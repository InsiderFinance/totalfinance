# PR #336 — sector performance readiness

Status: integrated into PR #303 at `fc46353b` (2026-09-08), explicitly authorized by the maintainer.
Full local CI and regeneration pass; hosted checks remain a release prerequisite.
Target: PR #336, `codex/totalfinance-sector-performance-snapshot`, based on the open TotalFinance PR #303
branch, not directly on `develop`. This review does not authorize publication or application rollout.

## Decision

The capability belongs in `@totalfinance/performance`: grouping comparable security returns into
sector returns is reusable finance computation. The original proposal had useful deterministic,
point-in-time behavior, but its only entrypoint imposed an application-specific policy and extensive
audit metadata on every caller. It was not ready as submitted.

The repaired public surface follows the permanent [alignment laws](../library-alignment-spec.md):

- `sectorPerformance({ members })` is the ordinary same-period-return calculator. It requires no
  invented provider, calendar, observation or classification lineage.
- `sectorPerformanceSnapshot({ ... })` selects completed sessions, effective-dated classifications
  and both split-adjusted closes under explicit source/knowledge cutoffs. Its extra coordinates
  serve actual audit requirements, not the simple calculation's first call.
- Both paths share aggregation, rounding, deterministic ordering, competition ranks and neutral
  policy identity. They return assumptions and warnings, and can be stored in analysis artifacts.
- Public financial coordinates use named objects; consumed numeric/date/identity fields are
  validated; controls are closed and structural observations are open without traversing metadata.
- No provider aliases, application universe inference, implicit clock, live I/O, currency conversion,
  cache or additional MCP tool is introduced.

See the [runnable public guide](../guides/sector-performance.md) for actual usage and return units.

## Defects repaired

| Original issue                                                      | Repair                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Required `insiderfinance-sector-performance-v1` policy input        | Vendor-neutral policy stamped in results, not required from callers.                                 |
| Audit-only first call                                               | Separate simple and snapshot entrypoints with one aggregation implementation.                        |
| Report lacked `diagnostics.warnings`                                | Standard report grammar and artifact-compatible result types.                                        |
| Sparse observations could leak raw errors or be ignored             | Dense-array, consumed-field and combined-row-budget validation with indexed typed errors.            |
| Repeated full observation scans per security                        | Indexed classification/close selection and realistic large-universe benchmark.                       |
| Close ratios erased small but real price changes                    | Difference-first return calculation, with finite-range safeguards and independent numeric oracles.   |
| Generic epsilon rounding could change a tie into a different rank   | One shared eight-decimal rounding rule, checked against exact binary-value/decimal-rounding cases.   |
| Stale base and generated artifacts                                  | Integrate the current PR #303 base, resolve conflicts, regenerate contracts, API/reference and docs. |
| Standalone manifest generator could resolve a parent app's packages | Resolve each built package through its own exports map, with a standalone regression test.           |

## Acceptance checklist

- [x] Simple and audit APIs, shared aggregation, golden historical selection and explicit exclusions.
- [x] Independent return/tie/rounding cases, sparse/bad-input teaching, decoration and non-mutation.
- [x] Indexed full-universe scaling and bounded input traversal.
- [x] Root/deep exports, executable first-touch fixtures and runnable public guide.
- [x] Final adversarial review findings resolved.
- [x] Full formatting, lint, type/build, site, coverage, API and generated-artifact gates.
- [x] Clean-revision regeneration and packed public-consumer verification.

## Verification and handoff

The integrated sector-focused run passes 399 tests covering input boundaries, historical selection,
simple returns, numerical edge cases and scaling. A realistic fixture with 10,000 securities,
30,000 classifications and 240,000 closes completes in 371 ms on the review machine; this is local
evidence, not a cross-machine latency promise. Strict NodeNext and Bundler consumers install the
actual packed packages, call both root/deep APIs, and save their reports directly as artifacts.
All 30 bundle budgets pass, including the dedicated sector subpath's 10.5 KiB gzip budget.

The final integrated revision `d81a0db5` passes `pnpm run ci`: 544 test files / 11,897 library
tests, all 38 site tests, formatting, lint, typechecks, builds, packed consumers and all 25 package
API checks. Coverage is 94.10% statements / 83.79% branches / 96.90% functions / 94.66% lines,
above every enforced floor. `pnpm regen:check` passes on that clean commit with no file changes.
The final inventory has 7,784 public paths, 41,297 naming identities (zero unresolved) and 5,326
measured enforcement candidates (zero defective). The PR #303 base independently passes full CI
and byte-stable regeneration on `c993367d`. Subsequent closeout edits are tracking prose only.

The original recommendation was to merge after hosted checks passed. On 2026-09-08 the maintainer
explicitly authorized merging #336 into #303 while those checks remained red. Merge `fc46353b`
preserves the latest #303 search fixes and the #336 sector implementation without source conflicts.
The exact merge revision passes `pnpm run ci` (544 files / 11,897 library tests, 63 site tests,
the same coverage percentages above and all 25 API checks) and `pnpm regen:check` (byte-stable).
The combined site's sector query returns `sectorPerformance` first; the closeout makes that check
unconditional now that the feature is present.

This is a local Node 26.5.0 certificate, not a claim that the supported-Node hosted matrix,
public registry, external UX study or live provider replacement has already been verified.
No array-example changes are included; follow the single #303 implementation queue for that review.

After this PR is integrated, the application/API team still owns real data acquisition/licensing,
eligible-universe rules, security/listing mapping, compatible provider response projection, cache
freshness, shadow comparison on captured production inputs, rollout and rollback. Those are not
hidden requirements for this pure calculator, and this PR does not implement or deploy them.
