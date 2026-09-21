# Changesets

This folder holds [changesets](https://github.com/changesets/changesets). Each changeset is a
markdown file describing a change and the semver bump it implies for affected `@totalfinance/*` packages.

Create one with `pnpm changeset`. They are consumed at release time to version packages and generate
changelogs.

## Version freeze (pre-release)

All `@totalfinance/*` packages stay pinned at **`0.0.1`** for the entire pre-release build. The roadmap
milestones (`0.1`, `0.2`, … in `totalfinance-implementation-spec.md` §24) are **development milestones,
not npm versions** — the published version remains `0.0.1` until the first real release.

Because a changeset would bump the version on the next `changeset version` run (e.g. a `minor` from
`0.0.1` → `0.1.0`), **do not add changesets until we are actually cutting a release.** Track work in
`totalfinance-implementation-tasklist.md` instead. Human-readable per-phase milestone notes live in
`docs/milestones/` (named by development phase, not version, since we stay on `0.0.1`).
