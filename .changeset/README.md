# Changesets

This folder holds [changesets](https://github.com/changesets/changesets). Each changeset is a
markdown file describing a change and the semver bump it implies for affected `@totalfinance/*` packages.

Create one with `pnpm changeset`. They are consumed at release time to version packages and generate
changelogs.

## Version freeze (pre-release)

All `@totalfinance/*` packages stay pinned at **`0.0.1`** for the entire pre-release build. The roadmap
milestones (`0.1`, `0.2`, … in `totalfinance-implementation-spec.md` §24) are **development milestones,
not npm versions** — the published version remains `0.0.1` until the first real release.

Record user-visible changes in a changeset as required by `CONTRIBUTING.md`. Adding a changeset
does not change package versions or publish anything. **Do not run `changeset version` or publish
without explicit release authorization.** The fixed group remains at its current development
version until the approved preview release commit. `docs/implementation-order.md` owns the work
queue; the release runbook owns version selection and publication.
