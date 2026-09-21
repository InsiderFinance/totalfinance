/**
 * Law 7, the OVERFLOW mutant, second edition (2026-08-23 review wave) — finite INPUTS must never
 * produce a successful non-finite RESULT, and a refusal must be a TYPED TotalFinance teaching error.
 *
 * The first edition had three blind spots the follow-up review demonstrated with 846 reproduced
 * successful non-finites across 61 heads:
 *
 *   1. it scaled every numeric leaf SIMULTANEOUSLY, so ratio-shaped heads self-masked
 *      (numerator x 1e150 over denominator x 1e150 cancels);
 *   2. it skipped small non-negative integers BY VALUE, which skipped ordinary prices and amounts
 *      like `spot: 100` — counts are a KEY-NAME semantic, not a magnitude;
 *   3. ANY throw counted as a pass, including raw JavaScript errors — a `RangeError` from
 *      un-guarded arithmetic is not a teaching refusal.
 *
 * This edition mutates ONE numeric coordinate at a time, in three magnitudes per coordinate
 * (x1e150 overflow pressure, x1e-300 near-zero denominators, and sign-preserving set-to-1.7e308
 * near `Number.MAX_VALUE`), skips only coordinates whose KEY names are loop-bound semantics, and
 * accepts exactly two outcomes: a deeply finite success, or a typed TotalFinance error. Membership is
 * manifest-driven, so a new head joins the moment its fixture lands.
 *
 * THIRD edition (2026-08-23, third external review), two more blind spots closed:
 *
 *   4. `if (!fixture) continue` silently exempted every governed head without a fixture — 34 of
 *      170, mostly the single-object valuation primitives, several of which returned Infinity
 *      from finite inputs. The sweep now FAILS while any governed head is unfed; a head whose
 *      manifest name is an alias (`performance.sharpe` === `performance.sharpeRatio`) is fed by
 *      FUNCTION IDENTITY from its canonical fixture.
 *   5. one-coordinate mutation cannot see AGGREGATION overflow: two same-sign near-MAX components
 *      overflow a sum whose one-coordinate mutants all pass (the review's WACC case: two 1e308
 *      market values → weights 0 and a silently WRONG finite answer). Paired mutations now drive
 *      the first two occurrences of each repeated key name and small same-parent groups to
 *      near-MAX, same-sign (the sum must refuse — or compute stably where the true answer is
 *      representable) and opposite-sign (cancellation — see the honesty note on PAIR_VARIANTS for
 *      what this gate can and cannot prove about refusals).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { allFixtures } from './fixtures.js';
import { isResourceCoordinate } from './count-semantics.js';
import { VARIANT_FIXTURES } from './overflow-variants.js';
import { declaredVariantFixtures } from './declaration-variants.js';
import { packageEntrypoints } from '../manifest/inventory.js';
import { readManifest } from '../manifest/generate.js';

/** The Stage 4 domain packages this mutant governs (the review's scope: the NEW surfaces). */
const SWEPT_DIRS = new Set([
  'fundamentals',
  'valuation',
  'research',
  'foreign-exchange',
  'commodities',
  'performance',
  // FC7 (Stage 4.4): the ledger is a Stage-4 surface; it joins the mutant with its first slice.
  'portfolio',
  // Stage 4.4b: scenario composition performs financial scaling, aggregation, and conversion.
  'scenarios',
]);

/**
 * Coordinates whose KEY names carry loop-bound/count semantics — scaling them by 1e150 tests the
 * machine's memory, not the library's arithmetic; they get their OWN unsafe-integer gate
 * (`count-safety-sweep.test.ts`). The classifier is shared so no coordinate falls between the two
 * gates — the second edition's bare-token regex over-matched `accountsReceivable`,
 * `annualDiscountRate`, `indexValue`, and `periodsPerYear`, silently exempting real money and
 * rate coordinates from magnitude testing (third review harvest, 2026-08-23).
 */
const isLoopBound = (head: string, coordinate: Coordinate): boolean =>
  isResourceCoordinate({ head, path: coordinate.path, key: coordinate.key });

