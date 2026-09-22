# Changesets

This folder holds [changesets](https://github.com/changesets/changesets). Each changeset is a
markdown file describing a change and the semver bump it implies for the two public artifacts:
`@insiderfinance/totalfinance` and `@insiderfinance/totalfinance-mcp`. They are one fixed group;
private `packages/*` workspaces are never release targets.

Create one with `pnpm exec changeset`. They are consumed at release time to version packages and generate
changelogs.

## Initial 0.1.0 release

The accepted scoped-release contract selects **0.1.0**, without Changesets pre-mode. This is still
pre-1.0 software, not a stable-core/1.0 declaration. The old development changesets have been
consolidated into the reviewed initial release notes at `.release-0.1.0.md` (a hidden, non-pending
ledger file ignored by Changesets); they must not remain
pending and accidentally advance the initial artifacts to 0.2.0. Do not run `changeset version`
again for the initial cut. This record is release preparation, not publication evidence.

For subsequent user-visible changes, add a changeset naming both public packages. With explicit
release-version authorization, run `pnpm exec changeset version`, then `pnpm publication:update`
to synchronize private build/runtime versions and regenerate distribution metadata, and update the
lockfile before the complete landing standard. Never run versioning as part of publication.
The [release runbook](../docs/runbooks/release.md) owns approvals and candidate/latest mechanics.
