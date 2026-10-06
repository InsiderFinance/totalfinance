---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Faster New York market-day lookups, and so faster flow analysis, with every result unchanged.

`usEquityMarketDayIndex` (and `usEquityMarketDateUtcMs`) read the New York calendar date from
`Intl` on every call, and `flow()` asks for it twice per print to flag 0DTE trades: on a
50,000-print session that was about three quarters of `flow()`. The day is now remembered per UTC
clock hour. The first instant asked about in an hour is read exactly, as before; the second visit
reads the hour's two ends and, when they agree, stores the date. A session of prints reads `Intl`
three times per hour instead of twice per print, and a one-off call costs what it did. An hour whose
New York date changes inside it (only possible before 1883, under local mean time) is still answered
exactly every time, and invalid input still throws the same error. `flow()`, `optionFlowDrift()`,
exposure's 0DTE buckets, earnings day counts and the backtest option chain all share the gain.
