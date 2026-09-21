/**
 * Phase 3B.0 — the MEASURED enforcement record.
 *
 * `public-contracts.json` records structure and a static `guardReachability` hint.
 * `public-enforcement.json` records what the library ACTUALLY DOES when a valid input is broken: it
 * imports each public callable, feeds it a first-touch fixture, mutates the fixture one way at a time,
 * and writes down the observed outcome.
 *
 * This exists because the static hint was wrong in the one direction that matters. `blackScholesPrice`
 * calls `requireArgumentObject` and `ensureEnum`, so guard-reachability read `direct` — while the same
 * commit's `SEED_FIXTURES` recorded that it returns `NaN` for a missing field and silently ignores
 * unknown keys. Both were true. `requireArgumentObject` proves the argument IS AN OBJECT and nothing
 * else. No refinement of the static pass closes that gap, because "a guard is reachable" and "the
 * contract is enforced" are different claims about the world.
 *
 * ## Which mutations are authoritative
 *
 * Two of the four are independent of field optionality, so they can convict on their own:
 *
 *   unknown-key  — no contract declares `qzxBogusKey`. Accepting it is a Law 12 violation, full stop.
 *   non-finite   — `NaN` in a field the contract types as a finite number. Accepting it is what turns a
 *                  typo into a silent `NaN` result.
 *
 * `omit-required` and `wrong-type` are recorded as ADVISORY, because per-field optionality is not in
 * the inventory: omitting a genuinely optional field SHOULD return a value, and calling that a defect
 * would manufacture false positives — the failure this whole rework exists to correct. They become
 * authoritative in 3B.1, once the field-level policy exists to say which fields are required.
 *
 * Regenerate with `pnpm enforcement:update`. The gate lives in `contract-conformance.test.ts` and
 * includes the cross-check that makes the original contradiction impossible: a path recorded defective
 * here may not be recorded enforced anywhere.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFixtures } from '../first-touch/fixtures.js';
import { probeContract, type ProbeResult } from './contract-probe.js';
import { mcpToolContracts, type McpToolContract } from './mcp-contracts.js';
import {
  alternativeOf,
  ATTEMPTS,
  CANONICAL_VARIANT,
  enumerateVariants,
  realizationGaps,
  normalizeSelection,
  selectionId,
  variantId,
  unionSites,
  incompleteBaseline,
  provesArgumentConformance,
  resetSynthesisIdentities,
  synthesisGap,
  expandedCoordinates,
  armsDigest,
  armsOf,
  satisfiedBranch,
  synthesizeArguments,
  synthesizeCall,
  unionMembers,
  type SynthesisField,
  type SynthesisParameter,
  type Variant,
  type VariantSelection,
} from './contract-synthesis.js';
import {
  ARTIFACT_VALUED_FIELDS,
  NON_FINITE_IN_DOMAIN,
  NON_TERMINATING_BOUNDARIES,
} from './contract-policy.js';
import { isQuantError } from '@totalfinance/core';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACTS = resolve(ROOT, 'tools/manifest/public-contracts.json');
const SIGNATURES = resolve(ROOT, 'tools/manifest/public-signatures.json');
const OUTPUT = resolve(ROOT, 'tools/manifest/public-enforcement.json');

/**
 * Mutations whose acceptance is a defect independent of any declared contract.
 *
 * `unknown-key` needs no schema (nothing declares `qzxBogusKey`) and neither do the container
 * mutations: an empty series, a wrong element type, a `NaN` mid-series and a ragged matrix are wrong
 * against any contract that accepts data at all.
 */
const ALWAYS_AUTHORITATIVE = new Set(['unknown-key', 'non-finite']);

/**
 * Mutations that convict ONLY against a declared contract (R7).
 *
 * Deleting an optional field must succeed, and "wrong type" is meaningless without knowing the declared
 * one — so before the field trees existed these could only be advisory. Now they convict whenever the
 * probe decided them against the declaration, and stay advisory when it did not.
 */
const AUTHORITATIVE_WHEN_DECLARED = new Set([
  'omit-required',
  'wrong-type',
  /**
   * A value outside a DECLARED literal domain. Authoritative for the same reason `wrong-type` is: the
   * contract states the closed set, so accepting a member outside it is a defect. It exists as its own
   * mutation because `wrong-type` substitutes a number — which a bare `typeof` check rejects, making
   * "enforces the enum" indistinguishable from "rejects a wrong primitive".
   */
  'invalid-literal',
  /**
   * Supplying a declared optional field with a forbidden type. Authoritative for the same reason
   * `wrong-type` is: the contract states the type, so accepting a violation of it is a defect. That
   * the field could have been omitted entirely is beside the point once it is present.
   */
  'optional-wrong-type',
  /**
   * `null` supplied to a field whose declaration does not admit it. Authoritative because the
   * inventory records `nullable` per field node and the probe only fires when it is false — the
   * declaration decided this. The ruling (review of 52f4e422e, from C06): optional `undefined` is
   * omission; `null` is not a second spelling of it, and a guard that early-returns on null accepts
   * a value the type system already refused.
   */
  'null-when-nonnullable',
]);

/**
 * Container mutations are ADVISORY, deliberately, and this is a correction of my own over-reach.
 *
 * Promoting them convicted 1,734 paths on `empty-series` alone — and `sma([], { period: 5 })` returns
 * `[]`, which is CORRECT for an aligned-output series API, not a defect. Whether an empty series, a
 * `NaN` element or a wrong element type should throw is a per-API decision about documented IEEE
 * behaviour, and the generator is explicitly forbidden from inventing that judgement.
 *
 * So they are recorded as findings for 3B.1 to adjudicate contract by contract. That is what advisory is
 * for: a real observation whose interpretation is not yet settled. Convicting on them would have
 * manufactured two thousand defects out of documented behaviour — the same failure as counting a
 * reachable guard as enforcement, arrived at from the opposite direction.
 */
function isAuthoritative(result: ProbeResult): boolean {
  if (ALWAYS_AUTHORITATIVE.has(result.mutation)) return true;
  return AUTHORITATIVE_WHEN_DECLARED.has(result.mutation) && result.declared === true;
}

export type MeasuredVerdict =
  /** Every authoritative mutation was rejected with a typed error. */
  | 'enforced'
  /** At least one authoritative mutation passed through, or threw untyped. */
  | 'defective'
  /**
   * Every authoritative mutation was rejected, but at least one contract DIMENSION is still
   * undecided — the path accepted a container mutation whose correctness is a per-API judgement.
   *
   * This is the honest middle the artifact was missing. `enforced` was awarded whenever no
   * AUTHORITATIVE mutation failed, which is not the same as the declared contract being enforced:
   * 1,851 of 2,881 "enforced" paths had accepted at least one advisory mutation, and 1,544 had
   * accepted a wrong element type, a non-finite element, or a ragged matrix. `@totalfinance/math:determinant`
   * declares a matrix, was handed a one-dimensional array, accepted it, and was called enforced.
   *
   * Container behaviour genuinely cannot be convicted globally — `sma([], { period: 5 })` returning
   * `[]` is correct for an aligned-output series API. But "cannot be convicted" means UNDECIDED, not
   * passed, and reporting it as a pass is the same error as counting a reachable guard as enforcement.
   */
  | 'partial'
  /** Nothing was measured. Honest third state, not a pass — see {@link UnmeasuredReason}. */
  | 'unmeasured';

/**
 * WHY a path was not measured.
 *
 * `unmeasured` was one opaque bucket of 1,011 paths, which reads as 1,011 things the harness failed to
 * check. It is not one thing. `CostModel#commission` is a declared FIELD on an interface — there is no
 * callable to hand a mutated argument to, and no amount of better synthesis will produce one. A
 * function whose synthesized baseline threw is the opposite: a real gap, and a fixture closes it.
 *
 * Recording the reason is what separates "there is nothing here to measure" from "we have not measured
 * this yet", and only the second is a work list. Same discipline as splitting `guardReachability` from
 * measured enforcement: a number nobody can act on is worth less than a smaller number that says what
 * to do.
 */
export type UnmeasuredReason =
  /**
   * A member of a type whose RECEIVER was never constructed, so the member could not be reached.
   *
   * This replaces a reason called `not-callable`, which claimed these paths held nothing to measure
   * ever. That was wrong on all 70 of them: every one is a `Type#member`, and they include
   * `SimulatedBroker#exerciseOption`, `Bond#cashflows` and `YieldCurve#addSpread` — methods that need
   * an instance, not inert fields. Worse, a gate was written demanding the count stay above zero,
   * which would have institutionalized the mistake as a permanent floor. Measuring these needs
   * constructor/factory acquisition; the work is real and outstanding, so the name says so.
   */
  | 'receiver-unresolved'
  /**
   * A member of an interface the CONSUMER implements and the library invokes — `CostModel#commission`,
   * `SlippageModel`, `OptionPricingEngine#price`. There is no library-side implementation to probe;
   * the contract is enforced where the library CALLS it, which is a different measurement.
   */
  | 'external-callback-contract'
  /** Callable, but neither a fixture nor synthesis could build an argument list. */
  | 'no-input'
  /**
   * The harness BUILT a call for this alternative and the call did not select it.
   *
   * Distinct from `no-input` on purpose: `no-input` means nothing could be built and the work is to
   * teach synthesis a shape; this means something was built and it was the WRONG THING, and the work
   * is to make the selected branch materialize. Collapsing them hides a defect inside a gap.
   */
  | 'branch-not-realized'
  /** An input was built and the baseline call REJECTED it, so no mutation of it means anything. */
  | 'baseline-rejected'
  /**
   * The declared input REQUIRES a function, and synthesis deliberately does not build one.
   *
   * `defineIndicator` needs `{ stream(parameters), restore(snapshot), nan(parameters) }`; `solveAll`
   * needs an `objective`. These were filed `baseline-rejected`, which reads as "the harness guessed
   * badly and a better guess would fix it" — and no guess fixes it, because callback synthesis is off
   * on purpose and `contract-synthesis.ts` explains at length why a constant stub drives numerical
   * routines into non-termination.
   *
   * Distinguished from `external-callback-contract` by POSITION: that one is a callback declared as a
   * member of an interface, with no library-side implementation to probe at all. This one is an
   * ordinary callable whose input happens to contain a function, and it becomes measurable the day
   * per-boundary isolation makes stub callbacks safe.
   *
   * Derived from the DECLARATION — a required function-valued field, at any depth reached through
   * required fields — never from the message. The message test looked cheaper and was wrong three
   * times: `generateSchedule` carries an OPTIONAL calendar of functions and fails on a date, so a
   * contract-shaped test that ignored optionality would have relabelled a fixable gap as a permanent
   * one.
   */
  | 'callback-input-required'
  /** The probe harness itself threw while mutating. */
  | 'probe-failed'
  /** The baseline held no mutable object, so there was nothing to mutate (`formatMoney(1)`). */
  | 'no-mutable-argument'
  /**
   * The call did not return, and the supervisor skipped this boundary so the rest could be measured.
   *
   * The harness runs real library code with invented inputs, and some of that code does not terminate
   * on some inputs: `normalSample` loops `while (u1 === 0) u1 = rng.next()`, `adaptiveSimpson` refines
   * a constant integrand toward a tolerance it cannot reach. Before this existed a single such
   * boundary took the whole pass down and no artifact was produced at all — the worst possible
   * outcome, since it hides 4,341 good measurements behind one bad one.
   */
  | 'probe-timeout'
  /**
   * The boundary returned a THENABLE, so its validation happens after the harness stopped watching.
   *
   * The probe calls, sees no throw, and records `accepted` — but an async boundary that rejects its
   * input rejects a PROMISE, and nobody awaited it. Every mutation would be scored as passed on
   * evidence that was never collected, which is precisely the inference this phase exists to remove;
   * `collectAsync` and `streamAsync` are the boundaries in question.
   *
   * Recorded as a gap rather than measured, because the fix is to make the whole probe path async and
   * that is a change worth doing deliberately rather than as a side effect. An honest gap beats a
   * verdict nobody earned.
   */
  | 'async-result-unobserved'
  /**
   * The harness built an input its OWN declaration says is incomplete — a required field missing, or a
   * key the contract does not declare.
   *
   * Split out of `baseline-rejected`, which conflated "the contract refused a well-formed request"
   * with "the harness handed it a malformed one". Only the first says anything about the library, and
   * a rejection recorded under the second was evidence about a call nobody should have made. Checked
   * statically before invoking, so the boundary is never touched with a request known to be wrong.
   */
  | 'incomplete-baseline';

export interface EnforcementRecord {
  id: string;
  package: string;
  /**
   * Mutations physically RUN against this boundary. Never inherited — an alias that borrowed a
   * verdict executed nothing.
   */
  mutationsExecuted?: Record<string, number>;
  /**
   * Mutations this PATH is covered by, directly or by attribution. Travels with inherited evidence,
   * because the claim "this path is covered" is exactly what inheriting a verdict asserts.
   */
  mutationsCovered?: Record<string, number>;
  /**
   * Declaration-template identity — `<file>.d.ts#<nameChain>`.
   *
   * NOT the key alias fan-out is inherited along: inheritance keys on the resolved FUNCTION OBJECT
   * (`measuredByTarget`). Several distinct callables share one template — 8 ids cover 710 runtime
   * function objects — so inheriting along this identity would hand one measurement to functions
   * that were never probed. Ledger R14 is the work to give a runtime callable its own identity.
   */
  implementation: string;
  verdict: MeasuredVerdict;
  /** Authoritative failures: what was broken, and what came back instead of an error. */
  failures?: ProbeResult[];
  /** Advisory results, pending the 3B.1 field-level optionality policy. */
  advisory?: ProbeResult[];
  /** Why nothing was measured. Present exactly when `verdict === 'unmeasured'`. */
  unmeasuredReason?: UnmeasuredReason;
  /** Contract dimensions left undecided. Present exactly when `verdict === 'partial'`. */
  undecided?: string[];
  /**
   * Why the contract refused the synthesized baseline. Present when the reason is
   * `baseline-rejected` — the contract's own account of what it wanted instead.
   */
  rejection?: { code: string; typed: boolean; field?: string; message?: string };
  /** The static hint, recorded alongside so the two can be compared rather than conflated. */
  guardReachability: string;
  /**
   * When this verdict was inherited from another name for the same callable, the source path.
   *
   * Keyed on the resolved FUNCTION OBJECT (`measuredByTarget`), not on `implementation` — that field
   * is a declaration-template identity and several distinct callables can share one, so keying fan-out
   * on it would hand one measurement to functions that were never probed.
   */
  inheritedFrom?: string;
  /** True when the input was SYNTHESIZED from the declaration rather than hand-fixtured. */
  synthesized?: boolean;
  /** The declared per-argument key policies this verdict was judged under, when any are curated. */
  inputPolicies?: Record<string, string>;
  /**
   * The canonical public path this record's evidence was MEASURED at.
   *
   * A semantic callable group is measured once — resolved function object + complete contract
   * fingerprint + invocation mode — and the result is attributed to every equivalent path. This names
   * the one that ran, so a reader can always reach the measurement behind an attribution.
   */
  measurementSource?: string;
  /**
   * The public path whose hand fixture produced this measurement's input.
   *
   * Present whenever a hand fixture was used, INCLUDING when this record owns it. Suppressing the
   * self-owned case meant a reader could not tell a self-fixtured measurement from a synthesized one
   * without cross-referencing another artifact — and provenance that is only recorded for borrowers
   * is not provenance, it is a diff.
   */
  fixtureSource?: string;
  /**
   * Per-ALTERNATIVE evidence, present wherever the DECLARATION offers more than one.
   *
   * Omitted only where a contract declares no union at all: there `total` would be 1 and the
   * boundary verdict already says everything the summary would. The GLOBAL summary still counts
   * those, so the library-wide alternative total stays complete.
   *
   * Presence is decided by the declaration, not by what synthesis managed to build. An alternative
   * nothing could build is published `unmeasured` — which already denies the boundary `enforced` —
   * because an absent alternative is a claim about a surface that was never touched.
   */
  alternatives?: AlternativeEvidence[];
  alternativeSummary?: AlternativeSummary;
}

/**
 * What one union alternative measured — NOT a second verdict vocabulary.
 *
 * The ruling is explicit that alternatives are evidence inside a boundary rather than new candidates,
 * so this reuses `MeasuredVerdict` and adds only the facts a per-alternative row needs.
 */
export interface AlternativeEvidence {
  /** `arg1.options:type=ironCondor`, or `baseline` for the all-defaults call. */
  id: string;
  verdict: MeasuredVerdict;
  /**
   * The public path whose hand fixture supplied THIS alternative's call.
   *
   * Per-alternative, because a semantic callable group pools fixtures from all of its names and two
   * of them can select different alternatives. A single row-level source would then name one of the
   * two and quietly stand for both.
   */
  fixtureSource?: string;
  unmeasuredReason?: UnmeasuredReason;
  /**
   * The runtime refused a call the DECLARATION says is valid.
   *
   * Set only when the canonical baseline was accepted and this variant differs from it in nothing but
   * the declared alternative it selects — so the refusal is attributable to the alternative rather
   * than to a value synthesis had to guess. That distinction is the whole reason this is a defect
   * instead of a gap: "the harness could not build this branch" and "the library rejects this branch"
   * are different findings, and only the second is about the library.
   */
  validCallRejected?: boolean;
  rejection?: { code: string; typed: boolean; field?: string; message?: string };
  /** Authoritative failures recorded against this alternative. */
  failures?: number;
}

