# TotalFinance Docs

TotalFinance `0.1.0` is pre-1.0 software, not a 1.0 stability guarantee. Its two public packages are
`@insiderfinance/totalfinance` (all domains, workflows, CLI and HTTP) and the optional
`@insiderfinance/totalfinance-mcp`. The 25 source workspaces are private implementation details.
[`STABILITY.md`](../STABILITY.md) ships in both artifacts: domain conformance does not promote
preview workflows or transports to production-ready status. Publication still requires maintainer
approval; a local checkout is not registry evidence. Together the public packages provide option
pricing (European, American, exotic, stochastic volatility), implied-volatility surfaces, options
market structure, **335 registered technical-analysis indicators** (every one batch +
serializable-streaming), performance metrics, risk & portfolio analytics, an options profit
calculator, backtesting, fixed income, crypto derivatives, exchange calendars, fundamentals, corporate
valuation, research, foreign exchange, commodities, a durable event-derived portfolio ledger, shared
cross-domain scenarios, and one protocol-neutral operation registry reachable from the SDK, the
`totalfinance` command line, a local HTTP server with a generated OpenAPI document, and a read-only MCP
server.

## Start here

- [Implementation order — the authoritative work queue](./implementation-order.md)
- [Library alignment spec — public-contract laws and Phase 3A/3B gates](./library-alignment-spec.md)
- [Core capability completion and live tracker — Stages 4.5, P1, 7A, 4.6, 4.7, 7B.1, and 7B.2 closed; Stage 5A's publish awaits the maintainer](./specs/finance-portfolio-backtesting-completeness.md)
- [Local operations, CLI, OpenAPI, and MCP — the Stage 7A contract (complete @ c7bdb260d)](./specs/local-operations-and-transports.md)
- [Preview integration and shipping — the Stage 5A contract (slices 1–3 landed, the publish awaits the maintainer's Decision 8)](./specs/preview-integration-and-shipping.md)
- [FC9 integration and the core freeze — completed Stage 4.7 contract and evidence (complete @ 530eb6de8; the hosted matrix maintainer-held)](./specs/fc9-integration-and-core-freeze.md)
- [The safe trade lifecycle and paper execution — the Stage 7B.2 (AT5) contract (complete; accepted 2026-09-05, closed 2026-09-06)](./specs/trade-lifecycle-and-paper-execution.md)
- [Trading-agent environment and Agent Bench — completed Stage 7B.1 (AT4) contract and evidence (complete @ f7677ebcb)](./specs/trading-agent-environment.md)
- [Portfolio-scale and cross-asset backtesting — completed Stage 4.6 contract and evidence (complete @ 839a955e7)](./specs/portfolio-scale-backtesting.md)
- [Calibration and research artifacts — completed Stage 4.5 contract and evidence](./specs/calibration-research-artifacts.md)
- [Shared scenario runner — completed Stage 4.4b contract and evidence](./specs/shared-scenario-runner.md)
- [Phase 3B.N public naming normalization — completed specification and evidence](./specs/phase-3b-public-naming-normalization.md)
- [Phase 3B runtime and semantic closeout — completed specification and permanent gates](./specs/phase-3b-runtime-semantic-closeout.md)
- [Phase 3B decision ledger — settled execution answers](./specs/phase-3b-decision-ledger.md)
- [Wave 6 quant moats — completed feature batch](./specs/wave6-quant-moats.md)
- [Getting started](./getting-started.md)
- [Platform-completeness roadmap — architecture and product direction](./platform-completeness-roadmap.md)
- [Agent-native portfolio and trading platform — durable state, workflows, simulation, and safe execution](./agent-native-portfolio-and-trading-platform.md)
- [Roadmap — the ambitious surface](./roadmap.md)
- [MCP, acceleration, and data-growth strategy](./mcp-acceleration-data-growth-strategy.md)
- [Levels: raw, facade, analysis, artifact, batch, workflow](./guides/levels.md)
- [End to end: fundamentals → valuation → screen → portfolio → backtest → performance](./guides/end-to-end.md)
- [Assumptions and conventions](./guides/assumptions.md)
- [Results & the `.explain()` envelope](./guides/envelope.md)
- [Errors and diagnostics](./guides/errors.md)
- [Strategy catalogue (profit calculator)](./guides/strategies.md)
- [Backtesting: the three engines and the ledger law](./guides/backtesting.md)
- [The trading-agent environment: reset/step, the laws, the episodes, Agent Bench](./guides/trading-environment.md)
- [The safe trade lifecycle: intent, preflight, grant, paper execution, journal, reconciliation, the trade pack](./guides/trade-lifecycle.md)
- [Technical indicators (all 335)](./guides/ta-indicators.md)
- [TA warmup semantics](./guides/ta-warmup.md)
- [TA-Lib / pandas-ta compatibility](./guides/ta-compatibility.md)
- [Live/streaming TA charts](./guides/ta-live-charts.md)
- [MCP server](./guides/mcp.md)
- [Command line (`totalfinance`)](./guides/cli.md)
- [Local HTTP server and OpenAPI (`totalfinance-http`)](./guides/http.md)

## Reference

- [Option pricing formulas (BSM / Black-76 / Bachelier)](./formulas/options.md)
- [Field reference — every public field, its kind, and the unit its name carries (generated)](./reference/fields.md)
- [Bundle size report](./bundle-size.md)
- [Stability tiers — the long form of the shipped `STABILITY.md`](./stability.md)
- [Schema library ADR](./adr/schema-library.md)

## Public packages and entry points

Domain paths are exports of the main package, not separate npm installs. MCP is the only optional
separate package. Install `@insiderfinance/totalfinance@0.1.0` after verifying registry availability.

| Package                                           | What it gives you                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@insiderfinance/totalfinance`                    | umbrella package: one install, namespace re-exports of every package below                                                               |
| `@insiderfinance/totalfinance/core`               | types, conventions, errors, dates/day-counts, OCC symbology, calendar engine, schema facade                                              |
| `@insiderfinance/totalfinance/math`               | distributions, solvers, optimizers, interpolation, linear algebra, integration, statistics, seeded RNG, Monte Carlo                      |
| `@insiderfinance/totalfinance/calendars`          | rules-based NYSE / CBOE / crypto trading calendars                                                                                       |
| `@insiderfinance/totalfinance/options`            | BSM / Black-76 / Bachelier, American & exotic engines, Heston / SABR / local-volatility, Monte-Carlo/QMC, Greeks, implied vol, batch API |
| `@insiderfinance/totalfinance/volatility`         | implied-vol surfaces with SVI/SABR/Heston calibration, static-arbitrage checks, skew/smile + term structure, IV rank, event vol          |
| `@insiderfinance/totalfinance/structure`          | dealer-positioning exposure (GEX/DEX/vanna/charm), walls, max pain, zero-gamma, scenario maps, options flow                              |
| `@insiderfinance/totalfinance/technical-analysis` | 335 registered technical indicators — every one batch **and** serializable-streaming — plus bars, candles, pipeline, signal DSL          |
| `@insiderfinance/totalfinance/performance`        | returns, Sharpe/Sortino/Calmar, benchmark-relative metrics, drawdowns, hit rate/expectancy, rolling metrics                              |
| `@insiderfinance/totalfinance/portfolio`          | event-derived multi-account ledger, lots/cash/lifecycle state, valuation, P&L, reconciliation, allocation, rebalancing, and monitoring   |
| `@insiderfinance/totalfinance/risk`               | VaR/CVaR, stress & scenario testing, factor/PCA exposure, portfolio optimization (min-var → Kelly/HRP), research hygiene                 |
| `@insiderfinance/totalfinance/strategy`           | options profit calculator: payoff, breakevens, mark-to-market, probability of profit, build-from-chain                                   |
| `@insiderfinance/totalfinance/backtest`           | vectorized research engine + event-driven simulator (broker, costs, slippage), walk-forward, tear sheets, honest assumptions             |
| `@insiderfinance/totalfinance/fixed-income`       | bonds + analytics, yield curves + bootstrapping, swaps/swaptions/caps/floors, short-rate models, CDS & credit curves                     |
| `@insiderfinance/totalfinance/crypto`             | crypto futures, perpetuals, options, carry, funding, basis, and cross-market arbitrage analytics                                         |
| `@insiderfinance/totalfinance/fundamentals`       | typed financial statements, accounting identities, point-in-time observations, and fundamental ratios                                    |
| `@insiderfinance/totalfinance/valuation`          | time-value-of-money, cash-flow solvers, loans, capital budgeting, DCF/reverse DCF, sensitivities, and comparables                        |
| `@insiderfinance/totalfinance/research`           | point-in-time screening/ranking, factor construction, neutralization, event studies, and research protocols                              |
| `@insiderfinance/totalfinance/foreign-exchange`   | FX spots/forwards/swaps, parity, carry, conversion, and coherent multi-currency analytics                                                |
| `@insiderfinance/totalfinance/commodities`        | commodity forwards, storage/convenience yield, term structures, carry, rolls, and spread analytics                                       |
| `@insiderfinance/totalfinance-mcp`                | read-only MCP server wrapping the same engines                                                                                           |

## Runnable examples

Every documented snippet has an executed counterpart in
[`docs/examples`](./examples/) that runs in CI:

- [`quickstart.test.ts`](./examples/quickstart.test.ts) — price an option, `.explain()`, IV, schema.
- [`credible-core.test.ts`](./examples/credible-core.test.ts) — profit calculator, TA + streaming,
  batch option chain, performance metrics, Black-76/Bachelier, NYSE calendar.
- [`advanced-quant.test.ts`](./examples/advanced-quant.test.ts) — Monte-Carlo/QMC pricing, Heston &
  SABR smiles, Dupire local vol, and barrier/Asian exotics.
- [`vol-surface-calibration.test.ts`](./examples/vol-surface-calibration.test.ts) — raw-SVI and SABR
  smile calibration with the butterfly-arbitrage check.
- [`research-hygiene.test.ts`](./examples/research-hygiene.test.ts) — deflated Sharpe, multiple-testing
  correction, and purged/embargoed cross-validation.
- [`backtesting.test.ts`](./examples/backtesting.test.ts) — vectorized and event-driven backtests,
  bracket orders, walk-forward, tear sheets, and the implementation-risk diagnostics block.
- [`end-to-end-journey.test.ts`](./examples/end-to-end-journey.test.ts) — fundamentals → valuation →
  score → rebalance proposal → cross-sectional backtest → performance, reconciled at every step.
- [`trading-environment.test.ts`](./examples/trading-environment.test.ts) — the environment journey:
  every baseline benched over two episodes, a recorded episode saved and replayed, a transcript scored
- [`trade-lifecycle.test.ts`](./examples/trade-lifecycle.test.ts) — the safe trade lifecycle as a cold user runs it: propose → preflight → authorize → execute on paper → reconcile, directly and through the registry with the stores and the capabilities.
- [`portfolio-and-vol.test.ts`](./examples/portfolio-and-vol.test.ts) — benchmark-relative performance,
  Black-Litterman & CVaR optimization with constraints, concentration risk, the Heston/term-structure
  surface, and event-vol decomposition.

## Runbooks and policies

- [Cutting a release — the version bump, the dry-run manifest, the approval gate, the smoke](./runbooks/release.md)
- [Release rollback — owner, dist-tag reversal, unpublish versus deprecate, the message template](./runbooks/release-rollback.md)
- [Contributing — spec first, the laws, the regeneration chain, the landing standard](../CONTRIBUTING.md)
- [Security policy — supported versions and private reporting](../SECURITY.md)
- [Code of conduct — Contributor Covenant 2.1](../CODE_OF_CONDUCT.md)

## Milestones

Development phases 0–6, the Phase 3A callable-shape correction, and Wave 6 are complete (the
planned first public version is `0.1.0`; no npm publication is asserted here). These pages are
historical implementation records. The
[implementation order](./implementation-order.md) is the current work queue. Phase 3B, FC0–FC9,
Platform Stages 4.1–4.7, Preview P1 (options marking truthfulness), and Stage 7A — the
protocol-neutral operation registry, machine-first CLI, generated OpenAPI/local HTTP, and exemplary
read-only local MCP — landed, as did Stage 7B.1's trading environment and Stage 7B.2's safe trade
lifecycle/paper execution. The [September review-repair gate](./specs/review-september-2026-repairs.md)
is locally verified complete on `dccfce53` plus the repair changes, with the local full-coverage gate
passed. Do not restart those stages or the repairs. Stage 5A publication and Stage 5B stable cutover
remain maintainer-held under their own release gates; local verification does not authorize
publication, commit/push, or claim hosted-matrix success. The
[roadmap](./roadmap.md) remains feature inventory rather than a scheduler:

- [Phase 0 — architecture spike](./milestones/phase-0.md)
- [Phase 1 — credible core](./milestones/phase-1.md)
- [Phase 2 — numerical foundation & options seriousness](./milestones/phase-2.md)
- [Phase 3 — market structure & volatility](./milestones/phase-3.md)
- [Phase 4 — TA parity](./milestones/phase-4.md)
- [Phase 5 — advanced quant & research](./milestones/phase-5.md)
- [Phase 6 — fixed income](./milestones/phase-6.md)

## API docs

```sh
pnpm run docs
```

Generated TypeDoc output is written to `docs/api/` (git-ignored) so authored Markdown is not
overwritten.
