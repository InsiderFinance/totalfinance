---
'@insiderfinance/totalfinance': minor
'@insiderfinance/totalfinance-mcp': minor
---

Add `valuation.convertPriceLevel` and the focused `valuation/price-levels` import for approximate two-way price-level mapping using explicit reference prices or a directed target-per-source ratio. The browser-safe facade includes `.explain()`, optional descriptive unit labels, typed boundary validation, numeric overflow/underflow refusals, and an optional schema import at `valuation/schemas`. No ticker ratios, quote retrieval or instrument economics are inferred.

Add three-price named helpers in both directions for ES/SPY, NQ/QQQ, YM/DIA, RTY/IWM, SPX/SPY, NDX/QQQ, RUT/IWM and DJIA/DIA. Helpers include `.explain()` and separate closed schemas, share the generic arithmetic, and supply descriptive units without hardcoding market ratios. Generic unit labels are optional metadata; an unlabeled explained result reports `resultUnit: null`. DJIA means the full Dow Jones Industrial Average, not DJX.