/**
 * One alternative to measure, and HOW its call is produced.
 *
 * `hand` marks the variant whose call is the hand-written fixture. A boundary can have both: the
 * fixture is the one known-valid call for the alternative its author chose, and synthesis supplies
 * the alternatives the fixture does not exercise. Measuring only the fixture is what left
 * `strategyFromChain` — ten declared `type` values — reporting on one of them.
 */
type MeasuredAlternative = Variant & {
  hand: boolean;
  /** The call built for this alternative does not select it — see `branch-not-realized`. */
  unrealized?: boolean;
  /**
   * For a HAND alternative, the public path whose fixture supplies its call.
   *
   * Per-alternative rather than per-boundary, because a group can pool fixtures from several of its
   * names and each may select a different alternative — "this row used a pooled fixture" does not say
   * which evidence came from where.
   */
  fixtureSource?: string;
};

/** Alternative coverage for one boundary. Telemetry — it never redefines what `defective` means. */
export interface AlternativeSummary {
  total: number;
  enforced: number;
  partial: number;
  defective: number;
  unmeasured: number;
  /** True when `VARIANT_LIMIT` bounded the enumeration, so these counts describe a subset. */
  truncated?: boolean;
}

/**
 * The ruling's aggregation ladder, in its stated order.
 *
 * A public union promises that EVERY alternative is supported, so one defective alternative makes the
 * boundary defective and one unmeasured alternative denies it `enforced`. Nothing may disappear
 * behind a passing branch — which is exactly what the old code did by returning after the first
 * baseline that ran.
 */
export function aggregateVerdict(results: readonly MeasuredVerdict[]): MeasuredVerdict {
  if (results.some((verdict) => verdict === 'defective')) return 'defective';
  if (results.every((verdict) => verdict === 'enforced')) return 'enforced';
  if (results.some((verdict) => verdict !== 'unmeasured')) return 'partial';
  return 'unmeasured';
}

export interface ContractRecord {
  id: string;
  package: string;
  implementation: string;
  signatures: {
    parameters: (SynthesisParameter & { contract?: string | null })[];
    /** Contract identity of the RESULT — how a receiver's factory is found (R12). */
    resultContract?: string | null;
  }[];
  fields?: string[];
  inputContract: string | null;
  inputPolicies?: Record<string, string>;
  boundaryKind: string;
  guardReachability: string;
}

/** The fixture key convention: `<packageDir>.<exportPath>`. */
function fixtureKey(id: string): string {
  return id.replace('@totalfinance/', '').replace(':', '.');
}

/** Resolve a public callable from its id, trying each entrypoint the signature inventory recorded. */
/** Specifiers that have already failed to import; retrying them is pure cost. */
const unresolvableSpecifiers = new Set<string>();

/**
 * Resolution memo, keyed by public id.
 *
 * Every id is resolved twice — once in the measurement loop and again in the alias-inheritance pass,
 * which re-resolves all 4,328 records concurrently under `Promise.all`. Trying several candidate
 * specifiers per id multiplied that, and the pass went from about two minutes to not finishing. The
 * answer for a given id cannot change within a run, so it is computed once.
 */
const resolutionMemo = new Map<string, ((...args: unknown[]) => unknown) | null>();

async function resolveCallable(
  id: string,
  entrypoints: readonly string[],
): Promise<((...args: unknown[]) => unknown) | null> {
  const memo = resolutionMemo.get(id);
  if (memo !== undefined) return memo;
  const resolvedForId = await resolveCallableUncached(id, entrypoints);
  resolutionMemo.set(id, resolvedForId);
  return resolvedForId;
}

async function resolveCallableUncached(
  id: string,
  entrypoints: readonly string[],
): Promise<((...args: unknown[]) => unknown) | null> {
  const [pkg, path] = id.split(':');
  if (!pkg || !path) return null;
  /**
   * Candidate specifiers, most specific first.
   *
   * The package alone is tried FIRST because an entrypoint-qualified identity already carries its
   * subpath: `totalfinance/technical-analysis:skew` composed with `./technical-analysis` produced
   * `totalfinance/technical-analysis/technical-analysis`, which resolves to nothing — so every one of the
   * 35 split identities failed to resolve and was about to be reported unmeasured for a reason that
   * was an artifact of the composition rule.
   */
  const specifiers = [
    pkg,
    ...entrypoints.map((entrypoint) => (entrypoint === '.' ? pkg : `${pkg}${entrypoint.slice(1)}`)),
  ];
  for (const specifier of [...new Set(specifiers)]) {
    // Failed resolutions are not cached by the runtime, and this harness asks for the same handful of
    // bad specifiers thousands of times; remembering them turns a very slow pass into a quick one.
    if (unresolvableSpecifiers.has(specifier)) continue;
    let module: Record<string, unknown>;
    try {
      module = (await import(specifier)) as Record<string, unknown>;
    } catch {
      unresolvableSpecifiers.add(specifier);
      continue;
    }
    const resolved = path
      .split('.')
      .reduce<unknown>(
        (object, key) => (object as Record<string, unknown> | undefined)?.[key],
        module,
      );
    if (typeof resolved === 'function') return resolved as (...args: unknown[]) => unknown;
  }
  return null;
}

/**
 * Measure ONE boundary against a resolved callable, and return its record.
 *
 * Extracted so the module path and the receiver path (R12) share one implementation. A second copy of
 * the baseline rule, the zero-probe rule, the key-policy rule and the verdict derivation would drift
 * from this one the first time any of them changed, and the whole point of those rules is that they
 * are applied identically everywhere.
 */
/**
 * Measure, and if the contract REFUSED the baseline, try the next synthesized alternative.
 *
 * A name can mean more than one thing — `expiry` is a zoned datetime to `callContract`, an ISO date to
 * `usEquityCall` and epoch milliseconds to `SimulatedBroker`, and each says so when handed one of the
 * others. `FIELD_ALTERNATIVES` holds the candidates; this decides when to reach for one.
 *
 * Only a REJECTED baseline retries, so a healthy pass costs nothing, and only a SYNTHESIZED input
 * retries, because a hand-written fixture is the same list every time. The last attempt's rejection is
 * the one recorded: it is the contract's account of the best input the harness could build.
 */
/**
 * Do two records declare the same call shape — parameter count, kinds, and optionality, in order?
 *
 * The precondition for inheriting a verdict, alongside sharing a runtime function object. Kinds
 * rather than full type text, because an alias may legitimately render a generic differently while
 * accepting exactly the same call.
 */
export function sameCallShape(
  a: ContractRecord | undefined,
  b: ContractRecord | undefined,
  /**
   * Ignore `record.fields` — the package-qualified curated-name index.
   *
   * Set ONLY by the grouping pre-pass, whose key already contains the resolved function object. That
   * object is what separates two different callables, so the index can only split a group there, and
   * it does: `fields` is keyed per package, so `@totalfinance/calendars:expirations` carries a different
   * list from `totalfinance:calendars.expirations` for ONE function. Seventeen function objects were
   * being measured twice for this reason, and two of the pairs disagreed on their own probe counts —
   * the order-dependent re-probing of a shared target that canonical measurement exists to remove.
   *
   * The twin path still compares it, because there the object is not part of the key.
   */
  ignoreFieldIndex = false,
): boolean {
  if (!a || !b) return false;
  /**
   * EVERY overload, every parameter, and the DECLARED SHAPE of each — not the first signature's
   * kinds.
   *
   * This gates inheritance, and after canonical measurement it is the only thing standing between "two
   * names for one function" and "two different questions about one function". The first version
   * compared `[kind, optional]` of signature zero, which cannot tell `f(x: BondInput)` from
   * `f(x: SwapInput)` — both `[object, false]` — so a re-export that narrows or re-types a parameter
   * would silently borrow a verdict measured against a different contract.
   *
   * The key policy is part of it too: `open` and `closed` are different contracts about the same
   * arguments, and a verdict is a verdict about one of them.
   */
  const shape = (record: ContractRecord): string =>
    JSON.stringify({
      policies: record.inputPolicies ?? null,
      /**
       * `fields` counts only when it can CHANGE the input, which is when some parameter has no field
       * tree — it is the name-only fallback and nothing else reads it.
       *
       * Including it unconditionally made every umbrella alias a non-twin and cost 358 measurements,
       * because the join key is package-qualified: `@totalfinance/options:blackScholes.price` carries 7
       * field paths and `totalfinance:blackScholes.price` carries none, for the same declaration with the
       * same field TREE on both. That difference is an artefact of how the index is keyed, not a
       * difference in the question being asked — so it belongs in the comparison only where synthesis
       * would actually consult it.
       */
      fields:
        !ignoreFieldIndex &&
        record.signatures.some((signature) =>
          signature.parameters.some((parameter) => !parameter.fieldTree),
        )
          ? [...(record.fields ?? [])].sort()
          : null,
      signatures: record.signatures.map((signature) =>
        signature.parameters.map((parameter) => ({
          kind: parameter.kind,
          optional: parameter.optional,
          rest: parameter.rest ?? false,
          inferredGeneric: parameter.inferredGeneric ?? false,
          instantiatedGeneric: parameter.instantiatedGeneric ?? false,
          /**
           * THE COMPLETE CONTRACT, because inheritance asserts the two names ask
           * the same question. Everything below was missing, and each omission
           * lets a verdict cross to a declaration it was never measured against:
           * a union's BRANCHES (so `A | B` and `A | C` were twins), literal
           * domains, nullability, tuple element trees, and callback signatures.
           */
          literals: [...(parameter.literals ?? [])].sort(),
          callSignature: parameter.callSignature ?? null,
          callSignatures: parameter.callSignatures ?? null,
          returns: parameter.returns ? fieldDigest([parameter.returns]) : null,
          /**
           * PAIRED, then sorted — the association is the contract.
           *
           * Sorting `branchFields` and `branchTypes` independently threw away which type went with
           * which shape, so `A -> fieldsA, B -> fieldsB` and `A -> fieldsB, B -> fieldsA` compared
           * EQUAL. Two genuinely different unions could then inherit each other's evidence, which is
           * the one thing this fingerprint exists to prevent.
           */
          branches: armedDigest(parameter),
          // NOT sorted — a tuple's positions are part of its meaning.
          tuples: (parameter.tupleFieldTrees ?? []).map((tree) => fieldDigest(tree ?? undefined)),
          /**
           * `type` and not `contract`. A contract identity is `<package>:<TypeName>`, so the same
           * declaration reached through the umbrella and through its scoped package differs only in a
           * prefix — and once that prefix is stripped it says exactly what `type` already says.
           * Comparing the raw identity made every umbrella alias a non-twin and sent 358 of them to be
           * re-measured against a synthesis that fails for them, converting inherited verdicts into
           * `baseline-rejected`. Identity strings are for joining; `type` is what the caller writes.
           */
          type: canonicalType(parameter.type),
          fields: fieldDigest(parameter.fieldTree),
          elementFields: fieldDigest(parameter.elementFieldTree),
        })),
      ),
    });
  return shape(a) === shape(b);
}

/**
 * A union rendered in a canonical ORDER.
 *
 * `A | B` and `B | A` are the same contract, and the checker renders whichever the
 * declaration happened to write. Sorting the branch DIGESTS was not enough on its own: the
 * parameter's own `type` text carries the order too, so the two spellings still fingerprinted
 * differently and inheritance was refused between genuinely identical declarations.
 */
function canonicalType(type: string | undefined): string {
  if (!type) return '';
  const members = unionMembers(type);
  return members.length > 1
    ? members
        .map((member) => member.trim())
        .sort()
        .join(' | ')
    : type;
}

/**
 * A stable digest of a declared field tree — the SEMANTIC content of the contract.
 *
 * Name, kind and requiredness alone could not tell `status: 'open' | 'closed'`
 * from `status: 'live' | 'dead'`, nor a nullable field from a non-nullable one,
 * nor two different callback signatures apart. Each of those is a different
 * promise to a caller, and inheritance claims the promises are identical.
 */
function fieldDigest(fields: readonly SynthesisField[] | undefined, depth = 0): string {
  if (!fields || depth > 6) return '';
  /**
   * SORTED, because `{ a; b }` and `{ b; a }` are the same type.
   *
   * Declaration order is a fact about how someone typed the interface, not about what the boundary
   * accepts — and two spellings of one callable whose field trees the checker happened to emit in
   * different orders were fingerprinting apart, which splits a group that should be measured once.
   * Tuples are NOT sorted (see `tuples` above): there, position IS the meaning.
   */
  return fields
    .map(
      (field) =>
        `${field.name}:${field.kind}:${canonicalType(field.type)}:${field.optional ? '?' : '!'}` +
        `:${field.nullable ? 'N' : '-'}` +
        `<${[...(field.literals ?? [])].sort().join('|')}>` +
        (field.callSignature
          ? `(${field.callSignature.parameters}=>${canonicalType(field.callSignature.returns)})`
          : '') +
        (field.callSignatures ? `<calls:${JSON.stringify(field.callSignatures)}>` : '') +
        /**
         * The callback's RETURN CONTRACT, expanded — not only its rendered signature text.
         *
         * Two callbacks can render the same `(x) => Result` and expand to different `Result`s, and
         * the fingerprint called them identical. A group key that cannot tell two contracts apart is
         * the one failure this key exists to prevent, so the return travels with the signature.
         */
        (field.returns ? `->{${fieldDigest([field.returns], depth + 1)}}` : '') +
        `{${fieldDigest(field.fields, depth + 1)}}` +
        (field.element ? `[${fieldDigest([field.element], depth + 1)}]` : '') +
        /**
         * PAIRED at every depth. The root-level digest paired branch types with shapes; nested field
         * unions still used the shape-only one, so `A -> fieldsA, B -> fieldsB` and
         * `A -> fieldsB, B -> fieldsA` fingerprinted identically inside a nested field. One recursive
         * rule, so "complete contract fingerprint" is true at every depth rather than at the root.
         */
        armedDigest(field, depth + 1),
    )
    .sort()
    .join(',');
}

/**
 * Every branch of a union as a (type, shape) PAIR, canonically sorted.
 *
 * Order must not matter — `A | B` and `B | A` are one contract — but the pairing must survive the
 * sort. Sorting the two lists separately made `A -> fieldsA, B -> fieldsB` indistinguishable from
 * `A -> fieldsB, B -> fieldsA`: the same multiset of types and the same multiset of shapes, wired
 * together differently. Sorting the JOINED records keeps both properties at once.
 */
/**
 * The paired digest of a node's ARMS — the one representation, at every level.
 *
 * `pairedBranchDigest` used to be handed `branchFields` and `branchTypes` directly, which made the
 * alias-grouping fingerprint depend on the legacy arrays and not on the arms that superseded them. A
 * node whose arms were richer than its arrays would have been fingerprinted by the poorer of the two
 * — and this fingerprint decides which paths POOL their evidence, so a difference it cannot see is a
 * difference that silently shares a measurement.
 */
function armedDigest(node: Parameters<typeof armsOf>[0], depth = 0): string {
  const arms = armsOf(node);
  if (!arms) return '';
  /**
   * THE COMPLETE ARMS, canonically — the same identity discovery and the builder use.
   *
   * `pairedBranchDigest` hashed rendered text plus each arm's shallowest fields, so an alias-resolved
   * element changing from numeric to string, or a callback arm's arity changing, left this
   * fingerprint unmoved — and this fingerprint decides which paths POOL their evidence. Two contracts
   * it cannot tell apart are two contracts that share a measurement.
   */
  void depth;
  // UNORDERED here: this fingerprint decides which paths pool evidence, and a union accepts the same
  // calls whichever order its arms were written in.
  return armsDigest(arms, { ordered: false });
}

/**
 * Does this contract require a FUNCTION the harness will not synthesize?
 *
 * Required-only descent: an optional function field is correctly omitted from a minimal baseline, so
 * its presence in the declaration says nothing about why the call failed.
 */
function requiresCallableInput(record: ContractRecord): boolean {
  const nodes = (fields: readonly SynthesisField[] | undefined, depth: number): boolean => {
    // The field trees are depth-capped at 4 by `contract-fields.ts`; this bounds the walk regardless.
    if (!fields || depth > 6) return false;
    return fields.some(
      (field) =>
        !field.optional &&
        (field.kind === 'function' ||
          nodes(field.fields, depth + 1) ||
          (field.element ? nodes([field.element], depth + 1) : false)),
    );
  };
  return (record.signatures[0]?.parameters ?? []).some(
    (parameter) =>
      !parameter.optional &&
      (parameter.kind === 'callback' ||
        nodes(parameter.fieldTree, 0) ||
        nodes(parameter.elementFieldTree, 0)),
  );
}

/**
 * A call the harness can make, WITH the declared coordinate of each argument it passes.
 *
 * The two travel together because they are produced together — `synthesizeCall` walks once and
 * returns both. Handing the probe a parameter ARRAY instead was how `fieldTrees[i]` came to describe
 * a different slot than `args[i]` for every callable declaring a labelled rest-tuple.
 */
interface Fixture {
  call: () => unknown[];
  coordinates: SynthesisParameter[];
}

/** A hand-written fixture and the public path it was filed under. */
interface PooledFixture {
  call: () => unknown[];
  source: string;
}

/** What a boundary will actually measure: the alternatives, and how to build each one's input. */
interface VariantPlan {
  variants: MeasuredAlternative[];
  fixtureFor: (attempt: number, variant: MeasuredAlternative) => Fixture | null;
  truncated: boolean;
  /** True when the CANONICAL input was synthesized rather than hand-written. */
  synthesized: boolean;
}

