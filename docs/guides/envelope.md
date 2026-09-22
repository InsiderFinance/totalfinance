# Results & the `.explain()` envelope

## The four public roles (one grammar per role)

Every runtime operation in TotalFinance is exactly one of four roles, and each role has ONE result
grammar (alignment spec Law 2 — settled by both PR-303 reviews):

| Role         | Who it's for                                                                                             | Call shape → result                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Facade**   | most users                                                                                               | one input object (or series + options) → **plain value**; the same call's `.explain()` → `Computed<T>` |
| **Analysis** | results whose diagnostics are inseparable (calibration, optimization, exposure, backtests, crypto carry) | one input object → **`Computed<T>` directly** — no plain form, nothing to forget                       |
| **Artifact** | reusable calibrated/stateful values (surfaces, curves, positions, streams)                               | factory config → immutable object with methods + versioned `toJSON`/`fromJSON`                         |
| **Kernel**   | experts & internal composition                                                                           | one named object for confusable finance inputs on expert subpaths; direct numeric result               |

After learning one domain you can predict every other: `probabilityInTheMoney({...})` is a facade (plain
number, `.explain()` when the risk-neutral caveat matters); `calibrateSvi(...)` is an analysis
(envelope always); a `VolatilitySurface` is an artifact; `blackScholesPrice({ type, spot, strike, timeToExpiryYears, riskFreeRate,
dividendYield, volatility })` is a kernel behind `@insiderfinance/totalfinance/options/black-scholes`.

TotalFinance has one rule for the shape of every result, and it never varies:

- **Plain call → plain value.** `blackScholes.call({ … })` → a number. `sharpe(returns)` → a number.
  `rsi(closes)` → a number array. No wrapper, no ceremony — the value you asked for.
- **`.explain()` → the envelope.** The same call with `.explain()` returns the rich `Computed<T>`
  envelope: `{ value, assumptions, diagnostics }`. `assumptions` echoes every convention that was
  applied — so a defaulted `periodsPerYear: 252` or `riskFreeRate: 0` is **disclosed, never hidden**;
  `diagnostics.warnings` carries any caveats. For example:

  ```ts
  sharpe(returns); // => 1.23
  sharpe.explain(returns).assumptions; // => { conventionsVersion: '0.0.1', periodsPerYear: 252, riskFreeRate: 0 }
  blackScholes.call.explain({
    spot: 100,
    strike: 100,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.05,
    volatility: 0.2,
  }).diagnostics.warnings; // => []
  ```

- **Pro API → the envelope always.** `option.price({ contract: contract, market: market, engine: engine })`,
  `exposure(chain, market, config)`, `calibrateSsvi(surface)` and the other analysis-role `f(subject, market, config?)`
  functions return `Computed<T>` directly — there is no plain form, because a professional result must
  always carry the assumptions it was computed under.

**One envelope type.** `Computed<T>` is used for every rich result across every package, so a
serialized result is self-interpreting and MCP / serialization consumers treat all results the same
way. (Warnings always live under `diagnostics.warnings` — never hoisted to a top-level `warnings`.)

**Technical indicators fit the same envelope.** `@insiderfinance/totalfinance/technical-analysis`'s `.explain()` returns the ordinary
`{ value, assumptions, diagnostics }` envelope too — there is no separate `SeriesResult` type. Its
`value` is the aligned, NaN-padded series (each output lined up with its input bar), and the length of
the leading NaN warmup is reported as `diagnostics.warmup` — the index of the first finite bar, exactly
what a chart needs to line an indicator up with price:

```ts
const rsi = technicalAnalysis.rsi.explain(closes, { period: 14 });
rsi.value; // number[] aligned to closes; the first `rsi.diagnostics.warmup` entries are NaN
rsi.diagnostics.warmup; // => 14 (RSI-14: the first finite value sits at index 14)
```
