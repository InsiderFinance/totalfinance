# Reference-price level conversion

Status: PL1–PL4 implementation and requested local verification complete (2026-10-12) at `f5beceb3b325d4763313b1019bfb904eb3033b89`; PL5 review repairs locally verified at `ac6142d85634d84ffb47534cd08590c9cbce025d`. [PR #14](https://github.com/InsiderFinance/totalfinance/pull/14) is open; final-head hosted checks and maintainer review remain separate landing gates.
Queue: bounded consumer-requested addition in `../implementation-order.md`.
Issue: [#13](https://github.com/InsiderFinance/totalfinance/issues/13). This is a library addition requested for the ES/SPY and NQ/QQQ
application pages; application implementation and publication are separate work.

## Outcome and limits

One browser-safe, deterministic call maps a nonnegative source price level to an approximate
target price level from caller-supplied positive reference prices or a positive directed ratio.
Named helpers cover the eight PL6 pairs in both directions; arbitrary pairs use the generic call.
No fixed ticker ratios, quote acquisition, clock, timestamp
inference, credentials, or network requests belong here. Generic units are optional caller-supplied labels; the
library does not certify instrument identity, freshness, comparability, or economic equivalence.

This is proportional price mapping. It does not estimate a live quote, predicted ETF open,
overnight gap, arbitrage/fair value, option premium, contract exposure, position size, or
notional/delta hedge equivalence. It assumes the supplied mapping remains valid at the requested
level. Negative price levels are outside this bounded contract; zero maps to zero.

## Numbered decisions

1. **Owner:** extend valuation with `convertPriceLevel` at its root and `./price-levels`.
   Valuation already owns direct price/value transformations and relative valuation. This small
   addition explicitly extends that ownership to reference-price mapping without claiming fair
   value. Commodities owns physical commodity carry/basis; foreign exchange owns currency pairs;
   structure owns options positioning/flow; technical analysis owns series-derived indicators;
   research owns statistical studies. None matches an instrument-neutral proportional level
   transform. Core remains shared contracts/guards, math remains mathematical primitives. No
   new package or dependency edge is needed. No umbrella root hoist is added.
2. **Public role:** facade, returning `number`, with the same input accepted by `.explain()`.
   Public imports are `@insiderfinance/totalfinance/valuation` and
   `@insiderfinance/totalfinance/valuation/price-levels`; `valuation.convertPriceLevel` is also
   available through the umbrella namespace. Schemas stay behind `valuation/schemas` so compute
   imports do not load schema machinery.
3. **Flat discriminated input:** required `method: 'reference-prices' | 'ratio'`,
   `sourcePriceLevel`, and optional `sourcePriceUnit` / `targetPriceUnit` metadata. Reference mode additionally
   requires `referenceSourcePrice` and `referenceTargetPrice`. Ratio mode instead requires
   `targetPricePerSourcePrice` (target price units per one source price unit). No inferred method,
   optional financial default, reverse flag, alias or builder. PL6 explicitly named pair helpers
   fix the reference-price method and descriptive units without assuming reference prices.
4. **Arithmetic:** reference mode computes
   `sourcePriceLevel * referenceTargetPrice / referenceSourcePrice`; ratio mode computes
   `sourcePriceLevel * targetPricePerSourcePrice`. No rounding to cents/ticks occurs. Inversion
   uses another call with source/target units and references swapped, or with a caller-supplied
   reciprocal ratio. Tests declare numeric tolerances rather than promising exact round trips.
5. **Validation:** both callable boundaries validate the full input. Each method arm is closed;
   mixing ratio and reference fields is refused even when the forbidden field is `undefined`.
   Missing fields, wrong containers/primitives, unknown fields, invalid methods, nonfinite
   numbers, negative levels, nonpositive references/ratios, and blank units receive registered,
   typed teaching errors. Once the method is valid, corrective examples retain that method and
   its required fields. Input records are never mutated.
6. **Numerics:** reference arithmetic scales binary significands/exponents to avoid unnecessary
   intermediate overflow/underflow, including when the implicit ratio itself is not
   representable. Near the output range boundaries, it recomputes the exact quotient of the
   supplied doubles and rounds once to nearest, ties to even; prematurely rounded intermediates
   must not cause false overflow/underflow refusals. Ordinary prices retain the scaled-number
   path. A positive result rounded to zero is refused as underflow; subnormal nonzero results
   are supported. Overflow is refused using the existing
   `requireRepresentableResult` finalizer. Facade finite postconditions also inspect the whole
   explanation. No nonfinite derived ratio is inserted into assumptions.
7. **Explanation:** echo a copy of the complete selected input (method, references or directed
   ratio, level and units), the result unit, the ratio direction and the mapping-validity
   assumption. Without a generic target unit label, `resultUnit` is `null` (unspecified), not an
   invented currency/unit. Optional undefined labels are omitted from the echoed request.
   Include the registered `model.limitation` warning naming the limitations above.
8. **Scope:** additive public surface and minor changeset for the two public fixed-group
   artifacts, without version changes. No new transport, MCP tool, application page, release,
   merge, deployment, or live execution.

## Pre-implementation contract review

Reviewed against CONTRIBUTING, the alignment laws, FC0/FC1/FC2 ownership and dependency laws,
the single-package distribution contract, existing facade/schema/first-touch patterns, and the
consumer request before source implementation. This is an author contract review, not an
independent reviewer endorsement.

- Ambiguous ratio direction: resolved by `targetPricePerSourcePrice` and explicit inverse calls.
- Mutually exclusive methods: resolved by a required discriminator and method-specific key sets.
- Hidden instrument economics: resolved by supplied unit labels and no ticker presets.
- Intermediate numeric overflow and explanation leaks: resolved by scaled reference arithmetic
  and echoing references rather than requiring a representable derived ratio.
- Positive underflow silently becoming a valid zero level: resolved by a typed refusal.
- Domain ownership: valuation extension is explicit and isolated in a focused subpath; no
  commodity, currency, options, provider, or generic core semantics are inferred.
- Evidence: exact worked examples, independent binary-exponent oracles and metamorphic tests,
  generated boundary probes, schemas, installed TypeScript/JavaScript and browser execution.

No unresolved contract decision blocks implementation. External PR review remains required.

Integration review (2026-10-12): the first full CI attempt at `2189afe` passed 13,292 tests but
failed the exact bundle-table count and two declaration-parity checks. The generic `Facade`
annotation exposed the concrete union to the generator through a different declaration route
than the independent checker. The public call and `.explain()` now state their concrete input
and output signatures directly, while retaining core's facade wrapper and the same behavior.
No checker exemption or allowlist is added. The exact budget-table count increases 32 → 33 for
the newly budgeted feature. Full verification must restart on the integrated revision.

The integration regeneration hit npm registry connection resets during its temporary consumer
installation. A cache-preferred retry completed. A subsequent cached/as-of bundle invocation
(`npm_config_offline=true`, `npm_config_before=2026-10-12T16:20:00Z`) produced identical artifacts.
The source dependency graph and lockfile are unchanged. Final local verification prefers cached
retrieval for temporary consumers; every installation, measurement and test still executes.

## Ordered slices and acceptance

| Slice | Contents                                                                                        | State                          |
| ----- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| PL1   | Issue, queue row, controlling contract and pre-code review                                      | complete before implementation |
| PL2   | Facade, validation, schemas, unit/error documentation and domain tests                          | complete at `f5beceb`          |
| PL3   | Public classification, first-touch fixtures, runnable guide, installed consumers and changeset  | complete at `f5beceb`          |
| PL4   | Derived artifacts, full requested verification, truthful tracker closeout and PR                | complete at `f5beceb`          |
| PL5   | Review repairs: exact range-boundary rounding, method-matched teaching, independent regressions | locally verified at `ac6142d`  |

- [x] ES/SPY worked example returns 598.98 for 6030 using 6000/596 references; inverse returns 6030.
- [x] Independent NQ/QQQ worked example: 20,250 from 20,000/500 gives 506.25; inverse returns 20,250.
- [x] Reference identity, ratio equivalence, round trips, homogeneity and joint-reference-scale
      invariance pass at relative tolerance 1e-12 for well-conditioned normal cases.
- [x] Both methods/boundaries reject malformed, missing, wrong-type, unknown and mixed fields;
      nonfinite, negative, zero-reference and blank-unit cases have exact typed codes.
- [x] Extreme inputs preserve representable answers, support nonzero subnormals and zero identity,
      and refuse output overflow/underflow. Independent power-of-two cases pin numeric behavior.
- [x] Explanations are JSON-safe, echo all selected inputs/units, disclose the assumption and limits,
      and do not mutate caller input.
- [x] Runtime schema and generated declaration/contract/first-touch evidence cover both methods.
- [x] Packed ESM, strict NodeNext/Bundler, namespace/subpath identity and a browser bundle execute
      the guide and malformed-input correction without private aliases or Node globals.
- [x] Changed files are formatted; bundle budgets, targeted tests and generated gates pass.
- [x] Canonical-runtime clean `regen:check`, `pnpm run ci`, standalone `api:check` and an independent
      second `test:coverage` all pass with exact command receipts and one implementation revision.
- [x] Queue, this slice ledger and the completeness tracker name the same verified commit.
- [x] Reviewable PR against main is open; hosted current-head checks are reported accurately.

PL5 review follow-up acceptance (the original verification record below remains historical):

- [x] The two finite-result regressions return `Number.MIN_VALUE` and `Number.MAX_VALUE` on both
      calls; exact zero/infinity rounding thresholds still receive typed `input.out_of_range`.
- [x] Subnormal ties, the normal/subnormal midpoint and 40,460 boundary-neighbor triples are
      checked independently using exact fractions and adjacent-double rounding intervals.
- [x] Corrective examples retain the selected method on both calls; installed strict NodeNext,
      Bundler and browser consumers exercise the regressions and ratio-mode correction.
- [x] No public signature, dependency, financial default, schema, version or transport change;
      focused checks and the ordered artifact regeneration pass at the repair revision.

Landing gate: final-head fast PR checks and the full hosted Node 22.13/24/26 gate must pass.
The PR records the exact head and run URLs; older receipts do not verify these repairs.

## PL1–PL4 verification record (historical)

Focused checks: all valuation tests and bundle budgets pass (159 tests); the installed NodeNext,
Bundler and browser guide checks pass (3 tests); first-touch/deep/unknown-key/finite-result
checks pass (1,104 tests). Generated enforcement reports 0 defective and both method alternatives
fully enforced on the plain and explained calls; naming reports 0 unresolved. The generated
fixture join increased exactly 1,316 → 1,317 for the new fixture.

Canonical bundle measurements (Node 22.23.2 / pnpm 10.32.0 / esbuild 0.25.12): base ec6ae2d
umbrella 710,091 B gzip, implementation 711,093 B (+1,002 B); focused converter 8,189 B.
The whole-surface ceiling increases 693.5 → 694.625 KiB with 203 B headroom; the new focused
ceiling is 8.125 KiB with 131 B headroom. Existing narrow-import ceilings and structural gates
are retained. A full hosted workflow will verify these bounded enforcement-record changes.

Requested local verification at `f5beceb3b325d4763313b1019bfb904eb3033b89` in a separate clean checkout,
using Node 22.23.2 and pnpm 10.32.0 (all direct exits 0):

- `pnpm install --frozen-lockfile`.
- `pnpm regen:check`: the complete documented chain was byte-stable after integration.
- `pnpm run ci`: format, lint, library/site types, builds, 80 site tests, coverage over
  586 files / 13,295 tests, and all 25 API reports.
- Standalone `pnpm api:check`: all 25 API reports match.
- Independent second `pnpm test:coverage`: 586 files / 13,295 tests pass again.

Both coverage passes report 94.22% statements, 84.20% branches, 97.02% functions and 94.78%
lines. Neither `TOTALFINANCE_PR_CHECKS` nor `TOTALFINANCE_COVERAGE_SHARD` was set. Temporary
npm consumers preferred cached retrieval after the registry resets recorded above. Packed
Node ESM, strict NodeNext/Bundler, browser isolation, guide execution and misuse correction
all run in the complete suite. The verification checkout stayed clean.

Hosted fast PR receipt for the implementation revision:
[run 38279796207](https://github.com/InsiderFinance/totalfinance/actions/runs/38279796207),
all eight runnable jobs pass (five Node 22.13.0 test shards, static checks, clean regeneration,
and the local-registry rehearsal). This is a fast PR receipt, not a full hosted matrix.
[PR #14](https://github.com/InsiderFinance/totalfinance/pull/14) retains final-head check status
and the separately required full Node 22.13.0/24/26 workflow receipt before landing the bounded
bundle/fixture enforcement records. No merge, public-registry publication, version bump,
application change or deployment is authorized or performed.

## PL5 review repair record

The review of `9a4aca1` found two extreme-range false refusals: a result just above half
`Number.MIN_VALUE` rounded too early to zero, and a result that should round to `Number.MAX_VALUE`
rounded too early to infinity. A separate DX finding showed ratio-mode missing-field errors
teaching a reference-price call instead. These are bounded implementation/error-guidance fixes,
not a new API or a claim that proportional mapping predicts market prices.

At `ac6142d85634d84ffb47534cd08590c9cbce025d`, the rare boundary path uses private exact integer
arithmetic over the original binary inputs; ordinary prices continue through the existing scaled
floating-point path. Both reviewed values, ties to even, true refusals, and 40,460 independently
checked rounding intervals pass. The oracle compares exact fractions with fixed range thresholds
and the midpoints around the returned double; it does not duplicate the implementation's quotient
rounding algorithm.

Local receipts on Node 22.23.2 / pnpm 10.32.0 (direct exits 0):

- Valuation tests plus `tools/bundle-size/budgets.test.ts`: 182 tests across 7 files.
- `tools/packed-consumer.test.ts -t 'packed price-level conversion'`: 3 installed-consumer tests,
  including Node-free browser execution of the new exact-boundary path.
- First-touch, deep-sweep, unknown-key and finite-result suites: 1,104 tests across 4 files.
- Library TypeScript, changed-file ESLint/Prettier, build, and standalone API checks: all pass;
  the 25 public API reports are unchanged.
- The complete `REGENERATION_STEPS` chain runs in order. The only changed derived artifact is the
  bundle report. Enforcement remains 0 defective and naming remains 0 unresolved. This dirty-tree
  generation is not presented as a clean-tree `regen:check`; hosted CI owns that final-head gate.

Measured gzip changes versus `9a4aca1`: focused price-level import 8,189 → 8,432 B (+243 B),
whole umbrella 711,093 → 711,393 B (+300 B). The respective ceilings are 8.375 KiB and 695 KiB,
leaving 144 B and 287 B headroom. Every other narrow-import ceiling and schema/provider exclusion
is unchanged. The existing minor changeset covers the still-unreleased addition. Final-head hosted
fast/full receipts belong to PR #14; this local repair record is not permission to merge or publish.

## PL6 — task-first named helpers and optional descriptive metadata

**Authorized and locally verified 2026-10-12.** This amendment supersedes the original
prohibition on ticker-specific exports and mandatory descriptive units. It does not introduce
financial defaults. The required numeric inputs, generic method discriminator and range laws stay.

### Contract and pre-code review

- Export both directions for ES/SPY, NQ/QQQ, YM/DIA, RTY/IWM, SPX/SPY, NDX/QQQ, RUT/IWM and
  DJIA/DIA from `valuation/price-levels` and the valuation domain, with no umbrella root hoist.
  Names end in `Level`: `esToSpyLevel`, `spyToEsLevel`, etc. DJIA means the full Dow Jones
  Industrial Average, not the scaled DJX index. No provider-specific ticker spelling is inferred.
- Each helper takes exactly three named finite numbers, e.g.
  `esToSpyLevel({ esPriceLevel, referenceEsPrice, referenceSpyPrice })`. The requested level is
  nonnegative; both references are positive. Unit labels, method, ratio and every other key are
  refused, including an unknown field set to undefined. Instrument abbreviations here are
  recognizable market identities, not abbreviations of concepts such as volatility or volume.
- Every helper is a number-returning facade with `.explain()` and a separately imported closed
  input schema. `.explain()` copies the original named input, the canonical reference-price
  mapping with fixed descriptive unit labels, and the existing mapping assumption/warning.
  Invalid inputs and unrepresentable outputs name the helper actually called and its own fields.
- All helpers delegate to one arithmetic implementation, including PL5's exact range fallback.
  They do not call network services, select contracts, apply multipliers, infer market sessions,
  promise economic equivalence, or hardcode a price ratio. A single-helper import must tree-shake
  unused siblings and exclude schema/transport machinery.
- Generic unit labels become independently optional metadata. Omission/undefined is accepted;
  a provided null, wrong primitive or blank string remains a typed error. Supplied labels retain
  their previous meaning; supplied-label `.explain()` results are preserved. Without a target
  label, `resultUnit` is null and the documentation explicitly means “caller did not label units.”
  No method inference is added. This additive input relaxation affects an unreleased PR feature.
- The helper set covers four major US equity-index families through futures and cash-index
  reference mapping. Other pairs still use the generic primitive. No leveraged/inverse ETF,
  commodity or micro-contract aliases are added speculatively; a contract-size multiplier is not
  a price-level conversion ratio. Application/provider selection remains outside this library.

The pair selection is grounded in [CME's product list](https://www.cmegroup.com/markets/products),
[SPY's benchmark](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy),
[QQQ's benchmark](https://www.invesco.com/qqq-etf/en/home.html),
[DIA's benchmark](https://www.ssga.com/us/en/individual/capabilities/spdr-core-equity-etfs/dia-djia),
and [IWM's benchmark](https://www.ishares.com/us/products/239710/ishares-russell-2000-etf).
These establish instrument identity, not fixed ratios or a guarantee of proportional returns.

### Implementation and acceptance

- [x] All 16 named calls, types and optional schemas are exported and classified; generic labels
      are optional at both TypeScript/runtime boundaries and in JSON Schema.
- [x] Every helper's worked/inverse/parity/zero/frozen-input examples and every required-field,
      wrong-type, nonfinite, range, unknown-key and output-range refusal pass on both calls.
- [x] Examples/errors name the called helper; original named and canonical inputs are disclosed
      without mutation, nonfinite values or undefined metadata in successful explanations.
- [x] All helpers have meaningful first-touch fixtures and independently checked schema/contract
      coverage. Existing boundary oracles remain unchanged and green.
- [x] Installed strict NodeNext/Bundler and browser consumers cover all helpers and generic
      metadata omission; single-helper bundles prove sibling tree shaking and schema isolation.
- [x] Public guide, examples, changeset, classifications, generated reference/API/contract/docs
      artifacts and measured bundle records are synchronized; the queue names this same slice.
- [x] Focused local checks pass; their receipts are below. The final-head hosted fast/full
      landing gate remains separate and its exact head/run URLs are recorded in PR #14.

### PL6 local verification record

Node 22.23.2 / pnpm 10.32.0, direct exits 0:

- Valuation, bundle budgets and all five boundary-sweep suites: **1,548 tests / 13 files**.
  This includes **392 valuation tests**, 243 of them in the new helper/metadata suite. PL5's
  independent 40,460-case rounding oracle remains unchanged and passes.
- Installed strict NodeNext, Bundler, browser/guide and esbuild/Rollup single-helper tests:
  **5 pass**. All sixteen helpers and their schemas/types execute from the actual tarballs.
  A single `esToSpyLevel` import removes the generic facade and all fifteen siblings, retains
  only core/valuation modules, and excludes schema machinery under both bundlers.
- Public export, signature, fixture, contract, independent declaration/checker parity and
  naming conformance: **137 tests / 8 files**. The fixture join is 1,333; 0 names are unresolved.
- README snippets plus overflow sweep: **31 tests / 2 files**. Site build and **80 site tests**
  pass. The guide's TypeScript fences execute in the installed consumer.
- Library types, changed-file lint/format, build and all **25 API reports** pass. The full
  ordered artifact chain ran successfully; docs inventory reports 0 findings.
- Generated enforcement adds **80 fully enforced aliases/call paths** for the 16 helpers:
  2,573 enforced of 5,461 candidates, 0 defective. Partial (2,701) and unmeasured (187)
  populations do not increase. Current machine-checked tracker counts are synchronized.

The first conformance pass caught unclassified instrument tokens and stale live tracker counts;
published symbol rationales and the measured prose were corrected, not the gates weakened. An
early boundary run raced the unfinished contract regeneration; the ordered regeneration followed
by the complete 1,548-test rerun above passes. Neither failed attempt is counted as a green receipt.

Measured whole-entrypoint gzip: **8,432 → 9,621 B** (+1,189 B); whole umbrella
**711,393 → 712,699 B** (+1,306 B), Node 22.23.2/esbuild 0.25.12. The respective ceilings
are 9.625 KiB (235 B headroom) and 696.25 KiB (261 B). Other narrow ceilings and structural
gates remain unchanged. The installed single-helper canaries have separate 9 KiB limits.

Commit and push are authorized; merging, version bumps and npm publication are not. The earlier
PL1–PL5 hosted receipts do not verify PL6; PR #14 records fresh final-head fast/full receipts.
