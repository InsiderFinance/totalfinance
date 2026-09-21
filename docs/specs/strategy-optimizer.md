# Spec — Strategy optimizer (`@totalfinance/strategy`)

> Roadmap Tier 3 → "Strategy intelligence": _"invert the calculator: given a thesis (target price,
> date, risk budget, IV view), search builders × strikes × expiries for best EV / PoP / risk-reward.
> `scanStrategies` is the seed; generalize the objective and the search space."_ Status: **shipped** as
> `optimizeStrategy` in `packages/strategy/src/optimizer.ts`, covered by
> `packages/strategy/test/optimizer.test.ts`, full CI green.

## Goal

The profit calculator answers "given this trade, what's my payoff?" The optimizer **inverts** it:
"given my **view** (where I think the stock lands, by when, and how sure I am), which trade is best?"
It searches structures × strikes × **expiries** and scores each by its expected P&L **under the
trader's thesis** — not the market's risk-neutral distribution — so the ranking reflects _your_ edge,
not the consensus already in the prices.

## Why this is a generalization, not a re-implementation

`scanStrategies` (scanner.ts) already enumerates the classic defined-risk structures over a strike grid
for **one** expiry, scoring each with the exact `Position` payoff/probability engine and returning
**materializable legs** (so `strategy(candidate.legs)` reconstructs the exact position). The optimizer
adds the two things the roadmap calls for — a **thesis** and **multiple expiries** — as a thin layer:

1. For each expiry in the search space, call `scanStrategies` to enumerate + risk-metric + filter the
   candidates (the market-implied PoP/EV come along for free).
2. Re-score every candidate's expected P&L and PoP **under the trader's thesis distribution** by
   integrating `Position.pnlAtExpiry` against it.
3. Rank all candidates across all expiries by the chosen objective.

No second pricing path: the risk metrics are the scanner's; the thesis metrics integrate the same exact
piecewise-linear payoff.

## The thesis (the trader's view)

A terminal-price distribution the trader believes. v1 is a **lognormal centered at a target**:

- `targetPrice` — the median of the terminal price at expiry (the trader's central view). If omitted,
  the median is `spot·e^{drift·t}` (`drift` default 0 — a flat view).
- `volatility` — an annualized volatility capturing the trader's **uncertainty** (distinct from the market
  pricing vol). The spread at expiry is `σ_log = vol·√t`.

So at each expiry `t`, `ln(S_T) ~ Normal(ln(median), vol·√t)` — a "drift-to-target with uncertainty"
view. This is deliberately separate from the **pricing** `volatility`/`smile` (which fills missing premiums and
drives the market-implied metrics); the whole point is to score the market's trades against _your_
distribution. An escape hatch `pdf(S, t)` allows an arbitrary terminal density; because its support is
unknown, it **requires** an explicit `pdfRange { from, to }` and is integrated (in price space) over
exactly that range — so a non-lognormal, multi-modal view's mass is never truncated by the `volatility` window.

**Thesis metrics** (per candidate, integrating the exact payoff over the thesis density):

```
thesisExpectedValue  = E_thesis[ pnlAtExpiry(S_T) ]          (expected P&L under the view, per contract)
thesisProbabilityOfProfit = P_thesis( pnlAtExpiry(S_T) > 0 )      (probability of profit under the view)
thesisExpectedValuePerRisk = thesisExpectedValue / |maxLoss|            (risk-normalized; 0 when risk is unbounded)
```

computed by trapezoidal integration in log-price space (`u = ln S`, where the thesis is exactly Normal)
over `±6σ`, normalized by the integrated mass (so truncation and the constant factor cancel).

## API