/**
 * SHRINK-ONLY: heads whose overflow behavior is still being repaired, each with a written reason.
 * Empty is the goal state.
 */
const OVERFLOW_LEDGER = new Set<string>([
  // Re-diagnosed 2026-08-23 (fourth review closeout): the original reason ("extreme series
  // overflow the rolling kernels") was WRONG — these three heads follow the aligned-series NaN
  // grammar shared with the technical-analysis indicators: the leading `window − 1` slots are
  // documented NaN warmup, and rollingSharpe emits a documented NaN sentinel where a window's
  // deviation is zero. Law 7's walker rightly refuses NaN in Stage-4 results, so the clash is a
  // DESIGN decision owed to the aligned-series grammar itself (null-filled warmup would break
  // Float64Array compatibility and the TA envelope symmetry), not an arithmetic repair. Ledgered
  // until that grammar decision is taken deliberately; the entries shrink the day it is.
  'performance.rollingReturn',
  'performance.rollingSharpe',
  'performance.rollingVolatility',
]);

/**
 * The administration repair arms (FC7 slice 3): `admin.reversal` and `admin.correction` (with each
 * of its nine economic `replacement` arms) name a fact that must ALREADY be applied, byte-identical
 * to the copy they carry. The branch builder grafts an arm onto the FIRST event, where nothing can
 * precede it, and the realization check reads that first element — so a seeded original cannot be
 * placed before the arm. The fold refuses the grafted arm as the typed
 * `portfolio.reversal_target_missing` teaching. The arms carry no magnitude coordinates of their
 * own: the carried original is hash-bound to the registry copy (any changed magnitude is the typed
 * hash refusal) and a replacement's magnitudes fold through the same economic reducers the
 * economic arms already sweep. Every family is exercised end-to-end, including its refusals, in
 * packages/portfolio/test/reconciliation.test.ts.
 */
function repairArmGaps(head: string): [string, string][] {
  const reason =
    'a repair names an already-applied fact; the builder grafts the arm at index 0 and reads index 0 back, so no applied target can precede it — typed target-missing refusal at the fold; no own magnitude coordinates; exercised end-to-end in packages/portfolio/test/reconciliation.test.ts';
  // The replacement union is the whole economic family set: 9 at slice 3, 22 with slice 5.
  const replacements = Array.from({ length: 22 }, (_, index) => index);
  return [
    [`${head}#arg0.events.event:eventType=admin.reversal`, reason],
    [`${head}#arg0.events.event:eventType=admin.correction`, reason],
    ...replacements.map((index): [string, string] => [
      `${head}#arg0.events.event:eventType=admin.correction.replacement#${index}`,
      reason,
    ]),
  ];
}

/**
 * `monitorPortfolio` takes an optional `reconciliation` companion — a PRODUCED
 * `ReconcilePortfolioResult` (FC7 slice 4, 2026-08-29). The declaration builder cannot synthesize a
 * produced report (its verdict, counts, instant, and base currency must agree with the portfolio it
 * was reconciled against), so the presence gate and the twelve draft-event arms beneath it never
 * reach the fold — the same cause the declared-coverage residual records for this gate. The
 * companion carries no magnitude coordinates of its own beyond the difference counts (curated as
 * closed-form values in count-semantics.ts), and the family is measured end-to-end with a REAL
 * reconcilePortfolio result in packages/portfolio/test/monitor.test.ts.
 */
function reconciliationCompanionGaps(): [string, string][] {
  const reason =
    'the reconciliation companion is a produced report the builder cannot synthesize consistently (verdict, counts, instant, base currency); no own magnitude coordinates; the family is exercised with a real reconcilePortfolio result in packages/portfolio/test/monitor.test.ts';
  const head = 'portfolio.monitorPortfolio#arg0.reconciliation:present';
  return [
    [head, reason],
    // Twelve draft-event arms at slice 4, twenty-five with the slice-5 families.
    ...Array.from({ length: 25 }, (_, index): [string, string] => [
      `${head}.suggestedCorrections.event#${index}`,
      reason,
    ]),
  ];
}

