---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Faster New York market-day lookups, and so faster flow analysis, with every result unchanged.

`usEquityMarketDayIndex` (and `usEquityMarketDateUtcMs`) read the New York calendar date from
`Intl` on every call, and `flow()` asks for it twice per print to flag 0DTE trades: on a
50,000-print session that was about three quarters of `flow()`. The day is now remembered per UTC
clock hour and confirmed at both ends of the hour, so a session of prints reads `Intl` a few dozen
times instead of twice per print. An hour whose New York date changes inside it (only possible
before 1883, under local mean time) is still answered exactly every time, and invalid input still
throws the same error. `flow()`, `optionFlowDrift()`, exposure's 0DTE buckets, earnings day counts
and the backtest option chain all share the gain.
