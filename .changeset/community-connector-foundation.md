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
implementation enters ordinary compute. Terminal pagination does not assert continuous coverage, source freshness or trade eligibility.

Improve connector authoring with a natural homogeneous raw-page return type, controlled actionable
mapping diagnostics and an independently installed no-key starter. Reject contradictory adjustment
facts and negative normalized option premiums; order same-term contracts by actual source IDs without
inventing identities. Preserve unknown financial inputs, caller-fixture blame and source metadata.

C5 simplifies authoring with protocol2 sources, original queries on every page and SDK-owned
normalization. Add finite capability negotiation, cross-copy safe errors, actual timestamped bars,
explicit consumed-work checkpoints/resume and field-specific research-quality choices with retained
originals/decisions. Keep clean data.connect/priceBars/existing-SMA use unchanged and all acquisition
synthetic/offline until separately configured access; no financial defaults or implicit execution.
