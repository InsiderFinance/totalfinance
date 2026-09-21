# Assumptions and Conventions

TotalFinance does not hide finance conventions. Pro APIs return a `Computed<T>` envelope with `value`, `assumptions`, and `diagnostics`; facade APIs return plain values but expose the same envelope through `.explain()`.

## 0.0.1 Defaults

- Day count: `ACT/365F`
- Compounding: continuous
- Dividend model: `none` when `dividendYield` is omitted or zero; `continuousYield` when provided
  (every pricing door, including `optionChainHealth`, echoes the yield it used and warns when it
  defaulted)
- Model: `black-scholes-merton`
- Contract multiplier: a share is 1 by construction; a registered option carries its own. An
  instrument known only from a market spot is a share, and an OCC option symbol never takes that
  share default — a plan, preflight, paper broker, or rebalance refuses it (or leaves the target
  unresolved) until `contractMultiplier` is declared, because the default of 1 would value a
  100-share contract at 1% of its cash. Every fill carries the multiplier it was valued at
  (`Trade.multiplier`, `TradePlanTrade.contractMultiplier`).
- Greek units:
  - `theta`: per calendar day
  - `vega`: per one volatility point
  - `rho`: per one percent rate change

## Time

Compute packages never read the system clock. The pro API requires `market.asOf`; facade APIs accept `t` directly.

**Expiries name their instant.** A date-only expiry (`'2026-09-18'`) resolves to the US equity/options close under the `us-equity-close` convention: 16:00 America/New_York, or 13:00 on an early-close day (the day after Thanksgiving, and 3 July / 24 December when they are trading days). Both are DST-aware. A zoned datetime (`'2026-09-18T16:00:00-04:00'`) is taken as written. The generic contract builders refuse a bare date unless the convention is named; `usEquityCall`/`usEquityPut` carry it in their names. `exerciseTime: 'AM'` is settlement metadata and does not move `expiresAt`.

**Valuation instants name their time of day.** Every option-pricing path (`market()`, `option.price`, implied volatility, strategy positions, volatility surfaces and events, structure exposure, scenarios, book marking) takes `asOf` as epoch milliseconds or a zoned ISO datetime. A bare `'YYYY-MM-DD'` is refused with the fix: a same-day option's value depends on the time of day, and a bare date resolved to UTC midnight is 20:00 ET the previous evening. `usEquitySessionInstant('2026-09-18', 'close')` is the one-call form for an end-of-day mark; `'open'` gives 09:30 ET. Date-granular consumers (ledgers, calendars, fundamentals, performance and research windows) still accept a bare date, meaning that calendar date. A market snapshot created from a bare date records `conventions.asOfConvention: 'date-midnight-utc'`; a scenario or pricer that needs the valuation instant refuses such a snapshot with the fix, while dated ledger marks use it as designed.

**Field forms.** Instants (`expiresAt`, every `*TimestampMs`, `asOf` once resolved) are integer epoch milliseconds. Labels (`expiry`, `eventDate`, `exDate`) are `YYYY-MM-DD` strings or zoned datetimes. A JavaScript `Date` is accepted nowhere; pass `date.getTime()`. Time to expiry is `ACT/365F` years everywhere it is echoed; 252 appears only in realized-volatility annualization.

## Why This Matters

The same numeric result can differ across desks because of day count, dividend treatment, compounding, expiry timestamp, and Greek unit conventions. TotalFinance makes those choices inspectable so results are easier to audit, reproduce, and explain.
