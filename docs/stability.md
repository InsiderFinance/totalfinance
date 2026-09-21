# Stability tiers

TotalFinance ships as an explicitly **pre-1.0 preview**: the published series is `0.1.0-preview.N` under the
npm dist-tag `preview`, and the twenty-five packages move together as one fixed group. The short form of
this page, [`STABILITY.md`](../STABILITY.md), is copied into every published package so the promise
travels with the artifact; this page is the long form and the two never disagree (the preview surface
audit checks that every package carries the identical file).

## The three tiers

| Tier              | What it covers                                                                                                                                                       | The promise                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stable-by-law** | every public function, type, and result envelope of the twenty domain and platform packages and the `totalfinance` umbrella                                          | it passes the public-API laws and their gates (naming, signature policy, closed-door enforcement, generated contracts, API reports) at every commit; a change lands with a changeset entry. The semantic-versioning promise itself begins at `1.0`. |
| **preview**       | the operation registry (`@totalfinance/workflows`) and the transports over it — the `totalfinance` CLI, `totalfinance-http` and its OpenAPI document, the MCP server | the wire ids, input and output schemas, exit codes, status codes, and error documents are held through the preview series; a change ships as a new preview minor with a changeset entry, never silently.                                            |
| **experimental**  | any export whose API report marks it `@experimental`                                                                                                                 | may change or disappear between previews without a deprecation cycle. The list is generated from the API reports under `packages/*/etc`, never authored by hand; at `0.1.0-preview.0` it is empty.                                                  |

What every tier shares, because the [public-API laws](./library-alignment-spec.md) require it: results
carry their `assumptions` and `diagnostics`; refusals are typed `QuantError`s with registered codes;
nothing computes from data you did not pass in; a warning never licenses a non-finite number.

## Tier by package

| Package                                                          | Tier                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `@totalfinance/core`                                             | stable-by-law                                              |
| `@totalfinance/math`                                             | stable-by-law                                              |
| `@totalfinance/calendars`                                        | stable-by-law                                              |
| `@totalfinance/options`                                          | stable-by-law                                              |
| `@totalfinance/volatility`                                       | stable-by-law                                              |
| `@totalfinance/structure`                                        | stable-by-law                                              |
| `@totalfinance/technical-analysis`                               | stable-by-law                                              |
| `@totalfinance/performance`                                      | stable-by-law                                              |
| `@totalfinance/risk`                                             | stable-by-law                                              |
| `@totalfinance/strategy`                                         | stable-by-law                                              |
| `@totalfinance/backtest`                                         | stable-by-law                                              |
| `@totalfinance/fixed-income`                                     | stable-by-law                                              |
| `@totalfinance/crypto`                                           | stable-by-law                                              |
| `@totalfinance/fundamentals`                                     | stable-by-law                                              |
| `@totalfinance/valuation`                                        | stable-by-law                                              |
| `@totalfinance/research`                                         | stable-by-law                                              |
| `@totalfinance/foreign-exchange`                                 | stable-by-law                                              |
| `@totalfinance/commodities`                                      | stable-by-law                                              |
| `@totalfinance/portfolio`                                        | stable-by-law                                              |
| `@totalfinance/scenarios`                                        | stable-by-law                                              |
| `totalfinance` (umbrella)                                        | stable-by-law — each namespace inherits its source package |
| `@totalfinance/workflows` (registry, runtime, `./local`)         | preview                                                    |
| `@totalfinance/cli` (`totalfinance`)                             | preview                                                    |
| `@totalfinance/http` (`totalfinance-http`, the OpenAPI document) | preview                                                    |
| `@totalfinance/mcp` (`totalfinance-mcp`)                         | preview                                                    |

## What "stable-by-law" means before 1.0

The domain packages are not frozen by a version number; they are held by executable laws. Every export
is classified in the manifest, its argument shape is checked by the signature policy, its refusals are
proven by the enforcement probe, and its public contract is regenerated into the API reports and the
generated docs on every commit. A change to any of them is therefore visible in the diff of a generated
artifact and must carry a changeset entry, so a preview consumer reads the changelog rather than
discovering a change at runtime. What the tier does **not** promise before `1.0` is that a name or shape
will never change: the preview series exists so that the last corrections can land with a changelog
entry instead of a major-version bump.

## How a tier changes

- An export becomes **experimental** by carrying the `@experimental` TSDoc tag; the API report records
  it and the generated list updates. It leaves the tier the same way.
- The **preview** surfaces become **stable-by-law** when the registry's wire contracts join the
  same gates the domain packages pass (the Stage 7B/connected-transport work), not by a date.
- **Deprecation** before `1.0` is a changeset entry plus a `@deprecated` tag that names the
  replacement and the preview minor that removes it; nothing is removed silently.

See [`SECURITY.md`](../SECURITY.md) for how to report a problem and the per-package `CHANGELOG.md` for
what changed in each preview.