/**
 * The lifecycle families (FC7 slice 5, 2026-08-29). Every one of them TRANSFORMS HELD LOTS —
 * an exercise relieves option lots, a merger converts them, a transfer moves them — so an arm
 * grafted onto the FIRST event (where nothing is held) is the fold's own position teaching, never
 * a baseline; the same cause the corporate.split rows above record. Their magnitude coordinates
 * (prices, quantities, amounts, fractions) fold through the one reducer kernel the fill family
 * already sweeps. The fill's `contract` union and a roll's successor `contract` sit below the
 * inventory's field-tree depth (recorded `truncated`, so no branch carries a discriminator), and
 * the builder cannot write or recognize the arm it names. Every family and every contract kind
 * is exercised end-to-end, refusals included, in packages/portfolio/test/lifecycle-foundation.test.ts,
 * lifecycle-derivatives.test.ts, and lifecycle-corporate.test.ts.
 */
function lifecycleArmGaps(head: string): [string, string][] {
  const held =
    'a lifecycle event transforms HELD lots; the builder grafts the arm onto the first event where nothing is held — the fold’s typed position teaching; magnitudes fold through the reducer kernel the fill family sweeps; exercised end-to-end in packages/portfolio/test/lifecycle-*.test.ts';
  const truncated =
    'the contract union sits below the inventory’s field-tree depth (branches recorded truncated, no discriminator), so the builder cannot write or recognize the arm; every contract kind is exercised in packages/portfolio/test/lifecycle-foundation.test.ts and lifecycle-derivatives.test.ts';
  const arm = (suffix: string, reason: string): [string, string] => [
    `${head}#arg0.events.event:eventType=${suffix}`,
    reason,
  ];
  const settlements = (family: string): [string, string][] =>
    ['fold-into-underlying-basis', 'realize'].flatMap((treatment) => [
      arm(`${family},premiumTreatment=${treatment}`, held),
      arm(`${family},premiumTreatment=${treatment}.settlement#0`, held),
      arm(`${family},premiumTreatment=${treatment}.settlement#1`, held),
    ]);
  return [
    arm('corporate.cash-in-lieu', held),
    arm('corporate.merger', held),
    arm('corporate.return-of-capital', held),
    arm('corporate.spin-off', held),
    arm('corporate.symbol-change', held),
    ...settlements('derivative.assignment'),
    ...settlements('derivative.exercise'),
    arm('derivative.expiration', held),
    arm('derivative.multiplier-change', held),
    arm('derivative.roll', held),
    arm('derivative.roll.contract:absent', held),
    arm('derivative.roll.contract:present', truncated),
    arm('derivative.roll.contract:present#0', truncated),
    arm('derivative.roll.contract:present#1', truncated),
    arm('derivative.roll.contract:present#2', truncated),
    arm('derivative.variation-margin', held),
    ...['call', 'maturity', 'principal-paydown', 'sinking-fund'].map((type) =>
      arm(`fixed-income.redemption,redemptionType=${type}`, held),
    ),
    arm('position.transfer', held),
    ...['buy', 'sell'].flatMap((side) => [
      arm(`trade.fill,side=${side}.contract:present`, truncated),
      arm(`trade.fill,side=${side}.contract:present#0`, truncated),
      arm(`trade.fill,side=${side}.contract:present#1`, truncated),
      arm(`trade.fill,side=${side}.contract:present#2`, truncated),
    ]),
  ];
}

/**
 * The trade lifecycle's content-addressed inputs (Stage 7B.2 slice 2, 2026-09-06). A grant is minted
 * from a PreflightReport and an ExecutionPlan, both bound by a content hash the door re-verifies, so
 * every arm the builder grafts beneath them (the plan's proposal source, a check's value or limit
 * union, the decision's verdict, the twenty-four hypothetical-event arms, the hypothetical fills'
 * contract union) changes the body without its hash — the typed hash refusal by design. Those arms
 * carry no magnitude coordinate of their own that the canonical report does not already sweep (the
 * report's numbers are the preflight's, swept through portfolio.preflightTradePlan). The
 * proposal-sourced plan is fed WHOLE, hashed correctly, through the registry variants
 * portfolio.createAuthorizationGrant#proposal and portfolio.verifyAuthorizationGrant#proposal, and
 * reconcileExecution's derivative-fill arms and external-snapshot instant are fed through
 * portfolio.reconcileExecution#external and the same lifecycle tests the ledger's own fills use.
 */
