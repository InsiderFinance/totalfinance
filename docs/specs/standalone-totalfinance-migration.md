# TotalFinance — standalone repository migration

Status: source migration committed and pushed; local verification complete; hosted diagnostic portability fix in verification.
The maintainer selected `InsiderFinance/totalfinance` and confirmed that
TotalFinance replaces the provisional library name everywhere, not just in the repository URL.
This bounded migration precedes the versioned release rehearsal in `implementation-order.md`.

## Scope and decisions

- Import only the verified library snapshot and its two library workflows. The source commit is
  `6fe3cdc5d3fd99e921ad2a5947ab3c7b69a6d803`; the source library tree is
  `9b45dfa8b4c5de8f8cdd6e3f6c1d53eecdcfbaf3`. The final compute revision was `af0d7cd2a`.
  No private application files, credentials, or private Git history belong in this repository.
- This repository is the standalone source of truth, with the library at its root and `main`
  as its default branch. Do not remove or rewrite the old app checkout as part of the move.
- Use `TotalFinance` in prose and public type names, `totalFinance` for camel-case branded
  identifiers, `totalfinance` for the umbrella package, commands, resource schemes and operation
  prefixes, `@totalfinance/*` for scoped packages, and `TOTALFINANCE_*` for environment variables.
  Rename the umbrella directory and workflows too. There are no deprecated-name aliases.
- This is an unpublished library: renamed artifact kinds, schema identities and content hashes
  deliberately replace the provisional wire namespace. Recompute generated contracts and
  measured fixtures from the renamed source; never pretend the old hashes identify new bytes.
  Historical release-rehearsal evidence remains byte-for-byte historical and is not release
  approval for TotalFinance.
- Keep financial algorithms, argument shapes, defaults, units, guard policies, package boundaries
  and all twenty-five package versions unchanged. No version bump, npm publish, live trading,
  hosted service, or documentation deployment is authorized by this migration.
- CI runs at the repository root. Test the declared minimum Node and newer supported versions;
  use the pinned contributor runtime for byte-stable artifact generation. Release publishing stays
  manual and approval-gated. Organization permissions and approval reviewers remain release gates.

## Ordered acceptance checklist

- [x] Confirm the destination is empty, public and owned by InsiderFinance; preserve `main`.
- [x] Extract the committed library tree without the parent application or its history.
- [x] Rename every supported package, import, branded type, CLI, MCP/HTTP identity, environment
      variable, storage prefix, public page, example and current instruction.
- [x] Rewire repository metadata, root-layout workflows, changesets and contributor commands.
- [x] Add regression checks for standalone layout, canonical branding and workflow routing.
- [x] Regenerate every derived artifact and refresh only measured expectations that changed
      because their namespaced source changed; preserve financial numerical assertions.
- [x] Pass full CI, installed-package tests, byte-stable regeneration and an independent second
      test pass from the standalone tree. Record exact revisions and results below.
- [x] Inspect the staged public tree for accidental app files, secrets and obsolete dependencies.
- [x] Commit and push the standalone repository; verify the remote head and inspect hosted checks.
- [x] Update the execution handoff with the repository result and the remaining release gates.

## Verification and handoff

The migrated code is `6eeb459064062511a3889562b64333b6b8c07e10`, pushed and verified on
`InsiderFinance/totalfinance:main`. Independent full `pnpm run ci` passes on Node 22.13.0 and
24.21.0 are green, each with a successful process exit: 552 files / 12,088 library tests, 79 site
tests, format/lint/typechecks/builds and all 25 API reports. Minimum-runtime coverage is 94.10%
statements, 83.88% branches, 96.96% functions and 94.66% lines; Node 24 statements are 94.09%,
with the other three percentages unchanged.

- Clean-tree `pnpm regen:check` passed on Node 22.23.2 at that same commit. The complete chain
  changed no tracked bytes. Naming records 41,983 identities with zero unresolved names;
  enforcement records 5,302 candidates, 2,441 enforced, 2,674 partial, 187 unmeasured and zero
  measured defects. Those categories are retained, not converted into a claim of exhaustive validation.