/**
 * Two fixtures claim the same alternative and are not the same call.
 *
 * Thrown rather than resolved, because there is no honest resolution: both are deliberately-authored
 * claims about one alternative of one callable, and picking by id order would publish one author's
 * call under a verdict the other's would not have produced. Generation stops and names both.
 */
export class ConflictingFixturesError extends Error {
  constructor(alternative: string, first: string, second: string) {
    super(
      `two fixtures claim alternative ${alternative} of the same callable with different calls: ` +
        `${first} and ${second}. A fixture is a claim about the CALLABLE, so both cannot stand — ` +
        `delete one, or make them identical.`,
    );
    this.name = 'ConflictingFixturesError';
  }
}

/**
 * A stable key for a normalized selection — the identity two calls are compared on.
 *
 * Sorted, so the key is a property of the SET of choices rather than of the order a walk happened to
 * discover them in.
 */
function selectionKeyOf(selection: VariantSelection): string {
  return [...selection.entries()]
    .map(([key, choice]) => variantId(key, choice))
    .sort()
    .join('|');
}

/**
 * DECIDE WHAT A BOUNDARY MEASURES — once, for module callables and receiver methods alike.
 *
 * This existed twice. The module path labelled a hand fixture with the alternative it selects and let
 * synthesis supply the rest; the receiver path took a hand fixture as the WHOLE measurement and
 * disabled union enumeration outright (`handWritten ? [CANONICAL] : enumerateVariants(...)`). So an
 * instance method with a fixture and a five-way union was measured on one branch and reported as
 * covered, which is precisely the defect the module path had already been fixed for. Two code paths
 * answering one question is how a fix reaches half a library.
 *
 * It also takes EVERY fixture the group owns, not the first. Fixtures are pooled across a semantic
 * callable group, and two names for one function can carry fixtures selecting DIFFERENT alternatives
 * — keeping only the lowest id silently discarded the other one's evidence and left its alternative
 * to synthesis, or to nothing.
 */
export function planVariants(input: {
  parameters: readonly SynthesisParameter[];
  fields: readonly string[];
  producers: ReadonlyMap<string, () => unknown> | undefined;
  declaredCoordinates: SynthesisParameter[];
  /** Every hand fixture the group owns, sorted by source id. */
  hand: readonly PooledFixture[];
}): VariantPlan {
  const { parameters, fields, producers, declaredCoordinates, hand } = input;
  const synthesizeFixture = (attempt: number, selection: VariantSelection): Fixture | null => {
    const built = synthesizeCall(parameters, fields, attempt, producers, selection);
    if (built === null) return null;
    const args = synthesizeArguments(parameters, fields, attempt, producers, selection);
    if (args === null) return null;
    /**
     * DID THE CALL ACTUALLY SELECT THE BRANCH IT NAMES? — asked of the built arguments, not of the
     * enumerator that asked for them.
     *
     * The enumerator discovers alternatives from the declaration, which is right, but synthesis does
     * not necessarily MATERIALIZE the one it was handed: an optional field is omitted from a minimal
     * baseline, an array element used to bypass its own union, a callback return was built in an
     * isolated context. Both `researchProtocol.trials` variants therefore produced the identical
     * request — with no `trials` property at all — and `arg0.trials#1` was published `enforced`:
     * evidence about a branch the call did not contain.
     *
     * This reads the ARGUMENTS back and compares what they select against what was asked for. It is
     * a genuinely independent reading — values, not declarations — which is the property the earlier
     * coverage gate lacked: it compared declaration-derived keys against enumerator-derived keys, so
     * it could only ever confirm the enumerator agreed with itself.
     */
    // ONE reading, shared with the gate — see `realizationGaps`.
    if (realizationGaps(parameters, fields, producers, selection, args).length > 0) return null;
    // Rebuild per probe — they mutate what they are handed — but keep the coordinates from the ONE
    // walk that produced this argument list.
    return {
      call: () => synthesizeArguments(parameters, fields, attempt, producers, selection)!,
      coordinates: built.coordinates,
    };
  };
  const buildable = synthesizeArguments(parameters, fields, 0, producers) !== null;

  if (hand.length === 0) {
    const declared = enumerateVariants(parameters, fields, producers);
    return {
      variants: declared.variants.map((variant) => ({
        ...variant,
        hand: false,
        ...(buildable && synthesizeFixture(0, variant.selection) === null
          ? {
              unrealized:
                synthesizeArguments(parameters, fields, 0, producers, variant.selection) !== null,
            }
          : {}),
      })),
      fixtureFor: (attempt, variant) => synthesizeFixture(attempt, variant.selection),
      truncated: declared.truncated,
      // Nothing buildable means nothing was synthesized either — the pre-flight check turns that
      // into ONE unmeasured record for the boundary rather than a row of empty alternatives.
      synthesized: buildable,
    };
  }

  const byId = new Map<string, PooledFixture>(hand.map((fixture) => [fixture.source, fixture]));
  const callFor = (variant: MeasuredAlternative): (() => unknown[]) =>
    (variant.fixtureSource ? byId.get(variant.fixtureSource) : undefined)?.call ?? hand[0]!.call;
  const handFixture = (attempt: number, variant: MeasuredAlternative): Fixture | null =>
    variant.hand
      ? { call: callFor(variant), coordinates: declaredCoordinates }
      : synthesizeFixture(attempt, variant.selection);

  /**
   * WHICH alternative does each fixture select? — the label, and with it the dedupe and the conflict.
   *
   * A fixture that cannot be labelled (no union, or a call the sites do not recognise) selects the
   * unnamed one; two such fixtures are indistinguishable, which is exactly when the conflict rule has
   * something to say.
   */
  const sites = buildable ? unionSites(parameters, fields, producers) : [];
  const labelled = hand.map((fixture) => {
    /**
     * The SELECTION the fixture makes, normalized — not a display string.
     *
     * Deduplicating on presentation was the defect: enumeration named a variant by the one site it
     * fixed while labelling named it by every site it selects, so the same call carried two names and
     * both were measured. A selection compares by what it IS.
     */
    const selection = ((): VariantSelection | null => {
      try {
        const found = sites.length > 0 ? alternativeOf(fixture.call(), sites) : null;
        return found === null ? null : normalizeSelection(parameters, found);
      } catch {
        return null;
      }
    })();
    const label = selection === null ? null : selectionId(parameters, selection);
    const shape = ((): string => {
      try {
        return describeCall(fixture.call());
      } catch {
        return `<threw:${fixture.source}>`;
      }
    })();
    return { ...fixture, label, selection, shape };
  });
  const chosen = new Map<string, (typeof labelled)[number]>();
  for (const entry of labelled) {
    // Keyed by the SELECTION, so two fixtures agreeing on the call agree here whatever they are called.
    const key = entry.selection ? selectionKeyOf(entry.selection) : '';
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, entry);
      continue;
    }
    // Identical calls are not a conflict — the same claim written twice under two names.
    if (existing.shape !== entry.shape) {
      throw new ConflictingFixturesError(
        entry.label ?? 'the unnamed alternative',
        existing.source,
        entry.source,
      );
    }
  }
  const kept = [...chosen.values()];

  /**
   * Enumerated UNCONDITIONALLY, not only when synthesis can build a baseline.
   *
   * Gating on `buildable` meant a boundary with a hand fixture and an unbuildable declaration
   * published exactly one alternative — its fixture's — and reported `enforced` for a union whose
   * other arms had never been called. `surfaceLocalVolatility` was the case: two declared nodes, one
   * measured, and a row that read as complete. An alternative nothing can build is `unmeasured`,
   * which already denies the boundary `enforced`; an alternative that is absent says nothing at all.
   */
  const enumerated = enumerateVariants(parameters, fields, producers);
  /**
   * One hand fixture and nothing to enumerate keeps the id it has always had. Renaming a single
   * alternative would churn every fixtured row in the artifact to say the same thing.
   */
  if (kept.length === 1 && enumerated.variants.length <= 1) {
    const only = kept[0]!;
    return {
      variants: [
        {
          id: CANONICAL_VARIANT,
          selection: new Map(),
          hand: true,
          fixtureSource: only.source,
        },
      ],
      fixtureFor: handFixture,
      truncated: false,
      synthesized: false,
    };
  }
  const covered = new Set(
    kept
      .map((entry) => (entry.selection ? selectionKeyOf(entry.selection) : null))
      .filter((key): key is string => key !== null),
  );
  const variants: MeasuredAlternative[] = [
    ...kept.map((entry) => ({
      id: entry.label ?? 'fixture',
      /**
       * The fixture's OWN selection travels with it, so a synthesized variant that would select the
       * same call is recognised as the same call rather than as a second one wearing another name.
       */
      selection: entry.selection ?? new Map(),
      hand: true,
      fixtureSource: entry.source,
    })),
    ...enumerated.variants
      .filter((variant) => !covered.has(selectionKeyOf(variant.selection)))
      .map((variant) => ({
        ...variant,
        hand: false,
        ...(buildable && synthesizeFixture(0, variant.selection) === null
          ? {
              unrealized:
                synthesizeArguments(parameters, fields, 0, producers, variant.selection) !== null,
            }
          : {}),
      })),
  ];
  return { variants, fixtureFor: handFixture, truncated: enumerated.truncated, synthesized: false };
}

/**
 * The FIELD INDEX a semantic callable group is measured with, pooled from every member.
 *
 * `fields` is a flat list of `Owner.field` paths — a name table synthesis consults as a LAST RESORT,
 * when a parameter's declared type resolves to no field tree. It is package-qualified, which is why
 * it is deliberately excluded from the group key: `buildStrategy` carries 79 paths under its scoped
 * name and 3 through the umbrella, for one declaration of one function. Excluding it from identity
 * while still measuring with whichever member sorted first meant a group could be measured through
 * the 3-path index and nothing would say so.
 *
 * Pooled PER OWNER TYPE, which is the granularity it is actually read at: synthesis filters to
 * `Owner.` for the owner named by the parameter's type, so entries for other owners are inert.
 * Taking whichever member holds the most paths OVERALL was the first attempt and it is wrong — a
 * member can hold more paths in total while holding NONE for the owner a given parameter needs, and
 * an owner with no entries synthesizes to nothing at all.
 *
 * Within one owner the largest set wins ENTIRE rather than being merged across members. A merge
 * could compose a key set no declaration has, and the one thing this harness must never do is
 * measure a call no caller could make.
 */
export function poolFieldIndex(members: readonly ContractRecord[]): string[] {
  const best = new Map<string, string[]>();
  for (const member of members) {
    const byOwner = new Map<string, string[]>();
    for (const path of member.fields ?? []) {
      const dot = path.indexOf('.');
      if (dot < 0) continue;
      const owner = path.slice(0, dot);
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), path]);
    }
    for (const [owner, paths] of byOwner) {
      const held = best.get(owner);
      if (!held || paths.length > held.length) best.set(owner, paths);
    }
  }
  return [...best.values()].flat().sort();
}

/**
 * A CANONICAL array index, per the language — ONE definition, used everywhere.
 *
 * Three near-misses in three rounds, each admitting a key the language does not. `/^\d+$/` accepts
 * `"01"`; dropping `Number.isInteger` accepts `"1.5"`. Both are ordinary own properties that `length`
 * never counts and the element walk never reads, so an array carrying one described as `[]` and
 * merged with a genuinely empty array — silently discarding a conflicting fixture. Integer, in range,
 * and an EXACT string round-trip; anything else is state, not structure.
 */
function isCanonicalIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

/**
 * How many elements this walk describes before falling back to identity.
 *
 * A cap that TRUNCATES turns "the first N agree" into "the calls agree". A cap that falls back to
 * identity says "this one cannot be proven equal" — the honest answer, and the fail-closed one.
 */
const MAX_DESCRIBED_ELEMENTS = 4096;

/** Monotonic across the process, so no two unprovable values ever describe the same. */
let unprovable = 0;

/** Stable serials for values nothing can compare structurally — see `describeCall`. */
const opaqueIdentity = new WeakMap<object, number>();

/**
 * Fixtures that are DELIBERATELY the same claim, by identity rather than by inspection.
 *
 * The escape hatch the fail-closed rule needs: two authors can assert their calls are equivalent
 * where nothing mechanical can prove it. Registering a value here is a claim a person made and can
 * be held to; the absence of a registration is not evidence of anything, which is why the default is
 * to refuse rather than to assume.
 */
const fixtureEquivalence = new WeakMap<object, string>();

export function declareFixtureEquivalence<T extends object>(value: T, identity: string): T {
  fixtureEquivalence.set(value, identity);
  return value;
}

/**
 * A description of a call precise enough that "these are the same claim" is PROVABLE.
 *
 * The rule refuses to publish one author's fixture under a verdict another's would not have
 * produced, so its comparison must fail CLOSED: anything it cannot distinguish, it must not call
 * equal. Two earlier versions failed open in different ways and each looked careful:
 *
 *   arity alone      `() => 1` and `() => 2` compared identical, so no conflict was raised and the
 *                    second fixture was discarded by the rule meant to protect it;
 *   source text      `const make = (n) => () => n; make(1)` and `make(2)` render the SAME source and
 *                    close over different values. Source text describes a function's shape, never
 *                    its behaviour, and a closure is exactly the case where the two diverge.
 *
 * So a function is equivalent to another only by OBJECT IDENTITY or an explicit registration. A
 * non-plain class instance is opaque whether or not it happens to expose an enumerable key, because
 * private state is invisible here and two instances agreeing on `tag` agree on nothing that matters.
 * Primitives carry their type so `1` and `'1'` never collide, and a typed array carries its
 * constructor so `Float64Array` and `Int32Array` do not.
 */
