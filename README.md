<p align="center">
  <img src="https://raw.githubusercontent.com/InsiderFinance/totalfinance/main/site/brand/assets/logo.svg" width="96" height="96" alt="TotalFinance logo" />
</p>

# TotalFinance

**Complete finance in TypeScript. For developers and AI agents.**

[![npm](https://img.shields.io/npm/v/%40insiderfinance%2Ftotalfinance)](https://www.npmjs.com/package/@insiderfinance/totalfinance)
[![CI](https://github.com/InsiderFinance/totalfinance/actions/workflows/totalfinance-ci.yml/badge.svg)](https://github.com/InsiderFinance/totalfinance/actions/workflows/totalfinance-ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-078754.svg)](./LICENSE)

[Homepage](https://totalfinance.io/) · [Documentation](https://totalfinance.io/docs/totalfinance/) · [npm](https://www.npmjs.com/package/@insiderfinance/totalfinance) · [Releases](https://github.com/InsiderFinance/totalfinance/releases)

Price options, analyze portfolios, build indicators, test strategies, and give agents the same
financial tools you use in code. TotalFinance brings options, volatility, technical analysis, risk,
valuation, and backtesting together in one package.

Calculations run locally with the data you provide. The main package has **zero runtime
dependencies**, typed inputs, and tree-shakeable ESM exports. Use it in Node.js, browsers, and workers;
connect the same engines to agents through MCP.

## Quick start

```sh
npm install @insiderfinance/totalfinance
```

Price a call option:

```ts
import { blackScholes } from '@insiderfinance/totalfinance/options';

const price = blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});

console.log(price); // 0.8983…
```

Rates and volatility are decimals: `0.045` means 4.5%, `0.22` means 22%. Time is in years;
the result uses the same currency as spot and strike.

[Try the calculator →](https://totalfinance.io/docs/totalfinance/learn/price-an-option/)

## See the assumptions behind the answer

Add `.explain()` to inspect the result's model, conventions, and diagnostics:

```ts
const explained = blackScholes.call.explain({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});

explained.value; // the price
explained.assumptions; // model, day count, compounding, units
explained.diagnostics; // engine, method, warnings
```

For instrument-level control, choose the contract, market snapshot, and pricing engine explicitly:

```ts
import { option, market, engines } from '@insiderfinance/totalfinance/options';

const contract = option.usEquityCall({ underlying: 'AAPL', strike: 100, expiry: '2026-09-18' });
const snapshot = market({
  spot: 96.5,
  riskFreeRate: 0.045,
  dividendYield: 0.012,
  volatility: 0.28,
  asOf: 1781827200000,
});

const result = option.price({ contract, market: snapshot, engine: engines.auto() });
result.value;
result.greeks.delta;
result.assumptions;
result.diagnostics;
```

[Explore pricing engines and conventions →](./docs/guides/assumptions.md)

## What's inside

| Area                         | Tools                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Options & volatility**     | Black–Scholes–Merton, Black-76, Bachelier, American and exotic options, Greeks, implied volatility, Heston, SABR, volatility surfaces, and arbitrage checks |
| **Technical analysis**       | Hundreds of indicators, TA-Lib aliases and candlestick patterns, batch calculations, serializable streaming, and price/volume bars                          |
| **Market structure**         | Dealer exposures, GEX/DEX, walls, max pain, options flow, volume profiles, and order-book analytics                                                         |
| **Risk & portfolios**        | VaR/CVaR, stress tests, factor exposure, portfolio optimization, immutable ledgers, lots, and multi-currency valuation                                      |
| **Backtesting & research**   | Vectorized and event-driven engines, costs and slippage, walk-forward analysis, tear sheets, point-in-time screening, and event studies                     |
| **Fixed income & valuation** | Bonds, yield curves, rates derivatives, credit/CDS, NPV/IRR, loans, amortization, and capital budgeting                                                     |
| **FX, crypto & commodities** | Currency conversion and forwards, funding, futures basis, carry, and term structure                                                                         |
| **Math & calendars**         | Solvers, optimizers, interpolation, linear algebra, integration, seeded Monte Carlo, and exchange calendars                                                 |
| **Workflows & agents**       | A shared operation registry for SDK workflows, CLI, HTTP, and MCP                                                                                           |

The test suite checks calculations against reference vectors, independent models, and mathematical
properties. Technical-analysis coverage includes TA-Lib, pandas-ta, and tulipy comparisons, plus
batch/stream equivalence and serialization checks.

## Import what you need

Use domain imports for portable tree shaking:

```ts
import { rsi } from '@insiderfinance/totalfinance/technical-analysis';
import { valueAtRisk } from '@insiderfinance/totalfinance/risk';

const closes = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
];

rsi(closes).at(-1); // 57.92…
valueAtRisk([0.01, -0.02, 0.015, -0.005, 0.008]);
```

Feature imports such as `@insiderfinance/totalfinance/technical-analysis/rsi` let you go narrower.
Calculation entry points work in browsers; the CLI, HTTP, and MCP transports run in Node.js.
Node.js requires **22.13+**. The package is ESM with TypeScript declarations.

[Imports, runtimes, and bundle sizes →](./docs/guides/imports-and-bundles.md)

<details>
<summary>Root imports and tree shaking</summary>

The root exports domain namespaces and the option helpers `blackScholes`, `option`, `market`,
`engines`, and `impliedVolatility`. Accessing `math.normalCdf(0)` through a root namespace retains
the math namespace in esbuild. Rollup shakes this static use. Domain and feature imports offer
more predictable browser bundles.

</details>

## For AI agents

The optional `@insiderfinance/totalfinance-mcp` server exposes the same calculation engines through
the Model Context Protocol. Its default profile provides **23 read-only tools** for options,
strategies, volatility, indicators, risk, portfolios, calendars, and more. Profiles let you select
the tools your agent needs.

Run the MCP server from a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
node distribution/mcp/dist/bin.js doctor
node distribution/mcp/dist/bin.js
```

Add it to your MCP client's configuration:

```json
{
  "mcpServers": {
    "totalfinance": {
      "command": "node",
      "args": ["/absolute/path/to/totalfinance/distribution/mcp/dist/bin.js"]
    }
  }
}
```

The server computes from supplied data. It does not fetch market prices. The
[MCP guide](./docs/guides/mcp.md) covers client setup, profiles, permissions, and background jobs.
Agents can also use the [agent handbook](https://totalfinance.io/docs/totalfinance/agents/),
[llms.txt](./docs/llms.txt), and [full library reference](./docs/llms-full.txt).

## Documentation

- [Interactive docs](https://totalfinance.io/docs/totalfinance/) — start with a task, run a calculator, and explore the result.
- [API reference](https://totalfinance.io/docs/totalfinance/reference/) — exports, types, and operations.
- [Examples](./docs/examples/) — executable examples across the toolkit.
- [Assumptions & conventions](./docs/guides/assumptions.md) — units, models, dates, and day counts.
- [Errors & diagnostics](./docs/guides/errors.md) — understand a refusal and fix the input.
- [Site source](./site/) — the static HTML generator, browser calculators, and local preview instructions.

## Contributing

Bug reports, questions, and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
for the development workflow and [open an issue](https://github.com/InsiderFinance/totalfinance/issues)
to discuss a change.

```sh
git clone https://github.com/InsiderFinance/totalfinance.git
cd totalfinance
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm site:build
pnpm site:dev
```

See [stability](./STABILITY.md), [security](./SECURITY.md), and our
[code of conduct](./CODE_OF_CONDUCT.md) for project policies.

## License

[Apache-2.0](./LICENSE). Built by [InsiderFinance](https://www.insiderfinance.io/).

TotalFinance provides financial analytics, not investment advice.