function contentAddressedInputGaps(): [string, string][] {
  const hashed =
    'the input is content-addressed and re-verified at the door; the builder’s graft changes the body without its hash — a typed refusal by design; no own magnitude coordinates beyond the canonical report’s (swept through preflightTradePlan); the proposal-sourced plan is fed whole through the #proposal registry variants and packages/portfolio/test/trade-lifecycle.test.ts';
  const grant = 'portfolio.createAuthorizationGrant#arg0';
  const fills =
    'a derivative fill needs contract terms the ledger fixture does not hold, so the graft is the fill validator’s typed refusal; reconcileExecution reads a fill’s id, order, and quantity only (no strike or multiplier arithmetic), and every contract kind is exercised through the ledger in packages/portfolio/test/lifecycle-derivatives.test.ts';
  const external =
    'the builder’s synthesized external instant is not a parseable as-of (reconcilePortfolio’s typed refusal); the external arm is fed whole through the registry variant portfolio.reconcileExecution#external and packages/portfolio/test/trade-lifecycle.test.ts';
  return [
    [`${grant}.plan.source:kind=rebalance-proposal`, hashed],
    [`${grant}.preflight.checks.limit#0`, hashed],
    [`${grant}.preflight.checks.limit#1`, hashed],
    [`${grant}.preflight.checks.value#1`, hashed],
    [`${grant}.preflight.decision:verdict=deny`, hashed],
    [`${grant}.preflight.decision:verdict=require-approval`, hashed],
    ...Array.from({ length: 24 }, (_, index): [string, string] => [
      `${grant}.preflight.hypotheticalEvents.event#${index + 1}`,
      hashed,
    ]),
    [`${grant}.preflight.hypotheticalFills.contract:present`, hashed],
    [`${grant}.preflight.hypotheticalFills.contract:present#0`, hashed],
    [`${grant}.preflight.hypotheticalFills.contract:present#1`, hashed],
    [`${grant}.preflight.hypotheticalFills.contract:present#2`, hashed],
    ['portfolio.verifyAuthorizationGrant#arg0.plan.source:kind=rebalance-proposal', hashed],
    [
      'portfolio.reconcileExecution#arg0.journal#1',
      'a folded journal state is a produced artifact whose eventCount must equal its eventIds (the builder writes one against sixty — the door’s typed refusal); the state arm is fed whole through the registry variant portfolio.reconcileExecution#folded-journal and packages/portfolio/test/trade-lifecycle.test.ts',
    ],
    ['portfolio.reconcileExecution#arg0.external:present.asOf#0', external],
    ['portfolio.reconcileExecution#arg0.fills.contract:present', fills],
    ['portfolio.reconcileExecution#arg0.fills.contract:present:kind=future', fills],
    ['portfolio.reconcileExecution#arg0.fills.contract:present:kind=option,type=call', fills],
    ['portfolio.reconcileExecution#arg0.fills.contract:present:kind=option,type=put', fills],
    ['portfolio.reconcileExecution#arg0.fills.contract:present:kind=perpetual', fills],
  ];
}

/**
 * SHRINK-ONLY: declared union arms the branch builder cannot baseline from the canonical fixture,
 * each with the reason and the evidence that the arm loses NO magnitude coverage by sitting here.
 * Empty is the goal state; an entry that stops being needed fails the suite.
 */
