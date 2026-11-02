---
'@insiderfinance/totalfinance': minor
'@insiderfinance/totalfinance-mcp': minor
---

Add opt-in research data-provider contracts and a bounded compatibility kit at core/data and
core/data-conformance. Keep provider packages external and all ordinary compute imports free of
credentials and fetching. Preserve incomplete financial terms, unknown times, source quality and
coverage limitations; these contracts grant no execution authority.

Add the SDK-owned consumer data view: direct-source binding, direct query/optional discovery,
explicit native closePrices/OHLCV arrays and retained raw source pages. Preserve field-specific
missing-input refusals without blanket quality/history bans or provider dependencies in compute.
