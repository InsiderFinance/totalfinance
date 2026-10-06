# Runbook — releasing the two scoped TotalFinance artifacts

The accepted [0.1.0 contract](../specs/scoped-single-package-release.md) supersedes the old
twenty-five-package/preview release mechanics. Publish exactly these artifacts, in dependency order:

| Order | Workspace                   | Public package                     | Initial version |
| ----- | --------------------------- | ---------------------------------- | --------------- |
| 1     | `distribution/totalfinance` | `@insiderfinance/totalfinance`     | `0.1.0`         |
| 2     | `distribution/mcp`          | `@insiderfinance/totalfinance-mcp` | `0.1.0`         |

Main has zero runtime dependencies. MCP has the exact main version plus the MCP SDK. All
`packages/*` workspaces, `@totalfinance/*` aliases and the old `totalfinance` package identity are
private implementation details. Never use recursive workspace publishing. This release is
pre-1.0 software; neither `latest` nor a GitHub non-prerelease flag is a 1.0 stability promise.

The sequence is **approved bytes → candidate → public-registry smoke → explicit latest promotion**.
`candidate` is a public npm dist-tag, not npm's separate `npm stage publish` service, and does not
hide the uploaded versions. Publication and tag promotion are not atomic. Read
[partial-publish recovery](./release-rollback.md#1-partial-publication-main-succeeded-mcp-failed)
before approving the first package.

## 0. External gates — still maintainer-held

Nothing in this runbook enables publishing, creates credentials, changes npm settings, or deploys
a website. Keep `TOTALFINANCE_RELEASE_ENABLED` unset/false until a maintainer explicitly authorizes
the exact release commit and verifies all of the following:

- Public repository `InsiderFinance/totalfinance`, protected `main`, green current hosted Node
  matrix, complete clean-tree landing standard, deterministic regeneration and installed-artifact
  rehearsal at that commit.
- Actual rights to create/publish **both** names in the `@insiderfinance` npm organization. A
  public `npm view` 404 proves no visible version, **not** ownership, name availability or token rights.
- GitHub `npm-publish` environment with required reviewers and main-only deployment protection.
  Reviewers inspect the retained artifact's two names, version, commit, sizes and full SHA-256 hashes.
- An explicit authentication route for both artifacts. The normal route is trusted publishing:
  GitHub owner `InsiderFinance`, repository `totalfinance`, workflow filename
  `totalfinance-release.yml`, environment `npm-publish`, with direct `npm publish` permitted.
  Saved settings alone do not prove a successful authentication handshake.
- A separately authorized operator and npm login/2FA for later dist-tag promotion/recovery. Do not
  assume the publication OIDC identity can mutate dist-tags.

Publication uses pinned **Node 24.21.0** and checks **npm ≥11.5.1** before uploading. Building uses
the canonical `.nvmrc` runtime (22.23.2); public smoke tests the consumer floor (22.13.0).
These are deliberately different. See the [Node release](https://nodejs.org/en/blog/release/v24.21.0)
and [npm trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/).

### First-pair bootstrap when the package names do not yet exist

Both names were reported as public-registry 404s during preparation. Ownership and credential
rights remain unverified. Per-package trusted-publisher setup may require the packages to exist;
do not claim that OIDC alone has solved first publication.

An authorized maintainer must first confirm npm's current first-publication requirements. If a
bootstrap granular access token is needed, explicitly approve a short-lived, minimally scoped token
able to create **both** package names, place it only in the protected `npm-publish` environment as
`NPM_BOOTSTRAP_TOKEN`, and dispatch with `bootstrap=true`. This selected route still runs the full
verification and artifact approval gate, pins the publishing toolchain, publishes approved tarballs
with provenance under `candidate`, and smokes the public registry. It never silently falls back
from OIDC to a token. Do not put credentials in the repository or terminal transcripts.

After both names exist, configure/verify their trusted publishers and revoke/remove the bootstrap
token under separate maintainer authority. Future dispatches use `bootstrap=false` (the default).
If only main succeeded, retain the token only as needed for the explicitly approved MCP recovery;
follow the rollback runbook. Do not bootstrap by publishing dummy versions or unrelated packages.

## 0. The one-command release (maintainer's machine)

From a clean, up-to-date `main` with pending changesets, and with version-change authorization:

```sh
tools/release/release.sh            # the bump the changesets ask for
tools/release/release.sh --patch    # or release every pending change as a patch (--minor likewise)
```

It versions the public pair (`changeset version`, `publication:update`, the lockfile), rewrites the
version in README, SECURITY and STABILITY, rebuilds, regenerates what carries the version (naming
manifest, API reports, package READMEs, llms docs, OpenAPI), runs the release-pin checks, commits
`Release <version>`, pushes `main`, and publishes the main package with
`tools/release/publish-npm.sh` (a clean build, `release:dry-run --skip-ci --expect-version`, then
`npm publish ./release/<tarball> --provenance=false`). npm may ask for a one-time password.
`--no-publish` stops after the push; `--dry-run` stops before committing. A rehearsal took about a
minute end to end. Hosted CI runs the full suites and `regen:check` on the pushed commit.

The sections below are the hosted, provenance-attested release path and its checks.

## 1. Prepare one reviewed release commit

The initial distributions and runtime version metadata are **0.1.0** already. Changesets has one
fixed two-package group, no pre-mode, and does not version/tag private packages. Initial development
entries were consolidated into `.changeset/.release-0.1.0.md` (not a pending changeset); do **not** run `changeset version`
again for this cut and accidentally create 0.2.0.

For future releases only, with version-change authorization:

```sh
pnpm exec changeset status
pnpm exec changeset version
pnpm publication:update
pnpm install --offline
```

Review the two public versions, MCP's exact main dependency, synchronized private/runtime versions,
generated manifests and lockfile. Future notes come from
`distribution/totalfinance/CHANGELOG.md`; initial notes come from the reviewed initial ledger.
Do not perform versioning or rebuilding after artifact approval.

The release commit meets the landing standard in `CONTRIBUTING.md` like any other change, and it
lands on `main`, so the full gate runs on it: everything `pnpm run ci` runs (the API-report check
included) on every supported Node version, and `pnpm regen:check` in a clean checkout. Run these
locally only to reproduce a hosted failure.

Commit/review/land through the normal maintainer process. Publication requires a clean checkout and
the manifest's exact HEAD. `--allow-dirty` marks a rehearsal and can never become public approval
evidence merely by committing later.

## 2. Local rehearsal — not public release proof

Use Node from `.nvmrc`, pinned pnpm, and a fresh output directory. Packing refuses to overwrite
existing tarballs or manifests. It packs only the distributions, validates packed metadata,
dependencies, archive paths/types, exports, declarations/maps, licenses, stability and README,
then records `RELEASE_HASHES.json` with names, version, commit, source cleanliness, lengths and hashes.

```sh
pnpm release:dry-run --expect-version 0.1.0
pnpm release:smoke --version 0.1.0 --tarballs release
```

CI also runs a local Verdaccio publish/install rehearsal. Its `@insiderfinance/*` rule has **no
public-registry fallback**; a missing artifact cannot be filled from npm. Legacy private aliases
also have no fallback. Verdaccio 6 synthesizes a `latest` tag when absent, even for a first
`candidate` upload, so local tag state does not certify npm's promotion boundary. Public publishing
separately reads tags before/after, verifies `candidate`, and refuses unexpected `latest` changes;
it never automatically repairs tags. The following publishes only to a disposable local registry:

```sh
pnpm dlx verdaccio@6 --config tools/release/verdaccio.yaml --listen 4873
# In a second terminal, after the dry-run:
pnpm release:publish --registry http://localhost:4873
pnpm release:smoke --version 0.1.0 --registry http://localhost:4873 --approved release
```

`--dry-run` on `release:publish` invokes npm's non-uploading check; it does not log in to or create
a loopback registry account. No local receipt proves public publication. `--write-expected` is
restricted to local tarballs and emits `expectations.matched=false`; review behavioral differences,
commit the generated baseline, then rerun normally. Never normalize away numeric results, contract
versions, operation counts, OpenAPI paths or MCP tool-name hashes to obtain a pass.

## 3. Dispatch and approve the exact pair

After all external gates and explicit enablement, dispatch **TotalFinance release** on `main` with
`version=0.1.0` and the explicitly selected bootstrap mode. The verify job rejects version mismatch
and an existing release tag, runs CI plus independent API/coverage checks, and uploads
`totalfinance-release-0.1.0` (retained for 30 days). Retain a durable copy before expiration.

The `npm-publish` reviewer approves **those artifacts**, not merely a version number. The publish
job downloads into ignored `release/approved/`, rejects a dirty/mismatched checkout or dirty-source
manifest, validates the exact ordered pair, filenames, metadata, dependency rules, sizes and all
hashes **before any upload**, and uploads main before MCP with provenance under `candidate`.
It does not rebuild, repack, advance `latest`, or create a release before registry smoke.

The workflow uses `--resume` so rerunning the original failed publish job is safe: a remotely
existing version is skipped only after its metadata and downloaded bytes match the original approved
artifact. A mismatch aborts the entire attempt. It is not permission to dispatch a new run that
rebuilds the same version. Preserve the original artifact and approval record.

## 4. Public registry smoke and candidate evidence

The smoke job explicitly targets `https://registry.npmjs.org`. It downloads the registry's tarballs
and matches the approved lengths/hashes, then installs the two exact versions into a fresh consumer.
It compares SDK/CLI outputs, HTTP OpenAPI, MCP tools and all committed smoke expectations; the site's
exact copied examples compile in strict NodeNext and bundler modes and execute against the installed
artifacts. Public scope resolution is pinned to the same registry.

A successful job retains `totalfinance-registry-smoke-0.1.0-attempt-<github.run_attempt>` with
`SMOKE_RECEIPT-0.1.0.json`, then creates `totalfinance-v0.1.0` and a **candidate/prerelease** GitHub
release attaching the manifest, both tarballs and smoke receipt. Failure leaves any already uploaded
versions public under candidate; follow recovery, never report the pair as promoted.

## 5. Explicit latest promotion — separate approval

Download the original artifacts and public smoke receipt under ignored `release/` in a clean checkout
of the approved commit. Record the release owner's explicit promotion approval and current dist-tags.
Use an authorized npm login/2FA; OIDC publishing is not dist-tag authorization.

```sh
# Read-only verification; checks source, original bytes, current registry bytes and smoke provenance.
pnpm release:promote --dir release/approved --receipt release/SMOKE_RECEIPT-0.1.0.json --expect-version 0.1.0

# ONLY after explicit maintainer approval: advances main then MCP and reads both latest tags back.
pnpm release:promote --dir release/approved --receipt release/SMOKE_RECEIPT-0.1.0.json --expect-version 0.1.0 --approve-latest

npm view @insiderfinance/totalfinance dist-tags --json --registry https://registry.npmjs.org
npm view @insiderfinance/totalfinance-mcp dist-tags --json --registry https://registry.npmjs.org
```

Tag mutations can fail between packages. Keep the incident open until both tags are coherent; the
rollback runbook owns recovery. After verified promotion, the maintainer may explicitly change the
GitHub candidate release's title/status. Preserve all original evidence; do not recreate tarballs.

## 6. Record and separately publish matching documentation

The release evidence note identifies the exact commit, full commands/results, both tarball names,
sizes/hashes, bootstrap versus OIDC authentication, reviewer, public-smoke receipt, promotion approval
and tag readback. State which external gates were actually verified. Never label local tests as a
public release or hosted-matrix result.

The separately approved site release imports **only** the real public-registry receipt:

```sh
pnpm site:record-release /absolute/path/to/SMOKE_RECEIPT-0.1.0.json preview
pnpm site:build
pnpm site:test
```

`preview` here is the site's pre-1.0 stability classification, not the obsolete npm dist-tag. Follow
[the site guide](../../site/README.md) for ledger review, immutable version archives, host/security
settings and real browser/keyboard/mobile checks. Deploy only `site/dist/` after separate authority.
Keep development labeling when public evidence is missing. Announce only after package promotion,
public smoke and the matching separately approved hosted site acceptance are complete.