const DECLARED_BRANCH_GAP_LEDGER = new Map<string, string>([
  [
    'scenarios.runScenarios#arg0.targets:valuationMethod=taylor',
    'ScenarioTarget is a frozen builder-owned opaque carrying private symbol identity; the declaration synthesizer cannot forge the Taylor brand/behavior pair. Taylor magnitudes are swept directly through scenarios.scenarioTarget.taylor and exercised end-to-end through runScenarios in packages/scenarios/test/run.test.ts and heterogeneous-parity.test.ts.',
  ],
  [
    'scenarios.scenarioTargetsFromPortfolio#arg0.bindings:valuationMethod=taylor',
    'ScenarioPortfolioBinding is a frozen builder-owned opaque carrying private symbol identity; a structural branch graft cannot manufacture its Taylor brand. Taylor binding magnitudes are swept directly through scenarios.scenarioPortfolioBinding.taylor and exercised through the durable adapter in packages/scenarios/test/portfolio.test.ts.',
  ],
  [
    'scenarios.scenarioTarget.fullRevaluation',
    'the checker exposes generic instrument/pricer intersections as declaration alternatives, but branch synthesis cannot select a generic arm independently of the builder-owned NoInfer instrument/pricer pair. The canonical full-revaluation fixture is successful and all of its numeric coordinates remain swept; structural pair compatibility has negative compile evidence in scenarios-signature-compatibility.compile.ts.',
  ],
  [
    'scenarios.scenarioPortfolioBinding.fullRevaluation',
    'the checker exposes generic instrument/pricer intersections as declaration alternatives, but branch synthesis cannot select a generic arm independently of the opaque builder-owned NoInfer pair. The canonical binding fixture is successful and its magnitudes remain swept; pair compatibility has negative compile evidence and end-to-end portfolio adapter tests.',
  ],
  [
    'portfolio.applyPortfolioEvents#arg0.events.event:eventType=corporate.split',
    'the split arm is grafted onto the FIRST event, and a split for an instrument the account does not yet hold is a typed refusal by design (a corporate action on a non-held instrument is a data error, never a silent no-op); the arm carries no magnitude coordinates (share counts are resource-classified) and is exercised end-to-end by the golden journey in packages/portfolio/test/apply.test.ts',
  ],
  [
    'portfolio.createPortfolioLedger#arg0.events.event:eventType=corporate.split',
    'same arm through the ledger artifact — same refusal, same absence of magnitude coordinates, same golden-journey coverage',
  ],
  [
    'portfolio.preflightTradePlan#arg0.plan.source:kind=rebalance-proposal',
    'an ExecutionPlan is content-addressed and bound by its hash at the door, so grafting the proposal arm onto the canonical plan changes the body without its hash and is a typed refusal by design; the arm carries no magnitude coordinates (two hashes) and the proposal-sourced plan is fed whole through the registry variant portfolio.preflightTradePlan#proposal and exercised in packages/portfolio/test/trade.test.ts',
  ],
  ...repairArmGaps('portfolio.applyPortfolioEvents'),
  ...repairArmGaps('portfolio.createPortfolioLedger'),
  ...reconciliationCompanionGaps(),
  ...lifecycleArmGaps('portfolio.applyPortfolioEvents'),
  ...lifecycleArmGaps('portfolio.createPortfolioLedger'),
  ...contentAddressedInputGaps(),
]);
const declaredBranchGapsUsed = new Set<string>();

interface Coordinate {
  path: (string | number)[];
  key: string;
}

/** Every numeric-leaf coordinate of an argument list, with the object key that names it. */
function numericCoordinates(root: unknown): Coordinate[] {
  const out: Coordinate[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, path: (string | number)[], key: string): void => {
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
      out.push({ path: [...path], key });
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map || value instanceof Set) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        walk(value[index], [...path, index], key);
      }
      return;
    }
    for (const [memberKey, member] of Object.entries(value)) {
      walk(member, [...path, memberKey], memberKey);
    }
  };
  walk(root, [], '');
  return out;
}

/** A deep structural clone with ONE coordinate transformed. */
function withCoordinate(
  root: unknown,
  coordinate: Coordinate,
  transform: (value: number) => number,
): unknown {
  const clone = (value: unknown, depth: number): unknown => {
    if (depth === coordinate.path.length) return transform(value as number);
    const step = coordinate.path[depth]!;
    if (Array.isArray(value)) {
      const copy = value.slice();
      copy[step as number] = clone(value[step as number], depth + 1);
      return copy;
    }
    const record = value as Record<string, unknown>;
    return { ...record, [step]: clone(record[step as string], depth + 1) };
  };
  return clone(root, 0);
}

