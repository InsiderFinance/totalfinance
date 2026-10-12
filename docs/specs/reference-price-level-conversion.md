# Reference-price level conversion

Status: PL1–PL4 implementation and requested local verification complete (2026-10-12) at `f5beceb3b325d4763313b1019bfb904eb3033b89`. [PR #14](https://github.com/InsiderFinance/totalfinance/pull/14) is open; final-head hosted checks and maintainer review remain separate landing gates.
Queue: bounded consumer-requested addition in `../implementation-order.md`.
Issue: [#13](https://github.com/InsiderFinance/totalfinance/issues/13). This is a library addition requested for the ES/SPY and NQ/QQQ
application pages; application implementation and publication are separate work.

## Outcome and limits

One browser-safe, deterministic call maps a nonnegative source price level to an approximate
target price level from caller-supplied positive reference prices or a positive directed ratio.
Both instrument pairs use the same call. No ticker presets, quote acquisition, clock, timestamp
inference, credentials, or network requests belong here. Units are caller-supplied labels; the
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
   `sourcePriceLevel`, `sourcePriceUnit`, and `targetPriceUnit`. Reference mode additionally
   requires `referenceSourcePrice` and `referenceTargetPrice`. Ratio mode instead requires
   `targetPricePerSourcePrice` (target price units per one source price unit). No inferred method,
   optional financial default, reverse flag, alias, builder, or ticker-specific export.
4. **Arithmetic:** reference mode computes
   `sourcePriceLevel * referenceTargetPrice / referenceSourcePrice`; ratio mode computes
   `sourcePriceLevel * targetPricePerSourcePrice`. No rounding to cents/ticks occurs. Inversion
   uses another call with source/target units and references swapped, or with a caller-supplied
   reciprocal ratio. Tests declare numeric tolerances rather than promising exact round trips.
5. **Validation:** both callable boundaries validate the full input. Each method arm is closed;
   mixing ratio and reference fields is refused even when the forbidden field is `undefined`.
   Missing fields, wrong containers/primitives, unknown fields, invalid methods, nonfinite
   numbers, negative levels, nonpositive references/ratios, and blank units receive registered,
   typed teaching errors. Input records are never mutated.
6. **Numerics:** reference arithmetic scales binary significands/exponents to avoid unnecessary
   intermediate overflow/underflow, including when the implicit ratio itself is not
   representable. A positive result rounded to zero is refused as underflow; subnormal nonzero
   results are supported with ordinary double precision. Overflow is refused using the existing
   `requireRepresentableResult` finalizer. Facade finite postconditions also inspect the whole
   explanation. No nonfinite derived ratio is inserted into assumptions.
7. **Explanation:** echo a copy of the complete selected input (method, references or directed
   ratio, level and units), the result unit, the ratio direction and the mapping-validity
   assumption. Include the registered `model.limitation` warning naming the limitations above.
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

| Slice | Contents                                                                                       | State                          |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| PL1   | Issue, queue row, controlling contract and pre-code review                                     | complete before implementation |
| PL2   | Facade, validation, schemas, unit/error documentation and domain tests                         | complete at `f5beceb`          |
| PL3   | Public classification, first-touch fixtures, runnable guide, installed consumers and changeset | complete at `f5beceb`          |
| PL4   | Derived artifacts, full requested verification, truthful tracker closeout and PR               | complete at `f5beceb`          |

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

## Verification record

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
