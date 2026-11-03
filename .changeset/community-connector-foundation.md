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

C3 adds the TotalFinance-owned `data.connect(provider)` research workflow at the root namespace
and `/data`, with bounded terminal price-bar windows, retained source pages and lazy strict native
array views for existing calculations. Advanced provider query remains one page. New workflow
budget refusal is distinct from upstream allowance exhaustion; no provider, credential or HTTP
implementation enters ordinary compute. C3 budget and final generated/hosted acceptance remain pending.
