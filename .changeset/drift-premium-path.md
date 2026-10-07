---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

`optionFlowDrift` is about twice as fast, with every result and error unchanged.

Drift ran all of `flow()` for each call and used only its per-print validation, premium and side
classification. It now runs just that shared path, so it no longer computes block, 0DTE,
open/close, sweep or spread analytics it never reported. On a 50,000-print session with one-minute
buckets, drift drops from about 70 ms to about 37 ms. The full result and every error (name, code
and message) match the published 0.1.2 on 71 pinned cases, and `flow()` itself is unchanged.
