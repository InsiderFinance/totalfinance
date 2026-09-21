---
'@totalfinance/backtest': minor
'@totalfinance/calendars': minor
'@totalfinance/cli': minor
'@totalfinance/commodities': minor
'@totalfinance/core': minor
'@totalfinance/crypto': minor
'@totalfinance/fixed-income': minor
'@totalfinance/foreign-exchange': minor
'@totalfinance/fundamentals': minor
'@totalfinance/http': minor
'@totalfinance/math': minor
'@totalfinance/mcp': minor
'@totalfinance/options': minor
'@totalfinance/performance': minor
'@totalfinance/portfolio': minor
'totalfinance': minor
'@totalfinance/research': minor
'@totalfinance/risk': minor
'@totalfinance/scenarios': minor
'@totalfinance/strategy': minor
'@totalfinance/structure': minor
'@totalfinance/technical-analysis': minor
'@totalfinance/valuation': minor
'@totalfinance/volatility': minor
'@totalfinance/workflows': minor
---

The first public preview of TotalFinance — twenty domain and platform packages, the `totalfinance` umbrella, the
operation registry (`@totalfinance/workflows`), and the three transports over it (the `totalfinance` CLI,
`totalfinance-http` with its OpenAPI document, the MCP server). Explicitly pre-1.0; `STABILITY.md` ships in
every package and says what each surface promises within the preview series.

What ships in this preview:

- **A frozen compute core** (FC0–FC9 closed): cash-flow mathematics, valuation and typed fundamentals,
  research primitives (screening, ranking, factors, event studies), cash-flow-aware performance, foreign
  exchange, commodities, options pricing across engines and exotics, volatility surfaces and calibration,
  fixed income and curves, crypto, technical analysis (335 indicators, batch and streaming), risk, strategy
  analysis, and the durable portfolio ledger with replay and P&L reconciliation.
- **Three simulation engines with one accounting law**: `crossSectionalBacktest` (point-in-time universes,
  the grid with the research-hygiene verdicts, walk-forward and purged folds), `optionsBacktest` over a
  position book (rules, limits, combo and legged fills, corporate actions, dividends), and
  `portfolioBacktest` (eight instrument adapters, lifecycle, settlement, margin) — every fill a portfolio
  event, every equity figure the ledger's net asset value.
- **Content-addressed artifacts** for fitted models, curves, research runs, and backtest runs: save, restore,
  replay to the same hash, compare.
- **Forty-six operations** on the registry, the CLI, the HTTP server, and the MCP adapter — twenty-three
  read-only defaults plus opt-in packs for backtests (the vectorized, options, cross-sectional, and
  portfolio runs, and a trading-environment episode), portfolio journeys (including the rebalance
  proposal), scenarios, research, artifacts, company valuation, and the trade lifecycle — with one
  schema, one result, and one teaching error per operation on every surface. Every write is
  capability-gated: the runtime refuses `trade.authorize`, `trade.submit`, `trade.cancel`,
  `trade.reconcile`, and `portfolio.record_events` without the capability the caller names.
- **Task-oriented MCP discovery and explicit worker jobs**: nine shared profiles, profile-aware
  prompts, bounded catalog pagination, truthful capability reporting, and opt-in submit/status/result/
  cancel controls over the existing local worker runner. The default stays at twenty-three compute
  tools; profiles never grant capabilities, and jobs do not change an operation's financial contract.
- **A deterministic trading-agent environment** (`@totalfinance/backtest/environment`): the portfolio
  engine's own loop driven from outside through `reset` / `step` / `finish`, the next-observation law,
  real open orders with idempotent retry, typed rejections that never throw, a chained trace identity,
  twenty maintained episodes, and Agent Bench — operational conformance apart from strategy quality.
- **The safe trade lifecycle on paper** (`@totalfinance/portfolio/trade`, `@totalfinance/backtest/paper`):
  intent → plan → preflight (the ledger's own fold before and after; never an allow from missing
  information) → a bounded, content-addressed, expiring authorization grant → the paper broker over the
  engines' one fill path (one key, one plan, one order; late fills, duplicate deliveries, cancellation,
  the kill switch all proven) → the execution journal → reconciliation to the ledger's fills. Live
  execution is a typed refusal in this preview.
- **The September review repairs**: portfolio decisions execute no earlier than the next observation;
  entry buying power is a pre-fill gate that rejects over-budget orders explicitly; dividends, coupons,
  redemptions, and FX maturities are signed obligations on both sides; paper orders resume from an
  authoritative journal store with durable fill identities; an inline grant is verified against the
  trusted authorization store; the HTTP server checks Host, Origin, and content type and requires a
  server-owned bearer credential for enabled writes — each with a permanent regression at its owner.
- **Generated references**: API reports, package READMEs, `llms.txt`, the bundle-size report, the OpenAPI
  document, and the field reference (every public field with its kind and the unit its name carries),
  regenerated by one command and proven byte-stable.
- **Execution safety and recovery**: preflight allocates hedge capacity once; submitted orders
  retain the complete approved plan and combo ratios; plan-local combos cancel together. Embedded
  slippage/spread/impact is attributed separately from cash charges, keeping backtest, paper and
  ledger cash aligned. Workflow grants persist their exact submission events before journal commit
  and recover pending events before any later write. Custom journal stores expose a stable
  `storeId`; submission and cancellation both retain the original authorization and journal stores.
- **Guides that run in CI**: getting started, the six levels (raw, facade, analysis, artifact, batch,
  workflow), the end-to-end journey from fundamentals to performance, backtesting, strategies, the
  transports, the trading-agent environment, and the safe trade lifecycle.
- **A public developer workbench in the repository**: task-first guides, complete searchable export
  reference, six SDK-powered playgrounds with matching copied examples tested against installed
  packages, and an agent handbook. Version snapshots require actual release evidence before claiming
  publication. The static site is deployed separately; real browser/host checks and hosting approval
  remain required. The maintained agent-task corpus and scorer do not claim a model benchmark.
