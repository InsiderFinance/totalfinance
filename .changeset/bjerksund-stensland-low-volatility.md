---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Fix the Bjerksund–Stensland American approximations (2002, its `bjerksundStensland()` alias, and
1993). For valid low-volatility inputs they returned a NaN price, which the no-arbitrage postcondition
refused, or a NaN Greek. The cause was a reflection power `(I/S)^κ` that overflowed while its matching
normal tail underflowed. The published formulas are now evaluated in the log domain with
cancellation-free boundary algebra. Every previously failing case now prices to the exact model value,
and ordinary results are unchanged to rounding. Model, floor, Greek units and bumps, and result shapes
are unchanged.
