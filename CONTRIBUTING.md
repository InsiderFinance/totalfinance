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
- **Iterate on the tests for what you changed** (`pnpm exec vitest run <test files>`), plus
  `pnpm exec vitest run tools/bundle-size/budgets.test.ts` when bundle size can move. The full
  suite and the regeneration chain are the slow parts. Run the suite in hosted CI, and the chain
  once.
- **Regenerate in order, once,** after the source is final:
  `signature:update → naming:update → contract:update → enforcement:update → validation:update →
api:update → readme → llms → bundle:update → openapi:update → docs:update`. Check
  `summary.defective` is `0` after `enforcement:update`; a generated file is never edited by hand.
- **Format only what you changed** with `pnpm exec prettier --write <files>`; never the whole repo.
- **A changeset for every user-visible change:** `pnpm exec changeset` (the fixed public group is
  the main library and MCP). Versions bump only in the authorized release commit. There is no
  Changesets pre-mode; pre-1.0 stability labeling is separate from npm version/tag selection.

## The landing standard

A change is ready when all of these hold:

1. Hosted CI is green on the pull request's final commit. It runs everything `pnpm run ci` runs
   (format, lint, typecheck, build, the full test suite with coverage, and the API-report check;
   the tests split across parallel runners) on the minimum
   supported Node and on newer versions, and regenerates every derived artifact in a clean
   checkout (`pnpm regen:check`). Each Node version runs the whole suite independently, which is
   the repeat run. The stochastic suites are seeded; a one-off flake is documented in `docs/`, not
   waved through.
2. Locally, the tests for what changed pass, and the derived artifacts were regenerated once from
   the final source, with `summary.defective` at `0`. Check every local command by its exit code,
   never through a pipe.
3. Every controlling tracker the change touches says the same thing: the spec's slice record, the
   implementation order, and the completeness tracker name one commit.

Running `pnpm run ci` locally is still the way to reproduce a hosted failure. It is not a second
gate to pass before you push.

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