function describeCall(args: readonly unknown[], seen: Set<unknown> = new Set()): string {
  /** First-sighting index per object, so an alias describes differently from a duplicate. */
  const visited = new Map<unknown, number>();
  /**
   * A STABLE id per object, so identity is what it claims to be.
   *
   * A fresh serial on every visit made the same function object describe differently each time it
   * was seen, which fails the case identity is FOR: two fixtures that hand over literally the same
   * object are the same claim. The serial is per-object and remembered, so the same object always
   * describes the same and two different objects never collide.
   */
  const opaque = (value: object, label: string): string => {
    const held = opaqueIdentity.get(value);
    if (held !== undefined) return `${label}#${held}`;
    const minted = (unprovable += 1);
    opaqueIdentity.set(value, minted);
    return `${label}#${minted}`;
  };
  const unique = (label: string): string => `${label}#unprovable${(unprovable += 1)}`;
  const describe = (value: unknown, level: number): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object' && typeof value !== 'function') {
      /**
       * The TYPE travels with the value, so `1`, `'1'` and `true` are three different arguments. Two
       * cases `String()` merges are spelled out: `-0` and `0`, which `Object.is` separates, and a
       * SYMBOL, identified by identity rather than description — two distinct symbols can describe
       * themselves identically and behave as different keys.
       */
      if (typeof value === 'symbol') {
        /**
         * A REGISTERED or WELL-KNOWN symbol is canonical — `Symbol.for('x')` is the same symbol
         * everywhere — and cannot be a `WeakMap` key, so routing it through the identity map threw
         * and surfaced as a false fixture conflict. Canonical symbols describe by their registration;
         * only a unique symbol needs identity.
         */
        const registered = Symbol.keyFor(value);
        if (registered !== undefined) return `symbol:for(${JSON.stringify(registered)})`;
        const wellKnown = Object.getOwnPropertyNames(Symbol)
          .filter((name) => (Symbol as unknown as Record<string, unknown>)[name] === value)
          .join('');
        if (wellKnown !== '') return `symbol:Symbol.${wellKnown}`;
        return opaque(value as unknown as object, 'symbol');
      }
      if (typeof value === 'number' && Object.is(value, -0)) return 'number:-0';
      return `${typeof value}:${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
    }
    const declared = fixtureEquivalence.get(value as object);
    if (declared !== undefined) return `declared:${declared}`;
    if (typeof value === 'function') {
      /**
       * Identity only. Two fixture files each writing `(x) => x * 2` produce two different function
       * objects, and this now refuses to merge them — deliberately. Refusing costs a person one
       * explicit `declareFixtureEquivalence`; accepting costs a silently discarded fixture, and only
       * one of those two failures is visible.
       */
      return opaque(value, `fn(${value.length})`);
    }
    /**
     * A REPEAT is a back-reference, not a fresh copy.
     *
     * `{ a: shared, b: shared }` and `{ a: {…}, b: {…} }` describe identically once each subtree is
     * walked independently, and they are different arguments: a probe that mutates `a` changes `b`
     * in one and not the other. Numbering the first sighting makes the aliasing part of the
     * description — and a genuine cycle falls out of the same rule.
     */
    const already = visited.get(value);
    if (already !== undefined) return `<ref ${already}>`;
    visited.set(value, visited.size);
    if (level > 8) return unique('deep');
    seen.add(value);
    try {
      if (ArrayBuffer.isView(value)) {
        const view = value as unknown as ArrayLike<number> & {
          byteOffset: number;
          byteLength: number;
          buffer: ArrayBufferLike;
        };
        const prototype = Object.getPrototypeOf(value) as {
          constructor?: { name?: string };
        } | null;
        const brand = prototype?.constructor?.name;
        /**
         * BACKING-BUFFER TOPOLOGY, or nothing.
         *
         * Contents plus offset plus length still merged two views onto ONE buffer with two views onto
         * two — and those differ in exactly the way that matters here, because a probe writing
         * through one is visible through the other. The buffer's identity is part of the value, so it
         * is part of the description; extra own state means it is not an ordinary view at all.
         */
        /**
         * A VIEW is ordinary only when it is a stock view: the standard prototype for its
         * constructor, extensible, and carrying nothing but canonical indices. An altered prototype
         * changes every method the boundary might call; extra own state is state; and `"01"` is not
         * an index, so filtering on `/^\d+$/` let one through.
         */
        const canonical =
          typeof brand === 'string' &&
          (globalThis as unknown as Record<string, { prototype?: object } | undefined>)[brand]
            ?.prototype === prototype;
        const own = Object.getOwnPropertyNames(value).filter((key) => !isCanonicalIndex(key));
        if (
          !canonical ||
          !Object.isExtensible(value) ||
          own.length > 0 ||
          Object.getOwnPropertySymbols(value).length > 0
        ) {
          return opaque(value, 'view-not-ordinary');
        }
        // Too large to walk: identity, never a truncated description that reads as agreement.
        if (view.length > MAX_DESCRIBED_ELEMENTS) return opaque(value, 'view-too-large');
        return (
          `${brand ?? 'view'}@${view.byteOffset}+${view.byteLength}` +
          `${opaque(view.buffer as unknown as object, 'buffer')}` +
          `[${Array.from(view).join(',')}]`
        );
      }
      // NOT truncated. A cap turns "the first eight elements agree" into "the calls agree".
      if (Array.isArray(value)) {
        /**
         * A SPARSE array is not a dense one of the same length. `[, ,]` and `[undefined, undefined]`
         * both describe as two `undefined`s and are different objects to anything asking `in`.
         */
        /**
         * AN ORDINARY ARRAY, completely defined: `Array.prototype`, extensible, own keys exactly its
         * indices and `length`, and every index a plain writable-configurable-enumerable slot.
         *
         * Each clause is a case that compared equal without it — a subclass, a frozen index, extra
         * own state. Listing the whole shape is the only way this stays fail-closed: a partial
         * whitelist is a promise to be surprised by whatever it forgot.
         */
        const names = Object.getOwnPropertyNames(value);
        const indices = names.filter(isCanonicalIndex);
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        const ordinaryArray =
          Object.getPrototypeOf(value) === Array.prototype &&
          Object.isExtensible(value) &&
          Object.getOwnPropertySymbols(value).length === 0 &&
          names.length === indices.length + 1 &&
          names.includes('length') &&
          // `length` decides what the element walk even looks at, so a frozen one is a different array.
          lengthDescriptor !== undefined &&
          lengthDescriptor.writable === true &&
          indices.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return (
              descriptor !== undefined &&
              descriptor.enumerable === true &&
              descriptor.writable === true &&
              descriptor.configurable === true
            );
          });
        if (!ordinaryArray) return opaque(value, 'array-not-ordinary');
        // Too large to walk: identity, never a truncated description that reads as agreement.
        if (value.length > MAX_DESCRIBED_ELEMENTS) return opaque(value, 'array-too-large');
        return `[${Array.from({ length: value.length }, (_, index) =>
          index in value ? describe(value[index], level + 1) : '<hole>',
        ).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(record) as { constructor?: { name?: string } } | null;
      /**
       * A class instance is a black box regardless of what it exposes — comparing the enumerable keys
       * of two `Bond`s says nothing about the private state that decides what they do. A
       * NULL-PROTOTYPE object is not ordinary data either: it behaves differently at every lookup, so
       * it is not interchangeable with one that merely holds the same keys.
       */
      if (prototype !== Object.prototype) {
        return opaque(
          record,
          prototype === null ? 'null-prototype' : (prototype?.constructor?.name ?? 'instance'),
        );
      }
      /**
       * NON-ENUMERABLE state is invisible to `Object.keys`, so an object carrying it is not ordinary
       * data and cannot be compared by its visible shape. Accessors are excluded for the same reason:
       * a getter's value is computed, and describing one reading says nothing about the next.
       */
      /**
         EXTENSIBILITY completes the object whitelist: a sealed `{ a: 1 }` and a mutable one answer
         differently to a probe that adds a key, which is exactly what the unknown-key probe does.
       */
      if (!Object.isExtensible(record)) return opaque(record, 'non-extensible');
      const descriptors = Object.getOwnPropertyDescriptors(record);
      const ordinary = Reflect.ownKeys(record).every((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return (
          typeof key === 'string' &&
          descriptor !== undefined &&
          descriptor.enumerable === true &&
          // WRITABILITY is part of the value. A frozen `{ a: 1 }` and a mutable one are different
          // arguments to a boundary that writes, and the probes DO write.
          descriptor.writable === true &&
          descriptor.configurable === true &&
          descriptor.get === undefined &&
          descriptor.set === undefined
        );
      });
      if (!ordinary) return opaque(record, 'exotic');
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${key}=${describe(record[key], level + 1)}`)
        .join(',')}}`;
    } finally {
      seen.delete(value);
    }
  };
  return args.map((value) => describe(value, 0)).join(',');
}

/**
 * Measure EVERY declared alternative, then aggregate pessimistically.
 *
 * The old code measured one call and let its verdict speak for the whole union: `measureVariant`
 * returns the moment a baseline is not rejected, so a healthy union was measured on branch 0 and the
 * other branches were never tried. Branch identity also rode `attempt`, the retry counter that
 * simultaneously walks curated values and admits choice-group optionals — one number selecting three
 * independent things.
 *
 * Now the two are separate: `variants` fixes WHICH alternative, `attempt` retries values WITHIN it.
 */