/** First non-finite path in a successful result, or null. Cycle-safe, full depth. */
function firstNonFinitePath(root: unknown): string | null {
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): string | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? null : path || 'value';
    if (v === null || typeof v !== 'object') return null;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = walk(v[i], `${path}[${i}]`);
        if (hit) return hit;
      }
      return null;
    }
    for (const [k, val] of Object.entries(v)) {
      const hit = walk(val, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, '');
}

const VARIANTS: readonly { label: string; transform: (value: number) => number }[] = [
  { label: 'x1e150', transform: (value) => value * 1e150 },
  { label: 'x1e-300', transform: (value) => value * 1e-300 },
  { label: 'x1e-322', transform: (value) => value * 1e-322 },
  { label: 'to-1.7e308', transform: (value) => (value < 0 ? -1.7e308 : 1.7e308) },
];

const NEAR_MAX = (value: number): number => (value < 0 ? -1.7e308 : 1.7e308);
const NEAR_MAX_FLIPPED = (value: number): number => (value < 0 ? 1.7e308 : -1.7e308);

/**
 * Paired mutations (third edition). Same-sign drives an aggregate past `Number.MAX_VALUE`;
 * opposite-sign builds a cancellation whose TRUE answer is usually representable.
 *
 * HONESTY NOTE (fourth review): this mutant accepts any TYPED refusal, so on its own it cannot
 * convict a refusal-happy wrap that rejects a computable answer — a generic walker cannot know
 * the true value. The dishonest-refusal law is held elsewhere: the additive heads aggregate
 * through core `stableSum` (a non-finite from it means the true total is past MAX_VALUE), and
 * exact-cancellation canary tests in each package pin `1e308 + 1e308 − 1e308 − 1e308 === 0`-shaped
 * answers as SUCCESSES. The earlier claim here that opposite-sign pairs "convict refusal-happy
 * wraps" overstated what a refusal-tolerant gate can prove.
 */
const PAIR_VARIANTS: readonly {
  label: string;
  first: (value: number) => number;
  second: (value: number) => number;
}[] = [
  { label: 'pair-same-sign-1.7e308', first: NEAR_MAX, second: NEAR_MAX },
  { label: 'pair-opposite-sign-1.7e308', first: NEAR_MAX, second: NEAR_MAX_FLIPPED },
];

/**
 * Which coordinates to pair: the first two occurrences of every repeated KEY name (the
 * aggregation axis — `components[0].marketValue` with `components[1].marketValue`,
 * `observations[*].value` with its neighbor), plus the first few numeric members of each shared
 * parent (additive record shapes like a bridge or a statement). Parent groups are capped at three
 * coordinates — long numeric ARRAYS would otherwise explode quadratically, and the repeated-key
 * rule already covers their first two elements.
 */
function pairCoordinates(coordinates: Coordinate[]): [Coordinate, Coordinate][] {
  const pairs: [Coordinate, Coordinate][] = [];
  const seen = new Set<string>();
  const push = (a: Coordinate, b: Coordinate): void => {
    const id = `${a.path.join('.')}|${b.path.join('.')}`;
    if (!seen.has(id)) {
      seen.add(id);
      pairs.push([a, b]);
    }
  };
  const byKey = new Map<string, Coordinate[]>();
  for (const coordinate of coordinates) {
    const list = byKey.get(coordinate.key) ?? [];
    if (list.length < 2) {
      list.push(coordinate);
      byKey.set(coordinate.key, list);
    }
  }
  for (const list of byKey.values()) if (list.length === 2) push(list[0]!, list[1]!);
  const byParent = new Map<string, Coordinate[]>();
  for (const coordinate of coordinates) {
    const parent = coordinate.path.slice(0, -1).join('.');
    const list = byParent.get(parent) ?? [];
    if (list.length < 3) {
      list.push(coordinate);
      byParent.set(parent, list);
    }
  }
  for (const list of byParent.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) push(list[i]!, list[j]!);
    }
  }
  return pairs;
}

const fixtures = allFixtures();