- `pnpm release:dry-run --skip-ci` and `pnpm release:smoke --version 0.0.1 --tarballs release`
  passed from the clean committed source. All 25 packages installed; the SDK/CLI/HTTP/MCP journeys
  matched, and all 24 exact site examples typechecked and executed against those installed artifacts.
  This is a local tarball rehearsal, not public-registry or publication evidence.
- The website builds 1,185 routes, 9,814 export paths and 46 operation references. All public
  package imports, identifiers and examples use the new namespace; versions remain unchanged.
- Hosted [TotalFinance CI](https://github.com/InsiderFinance/totalfinance/actions/workflows/totalfinance-ci.yml)
  started all five real jobs after the first push: Node 22.13.0, 24.x and 26.x, regeneration, and
  local-registry release rehearsal. Startup is no longer blocked as it was in the parent repository.
  The local-registry release rehearsal passed twice. Hosted regeneration exposed last-digit
  floating-point differences in diagnostic return previews, not changed enforcement claims; the
  portability repair is described below and still requires its hosted rerun.
  Inspect the latest run on `main`; this local record does not certify its final hosted conclusion.
- The original app checkout and private PR were not modified or pushed. Their existing package
  artifacts, imports, flags and adapters require a separate app-owned namespace migration before
  adopting these packages. Historical dogfooding measurements remain evidence, not runnable app
  setup instructions for the public repository.

### Findings resolved during extraction

The initial package-source comparison covered all 980 TypeScript files and found only branding and
formatting differences. The 13 complete portfolio journeys were also compared against the frozen
source: every non-brand result field was identical. Only the namespace-bound result hashes changed;
all numerical golden assertions are preserved. The default MCP tool-name hash was similarly
recomputed from the same 23 renamed tools. Historical release-manifest bytes remain unchanged.
API-report headings and console labels now read each package's actual metadata name, including the
unscoped umbrella, rather than assuming that every directory is a scoped package.

The minimum-runtime verification then found one runtime output defect and one test-fixture defect:
MCP `doctor` could exit before its large JSON report drained, and the persistence-test worker could
disconnect before sending a large IPC reply. Doctor now exits naturally; the fixture disconnects
only after the send callback. The existing regression cases and a new 256 KiB IPC case pass on
Node 22.13.0. No timeout, financial algorithm, store transaction or public contract was weakened.
The [Node process documentation](https://nodejs.org/docs/latest-v22.x/api/process.html#processexitcode)
explains why natural exit is required for pending output.

An initial concurrent minimum-Node run passed all 12,088 assertions but reported a Vitest
`onTaskUpdate` communication timeout. That run is not counted as green. The isolated complete rerun
at the same commit passed with exit code zero and no reporter errors; this is the minimum-runtime
closing evidence above. No reporter error was suppressed and no test budget was increased.

Hosted regeneration then exposed 18 `returned`-preview differences: Linux x64 and macOS arm64
produced the same enforcement results but slightly different final floating-point digits. For
example, a preview contained `0.2476734303459216` versus `0.24767343034592149`. The return-preview
renderer now uses 12 significant digits for finite fractional numbers, before its existing
120-character truncation. This is only the diagnostic string in the measurement artifact, not a
library return value, financial calculation, solver tolerance, or golden numerical assertion.
Integers and non-finite scalar evidence retain their previous representation. Regression tests
cover both observed platform pairs, nested previews, meaningful numerical differences, safe
integers, tiny values, non-finite scalars and non-mutation of the actual result. Exact verdict,
identity, dimension, error-code and whole-record determinism gates remain enabled.
The regenerated artifact changes 4,956 diagnostic preview strings and no other JSON leaf: every
summary, verdict, rejection, mutation and identity is identical. The final minimum-Node focused
run passes 106 tests; Node 24 independently passes the 35 probe/repository tests. The metadata
heading repair at `e8e4805` also passed the complete clean-tree regeneration chain.

### Next owner actions

`docs/implementation-order.md` still owns the sequence: confirm npm scope/umbrella publishing
ownership, required reviewers and rollback ownership; complete the remaining domain/hosting/browser
acceptance; then separately approve the exact preview-version bump and rehearse its committed
artifacts. The manual release workflow requires `TOTALFINANCE_RELEASE_ENABLED=true` on `main`
in addition to the `npm-publish` environment. This migration did not enable that flag, configure
credentials, publish packages, deploy a site, or enable live execution.
