# TotalFinance core capability completion — specification and execution tracker

> **Scope:** this is not a backtesting-only specification. It closes four independently useful
> capability families: foundational finance and valuation, quantitative research, durable portfolio
> management, and portfolio-scale simulation/backtesting. Backtesting is one downstream workstream
> (`FC8`), not the umbrella for the document.
> **Status:** original FC0–FC9 and platform slices landed; review repairs are locally verified complete.
> The tracker table records those completion points and the maintainer-held release gates.
> [September review repairs](./review-september-2026-repairs.md) records the local evidence on
> `dccfce53` plus the repair changes. Next: Stage 5A/5B remain maintainer-held; no publication,
> commit/push, or hosted-matrix success is implied, and completed work must not restart.
> **Queue authority:** [`../implementation-order.md`](../implementation-order.md) controls when each
> slice starts. Phase 3B and the original core-freeze program have closed; this specification retains
> their compute contracts and the separate locally verified repair closeout.
> **Current pre-release repair (2026-09-21):** [installed-consumer bundle guarantees](./tree-shaking-and-consumer-budgets.md)
> are **COMPLETE (local) @ `d95634c`** in the standalone TotalFinance repository. Full Node 22 CI,
> independent Node 24 coverage, API checks and clean-checkout regeneration pass. Next is the remaining
> organization/website acceptance and exact release rehearsal owned by `implementation-order.md`;
> this bounded import/validation repair does not reopen FC0–FC9 or authorize publication.
> **Permanent API authority:** [`../library-alignment-spec.md`](../library-alignment-spec.md) and
> [`../platform-completeness-roadmap.md`](../platform-completeness-roadmap.md). Every public API added
> here must satisfy their naming, argument, result, runtime, layering, determinism, provenance, and
> parity laws in its first commit. This work does not create a second cleanup phase.
> **Related focused contracts:** the durable-state, management, and safe-trading requirements in
> [`../agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
> are normative for FC7; the shipped options-backtest contract in
> [`options-backtest.md`](./options-backtest.md) remains normative for the current implementation and
> this specification owns its portfolio-grade completion requirements.

## Bounded disclosed-holdings addition (2026-09-25)

The additive [reported-partition successor](./disclosed-holding-partitions.md), HP1–HP5, is
**implementation and independent local verification complete (2026-10-06) @
`612fed23e094c7468d9398ebb1e9edb644af8904`.** Full CI and an independent coverage repeat passed
579 library files / 12,852 tests plus 80 site tests; separate API checks and clean committed
regeneration passed. The linked spec records the exact verification and earlier RPC-timeout retry.
It preserves the v1 calculator and does not reopen ledger semantics. Final-head hosted checks
remain required before [PR #11](https://github.com/InsiderFinance/totalfinance/pull/11) merges;
publication and the consumer's offline handoff remain separate.

The independent consumer-requested [disclosed holdings comparison](./disclosed-holdings.md) is
**DH1–DH7 implementation and review verification complete (2026-10-02) @
`69b9ef92094f16b5f4fa881229b586ecb1c3f67e`.** Typed scales and reason codes, structured policy reporting,
and current-main integration are included. Local full CI and an independent hosted Node 22.13.0
full-coverage repeat each passed 577 files / 12,788 tests plus 80 site tests; separate API checks
and clean regeneration pass. The linked spec records exact receipts and preserves the original
September evidence. Final-head hosted checks remain mandatory before PR #4 merges; publication
is separate. This compares selected disclosure snapshots and does not reopen FC7 economic-ledger
semantics. Do not restart completed DH1–DH7 work.

## How this document becomes library code

This file deliberately combines a specification and an execution tracker. The two roles are distinct:

| Concern                         | Source of truth                                                                                        | Update rule                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which program is active         | [`implementation-order.md`](../implementation-order.md)                                                | It alone moves the global queue from Phase 3B to Stage 4 and later stages.                                                                       |
| What FC0–FC9 must build         | Settled decisions, contracts, APIs, semantics, acceptance laws, and package ownership in this document | Treat these as implementation requirements. Reopen one only with a documented counterexample or an explicit product decision.                    |
| Progress inside Stage 4         | The active-queue table and FC checklists in this document                                              | Change a slice to `COMPLETE @ <commit>` only when its code, tests, generated artifacts, and stated exit evidence are green at that exact commit. |
| Permanent public API standards  | [`../library-alignment-spec.md`](../library-alignment-spec.md)                                         | Every new API enters its naming, signature, runtime, field, result, and packed-consumer ratchets in the first implementation commit.             |
| Cross-domain platform contracts | [`../platform-completeness-roadmap.md`](../platform-completeness-roadmap.md)                           | Stage 4.1–4.7 compose the finance work into artifacts, durable books, shared scenarios, and simulation without duplicating domain logic.         |

### Active-queue handoff

The current workflow is explicit. `BLOCKED` means “do not implement yet,” not “undecided.”
The September review repairs are locally verified complete; Stage 5A/5B remain maintainer-held.
Completed rows below retain their historical landing evidence. Local repair verification does
not authorize publication or close the separately held hosted-matrix gate.

| Global queue  | Slice                                         | State now                                 | Activation and dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 3       | Phase 3B runtime and semantic closeout        | `COMPLETE @ af99ee107`                    | Closed 2026-08-19; permanent ratchets hardened through the 2026-08-26 merge-readiness review without reopening the gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stage 4.0     | FC0 contracts, package graph, and evidence    | `COMPLETE @ 3432f6f4d`                    | Reviewed 2026-08-19. Grammar unified, fundamentals landed, graph law installed, evidence plans + defaults frozen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Stage 4.0     | FC1 cash-flow foundation                      | `COMPLETE @ 2d7126a69`                    | Reviewed 2026-08-19. Valuation package landed measured-in-full: enforced +29, ZERO added unmeasured; IRR answers or explains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Stage 4.0     | FC2 valuation and fundamentals                | `COMPLETE @ ce7f545c8`                    | Reviewed 2026-08-19. Two packages measured whole: 0 defective, six probe-caught defects fixed, all 11 acceptance laws closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Stage 4.0     | FC3 research primitives                       | `COMPLETE @ 6538cdf92`                    | Reviewed 2026-08-19. The 16th domain landed measured-whole: 0 defective, 8 guard defects probe-caught and fixed, 8 laws closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Stage 4.0     | FC4 cash-flow-aware performance               | `COMPLETE @ 3b76a2d3b`                    | Reviewed 2026-08-19. Flow-aware module landed: 0 defective, gaps never forward-filled, all 5 laws closed with evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Stage 4.0     | FC5 foreign exchange                          | `COMPLETE @ 3b76a2d3b`                    | Reviewed 2026-08-19. The 17th domain landed measured-whole: 0 defective, 3-way parity bridge at 1e-12, all 5 laws closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Stage 4.0     | FC6 commodities                               | `COMPLETE @ 98589fcee`                    | Reviewed 2026-08-19. The 18th domain closes Stage 4.0: 0 defective, exact inverse recovery + multiplicative roll, 4 laws closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Stage 4.1–4.3 | Platform gates, artifacts, and extensions     | `COMPLETE @ 4a6dd7d97`                    | COMPLETE: 4.1 @ 59d714a78 · 4.2 @ 38d82ffa9 · 4.3 @ 4a6dd7d97, hardened by the review waves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Stage 4.4a    | FC7 durable portfolio management              | `COMPLETE @ a6f9842b`                     | Reviewed 2026-08-29. The event-derived ledger, lifecycle, policy, reconciliation, hostile-input, and packed-runtime exit laws are closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Stage 4.4b    | Shared cross-domain scenario runner           | `COMPLETE @ 3095cf91`                     | Verified 2026-09-01 from [`shared-scenario-runner.md`](./shared-scenario-runner.md): all slices, packed consumers, evidence, and full CI are green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Stage 4.5     | Calibration and research artifacts            | `COMPLETE @ 795dd999f`                    | Closed 2026-09-03 from [`calibration-research-artifacts.md`](./calibration-research-artifacts.md): six slices, three `./artifacts` subpaths, packed consumers, full CI, and the ticked exit gate; completion record inside.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Preview P1    | Options marking truthfulness                  | `COMPLETE @ db2df2451`                    | Landed 2026-09-03: current-quote marking by default, a refusing missing-mark policy with named fallbacks, per-leg volatility in the mark and the P&L explain, evidence in every trade; six fixtures; [`options-backtest.md`](./options-backtest.md) Preview P1 amendment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Stage 7A      | Local operations, CLI, OpenAPI, and MCP       | `COMPLETE @ c7bdb260d`                    | Landed 2026-09-03 in seven slices under [`local-operations-and-transports.md`](./local-operations-and-transports.md): the AT2 registry and runtime, ten journey operations, local AT3 handles / stores / jobs, the `totalfinance` CLI, `@totalfinance/http` + OpenAPI, the local-MCP preview gate, transport parity and packed consumers.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Stage 5A      | Preview integration and shipping              | `MAINTAINER-HELD; LOCAL REPAIRS COMPLETE` | Contract accepted 2026-09-03, slices 1–3 (metadata, `STABILITY.md`, changesets pre-mode, the preview-surface audit, community files, runbooks, the dry-run manifest, the approval-gated release workflow, the registry smoke rehearsed in CI) landed: [`preview-integration-and-shipping.md`](./preview-integration-and-shipping.md) (metadata + stability statement, the FC9 preview audit, release automation with an approval gate, the registry smoke; one maintainer decision — the public repository). The September repairs are locally verified complete. After the maintainer's Decision 8, run current-surface release checks, public-package safeguards, actual-registry smoke, and the explicit pre-1.0 preview cutover; the original FC9 completion is separate evidence. |
| Stage 4.6     | FC8 portfolio-scale backtesting               | `COMPLETE @ 839a955e7`                    | Closed 2026-09-04 from [`portfolio-scale-backtesting.md`](./portfolio-scale-backtesting.md): six slices — the shared contracts, `crossSectionalBacktest`, the grid and the run artifacts, `optionsBacktest` over a position book, `portfolioBacktest` with eight adapters, `portfolio_run` and the out-of-sample verbs — every flagship operation on the five transports, full CI, and the ticked exit gate; completion record inside.                                                                                                                                                                                                                                                                                                                                                 |
| Stage 4.7     | FC9 integration and core freeze               | `COMPLETE @ 530eb6de8`                    | Closed 2026-09-04 from [`fc9-integration-and-core-freeze.md`](./fc9-integration-and-core-freeze.md): five slices — the three gates, the two remaining flagship operations, the end-to-end and levels guides with the generated field reference, `pnpm regen:check` and its hosted job, the FC0–FC9 sweep and the core-freeze gate; completion record inside. Two rows stay open by standing decisions: the performance budget (the maintainer's deferral) and the hosted matrix (GitHub Actions billing).                                                                                                                                                                                                                                                                              |
| Stage 7B.1    | AT4 trading-agent environment and Agent Bench | `COMPLETE @ f7677ebcb`                    | Contract [`trading-agent-environment.md`](./trading-agent-environment.md): the portfolio engine's loop driven from outside through a stepper seam, the next-observation and no-leak laws as gates, a declared reward composition, twenty seeded synthetic episodes with executable expectations, the `environment` run kind, Agent Bench with operational conformance reported apart from strategy quality, and one declarative operation. Executes while the Stage 5A publish waits on the maintainer.                                                                                                                                                                                                                                                                                |
| Stage 7B.2    | AT5 safe trade lifecycle and paper execution  | `COMPLETE @ 44cd9d72e`                    | Contract [`trade-lifecycle-and-paper-execution.md`](./trade-lifecycle-and-paper-execution.md): trade artifacts and normalization, preflight through the ledger and the monitor, a structured policy, bounded content-addressed authorization, the execution journal, a paper broker over the declared execution policy with the hazard suite, reconciliation, runtime capabilities, and six trade operations across the transports. Live adapters stay `AT8`.                                                                                                                                                                                                                                                                                                                          |
| Stage 5B      | Stable release                                | `MAINTAINER-HELD; LOCAL REPAIRS COMPLETE` | Stage 4.7 landed and the September repairs are locally verified complete. Final release documentation, authorization, publication, registry smoke, and stable-version cutover remain subject to the maintainer's release gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Stage 4.4b closed on 2026-09-01 at `3095cf91`, after all four implementation slices and the complete
repository gate passed. **Stage 4.5 closed on 2026-09-03 at `795dd999f`**: its contract,
[`calibration-research-artifacts.md`](./calibration-research-artifacts.md), was authored 2026-09-01,
adversarially reviewed, revised, and accepted 2026-09-02, and its six ordered slices (core contracts
→ direct-API warm starts and renames → volatility → fixed-income → research → packed consumers and
closeout) each landed with tests, generated evidence, and a slice record; the completion record and
the ticked exit gate are in the contract. **Preview P1 closed at `db2df2451` and Stage 7A closed at
`c7bdb260d` (2026-09-03). The September review repairs are locally verified complete; Stage 5A publication remains
maintainer-held.**

**Original preview sequencing (historical):** P1 and Stage 7A could execute in parallel after
Stage 4.5, with `optionsBacktest` registration waiting for P1. The maintainer subsequently allowed
FC8/Stage 4.6 and FC9/Stage 4.7 to land ahead of the still-held Stage 5A publish. Those stages and
Stage 7B.1/7B.2 are complete as original slices; none should be restarted. A preview audit cannot
substitute for their separate local review-repair evidence or for the stable-release gate.

Copy-paste handoff for the next implementing agent:

> Read `docs/implementation-order.md` first, then `docs/specs/review-september-2026-repairs.md`.
> Stages 4.5, Preview P1, 7A, 4.6, 4.7, 7B.1, and 7B.2 already landed; do not restart them.
> The review repairs are locally verified complete on `dccfce53` plus the repair changes; do not restart them.
> Stage 5A publication and Stage 5B stable cutover remain maintainer-held and need release decisions and
> their shipping gates. Data/hosted services, live trading, and acceleration remain separately
> governed later work, not implicit authority granted by a paper-execution repair.

Stage 7A was a deliberate exception to the old “all transports later” sequence. The foundations,
FC8 expansion, local transports, trading environment, and safe paper lifecycle have now landed.
Stage 6 data, connected/hosted Stage 7B work, live execution, and Stage 8 acceleration remain
separately governed later layers, not hidden homes for compute semantics.

## Executive decision

The following is the original gap analysis that motivated FC0–FC9, not a statement that those
implemented capabilities are still missing. Current completion and repair status is recorded above.

TotalFinance is exceptionally deep in options, volatility, technical analysis, risk, fixed income, and
research hygiene, but that depth hid several category-level gaps. A blank-sheet finance inventory
found no general time-value-of-money layer, corporate DCF, typed fundamental analysis, general equity
screener, economic style-factor construction, generic event-study engine, cash-flow-aware portfolio
performance, coherent foreign-exchange front door, or commodity-carry package. Portfolio management
is well designed but not implemented. Backtesting is substantial but not yet portfolio-scale,
cross-sectional, cross-asset, or ledger-backed.

These are not documentation or provider gaps. Every capability in this specification is pure compute
over caller-supplied data. Data adapters arrive later and normalize into these contracts.

The target journey is continuous while every level remains independently usable:

```text
cash-flow math and fundamentals
            │
            ▼
corporate valuation ──▶ screening, factors, and event studies
            │                         │
            └──────────────┬──────────┘
                           ▼
              portfolio construction and policy
                           │
                           ▼
             durable ledger and reconciled performance
                           │
                           ▼
              portfolio-scale historical simulation
                           │
                           ▼
       workflows, MCP, data adapters, agents, paper/live edges
```

No higher box becomes mandatory for a lower task. A developer can calculate present value, DCF,
factor scores, event-window returns, TWR, FX forwards, or commodity carry without creating a client,
provider, ledger, workflow, or agent.

## Accepted baseline and exact gap (historical; FC0–FC6 are now complete)

This table records the blank-sheet baseline that produced FC0–FC9. Rows assigned to FC1–FC6 are no
longer current gaps; their exact completion evidence is in the active-queue table above. FC7–FC9
remain the live implementation work.

| Capability                                              | Current truth                                                                  | This specification                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Options/volatility/strategy/TA/fixed-income/credit/risk | Broad and shipped                                                              | Preserve; compose rather than duplicate     |
| General PV/FV/NPV/IRR/loan math                         | Absent                                                                         | FC1                                         |
| Corporate valuation and DCF                             | Absent                                                                         | FC2                                         |
| Typed statements and fundamental ratios                 | Only a generic `Fundamentals.fields` placeholder                               | FC2 replaces the compute-facing placeholder |
| General screening                                       | Options-strategy scanner only                                                  | FC3                                         |
| Style factors                                           | PCA exposure/attribution exists; factor construction does not                  | FC3                                         |
| Generic event study                                     | Earnings event-volatility exists; event studies do not                         | FC3                                         |
| Cash-flow-aware performance                             | Mentioned in the portfolio roadmap; not implemented                            | FC4                                         |
| Foreign exchange                                        | FX-option/cross-currency pieces exist; no coherent basic surface               | FC5                                         |
| Commodities                                             | Crypto carry exists; general commodity carry is absent                         | FC6                                         |
| Point-in-time book analytics                            | `analyzeBook`, VaR, P&L explain, margin, optimization shipped                  | Preserve                                    |
| Durable portfolio management                            | Detailed direction only                                                        | FC7                                         |
| Equity/event-driven backtesting                         | Shipped                                                                        | Preserve and extend in FC8                  |
| Options backtesting                                     | Initial engine shipped; constant-entry-volatility and one-position limitations | Preview P1 + FC8                            |
| Cross-sectional/cross-asset/ledger-backed simulation    | Absent                                                                         | FC8                                         |

## Settled decisions — no implementation questions remain

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Add separate `@totalfinance/valuation` and `@totalfinance/fundamentals` packages; do not create a vague `@totalfinance/finance` package or hide statement analysis under valuation. `valuation` owns cash-flow mathematics, forecasts, and corporate valuation. `fundamentals` owns typed statements, statement utilities, ratios, and scores.                                                                                               |
| D2  | Add `@totalfinance/research`; it owns data-free screening, cross-sectional ranking, style-factor construction, and event studies. It does not own backtest execution or data retrieval.                                                                                                                                                                                                                                                      |
| D3  | Add `@totalfinance/foreign-exchange` with umbrella namespace `foreignExchange`. `FX` remains valid in prose and canonical market notation, but package, namespace, function, and field names are explicit.                                                                                                                                                                                                                                   |
| D4  | Add `@totalfinance/commodities` for generic commodity spot/forward/futures carry and term-structure analytics. Physical logistics and venue adapters remain out of scope.                                                                                                                                                                                                                                                                    |
| D5  | Implement `@totalfinance/portfolio` as the event-derived, browser-safe economic-state package already designed in the agent/platform document. It does not absorb `@totalfinance/risk`, `@totalfinance/performance`, pricing packages, providers, persistence implementations, or broker credentials.                                                                                                                                        |
| D6  | Extend the existing `@totalfinance/performance` and `@totalfinance/backtest`; do not mint replacement packages.                                                                                                                                                                                                                                                                                                                              |
| D7  | Raw functions remain independently public. Compositions and workflows call those functions or a batch implementation proven semantically equivalent.                                                                                                                                                                                                                                                                                         |
| D8  | Financially confusable public and internal inputs use one flat named object. Conventional acronyms appear in public identities only when the Phase 3B.N allowlist records them as the dominant market term (for example, EBITDA); otherwise they stay in literature/formula documentation and canonical function/field names are explicit (`netPresentValue`, `internalRateOfReturn`, `weightedAverageCostOfCapital`, `timeWeightedReturn`). |
| D9  | General cash-flow amounts use the holder/investor perspective: inflows are positive and outflows are negative. Amortization rows separately report positive payment, interest, and principal magnitudes to avoid Excel-style sign surprises.                                                                                                                                                                                                 |
| D10 | A timed cash flow explicitly identifies `timeYears`; a dated cash flow identifies `cashFlowDate`, and every dated calculation requires `asOf`. Period zero is included when supplied. TotalFinance never reproduces Excel's easily-misread “NPV starts at period one” behavior silently.                                                                                                                                                     |
| D11 | Rates are decimal, not percent. Fields identify whether a rate is annual or periodic. Compounding and day-count conventions are explicit or are a documented facade default echoed in assumptions. Professional valuation paths never invent a discount rate, terminal method, growth rate, tax rate, currency, or share count.                                                                                                              |
| D12 | `discountedCashFlow` is a rich analysis, not one opaque scalar. It returns projected and terminal present values, enterprise value, an optional enterprise-to-equity bridge, optional per-share value, assumptions, diagnostics, and provenance. Every underlying primitive remains callable directly.                                                                                                                                       |
| D13 | Compute-facing fundamentals use typed statements and period/availability metadata. Vendor-specific tags and raw XBRL live at the data edge. Structural metadata may be preserved, but no calculation reads a generic string key without a declared mapping.                                                                                                                                                                                  |
| D14 | Screening has a serializable declarative grammar plus a direct callback escape hatch. No string expression parser or hidden `eval` enters the library. Ranking, ties, missing values, neutralization, and direction are explicit and deterministic.                                                                                                                                                                                          |
| D15 | The phrase `price-backed event` is retired. The canonical operation is `eventStudy`; canonical inputs are typed `MarketEvent` records plus price/return observations. Prediction-market contracts are a separate future domain.                                                                                                                                                                                                              |
| D16 | Portfolio truth is event-derived; P&L is a derived report; execution journals and economic ledgers remain separate. Corrections reverse or supersede events and never rewrite history silently.                                                                                                                                                                                                                                              |
| D17 | Backtest, deterministic replay, paper trading, and later live monitoring share portfolio-event, fill, accounting, valuation, and risk semantics. They may differ in clock and data source, not in finance.                                                                                                                                                                                                                                   |
| D18 | The shipped `vectorized`, `eventDriven`, and `optionsBacktest` calls remain available. FC8 adds focused modes/compositions rather than one universal backtester class.                                                                                                                                                                                                                                                                       |
| D19 | All compute remains BYOD and credential-free. Point-in-time data contracts are built now; SEC, market-data, broker, and InsiderFinance adapters arrive at the edge later.                                                                                                                                                                                                                                                                    |
| D20 | No new package receives an umbrella root hoist by default. It receives a symmetric domain namespace and curated package root/subpaths; a flagship hoist requires a separate manifest-backed discovery decision.                                                                                                                                                                                                                              |

## Permanent lovability and correctness gate

Every FC workstream must satisfy all existing laws plus the following concrete interpretation:

1. **One obvious first call.** Package README examples start from the common user question, not a
   class hierarchy or a low-level solver.
2. **Named financial coordinates.** No public `r`, `t`, `n`, `pv`, `fv`, `wacc`, `mwr`, `fx`, or
   generic `value` input where the concept can be named explicitly. Canonical formulas and report
   labels may include their standard acronyms alongside the explicit name.
3. **One result grammar per role.** Simple transforms are facades with `.explain()`; responsible
   multi-output calculations are analyses; reusable state is an immutable versioned artifact;
   expert kernels live on explicit subpaths.
4. **Teaching runtime errors.** Closed requests reject unknown keys, missing fields, wrong primitive
   or container types, invalid enum values, and non-finite inputs before calculation. Errors name the
   field, expected unit/shape, and a corrected minimal call.
5. **No plausible wrong answers.** Multiple-root IRR, invalid terminal growth, impossible statement
   identities, stale point-in-time data, singular neutralization, unavailable marks, and ambiguous
   intrabar fills produce a disclosed result or typed failure—not a guessed scalar.
6. **Explicit economics.** Currency, timing, cash-flow perspective, compounding, day count,
   annualization, benchmark, restatement policy, fill policy, costs, settlement, and tax treatment are
   never hidden.
7. **Finite and serializable success.** Rich results and artifacts are JSON-safe and deeply finite.
   Undefined metrics are `null`/omitted with field-specific reasons.
8. **Deterministic and clock-free.** Every date-sensitive call receives `asOf`; stochastic calls
   require and echo a seed; stable sorting and tie behavior are specified.
9. **Immutable inputs and outputs.** No function mutates caller arrays, statement records, events,
   holdings, or configuration. Returned artifacts snapshot their own state.
10. **Provenance survives composition.** Filing/data identity, market snapshot, model version,
    assumptions, and parent artifact hashes remain inspectable through valuation, research,
    portfolio, backtest, workflow, and transport layers.
11. **No second engine.** DCF workflows call cash-flow primitives; MWR calls the dated-return solver;
    factor backtests call research primitives; portfolio backtests call the portfolio reducer;
    transports call the SDK.
12. **Semantic parity.** Scalar, facade, batch, worker, future WASM, MCP, and language-client paths
    agree within declared tolerances and share names, defaults, units, errors, and model IDs.
13. **Manifest from day one.** Every export, field, schema, subpath, artifact, alias, and MCP linkage
    lands with its signature/field/role/first-touch/finite-result evidence; all Phase 3B ratchets stay
    at zero.
14. **Packed cold-user proof.** Examples and type tests run against packed tarballs under the
    supported Node/TypeScript/bundler matrix, never only workspace aliases.

## Package and dependency ownership

`A → B` below means package A may depend on package B:

```text
@totalfinance/fundamentals       → core, math
@totalfinance/valuation          → core, math, calendars, fundamentals
@totalfinance/research           → core, math, performance, fundamentals, valuation
@totalfinance/performance        → core, math, valuation
@totalfinance/foreign-exchange   → core, math, calendars
@totalfinance/commodities        → core, math, calendars
@totalfinance/portfolio          → core, performance
@totalfinance/risk               → core, math, options, performance, valuation; no portfolio dependency
@totalfinance/backtest           → portfolio; focused subpaths may also depend on research,
                               options, strategy, risk, calendars, fixed-income, and performance
@totalfinance/workflows          → every required compute/composition package
data/MCP/HTTP/CLI/adapters    → workflows and public SDK packages
```

This is the required graph. FC0 installs an architectural cycle test before package scaffolding.
September R05 adds `backtest → fixed-income` for the bond adapter's calendar coupon accrual:
reuse the domain owner instead of retaining a second approximate accrual formula.
`portfolio` does not import `risk`, and `risk` does not import `portfolio`; shared risk snapshots are
small structural contracts owned by `core`, and workflows explicitly compose the two packages.
`research` does not import `backtest`, and no compute package imports a data/provider/transport
package.

### Shared contract ownership

| Contract family                                                                 | Owning package               | Rule                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `EpochMs`, `DayCount`, `InterestCompounding`, provenance and point-in-time base | `@totalfinance/core`         | Small serializable vocabulary shared downward; no domain calculations move into core.                                                     |
| `TimedCashFlow`, `DatedCashFlow`, cash-flow solver diagnostics                  | `@totalfinance/valuation`    | Performance imports the dated solver rather than implementing another MWR root engine.                                                    |
| `FundamentalPeriod`, statements, snapshots, ratio inputs                        | `@totalfinance/fundamentals` | Valuation/research import typed fundamentals; data adapters map raw vendor records into them.                                             |
| `MarketEvent`, research observations, factor/screen recipes                     | `@totalfinance/research`     | Backtest imports serializable recipes/events; research never imports a simulator.                                                         |
| `PortfolioEventEnvelope`, `NormalizedFill`, lots/cash/state snapshots           | `@totalfinance/portfolio`    | Backtest/replay/paper/live emit the same economic facts; order submission and broker credentials are not portfolio state.                 |
| Simulation order records and fill/execution models                              | `@totalfinance/backtest`     | Simulation-specific mechanics map successful fills into portfolio-owned `NormalizedFill`/economic events.                                 |
| `MarketSnapshot`, `ScenarioSet`, `AnalysisArtifact` base contracts              | `@totalfinance/core`         | Platform Stage 4.2 freezes small JSON-safe structural contracts; domain packages own valuation/calibration logic and artifact extensions. |

No contract is copied into a consumer package for convenience. A package may define a narrower
structural input view, but parity tests prove it maps losslessly to the owner contract.

### Package roots and subpaths

| Package                          | Curated root                                               | Required subpaths                                                                                 |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@totalfinance/fundamentals`     | `analyzeFundamentals` plus canonical statement/ratio calls | `./statements`, `./ratios`, `./scores`                                                            |
| `@totalfinance/valuation`        | canonical cash-flow and company-valuation calls            | `./cash-flows`, `./corporate`, `./forecasting`                                                    |
| `@totalfinance/research`         | screening, factor, and event-study first moves             | `./screening`, `./factors`, `./events`                                                            |
| `@totalfinance/foreign-exchange` | spot/forward/conversion first moves                        | `./spot`, `./forwards`, `./risk`                                                                  |
| `@totalfinance/commodities`      | carry and term-structure first moves                       | `./forwards`, `./term-structure`                                                                  |
| `@totalfinance/portfolio`        | direct reducer, snapshot, reconciliation, policy/rebalance | `./events`, `./ledger`, `./performance`, `./policy`, `./reconciliation`                           |
| `@totalfinance/backtest`         | preserve current root                                      | preserve current subpaths; add `./cross-sectional` and ledger-backed v2 modes without breaking v1 |

These subpaths are required. FC0 adds each export only with its first real implementation slice, so
the repository never publishes an empty barrel or placeholder package.

## Canonical first-touch shapes

These examples freeze the intended ergonomics. The field names shown are required; implementations
may add only semantically necessary optional fields that pass the alignment/manifest review. Every
call also has a package-root or documented subpath import and works without a client/provider.

```ts
import { analyzeFundamentals } from '@totalfinance/fundamentals';
import { discountedCashFlow, netPresentValue, presentValue } from '@totalfinance/valuation';

const fundamentals = analyzeFundamentals({
  statements,
  marketSnapshot,
  asOf: Date.UTC(2026, 7, 12, 20),
  restatementPolicy: 'latest-available',
});

const present = presentValue({
  futureAmount: 1_000,
  annualInterestRate: 0.08,
  timeYears: 5,
  compounding: 'annual',
});

const projectValue = netPresentValue({
  cashFlows: [
    { amount: -1_000, timeYears: 0 },
    { amount: 600, timeYears: 1 },
    { amount: 600, timeYears: 2 },
  ],
  annualDiscountRate: 0.1,
  compounding: 'annual',
});

const company = discountedCashFlow({
  valuationBasis: 'firm',
  valuationDate: '2026-12-31',
  currency: 'USD',
  projectedCashFlows: [
    { cashFlowDate: '2027-12-31', amount: 120_000_000 },
    { cashFlowDate: '2028-12-31', amount: 135_000_000 },
  ],
  annualDiscountRate: 0.09,
  compounding: 'annual',
  dayCount: 'act/365f',
  terminalValueMethod: {
    method: 'perpetual-growth',
    terminalCashFlow: 135_000_000,
    perpetualGrowthRate: 0.025,
  },
  enterpriseToEquityBridge: {
    cashAndCashEquivalents: 40_000_000,
    totalDebt: 150_000_000,
    preferredEquity: 0,
    minorityInterest: 0,
    nonOperatingAssets: 0,
  },
  dilutedSharesOutstanding: 50_000_000,
});
```

```ts
import { eventStudy, screenUniverse } from '@totalfinance/research';

const screen = screenUniverse({
  universeId: 'us-large-cap@2026-08-12',
  asOf: Date.UTC(2026, 7, 12, 20),
  observations,
  fieldDefinitions,
  filter: {
    all: [
      { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual', value: 0.15 },
      { field: 'netDebtToEbitda', operator: 'lessThanOrEqual', value: 2 },
    ],
  },
  missingValuePolicy: 'exclude',
  orderBy: [
    { field: 'freeCashFlowYield', direction: 'descending' },
    { field: 'instrumentId', direction: 'ascending' },
  ],
});

const earningsReaction = eventStudy({
  events,
  returnObservations,
  eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 5 },
  estimationWindow: { startTradingSessionOffset: -120, endTradingSessionOffset: -20 },
  expectedReturnModel: { model: 'market', marketReturns },
  overlappingEventPolicy: 'reject',
});
```

```ts
import { timeWeightedReturn } from '@totalfinance/performance';
import { convertCurrency } from '@totalfinance/foreign-exchange';
import { commodityForwardPrice } from '@totalfinance/commodities';

const performance = timeWeightedReturn({
  valuations,
  externalCashFlows,
  flowTiming: 'at-flow-timestamp',
  annualization: 'none',
});

const dollars = convertCurrency({
  amount: 1_000,
  fromCurrency: 'EUR',
  toCurrency: 'USD',
  spotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 },
});

const forward = commodityForwardPrice({
  spotPrice: 72,
  timeToDeliveryYears: 0.5,
  annualFinancingRate: 0.05,
  annualStorageCostRate: 0.02,
  annualConvenienceYield: 0.01,
  compounding: 'continuous',
});
```

```ts
import { applyPortfolioEvents, createPortfolioLedger } from '@totalfinance/portfolio';
import { crossSectionalBacktest } from '@totalfinance/backtest/cross-sectional';

const nextState = applyPortfolioEvents({
  previousState,
  events,
});

const ledger = createPortfolioLedger({
  portfolioId: 'primary',
  baseCurrency: 'USD',
  events,
});

const run = crossSectionalBacktest({
  dataset,
  universeHistory,
  factorRecipe,
  rebalanceSchedule: { frequency: 'monthly', session: 'close' },
  portfolioConstruction: { method: 'equal-weight', maximumPositions: 50 },
  transactionCostModel,
  seed: 42,
});
```

The simple calls return their declared facade/analysis result directly. There is no positional
alternative for these financially confusable coordinates, no catch-all options bag, no implicit
clock, and no need to graduate to a ledger or backtest to use a lower-level function.

## Shared financial contracts

### Cash flows

```ts
interface TimedCashFlow {
  amount: number; // positive inflow, negative outflow
  timeYears: number; // 0 is the valuation instant
  label?: string;
}

interface DatedCashFlow {
  amount: number;
  cashFlowDate: string; // strict YYYY-MM-DD calendar date
  label?: string;
}
```

- A collection has one monetary unit unless a professional input declares `currency`.
- `timeYears` must be finite and non-negative for ordinary discounting. Historical cash-flow reports
  use dated flows and an explicit policy; they do not smuggle negative times into pricing helpers.
- Duplicate dates/times are accepted and aggregated deterministically without mutating input order.
- General cash-flow helpers never infer a cash flow at time zero.

### Interest convention

FC0 promotes one public `InterestCompounding` grammar into `@totalfinance/core`, migrates the existing
core and fixed-income public contracts to it, and removes the duplicate public compounding grammars.
Because this is pre-1.0, no compatibility aliases survive. The shared grammar is:

```ts
type InterestCompounding =
  | 'simple'
  | 'continuous'
  | 'annual'
  | 'semiannual'
  | 'quarterly'
  | 'monthly'
  | { type: 'periodic'; periodsPerYear: number };
```

Rates state whether they are annual or per-period at the field. Dated cash flows also state a
supported day count. A facade may default to annual periodic compounding or ACT/365F only when the
default is documented and echoed; a professional DCF or market instrument never obtains a discount
rate from a default.

The FC1 convenience facades for ordinary annual cash flows default to `compounding: 'annual'`.
Date-based FC1 facades default to `dayCount: 'act/365f'`. Their `.explain()` reports those defaults.
Rate-conversion functions, professional DCF analyses, and market-instrument functions require the
convention explicitly. Periodic compounding rejects rates at or below -100%; all conventions reject
states outside their mathematical domains.

### Fundamental periods and point-in-time availability

```ts
interface FundamentalPeriod {
  periodStartDate?: string;
  periodEndDate: string;
  fiscalYear: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  periodType: 'quarter' | 'year' | 'trailing-twelve-months';
  filedTimestampMs?: EpochMs;
  availableTimestampMs: EpochMs;
  currency: string;
  monetaryScale: 1 | 1_000 | 1_000_000;
  form?: string;
  accession?: string;
  restatementOf?: string;
}
```

`periodStartDate` and `periodEndDate` are strict `YYYY-MM-DD` calendar dates.
`availableTimestampMs`, not `periodEndDate`, controls point-in-time eligibility. A later restatement
is a new version with provenance. Backtests and event studies must not see it before its availability
time. These names and units are final and enter the Phase 3B naming/field ratchets with FC0.

## FC0 — Install contracts, packages, and evidence

### Deliverables

- [x] Add every new package and planned public operation to the architecture graph before code. CLOSED 2026-08-19: the FC0 required-edge matrix (including every not-yet-created package) and the named forbidden edges are law in `tools/package-graph.test.ts`.
- [x] Encode and freeze the shared cash-flow, interest, fundamental-period, market-event,
      portfolio-event, and point-in-time observation contracts defined here. CLOSED 2026-08-19:
      `InterestCompounding` is core's ONE grammar (both prior grammars migrated, no aliases);
      `FundamentalPeriod` + the availability law are code in `@totalfinance/fundamentals`. Contracts
      owned by not-yet-created packages (`TimedCashFlow`/`DatedCashFlow` → valuation;
      market/portfolio events → research/portfolio) stay frozen TEXTUALLY here and are encoded
      with their owner's first slice per the no-empty-package rule.
- [x] Replace or relocate the compute-facing generic `core.Fundamentals { fields: Record<...> }`.
      Provider raw fields may survive only as an explicitly raw/open data-edge artifact;
      `@totalfinance/fundamentals`, valuation, and research functions consume typed declarations.
      CLOSED 2026-08-19: renamed-in-place to `RawFundamentalsRecord` (the schema layer that
      validates vendor payloads lives in core, and fundamentals cannot be a core dependency); its
      docs bind the data-edge-only rule, and the typed side is `FundamentalPeriod`.
- [x] Add architectural tests for dependency direction and cycle prevention. CLOSED 2026-08-19: cycle + tier guards existed; FC0 adds the required-edge matrix, both named forbidden directions, and the compute↛data-edge law.
- [x] Add manifest/package/namespace/subpath placeholders only when backed by a first implementation
      slice; no empty public packages. CLOSED 2026-08-19: only `@totalfinance/fundamentals` lands (its
      first slice is the frozen contracts + guards + availability law, real exported code);
      valuation/research/foreign-exchange/commodities/portfolio wait for their first slices.
- [x] Define per-domain external reference corpora, metamorphic laws, numerical tolerances, and
      performance budgets. CLOSED 2026-08-19: the evidence-plan table above; deep performance work
      stays user-deferred.
- [x] Record every public default and every intentionally unsupported state before freezing fields. CLOSED 2026-08-19: the defaults/unsupported table above; the periodic-floor and bare-number retirements are already executable rejections.

### Evidence plan (FC0 deliverable — per-domain corpora, laws, tolerances, budgets)

| Domain                       | External reference corpus                                                                                                                                                                  | Metamorphic laws (beyond each FC's acceptance list)                                                                                                                                     | Numerical tolerance                                                    | Performance budget                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| FC1 cash flows               | Excel/NumPy-Financial worked cases (PV/FV/NPV/IRR/MIRR/amortization); documented timing/sign deviations tested explicitly                                                                  | PV·FV inversion under every `InterestCompounding` form; cash-flow scaling; schedule-regularity equivalence (periodic ⇄ dated)                                                           | identities 1e-12; vs external goldens 1e-9 (their published precision) | bundle budget per `budgets.ts` on first slice; scalar calls stay allocation-light (no per-call schedule materialization for plain PV/FV) |
| FC2 valuation/fundamentals   | Published DCF worked examples (textbook Damodaran-style cases recomputed by hand into committed fixtures); SEC filing-derived statement fixtures with real accession/availability metadata | statement articulation (balance sheet ties, cash-flow reconciliation); ratio scale-invariance under `monetaryScale`; point-in-time monotonicity (later `asOf` never sees fewer periods) | identities 1e-10; vs recomputed goldens 1e-8                           | statement/ratio calls linear in period count; bundle budgets on first slice                                                              |
| FC3 screening/factors/events | Classic style-factor sign conventions (value/momentum/quality direction fixtures); event-study abnormal-return worked example                                                              | screen/ranking permutation-invariance; factor winsorization idempotence; event windows never read post-availability data (point-in-time law)                                            | ranks exact; statistics 1e-10                                          | screening linear in universe size; no per-symbol revalidation inside ranking loops                                                       |
| FC4 performance              | GIPS-style TWR and Modified Dietz worked examples; MWR = `datedInternalRateOfReturn` parity                                                                                                | TWR flow-timing invariance under sub-period splits; contribution reconciliation sums to portfolio return; MWR/TWR agreement in the no-flow case                                         | identities 1e-12; vs worked examples 1e-10                             | flow-aware timelines linear in flow count                                                                                                |
| FC5 foreign exchange         | Covered-interest-parity fixtures across quote conventions; triangular-arbitrage closure cases                                                                                              | conversion round-trip identity; parity residual zero within tolerance under matching conventions; quote-direction inversion                                                             | identities 1e-12                                                       | conversion calls constant-time                                                                                                           |
| FC6 commodities              | Contango/backwardation term-structure fixtures; documented carry decompositions                                                                                                            | carry decomposition sums to the forward basis; roll-yield sign law under monotone curves                                                                                                | identities 1e-12                                                       | curve evaluation linear in pillar count                                                                                                  |

Budgets are enforced through the existing `tools/bundle-size/budgets.test.ts` ratchet and the Phase
3B benchmark law (committed benches, numbers quoted only from idle machines). Deeper performance
work (WASM/SIMD/batch acceleration) remains explicitly deferred by user decision and is NOT started
by any FC slice.

### Defaults and intentionally unsupported states (FC0 record, frozen before fields)

| Surface                               | Default (documented + echoed)                                                                                                      | Intentionally unsupported                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `InterestCompounding`                 | FC1 ordinary-annual facades default `'annual'`; date-based FC1 facades default `dayCount: 'act/365f'`; both echoed in `.explain()` | bare-number periodic form (retired — the object form names its meaning); periodic rates at or below −100% per period (no real growth factor) |
| Professional DCF / market instruments | none — the convention is REQUIRED explicitly                                                                                       | obtaining a discount rate from a default                                                                                                     |
| `TimedCashFlow`                       | single monetary unit per collection unless a professional input declares `currency`                                                | negative `timeYears` in ordinary discounting helpers (historical flows use dated forms with an explicit policy); inferred time-zero flows    |
| `FundamentalPeriod`                   | none — every field explicit                                                                                                        | eligibility by `periodEndDate` (availability controls); mutating restatements (a restatement is a NEW version with provenance)               |
| `RawFundamentalsRecord`               | open field bag at the data edge                                                                                                    | consumption by any compute function                                                                                                          |

### Exit gate

There is no unresolved package owner, duplicated convention grammar, generic financial field lookup,
or dependency direction that can force a later breaking redesign.

## FC1 — Elementary cash-flow and capital-budgeting mathematics

FC1 is implemented in `@totalfinance/valuation/cash-flows`; the curated valuation root exposes its
obvious first calls.

### Required public surface

The canonical names below are required capabilities, not permission to expose every name at the
package root.

#### Discounting and accumulation

- `presentValue`
- `futureValue`
- `discountCashFlows`
- `netPresentValue`
- `datedNetPresentValue`
- `effectiveAnnualRate`
- `nominalAnnualRate`
- `equivalentInterestRate`

`presentValue`/`futureValue` use named fields such as `futureAmount`, `presentAmount`,
`annualInterestRate`, `timeYears` or `numberOfPeriods`, and `compounding`. `netPresentValue` accepts
explicit timed flows;
`datedNetPresentValue` accepts dated flows plus `asOf` and day count. Both include a supplied time-zero
flow exactly once.

`datedNetPresentValue` and `datedInternalRateOfReturn` accept cash flows before and after `asOf`.
Future flows discount back and historical flows accumulate forward using the same declared
convention; neither function discards a realized flow merely because it precedes the valuation date.

#### Return solvers

- `internalRateOfReturn`
- `datedInternalRateOfReturn`
- `modifiedInternalRateOfReturn`

The direct facade returns `number | null`; `.explain()` reports convergence, bracket/search range,
iterations, every economically admissible root found, and an ambiguity warning when more than one
root exists. The plain call returns `null` for no root or multiple unresolved roots; it never chooses
one silently. Callers can select an explicit root from the report.

#### Annuities, loans, and schedules

- `annuityPayment`
- `loanInterestPayment`
- `loanPrincipalPayment`
- `loanNumberOfPeriods`
- `loanPeriodicInterestRate`
- `amortizationSchedule`
- `cumulativeLoanInterest`
- `cumulativeLoanPrincipal`

Required semantics:

- payment timing is explicit: beginning or end of period;
- balloon/residual value is explicit;
- irregular dated loans use a dated schedule rather than pretending periods are equal;
- schedule rows expose opening balance, payment, interest, principal, fees when supplied, and closing
  balance;
- final rounding policy is explicit and the unrounded schedule reconciles exactly within tolerance;
- returned payment components are SIGNED (2026-08-23 resolution): nonnegative rates yield positive
  magnitudes; a negative rate yields negative interest — credited to the borrower — with the
  identities holding signs intact, and any borrower/lender cash-flow view labels its perspective.

#### Capital budgeting and depreciation

- `paybackPeriod`
- `discountedPaybackPeriod`
- `profitabilityIndex`
- `equivalentAnnualAnnuity`
- `straightLineDepreciation`
- `decliningBalanceDepreciation`
- `doubleDecliningBalanceDepreciation`
- `sumOfYearsDigitsDepreciation`

Depreciation helpers require cost, salvage value, useful life, and period; they never infer tax rules.

### Acceptance laws

- [x] PV and FV invert under every supported compounding convention. CLOSED 2026-08-19 (`2d7126a69`): packages/valuation/test/cash-flows.test.ts, all seven forms at 1e-12.
- [x] NPV evaluated at each unambiguous IRR is zero within the declared tolerance. CLOSED 2026-08-19: same suite, 1e-9 at the solver tolerance.
- [x] Periodic and dated NPV/IRR agree on an exactly regular schedule under matching conventions. CLOSED 2026-08-19: regular-365-day schedule parity test.
- [x] Scaling every cash flow scales PV/NPV and leaves IRR unchanged. CLOSED 2026-08-19: scaling metamorphic test.
- [x] An amortization schedule's principal sums to original principal minus balloon; every row and
      final balance reconcile. CLOSED 2026-08-19: row-by-row reconciliation test, balloon included.
- [x] Zero-rate, one-period, immediate-flow, long-horizon, negative-rate where mathematically valid,
      and multiple-sign-change cases are covered. CLOSED 2026-08-19: the pump-project dual-root case answers null with both roots reported.
- [x] Independent golden values cover the standard Excel/NumPy-Financial cases while TotalFinance's
      intentionally clearer timing/sign differences are documented and tested. CLOSED 2026-08-19: IRR/PMT/EFFECT/MIRR/SLN/DDB/SYD goldens; the Excel-NPV timing difference is itself a test.
- [x] No root solver reports convergence merely because its loop ended. CLOSED 2026-08-19: scan-bisect reports per-root convergence; ambiguity and no-root answer null with reasons.

## FC2 — Corporate valuation and typed fundamental analysis

FC2 deliberately spans two packages. `@totalfinance/fundamentals` owns historical statement truth,
normalization, ratios, and scores. `@totalfinance/valuation` owns forecasts and valuation analyses and
depends on those typed contracts. Neither package fetches filings or market prices.

### Cost of capital and cash-flow primitives

Required direct operations:

- `capitalAssetPricingExpectedReturn`
- `costOfEquity`
- `afterTaxCostOfDebt`
- `weightedAverageCostOfCapital`
- `freeCashFlowToFirm`
- `freeCashFlowToEquity`
- `terminalValue`
- `enterpriseToEquityValue`

`weightedAverageCostOfCapital` requires explicit market-value capital components and component costs.
It reports normalized weights and refuses a zero/negative total capital base. Tax shields are
explicit. `terminalValue` requires a discriminated union:

The default named formulas are fixed:

- capital-asset-pricing expected return = annual risk-free rate + beta × annual market risk premium;
- after-tax cost of debt = annual pre-tax cost × (1 − marginal tax rate), with any unusable tax shield
  supplied as an explicit adjustment rather than inferred;
- weighted-average cost of capital uses market-value debt/equity/preferred weights and the supplied
  after-tax component costs;
- FCFF = operating income × (1 − tax rate) + depreciation/amortization − capital expenditure −
  increase in net working capital; and
- FCFE = net income + depreciation/amortization − capital expenditure − increase in net working
  capital + net borrowing.

Callers can supply already-derived cash flows, but a function never silently swaps net income for
operating income, total debt change for net borrowing, or cash for operating working capital.

```ts
type TerminalValueMethod =
  | {
      method: 'perpetual-growth';
      terminalCashFlow: number;
      perpetualGrowthRate: number;
    }
  | { method: 'exit-multiple'; terminalMetricAmount: number; exitMultiple: number };

interface TerminalValueInput {
  terminalValueMethod: TerminalValueMethod;
  annualDiscountRate: number;
}
```

Perpetual growth requires `annualDiscountRate > perpetualGrowthRate`; no clamp or guessed spread is
allowed. `discountedCashFlow` supplies its top-level `annualDiscountRate` to the same primitive, so a
caller never repeats the discount rate inside the terminal method.

### DCF analyses

Required analyses:

- `discountedCashFlow`
- `discountedCashFlowFromStatements`
- `reverseDiscountedCashFlow`
- `discountedCashFlowSensitivityTable`
- `discountedCashFlowScenarioAnalysis`
- `probabilisticDiscountedCashFlow`
- `dividendDiscountValuation`
- `residualIncomeValuation`
- `comparableCompanyValuation`
- `adjustedPresentValue`
- `leveragedBuyoutAnalysis`

`discountedCashFlow` accepts explicit dated or timed FCFF/FCFE projections, valuation date, currency,
discounting convention, and terminal method. It returns at least:

```ts
interface DiscountedCashFlowCommonResult {
  projectedCashFlows: Array<{
    cashFlowDate?: string;
    timeYears: number;
    cashFlowAmount: number;
    discountFactor: number;
    presentValue: number;
  }>;
  projectedCashFlowPresentValue: number;
  terminalValue: number;
  terminalValuePresentValue: number;
  assumptions: DiscountedCashFlowAssumptions;
  diagnostics: DiscountedCashFlowDiagnostics;
  provenance?: ValuationProvenance;
}

type DiscountedCashFlowResult = DiscountedCashFlowCommonResult &
  (
    | {
        valuationBasis: 'firm';
        enterpriseValue: number;
        enterpriseToEquityBridge?: EnterpriseToEquityBridge;
        equityValue?: number;
        valuePerShare?: number;
      }
    | {
        valuationBasis: 'equity';
        equityValue: number;
        valuePerShare?: number;
      }
  );

interface EnterpriseToEquityBridge {
  cashAndCashEquivalents: number;
  totalDebt: number;
  preferredEquity: number;
  minorityInterest: number;
  nonOperatingAssets: number;
}
```

- FCFF produces enterprise value. FCFE produces equity value. The result never relabels one as the
  other.
- Enterprise-to-equity fields are not silently zeroed. If the bridge is absent, equity value is
  absent; if shares are absent, per-share value is absent with a reason.
- `reverseDiscountedCashFlow` uses an explicit target variable discriminant such as terminal growth,
  revenue growth, margin, or discount rate. It reports bounds and convergence.
- Sensitivity tables identify row/column variables and units, retain the base case, and prove every
  cell equals a direct DCF call.
- `discountedCashFlowScenarioAnalysis` accepts named deterministic assumption sets and returns a
  reconciled base/bear/bull-or-caller-named comparison without inventing scenario values.
- `probabilisticDiscountedCashFlow` accepts explicit marginal distributions, dependence/correlation,
  sample count, and seed. It returns the valuation distribution, quantiles, tail diagnostics, and the
  exact seeded assumptions; it never turns an unlabeled base case into a stochastic forecast.
- Comparable valuation records metric definition, period, peer values, weighting/aggregation method,
  outlier policy, and enterprise/equity basis.
- `adjustedPresentValue` separates unlevered operating value, financing side effects, and their
  assumptions.
- `leveragedBuyoutAnalysis` accepts explicit sources/uses, debt tranches, rates, amortization/cash
  sweep policy, operating forecast, fees, taxes, holding period, and exit assumptions. It returns an
  annual debt/cash schedule, exit bridge, equity cash flows, multiple on invested capital, and IRR by
  investor perspective. It composes FC1 schedules/IRR and FC2 cash-flow primitives.

`DiscountedCashFlowAssumptions`, `DiscountedCashFlowDiagnostics`, and `ValuationProvenance` are closed,
versioned field contracts—not `Record<string, unknown>`. At minimum they disclose valuation date,
currency, valuation basis, compounding/day count, discount-rate source, terminal method, forecast
identity, statement/restatement identity, model version, warnings, convergence, exclusions, and all
bridge/share-count decisions.

### Forecasting compositions

Required compositions:

- `projectFinancialStatements` from typed historical statements plus explicit period-by-period or
  driver-based assumptions;
- `operatingForecast` for revenue, margins, taxes, working capital, capital expenditure,
  depreciation/amortization, and resulting FCFF/FCFE; and
- `discountedCashFlowFromStatements`, which composes those projections with the direct DCF analysis.

No forecast extrapolates historical growth, margins, capital intensity, or working capital by
default. Every driver is explicit, can vary by period, and is echoed. The projection reconciles the
three statements and identifies any balancing item; it never hides a plug inside cash or debt.

### Typed statements

Required structural contracts:

- `IncomeStatement`
- `BalanceSheet`
- `CashFlowStatement`
- `FinancialStatements`
- `FundamentalSnapshot`
- `FundamentalSeries`

The canonical fields cover at minimum revenue, cost of revenue, gross profit, operating expenses,
operating income, interest, taxes, net income, diluted shares, cash, receivables, inventory, current
and total assets/liabilities, debt, equity, operating/investing/financing cash flow, capital
expenditure, depreciation/amortization, stock compensation, acquisitions, dividends, and repurchases.
Every statement carries `FundamentalPeriod`. Optional source-specific metadata is preserved in an
open metadata field, not mixed into canonical numeric properties.

Required statement utilities:

- `trailingTwelveMonthStatements` with overlap/gap detection;
- `fundamentalGrowth` for period-over-period and compound annual growth;
- `commonSizeFinancialStatements`;
- `reconcileFinancialStatements` with accounting-identity diagnostics;
- `perShareFundamentals` with split-aware normalization; and
- `selectFundamentalSnapshot` using `availableTimestampMs` and an explicit restatement policy.

### Fundamental ratios and scores

Required direct operations:

- profitability: `grossMargin`, `operatingMargin`, `ebitdaMargin`, and `netProfitMargin`;
- returns: `returnOnAssets`, `returnOnEquity`, `returnOnInvestedCapital`, and
  `returnOnCapitalEmployed`;
- liquidity: `currentRatio`, `quickRatio`, and `cashRatio`;
- leverage/coverage: `debtToEquity`, `debtToAssets`, `netDebtToEbitda`, `interestCoverage`, and
  `debtServiceCoverage`;
- efficiency: `assetTurnover`, `inventoryTurnover`, `receivablesTurnover`, `payablesTurnover`,
  `daysInventoryOutstanding`, `daysSalesOutstanding`, `daysPayablesOutstanding`, and
  `cashConversionCycle`;
- quality: `accrualRatio`, `cashFlowToNetIncome`, and `cashReturnOnAssets`;
- per-share: `earningsPerShare`, `bookValuePerShare`, `revenuePerShare`, and
  `freeCashFlowPerShare`;
- valuation: `priceToEarnings`, `priceToBook`, `priceToSales`, `enterpriseValueToRevenue`,
  `enterpriseValueToEbitda`, `freeCashFlowYield`, `earningsYield`, and `dividendYield`;
- scores: `piotroskiFScore` for the standard nine signals, `altmanZScore` with the explicit required
  variant `public-manufacturing`, `private-manufacturing`, or `non-manufacturing`, and
  `beneishMScore` for the original eight-variable model with no silent five-variable fallback; and
- `analyzeFundamentals` as the one-call typed analysis that composes the selected direct ratios and
  scores and reports every missing/invalid denominator.

The default ratio bases are also fixed:

- margins divide the named income-statement amount by revenue; EBITDA is operating income plus
  depreciation/amortization under the canonical statement mapping;
- return on assets/equity uses average beginning/ending assets/equity; return on invested capital
  uses after-tax operating income over average interest-bearing debt + equity − cash and cash
  equivalents; return on capital employed uses operating income over average total assets − current
  liabilities;
- debt means interest-bearing debt, net debt subtracts cash and cash equivalents, and coverage uses
  the exact interest or debt-service denominator supplied;
- turnover ratios use the matching flow over the average balance; day metrics use the explicitly
  supplied period-day count, and cash-conversion cycle = days inventory outstanding + days sales
  outstanding − days payables outstanding;
- enterprise value = equity market value + total debt + preferred equity + minority interest − cash
  and cash equivalents − separately supplied non-operating assets;
- market multiples require a market observation whose timestamp is no earlier than the fundamental
  availability timestamp and obey an explicit freshness limit; and
- diluted per-share metrics require split-adjusted diluted shares for the same period.

Piotroski uses exactly nine binary signals: positive return on assets, positive operating cash flow,
improving return on assets, operating cash flow greater than net income, falling long-term-debt ratio,
improving current ratio, no net share issuance, improving gross margin, and improving asset turnover.
The score reports each signal—not only the total.

Altman variants use their published coefficients and denominator definitions:

- `public-manufacturing`: `1.2 X1 + 1.4 X2 + 3.3 X3 + 0.6 X4 + 1.0 X5`, with market equity in `X4`;
- `private-manufacturing`: `0.717 X1 + 0.847 X2 + 3.107 X3 + 0.420 X4 + 0.998 X5`, with book equity
  in `X4`; and
- `non-manufacturing`: `6.56 X1 + 3.26 X2 + 6.72 X3 + 1.05 X4`, with book equity and no sales/assets
  term.

For all three, `X1` is working capital/assets, `X2` retained earnings/assets, `X3` operating
income/assets, and `X4` the selected equity/liabilities basis; `X5` is sales/assets where present.
`beneishMScore` uses the original eight-variable 1999 equation
`-4.84 + 0.920 DSRI + 0.528 GMI + 0.404 AQI + 0.892 SGI + 0.115 DEPI - 0.172 SGAI + 4.679 TATA - 0.327 LVGI`
and returns all eight component indices, their expanded names, and period identities alongside the
score. The component definitions are fixed to the paper: days-sales-in-receivables index = current
receivables/sales divided by prior receivables/sales; gross-margin index = prior gross margin divided
by current gross margin; asset-quality index = the current non-current/non-property-plant-equipment
asset share divided by its prior share; sales-growth index = current/prior sales; depreciation index
= prior depreciation rate divided by current depreciation rate, where each rate is depreciation over
depreciation plus property, plant, and equipment; selling/general/administrative-expense index =
current expense/sales divided by prior expense/sales; leverage index = current debt/assets divided by prior
debt/assets; and total accruals to total assets = income from continuing operations minus operating
cash flow, divided by total assets.

Ratios use average balance-sheet denominators where financially appropriate, name the period and
basis, and return `null` with a reason for a zero/invalid denominator. Decimal ratios are never
silently converted to displayed percentages.

### Acceptance laws

- [x] FCFF/FCFE identities reconcile from independently supplied statement components. CLOSED 2026-08-19: packages/valuation/test/corporate.test.ts (FCFE = FCFF − interest × (1 − t) + net borrowing).
- [x] WACC component weights sum to one and scale invariance holds. CLOSED 2026-08-19: normalized-weight and ×1,000 scale tests; zero base refused.
- [x] DCF enterprise/equity bridges reconcile exactly. CLOSED 2026-08-19: five-component bridge test; no bridge → equity value absent WITH reason.
- [x] Perpetual-growth and exit-multiple terminal values recover direct primitives. CLOSED 2026-08-19: both recovered at 1e-10; growth ≥ rate refused.
- [x] Statement-driven forecasts reconcile all three statements and reproduce a direct DCF from the
      emitted cash flows. CLOSED 2026-08-19: the identity ties by construction (algebra in forecasting.ts) and the composed valuation equals the direct call at 1e-12 (forecasting.test.ts).
- [x] Every deterministic scenario cell equals a direct DCF call; probabilistic runs reproduce
      exactly for the same seed and collapse to the deterministic result for degenerate inputs. CLOSED 2026-08-19: cell-by-cell equality, deep-equal seed reproduction, degenerate collapse at 1e-9.
- [x] Adjusted present value reconciles unlevered value plus financing effects; leveraged-buyout
      sources equal uses, every debt schedule closes, and exit proceeds reconcile to equity MOIC/IRR. CLOSED 2026-08-19: corporate-analyses.test.ts — year-1 walked by hand, every tranche closes, (1+IRR)³ identity at 1e-9.
- [x] DCF value is monotone under controlled discount-rate/growth changes where the economics require
      it; invalid monotonicity domains are not asserted. CLOSED 2026-08-19: decreasing in rate, increasing in growth inside the valid domain only.
- [x] Common-size, TTM, growth, ratio, and score results have independent golden fixtures. CLOSED 2026-08-19: the three-year hand-computed fixture (identities tie exactly); 39 ratio goldens, Piotroski 9/9 + flip, all three Altman variants, the full Beneish equation.
- [x] Point-in-time tests prove a filing/restatement is unavailable before
      `availableTimestampMs`. CLOSED 2026-08-19: statements.test.ts — availability-not-period-end, monotonicity, and both restatement policies before/after the restatement instant.
- [x] Every ratio formula, numerator, denominator, period, unit, and nullability appears in generated
      reference documentation and the field contract inventory. CLOSED 2026-08-19: every head's .explain carries formula/numerator/denominator/period in the ONE Computed envelope; the api reports and field inventory regenerate from the declarations.

## FC3 — Screening, style factors, and event studies

### Screening

Required operations:

- `screenUniverse`
- `rankUniverse`
- `scoreUniverse`
- a direct callback escape hatch with an explicit non-serializable classification

The serializable filter grammar is a closed recursive union over declared fields and operators. It
supports logical groups, comparisons, ranges, membership, presence, and string identity where
appropriate. It does not parse arbitrary source text.

Every screen declares:

- input universe identity and `asOf`;
- field definitions and units;
- missing-value policy (`exclude` is the safe default; no financial-value imputation by default);
- stable tie policy and secondary ordering;
- sort direction and limit;
- point-in-time eligibility;
- included/excluded counts and exclusion reasons.

Technical, fundamental, valuation, liquidity, options, and caller-defined fields are all ordinary
features. The engine does not fetch or calculate hidden fields.

### Cross-sectional factors

Required primitives and analyses:

- winsorization with explicit method/cutoffs;
- percentile rank and z-score standardization;
- missing-value and minimum-coverage policy;
- sector/industry and continuous-exposure neutralization;
- weighted composite scoring;
- quantile portfolio formation;
- information coefficient and rank information coefficient;
- factor spread return, turnover, decay, breadth, and coverage diagnostics;
- factor exposure and return attribution composition with `@totalfinance/risk`.

Required named recipe families:

- value;
- size;
- momentum;
- quality/profitability;
- low volatility;
- liquidity;
- investment/growth.

A recipe is a versioned artifact that discloses its features, transforms, direction, lag,
neutralization, weights, and missing-value policy. TotalFinance may provide canonical recipes, but it
must not imply that one definition is universal truth. Raw transforms remain available.

### Event studies

Required contracts and operations:

```ts
interface MarketEvent {
  eventId: string;
  instrumentId: string;
  eventType: string;
  announcedTimestampMs: EpochMs;
  effectiveTimestampMs?: EpochMs;
  metadata?: Record<string, unknown>;
}
```

- `eventStudy`
- `aggregateEventStudies`
- event-window alignment helpers

Required expected-return models:

- mean-adjusted;
- market-adjusted;
- market model estimated over an explicit pre-event window;
- caller-supplied factor model through a structural interface.

Required outputs:

- aligned raw and expected returns;
- abnormal return by event-relative period;
- cumulative abnormal return per event;
- average abnormal return and cumulative average abnormal return across events;
- confidence intervals/test statistics with method and sample size;
- coverage, missing sessions, overlapping events, excluded events, and diagnostics.

Announcement time versus effective time is explicit. A date-only event resolves through a declared
session policy. Estimation windows end before event windows, and tests mechanically reject overlap
unless the caller explicitly selects a supported contaminated-window policy.

### Acceptance laws

- [x] Screening is deterministic under input permutation once the explicit stable secondary key is
      applied. CLOSED 2026-08-19: instrumentId-ascending is ALWAYS the final key; permutation test in packages/research/test/screening.test.ts.
- [x] Unknown fields/operators and unit-incompatible comparisons are teaching errors. CLOSED 2026-08-19: undeclared field, out-of-grammar operator, and category-ordered-numerically all teach.
- [x] Neutralized factor residuals are orthogonal to controlled exposures within tolerance. CLOSED 2026-08-19: normal-equations projection; residual ⊥ exposure at 1e-8 and mean-zero at 1e-10.
- [x] Quantile portfolios contain no duplicate names and account for every eligible observation. CLOSED 2026-08-19: exact-partition test; sizing convention disclosed.
- [x] Factor return, turnover, and IC calculations match independent fixtures. CLOSED 2026-08-19: hand Pearson/Spearman 0.8 fixture, spread/turnover/decay goldens.
- [x] Cumulative abnormal return equals the sum/compound convention declared by the event-study
      model; aggregate results reconcile to event rows. CLOSED 2026-08-19: both conventions hand-derived in packages/research/test/events.test.ts; aggregation recomputes from pooled rows.
- [x] Shifting `availableTimestampMs` or `announcedTimestampMs` past the observation instant removes
      the information from a point-in-time screen/backtest. CLOSED 2026-08-19: screening availability-gates rows; the event anchor moves with the announcement instant (tested in both modules).
- [x] The words `priceBackedEvent` and `price-backed event` never become public identities. CLOSED 2026-08-19: no such identity exists; the naming baseline would flag it on arrival.

## FC4 — Cash-flow-aware performance

Extend `@totalfinance/performance` with:

- `timeWeightedReturn`;
- `moneyWeightedReturn`;
- `modifiedDietzReturn`;
- subperiod linking;
- external-flow segmentation;
- portfolio total-return/NAV index construction;
- benchmark-relative timeline comparison;
- contribution by position/account/strategy/underlying/asset class/currency/tag when supplied by a
  portfolio timeline.

Required semantics:

- external deposits, withdrawals, and transfers are not investment P&L;
- flow timing is explicit and matches the selected method;
- TWR links subperiod returns around external flows;
- MWR composes the FC1 dated IRR solver and preserves its root/convergence diagnostics;
- Modified Dietz exposes the flow weights it used;
- missing marks produce gaps/diagnostics rather than silent forward fill;
- benchmark returns state total-return versus price-return basis;
- annualization is explicit and never inferred from timestamps without a declared policy.

### Acceptance laws

- [x] TWR is invariant to a pure external contribution immediately valued at the same NAV. CLOSED 2026-08-19: `flow-aware.test.ts` LAW (a) — the flow-free and contribution timelines link to the same return at 1e-12 (and again at index scope in `portfolioReturnIndex`).
- [x] MWR equals dated IRR on the identical cash-flow schedule. CLOSED 2026-08-19: LAW (b) — `moneyWeightedReturn` matches a hand-built `datedInternalRateOfReturn.explain` call on the same schedule at 1e-12, and the solver report rides along whole.
- [x] With no external flows, TWR, MWR, and linked simple return agree in controlled fixtures. CLOSED 2026-08-19: LAW (c) — a one-ACT/365F-year no-flow fixture makes all three coincide at 1e-10.
- [x] Transfers between accounts inside one portfolio net to zero external flow. CLOSED 2026-08-19: LAW (d) — `segmentExternalFlows` pairs opposite-signed same-day legs across accounts before any filter; a transfer-only ledger reports exactly zero external flow.
- [x] Portfolio/group contributions reconcile to total return within disclosed linking residuals. CLOSED 2026-08-19: LAW (e) — `contributionByGroup` discloses `reconciliationResidual`, 0 within 1e-12 at single-period scope.

## FC5 — Foreign-exchange foundations

### Required surface

- explicit currency-pair construction and quote direction;
- `crossRate`;
- `convertCurrency`;
- `coveredInterestParityForward`;
- `foreignExchangeForwardPoints`;
- `foreignExchangeForwardValue`;
- `foreignExchangeSwapValue`;
- `nonDeliverableForwardValue`;
- `pipValue`;
- spot/forward/hedged foreign-exchange P&L;
- currency exposure and hedge-ratio helpers.

Required semantics:

- a pair always identifies base and quote currency; spot is quote currency per one base currency;
- inversion and triangular conversion are explicit and tested;
- pip/tick size is supplied or comes from declared instrument metadata, never guessed from symbol
  spelling;
- forward calculations accept explicit domestic/foreign rates or discount factors with matched dates
  and conventions;
- settlement currency, fixing date, settlement date, notional currency, and NDF fixing source are
  explicit where relevant;
- existing fixed-income cross-currency basis and options FX-smile code are reused or adapted, not
  copied.

### Acceptance laws

- [x] Pair inversion and triangular cross-rate identities hold. CLOSED 2026-08-19: `foreign-exchange.test.ts` — double inversion is the identity at 1e-12; EURUSD × USDJPY = EURJPY with one-hop = two-hop conversion, including a reversed-orientation leg.
- [x] Covered-interest-parity spot/forward round trips hold under rates and discount factors. CLOSED 2026-08-19: continuous closed form exact at 1e-12; the invest-abroad-vs-invest-at-home no-arbitrage fixture closes; the fixed-income curve bridge proves the discount-factor form (below).
- [x] Long/short and base/quote P&L sign laws hold. CLOSED 2026-08-19: buyer/seller perspectives negate each other on forwards, swaps, and NDFs; signed notionals are rejected (direction lives in `perspective`); the hedged-P&L decomposition flips every sign with the notional.
- [x] Forward value is zero at its contracted fair forward under unchanged inputs. CLOSED 2026-08-19: `foreignExchangeForwardValue` returns exactly 0 when `currentForwardRate` equals `contractRate`, tested for both perspectives.
- [x] Cross-package FX option/cross-currency conventions have parity fixtures with the new package. CLOSED 2026-08-19: `docs/examples/foreign-exchange-parity-bridge.test.ts` — fixed-income's no-basis `crossCurrencyBasisCurve.fxForward`, `coveredInterestParityForward`, and Garman-Kohlhagen put-call parity (Black-Scholes with the foreign rate as carry) all state the SAME forward at 1e-12, and the synthetic option forward equals `foreignExchangeForwardValue`.

## FC6 — Commodity carry and term structure

### Required surface

- `commodityForwardPrice`;
- `commodityForwardValue`;
- `commodityCarry`;
- `impliedConvenienceYield`;
- `impliedStorageCost` when the remaining inputs identify it uniquely;
- `rollYield`;
- calendar-spread and curve-spread analytics;
- term-structure state (`contango`, `backwardation`, `flat`, `indeterminate`);
- futures hedge-ratio and basis helpers;
- seasonality profile as a research analysis over caller-supplied history.

Required semantics:

- financing, income/lease rate, storage cost, convenience yield, expiry, and compounding are explicit;
- functions distinguish a quoted futures price, theoretical forward, and current contract value;
- roll return separates spot move, carry/curve move, and contract-roll effect when data supports it;
- commodity identity may preserve grade/location/unit metadata, but the generic engine does not invent
  conversion factors or physical-delivery rules;
- options on commodity futures compose existing option/futures primitives rather than adding a
  separate Black implementation.

### Acceptance laws

- [x] Cost-of-carry parity and inverse implied-input recovery hold. CLOSED 2026-08-19: the frozen first-touch call is bit-exact against `spot × e^((f + s − c) × t)`; `impliedConvenienceYield` and `impliedStorageCost` each recover the component that priced the forward at 1e-12, under continuous AND annual compounding; `commodityCarry` reports residual 0 for a parity-priced forward and warns on a mispriced one.
- [x] Scale/unit transformations preserve economics when an explicit conversion is supplied. CLOSED 2026-08-19: doubling spot doubles the forward exactly; `convertCommodityQuantity` with an explicit factor keeps price-per-unit × quantity invariant (barrels→gallons worked example), and an identity conversion with factor ≠ 1 is refused as a contradiction.
- [x] Contango/backwardation classification is stable under tolerance and reports indeterminate for
      insufficient/contradictory curves. CLOSED 2026-08-19: monotone curves classify, a within-tolerance wiggle is flat, the SAME
      wiggly curve flips flat → indeterminate as the tolerance tightens, and a rising/flat mix is
      indeterminate with the mixed segments named in the diagnostics.
- [x] Roll decomposition reconciles to observed total return within the declared residual. CLOSED 2026-08-19: the declared MULTIPLICATIVE convention `(1 + total) = (1 + spotMove) × (1 + carryConvergence)` is an algebraic identity, tested at the declared 1e-12 residual with the algebra hand-written; the roll leg is stated separately as cash-neutral at execution.

## FC7 — Durable portfolio management completion

The ledger, event grammar, package boundary, API ladder, policy, rebalance, monitoring, P&L,
reconciliation, and safety decisions in
[`../agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
are incorporated by reference and become implementation requirements at Stage 4.4. This section adds
the previously implicit finance-completeness requirements below.

### Required direct and artifact APIs

- `applyPortfolioEvents` — direct pure reducer;
- `createPortfolioLedger` — immutable reusable artifact;
- `portfolioSnapshot` — explicit market/as-of valuation;
- `portfolioTimeline` — NAV, cash, flows, exposure, and P&L through time;
- `portfolioPnl` — reconciled P&L decomposition;
- `reconcilePortfolio` — comparison with an external normalized snapshot;
- `createModelPortfolio` — immutable strategic/tactical target artifact;
- `allocatePortfolio` — target weights to executable quantities/cash residuals;
- `proposePortfolioRebalance` — pure proposal, never execution;
- `monitorPortfolio` — pure state transition returning typed alerts/evidence;
- versioned serialization, migration, replay, hashes, and conformance fixtures.

`analyzeBook`, direct risk functions, optimizers, and performance calls remain available without a
ledger.

### Mandatory economic state

- multiple portfolios/accounts and stable account/portfolio/instrument/lot/event identity;
- cash by currency split into settled, unsettled, receivable, payable, and restricted/collateral
  amounts where supplied;
- positions, long/short/fractional lots, cost basis, and configurable lot relief;
- trade date and settlement date;
- commissions, exchange/regulatory fees, slippage adjustments, borrow, margin interest, dividends,
  coupons, staking, crypto funding, and other income/financing as separate components;
- futures variation margin and contract rolls;
- fixed-income accrued interest, coupon, call, maturity, and principal events;
- option exercise, assignment, expiration, physical/cash settlement, and multiplier changes;
- split, merger, spin-off, symbol change, return of capital, and cash-in-lieu transformations;
- FX conversion and explicit base-currency marks;
- contribution, withdrawal, and internal transfer identity;
- correction/reversal links and reconciliation status.

The open core preserves tax-lot facts but does not claim jurisdiction-specific wash-sale, tax
liability, suitability, best-execution, or regulatory truth.

### Risk-side portfolio construction

Keep the existing `meanReturns`, covariance estimators, `minVariance`, `maxSharpe`, `meanVariance`,
`riskParity`, `hrp`, `kelly`, `blackLitterman`, and `conditionalValueAtRiskOptimize` calls in
`@totalfinance/risk`. Do not copy them into `@totalfinance/portfolio`.

Extend `@totalfinance/risk` with:

- `estimateExpectedReturns` using an explicit method of historical mean, exponentially weighted,
  capital-asset-pricing model, or caller-supplied values, with annualization and point-in-time inputs;
  the capital-asset-pricing method composes FC2's direct primitive; and
- `efficientFrontier` over the supported objectives and existing constraint grammar, returning every
  solved/failed point plus convergence and feasibility diagnostics.

### Portfolio-side management

Build the practical state/quantity path in `@totalfinance/portfolio` with:

- model portfolios and hierarchical sleeves with versioned targets;
- strategic versus tactical targets and effective dates;
- discrete weight-to-quantity allocation with prices, lot sizes, minimum notionals, cash reserve,
  transaction costs, and dust reporting;
- contribution-aware and withdrawal-aware rebalancing;
- target drift, turnover, liquidity, concentration, factor/risk, leverage, margin, drawdown, and cash
  constraints;
- benchmark history and membership identity;
- optional liability/cash-flow schedules, horizon, and glide-path targets;
- projected cash availability for settlement, coupons/dividends, option lifecycle, margin, and planned
  withdrawals.

Optimization never silently relaxes hard constraints. Infeasibility, non-convergence, skipped dust,
rounding, residual cash, and unavailable tax policy are explicit.

### FC7 slice ledger (Platform Stage 4.4a; complete)

| Slice | Contents                                                                                                                                                                                                                                                   | State                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | `@totalfinance/portfolio` foundation: event grammar, `applyPortfolioEvents`, `createPortfolioLedger` + spine serialization/migration/replay, `portfolioSnapshot`, `portfolioPerformanceInputs` (FC4 seam); [`fc7-first-slice.md`](./fc7-first-slice.md)    | `COMPLETE @ a212404d9` (reviewed 2026-08-28)                                                             |
| 2     | `portfolioTimeline`, `portfolioPnl` (reconciled decomposition incl. FX P&L and the residual identity), grouping by position/strategy/underlying/account/asset class/currency/tag                                                                           | `COMPLETE @ a02ed424b` (reviewed 2026-08-28)                                                             |
| 3     | `reconcilePortfolio` + `./reconciliation`; corrections/reversals (`reversesEventId` repair flow); see [`fc7-first-slice.md`](./fc7-first-slice.md) "Slice 3"                                                                                               | `COMPLETE @ a6914ff7d` (reviewed 2026-08-28)                                                             |
| 4     | `createModelPortfolio`, `allocatePortfolio`, `proposePortfolioRebalance`, `monitorPortfolio`, `./policy`; risk-side `estimateExpectedReturns` / `efficientFrontier` in `@totalfinance/risk`                                                                | `COMPLETE @ b83ecc89a` (reviewed 2026-08-29); see [`fc7-first-slice.md`](./fc7-first-slice.md) "Slice 4" |
| 5     | Lifecycle families: derivative exercise/assignment/expiration and settlement, futures variation margin and rolls, fixed-income accrual/coupon/call/maturity, crypto funding, corporate actions beyond splits, cash-in-lieu; packed browser/worker fixtures | `COMPLETE @ a6f9842b` (reviewed 2026-08-29); see [`fc7-first-slice.md`](./fc7-first-slice.md) "Slice 5"  |

### Portfolio exit gate

- [x] Replay is deterministic, idempotent for duplicate event IDs, and conflict-detecting for changed
      payloads. CLOSED 2026-08-28 (slice 1): fold purity + create → serialize → read → re-fold
      deep-equal with identical content hash; duplicate `(sourceId, eventId)` is a no-op; a changed
      body is the typed `portfolio.duplicate_event_conflict`.
- [x] Every golden journey reconciles cash, quantities, lots, cost basis, NAV, and P&L at each event.
      CLOSED 2026-08-28 for the implemented families (slices 1–2): cash, quantities, lots, cost
      basis, realized P&L, and NAV reconcile at each step (1e-9/1e-12), and `portfolioPnl` holds
      the full identity (realized + unrealized + income − costs − financing + FX + residual) at
      each mark of a multi-currency journey with residual 0 to 1e-9. Slice 5 re-ran the law over
      the lifecycle families: multiplier and variation-margin valuation, NAV conservation across a
      settlement, and exposure on notional (102,400 NAV against 453,400 long exposure).
- [x] Trade/settlement, option assignment, futures variation margin, fixed-income accrual, crypto
      funding, FX conversion, corporate action, correction, and multi-account transfer journeys pass.
      CLOSED 2026-08-29 (slice 5): option exercise/assignment/expiration in every settlement and
      premium convention, a futures variation-margin sequence (+2,000 / −3,000 / +1,000 closing to 0) with NAV conserved across a settlement, a roll, a multiplier/strike adjustment preserving
      total basis, a BTC perpetual with funding paid and received, accrued interest on a bond fill
      recovered by its coupon, maturity/paydown redemptions, symbol change, stock/cash/mixed
      mergers, a spin-off with explicit basis allocation, return of capital, cash-in-lieu, and lot
      transfers between accounts — every journey hand-computed; slices 1 and 3 closed the
      trade/settlement, FX, split, transfer, and correction journeys.
- [x] TWR/MWR consume the exact ledger flows and marks and match FC4 direct calls. CLOSED
      2026-08-28 (slice 1): `portfolioPerformanceInputs` emits FC4's literal series types and the
      ledger-derived `timeWeightedReturn`/`moneyWeightedReturn` results deep-equal the direct FC4
      calls on hand-built series (the FC8 hook, closed early).
- [x] Snapshot/group totals reconcile by position, strategy, underlying, account, asset class,
      currency, and tag. CLOSED 2026-08-28 (slice 2): `portfolioPnl` groupings and
      `portfolioTimeline` exposure groupings partition to the total with an explicit unattributed
      row (residual 0 within 1e-9, tested per dimension); tag overlap is disclosed as
      `reconciles: false` by design.
- [x] Rebalance proposals satisfy or explicitly fail every policy constraint and never mutate or
      execute. CLOSED 2026-08-29 (slice 4): `proposePortfolioRebalance` returns a frozen plan and a
      content-addressed `TradePlanArtifact` with no execution capability; the turnover cap and cash
      floor trim the plan as reported `capped` goals, every hard limit is evaluated on the post-trade
      book and a breach is a `violated` row with `feasible: false` (trades still listed, nothing
      relaxed), unresolved goals are explicit rows, and lot previews match the reducer's relief.
- [x] Serialization/migration/replay works through packed browser, Node, worker, and local-store
      fixtures without a database dependency. CLOSED 2026-08-29 (slice 5): `tools/packed-consumer.test.ts`
      folds one journey against the PACKED package in a `worker_threads` Worker (envelope posted
      across the thread), an esbuild browser bundle executed in `node:vm` with only web globals
      (no `process`/`require`/`Buffer`, proven inside the bundle), and a `Map`-backed
      `getItem`/`setItem` store (store → restore → apply → store → restore equals a single-pass
      fold; a newer `schemaVersion` refuses with `snapshot.unsupported_version`); all three report
      the same content hash. Slice 1 closed the Node/vitest round trip and the registered-migration
      law.
- [x] `analyzeBook` and other one-off functions remain independently callable and documented.
      CLOSED 2026-08-28 (slice 1): `@totalfinance/risk` is untouched and `@totalfinance/portfolio` never
      imports it — the FC0 graph law forbids the edge in both directions and re-ran green.

## FC8 — Portfolio-scale and cross-asset backtesting

Preserve the shipped engines. Add focused capabilities that reuse FC3, FC4, and FC7 rather than
growing another private accounting system.

The canonical entry points are:

- existing `vectorized` for the lightweight single-series path;
- existing `eventDriven` for the current order/fill path;
- existing `optionsBacktest`, refined into the one preferred portfolio-grade contract below;
- new `crossSectionalBacktest` for point-in-time universe/ranking/factor strategies; and
- new `portfolioBacktest` for ledger-backed multi-asset simulation.

They are functions over named request objects, not subclasses of one universal engine. Shared
execution/accounting models are small structural inputs and can be replaced independently.

### Cross-sectional and multi-asset vectorized research

Required `@totalfinance/backtest/cross-sectional` capabilities:

- point-in-time universe membership, additions, removals, and delisting returns;
- per-date feature eligibility using `availableTimestampMs`;
- screening/ranking/factor recipes from FC3;
- long-only, long/short, quantile, market-neutral, sector-neutral, beta-neutral, and factor-neutral
  target formation;
- equal, score, volatility, risk-budget, and optimizer-supplied weights;
- scheduled/event-driven rebalance with buffer bands;
- turnover/cost/liquidity/minimum-position constraints;
- benchmark and constituent history;
- attribution and factor diagnostics;
- parameter grid/batch execution without changing single-run semantics.

The common one-line path remains declarative. Callbacks remain a direct TypeScript escape hatch, and
a serializable recipe path supports workers, artifacts, MCP, and other languages.

### Portfolio-grade options backtesting

The initial engine's deferred items become required. The first item closes the pre-preview
truthfulness gate; the remaining portfolio-scale capabilities close with FC8:

- current-snapshot per-contract implied-volatility re-marking and live vega P&L;
- multiple simultaneous and overlapping positions;
- portfolio-level cash, margin, Greeks, concentration, and scenario limits;
- calendars, diagonals, and multi-expiry lifecycle as first-class declarative entries;
- combo-order versus legged-fill policy with partial-fill/rejection behavior;
- intraday chain support and explicit quote freshness;
- adjusted contracts and corporate-action lineage;
- assignment/exercise/dividend-risk evidence;
- volatility-surface evolution and mark-source provenance;
- provider-fed chains later through unchanged normalized iterable/stream contracts.

### Shared ledger/accounting

- The simulator emits the same normalized portfolio economic events FC7 reduces.
- Historical, replay, paper, and live adapters share fill/order/event types.
- Contributions, withdrawals, settlement, multi-currency cash, fees, income, borrow, funding,
  variation margin, exercise/assignment, and corporate actions use portfolio semantics.
- Backtest results carry a portfolio timeline and reconcile final value to ledger state.
- Existing lightweight results may expose a compact view, but the canonical artifact retains the
  full audit trail.

### Pluggable execution reality

Required models/contracts:

- fill policy by market, limit, stop, stop-limit, market-on-open, market-on-close, and combo order;
- explicit bid/ask quote, trade, OHLC bar, and optional order-book observations;
- optimistic, pessimistic, deterministic path, or reject policy for ambiguous intrabar order;
- fee, spread, slippage, market-impact, latency, participation, and borrow models;
- stale/locked/crossed market behavior;
- auction/session/holiday, halt, and price-limit state;
- partial fill, queue/depth approximation, cancel/replace, rejection, and expiration;
- buying-power, initial/maintenance margin, settlement, and forced-policy-liquidation hooks;
- caller-supplied custom models through small structural interfaces and conformance suites.

No default claims exchange realism. A simplified default is allowed only when assumptions name it.

### Cross-asset lifecycle

The ledger-backed simulator supports, through instrument adapters and explicit market data:

- equities and ETFs;
- listed options and multi-leg strategies;
- futures, expiry/roll, multipliers, and variation margin;
- FX spot/forward cash flows;
- crypto spot/perpetual funding and liquidation policy;
- fixed-income accrued interest, coupons, calls, and maturities;
- custom instruments through the structural extension contract.

### Reproducible research artifacts

Every canonical run records:

- strategy/recipe and source version;
- exact input dataset, universe, revision, coverage, and point-in-time policy;
- market/calendar/convention versions;
- engine and every execution/accounting model;
- seed, parameters, costs, benchmark, and annualization;
- orders, fills, rejections, portfolio events, marks, trades, settlements, and diagnostics;
- parent sweep/research protocol and child-run hashes;
- serializable result/replay identity and comparison metrics;
- cancellation/checkpoint state for bounded worker/job execution.

### Backtesting exit gate

Closed with Stage 4.6 @ `839a955e7` (2026-09-04): each row below is ticked in the contract,
[`portfolio-scale-backtesting.md`](./portfolio-scale-backtesting.md) § Acceptance and exit gate, with the
test that closes it and the commit it closed at; the one open row is held by the maintainer's deferral.

- [x] No-look-ahead tests cover signals, point-in-time fundamentals, universe membership,
      normalization, event timestamps, current-chain marks, and revised data.
- [x] A single event stream reduces to identical portfolio state in historical simulation and direct
      FC7 replay.
- [x] Multi-asset results are invariant to same-timestamp input ordering where policy says order is
      irrelevant.
- [x] Portfolio-grade options tests prove current-implied-volatility vega P&L, overlapping
      positions, multi-expiry lifecycle, combo/legged fills, and portfolio margin/risk.
- [x] Cross-asset golden journeys cover each supported lifecycle and reconcile P&L.
- [x] Fill models prove stale data, gaps, ambiguous bars, partial fills, cancellation, rejection,
      corporate actions, and session boundaries.
- [x] Point-in-time delisting/restatement fixtures prevent survivorship and revision leakage.
- [x] Walk-forward, purged/embargoed CV, PBO, deflated Sharpe, multiple-testing correction, and
      parameter comparisons compose into one research artifact without duplicated math.
- [x] Existing `vectorized`, `eventDriven`, and `optionsBacktest` packed examples remain green.
- [ ] Performance budgets separate small direct runs, broad vectorized grids, event simulation, and
      worker/Arrow paths; acceleration ships only after measurement and parity.
      OPEN by the maintainer's standing deferral of acceleration work (TotalFinance §1.4); bundle budgets
      are measured at every commit.

## FC9 — Integration, discovery, evidence, and final core freeze

### Umbrella and documentation

- [x] Add symmetric `fundamentals`, `valuation`, `research`, `foreignExchange`, `commodities`, and
      `portfolio` namespaces to the umbrella without wildcard root hoists. CLOSED 2026-09-04 (`530eb6de8`): tools/preview-surface-audit.test.ts "FC9 row 1 — discovery" (every domain a namespace and a subpath, no wildcard hoist).
- [x] Provide one executable cold-user journey per package and one end-to-end journey across
      fundamentals → valuation → screen/factor → portfolio → backtest → performance. CLOSED 2026-09-04 (`00980d725`): tools/packed-consumer.test.ts runs every package README as published; docs/examples/end-to-end-journey.test.ts runs the six-step journey reconciled at every step.
- [x] Generate API reports, package READMEs, formula references, field/unit tables, `llms.txt`, and
      manifest discovery from source-controlled declarations. CLOSED 2026-09-04 (`00980d725`): tools/fields-doc.ts + tools/fields-doc.test.ts join the API reports, READMEs, llms.txt, and manifest generators; formula references are the authored docs/formulas/\*.
- [x] Document raw, facade, analysis, artifact, batch, and workflow levels; no guide presents the
      highest abstraction as the only route. CLOSED 2026-09-04 (`00980d725`): docs/guides/levels.md, executed by docs/examples/guides.test.ts.

### Preview baseline and final workflow readiness

- [x] Stage 7A establishes a protocol-neutral registry, curated local MCP, machine-first CLI, and
      generated OpenAPI before preview; it never creates one tool per formula or duplicates compute
      (`@totalfinance/workflows`, `@totalfinance/cli`, `@totalfinance/http`, the MCP adapter — closed at `c7bdb260d`).
- [x] Add workflow operations only after that registry exists: company valuation,
      universe research, event study, portfolio analysis/rebalance proposal, and backtest run. CLOSED 2026-09-04 (`c4aa2b2cd`): totalfinance.valuation.company and totalfinance.portfolio.rebalance_proposal (Stage 4.7 slice 2) beside the Stage 7A research/portfolio and Stage 4.6 backtest operations.
- [x] Every operation uses the same public SDK schema/result and carries effect classification,
      budgets, seed policy, handles, assumptions, diagnostics, provenance, and artifact identity. CLOSED 2026-09-04 (`530eb6de8`): packages/workflows/test/registry.test.ts, runtime.test.ts, journey.test.ts (the Stage 7A operation contract) over all 39 operations.
- [x] Read-only defaults exclude portfolio writes and all broker orders. CLOSED 2026-09-04 (`530eb6de8`): every operation is sideEffect 'none' (registry.test.ts, journey.test.ts); the portfolio journey pack and the rebalance proposal are opt-in and return proposals, never orders.
- [x] SDK/MCP/CLI/OpenAPI parity fixtures compare normalized outputs and teaching errors. CLOSED 2026-09-04 (`530eb6de8`): tools/transport-parity.test.ts — one valid and one malformed fixture per operation, the registry, CLI, HTTP, and MCP results and refusals compared.
- [x] Every Stage 4.6 flagship operation joins those transports through a separate adapter/parity
      slice as it lands (`cross_sectional_run` @ `f38f7da24`, the extended `options_run` @ `9948cc3e2`,
      `portfolio_run` @ `839a955e7`), and Stage 4.7 reruns the complete expanded-surface matrix.

### Numerical and semantic evidence

- [x] Independent golden corpora cover FC1–FC6; literature/source citations and formula variants are
      versioned. CLOSED 2026-09-04 (`926404166`): tools/evidence-matrix.test.ts names the corpus and its citation per domain.
- [x] Property/metamorphic suites cover identities listed in every workstream. CLOSED 2026-09-04 (`926404166`): tools/evidence-matrix.test.ts, one named suite per workstream FC1–FC8.
- [x] Differential tests compare direct primitives with composed analyses and workflows. CLOSED 2026-09-04 (`926404166`): tools/evidence-matrix.test.ts, seven named composition-versus-primitive tests.
- [x] Mutation tests target signs, units, dates, cash-flow timing, root selection, terminal basis,
      statement periods, point-in-time availability, quote direction, and portfolio accounting. CLOSED 2026-09-04 (`926404166`): tools/evidence-matrix.test.ts, six named harnesses (enforcement mutations, count safety, garbage and finite-results sweeps, availability, periods).
- [x] Full Phase 3A/3B naming/signature/runtime/field/result gates rerun against the expanded surface
      with zero deferred exceptions. CLOSED 2026-09-04 (`530eb6de8`): the whole tools/ suite green at this commit; tools/deferred-exceptions.test.ts holds the zero.
- [ ] Full local CI, hosted matrix, packed-tarball consumers, bundle budgets, and clean-repository
      generation are green at one exact commit. Local CI, tools/packed-consumer.test.ts, tools/bundle-size/budgets.test.ts, and `pnpm regen:check` green at `530eb6de8`; the hosted matrix OPEN — every hosted "TotalFinance CI" run since 2026-09-03 has failed to start on the organization's GitHub Actions billing ("recent account payments have failed or your spending limit needs to be increased"); the last hosted run that executed was green at `f42dfee97`. The job definitions (the matrix, the release rehearsal, clean-repository generation) are committed; the row closes when billing is restored and the workflow runs green at this commit or a docs-only successor.

## Execution details and commit slices

The active-queue table near the top of this document is the live Stage 4 tracker. This section defines
the original contents of each row, not instructions to restart completed slices. The September
review repairs are locally verified complete; the next release handoff remains maintainer-held.
Do not infer activation or publication authority merely because a later slice is fully specified.

1. **FC0 — contracts and graph.** Encode and freeze the settled types, package boundaries,
   convention reuse, manifests, and evidence plans. No formula implementation before this slice is
   green.
2. **FC1 — cash-flow foundation.** Discounting/accumulation → return solvers → loans/schedules →
   capital budgeting/depreciation. Independently publishable package slice.
3. **FC2 — valuation/fundamentals.** Typed periods/statements → ratios → cost of capital/FCF → DCF
   analyses → sensitivity/comparables. Each subpath independently green.
4. **FC3 — research primitives.** Screening/ranking → transformations/neutralization → factor
   recipes/diagnostics → event studies.
5. **FC4/FC5/FC6 — adjacent foundations.** Cash-flow-aware performance follows FC1 so that it reuses
   the shared timing and return-solver contracts. Foreign exchange and commodity carry may start
   after FC0 and run independently if they do not modify the same shared convention types or package
   edges as another active slice.
6. **Platform Stage 4.1–4.3.** Finish architecture, shared market/artifact spine, and structural
   extension contracts using the now-known finance domains.
7. **FC7 / Platform Stage 4.4a — COMPLETE @ `a6f9842b`.** The durable portfolio ledger,
   management, reconciliation, and lifecycle layer is closed. It depends on FC1, FC4, shared
   market/artifact contracts, and the ratified structural interfaces.
8. **Platform Stage 4.4b — COMPLETE @ `3095cf91`.** The shared cross-domain scenario runner's four
   slices and exit gate are closed in [`shared-scenario-runner.md`](./shared-scenario-runner.md).
9. **Platform Stage 4.5 — COMPLETE @ `795dd999f`.** `docs/specs/calibration-research-artifacts.md`
   was authored, accepted, and built in six slices over FC3 and the existing
   calibration/research-hygiene surfaces; the completion record is inside it.
10. **Preview P1 — options marking truthfulness — COMPLETE @ `db2df2451`.** The current-contract
    marking, missing-mark policy, assumptions, evidence, and direct-pricer parity gate landed in
    [`options-backtest.md`](./options-backtest.md); `optionsBacktest` kept its identity.
11. **Stage 7A — local agent access (COMPLETE @ c7bdb260d; contract accepted 2026-09-03).** Executed AT2,
    local/read-only AT3, and the local MCP preview gate from
    [`local-operations-and-transports.md`](./local-operations-and-transports.md): one operation
    registry, machine-first CLI, generated OpenAPI/local HTTP, and protocol-correct local MCP over
    the same schemas/results.
12. **Stage 5A — preview integration and shipping (MAINTAINER-HELD; LOCAL REPAIRS COMPLETE).**
    Slices 1–3 landed and the review repairs are locally verified complete; publication requires the maintainer's Decision 8, the
    preview release checks, and actual-registry smoke. It does not itself certify FC8/FC9.
13. **FC8 / Platform Stage 4.6 — COMPLETE @ `839a955e7` (contract [`portfolio-scale-backtesting.md`](./portfolio-scale-backtesting.md) accepted 2026-09-03; six slices; begun and completed ahead of the Stage 5A publish by the maintainer's decision).** Build cross-sectional, portfolio-grade options, cross-asset, and
    ledger-backed backtesting. It depends on FC3, FC4, FC7, and structural instrument/market
    contracts. Extend operation/transport parity alongside each public slice.
14. **FC9 / Platform Stage 4.7 — true whole-surface integration — COMPLETE @ `530eb6de8` (contract [`fc9-integration-and-core-freeze.md`](./fc9-integration-and-core-freeze.md) accepted 2026-09-04; the hosted-matrix row maintainer-held).** Umbrella, packed journeys,
    complete operation/workflow registration, semantic parity, final Phase 3B rerun, and exact-commit
    evidence precede the stable release.

Each numbered slice ends with formatting, lint, strict typecheck, API/manifest/generated-output drift,
focused tests, full affected-package tests, packed consumer tests, and `git diff --check`. Commits must
not combine shared-contract design, implementation, generated artifacts, and unrelated cleanup into
an unreviewable change. Completion is recorded twice in the same closeout change: check the slice's
detailed boxes and update its active-queue row to `COMPLETE @ <commit>`. A checkbox without executable
evidence, or a completed status row with unchecked requirements, does not advance the queue.

## Complete core-freeze gate

This specification is complete only when:

- [x] FC0–FC9 checklists and every workstream exit gate are closed with executable evidence; CLOSED 2026-09-04 (`530eb6de8`) — two rows held by standing decisions and stated where they sit (the performance budget, the hosted matrix).
- [x] the existing direct APIs remain public, tested, and documented; CLOSED 2026-09-04 (`530eb6de8`): api:check, the generated READMEs run as published (tools/packed-consumer.test.ts), the field reference (tools/fields-doc.test.ts), the roster gate.
- [x] a cold TypeScript developer can perform every flagship journey without a provider or framework; CLOSED 2026-09-04 (`530eb6de8`): docs/examples/end-to-end-journey.test.ts, the packed README journeys, docs/guides/levels.md and end-to-end.md executed by guides.test.ts.
- [x] a JavaScript caller receives typed teaching errors instead of NaN, raw TypeErrors, or ignored
      fields; CLOSED 2026-09-04 (`530eb6de8`): enforcement defective 0 over 5,244 candidates, the first-touch garbage and finite-results sweeps, the packed misuse journeys.
- [x] point-in-time, timing, sign, unit, currency, rate, benchmark, and execution conventions are
      inspectable in every responsible result; CLOSED 2026-09-04 (`530eb6de8`): the assumptions envelopes (the Phase 3B assumptions gates), the execution policy named in every engine result (engine-properties.test.ts), the unit-by-name reference.
- [x] valuation, research, portfolio, and backtest compositions exactly reconcile to their primitives; CLOSED 2026-09-04 (`530eb6de8`): the differential class of tools/evidence-matrix.test.ts and the end-to-end journey's per-step reconciliations.
- [x] every reusable state/result is immutable, versioned, serializable, replayable, and provenance
      preserving; CLOSED 2026-09-04 (`530eb6de8`): the artifact spine gates (Stage 4.5, 4.6), the packed artifact journey (save → JSON → restore → replay byte-identical in Node, a worker, and a browser bundle).
- [x] research/backtest/paper/live financial semantics have one source of truth; CLOSED 2026-09-04 (`530eb6de8`): the ledger law (every engine's equity is its ledger's NAV; tools/backtest-fill-shape.test.ts — no second fill, cash, lot, or P&L shape).
- [x] no compute package fetches data, reads credentials, uses the process clock, or performs an
      external side effect; CLOSED 2026-09-04 (`926404166`): tools/no-side-effects.test.ts, fifteen allowlisted hits with reasons, none in a computed value.
- [x] the final expanded manifest has no unresolved naming, signature, runtime, field-semantic,
      result-role, finite-success, evidence, or packed-consumer debt. CLOSED 2026-09-04 (`530eb6de8`): naming unresolved 0, enforcement defective 0, the debt ledgers empty, tools/deferred-exceptions.test.ts, tools/evidence-matrix.test.ts, tools/packed-consumer.test.ts.

Only then may the pre-release stability label advance to stable. The preview may already expose the
certified earlier surface, but Stage 4.7 must re-prove the expanded library before the stable publish.
Data adapters, connected/hosted agent operation, paper/live edges, and measured acceleration remain
separately gated.

## Explicit non-goals and extension boundary

“Comprehensive” does not mean placing every regulated or specialist financial business inside the
default library. The following remain optional extension domains unless separately accepted:

- jurisdiction-specific tax calculation, wash-sale rules, tax filing, suitability, regulatory, or
  best-execution claims;
- credentialed market-data or broker access inside compute packages;
- live order placement in the default SDK or MCP;
- insurance/actuarial reserves, banking ledgers, mortgages as a servicing platform, or ERP
  accounting;
- MBS/ABS/CLO waterfalls, prepayment models, and specialist structured-credit infrastructure;
- private-equity fund administration/waterfalls, real-estate appraisal, and physical commodity
  logistics/quality/location systems (the pure `leveragedBuyoutAnalysis` calculation remains FC2);
- prediction-market event contracts under the event-study API;
- a universal instrument superclass, mandatory portfolio client, stringly mega-dispatch, or a second
  implementation hidden in workflows/transports;
- worker, GPU, or WASM rewrites without measured end-to-end benefit and exact parity.

The structural extension contracts must let third-party packages add those domains later without
patching TotalFinance or weakening the public laws.

## Primary comparison and reference surfaces

These sources define comparison breadth, not APIs to copy blindly:

- [Aswath Damodaran's NYU valuation materials](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/eqlect.htm)
  — DCF, FCFF/FCFE, terminal value, relative valuation, APV, and LBO model boundaries.
- [Piotroski, “Value Investing: The Use of Historical Financial Statement Information”](https://www.chicagobooth.edu/~/media/FE874EE65F624AAEBD0166B1974FD74D.p%20d84)
  — the canonical nine-signal F-score.
- [Beneish, “The Detection of Earnings Manipulation”](https://rpc.cfainstitute.org/research/financial-analysts-journal/1999/the-detection-of-earnings-manipulation)
  and
  [Altman's 50-year Z-score retrospective](https://www.mdpi.com/2227-7072/6/3/70) — exact named score
  variants and limitations, not unlabeled lookalikes.
- [Kenneth French's factor definitions](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_bench_factor.html)
  and [data library](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html) —
  economic factor construction, lags, portfolio sorts, and reproducible comparison data.
- [MacKinlay, “Event Studies in Economics and Finance”](https://www.bu.edu/econ/files/2011/01/MacKinlay-1996-Event-Studies-in-Economics-and-Finance.pdf)
  — estimation/event windows, expected-return models, abnormal returns, aggregation, and inference.
- [CFA Institute GIPS performance guidance](https://rpc.cfainstitute.org/sites/default/files/docs/codes-and-standards/introduction-to-the-gips-standards-for-asset-owners_requirements_online.pdf)
  — TWR/MWR, external-flow treatment, linking, transaction costs, and valuation timing.
- [Microsoft financial functions](https://support.microsoft.com/en-US/Excel/financial-functions-reference)
  — elementary cash-flow, annuity, loan, depreciation, NPV, and IRR expectations.
- [NumPy Financial](https://numpy.org/numpy-financial/) — compact elementary-finance baseline.
- [OpenBB fundamentals](https://docs.openbb.co/odp/python/reference/equity/fundamental),
  [screening](https://docs.openbb.co/odp/python/reference/equity/screener), and
  [company events](https://docs.openbb.co/odp/python/reference/equity/calendar) — research category
  coverage and data/compute separation.
- [PyPortfolioOpt](https://pyportfolioopt.readthedocs.io/en/latest/) — practical portfolio
  construction, risk models, constraints, efficient frontiers, and allocation workflows.
- [VectorBT portfolio](https://vectorbt.dev/api/portfolio/base/) — multi-asset vectorized simulation,
  records, grouping, saving/loading, and portfolio analysis.
- [QuantConnect LEAN algorithm framework](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/overview)
  and [fill models](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts)
  — separation of universe/signals/construction/risk/execution and pluggable simulation reality.
- [OpenGamma Strata product coverage](https://strata.opengamma.io/product_coverage/) — explicit
  foreign-exchange and cross-asset product/convention coverage.

TotalFinance's differentiator is not having the longest list. It is making this breadth direct,
composable, deterministic, inspectable, agent-safe, browser-safe, and unusually hard to misuse.
