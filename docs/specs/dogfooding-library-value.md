# Dogfooding-driven library value — specification and task list

Status: implemented and locally verified complete (September 7, 2026). This is the follow-on to
[app dogfooding](../reviews/app-dogfooding-implementation.md) and the review of PR #336.
The public-contract laws in [the alignment spec](../library-alignment-spec.md) govern every item.
This batch adds reusable compute capabilities; it does not authorize deployment, live trading,
publication, or a change to the app's default pricing engine.

## Decisions and boundaries

1. Supplied Greeks and model Greeks are different observations, not interchangeable truth.
   Expose a clearly named supplied-Greek calculation with explicit GEX and DEX conventions,
   provenance, units, coverage, per-contract contributions and strike/expiry aggregates. Never
   reprice a spot/volatility scenario by pretending supplied Greeks remain a pricing model.
2. Chain health is a report, not a mutation or automatic filter. Compose existing pricing,
   no-arbitrage and IV primitives; disclose stale/future/missing/crossed/wide quotes, expiry and
   strike coverage, and model-fit/solver outcomes. A price outside a model's feasible range is
   model-incompatible, not proof the market observation is invalid. Thresholds and valuation time
   are explicit. Never invent rates, dividend treatment, IVs or quote timestamps.
3. Comparison/replay extends existing analysis artifacts, snapshot identity, canonical comparison
   and exact replay rather than inventing a second serialization framework. Add a financial
   comparison report with independently specified per-metric units/tolerances and semantic
   differences (model, input snapshot, day count, dividends, multiplier, quote/Greek source,
   conventions). Numeric closeness does not erase a semantic mismatch or prove vendor error.
   Raw pricing and ordinary reports remain callable without creating artifacts.
4. Sector performance belongs in `@totalfinance/performance`, with a simple same-period-return
   on-ramp and a separate rigorous completed-session historical report. The library calculation
   policy is vendor-neutral. Version identity is stamped/echoed; a single supported policy must
   not impose a magic InsiderFinance string on every caller. Keep effective-dated classifications,
   source/knowledge cutoffs, stable identities, exclusions and exact selected-input lineage.
   Do not invent missing audit metadata in the simple path. Provider field aliases, eligible
   universe selection, endpoint replacement, caching and production rollback remain app-owned.
5. All new public financial calls take explicit named objects. Rich primary reports carry
   assumptions and `diagnostics.warnings`, so existing saved-analysis artifacts accept them.
   Closed control objects reject typos; structural observation rows accept harmless decoration
   while validating every consumed field. Sparse arrays, non-finite values, nulls and malformed
   objects receive typed indexed errors. Work is bounded before expensive traversal/allocation.
6. New APIs are direct SDK/domain exports with deliberate manifest classifications and executable
   fixtures. They are not automatically new MCP tools. Existing curated transport coverage stays
   honest; no broad tool proliferation or hidden I/O is part of this batch.

## Task list and acceptance

- [x] Supplied-Greek exposure: implement the report, explicit signs/units/source, full runtime
      boundary checks, model-fed parity, independent hand-calculated GEX/DEX fixtures, aggregation
      conservation and deterministic ordering; demonstrate use in the dogfooding harness.
- [x] Chain health: implement the consolidated report, explain exclusions separately from malformed
      requests, reuse model/IV primitives, and test stale/future quotes, crossed/wide markets,
      missing/sparse coverage, unavailable/model-incompatible IV, dividends/exercise assumptions,
      empty chains, resource limits, and non-mutation.
- [x] Comparison/replay: implement or extend the artifact comparison layer with metric-specific
      tolerance and semantic disclosures; tests must cover equal numbers under different models,
      mismatched units, absent values, zero baselines, missing input identity, unknown keys,
      truncated/bounded work, tamper detection and exact replay. Include a runnable adoption example.
- [x] Sector performance: update PR #336 against the current base; offer simple and audit paths,
      neutral policy, report grammar, shared aggregation semantics, dense-array validation and
      indexed observation selection. Preserve golden point-in-time behavior and add realistic
      full-universe scaling evidence, decoration/purity tests, unknown-field/type teaching and
      numerical edge cases. No application endpoint is claimed implemented.
- [x] Integrate all public exports, first-touch fixtures, API reports, manifests, names, signatures,
      contracts, measured enforcement, reference/agent docs, runnable examples and narrow packaging.
