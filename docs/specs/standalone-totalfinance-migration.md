# TotalFinance — standalone repository migration

Status: implementing. The maintainer selected `InsiderFinance/totalfinance` and confirmed that
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
- [ ] Rename every supported package, import, branded type, CLI, MCP/HTTP identity, environment
      variable, storage prefix, public page, example and current instruction.
- [ ] Rewire repository metadata, root-layout workflows, changesets and contributor commands.
- [ ] Add regression checks for standalone layout, canonical branding and workflow routing.
- [ ] Regenerate every derived artifact and refresh only measured expectations that changed
      because their namespaced source changed; preserve financial numerical assertions.
- [ ] Pass full CI, installed-package tests, byte-stable regeneration and an independent second
      test pass from the standalone tree. Record exact revisions and results below.
- [ ] Inspect the staged public tree for accidental app files, secrets and obsolete dependencies.
- [ ] Commit and push the standalone repository; verify the remote head and inspect hosted checks.
- [ ] Update the execution handoff with the repository result and the remaining release gates.

## Verification and handoff

Pending. Repository initialization is not npm publication or a claim that the site is deployed.