```ts
interface OptimizerThesis {
  targetPrice?: number; // median terminal price (the central view); default spot·e^{drift·t}
  volatility: number; // annualized uncertainty of the view (σ_log = vol·√t)
  drift?: number; // annualized drift when targetPrice is omitted (default 0)
  pdf?: (price: number, t: number) => number; // escape hatch: arbitrary terminal density
  pdfRange?: { from: number; to: number }; // REQUIRED with pdf — its support (0 < from < to)
}
interface OptimizerExpiry {
  expiry: string; // YYYY-MM-DD
  chain: ScanQuoteRow[]; // the scanner's per-strike rows
  volatility?: number; // pricing vol for this expiry (falls back to options.vol)
  smile?: (strike: number) => number;
}
type OptimizerObjective =
  | 'thesisExpectedValuePerRisk'
  | 'thesisExpectedValue'
  | 'thesisProbabilityOfProfit'
  | ScanObjective; // pop|ev|return|expectedValuePerRisk
interface OptimizeStrategyOptions {
  spot: number;
  asOf: number;
  riskFreeRate: number;
  dividendYield?: number;
  expiries: OptimizerExpiry[]; // the multi-expiry search space (≥ 1)
  thesis: OptimizerThesis;
  volatility?: number;
  smile?: (strike: number) => number; // default pricing vol/smile
  structures?: ScanStructure[]; // which structures to enumerate (default: all the scanner's)
  maxWidth?: number;
  minProbabilityOfProfit?: number;
  maxRisk?: number; // scanner filters (minProbabilityOfProfit is market-implied)
  minThesisProbabilityOfProfit?: number; // keep only candidates whose THESIS PoP ≥ this
  objective?: OptimizerObjective; // default 'thesisExpectedValuePerRisk'
  top?: number; // top-N across all expiries (default 25)
  gridPoints?: number; // integration resolution (default 801)
}
interface OptimizedStrategy extends ScanCandidate {
  expiry: string;
  timeToExpiryYears: number;
  thesisExpectedValue: number;
  thesisProbabilityOfProfit: number;
  thesisExpectedValuePerRisk: number;
}
interface OptimizeStrategyResult {
  candidates: OptimizedStrategy[]; // top-N, ranked by `objective` (descending)
  thesis: { median: 'target' | 'drift'; volatility: number; targetPrice?: number; drift?: number };
  assumptions: {
    conventionsVersion: string;
    objective: OptimizerObjective;
    expiries: number;
    gridPoints: number;
  };
  diagnostics: Diagnostics;
}
function optimizeStrategy(options: OptimizeStrategyOptions): OptimizeStrategyResult;
```

## Honesty / envelope contract

- **Thesis ≠ market** — thesis metrics use the trader's `volatility`/`targetPrice`; the scanner's PoP/EV (the
  market-implied numbers) ride along on each candidate, so the two are visible side by side, never
  conflated. `assumptions.objective` records what the ranking optimized.
- **Materializable** — every candidate carries the scanner's resolved `legs`, so
  `strategy(candidate.legs)` reproduces the exact position (charting, mark-to-market, order entry).
- **No fabricated edge** — a thesis that matches the market (thesis vol ≈ pricing vol, target ≈ forward)
  drives thesisExpectedValue toward the market EV; the optimizer never manufactures a positive expectancy.
- Typed guards on every entry (garbage opts, empty `expiries`, `thesis.vol > 0`, objective enum, `top`);
  pure and deterministic (grid integration, injected `asOf`, no clock).

## Build checklist

1. **Types** — the interfaces above.
2. **Thesis integrator** — log-space trapezoidal `thesisExpectedValue`/`thesisProbabilityOfProfit` over `Position.pnlAtExpiry`.
3. **`optimizeStrategy`** — per-expiry `scanStrategies` (enumerate + filter, `top: all`), rebuild each
   candidate via `strategy(legs)`, attach thesis metrics + expiry/t, filter `minThesisProbabilityOfProfit`, rank across
   expiries by `objective`, slice `top`; envelope.
4. **Exports + API report + READMEs/llms.**
5. **Tests** — a bullish thesis (target above spot) ranks bullish structures above bearish ones; a
   candidate's `thesisExpectedValue` matches a direct integration of its payoff; thesis vol ≈ pricing vol + target ≈
   forward drives thesisExpectedValue toward the market EV (no fabricated edge); multi-expiry search returns
   candidates from more than one expiry and ranks across them; `minThesisProbabilityOfProfit`/`maxRisk` filter; the top
   candidate is materializable (`strategy(legs)` reproduces `maxLoss`); envelope/guards.

## Deferred (explicitly)

- **Kelly-optimal sizing** per candidate (given the thesis distribution and bankroll) — pairs with the
  risk package's Kelly.
- **Undefined-risk structures** (naked/ratios) behind an opt-in, with margin-aware ranking (`optionsMargin`).
- **Custom search space** (calendars/diagonals across the multi-expiry chain) once the scanner grows them.
- **A distribution from the chain** (risk-neutral or a blend with the view) once the data layer lands.
