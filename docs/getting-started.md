# Getting Started

Install the `totalfinance` umbrella package — one install for the whole toolkit. The options API is
re-exported flat; every other package is a namespace (`technicalAnalysis`, `risk`, `volatility`, `strategy`, …):

```sh
pnpm add totalfinance
```

```ts
import { blackScholes, risk, technicalAnalysis } from 'totalfinance';

blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
}); // => 0.8983...
technicalAnalysis
  .rsi([
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  ])
  .at(-1); // => 57.92 — RSI-14 needs 15+ closes (fewer is an all-NaN warmup)
risk.valueAtRisk([0.01, -0.02, 0.015, -0.005, 0.008]);
```

If you want the leanest possible bundle, install only the packages you need instead — every
`@totalfinance/*` package is independently published and tree-shakeable, with deep per-feature
entrypoints. The options package includes the Black-Scholes facade and the pro option-pricing API:

```sh
pnpm add @totalfinance/options
```

## Facade API

Facade APIs accept flat object inputs and return plain values. Use them for notebooks, dashboards, quick calculations, and hot paths where you want minimal ceremony.

```ts
import { blackScholes } from '@totalfinance/options';

const price = blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});
```

Every facade function also has an `.explain()` companion that returns the same value with assumptions and diagnostics.

```ts
const explained = blackScholes.call.explain({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});

explained.value;
explained.assumptions.dayCount; // ACT/365F
explained.diagnostics.converged; // true
```

## Pro API

The pro API separates contracts from markets and always returns a rich envelope.

```ts
import { engines, market, option } from '@totalfinance/options';

// usEquityCall encodes the US listed convention (American exercise, 16:00 ET close, ×100);
// exercise style is never silently defaulted — option.call requires an explicit `style`.
const contract = option.usEquityCall({
  underlying: 'AAPL',
  strike: 100,
  expiry: '2026-09-18',
});

const result = option.price({
  contract,
  market: market({
    spot: 96.5,
    riskFreeRate: 0.045,
    dividendYield: 0.012,
    volatility: 0.28,
    asOf: Date.UTC(2026, 5, 18),
  }),
  engine: engines.auto(), // optional — auto is the default
});

result.value;
result.greeks.delta;
result.assumptions;
result.diagnostics;
```

## Runtime Schemas

Runtime schemas live behind explicit schema entrypoints so the compute path stays small.

```ts
import { schemas } from '@totalfinance/options/schema';

const parsed = schemas.OptionContract.parse({
  underlying: 'AAPL',
  type: 'call',
  style: 'european',
  strike: 100,
  expiry: '2026-09-18',
});
```

## Current scope & limits

Implemented today (phases 0–5 are complete): European pricing (Black–Scholes–Merton, Black-76,
Bachelier) with first- and higher-order Greeks and a multi-method implied-vol suite
(`auto`/`brent`/`newton`/`halley`/`householder`); American/exotic engines (Barone–Adesi–Whaley,
Bjerksund–Stensland 1993 & 2002, binomial CRR/JR/Tian/Leisen–Reimer, trinomial, Crank–Nicolson) with
discrete-dividend handling and `option.compareEngines`; stochastic-vol models (Heston, SABR, Dupire
local vol) and seeded Monte-Carlo/QMC pricing with barrier/Asian/lookback exotics; the
`@totalfinance/math` numerical foundation; implied-vol surfaces with SVI/SABR calibration, skew/smile
metrics and event vol (`@totalfinance/volatility`); options market structure — GEX/DEX/vanna/charm exposure,
walls, max pain, scenario maps, flow (`@totalfinance/structure`); exchange calendars; 335 registered
technical indicators (batch + streaming); performance metrics; risk & portfolio analytics —
VaR/CVaR, stress/scenario testing, factor/PCA, optimization and research hygiene (`@totalfinance/risk`);
an options strategy/payoff calculator; backtesting — a vectorized research engine and an
event-driven execution simulator with walk-forward and tear sheets (`@totalfinance/backtest`); and fixed
income — bonds + analytics, yield-curve bootstrapping, rates derivatives, short-rate models, and
credit (`@totalfinance/fixed-income`).

Boundaries that still hold:

- `riskFreeRate` and `volatility` are scalar market inputs on the options market object (yield curves live
  in `@totalfinance/fixed-income`; the scalar vol feeds the `@totalfinance/volatility` surface as fitted IVs).
- Discrete dividends use the documented escrowed-spot approximation across BSM and the American
  engines; the textbook `engines.blackScholes()` ignores dividends by design.
- Date-only expiries resolve to the named instrument convention — `usEquityCall`/`usEquityPut`
  stamp the 16:00 ET close (`expiryConvention: 'us-equity-close'`); the generic `european()`
  builder requires the convention (or a zoned datetime) explicitly.
- No data fetching, brokerage integration, trading, persistence, or system-clock access exists in
  compute packages — `asOf` is always injected.