function measureWithAlternatives(
  record: ContractRecord,
  target: (...args: unknown[]) => unknown,
  fixtureFor: (attempt: number, variant: MeasuredAlternative) => Fixture | null,
  isConstructor: boolean,
  synthesized: boolean,
  variants: readonly MeasuredAlternative[] = [
    { id: CANONICAL_VARIANT, selection: new Map(), hand: false },
  ],
  truncated = false,
): EnforcementRecord {
  const measured = variants.map((variant) => ({
    variant,
    // A HAND-written variant is not synthesized, whatever the boundary's default is: the retry
    // ladder and the baseline check both key off how the call was PRODUCED, not off the record.
    result: measureVariant(
      record,
      target,
      fixtureFor,
      isConstructor,
      variant.hand ? false : synthesized,
      variant,
    ),
  }));
  const canonical = measured[0]!.result;
  /**
   * WHEN IS A REFUSED BRANCH A DEFECT RATHER THAN A GAP? Only when the call is KNOWN valid.
   *
   * The first version asked whether the canonical call ran, and treated any sibling rejection as
   * `valid-call-rejected`. That reasoning holds only if the two calls differ in nothing but the
   * discriminator — and it collapses in the configuration that matters most, where the canonical is
   * a HAND fixture and the siblings are synthesized. There the whole request differs, and the
   * library said so precisely: "an ATM straddle needs a spot", "delta-based strike selection needs a
   * delta on every call quote". Those are correct refusals of an under-specified request. Believing
   * them produced 23 convictions and 9 `enforced` -> `defective` flips, every one of them the
   * harness's own synthesis gap wearing a defect's label.
   *
   * So the bar is what the ruling actually set: a branch the harness cannot build a valid baseline
   * for is UNMEASURED — and unmeasured already denies the boundary `enforced`, which is the coverage
   * this was for. A defect is claimed only for a HAND-WRITTEN fixture — deliberately authored, and
   * proven declaration-valid by `fixture-validation.test.ts` — that the runtime refuses. That is the
   * one call in this harness whose validity does not rest on a guess.
   */
  const rows = measured.map(({ variant, result }) => {
    const refusedValidCall = variant.hand && result.unmeasuredReason === 'baseline-rejected';
    return {
      variant,
      refusedValidCall,
      result: refusedValidCall ? { ...result, verdict: 'defective' as MeasuredVerdict } : result,
    };
  });
  const verdict = aggregateVerdict(rows.map((row) => row.result.verdict));
  // The record that DECIDED the verdict carries the identity and rejection detail; evidence below is
  // unioned across every alternative, because each one physically ran.
  const base = rows.find((row) => row.result.verdict === verdict)?.result ?? canonical;
  if (variants.length === 1) return base;

  const key = (probe: ProbeResult): string =>
    `${probe.mutation}|${probe.argumentIndex}|${probe.field ?? ''}`;
  const union = (pick: (result: EnforcementRecord) => ProbeResult[] | undefined): ProbeResult[] => {
    const byKey = new Map<string, ProbeResult>();
    for (const row of rows)
      for (const probe of pick(row.result) ?? []) byKey.set(key(probe), probe);
    return [...byKey.values()];
  };
  const executed: Record<string, number> = {};
  for (const row of rows) {
    for (const [mutation, count] of Object.entries(row.result.mutationsExecuted ?? {})) {
      executed[mutation] = (executed[mutation] ?? 0) + count;
    }
  }
  const failures = union((result) => result.failures);
  const advisory = union((result) => result.advisory);
  const alternatives: AlternativeEvidence[] = rows.map((row) => ({
    id: row.variant.id,
    verdict: row.result.verdict,
    ...(row.variant.fixtureSource ? { fixtureSource: row.variant.fixtureSource } : {}),
    ...(row.result.unmeasuredReason ? { unmeasuredReason: row.result.unmeasuredReason } : {}),
    ...(row.refusedValidCall ? { validCallRejected: true } : {}),
    ...(row.result.rejection ? { rejection: row.result.rejection } : {}),
    ...(row.result.failures?.length ? { failures: row.result.failures.length } : {}),
  }));
  const tally = (want: MeasuredVerdict): number =>
    rows.filter((row) => row.result.verdict === want).length;
  // An aggregate that measured something is not unmeasured, so the reason must not merely be
  // overwritten — the KEY has to go, or `unmeasuredReason` outlives the verdict that justified it.
  // The rejection goes with it, for the reason the inheritance pass already records: it explained
  // why ONE attempt was refused, and once the aggregate verdict is a real measurement it is a stale
  // note about a road not taken — the alternatives array below keeps the per-variant evidence.
  const { unmeasuredReason: baseReason, rejection: baseRejection, ...carrier } = base;
  /**
   * A `partial` must say WHICH dimension is open, or it is a softer overclaim — the invariant
   * `contract-conformance.test.ts` has held since `partial` was introduced. When the ladder returns
   * `partial` because an ALTERNATIVE went unmeasured, that alternative IS the open dimension, and
   * naming it is what keeps the verdict readable: "`kellyBet` is partial" says nothing, "two of its
   * five declared alternatives could not be built" says the whole thing.
   */
  const openAlternatives = rows
    .filter((row) => row.result.verdict === 'partial' || row.result.verdict === 'unmeasured')
    .map(
      (row) =>
        `alternative ${row.variant.id} (${row.result.verdict}` +
        `${row.result.unmeasuredReason ? `: ${row.result.unmeasuredReason}` : ''})`,
    );
  const undecided = [...(base.undecided ?? []), ...openAlternatives];
  return {
    ...carrier,
    ...(verdict === 'unmeasured' && baseReason !== undefined
      ? { unmeasuredReason: baseReason }
      : {}),
    ...(verdict === 'unmeasured' && baseRejection !== undefined
      ? { rejection: baseRejection }
      : {}),
    ...(verdict === 'partial' && undecided.length > 0 ? { undecided } : {}),
    verdict,
    ...(failures.length > 0 ? { failures } : {}),
    ...(advisory.length > 0 ? { advisory } : {}),
    ...(Object.keys(executed).length > 0
      ? { mutationsExecuted: executed, mutationsCovered: { ...executed } }
      : {}),
    alternatives,
    alternativeSummary: {
      total: rows.length,
      enforced: tally('enforced'),
      partial: tally('partial'),
      defective: tally('defective'),
      unmeasured: tally('unmeasured'),
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/** One alternative, measured across the value-retry ladder. `attempt` no longer chooses a branch. */
function measureVariant(
  record: ContractRecord,
  target: (...args: unknown[]) => unknown,
  fixtureFor: (attempt: number, variant: MeasuredAlternative) => Fixture | null,
  isConstructor: boolean,
  synthesized: boolean,
  variant: MeasuredAlternative,
): EnforcementRecord {
  /**
   * A call that does not select its own branch is not evidence about that branch.
   *
   * Reported before any probe runs, and under its own name: the alternative IS declared, it IS
   * enumerated, and the harness could not produce a call that reaches it. That is a gap with a
   * specific repair, not the generic "no input could be built".
   */
  if (variant.unrealized === true) {
    return {
      id: record.id,
      package: record.package,
      implementation: record.implementation,
      verdict: 'unmeasured',
      unmeasuredReason: 'branch-not-realized',
      guardReachability: record.guardReachability,
    };
  }
  let last: EnforcementRecord | null = null;
  for (let attempt = 0; attempt < (synthesized ? ATTEMPTS : 1); attempt++) {
    const fixture = fixtureFor(attempt, variant);
    if (!fixture) break;
    const result = measureBoundary(
      record,
      target,
      fixture.call,
      isConstructor,
      synthesized,
      fixture.coordinates,
    );
    /**
     * A pre-call refusal walks the ladder too. `incomplete-baseline` used to return immediately,
     * which was right when every attempt built the SAME input — but FIELD_ALTERNATIVES makes the
     * attempts genuinely different, and the dated valuation heads showed the cost: attempt 0 built
     * the TIMED cash-flow shape, the validator correctly refused it, and the DATED shape sitting at
     * attempt 1 was never tried. A refused baseline measures nothing, so trying the next alternative
     * can only add coverage — the same argument that justifies retrying a library rejection.
     */
    const retryable =
      result.unmeasuredReason === 'baseline-rejected' ||
      result.unmeasuredReason === 'incomplete-baseline';
    if (!retryable) return result;
    /**
     * Relabel ONLY when the contract said the callback was the problem.
     *
     * This used to relabel any rejection whose declaration merely CONTAINED a required function, which
     * is a static property of the contract and not a fact about the failure. `differentialEvolution`
     * was filed `callback-input-required` while its actual error was `.for is not iterable` — bounds
     * that synthesis builds wrongly, nothing to do with its callback. The library had said exactly what
     * was wrong and the harness overwrote it with a guess.
     *
     * "X is not a function" is the library telling us it tried to CALL something we did not supply.
     * Anything else keeps `baseline-rejected` and its message, which is the more useful record.
     */
    const blamesCallback =
      result.rejection?.code === 'TypeError' &&
      /is not a function/.test(result.rejection.message ?? '');
    if (blamesCallback && requiresCallableInput(record)) {
      return { ...result, unmeasuredReason: 'callback-input-required' };
    }
    last = result;
  }
  return (
    last ?? {
      id: record.id,
      package: record.package,
      implementation: record.implementation,
      verdict: 'unmeasured',
      unmeasuredReason: 'no-input',
      guardReachability: record.guardReachability,
    }
  );
}

function measureBoundary(
  record: ContractRecord,
  target: (...args: unknown[]) => unknown,
  fixture: () => unknown[],
  isConstructor: boolean,
  synthesized: boolean,
  /** One entry per ARGUMENT passed, in order — see `Fixture`. */
  coordinates: SynthesisParameter[] = [],
): EnforcementRecord {
  /**
   * VALIDATE THE BASELINE BEFORE CALLING. See `incomplete-baseline`: a request the declaration itself
   * says is malformed tells us nothing about the contract, and calling with it produces a rejection
   * that reads as though it did.
   *
   * Only for SYNTHESIZED inputs — a hand-written fixture is a deliberate choice, including where it
   * deliberately omits something.
   */
  /**
   * EVERY baseline is validated, hand-written included.
   *
   * This ran only for SYNTHESIZED input, on the reasoning that a hand fixture is a deliberate choice.
   * That is true about what a fixture OMITS and false about what it gets wrong: a fixture that drifted
   * from a renamed field is a call no caller could make, and measuring against one describes the
   * fixture rather than the library. The separate gate proves the fixtures are valid; this makes it
   * impossible for an invalid one to reach a verdict even if that gate were removed.
   *
   * A fixture that cannot be BUILT is a harness gap and never a library defect — see the `catch`
   * around the construction below, which files `no-input` rather than convicting anything.
   */
  {
    // The coordinates that produced these arguments, not the signature they came from.
    const incomplete = incompleteBaseline(
      // Same rule the probe uses: an OPEN argument permits decoration, so an undeclared key on it is
      // not a malformed baseline.
      coordinates.map((coordinate, index) => {
        const policy = record.inputPolicies?.[String(index)];
        return policy === undefined ? coordinate : { ...coordinate, policy };
      }),
      fixture(),
    );
    if (incomplete !== null) {
      return {
        id: record.id,
        package: record.package,
        implementation: record.implementation,
        verdict: 'unmeasured',
        unmeasuredReason: 'incomplete-baseline',
        rejection: { code: 'synthesis.incomplete', typed: false, message: incomplete },
        guardReachability: record.guardReachability,
      };
    }
  }
  const unmeasured = (
    unmeasuredReason: UnmeasuredReason,
    rejection?: EnforcementRecord['rejection'],
  ): EnforcementRecord => ({
    id: record.id,
    package: record.package,
    implementation: record.implementation,
    verdict: 'unmeasured',
    unmeasuredReason,
    ...(rejection ? { rejection } : {}),
    guardReachability: record.guardReachability,
  });
  try {
    const produced = isConstructor
      ? new (target as unknown as new (...a: unknown[]) => unknown)(...fixture())
      : target(...fixture());
    /**
     * A THENABLE means the answer has not arrived. See `async-result-unobserved`: scoring mutations
     * against a promise nobody awaited would record passes for evidence never collected.
     */
    if (typeof (produced as { then?: unknown })?.then === 'function') {
      // Settle it so the process does not carry an unhandled rejection out of a measurement.
      void Promise.resolve(produced).catch(() => undefined);
      return unmeasured('async-result-unobserved');
    }
    /**
     * A GENERATOR IS NOT A THENABLE, and the guard written for `streamAsync` missed `streamAsync`.
     *
     * The comment on `async-result-unobserved` names `collectAsync` and `streamAsync` as the two
     * boundaries in question, but the test above only recognises a promise. `collectAsync` returns
     * one and was caught; `streamAsync` is an `async function*`, whose returned object carries
     * `Symbol.asyncIterator` and `next` and no `then` at all — so it sailed through.
     *
     * Nothing in an (async) generator body runs until the first `next()`. Its guards therefore never
     * executed, every mutation came back as the generator OBJECT, and the harness scored four
     * accepted mutations returning `{}` — marking `streamAsync` DEFECTIVE on evidence it never
     * observed. That is the inference this reason exists to refuse, arriving through the one shape
     * the check did not cover.
     *
     * Closed rather than advanced: driving an iterator is a real capability (it needs timeout
     * supervision, and a source that yields), and an honest gap beats a verdict nobody earned.
     */
    const iterable = produced as {
      next?: unknown;
      return?: () => unknown;
      [Symbol.asyncIterator]?: unknown;
      [Symbol.iterator]?: unknown;
    };
    if (
      typeof iterable?.next === 'function' &&
      (typeof iterable[Symbol.asyncIterator] === 'function' ||
        typeof iterable[Symbol.iterator] === 'function')
    ) {
      try {
        // Release whatever the generator is holding; an abandoned one can pin a source open.
        void iterable.return?.();
      } catch {
        // A generator that refuses to close is not this measurement's subject.
      }
      return unmeasured('async-result-unobserved');
    }
  } catch (caught) {
    /**
     * RECORD WHY the contract refused. It told us, and throwing that away made 405 paths opaque.
     *
     * `baseline-rejected` says the harness built an input and the contract would not take it. That is
     * a conversation, not a dead end: `input.missing_field` names a field synthesis did not supply,
     * `input.out_of_range` says the shape was right and a value was not. Same lesson as splitting
     * `unmeasured` by cause — a bucket nobody can act on is worth less than a smaller one that says
     * what to do.
     */
    const code = isQuantError(caught) ? (caught.code as string) : undefined;
    const field =
      caught instanceof Error
        ? // The guards format as `functionName: <field> must be …`; the field is the useful part.
          (/(?:^|:\s)([A-Za-z_$][\w$.[\]]*)\s+(?:must|is|should)\b/.exec(caught.message)?.[1] ??
          undefined)
        : undefined;
    return unmeasured('baseline-rejected', {
      code: code ?? (caught instanceof Error ? caught.constructor.name : 'unknown'),
      typed: code !== undefined,
      ...(field ? { field } : {}),
      /**
       * The MESSAGE, not just a field parsed out of it.
       *
       * The field regex reads one message shape and 168 of 262 rejections do not match it — so two
       * thirds of what the contracts said was being discarded a second time, one level below the
       * discard this record was added to fix. A contract that explains itself deserves to be quoted,
       * not paraphrased by a regex that only understands some of its sentences. Truncated because the
       * useful part is the front, and it is what makes the remaining buckets diagnosable at all.
       */
      ...(caught instanceof Error && caught.message
        ? { message: caught.message.slice(0, 160) }
        : {}),
    });
  }
  let results: ProbeResult[];
  try {
    /**
     * The declared contract per argument, so requiredness and type decide the per-field mutations —
     * and for a UNION parameter, the branch this argument actually satisfies rather than the merged
     * tree. Builder, validator and probe then read one union the same way; before this the probe was
     * the odd one out and could not convict on a branch-only field.
     *
     * `satisfiedBranch` falls back to the merged tree, so a misaligned index or an unmatched value
     * behaves exactly as it did before rather than losing the contract altogether.
     */
    const probed = fixture();
    results = probeContract(target, fixture, {
      construct: isConstructor,
      acceptsOmittedArguments: (args) =>
        provesArgumentConformance(
          coordinates.map((coordinate, index) => {
            const policy = record.inputPolicies?.[String(index)];
            return policy === undefined ? coordinate : { ...coordinate, policy };
          }),
          args,
        ),
      coordinates: coordinates.map((coordinate, index) => ({
        kind: coordinate.kind,
        type: coordinate.type,
        optional: coordinate.optional,
        ...(coordinate.literals ? { literals: coordinate.literals } : {}),
        // For a union parameter, the branch this argument actually satisfies — not the merged tree.
        ...(() => {
          const fields = satisfiedBranch(coordinate, probed[index]);
          return fields ? { fields } : {};
        })(),
      })),
    });
  } catch {
    return unmeasured('probe-failed');
  }
  /**
   * ZERO PROBES IS NOT A PASS.
   *
   * `probeContract` only mutates plain-object arguments, so a baseline with none — `formatMoney(1)`,
   * because its key contract lives on an OPTIONAL argument the synthesis had skipped — produced an
   * empty result set that the harness then graded `enforced`. It read as the strongest possible
   * verdict on the strength of having tested nothing, on a path already proven defective by hand.
   * Absence of evidence, one more time.
   */
  if (results.length === 0) {
    return unmeasured('no-mutable-argument');
  }
  /**
   * The DECLARED per-argument policy decides whether accepting an unknown key is a defect.
   *
   * Law 12 is three rules, not one: a `closed` request rejects unknown keys, an `open` structural
   * artifact ACCEPTS decoration while validating the fields it consumes, and `passthrough` owns a
   * foreign schema. Convicting every acceptance treated the second and third as violations of the
   * first — nine paths were marked defective for behaviour their contract explicitly permits,
   * `crossOver` among them, which declares two open arguments.
   *
   * Type mutations still convict on an open argument: `open` permits EXTRA keys, never a `NaN` in a
   * field the contract consumes as a finite number.
   */
  const policyFor = (argumentIndex: number): string =>
    record.inputPolicies?.[String(argumentIndex)] ?? 'closed';

  /**
   * EACH POLICY HAS ITS OWN PASSING OUTCOME. This scored only one direction.
   *
   * The rule was "an unknown key on a non-closed argument is permitted", which
   * excused the probe's RESULT rather than judging it: an `open` contract that
   * wrongly REJECTS decoration scored exactly like one that correctly accepts
   * it, so the harness could not detect the failure the policy exists to
   * describe. `open` is a promise in both directions — it says extra keys are
   * accepted, and a boundary that refuses them is breaking that promise.
   *
   *   closed       rejection passes, acceptance fails (Law 12's default)
   *   open         acceptance passes, rejection fails
   *   passthrough  unscored — it owns a foreign schema and we have no opinion
   *
   * Type mutations are unaffected: `open` permits EXTRA keys, never a `NaN` in a
   * field the contract consumes as a finite number.
   */
  const isFailure = (result: ProbeResult): boolean => {
    if (result.mutation !== 'unknown-key') return result.verdict !== 'rejected';
    const policy = policyFor(result.argumentIndex);
    if (policy === 'passthrough') return false;
    if (policy === 'open') return result.verdict !== 'accepted';
    return result.verdict !== 'rejected';
  };

  /**
   * PASSTHROUGH IS UNSCORED, and "unscored" cannot mean "passes".
   *
   * Returning `false` from `isFailure` excused the result but LEFT IT IN `results`, and `unknown-key`
   * is always authoritative — so the probe still counted toward `authoritativeTested` and could carry
   * a boundary to `enforced` on the strength of a dimension nobody judged. That is the same
   * absence-of-evidence shape as the zero-probe rule below, arriving by a different door: a contract
   * that owns a foreign schema has no opinion to test, so the probe must leave the population rather
   * than pass it.
   */
  const scored = results.filter(
    (result) =>
      !(result.mutation === 'unknown-key' && policyFor(result.argumentIndex) === 'passthrough'),
  );
  /**
   * MEMBER mutations on an argument whose manifest policy is OPEN are ADVISORY, not authoritative
   * (C05): an open structural artifact validates its CONSUMED fields while unconsumed members may
   * legitimately be absent — `priceMultiCurve` never calls `discountCurve.addSpread`, so accepting
   * a curve without it is the documented contract, and convicting it manufactures defects out of
   * correct behaviour (the same reasoning that keeps container mutations advisory). Which members
   * a boundary consumes is not statically knowable, so per-boundary adjudication is the honest
   * verdict; `unknown-key` keeps its own policy branch (open must ACCEPT decoration).
   */
  const openMemberAdvisory = (result: ProbeResult): boolean =>
    result.field !== undefined &&
    result.mutation !== 'unknown-key' &&
    policyFor(result.argumentIndex) === 'open';
  /**
   * A curated by-design non-finite domain (see NON_FINITE_IN_DOMAIN): the declaration says
   * `number` because TypeScript cannot say "number including NaN", and the function's purpose is
   * to ACCEPT the non-finite value — the observation is real, the conviction would be false, so
   * it lands in advisory like the open-member class above.
   */
  const nonFiniteByDesign = (result: ProbeResult): boolean =>
    result.mutation === 'non-finite' &&
    NON_FINITE_IN_DOMAIN[`${record.id}#${String(result.argumentIndex)}`] !== undefined;
  /** Member mutations under a curated artifact-valued FIELD (C05 one level down) — advisory. */
  const artifactMemberAdvisory = (result: ProbeResult): boolean => {
    if (result.field === undefined || !result.field.includes('.')) return false;
    const roots = ARTIFACT_VALUED_FIELDS[`${record.id}#${String(result.argumentIndex)}`];
    return roots !== undefined && roots.includes(result.field.split('.')[0]!);
  };
  const failures = scored.filter(
    (result) =>
      isAuthoritative(result) &&
      !openMemberAdvisory(result) &&
      !nonFiniteByDesign(result) &&
      !artifactMemberAdvisory(result) &&
      isFailure(result),
  );
  const advisory = scored.filter(
    (result) =>
      (!isAuthoritative(result) ||
        openMemberAdvisory(result) ||
        nonFiniteByDesign(result) ||
        artifactMemberAdvisory(result)) &&
      isFailure(result),
  );
  /**
   * `enforced` requires that something authoritative was actually DECIDED and passed, and that no
   * dimension was left open. Three ways to fall short of it, and only one of them is a defect.
   */
  const authoritativeTested = scored.filter((result) => isAuthoritative(result)).length;
  const verdict: MeasuredVerdict =
    failures.length > 0
      ? 'defective'
      : authoritativeTested === 0 || advisory.length > 0
        ? 'partial'
        : 'enforced';

  const entry: EnforcementRecord = {
    id: record.id,
    package: record.package,
    implementation: record.implementation,
    verdict,
    guardReachability: record.guardReachability,
  };
  if (verdict === 'partial') {
    entry.undecided = [
      ...new Set([
        ...(authoritativeTested === 0 ? ['no-authoritative-dimension-tested'] : []),
        ...advisory.map((result) => result.mutation),
      ]),
    ].sort();
  }
  /**
   * WHAT WAS ATTEMPTED, not only what failed.
   *
   * `failures` and `advisory` record results whose verdict is not `rejected`, so a dimension that is
   * fully enforced leaves NO trace — and "this mutation records nothing" reads identically whether
   * the boundary refused it or the probe never ran. `invalid-literal` recording zero library-wide is
   * exactly that ambiguity, and no assertion over the artifact could resolve it.
   *
   * These counts make coverage checkable from the artifact itself: a coordinate that should have
   * been probed and was not shows up as a missing attempt rather than as silence.
   */
  const attempted = results.reduce<Record<string, number>>((into, result) => {
    into[result.mutation] = (into[result.mutation] ?? 0) + 1;
    return into;
  }, {});
  if (Object.keys(attempted).length > 0) {
    /**
     * TWO NUMBERS, because "coverage" has two honest meanings and one name for both is how the last
     * table came to mix them. EXECUTED is what physically ran here; COVERED is what this path can
     * claim, directly or by attribution. For a record measured in place they are equal — they
     * diverge only on an alias that inherited a verdict without running anything, and reporting the
     * inherited figure as if it were execution overstated `unknown-key` as 4,147 against 1,788 runs.
     */
    entry.mutationsExecuted = attempted;
    entry.mutationsCovered = { ...attempted };
  }
  if (synthesized) entry.synthesized = true;
  if (record.inputPolicies) entry.inputPolicies = record.inputPolicies;
  if (failures.length > 0) entry.failures = failures;
  if (advisory.length > 0) entry.advisory = advisory;
  return entry;
}

export async function buildEnforcementRecord(): Promise<{
  version: number;
  summary: Record<string, unknown>;
  /**
   * The 23 MCP tool contracts, enumerated from the LIVE registry.
   *
   * A tool contract is a runtime value (a schema object built at module load), so declaration reading
   * cannot see it — which is why the inventory had `defaultTools` and `TotalFinanceTool#run` but not one
   * record for `totalfinance.option.price`. This is the surface an agent actually calls, and a hallucinated
   * field name meets it first.
   */
  mcpTools: McpToolContract[];
  enforcement: EnforcementRecord[];
}> {
  const contractGraph = JSON.parse(readFileSync(CONTRACTS, 'utf8')) as {
    contracts: ContractRecord[];
    /** Required member names per contract identity — see `contractMembers` in the inventory. */
    contractMembers?: Record<string, string[]>;
  };
  const { contracts } = contractGraph;
  const { callables } = JSON.parse(readFileSync(SIGNATURES, 'utf8')) as {
    callables: { id: string; entrypoints: string[] }[];
  };
  const entrypointsById = new Map(callables.map((callable) => [callable.id, callable.entrypoints]));
  const fixtures = allFixtures();

  // Only boundaries where enforcement is REQUIRED, and only those carrying an object contract: a
  // positional scalar kernel has no object to break.
  const REQUIRED = new Set(['entry-point', 'snapshot-restore', 'constructor']);
  const hasProbeableArgument = (record: ContractRecord): boolean =>
    (record.signatures[0]?.parameters ?? []).some(
      (parameter) => parameter.kind === 'object' || parameter.kind === 'series',
    );
  const targets = contracts.filter(
    (record) =>
      REQUIRED.has(record.boundaryKind) &&
      // An object contract OR a series/container one. Filtering on `inputContract !== null` meant a
      // series API — `attribution(trades)`, `cholesky(matrix)`, most of technical analysis — was
      // excluded outright: 445 required boundaries with no measurement of any kind.
      (record.inputContract !== null || hasProbeableArgument(record)),
  );

  /** Every contract by id, so a member can find its owner's constructor. */
  const contractById = new Map(contracts.map((record) => [record.id, record]));

  /**
   * Callables indexed by the contract they RETURN — how a member reaches a receiver it cannot
   * construct. See the note at the receiver branch below.
   *
   * Sorted by id so the choice of factory is deterministic rather than dependent on record order.
   */
  const factoriesByResult = new Map<string, ContractRecord[]>();
  for (const record of [...contracts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const signature of record.signatures) {
      const result = signature.resultContract;
      if (!result) continue;
      const list = factoriesByResult.get(result);
      if (list) list.push(record);
      else factoriesByResult.set(result, [record]);
    }
  }
  /**
   * The owner's contract identity, derived from its public id the same way the inventory derives it:
   * `@totalfinance/fixed-income:Bond` for a member id of `@totalfinance/fixed-income:Bond#accrued`.
   */
  const ownerContractIdentity = (ownerId: string): string | null =>
    ownerId.includes(':') ? ownerId : null;

  /**
   * PRODUCERS — one working instance per contract the library makes but a declaration cannot describe.
   *
   * `curveMetrics.explain([bond, curve, options])` needs a real `Bond`: a class with methods, where
   * reading the declaration yields a shape with no working `cashflows()`. The library makes them, and
   * `factoriesByResult` already says which callable returns which contract, so this is a lookup.
   *
   * Resolved ONCE and up front, because synthesis is synchronous and module resolution is not. Trying
   * to reach for a factory mid-synthesis would mean making the whole build path async for a fallback
   * that fires on a few dozen parameters.
   *
   * A factory earns its place by WORKING, not by being declared: it must synthesize its own arguments
   * and return an object when called. A recorded result contract is a declaration, and a declaration
   * that throws is not a producer.
   */
  /**
   * The REQUIRED members of each named contract, gathered from every parameter that declares it.
   *
   * This is what makes a produced instance checkable. "It returned an object" is not evidence that it
   * returned a `YieldCurve`: `curves.discountFactor` is recorded as returning one, does not, and the
   * first version of this loop accepted it — so `curveMetrics.explain` was handed a bogus curve and
   * answered `curve.discount is not a function`. A produced value that fails its own contract is worse
   * than none, because it converts a clean `no-input` into a false rejection.
   */
  const requiredMembers = new Map<string, readonly string[]>(
    Object.entries(contractGraph.contractMembers ?? {}),
  );

  const producers = new Map<string, () => unknown>();
  for (const [contract, candidates] of [...factoriesByResult].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const required = requiredMembers.get(contract);
    for (const candidate of candidates) {
      // A method of the type it returns is circular: `YieldCurve#addSpread` needs a curve to make one.
      if (candidate.id.includes('#')) continue;
      const parameters = candidate.signatures[0]?.parameters ?? [];
      if (synthesizeArguments(parameters, candidate.fields ?? []) === null) continue;
      const target = await resolveCallable(
        candidate.id,
        entrypointsById.get(candidate.id) ?? ['.'],
      );
      if (!target) continue;
      const make = (): unknown =>
        target(...(synthesizeArguments(parameters, candidate.fields ?? []) ?? []));
      try {
        const sample = make();
        if (sample === null || typeof sample !== 'object') continue;
        // It must actually BE one: every required member the contract declares must be present.
        if (required?.some((name) => !(name in (sample as object)))) continue;
      } catch {
        continue;
      }
      producers.set(contract, make);
      if (process.env['TOTALFINANCE_PRODUCER_TRACE'])
        process.stderr.write(`__TOTALFINANCE_PRODUCER ${contract} <- ${candidate.id}\n`);
      break;
    }
  }

  /**
   * A member is addressed through its owner; a constructor through its class. Shared with the
   * measurement loop so the grouping pre-pass and the measurement resolve the SAME name — two
   * spellings of this rule is how the group and the thing measured come apart.
   */
  const resolveIdOf = (id: string): string =>
    id.endsWith('.constructor') ? id.slice(0, -'.constructor'.length) : id;

  const enforcement: EnforcementRecord[] = [];
  /**
   * The canonical measurement for each resolved function object — see the note at the measurement
   * site. Keyed on the object because that is the only thing that proves two names are one function.
   */
  const measuredByTarget = new Map<unknown, EnforcementRecord>();
  /**
   * Announce each boundary before calling it, so a supervisor outside this process can name the one
   * that never returned. Off unless asked for: the generator writes one line per boundary and there
   * are 4,342 of them.
   */
  const trace = process.env['TOTALFINANCE_MEASURE_TRACE'] === '1';

  /**
   * Boundaries the supervisor has already watched hang, passed back on a restart.
   *
   * This is what makes a hang SURVIVABLE rather than merely diagnosable. Synchronous JavaScript
   * cannot be interrupted from inside itself, so the process that hangs cannot skip the call and
   * carry on — but a process OUTSIDE it can kill it, note which boundary was in flight, and start
   * again with that one excluded. Each hang costs one re-run; the artifact still gets produced, with
   * the offending boundaries honestly recorded rather than silently missing.
   */
  /**
   * The DECLARED list first, the supervisor's discoveries second.
   *
   * Reading only the environment variable made the generator's answer depend on who launched it: the
   * supervisor sets it, and the drift gate — which regenerates in-process to compare against the
   * committed artifact — does not. So the committed record said `probe-timeout` for `swapXva` and the
   * in-process regeneration measured it, and the two disagreed about a boundary neither had changed.
   *
   * A generator that behaves differently depending on its caller cannot be checked for drift, which
   * is the one thing this artifact most needs. The policy is the source of truth; the env var only
   * ADDS to it, for the supervisor's tripwire.
   */
  const skipped = new Set([
    /**
     * `TOTALFINANCE_IGNORE_DECLARED_SKIPS=1` is the AUDIT PATH, and it is load-bearing rather than a debug aid:
     * a skip-list entry must never be its own evidence, so there has to be a way to ask the library
     * directly whether a declared boundary still fails to return. It is how the `swapXva` entry was
     * found to be false.
     */
    ...(process.env['TOTALFINANCE_IGNORE_DECLARED_SKIPS']
      ? []
      : Object.keys(NON_TERMINATING_BOUNDARIES)),
    ...(process.env['TOTALFINANCE_SKIP_BOUNDARIES'] ?? '')
      .split(',')
      .filter((id) => id.trim() !== ''),
  ]);

  /**
   * RESOLVE AND GROUP BEFORE MEASURING — the semantic callable group.
   *
   * A hand fixture was keyed to ONE public spelling, so every other name for the same function was
   * measured against synthesis instead. `collectAsync` is the visible case: the scoped name builds a
   * real `IndicatorStream` from its fixture and reports `async-result-unobserved`, while both
   * umbrella spellings fail to build one and report `callback-input-required` — one runtime function,
   * one contract, two accounts of what is wrong with it. 656 fingerprint-equal groups have some names
   * fixtured and others not, covering 1,333 alias records.
   *
   * The group key is the RESOLVED FUNCTION OBJECT plus the complete contract fingerprint plus the
   * invocation mode. It cannot be computed from the artifact, and that is measured rather than
   * assumed: `implementation` is a declaration-template identity, so dropping `record.fields` from the
   * fingerprint merges 24 different technical-analysis indicators that share one `.explain` template,
   * while keeping `fields` splits genuine twins because the field index is package-qualified
   * (`buildStrategy` carries 79 field paths scoped and 3 through the umbrella, for one declaration).
   * Only the function object separates the first case and unifies the second.
   *
   * Sorted by id, so which member becomes the fixture source is a property of the SET rather than of
   * the order records happen to arrive in.
   */
  const byId = (a: ContractRecord, b: ContractRecord): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  interface CallableGroup {
    members: ContractRecord[];
    isConstructor: boolean;
    /**
     * INVOCATION MODE, the third part of the group key.
     *
     * A function object can be both exported bare and installed on a prototype. Called without a
     * receiver it is a different call from `instance.method(...)` — `this` is undefined in one and
     * the instance in the other — so grouping them would attribute a receiverless measurement to a
     * path that always has a receiver.
     */
    viaReceiver: boolean;
  }
  const groups: CallableGroup[] = [];
  const groupOfRecord = new Map<string, number>();
  /**
   * A RECEIVER METHOD IS A FUNCTION OBJECT TOO — it just does not live on a module.
   *
   * `resolveCallable` returns nothing for `SimulatedBroker#processBar`, so every instance method fell
   * out of the grouping pre-pass: all 78 receiver records carried no `measurementSource` and could
   * not pool a sibling's fixture. The PROTOTYPE holds the one function object every instance shares,
   * which is exactly the identity the group key wants, and reading it constructs nothing — so it
   * cannot perturb a stateful receiver the way constructing one to look would.
   *
   * Owners reachable only through a factory (`Bond`, `YieldCurve`) have no prototype to read from a
   * module export and stay ungrouped, rather than being grouped on a guess.
   */
  const prototypeMethod = async (id: string): Promise<unknown> => {
    const hash = id.indexOf('#');
    if (hash < 0) return undefined;
    const owner = await resolveCallable(id.slice(0, hash), entrypointsById.get(id) ?? ['.']);
    if (typeof owner !== 'function') return undefined;
    const prototype = (owner as { prototype?: Record<string, unknown> }).prototype;
    const method = prototype?.[id.slice(hash + 1)];
    return typeof method === 'function' ? method : undefined;
  };
  let receiverGroupingGaps = 0;
  {
    const byTarget = new Map<unknown, number[]>();
    for (const record of [...targets].sort(byId)) {
      if (skipped.has(record.id)) continue;
      const target =
        (await resolveCallable(resolveIdOf(record.id), entrypointsById.get(record.id) ?? ['.'])) ??
        (await prototypeMethod(record.id));
      if (!target) {
        if (record.id.includes('#')) receiverGroupingGaps += 1;
        continue;
      }
      const isConstructor = record.id.endsWith('.constructor');
      const viaReceiver = record.id.includes('#');
      const candidates = byTarget.get(target) ?? [];
      let index = candidates.find(
        (candidate) =>
          groups[candidate]!.isConstructor === isConstructor &&
          groups[candidate]!.viaReceiver === viaReceiver &&
          sameCallShape(groups[candidate]!.members[0], record, true),
      );
      if (index === undefined) {
        index = groups.length;
        groups.push({ members: [], isConstructor, viaReceiver });
        byTarget.set(target, [...candidates, index]);
      }
      groups[index]!.members.push(record);
      groupOfRecord.set(record.id, index);
    }
  }

  /**
   * ONE fixture per group, pooled from every member and chosen deterministically.
   *
   * A fixture is a claim about the CALLABLE, not about the spelling it was filed under, so a fixture
   * written for the scoped name is the right input for its umbrella twin — they are the same function
   * under the same contract, which is exactly what the group key establishes. The lowest id that has
   * one wins, so the choice does not depend on iteration order.
   */
  const pooledFixtures = new Map<number, PooledFixture[]>();
  for (const [index, group] of groups.entries()) {
    const owned: PooledFixture[] = [];
    for (const member of group.members) {
      const own = fixtures.get(fixtureKey(member.id)) as (() => unknown[]) | undefined;
      if (own) owned.push({ call: own, source: member.id });
    }
    if (owned.length > 0) pooledFixtures.set(index, owned);
  }

  /**
   * THE RICHEST FIELD INDEX IN THE GROUP, not the canonical member's own.
   *
   * `record.fields` is the package-qualified index of field paths synthesis consults, and it is
   * DELIBERATELY excluded from the group key: `buildStrategy` carries 79 paths under its scoped name
   * and 3 through the umbrella, for one declaration of one function. Excluding it from identity while
   * still measuring with whichever member happened to sort first meant the group could be measured
   * through the 3-path index — the same callable, the same contract, measured with a quarter of the
   * evidence, and nothing in the artifact would say so.
   *
   * Pooled PER OWNER TYPE, which is the granularity the index is actually consulted at: synthesis
   * filters it to `Owner.` for the owner named by the parameter's type, so entries for other owners
   * are inert. Taking whichever member has the most paths OVERALL was the first attempt and it cost
   * 89 boundaries their measurement — a member can hold more paths in total while holding NONE for
   * the owner this parameter needs, and an owner with no entries synthesizes to nothing at all.
   *
   * Within one owner the largest set wins entire, rather than being merged across members. A merge
   * could compose a key set no declaration has, and the one thing this harness must never do is
   * measure a call no caller could make.
   */
  const pooledFields = new Map<number, readonly string[]>();
  for (const [index, group] of groups.entries()) {
    const pooled = poolFieldIndex(group.members);
    if (pooled.length > 0) pooledFields.set(index, pooled);
  }

  /**
   * ONE member of each group does the measuring; the rest receive its evidence.
   *
   * The lowest id, so which path is canonical is a property of the SET. Measuring every alias instead
   * would add physical executions and no knowledge — and for a STATEFUL callable it would make the
   * answer depend on probe order, which is the failure canonical measurement exists to prevent.
   */
  const canonicalOfGroup = new Map<number, string>(
    groups.map((group, index) => [index, group.members[0]!.id]),
  );

  let measured = 0;
  for (const record of targets) {
    /**
     * YIELD TO THE EVENT LOOP periodically. This loop `await`s a MEMOIZED resolver, so after the first
     * pass almost every await settles on the microtask queue — which does not yield to timers or I/O.
     * Fourteen minutes of that starves anything living on the macrotask queue.
     *
     * It showed up as `[vitest-worker]: Timeout calling "onTaskUpdate"` on Node 22.13, the minimum
     * supported version: all 6,604 tests passed and the run still failed, because the reporter's
     * heartbeat never got a turn. A generator that monopolises the loop is a bad citizen in any host,
     * so this belongs here rather than in a test config.
     *
     * `setImmediate` rather than `setTimeout(0)`: it runs in the check phase, after I/O callbacks, so
     * it is the cheapest yield that actually lets pending I/O through.
     */
    if (++measured % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    /**
     * NOT the canonical member? Its evidence comes from the group after this loop.
     *
     * Skipping here is what makes "measure once" true rather than aspirational: the alias never
     * touches the callable, so it cannot perturb a stateful target and cannot contribute a physical
     * execution to the totals.
     */
    const groupIndex = groupOfRecord.get(record.id);
    if (groupIndex !== undefined && canonicalOfGroup.get(groupIndex) !== record.id) continue;
    // Each boundary starts from a clean identity counter, so measuring it twice yields one record.
    resetSynthesisIdentities();
    if (skipped.has(record.id)) {
      enforcement.push({
        id: record.id,
        package: record.package,
        implementation: record.implementation,
        verdict: 'unmeasured',
        unmeasuredReason: 'probe-timeout',
        guardReachability: record.guardReachability,
      });
      continue;
    }
    if (trace) process.stderr.write(`__TOTALFINANCE_MEASURING ${record.id}\n`);
    // A constructor path addresses the class; `Foo.constructor` would resolve to `Function` itself.
    const isConstructor = record.id.endsWith('.constructor');
    const resolveId = resolveIdOf(record.id);
    // A hand-written fixture first; otherwise synthesize from the declaration. The synthesized
    // baseline is verified below by CALLING it — a throw means the guess was wrong and the path stays
    // unmeasured, so synthesis can only add coverage, never a false verdict.
    let synthesized = false;
    // A FRESH argument list per call — probes mutate what they are handed, so a shared object would let
    // one probe corrupt the next and the verdicts would depend on their order.
    /**
     * ONE source of truth for the input, attempt-aware throughout.
     *
     * It was briefly two — a `fixture` and a `fixtureFor` derived from it — and the `.fromJSON` branch
     * below, which overrides the input with a real snapshot, wrote to the one that was no longer being
     * read. 133 boundaries silently reverted to the generic object and answered
     * "schema version 1 predates the explicit envelope (2)" again, which is exactly the failure that
     * branch exists to prevent. A second variable holding a stale copy of the first is not a
     * refactoring detail; it is a bug with a rehearsal.
     */
    /**
     * The group's fixture, which may have been written under another of its names.
     *
     * `fixtureSource` records which one, so a reader can always see whose call produced the evidence
     * — attribution without auditability is how a shared input becomes untraceable.
     */
    const groupIndexOfRecord = groupOfRecord.get(record.id) ?? -1;
    const ownFixture = fixtures.get(fixtureKey(record.id)) as (() => unknown[]) | undefined;
    /**
     * EVERY fixture the group owns — the record's own first, so a boundary measured alone behaves
     * exactly as it did.
     */
    const handFixtures: PooledFixture[] =
      pooledFixtures.get(groupIndexOfRecord) ??
      (ownFixture ? [{ call: ownFixture, source: record.id }] : []);
    const declaredCoordinates = expandedCoordinates(record.signatures[0]?.parameters ?? []);
    const parameters = record.signatures[0]?.parameters ?? [];
    /** The group's richest field index — see `pooledFields`. */
    const measuredFields = pooledFields.get(groupIndexOfRecord) ?? record.fields ?? [];
    const plan = planVariants({
      parameters,
      fields: measuredFields,
      producers,
      declaredCoordinates,
      hand: handFixtures,
    });
    let { variants, fixtureFor } = plan;
    let variantsTruncated = plan.truncated;
    if (plan.synthesized) synthesized = true;
    /**
     * The fixture provenance for the row as a whole: the source that produced the FIRST hand
     * alternative. Per-alternative provenance travels on the alternatives themselves.
     */
    const fixtureSource = variants.find((variant) => variant.hand)?.fixtureSource;
    /**
     * A SNAPSHOT comes from the thing that produces snapshots, not from a guess.
     *
     * 134 `Stream.fromJSON(snapshot)` boundaries rejected their synthesized input with
     * `snapshot.unsupported_version`, and rightly: synthesis built a plain object from the declared
     * fields, and a snapshot is not merely a shape — it carries a version its reader checks. The only
     * input guaranteed to be a valid snapshot is the one the stream itself emits, and producing it is
     * exactly the round trip `fromJSON` exists for.
     *
     * The constructor is already reachable in the contract graph, which is what R12 established for
     * receivers; this reuses it.
     */
    if (record.id.endsWith('.fromJSON')) {
      const owner = record.id.slice(0, -'.fromJSON'.length);
      const ownerValue = await resolveCallable(owner, entrypointsById.get(record.id) ?? ['.']);
      const constructorRecord = contractById.get(`${owner}.constructor`);
      const constructorParameters = constructorRecord?.signatures[0]?.parameters ?? [];
      if (ownerValue) {
        const snapshot = ((): unknown => {
          try {
            const built =
              synthesizeArguments(
                constructorParameters,
                constructorRecord?.fields ?? [],
                0,
                producers,
              ) ?? [];
            const instance = new (ownerValue as unknown as new (...a: unknown[]) => unknown)(
              ...built,
            ) as { toJSON?: () => unknown };
            return typeof instance.toJSON === 'function' ? instance.toJSON() : undefined;
          } catch {
            return undefined;
          }
        })();
        if (snapshot !== undefined) {
          synthesized = true;
          // A snapshot is not attempt-dependent: it is produced by the stream, not curated.
          // A snapshot is produced, not declared, so it has no union alternatives to enumerate.
          variants = [{ id: CANONICAL_VARIANT, selection: new Map(), hand: false }];
          variantsTruncated = false;
          fixtureFor = () => ({
            coordinates: declaredCoordinates,
            call: () => [
              // A FRESH snapshot per probe: they mutate what they are handed.
              (() => {
                const built =
                  synthesizeArguments(
                    constructorParameters,
                    constructorRecord?.fields ?? [],
                    0,
                    producers,
                  ) ?? [];
                const instance = new (ownerValue as unknown as new (...a: unknown[]) => unknown)(
                  ...built,
                ) as { toJSON: () => unknown };
                return instance.toJSON();
              })(),
            ],
          });
        }
      }
    }

    // Resolve FIRST, so a member that cannot be reached is reported as unreachable rather than as a
    // synthesis gap — "no input could be built" invites someone to go build one that would not help.
    const target = await resolveCallable(resolveId, entrypointsById.get(record.id) ?? ['.']);
    if (!target) {
      /**
       * Which KIND of unreachable? The two need different work, and calling both "not callable"
       * asserted that neither needed any.
       *
       * If the owning type resolves to a runtime value, it is a class or factory this harness could
       * construct and does not yet — `receiver-unresolved`. If it resolves to nothing, the type is a
       * pure interface the consumer implements and the library calls, so there is no library-side
       * implementation to probe here at all.
       */
      const owner = record.id.includes('#') ? record.id.slice(0, record.id.indexOf('#')) : null;
      const ownerValue = owner
        ? await resolveCallable(owner, entrypointsById.get(record.id) ?? ['.'])
        : null;
      /**
       * R12 — ACQUIRE THE RECEIVER rather than declaring the member unmeasurable.
       *
       * `SimulatedBroker#exerciseOption` cannot be reached from a module because it is an instance
       * method; it needs an instance. All 42 such members have their owner's constructor recorded in
       * the contract graph, so the receiver is constructible from the same declaration the harness
       * already reads. Calling them "not callable" said the work was impossible when it was merely
       * undone.
       *
       * A FRESH instance per call, not one shared across probes. These objects are stateful —
       * `SimulatedBroker#processBar`, `FeaturePipeline#*`, `BarAggregator#*` all mutate — so a shared
       * receiver would let one mutation decide the next probe's verdict, and the verdicts would depend
       * on probe order.
       */
      const member = record.id.slice(record.id.indexOf('#') + 1);
      const constructorRecord = owner ? contractById.get(`${owner}.constructor`) : undefined;
      const constructorParameters = constructorRecord?.signatures[0]?.parameters ?? [];
      const constructorArguments = ownerValue
        ? synthesizeArguments(constructorParameters, constructorRecord?.fields ?? [], 0, producers)
        : null;
      // A no-argument constructor synthesizes to `null`; that is a valid receiver, not a failure.
      const constructible =
        ownerValue !== null &&
        (constructorArguments !== null || constructorParameters.length === 0);

      /**
       * A receiver can be PRODUCED as well as constructed, and 20 boundaries turned on that word.
       *
       * `Bond#accrued`, `HullWhiteModel#caplet`, `YieldCurve#addSpread` were filed
       * `external-callback-contract` — "a callback the LIBRARY calls, with no implementation here to
       * probe". That is exactly wrong: the library implements every one of them. They landed there
       * only because the reason was chosen by whether the owner resolves as a runtime EXPORT, and a
       * `Bond` is not exported — it is returned. `bonds.fixedRate(...)` makes one.
       *
       * The inventory already recorded the answer: every callable's `resultContract`. So the owner's
       * factory is a lookup, not a guess — and the same mistake as the retired `not-callable` reason,
       * which also claimed work was impossible when it was merely undone.
       *
       * Deterministic tie-break: factories are sorted by id and the first that produces a usable
       * instance wins, so the artifact does not depend on record order. A factory that is itself a
       * method of the type it returns is skipped — `YieldCurve#addSpread` returns a `YieldCurve`, and
       * using it to obtain one is circular.
       */
      const factoryFor = async (): Promise<(() => unknown) | null> => {
        /**
         * Tried whenever the receiver cannot be CONSTRUCTED, not only when the owner fails to
         * resolve.
         *
         * The first cut gated on `ownerValue === null`, which is the case that motivated it
         * (`Bond` is returned, never exported) and not the whole of it. `SimulatedBroker`,
         * `Position`, `ExposureProfile`, `FeaturePipeline` and `VolatilitySurface` all resolve as
         * exports and all have constructors synthesis cannot fill — and all of them have a public
         * factory recorded: `brokers.simulated`, `bearCallLadder`, `exposure`, `features`. Being
         * exported is not the question; being obtainable is.
         */
        if (!owner || constructible) return null;
        const wanted = ownerContractIdentity(owner);
        if (!wanted) return null;
        for (const candidate of factoriesByResult.get(wanted) ?? []) {
          if (candidate.id.includes('#')) continue; // circular: a method of the type it returns
          const parameters = candidate.signatures[0]?.parameters ?? [];
          if (synthesizeArguments(parameters, candidate.fields ?? []) === null) continue;
          const target = await resolveCallable(
            candidate.id,
            entrypointsById.get(candidate.id) ?? ['.'],
          );
          if (!target) continue;
          /**
           * A FRESH instance per call, for the same reason a constructed receiver gets one: probes
           * mutate what they are handed, and a shared `Bond` would let one probe decide the next
           * one's verdict.
           */
          const produceOne = (): unknown =>
            target(...(synthesizeArguments(parameters, candidate.fields ?? []) ?? []));
          // The factory must actually WORK. A recorded result contract is a declaration, and a
          // declaration that throws when called is not a receiver.
          try {
            const sample = produceOne();
            if (sample === null || typeof sample !== 'object') continue;
          } catch {
            continue;
          }
          return produceOne;
        }
        return null;
      };
      const produce = await factoryFor();

      if ((constructible || produce !== null) && member !== '') {
        const receiverTarget = (...args: unknown[]): unknown => {
          const instance = (
            produce !== null
              ? produce()
              : new (ownerValue as unknown as new (...a: unknown[]) => unknown)(
                  ...(synthesizeArguments(
                    constructorParameters,
                    constructorRecord?.fields ?? [],
                    0,
                    producers,
                  ) ?? []),
                )
          ) as Record<string, unknown>;
          const method = instance[member];
          if (typeof method !== 'function') {
            throw new TypeError(
              `${record.id}: ${member} is not callable on a constructed receiver`,
            );
          }
          return (method as (...a: unknown[]) => unknown).apply(instance, args);
        };
        /**
         * The member's input, planned by the SAME rules a module-level callable gets.
         *
         * It used to be planned here, differently: a hand fixture became the whole measurement and
         * union enumeration was switched off entirely, so a receiver method with a fixture and a
         * multi-way union was measured on one branch. The module path had already been corrected for
         * exactly that; `planVariants` is now the only place either question is answered.
         */
        const parameters = record.signatures[0]?.parameters ?? [];
        const memberPlan = planVariants({
          parameters,
          fields: measuredFields,
          producers,
          declaredCoordinates: expandedCoordinates(parameters),
          hand: handFixtures,
        });
        if (
          memberPlan.fixtureFor(
            0,
            memberPlan.variants[0] ?? {
              id: CANONICAL_VARIANT,
              selection: new Map(),
              hand: false,
            },
          )
        ) {
          const measuredMember = measureWithAlternatives(
            record,
            receiverTarget,
            memberPlan.fixtureFor,
            false,
            memberPlan.synthesized,
            memberPlan.variants,
            memberPlan.truncated,
          );
          const memberFixtureSource = memberPlan.variants.find(
            (variant) => variant.hand,
          )?.fixtureSource;
          if (memberFixtureSource !== undefined) {
            measuredMember.fixtureSource = memberFixtureSource;
          }
          enforcement.push(measuredMember);
          continue;
        }
      }

      /**
       * THE RECEIVER OR THE INPUT — say which, because they are different work.
       *
       * This fell through to `receiver-unresolved` whenever the measurement did not happen, and for
       * all 12 of them the receiver was fine. `SimulatedBroker#equity(marks)`,
       * `ExposureProfile#levels(options)`, `VolatilitySurface#shock(shifts, …)` — every one has an
       * obtainable receiver and an argument synthesis could not build. Reporting that as an
       * unreachable receiver sends the reader to construct something that already constructs.
       *
       * Third time this exact shape of mistake has been corrected here: the reason was being chosen
       * by WHICH BRANCH GAVE UP rather than by what was missing. `not-callable` claimed instance
       * methods held nothing to measure; `external-callback-contract` claimed `Bond#accrued` had no
       * implementation to probe; this claimed a constructed receiver could not be reached. In each
       * case the label named the harness's own last step instead of the gap.
       */
      const receiverObtainable = constructible || produce !== null;
      const receiverReason: UnmeasuredReason = receiverObtainable
        ? synthesisGap(record.signatures[0]?.parameters ?? [], record.fields ?? [], producers)
            ?.kind === 'function'
          ? 'callback-input-required'
          : 'no-input'
        : ownerValue
          ? 'receiver-unresolved'
          : 'external-callback-contract';
      /**
       * A RECEIVER ROW PUBLISHES ITS ALTERNATIVES TOO.
       *
       * The module path was taught this and the receiver path was not, so `Position#whatIfCube` — six
       * declared alternatives — reported one row-level `no-input` and nothing about its shapes. Two
       * paths answering one question differently is the defect this file keeps finding; the rule is
       * the same on both, or it is not a rule.
       */
      const receiverDeclared = enumerateVariants(
        record.signatures[0]?.parameters ?? [],
        record.fields ?? [],
        producers,
      );
      enforcement.push({
        id: record.id,
        package: record.package,
        implementation: record.implementation,
        verdict: 'unmeasured',
        unmeasuredReason: receiverReason,
        guardReachability: record.guardReachability,
        ...(receiverDeclared.variants.length > 1
          ? {
              alternatives: receiverDeclared.variants.map((variant) => ({
                id: variant.id,
                verdict: 'unmeasured' as MeasuredVerdict,
                unmeasuredReason: receiverReason,
              })),
              alternativeSummary: {
                total: receiverDeclared.variants.length,
                enforced: 0,
                partial: 0,
                defective: 0,
                unmeasured: receiverDeclared.variants.length,
                ...(receiverDeclared.truncated ? { truncated: true } : {}),
              },
            }
          : {}),
      });
      continue;
    }
    /**
     * ONE MEASUREMENT PER (function object, contract) — measured once, never re-probed.
     *
     * `stoch` and `stochastic` are ONE function object with ONE contract and landed on different
     * verdicts. Not a numerical accident: a TA indicator built by `makeIndicator` holds a stream, so a
     * second batch of probes against it is not independent of the first, and whichever name got
     * measured second inherited the leftovers. The drift gate had to record that as a permutation,
     * which made it visible without making it sound — and a measurement whose answer depends on what
     * ran before it cannot ground 3B.1.
     *
     * This was tried once before and reverted, because the key is a function OBJECT and function
     * objects differ across module graphs: the artifact was generated under tsx (dist) while the gate
     * regenerated under vitest (source), so whichever record became canonical differed between them
     * and cross-graph disagreement grew from 4 to 15. That is no longer true. Moving generation into a
     * subprocess for the conformance gates left exactly ONE module graph, so the objection the revert
     * rested on has been removed by an unrelated fix — which is why it is safe now and was not then.
     *
     * The contract must match too, not just the object: a re-export that narrows a signature is a
     * different question about the same function, and `sameCallShape` is what decides.
     */
    /**
     * A MEASURED twin short-circuits; an UNMEASURED one must not.
     *
     * Storing every outcome here — so that a REASON is as canonical as a verdict — let one path's
     * early failure decide for all its twins, and cost 360 measurements: a record whose own fixture
     * would have worked inherited a `baseline-rejected` from whichever name happened to be processed
     * first. A twin proves two names are one function; it does not prove the harness had the same luck
     * building an input for both. Reason unification is applied at the failure branches instead, where
     * this record has already tried and failed on its own.
     */
    const twin = measuredByTarget.get(target);
    if (twin && twin.verdict !== 'unmeasured' && sameCallShape(record, contractById.get(twin.id))) {
      /**
       * The verdict and evidence come from the twin; IDENTITY and CONTRACT come from this record.
       *
       * Spreading the twin and then conditionally overwriting `inputPolicies` left the twin's policy in
       * place whenever this record declared none — reporting a path under a contract it does not have,
       * which is the exact defect the policy-parity gate exists to catch, reintroduced by the fix for
       * it. Built explicitly instead, so nothing can be inherited by omission.
       */
      const inherited: EnforcementRecord = {
        id: record.id,
        package: record.package,
        implementation: record.implementation,
        verdict: twin.verdict,
        inheritedFrom: twin.id,
        guardReachability: record.guardReachability,
      };
      if (twin.failures) inherited.failures = twin.failures;
      // Coverage travels with the evidence, at BOTH inheritance sites. Copying `failures` here and
      // not `mutationsAttempted` is what left the roll-up reporting more findings than attempts.
      // Same rule at the twin site: attributed coverage travels, execution does not.
      if (twin.mutationsCovered) inherited.mutationsCovered = twin.mutationsCovered;
      if (twin.advisory) inherited.advisory = twin.advisory;
      if (twin.undecided) inherited.undecided = twin.undecided;
      if (twin.synthesized) inherited.synthesized = twin.synthesized;
      if (record.inputPolicies) inherited.inputPolicies = record.inputPolicies;
      enforcement.push(inherited);
      continue;
    }
    /**
     * CAN ANY DECLARED ALTERNATIVE BE BUILT? — asked of the plan, not of a fabricated variant.
     *
     * This used to synthesize its own probe variant with `hand: false`, which is a claim about the
     * call and not a question about it. `fixtureFor` is variant-aware — a hand alternative returns the
     * fixture, a synthesized one builds from the declaration — so a `hand: false` probe asks synthesis
     * to build an input for a boundary that has a hand fixture PRECISELY BECAUSE synthesis cannot.
     * It cost 89 boundaries their measurement, every one of them fixtured, every one reported
     * `no-input` while holding a working input the harness had already built.
     */
    if (!variants.some((variant) => fixtureFor(0, variant))) {
      const reason: UnmeasuredReason =
        synthesisGap(record.signatures[0]?.parameters ?? [], measuredFields, producers)?.kind ===
        'function'
          ? 'callback-input-required'
          : 'no-input';
      enforcement.push({
        id: record.id,
        package: record.package,
        implementation: record.implementation,
        verdict: 'unmeasured',
        /**
         * The SAME cause gets the SAME name, whichever side of the call it stops on.
         *
         * A contract needing a function fails in one of two places: synthesis builds a partial input
         * and the call refuses it (`baseline-rejected` -> `callback-input-required`), or synthesis
         * declines to build anything at all and no call happens. Those were landing in different
         * buckets — 58 in `no-input`, 10 named — and the difference between them is which code path
         * gave up first, not anything about the contract. A reader comparing 162 "we could not build
         * an input" against 10 "the input needs a function" would draw the wrong conclusion about
         * where the work is.
         */
        /**
         * Classified from the ACTUAL gap, not from whether the contract happens to contain a callback.
         * `synthesisGap` names the first required field it could not build; only a `function` there
         * means the callback is why nothing could be built.
         */
        unmeasuredReason: reason,
        guardReachability: record.guardReachability,
        /**
         * EVERY DECLARED ALTERNATIVE, carrying the row's reason.
         *
         * The row said `callback-input-required` and published no alternatives at all, so a contract
         * declaring several — `defineIndicator` — reported one fact about the boundary and nothing
         * about its shapes. "Measured or explicitly unmeasured, never absent" has to hold when the
         * answer is unmeasured, or it is a claim about the easy half.
         */
        ...(variants.length > 1
          ? {
              alternatives: variants.map((variant) => ({
                id: variant.id,
                verdict: 'unmeasured' as MeasuredVerdict,
                unmeasuredReason: reason,
              })),
              alternativeSummary: {
                total: variants.length,
                enforced: 0,
                partial: 0,
                defective: 0,
                unmeasured: variants.length,
                ...(variantsTruncated ? { truncated: true } : {}),
              },
            }
          : {}),
      });
      continue;
    }
    /**
     * Measured ONCE per (function object, contract); other names inherit. The paragraphs below are the
     * history of getting here and are kept because the reasoning is the useful part — but note that
     * they describe the state BEFORE R11 closed, when measurement was per-record. `measuredByTarget`
     * above is the canonical measurement, and R11 is closed, so "R11 already owes" below is a record
     * of what was owed then, not an open debt.
     *
     * `stoch`/`stochastic` and `bb`/`bbands` are alias pairs: one function object, byte-identical
     * declared contracts, and they land on different verdicts. The cause is statefulness — a TA
     * indicator built by `makeIndicator` holds a stream, so two probe batches against one target are
     * not independent, and deeper probing gave each batch more chances to leave something behind.
     *
     * Sharing one measurement per (function object, contract) fixes that WITHIN a module graph: the
     * aliases agree, and the pass gets faster. It also made things worse overall, because the key is a
     * function object and function objects are not the same across module graphs — under vitest the
     * `@totalfinance/*` specifiers resolve to source, under tsx to dist. Whichever record became canonical
     * differed between them, and the cross-graph disagreement grew from 4 records to 15.
     *
     * Trading a small known inconsistency for a larger one is not a fix. The real answer is to stop
     * the state leaking — a fresh module realm per boundary, which needs the process isolation R11
     * already owes for the hang budget. Recorded there rather than papered over here.
     */
    const verdict = measureWithAlternatives(
      record,
      target,
      fixtureFor,
      isConstructor,
      synthesized,
      variants,
      variantsTruncated,
    );
    /**
     * Stored whatever the outcome, because a REASON is as much a property of (function, contract) as a
     * verdict is. `collectAsync` reported `no-mutable-argument` through its scoped name and
     * `callback-input-required` through its umbrella aliases — one function, one contract, two
     * accounts of why it could not be measured, and at most one of them true.
     *
     * `probe-timeout` is the exception, for the reason recorded at the inheritance pass: it means THIS
     * call did not return, and borrowing an alias's answer would erase the only fact established.
     */
    if (fixtureSource !== undefined) {
      verdict.fixtureSource = fixtureSource;
    }
    if (verdict.unmeasuredReason !== 'probe-timeout') measuredByTarget.set(target, verdict);
    enforcement.push(verdict);
  }

  /**
   * ALIAS FAN-OUT for measurement.
   *
   * 2,530 umbrella paths carry no fixture of their own, but 1,972 of them re-export the very object a
   * scoped path already measured — `totalfinance:blackScholes.price` IS
   * `@totalfinance/options:blackScholes.price`, proved by `packages/totalfinance/test`. Same implementation
   * means same behaviour under mutation, so the verdict is inherited rather than left unmeasured or
   * (worse) re-probed as if it were a different contract. The source is recorded so the inheritance is
   * auditable and never mistaken for an independent measurement.
   */
  /**
   * Inheritance is keyed on the RESOLVED FUNCTION OBJECT, not on any string.
   *
   * Two earlier keys were both wrong, in opposite directions:
   *
   *   by `implementation` string  — over-linked. `makeIndicator` declares `stream`/`explain` once, so
   *                                217 unrelated indicators shared one identity and inherited verdicts
   *                                never measured for them.
   *   by string + a `===` check   — under-linked. It only compared functions whose strings ALREADY
   *                                matched, so genuine aliases with distinct declarations were missed:
   *
   *                                    export const difference = lagFacade('diff', 'diff');
   *                                    export const change = difference;   // same object, other name
   *
   *                                `change` and `difference` ARE one function, but their declaration
   *                                identities are `#change` and `#difference`, so no link was made.
   *                                Whichever happened to be probeable got measured and the other stayed
   *                                `unmeasured` — and which one that was depended on module resolution,
   *                                producing the src↔dist verdict skew this ratchet was holding at 12.
   *
   * Keying on the object itself is exactly right and needs no heuristic: same function, same behaviour
   * under mutation, necessarily.
   */
  /**
   * EVERY record carries the policy its contract declares — measured, inherited or not measured.
   *
   * Each push site set it separately and the `unmeasured` helper set it nowhere, so four paths reported
   * a policy in `public-contracts.json` and none in `public-enforcement.json`. A contract is a contract
   * whether or not the harness managed to test it, and a reader consulting one artifact should never
   * learn a different one from the other. Normalized in ONE place so no future push site can forget.
   */
  /**
   * FAN THE CANONICAL EVIDENCE OUT to every other name for the same callable.
   *
   * Identity and contract come from the member; verdict, reason, alternatives and coverage come from
   * the one measurement. `mutationsExecuted` deliberately does NOT travel — the member ran nothing,
   * and a count that grows with alias fan-out stops describing work.
   *
   * A group-level gap travels too. The old rule refused to inherit `unmeasured` because inputs were
   * PATH-LOCAL: one name's bad synthesis luck would have decided for a twin whose own fixture might
   * have worked. Pooling removed that cause — every member now shares the group's fixture — so a
   * result reached through it is group evidence rather than one path's misfortune.
   */
  {
    const measuredById = new Map(enforcement.map((entry) => [entry.id, entry]));
    for (const [index, group] of groups.entries()) {
      const canonicalId = canonicalOfGroup.get(index)!;
      const source = measuredById.get(canonicalId);
      if (!source) continue;
      for (const member of group.members) {
        if (member.id === canonicalId) continue;
        const derived: EnforcementRecord = {
          id: member.id,
          package: member.package,
          implementation: member.implementation,
          verdict: source.verdict,
          measurementSource: canonicalId,
          inheritedFrom: canonicalId,
          guardReachability: member.guardReachability,
        };
        if (source.unmeasuredReason) derived.unmeasuredReason = source.unmeasuredReason;
        if (source.rejection) derived.rejection = source.rejection;
        if (source.failures) derived.failures = source.failures;
        if (source.advisory) derived.advisory = source.advisory;
        if (source.undecided) derived.undecided = source.undecided;
        if (source.mutationsCovered) derived.mutationsCovered = source.mutationsCovered;
        if (source.alternatives) derived.alternatives = source.alternatives;
        if (source.alternativeSummary) derived.alternativeSummary = source.alternativeSummary;
        if (source.synthesized) derived.synthesized = source.synthesized;
        if (source.fixtureSource) derived.fixtureSource = source.fixtureSource;
        enforcement.push(derived);
      }
    }
  }

  for (const entry of enforcement) {
    const declared = contractById.get(entry.id)?.inputPolicies;
    if (declared) entry.inputPolicies = declared;
    else delete entry.inputPolicies;
  }

  enforcement.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const resolvedByRecord = new Map<string, unknown>();
  await Promise.all(
    enforcement.map(async (entry) => {
      const resolved = await resolveCallable(
        entry.id.endsWith('.constructor') ? entry.id.slice(0, -'.constructor'.length) : entry.id,
        entrypointsById.get(entry.id) ?? ['.'],
      );
      if (resolved) resolvedByRecord.set(entry.id, resolved);
    }),
  );

  // The canonical source per function object: the lexicographically-first MEASURED record, so the
  // choice does not depend on generation or resolution order.
  const measuredByFunction = new Map<unknown, EnforcementRecord>();
  for (const entry of enforcement) {
    if (entry.verdict === 'unmeasured') continue;
    const resolved = resolvedByRecord.get(entry.id);
    if (resolved === undefined) continue;
    if (!measuredByFunction.has(resolved)) measuredByFunction.set(resolved, entry);
  }
  for (const entry of enforcement) {
    if (entry.verdict !== 'unmeasured') continue;
    /**
     * A boundary skipped for NON-TERMINATION does not inherit.
     *
     * Every other `unmeasured` reason means "we could not construct a measurement", and an alias that
     * shares the function object legitimately supplies one. `probe-timeout` means something else: this
     * call did not return. If its alias returned, the two did not behave identically, so borrowing the
     * alias's verdict would erase the one fact actually established — and the skip would be invisible
     * in the artifact, which is how it was found: skipping two boundaries changed nothing at all.
     */
    if (entry.unmeasuredReason === 'probe-timeout') continue;
    const resolved = resolvedByRecord.get(entry.id);
    if (resolved === undefined) continue;
    const source = measuredByFunction.get(resolved);
    if (!source || source.id === entry.id) continue;
    /**
     * Same function object is not, by itself, licence to inherit: the two paths must also DECLARE the
     * same call shape. A re-export that narrows or wraps a signature is a different contract even
     * where the runtime object is shared, and copying a verdict across it would measure one thing and
     * report another.
     */
    if (!sameCallShape(contractById.get(entry.id), contractById.get(source.id))) continue;
    entry.verdict = source.verdict;
    entry.inheritedFrom = source.id;
    // The reason described why THIS path could not be measured directly; it no longer holds once the
    // verdict is real, and leaving it would report a measured path as an outstanding gap.
    delete entry.unmeasuredReason;
    // The rejection explained why THIS path could not be measured; once the verdict is real it is a
    // stale note about a road not taken. Leaving it made the rejection tally count 727 causes for 405
    // rejections — a number that could only mislead whoever read it.
    delete entry.rejection;
    if (source.failures) entry.failures = source.failures;
    /**
     * The ATTEMPT counts travel with the evidence they describe. An inheriting record claims the
     * source's measurement, so it must claim the source's coverage too — otherwise `failures` is
     * copied while `mutationsAttempted` is not, and the library-wide roll-up reports 409
     * `invalid-literal` FAILURES against 386 ATTEMPTS. A coverage number smaller than the findings it
     * is supposed to bound is worse than no coverage number.
     */
    // Coverage is attributed; EXECUTION is not. An alias ran no probes and must not claim to have.
    if (source.mutationsCovered) entry.mutationsCovered = source.mutationsCovered;
    if (source.advisory) entry.advisory = source.advisory;
    if (source.undecided) entry.undecided = source.undecided;
    /**
     * THE POLICY TRAVELS WITH THE VERDICT, and omitting it falsely certified 8 paths.
     *
     * A per-argument key policy is a property of the FUNCTION, not of the path that names it. Only
     * scoped packages carry a manifest, so `backtest:crossOver` declares both arguments `open` and its
     * umbrella aliases declare nothing — and an absent policy means `closed`. The alias then inherited
     * `enforced` while reading as a contract that forbids unknown keys, i.e. it was certified as
     * enforcing a rule it does not have and its own source does not claim.
     *
     * The verdict itself was right: `totalfinance:crossOver` IS `backtest:crossOver`, accepts a decorated
     * row, and is correct to. What was wrong was the contract printed next to it. Same function, same
     * policy, necessarily — the same argument that makes the verdict inheritable at all.
     *
     * 38 inherited records disagreed with their source; 8 of them read `enforced`.
     */
    if (source.inputPolicies) entry.inputPolicies = source.inputPolicies;
    else delete entry.inputPolicies;
  }

  enforcement.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const count = (verdict: MeasuredVerdict): number =>
    enforcement.filter((record) => record.verdict === verdict).length;

  /**
   * The unmeasured bucket, split by cause — the difference between "nothing to measure here" and
   * "not measured yet". Only the second is a work list.
   */
  /** What the contracts said when they refused a synthesized baseline. */
  const rejectionsByCode = enforcement
    .filter((record) => record.rejection !== undefined)
    .reduce<Record<string, number>>(
      (accumulator, record) => {
        const code = record.rejection!.code;
        accumulator[code] = (accumulator[code] ?? 0) + 1;
        return accumulator;
      },
      Object.create(null) as Record<string, number>,
    );

  const unmeasuredByReason = enforcement
    .filter((record) => record.verdict === 'unmeasured')
    .reduce<Record<string, number>>(
      (accumulator, record) => {
        const reason = record.unmeasuredReason ?? 'unrecorded';
        accumulator[reason] = (accumulator[reason] ?? 0) + 1;
        return accumulator;
      },
      Object.create(null) as Record<string, number>,
    );

  /**
   * The number this artifact exists to produce: paths the STATIC pass called enforced that
   * measurement convicts. Every one is a claim the old inventory would have made and been wrong about.
   */
  const staticFalsePositives = enforcement.filter(
    (record) =>
      record.verdict === 'defective' &&
      (record.guardReachability === 'direct' || record.guardReachability === 'delegated'),
  );

  const mcpTools = mcpToolContracts();

  return {
    version: 1,
    mcpTools,
    summary: {
      mcpToolContracts: mcpTools.length,
      mcpToolsWithCanonicalSchema: mcpTools.filter((tool) => tool.inputSchema !== null).length,
      mcpToolsWithRequiredList: mcpTools.filter((tool) => tool.requiredInputFields.length > 0)
        .length,
      mcpToolsMeasured: mcpTools.filter((tool) =>
        tool.probes.some((probe) => probe.verdict !== 'unmeasured'),
      ).length,
      mcpToolsDefective: mcpTools.filter((tool) =>
        tool.probes.some((probe) => probe.verdict === 'accepted' || probe.verdict === 'untyped'),
      ).length,
      candidates: enforcement.length,
      enforced: count('enforced'),
      defective: count('defective'),
      partial: count('partial'),
      unmeasured: count('unmeasured'),
      unmeasuredByReason,
      rejectionsByCode,
      /**
       * Library-wide mutation coverage — how many of each mutation the harness actually RAN. This is
       * the number that distinguishes "every enum is enforced" from "the enum probe never fired",
       * which the failure counts alone cannot.
       */
      /** Probes that physically RAN. The number to quote when asking "was this actually tested?". */
      mutationsExecuted: enforcement.reduce<Record<string, number>>((into, record) => {
        for (const [mutation, count] of Object.entries(record.mutationsExecuted ?? {})) {
          into[mutation] = (into[mutation] ?? 0) + count;
        }
        return into;
      }, {}),
      /** Paths covered, direct plus attributed. Larger than `mutationsExecuted` by the alias fan-out. */
      mutationsCovered: enforcement.reduce<Record<string, number>>((into, record) => {
        for (const [mutation, count] of Object.entries(record.mutationsCovered ?? {})) {
          into[mutation] = (into[mutation] ?? 0) + count;
        }
        return into;
      }, {}),
      /** Findings split the same way, so a failure count is never read against the wrong coverage. */
      failuresDirect: enforcement
        .filter((record) => record.inheritedFrom === undefined)
        .reduce((total, record) => total + (record.failures?.length ?? 0), 0),
      failuresAttributed: enforcement
        .filter((record) => record.inheritedFrom !== undefined)
        .reduce((total, record) => total + (record.failures?.length ?? 0), 0),
      inherited: enforcement.filter((record) => record.inheritedFrom !== undefined).length,
      fromSynthesizedInput: enforcement.filter((record) => record.synthesized === true).length,
      /**
       * ALTERNATIVE-LEVEL reasons, published separately from the row-level ones.
       *
       * The two are different populations and the header conflated them: it claimed a row-level
       * `branch-not-realized` that does not exist, because 27 ALTERNATIVES carry that reason and no
       * ROW does. A figure that cannot be checked against anything is a figure nobody can correct, so
       * the alternative-level map is published and gated in its own right.
       */
      alternativeUnmeasuredByReason: enforcement.reduce<Record<string, number>>((into, record) => {
        for (const alternative of record.alternatives ?? []) {
          const reason = alternative.unmeasuredReason;
          if (reason === undefined) continue;
          into[reason] = (into[reason] ?? 0) + 1;
        }
        return into;
      }, {}),
      /**
       * Receiver members whose function object could not be reached WITHOUT constructing one, so they
       * are measured individually rather than as part of a semantic callable group.
       *
       * Published because the alternative is an unstated limit. Grouping reads the owner's prototype,
       * which covers every exported class; an owner obtainable only from a factory (`Bond`,
       * `YieldCurve`) has no prototype on any module export, and guessing one is not available. The
       * number says how much of the receiver surface that is.
       */
      receiverGroupingGaps,
      /**
       * ALTERNATIVE coverage library-wide. Telemetry, never a candidate count: a boundary with no
       * union contributes exactly one alternative — itself — so the total stays comparable to
       * `candidates` without redefining it. The per-record field is omitted for those, which is why
       * this cannot be derived by summing what is published.
       */
      alternatives: enforcement.reduce(
        (into, record) => {
          const summary = record.alternativeSummary;
          if (!summary) {
            into.total += 1;
            into[record.verdict] += 1;
            return into;
          }
          into.total += summary.total;
          into.enforced += summary.enforced;
          into.partial += summary.partial;
          into.defective += summary.defective;
          into.unmeasured += summary.unmeasured;
          if (summary.truncated) into.truncated += 1;
          return into;
        },
        { total: 0, enforced: 0, partial: 0, defective: 0, unmeasured: 0, truncated: 0 },
      ),
      staticFalsePositives: staticFalsePositives.length,
      /**
       * TWO numbers, because "how much work is left" has two honest answers and one name for both
       * was how a plan got built on the wrong one.
       *
       * The field here used to be `defectiveImplementations`, and it counted distinct
       * `record.implementation` strings. But `implementation` is a DECLARATION-TEMPLATE identity
       * (`<file>.d.ts#<nameChain>`), not a runtime callable — ledger row R10 says so in as many
       * words, and 8 such ids cover 710 runtime function objects across the inventory. So a field
       * whose name promised "distinct things to fix" was delivering "distinct declarations", and
       * nothing in the artifact said which.
       *
       * Both fields are DESCRIPTIVE counts. Neither is an edit-site workload, and saying so was an
       * overclaim in the first version of this comment:
       *
       *   defectiveDeclarationTemplates  596  distinct declaration templates represented among the
       *                                       defective PATHS (all 1,630, inherited included)
       *   defectiveMeasurementTargets    642  canonical defective records — those measured directly
       *                                       rather than inherited from an alias
       *
       * A third number exists and is neither of these: 572 templates are represented among the 642
       * canonical targets. The three differ because a template can appear on inherited paths whose
       * canonical source is a different record, and because two generic declarations —
       * `Indicator.explain` and `Indicator.stream` — cover 33 indicators each.
       *
       * Whether editing one template fixes every path behind it is EXACTLY the question `implementationId`
       * cannot answer, because it is a declaration identity and not a runtime callable (ledger R14).
       * Until R14 lands, the true edit-site workload is unknown, and no field here should be read as
       * claiming otherwise.
       */
      defectiveDeclarationTemplates: new Set(
        enforcement
          .filter((record) => record.verdict === 'defective')
          .map((record) => record.implementation),
      ).size,
      defectiveMeasurementTargets: enforcement.filter(
        (record) => record.verdict === 'defective' && record.inheritedFrom === undefined,
      ).length,
      byPackage: enforcement
        .filter((record) => record.verdict === 'defective')
        .reduce<Record<string, number>>(
          (accumulator, record) => {
            accumulator[record.package] = (accumulator[record.package] ?? 0) + 1;
            return accumulator;
          },
          Object.create(null) as Record<string, number>,
        ),
    },
    enforcement,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = await buildEnforcementRecord();
  writeFileSync(OUTPUT, `${JSON.stringify(record, null, 2)}\n`);
  const { summary } = record;
  process.stdout.write(
    `enforcement: ${relative(ROOT, OUTPUT)}\n` +
      `  candidates              ${String(summary['candidates'])}\n` +
      `  MEASURED enforced       ${String(summary['enforced'])}\n` +
      `  MEASURED defective      ${String(summary['defective'])}\n` +
      `  unmeasured (no fixture) ${String(summary['unmeasured'])}\n` +
      `  static false positives  ${String(summary['staticFalsePositives'])}\n`,
  );
}
