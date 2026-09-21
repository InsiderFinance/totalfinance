---
'@totalfinance/backtest': patch
'@totalfinance/calendars': patch
'@totalfinance/cli': patch
'@totalfinance/commodities': patch
'@totalfinance/core': patch
'@totalfinance/crypto': patch
'@totalfinance/fixed-income': patch
'@totalfinance/foreign-exchange': patch
'@totalfinance/fundamentals': patch
'@totalfinance/http': patch
'@totalfinance/math': patch
'@totalfinance/mcp': patch
'@totalfinance/options': patch
'@totalfinance/performance': patch
'@totalfinance/portfolio': patch
'@totalfinance/research': patch
'@totalfinance/risk': patch
'@totalfinance/scenarios': patch
'@totalfinance/strategy': patch
'@totalfinance/structure': patch
'@totalfinance/technical-analysis': patch
'@totalfinance/valuation': patch
'@totalfinance/volatility': patch
'@totalfinance/workflows': patch
totalfinance: patch
---

Reduce unused analytic-pricing wrapper and shared validation-code overhead without changing public
APIs, financial results or runtime guards. Make built-in indicator validation and disclosure metadata
self-contained, so importing a leaf does not require the full discovery registry. Add installed-package esbuild/Rollup bundle budgets,
retained-module and misuse checks, and clear guidance for portable small imports and the
esbuild umbrella namespace limitation. No release version or publication is performed by this change.
