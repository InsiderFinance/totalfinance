# Contributing to TotalFinance

TotalFinance is built spec-first under a small set of executable laws, and every change lands through
the same gates the maintainers use. This page is that process in one screen; the long form is
[`docs/library-alignment-spec.md`](./docs/library-alignment-spec.md) and the work queue is
[`docs/implementation-order.md`](./docs/implementation-order.md).

## Before you write code

1. **Find the row.** Work is queued in `docs/implementation-order.md`; a change that is not on the
   queue starts as an issue that says which row it belongs to, or why it is a new one.
2. **Spec first.** Anything larger than a bug fix begins as a decision-complete contract under
   `docs/specs/` (outcome, non-goals, numbered decisions, ordered slices, an exit gate). The spec is
   reviewed before the first line of implementation; roadmap bullets are never implemented directly.
3. **Read the laws.** The public-API laws in the alignment spec are not style: a result carries its
   `assumptions` and `diagnostics`; a refusal is a typed `QuantError` with a registered code; a
   warning never licenses a non-finite number; every door re-validates what it is handed; nothing
   computes from data the caller did not pass in; no verb is exported that refuses every input.

## While you build

- **Node 22.13+ and pnpm 10.** From this repository's root, `nvm use` (or select the version in
  `.nvmrc`), `corepack enable`, `pnpm install --frozen-lockfile`, then `pnpm build`.
  `.nvmrc` pins the canonical artifact-generation runtime; CI additionally tests the minimum
  supported Node and newer versions. Open pull requests against `main`.
- **Tests live beside the code** (`packages/<name>/test/`), goldens under `tools/golden/`. A new
  export needs its tests, its manifest row (`tools/manifest/packages/<name>.json`, hand-classified
  — never `manifest:update`, which wipes curation), a first-touch fixture when it takes more than one
  positional argument, and a `@totalfinance/core` error code when it can refuse.
- **Regenerate in order** after the source is final:
  `signature:update → naming:update → contract:update → enforcement:update → validation:update →
api:update → readme → llms → bundle:update → openapi:update → docs:update`. Check
  `summary.defective` is `0` after `enforcement:update`; a generated file is never edited by hand.
- **Format only what you changed** with `pnpm exec prettier --write <files>`; never the whole repo.
- **A changeset for every user-visible change:** `pnpm exec changeset` (the fixed public group is
  the main library and MCP). Versions bump only in the authorized release commit. There is no
  Changesets pre-mode; pre-1.0 stability labeling is separate from npm version/tag selection.

## The landing standard

### Pull requests: temporary maintainer-only fast gate

Approved 2026-10-06 while the maintainers are the only contributors; revisit before accepting
outside contributions. An ordinary PR may land after review and all **current-head** PR checks pass:

- The whole test suite on minimum-supported Node 22.13.0, split into five duration-balanced shards.
  Coverage is not collected, and enforcement regeneration runs once: the drift assertion stays,
  but the second-generation determinism assertion waits for the full gate.
- Format, lint, TypeScript checks, builds, site tests, and the API-report check.
- Clean-repository artifact regeneration on `.nvmrc` and the local-registry release rehearsal.

This is a deliberate reduction in pre-merge checks, not equivalent evidence delivered faster.
Node 24/26-only failures, a coverage drop, or a determinism regression can first appear after merge.
Fix a red `main` before merging unrelated work. Keep any controlling trackers consistent and name
the actual verified commit; do not describe a fast run as a full CI pass.

### Full gate: main, daily, manual, and before changing the gate itself

Pushes to `main`, the daily 09:23 UTC schedule, and manual runs test Node 22.13.0, 24.x, and 26.x.
Each version has five test shards with coverage and both independent enforcement generations.
The merge job requires all five nonempty report files before enforcing the unchanged coverage
floors. Static checks run once per Node version; regeneration and the release rehearsal also run.

**Before merging changes to CI, sharding/test selection, coverage, enforcement generation, or
supported Node versions, run the full workflow on the PR branch and require every job to pass at
the exact proposed head.** A green fast PR run is not sufficient to verify a change to the gate.
Use Actions → TotalFinance CI → Run workflow → select the PR branch, or:

```sh
gh workflow run totalfinance-ci.yml --repo InsiderFinance/totalfinance --ref <pr-branch>
```

Record the run URL and head SHA in the PR. A later code commit requires a new run. Do not wait until
after merging to discover whether a changed full-gate path works.

### Local full verification and releases

`pnpm run ci` is unchanged: it runs the full local checks, including coverage and determinism.
Use targeted checks while iterating; rely on the hosted matrix for cross-version verification.
Do not set `TOTALFINANCE_PR_CHECKS` or `TOTALFINANCE_COVERAGE_SHARD` in a local full run or release
environment; they are workflow-internal switches for fast PR tests and partial coverage shards.

Release candidates still require the full gate, plus the independent repeat below. Check exit
codes directly, never through a pipe:

1. `pnpm run ci` exits 0 — format, lint, typecheck, build, coverage, and the API-report check.
2. `pnpm api:check` exits 0 on its own.
3. A second `pnpm test:coverage` is all green (the stochastic suites are seeded; a one-off flake is
   documented in `docs/`, not waved through).
4. Every controlling tracker the change touches says the same thing: the spec's slice record, the
   implementation order, and the completeness tracker name one commit.

## What we say no to

Compute duplicated inside an artifact, a workflow, or a transport; a new transport that does not go
through the operation registry; a benchmark quoted from a loaded machine; a gate weakened to pass
(raise the bound only from a measurement, and say where the measurement came from); provider
connectors, credentials, or network reads inside the library.

## Reporting

Bugs and questions: GitHub issues on the TotalFinance repository. Security: never an issue — see
[`SECURITY.md`](./SECURITY.md). Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Publication layout (current)

The first release is `@insiderfinance/totalfinance@0.1.0` plus optional
`@insiderfinance/totalfinance-mcp@0.1.0`. The 25 `packages/*` workspaces are private source modules;
only `distribution/*` is published. Their old internal aliases remain useful for source-level
contracts, not user installs. The [single-package release contract](docs/specs/scoped-single-package-release.md)
supersedes older fixed-group and preview-version instructions. Initial 0.1.0 metadata is already
prepared: do not run `changeset version` again for that cut. For subsequent releases, after Changesets updates the
two public versions, run `pnpm publication:update` and `pnpm install --no-frozen-lockfile`, then the
full gates. `pnpm build` assembles the distributable modules; it refuses stale metadata.
