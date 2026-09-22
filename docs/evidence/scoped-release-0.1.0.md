# TotalFinance 0.1.0 — publication preparation evidence

Status: final local verification in progress. **This is not approval or proof of public publication.**
The implementation is on `release/scoped-0.1.0`; the permanent repository is
`InsiderFinance/totalfinance`, not the retired application copy. The controlling contract is
[scoped-single-package-release.md](../specs/scoped-single-package-release.md); the operator commands
are in [the release runbook](../runbooks/release.md).

## What is prepared

- One self-contained `@insiderfinance/totalfinance@0.1.0`, with 193 executable/type entry points,
  granular imports, all domains/workflows, and explicit Node-only CLI/HTTP surfaces. Its 25 internal
  source workspaces remain private. Main has no runtime dependencies.
- Optional `@insiderfinance/totalfinance-mcp@0.1.0`, depending on the exact main version and MCP SDK.
- Public imports, IDE examples, error/help guidance, generated reference, site examples, version
  metadata, Changesets configuration, publication gates, candidate/promotion separation and recovery.
- Financial formulas, input/output shapes, runtime validation and numerical convention versions are
  unchanged. An AST comparison of 184 changed source files found only the CLI version-reading fix
  beyond comments/string text; the package version is now 0.1.0. The measured contract evidence has
  2,441 enforced boundaries, zero measured defects, and is unchanged from the pre-cutover contract.

The thirteen portfolio golden hashes changed because their reports contain the renamed public
import guidance. The checked-in `tools/release/migrate-portfolio-goldens.ts` proved that restoring
only that text reproduces every prior full-result hash, and separately checked every final value,
session/fill/event count. It refused any other change before writing the new exact hashes; the
permanent tests still compare the complete unnormalized result.

## Exact local artifacts

Clean-source rehearsal commit: `8453714661ef70bb2d0bed86faf2c434e9bc00aa`.
Earlier implementation commits are `0c9f258` (packaging) and `6bc5082` (npm metadata normalization).
The final helper hardening changes no shipped artifact bytes: all three clean packs are identical.

| Artifact                                    | Compressed bytes | SHA-256                                                            |
| ------------------------------------------- | ---------------: | ------------------------------------------------------------------ |
| `insiderfinance-totalfinance-0.1.0.tgz`     |        5,775,834 | `433c65305b2ad06dfbeb9ba527eacdfdd85193c915f8856be469ed1c082392fc` |
| `insiderfinance-totalfinance-mcp-0.1.0.tgz` |           71,867 | `fdaf23f1ba32fd5b67d00e82db2dea2042edd0149e49316b03cea7b0d64b5208` |

Local ignored evidence is under `release/scoped-0.1.0-8453/` in the publication checkout:
`RELEASE_HASHES.json` and `LOCAL_SMOKE_RECEIPT-0.1.0.json`, with `sourceDirty=false`.
The receipt is deliberately **not** a public-registry receipt or a site-release ledger entry.
Fresh public workflow approval must identify its own exact commit and artifacts; do not reuse a
local manifest under a different HEAD, even when the payload hashes match.

## Verification record

- Locked dependency install and Changesets status: pass; no pending version bump.
- Installed package/tree-shaking matrix: real tarballs, no source aliases; root/domain/feature
  imports, strict NodeNext and bundler types, shared error identity, browser isolation, workers,
  CLI/HTTP/MCP and installed esbuild/Rollup budgets are exercised by the suite.
- Public site: 965 routes, 6,737 export paths, 46 registered operations; 80 site tests pass.
- Local publish/install rehearsal: Verdaccio 6.10.4 on loopback only, no first-party uplink.
  Actual upload, exact downloaded-byte verification, existing-version resume and repeated local
  account authentication pass. The installed smoke uses minimum Node 22.13.0 and passes all 24
  copied site examples, 23 default operations, 55 OpenAPI paths and 23 default MCP tools.
  Numeric outputs and MCP tool-name hashes match the committed baseline.
- Adversarial review and repairs: no unresolved artifact-assembly blocker; npm-normalized executable
  paths are accepted only in registry metadata, while tarballs remain byte-strict. GitHub finalization
  checks the dereferenced tag, release status, complete asset roster and bytes, and refuses conflicts.
  Public publishing reads candidate/latest before and after; no tag repair is automatic.
- Fresh-checkout regeneration at `0c9f258`: complete chain passed with a byte-identical clean tree.
  Subsequent changes are release recovery checks and reviewed test expectations, not generators or
  calculation implementations. Full CI and independent coverage repeat: pending final recording.

The final runs at `94b11c8` did not pass and are not release evidence: Node 22 passed 12,481/12,484
tests and Node 24 passed 12,482/12,484. Both caught the newly added evidence document missing from the
generated documentation inventory and a single trading-example test exhausting its 45-second budget;
Node 22 additionally caught an overstrong cancellation assertion and worker RPC timeouts under
concurrent full suites/regeneration. The inventory is regenerated, not hand-edited. The trading
journey is split into independent cases with identical policies, parameters, seeds, computations
and assertions. The MCP regressions now control both sides of actual worker persistence: early
cancellation leaves no report; late cancellation stays terminal and refuses job-result reads, while
already-persisted reports retain the documented ownership/profile visibility. No calculation or
cancellation implementation was changed and no timeout or coverage gate was increased. These
repairs require fresh complete verification before closeout; the earlier green subset is not a waiver.

Verdaccio synthesizes `latest` for a first version even when the client requests `candidate`.
Consequently its tag state is **not** public npm promotion evidence. The public path verifies tag
readback separately; [npm documents explicit tag selection](https://docs.npmjs.com/adding-dist-tags-to-packages/).

## Maintainer-held gates and trigger

Still unverified: current hosted CI on the final pushed revision; publishing rights for **both**
names in the npm organization; protected `main`; required reviewers/main-only restrictions on
GitHub's `npm-publish` environment; actual OIDC or explicitly approved first-pair bootstrap
authentication; and the separately approved website host/domain/browser acceptance.
Public registry reads returned 404 for both names during preparation. That is not proof of ownership.
No npm credentials were inspected or changed, no publication variable was enabled, and no public
package, GitHub release/tag or website was published by this preparation.

After those package-release gates are verified and the owner explicitly enables publishing:

1. Dispatch **TotalFinance release** on `main`, version **0.1.0**, with the explicitly selected
   authentication mode. Do not run Changesets versioning again for this initial cut.
2. Review/approve the exact two tarballs and manifest in `npm-publish`. The workflow publishes
   `candidate`, verifies the public registry and retains a candidate GitHub release and smoke receipt.
3. Separately approve/run `release:promote` with the original artifacts and public receipt. Verify
   both `latest` tags. This is the point when an unversioned npm install should become the default.
4. Record the actual public receipt in the site ledger and deploy/announce only after separate
   website approval. Local packaging evidence cannot certify a hosted site.

Follow the runbooks for interrupted publication/finalization or partial promotion. Never replace
approved artifacts, move a conflicting tag, overwrite an evidence asset, or normalize a receipt's
timestamp to make recovery pass.
