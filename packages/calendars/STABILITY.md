# Stability

TotalFinance is published as an explicitly **pre-1.0 preview**. This file ships inside every package of
the fixed group so the promise travels with the artifact. The version you installed says which
series you are on (`0.1.0-preview.N`); the tiers below say what each surface promises within it.

| Tier              | What it covers                                                                                                                                                       | The promise                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stable-by-law** | every public function, type, and result envelope of the twenty domain and platform packages and the `totalfinance` umbrella                                          | it passes the public-API laws and their gates (naming, signature, closed-door enforcement, generated contracts) at every commit; a change lands with a changeset entry. The semantic-versioning promise itself begins at `1.0`. |
| **preview**       | the operation registry (`@totalfinance/workflows`) and the transports over it — the `totalfinance` CLI, `totalfinance-http` and its OpenAPI document, the MCP server | the wire ids, input and output schemas, exit codes, status codes, and error documents are held through the preview series; a change ships as a new preview minor with a changeset entry, never silently.                        |
| **experimental**  | any export whose API report marks it `@experimental`                                                                                                                 | may change or disappear between previews without a deprecation cycle. At `0.1.0-preview.0` this list is empty; it is generated from the API reports, never authored by hand.                                                    |

What every tier shares: results carry their `assumptions` and `diagnostics`; refusals are typed
`QuantError`s with registered codes; nothing computes from data you did not pass in.

Twenty-five packages move together: `@totalfinance/core`, `math`, `calendars`, `options`, `volatility`,
`structure`, `technical-analysis`, `performance`, `risk`, `strategy`, `backtest`, `fixed-income`,
`crypto`, `fundamentals`, `valuation`, `research`, `foreign-exchange`, `commodities`, `portfolio`,
`scenarios`, the umbrella `totalfinance`, `@totalfinance/workflows`, `@totalfinance/cli`, `@totalfinance/http`, and
`@totalfinance/mcp`. See `SECURITY.md` for how to report a problem and `CHANGELOG.md` in each package for
what changed.
