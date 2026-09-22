# Stability tiers

TotalFinance `0.1.0` is **pre-1.0 software**, not a 1.0 stability guarantee. The main toolkit
and optional MCP server are the two public packages; the 25 source workspaces remain private.
The main package includes preview workflows and transports: one install does not mean one maturity tier.
A checkout version is not proof of publication. The short form of
this page, [`STABILITY.md`](../STABILITY.md), is copied into every published package so the promise
travels with the artifact; this page is the long form and the two never disagree (the preview surface
audit checks that every package carries the identical file).

## The three tiers

| Tier              | What it covers                                                                                                                                                                      | The promise                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stable-by-law** | every public function, type, and result envelope of the domain calculation entry points and root calculation namespaces                                                             | it passes the public-API laws and their gates (naming, signature policy, closed-door enforcement, generated contracts, API reports) at every commit; a change lands with a changeset entry. The semantic-versioning promise itself begins at `1.0`. |
| **preview**       | the operation registry (`@insiderfinance/totalfinance/workflows`) and the transports over it — the `totalfinance` CLI, `totalfinance-http` and its OpenAPI document, the MCP server | the wire ids, input and output schemas, exit codes, status codes, and error documents are held through the preview series; a change ships as a new preview minor with a changeset entry, never silently.                                            |
| **experimental**  | any export whose API report marks it `@experimental`                                                                                                                                | may change or disappear between previews without a deprecation cycle. The list is generated from the API reports under `packages/*/etc`, never authored by hand; consult those reports for the current list.                                        |

What every tier shares, because the [public-API laws](./library-alignment-spec.md) require it: results
carry their `assumptions` and `diagnostics`; refusals are typed `QuantError`s with registered codes;
nothing computes from data you did not pass in; a warning never licenses a non-finite number.

## Tier by public entry point

All paths below except MCP belong to `@insiderfinance/totalfinance`; they are not separate installs.

| Package                                                                         | Tier                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@insiderfinance/totalfinance/core`                                             | stable-by-law                                              |
| `@insiderfinance/totalfinance/math`                                             | stable-by-law                                              |
| `@insiderfinance/totalfinance/calendars`                                        | stable-by-law                                              |
| `@insiderfinance/totalfinance/options`                                          | stable-by-law                                              |
| `@insiderfinance/totalfinance/volatility`                                       | stable-by-law                                              |
| `@insiderfinance/totalfinance/structure`                                        | stable-by-law                                              |
| `@insiderfinance/totalfinance/technical-analysis`                               | stable-by-law                                              |
| `@insiderfinance/totalfinance/performance`                                      | stable-by-law                                              |
| `@insiderfinance/totalfinance/risk`                                             | stable-by-law                                              |
| `@insiderfinance/totalfinance/strategy`                                         | stable-by-law                                              |
| `@insiderfinance/totalfinance/backtest`                                         | stable-by-law                                              |
| `@insiderfinance/totalfinance/fixed-income`                                     | stable-by-law                                              |
| `@insiderfinance/totalfinance/crypto`                                           | stable-by-law                                              |
| `@insiderfinance/totalfinance/fundamentals`                                     | stable-by-law                                              |
| `@insiderfinance/totalfinance/valuation`                                        | stable-by-law                                              |
| `@insiderfinance/totalfinance/research`                                         | stable-by-law                                              |
| `@insiderfinance/totalfinance/foreign-exchange`                                 | stable-by-law                                              |
| `@insiderfinance/totalfinance/commodities`                                      | stable-by-law                                              |
| `@insiderfinance/totalfinance/portfolio`                                        | stable-by-law                                              |
| `@insiderfinance/totalfinance/scenarios`                                        | stable-by-law                                              |
| `@insiderfinance/totalfinance` (root calculations)                              | stable-by-law — each namespace inherits its source package |
| `@insiderfinance/totalfinance/workflows` (registry, runtime, `./local`)         | preview                                                    |
| `@insiderfinance/totalfinance/cli` (`totalfinance`)                             | preview                                                    |
| `@insiderfinance/totalfinance/http` (`totalfinance-http`, the OpenAPI document) | preview                                                    |
| `@insiderfinance/totalfinance-mcp` (`totalfinance-mcp`)                         | preview                                                    |

## What "stable-by-law" means before 1.0

The domain packages are not frozen by a version number; they are held by executable laws. Every export
is classified in the manifest, its argument shape is checked by the signature policy, its refusals are
proven by the enforcement probe, and its public contract is regenerated into the API reports and the
generated docs on every commit. A change to any of them is therefore visible in the diff of a generated
artifact and must carry a changeset entry, so a preview consumer reads the changelog rather than
discovering a change at runtime. What the tier does **not** promise before `1.0` is that a name or shape
will never change: the pre-1.0 series exists so that corrections can land with a changelog
entry instead of a major-version bump.

## How a tier changes

- An export becomes **experimental** by carrying the `@experimental` TSDoc tag; the API report records
  it and the generated list updates. It leaves the tier the same way.
- The **preview** surfaces become **stable-by-law** when the registry's wire contracts join the
  same gates the domain packages pass (the Stage 7B/connected-transport work), not by a date.
- **Deprecation** before `1.0` is a changeset entry plus a `@deprecated` tag that names the
  replacement and the release that removes it; nothing is removed silently.

See [`SECURITY.md`](../SECURITY.md) for how to report a problem and the per-package `CHANGELOG.md` for
what changed in each preview.