interface Target {
  key: string;
  fn: (...callArguments: unknown[]) => unknown;
  fixture: () => unknown[];
}
const targets: Target[] = [];
/**
 * Governed heads the sweep cannot feed — no fixture under their own key NOR under any key whose
 * export is the SAME function object (aliases). The second edition's `if (!fixture) continue`
 * silently exempted 34 such heads, several of which returned Infinity from finite inputs; the
 * third edition refuses to pass while this list is non-empty.
 */
const unfed: string[] = [];
{
  const governed: { key: string; fn: (...callArguments: unknown[]) => unknown }[] = [];
  for (const pkg of packageEntrypoints()) {
    if (!SWEPT_DIRS.has(pkg.dir)) continue;
    const manifest = readManifest(pkg.dir);
    if (!manifest || manifest.tier !== 'facade') continue;
    const mod = (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(manifest.exports)) {
      if (entry.kind !== 'function') continue;
      // Law 7 governs public quant ANSWERS: facades, analyses, artifact factories, and the
      // ratified-plain bare-number primitives. Guards/adapters and documented-IEEE kernels are
      // outside this mutant's population.
      const ratifiedPlain =
        entry.role === 'helper' && (entry.note ?? '').includes('ratified plain');
      if (
        entry.role !== 'facade' &&
        entry.role !== 'analysis' &&
        entry.role !== 'artifact' &&
        !ratifiedPlain
      ) {
        continue;
      }
      const fn = name
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], mod);
      if (typeof fn !== 'function') continue;
      governed.push({ key: `${pkg.dir}.${name}`, fn: fn as never });
    }
  }
  const fixtureByIdentity = new Map<unknown, () => unknown[]>();
  for (const { key, fn } of governed) {
    const fixture = fixtures.get(key);
    if (fixture && !fixtureByIdentity.has(fn)) fixtureByIdentity.set(fn, fixture as never);
  }
  for (const { key, fn } of governed) {
    const fixture =
      (fixtures.get(key) as (() => unknown[]) | undefined) ?? fixtureByIdentity.get(fn);
    if (!fixture) {
      unfed.push(key);
      continue;
    }
    targets.push({ key, fn, fixture });
  }
  // The compiler declaration, not the curated list below, owns union-arm completeness. Graft each
  // selected arm onto the known-valid canonical request; an unbuildable arm is an `unfed` failure.
  for (const target of [...targets]) {
    const declared = declaredVariantFixtures({
      headKey: target.key,
      canonical: target.fixture,
      fn: target.fn,
    });
    for (const gap of declared.gaps) {
      const id = gap.split(': ')[0]!;
      if (DECLARED_BRANCH_GAP_LEDGER.has(id)) {
        declaredBranchGapsUsed.add(id);
        continue;
      }
      unfed.push(gap);
    }
    for (const variant of declared.fixtures) {
      targets.push({
        key: `${target.key}#declared:${variant.id}`,
        fn: target.fn,
        fixture: variant.fixture,
      });
    }
  }
  // Branch variants (fourth review): one fixture proves one branch, so every alternate arm of a
  // semantic enum gets a curated baseline too. Union completeness is declaration-derived above;
  // this list remains for cross-field APIs whose declaration is one object with an enum selector.
  const byKey = new Map(targets.map((target) => [target.key, target]));
  for (const [variantKey, fixture] of Object.entries(VARIANT_FIXTURES)) {
    const headKey = variantKey.split('#')[0]!;
    // This registry is shared with the library-wide count gate. A branch added for a package outside
    // this Stage-4-only magnitude sweep is valid there and intentionally irrelevant here.
    if (!SWEPT_DIRS.has(headKey.split('.')[0]!)) continue;
    const head = byKey.get(headKey);
    if (!head) {
      unfed.push(`${variantKey} (variant of ungoverned or unfed head)`);
      continue;
    }
    targets.push({ key: variantKey, fn: head.fn, fixture: fixture as () => unknown[] });
  }
}

