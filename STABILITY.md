# Stability

TotalFinance `0.1.0` is **pre-1.0 software**, not a 1.0 stability guarantee. Two public packages
move together: `@insiderfinance/totalfinance` and optional `@insiderfinance/totalfinance-mcp`.
This file ships in both artifacts. A local build or version number is not evidence of npm publication.

The main package contains components with different maturity. Combining them into one install
does not promote preview transports or workflows to production-ready status.

| Tier              | What it covers                                                                                                         | The promise                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stable-by-law** | Domain calculations and the root's calculation namespaces                                                              | Public-API laws, typed errors, explicit units, validation and generated-contract gates apply. This is contract conformance, not a guarantee that names or shapes cannot change before 1.0. |
| **preview**       | `@insiderfinance/totalfinance/workflows` (including `/local`), `/cli`, `/http`, and `@insiderfinance/totalfinance-mcp` | Wire IDs, schemas, exit/status codes and error documents are versioned contracts. Changes require release notes and a changeset; they are never silent.                                    |
| **experimental**  | Exports explicitly tagged `@experimental` in their API reports                                                         | May change or disappear without a deprecation cycle. Inspect the generated API reports for the current list.                                                                               |

Result envelopes preserve their `assumptions` and `diagnostics`; facade calls expose them through
`.explain()`. Refusals are typed `QuantError`s with registered codes. Calculations use only
caller-supplied data. No component grants brokerage access or live-trading authority.

The 25 source workspaces are private build inputs, not separately installable npm products.
Browser root/domain imports do not load Node-only transports or MCP. See `SECURITY.md` for
private reporting and the release changelog for changes. The public semantic-versioning
stability promise begins at 1.0, not at this first release.
