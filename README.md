# TotalFinance

> A TypeScript-native finance, quant, options, technical-analysis, and risk toolkit.
> Browser-safe by default, serious enough for quants, pleasant enough for frontend developers,
> and structured enough for MCP agents.

TotalFinance aims to be the best TypeScript-native alternative to the combined practical surface area of
QuantLib, TA-Lib, py_vollib, vectorbt, and modern options-flow dashboards — without leaving the
JavaScript ecosystem.

Start with the [public developer workbench](./site/README.md): task guides, runnable calculators,
searchable API reference, and the agent handbook. Its source is checked in under `site/`;
the preview instructions work from any checkout of this branch. Public hosting is not yet enabled.

**Status: pre-1.0, published to npm as `@insiderfinance/totalfinance`** (the optional MCP package
is not yet published). The release has **two packages**:
`@insiderfinance/totalfinance@0.1.2` includes every domain, workflows, CLI and HTTP;
`@insiderfinance/totalfinance-mcp@0.1.2` is the optional MCP server. The main package has no runtime
dependencies; MCP depends on the exact main version and the MCP SDK. Calculations run locally;
paper execution requires explicit capabilities and is not live trading.

The current release is `0.1.2`: pre-1.0 software, not a 1.0 stability guarantee.
[`STABILITY.md`](./STABILITY.md) explains each surface's guarantees. Install the main package from
npm as below, or use the [source-checkout instructions](#develop). This repository is the canonical
source home. What's inside:

- **Options & volatility** — option pricing (Black–Scholes–Merton, Black-76, Bachelier) with first-
  and higher-order Greeks and a multi-method implied-vol suite; American/exotic engines
  (Barone–Adesi–Whaley, Bjerksund–Stensland 1993 & 2002, binomial CRR/JR/Tian/Leisen–Reimer,
  trinomial, Crank–Nicolson) with discrete dividends and an engine-comparison API;
  **stochastic-volatility models** (Heston via COS + Andersen-QE Monte-Carlo, SABR Hagan asymptotics,
  Dupire local volatility) and a seeded Monte-Carlo/QMC path-pricing engine with barrier/Asian/lookback
  exotics — every model cross-validated analytic↔simulation; **implied-vol surfaces** with SVI/SABR
  calibration, static (calendar/butterfly) arbitrage checks, skew/smile metrics and event vol.
- **Market structure & technical analysis** — **options market structure**
  (GEX/DEX/vega/vanna/charm/theta/vomma/speed/color exposure, walls incl. 0DTE/weekly/monthly OPEX,
  max pain, net-drift, scenario maps, options flow with 0DTE & call-put premium); a **full
  technical-analysis suite** (300+ indicators across moving averages, momentum, trend, volatility,
  volume, Hilbert-transform cycles and statistics; the complete TA-Lib candlestick catalog with `CDL*`
  aliases plus an adaptive TA-Lib candle engine; Renko/Kagi/P&F/Line-Break and range/tick/volume/dollar
  bars; **trade/quote-level microstructure** — aggressor CVD, tick volume profile, order-book imbalance,
  footprint bars; price-action utilities; a feature pipeline, signal DSL and indicator registry — every
  indicator both batch and serializable-streaming, **certified against the TA-Lib C reference, pandas-ta
  and tulipy** via committed golden vectors plus closed-form correctness oracles (**~98%** of the
  ~216-name pandas-ta-classic catalog is numerically proven, the rest a tracked 4-name allowlist), with
  opt-in `talib: true` modes for exact TA-Lib reproduction).
- **Risk, backtesting & strategy** — performance metrics; **risk & portfolio analytics** (VaR/CVaR
  parametric·historical·Monte-Carlo, marginal/component VaR, stress & scenario testing, factor/PCA
  exposure, optimization — min-variance, max-Sharpe, mean-variance, risk parity, HRP, Kelly — and
  **research hygiene**: deflated/probabilistic Sharpe, multiple-testing correction, purged/embargoed
  cross-validation); an options strategy/payoff calculator; **a backtesting suite** (a vectorized
  research engine and an event-driven execution simulator with a broker, order types,
  costs/slippage/borrow, walk-forward and tear sheets — every run carrying implementation-risk
  diagnostics that surface its hidden fill, cost, look-ahead and survivorship assumptions).
- **Foundations & integration** — a serious numerical foundation (solvers, optimizers, interpolation,
  linear algebra, integration, Monte Carlo, low-discrepancy sequences, the bivariate normal); exchange
  calendars; **fixed income** (bonds + analytics, yield curves and bootstrapping, rates derivatives,
  short-rate models, and credit/CDS); and a read-only MCP server that wraps the same engines.

All of it sits on the proven four-role public architecture—facade, analysis, artifact, and expert
kernel—with the `.explain()` companion, assumptions/diagnostics envelope, zero-dependency schema
facade with JSON-Schema export, and enforced bundle-size discipline. The **full suite passes** under `pnpm run ci` — including TA-Lib /
pandas-ta / tulipy golden-vector parity, closed-form oracles, a degenerate-OHLC robustness matrix, and
registry-wide batch≡stream + serialization property tests.

## Install

Everything under one install: use the `@insiderfinance/totalfinance` umbrella, then import named functions from its
domain subpaths for portable browser tree shaking:

```sh
pnpm add @insiderfinance/totalfinance@0.1.2
```

```ts
import { blackScholes } from '@insiderfinance/totalfinance/options';
import { valueAtRisk } from '@insiderfinance/totalfinance/risk';
import { rsi } from '@insiderfinance/totalfinance/technical-analysis';

blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
}); // => 0.8983...
rsi([
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
]).at(-1); // => 57.92 — RSI-14 needs 15+ closes (fewer is an all-NaN warmup)
valueAtRisk([0.01, -0.02, 0.015, -0.005, 0.008]);
```

The root still exposes every domain as a namespace and hoists only five flagship option gestures:
`blackScholes`, `option`, `market`, `engines`, `impliedVolatility`. Namespace convenience such as
`import { math } from '@insiderfinance/totalfinance'` followed by `math.normalCdf(0)` has a bundler tradeoff:
esbuild retains the whole math namespace ([issue #1420](https://github.com/evanw/esbuild/issues/1420));
Rollup shakes this static use. Direct `import * as math from '@insiderfinance/totalfinance/math'` with static member
use also shakes; dynamic namespace access and registries retain the implementations they can reach.

**Runtime contract:** ESM-only, Node ≥ 22.13.0 (the supported LTS lines). `require()` works via
Node's `require(ESM)` interop — unflagged since 22.12.0, warning-free since 22.13.0 — through the
`default` export condition; there is no separate CommonJS build. Both paths (plus TypeScript
`nodenext` and `bundler` resolution) are verified in CI against the **packed tarballs**, not the
workspace.

Add the optional MCP server when an agent needs it (after publication):

```sh
pnpm add @insiderfinance/totalfinance-mcp@0.1.2
```

Named imports from `@insiderfinance/totalfinance/<domain>` and supported feature subpaths work too. Installation
size is not final bundle size: a bundler can remove unused code, while plain Node ESM performs no
automatic dead-code elimination. Facades include validation and `.explain()` services; indicators
also carry streaming support, not just a bare formula. Type-only imports add no runtime code.
See [Imports and bundles](./docs/guides/imports-and-bundles.md) for examples and measured budgets.

## One line

```ts
import { blackScholes } from '@insiderfinance/totalfinance/options';

blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});
// => 0.8983...
```

## When you need the assumptions

```ts
const explained = blackScholes.call.explain({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});

explained.value; // the price
explained.assumptions; // day count, compounding, greek units, model, conventions version
explained.diagnostics; // engine, method, warnings, timing
```

## Professional control

```ts
import { option, market, engines } from '@insiderfinance/totalfinance/options';

// The instrument builder encodes the US listed convention: AMERICAN exercise, date-only
// expiries resolve to the 16:00 ET close, multiplier 100 — no silent style default.
const contract = option.usEquityCall({ underlying: 'AAPL', strike: 100, expiry: '2026-09-18' });
const mkt = market({
  spot: 96.5,
  riskFreeRate: 0.045,
  dividendYield: 0.012,
  volatility: 0.28,
  asOf: 1781827200000,
});

// engines.auto() routes the American contract to the right engine and says why in diagnostics.
const result = option.price({ contract: contract, market: mkt, engine: engines.auto() });
result.value;
result.greeks.delta;
result.assumptions;
result.diagnostics;
```

## MCP quickstart

`@insiderfinance/totalfinance-mcp` exposes the same engines to AI agents over the Model Context Protocol — 23
read-only tools (option pricing/Greeks/IV, strategy analysis, vol surfaces and expected move,
GEX/flow, any of the 335 TA indicators, performance, VaR, portfolio optimization, calendars,
crypto funding/carry, bond analytics).
The checked-in `0.1.2` package is pre-1.0 software. From a checkout with dependencies installed,
build and run the local binary (Node ≥22.13); no npm publication is implied:

```sh
pnpm build
node distribution/mcp/dist/bin.js doctor
node distribution/mcp/dist/bin.js
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "@insiderfinance/totalfinance": {
      "command": "node",
      "args": ["/absolute/path/to/totalfinance/distribution/mcp/dist/bin.js"]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add totalfinance -- node /absolute/path/to/totalfinance/distribution/mcp/dist/bin.js
```

**Cursor** — add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "@insiderfinance/totalfinance": {
      "command": "node",
      "args": ["/absolute/path/to/totalfinance/distribution/mcp/dist/bin.js"]
    }
  }
}
```

Add `--profile` plus one of `default`, `options`, `research`, `strategies`, `portfolio`, `valuation`,
`backtesting`, `scenarios`, or `full` to the binary arguments. `--packs a,b` narrows that profile
exactly; profiles never grant writes. Omitting jobs keeps the default at 23 tools.

For explicit local worker jobs, append `--profile backtesting --store /absolute/path/to/store --jobs`.
This adds typed `totalfinance.job.submit`, `totalfinance.job.status`, `totalfinance.job.result`, and
`totalfinance.job.cancel` controls with lifecycle/stage progress and fetch-later resource URIs.
Existing job-class calls await workers asynchronously and retain their financial schemas; other cost
classes remain inline. No experimental MCP tasks are required. `--store` alone adds no job tools;
`--store-read-only` attaches only an artifact reader and cannot be combined with `--jobs`.

Read `totalfinance://capabilities` for effective filters, held/required grants, actual read/write stores,
budgets, and jobs, and `totalfinance://profiles` for registry-derived descriptions. `doctor` reports the
same validated configuration. Grants are an exact server-owned `--capability` selection, not tool
arguments or implied live-order permission. Prompts mention only available tools and request missing
inputs rather than inventing market data.

Tool/resource lists are bounded by `--page-size` (1–100, default 100); follow `nextCursor` until absent.
Malformed, stale, cross-catalog, or cross-server cursors are JSON-RPC `InvalidParams`; restart listing.
The raw UTF-8 input cap defaults to 65,536 bytes and can be raised to 16,777,216 with
`--max-input-bytes`. `--seed` defaults to 0 for stochastic calls; `--deadline-ms` is an optional
positive millisecond budget, not a hard preemption guarantee. Errors carry machine-readable
`OperationError` JSON in text content with no success `structuredContent`; unknown/filtered tool,
resource, and prompt names are protocol errors.

See the [MCP guide](./docs/guides/mcp.md) for exact profile packs, all registered operations, schemas,
permissions, cancellation, error codes, and SDK-only limitations. After an actual npm release,
install or launch the exact published version; do not treat these local examples as release evidence.

## Design laws

TotalFinance is governed by non-negotiable design laws (see the [docs](./docs/README.md) — in
particular [assumptions & conventions](./docs/guides/assumptions.md), [the `.explain()`
envelope](./docs/guides/envelope.md), and [errors & diagnostics](./docs/guides/errors.md)):

1. **One result grammar per public role** — facades return plain values with `.explain()`;
   analyses return rich results directly; artifacts are immutable reusable objects; direct kernels
   live on expert subpaths and use named objects whenever financial scalars could be confused.
2. **Plain numerics** — public values are `number`, never wrapped-number DSLs.
3. **No hidden finance conventions** — pro results echo every applied convention; facades expose
   `.explain()`.
4. **No silent degradation** — solvers never return a guessed value after non-convergence; facades
   throw typed errors, pro APIs report `converged: false`.
5. **Pure calculation packages** — no I/O, env, network, filesystem, or system clock. `asOf` is
   injected.
6. **Bring your own data** — compute packages never fetch; no API keys in browser-safe packages.
7. **Batch and stream are first-class.**
8. **Fluent chains are lazy.**
9. **Tree-shakeable by construction** — ESM-first, `sideEffects: false`, with deep per-feature
   entrypoints for the hot paths (e.g. `@insiderfinance/totalfinance/options/black-scholes`, `@insiderfinance/totalfinance/math/normal`,
   `@insiderfinance/totalfinance/math/solvers`, `@insiderfinance/totalfinance/performance/sharpe`, `@insiderfinance/totalfinance/technical-analysis/rsi`).
10. **Correctness before speed** — pure-TS reference kernels ship first; a fast wrong answer is a
    release blocker.
11. **Developer experience is a product feature.**

## Public packages and entry points

Install only the main package and, optionally, MCP. All domain paths below are subpath imports of
the main package, not separately installable npm packages. Source workspaces under `packages/`
are private implementation details. Browser root/domain imports exclude Node-only transports and MCP.

| Package                                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@insiderfinance/totalfinance`                    | umbrella package: one install, namespace re-exports of the whole toolkit below                                                                                                                                                                                                                                                                                                                                                                       |
| `@insiderfinance/totalfinance/core`               | types, conventions, errors, diagnostics, assumptions, schema facade                                                                                                                                                                                                                                                                                                                                                                                  |
| `@insiderfinance/totalfinance/math`               | distributions, solvers, optimizers, interpolation, linalg, integration, statistics, monteCarlo                                                                                                                                                                                                                                                                                                                                                       |
| `@insiderfinance/totalfinance/calendars`          | rules-based exchange calendars (NYSE, CBOE, crypto)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@insiderfinance/totalfinance/crypto`             | perpetual funding, futures basis/carry curves, inverse futures, and coin-delta hedging                                                                                                                                                                                                                                                                                                                                                               |
| `@insiderfinance/totalfinance/options`            | pricing engines (BSM/Black-76/Bachelier, American, Monte-Carlo/QMC), Heston/SABR/local-vol, barrier/Asian/lookback exotics, Greeks, IV                                                                                                                                                                                                                                                                                                               |
| `@insiderfinance/totalfinance/volatility`         | implied-vol surfaces (raw/interpolated/smoothed + SVI/SABR/Heston calibration, moneyness/delta axes), static arbitrage checks, skew/smile + term structure, IV rank/percentile, event vol (variance risk premium, earnings decomposition), risk-neutral probability (Breeden–Litzenberger), volatility cone, variance-swap fair vol                                                                                                                  |
| `@insiderfinance/totalfinance/structure`          | dealer-positioning exposure (GEX/DEX/vega/vanna/charm/theta/vomma/speed/color), levels (zero-gamma, call/put + vanna/charm + 0DTE/weekly/monthly-OPEX walls, max pain, pin risk), net-drift, scenario maps, options flow (aggressor/sweep/block/spread, 0DTE, call-put premium)                                                                                                                                                                      |
| `@insiderfinance/totalfinance/technical-analysis` | technical-analysis indicators, batch + serializable streaming                                                                                                                                                                                                                                                                                                                                                                                        |
| `@insiderfinance/totalfinance/performance`        | returns, Sharpe/Sortino/Calmar/Omega/Treynor, benchmark-relative (alpha/beta/info ratio/tracking error), drawdowns, hit rate/profit factor/expectancy, turnover/exposure, rolling metrics                                                                                                                                                                                                                                                            |
| `@insiderfinance/totalfinance/risk`               | VaR/CVaR, portfolio risk decomposition, concentration/liquidity/margin, stress/scenarios, factor/PCA, beta-weighted delta, optimization (min-var/max-Sharpe/risk-parity/HRP/Kelly/Black-Litterman/CVaR + sector/turnover/cost constraints), research hygiene                                                                                                                                                                                         |
| `@insiderfinance/totalfinance/strategy`           | options strategy/payoff calculator (legs, breakevens, max P/L, Greeks, probability of profit, expected value, risk/reward, probability of touch, scenario table)                                                                                                                                                                                                                                                                                     |
| `@insiderfinance/totalfinance/backtest`           | vectorized research engine + event-driven execution simulator (broker, order types, costs/slippage/borrow), walk-forward, tear sheets, implementation-risk diagnostics                                                                                                                                                                                                                                                                               |
| `@insiderfinance/totalfinance/fixed-income`       | bonds (fixed/zero/FRN/amortizing/inflation) + analytics (clean/dirty/accrued, YTM/YTC, Macaulay/modified/effective/key-rate duration, convexity, DV01/PV01), yield curves + bootstrapping (deposits/FRAs/futures/OIS/swaps), rates derivatives (FRA/swap/swaption/cap/floor via Black & Bachelier), short-rate models (Vasicek/CIR/Hull-White + HW/Black-Karasinski tree), credit (survival/hazard curves, CDS pricing, hazard bootstrap, CDS basis) |
| `@insiderfinance/totalfinance/fundamentals`       | TotalFinance typed fundamentals: the point-in-time FundamentalPeriod contract, availability rule, and raw data-edge record. Browser-safe                                                                                                                                                                                                                                                                                                             |
| `@insiderfinance/totalfinance/valuation`          | TotalFinance valuation: time-value-of-money, NPV/IRR/MIRR cash-flow solvers, loans and amortization, capital budgeting and depreciation. Browser-safe                                                                                                                                                                                                                                                                                                |
| `@insiderfinance/totalfinance/research`           | Point-in-time research primitives: universe screening, cross-sectional style factors, and event studies                                                                                                                                                                                                                                                                                                                                              |
| `@insiderfinance/totalfinance/foreign-exchange`   | Foreign-exchange foundations: pairs, conversion, forwards, parity, and currency exposure                                                                                                                                                                                                                                                                                                                                                             |
| `@insiderfinance/totalfinance/commodities`        | Commodity carry and term structure: cost-of-carry forwards, implied carry inputs, roll yield, and curve analytics                                                                                                                                                                                                                                                                                                                                    |
| `@insiderfinance/totalfinance/portfolio`          | Durable portfolio management: the immutable economic-event ledger, pure event reduction, lots and multi-currency cash, valuation snapshots, and flow-aware performance inputs                                                                                                                                                                                                                                                                        |
| `@insiderfinance/totalfinance/scenarios`          | Cross-domain scenario analysis with explicit targets, shared market state, full revaluation, Taylor attribution, reporting-currency aggregation, and durable replay                                                                                                                                                                                                                                                                                  |
| `@insiderfinance/totalfinance/workflows`          | TotalFinance workflows: the protocol-neutral operation registry — one operation definition drives the SDK-facing runtime, the CLI, OpenAPI, and MCP. Read-only, provider-free, browser-safe                                                                                                                                                                                                                                                          |
| `@insiderfinance/totalfinance/cli`                | TotalFinance local operations: file-backed artifact and job stores and the worker-terminated job runner behind the `@insiderfinance/totalfinance` command line                                                                                                                                                                                                                                                                                       |
| `@insiderfinance/totalfinance/http`               | TotalFinance local HTTP server: a loopback, read-only transport over the operation registry, with its OpenAPI 3.1 document generated from the same definitions                                                                                                                                                                                                                                                                                       |
| `@insiderfinance/totalfinance-mcp`                | read-only MCP server wrapping the same engines                                                                                                                                                                                                                                                                                                                                                                                                       |

(Later phases add `data` and adapters.)

## Develop

```sh
git clone https://github.com/InsiderFinance/totalfinance.git
cd totalfinance
nvm use         # optional if the pinned Node version is already active
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck   # whole-repo type check against source
pnpm test        # unit, golden, property, and bundle-size tests
pnpm lint        # ESLint with package-boundary + purity rules
pnpm build       # composite build to dist/ for publishing
pnpm api:check   # public API report drift check
pnpm site:dev   # local docs and playgrounds at http://127.0.0.1:4173
```

Contributions follow [`CONTRIBUTING.md`](./CONTRIBUTING.md) (spec first, the laws, the landing standard);
the promise each surface makes is in [`STABILITY.md`](./STABILITY.md); report vulnerabilities per
[`SECURITY.md`](./SECURITY.md); the community standard is [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Disclaimer

TotalFinance is analytics software, **not financial advice**. Outputs that estimate dealer positioning,
opening/closing trades, unusual activity, or flow classification are labeled as estimates. The
default MCP server is read-only and places no trades.

## License

[Apache-2.0](./LICENSE)
