# Phase 0 — Architecture spike

> Development milestone, not an npm version — the published version stays `0.0.1` through pre-release.

Phase 0 is an architecture spike, not a broad finance release. It proves the core public contracts on one narrow vertical slice before the library expands.

## Included

- `@totalfinance/core`
  - typed errors and stable error codes
  - assumptions and diagnostics envelopes
  - option contract types
  - zero-dependency schema facade under `@totalfinance/core/schema`
- `@totalfinance/math`
  - normal PDF/CDF/inverse CDF
  - root solver utilities used by implied volatility
- `@totalfinance/options`
  - Black-Scholes and Black-Scholes-Merton pricing
  - first-order Greeks
  - implied volatility
  - facade API: `bs.call`, `bs.put`, `bs.price`, `bs.greeks`, `bs.impliedVolatility`
  - pro API: `option.call`, `option.put`, `option.price`, `option.impliedVolatility`
  - schema entrypoint: `@totalfinance/options/schema`
- `@totalfinance/mcp`
  - read-only MCP server
  - generated input schemas
  - structured diagnostics

## Verified

- TypeScript strict mode
- Unit, golden, docs example, MCP, API report, and bundle-size tests
- Hot Black-Scholes entrypoint stays below the 8 KB gzip budget and does not import schema machinery

## Not Included Yet

- American or Bermudan option engines
- Vol surfaces and smiles
- Rates curves
- Calendars and market-close-aware expiry handling
- Option chains and lazy chain transforms
- Data adapters
- Technical analysis, backtesting, strategy, risk, and portfolio analytics
- Native/WASM acceleration