- [x] Review the integrated implementation adversarially, repair findings, and pass formatting,
      lint, typechecks, builds, full tests/coverage, artifact freshness and packed consumers.
- [x] Update this tracker and implementation-order with exact verified status and next steps.

The sector task from [PR #336](https://github.com/InsiderFinance/insiderfinance-app/pull/336) is now
integrated into PR #303 at `fc46353b` (2026-09-08), on the maintainer's explicit instruction.
The search repair is preserved. Integration and local verification are not release approval;
the unresolved hosted matrix still gates publication.

## Verification record

Source gates pass for `exposureFromGreeks`, `optionChainHealth` and
`compareCalculationArtifacts`. All reports can be saved directly as analysis artifacts without
casts/spreads; strict NodeNext/Bundler packed-consumer checks exercise that contract. The
[public adoption guide](../guides/calculation-adoption.md) executes its actual code fences in CI.

The installed-package app comparison covers 20 synthetic contracts, three position conventions,
two gamma units and net/gross GEX/DEX: all six cases have zero difference. Independent hand-summed
totals, three host timezones and a forbidden implicit clock are also tested. These are matched-input
aggregation checks, not live-vendor/model-Greek equality or certification of app wall/score formulas.

Adversarial review repaired exact-tolerance edge cases (36,450 independent numeric-oracle cases),
source-failure diagnostics, producer-operation policy, descriptor-safe bounded comparison controls,
shared retained-difference limits, report assignability, indexed expiry errors, numeric error codes
and subnormal spread reporting. Comparisons default to requiring the same producer operation;
cross-operation metric comparisons are explicit and never waive failed source calculations.

The new optional model branch also exposed false omission evidence in the tooling: a model-less
request can legitimately select quote-only health. The harness must judge omissions against the
complete declaration, demand positive conformance evidence rather than opaque/truncated abstention,
and never count a valid transition as a negative probe. Regression cases protect genuinely required
fields and forbidden model-only controls; this is not an allowlist or a weakened library contract.

Final local verification ran on Node 26.5.0:

| Revision   | Scope                                 | Full library tests | Site tests | Full CI and clean regeneration       |
| ---------- | ------------------------------------- | -----------------: | ---------: | ------------------------------------ |
| `c993367d` | PR #303 dogfooding value              |             11,488 |         38 | Pass; generated files byte-identical |
| `d81a0db5` | PR #336 plus the current PR #303 base |             11,897 |         38 | Pass; generated files byte-identical |
| `fc46353b` | PR #336 merged into #303 with search  |             11,897 |         63 | Pass; generated files byte-identical |

All runs include formatting, lint, typechecks, builds, packed consumers, contract freshness,
API checks and the enforced coverage floors. PR #303 coverage is 94.07% statements / 83.73%
branches / 96.88% functions / 94.63% lines; the combined sector branch is 94.10% / 83.79% /
96.90% / 94.66%. Measured contract defects remain zero on both branches. All 29/30 bundle
budgets pass respectively. The three new registered warnings add 66 compressed bytes to pricing's
shared code registry (11,717 → 11,783 bytes), with the exact same contributing source set; the
budget rationale records this cost and retains the forbidden-dependency checks.

The final app tarball refresh also passes the eight harness tests, empty-cache offline Yarn
installation, TypeScript 5.4.5 checks over all 70 public exports under Node/Bundler/NodeNext,
private-import refusal, Node ESM/browser-only execution, the six installed-package GEX/DEX
comparisons and the full app TypeScript check. The preceding app migration batch passed all
2,127 app tests and the all-opt-in app compile.

The merge revision retains the combined coverage values above and passes all 25 API checks and
30 bundle budgets. No calculation or playground source changed to resolve the merge. Its closeout
strengthens sector search from a conditional pre-integration assertion to an unconditional gate.

Next: revisit first-touch documentation examples as requested, then complete the existing app
browser/data acceptance and exact-revision release gates; resolve hosted CI in parallel. Follow
[implementation-order](../implementation-order.md), not a separate sector queue. Do not restart
the completed core implementation stages.
Browser acceptance is still permission-gated; no fresh vendor feed was captured, no default engine
changed, and no package, endpoint or production site was deployed by this merge. The temporary
beamd website preview is separate from release approval. A “10/10” label does not replace evidence or
external UX study.