describe('Law 7 overflow mutant (one coordinate at a time, typed refusals only)', () => {
  it('feeds EVERY governed head — a head the mutant cannot feed is a head it does not govern', () => {
    expect(
      [...unfed].sort(),
      'governed heads with no fixture and no same-function alias fixture — add fixtures',
    ).toEqual([]);
    expect(
      [...DECLARED_BRANCH_GAP_LEDGER.keys()].filter((id) => !declaredBranchGapsUsed.has(id)),
      'DECLARED_BRANCH_GAP_LEDGER entries the builder no longer reports — delete them (shrink-only)',
    ).toEqual([]);
    expect(targets.length).toBeGreaterThan(160);
  });

  it('starts every magnitude mutation from a successful baseline call', () => {
    const invalidBaselines: string[] = [];
    for (const { key, fn, fixture } of targets) {
      const coordinates = numericCoordinates(fixture()).filter(
        (coordinate) => !isLoopBound(key, coordinate),
      );
      if (coordinates.length === 0) continue;
      try {
        const result = fn(...fixture());
        const nonFinitePath = firstNonFinitePath(result);
        if (nonFinitePath !== null && !OVERFLOW_LEDGER.has(key)) {
          invalidBaselines.push(`${key}: non-finite at ${nonFinitePath}`);
        }
      } catch (error) {
        invalidBaselines.push(
          `${key}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
      }
    }
    expect(
      invalidBaselines.sort(),
      'a mutation of an already-invalid baseline is not overflow evidence',
    ).toEqual([]);
  });

  it('every single-coordinate magnitude mutation either teaches (typed) or stays deeply finite', () => {
    const violations = new Set<string>();
    const staleLedger = new Set(OVERFLOW_LEDGER);
    for (const { key, fn, fixture } of targets) {
      const baseline = fixture();
      const coordinates = numericCoordinates(baseline).filter(
        (coordinate) => !isLoopBound(key, coordinate),
      );
      let convicted = false;
      for (const coordinate of coordinates) {
        for (const variant of VARIANTS) {
          let result: unknown;
          try {
            result = fn(...(withCoordinate(fixture(), coordinate, variant.transform) as unknown[]));
          } catch (error) {
            if (!isQuantError(error)) {
              convicted = true;
              violations.add(
                `${key}: RAW ${((error as Error)?.constructor?.name ?? 'error').slice(0, 30)} (not a typed teaching refusal) at ${coordinate.path.join('.')} ${variant.label}`,
              );
            }
            continue;
          }
          const hit = firstNonFinitePath(result);
          if (hit !== null) {
            convicted = true;
            violations.add(
              `${key}: successful non-finite at ${hit} (coordinate ${coordinate.path.join('.')} ${variant.label})`,
            );
          }
        }
      }
      for (const [a, b] of pairCoordinates(coordinates)) {
        for (const variant of PAIR_VARIANTS) {
          let result: unknown;
          try {
            result = fn(
              ...(withCoordinate(
                withCoordinate(fixture(), a, variant.first),
                b,
                variant.second,
              ) as unknown[]),
            );
          } catch (error) {
            if (!isQuantError(error)) {
              convicted = true;
              violations.add(
                `${key}: RAW ${((error as Error)?.constructor?.name ?? 'error').slice(0, 30)} (not a typed teaching refusal) at ${a.path.join('.')}+${b.path.join('.')} ${variant.label}`,
              );
            }
            continue;
          }
          const hit = firstNonFinitePath(result);
          if (hit !== null) {
            convicted = true;
            violations.add(
              `${key}: successful non-finite at ${hit} (pair ${a.path.join('.')}+${b.path.join('.')} ${variant.label})`,
            );
          }
        }
      }
      if (convicted && OVERFLOW_LEDGER.has(key)) {
        staleLedger.delete(key);
        for (const v of [...violations]) if (v.startsWith(`${key}:`)) violations.delete(v);
      } else if (!convicted) {
        staleLedger.delete(key);
      }
    }
    const sorted = [...violations].sort();
    expect(sorted.slice(0, 80), sorted.slice(0, 80).join('\n')).toEqual([]);
    expect(
      [...staleLedger].sort(),
      'ledger entries that no longer overflow — delete them (shrink-only)',
    ).toEqual([]);
  }, 600_000);
});
