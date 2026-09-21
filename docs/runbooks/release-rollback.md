# Runbook — rolling back a TotalFinance preview release

**Owner:** the maintainer who approved the `npm-publish` environment for the release being rolled
back. Approval and rollback are the same person by design: whoever said "these hashes may ship" owns
taking them back. If that person is unavailable, the repository owner takes over and says so in the
release thread before touching anything.

The fixed group is twenty-five packages that publish together under one version and one dist-tag
(`preview`). Every step below applies to **the whole group**; a rollback of one package alone is not a
state this library is ever in.

## 0. Decide, and say it first

Post in the release thread (the GitHub release's discussion, or the issue that tracks the release)
before acting, using the template at the bottom: what is wrong, which version is affected, what
consumers should do now, and what the fix path is. A rollback without a message is a second incident.

## 1. Move the `preview` dist-tag back — always, and first

Consumers who install `@totalfinance/*@preview` get whatever the tag points at, so this alone stops new
installs of the bad version, for all twenty-five packages, in under a minute:

```sh
PREV=0.1.0-preview.N-1   # the last good version of the group
for p in $(pnpm -r --filter './packages/*' exec node -p "require('./package.json').name"); do
  npm dist-tag add "$p@$PREV" preview
done
npm dist-tag ls @totalfinance/core    # verify: preview -> $PREV
```

Verify on a clean machine: `npm view @totalfinance/core dist-tags --json` must show `preview` at the
previous version for every package (the smoke tool does this for all of them:
`pnpm release:smoke -- --version $PREV`).

## 2. Unpublish or deprecate the bad version

- **Inside 72 hours of publish and no dependents:** `npm unpublish <package>@<version>` for each
  package of the group. npm refuses to unpublish a version that another published package depends on;
  the group's internal dependencies make the order matter — unpublish the umbrella and the
  transports first (`totalfinance`, `@totalfinance/cli`, `@totalfinance/http`, `@totalfinance/mcp`,
  `@totalfinance/workflows`), then the domain packages, then `@totalfinance/math` and `@totalfinance/core` last.
  An unpublished version number can never be reused: the fix ships as the next number.
- **After 72 hours, or when unpublish is refused:** deprecate instead —
  `npm deprecate "<package>@<version>" "Rolled back: <one line>. Use <package>@<prev> (dist-tag preview)."`
  for every package. Deprecation warns on install; the dist-tag move from step 1 already stops new
  installs.

## 3. Remove the tag and the GitHub release

```sh
git push --delete origin totalfinance-v<version>     # the release tag
gh release delete totalfinance-v<version> --yes     # the GitHub release and its attached hash manifest
```

Leave the release commit itself on the branch; history is not rewritten. The next release commit
supersedes it.

## 4. Record it

Add a `docs/evidence/release-rollback-<version>.md` note: the timeline, the reason, the exact commands
run, and who ran them; link it from the release thread. The changeset for the fix names the rollback.

If public documentation was deployed for the affected version, restore the last good verified static
site artifact as the current site under the deployment owner's approval. Do not rebuild old-version
pages from the broken or corrected current source, delete historical smoke evidence, or relabel a
tarball rehearsal as a published release. Preserve version archives and announce the affected docs
version alongside the package rollback. The site does not automatically follow npm dist-tag changes;
verify the deployed current version explicitly. See [the site guide](../../site/README.md).

## 5. Re-release

The fix lands through the ordinary landing standard and a new `pnpm release:dry-run`; the workflow
publishes `0.1.0-preview.N+1` (never the rolled-back number) under the same approval gate.

## Message template

> **TotalFinance `<version>` has been rolled back.**
> What happened: `<one sentence — what a consumer could observe>`.
> Affected: every `@totalfinance/*` package and `totalfinance` at `<version>`.
> What to do now: `npm install @totalfinance/<pkg>@preview` (the tag points at `<prev>` again); pin
> `<prev>` if you pin.
> Fix: `<issue link>`; the corrected release will be `<next version>`.
> Owner: `<maintainer>`.
