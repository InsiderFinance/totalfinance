# Runbook — publish the SDK and MCP server from a GitHub Release

Publishing a normal GitHub Release tagged `totalfinance-v<version>` authorizes that exact prepared
version of `@insiderfinance/totalfinance` and `@insiderfinance/totalfinance-mcp` to npm `latest`.
Actions verifies the release commit, builds and publishes on GitHub-hosted runners, and checks
public consumers. Local npm commands are unnecessary, except once for the MCP server's first version
(see [First MCP publication](#first-mcp-publication)).

The SDK is uploaded first, then the MCP server, which depends on the SDK's exact version. Until
0.1.7 only the SDK was published; the MCP server joined the release path in 2026-11. The
[scoped contract](../specs/github-release-npm.md) controls this automation, as amended there. It does not authorize
creating a release, publishing a version, changing npm settings or deploying the website during PR
preparation. Older [candidate-pair instructions](./release-pair-legacy.md) are historical, not the
current workflow.

## One-time setup

Complete this after reviewing/merging the automation PR, before creating the first release:

1. In npm's package settings for `@insiderfinance/totalfinance`, and for `@insiderfinance/totalfinance-mcp`
   once it exists, add a GitHub Actions trusted publisher:

   | Field             | Exact value                |
   | ----------------- | -------------------------- |
   | Organization/user | `InsiderFinance`           |
   | Repository        | `totalfinance`             |
   | Workflow filename | `totalfinance-release.yml` |
   | Environment       | `npm-publish`              |
   | Allowed action    | Direct `npm publish`       |

   No npm token, OTP or dist-tag permission is needed. npm does not verify these settings on save;
   the first explicitly authorized release proves the actual OIDC handshake. A new trusted
   publisher expires if it is not used to publish within 2 days, so add the MCP server's shortly
   before the release that first publishes it through Actions. See
   [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

2. Create the GitHub `npm-publish` environment. Its selected deployment tag rule allows
   `totalfinance-v*`; a main-only branch rule would reject release events because they use tag refs.
   The workflow separately requires the tagged commit to belong to `main`. Additional required
   reviewers are optional; without them, clicking Publish release is the release owner's approval.
3. After checking both settings, set repository Actions variable `TOTALFINANCE_RELEASE_ENABLED=true`.
   Leave it unset/false during preparation. This is not an npm credential. Keep the existing full
   CI and main protection policies; do not bypass them to make a release proceed.

Building uses `.nvmrc` and pinned pnpm with a frozen lockfile. Publishing uses the existing Node
24.21.0 pin, verifies npm >=11.5.1 and requests OIDC only in the publish job. Consumer smoke uses
Node 22.13.0. This preserves the supported consumer runtime while meeting npm's publisher floor.

## For each version

1. Prepare/review/merge version, changelog and derived metadata through the normal PR process.
   Run Changesets once for the selected unused version, then `pnpm publication:update` and the
   required lockfile synchronization. Do not run versioning again for an already prepared cut.
2. Wait for the **full main CI at the exact release commit** to pass. The release checks require
   every supported Node shard, coverage merge, static job, clean regeneration and registry rehearsal;
   a fast PR run cannot substitute. Creating the release early produces a clear refusal; rerun its
   failed verification job once main CI is green.
3. In GitHub → Releases → Draft a new release, select/create `totalfinance-v<version>` (for example `totalfinance-v0.1.4`) at the prepared
   main commit, enter the reviewed release notes, and click **Publish release**. Drafts do nothing;
   prereleases are skipped and never advance npm `latest`. Stable tags must match both prepared
   distribution versions. Publishing does not invent or bump a version.
4. Watch **TotalFinance release**. Verification checks the real tag/commit/main ancestry and exact
   full-CI evidence, then runs `pnpm run ci`, standalone `pnpm api:check`, and a second
   `pnpm test:coverage`. It packs the validated distribution pair once and retains clean-source hashes.
5. The environment-protected publish job downloads those bytes, checks all hashes/metadata and
   source identity again, and uploads **the SDK, then the MCP server** with provenance, public access
   and `latest`. Each package is byte-verified and skipped when npm already serves its approved
   bytes. It neither rebuilds approved bytes nor uses an npm-token fallback. A publication is
   immediately accepted; npm can report asynchronous processing before the version and latest tag
   become public.
   Readback polls every 15 seconds up to a 15-minute polling deadline, retaining the existing HTTP
   request timeouts, until exact approved bytes and latest match. It never repeats the upload.
   Integrity/metadata/HTTP errors and a newer latest fail immediately. A later smoke failure does
   not automatically unpublish or roll back discovery.
6. Registry smoke matches both packages' downloaded tarballs to approval and installs their exact
   versions from npm. Existing numerical SDK/CLI/HTTP/MCP journeys and all strict site examples must
   match committed expectations. `RELEASE_SMOKE_RECEIPT-<version>.json` records both registry
   packages.
7. Actions retains the source/pack/publication/smoke artifacts for 30 days. After smoke passes, it
   attaches the SDK and MCP tarballs, pair hash manifest, source/full-CI receipt
   (`RELEASE_SOURCE.json`) and smoke receipt to the existing GitHub Release. It never creates another release, moves the tag or overwrites assets.
   Preserve a durable copy before Actions artifacts expire.
8. After smoke passes, the docs job fast-forwards `docs-live` to the release commit, and Vercel
   deploys it to production, so the live docs match the version now on npm. It never moves
   `docs-live` backwards; rerunning an older release leaves newer docs in place. See the
   [deployment guide](./deploy-totalfinance-site.md) for publishing docs-only fixes by hand.

## First MCP publication

npm trusted publishing can be configured only for a package that already exists, so the MCP server's
first version cannot be uploaded through Actions. The first release that includes it publishes the
SDK, then stops the publish job with "First MCP publication" before any MCP upload. Then:

1. Download that run's approved bytes and check the MCP tarball against the approved hash manifest
   (replace `<run-id>` and `<version>`):

   ```sh
   gh run download <run-id> -R InsiderFinance/totalfinance -n totalfinance-release-<version> -D /tmp/totalfinance-release-<version>
   cd /tmp/totalfinance-release-<version>
   shasum -a 256 insiderfinance-totalfinance-mcp-<version>.tgz
   grep -A3 insiderfinance-totalfinance-mcp-<version>.tgz RELEASE_HASHES.json
   ```

2. Upload exactly that tarball once with your npm login. Local uploads cannot carry provenance:

   ```sh
   npm whoami || npm login
   npm publish ./insiderfinance-totalfinance-mcp-<version>.tgz --access public --tag latest --provenance=false --ignore-scripts
   ```

3. In the same run, choose **Re-run failed jobs**. The publish job byte-verifies both packages
   instead of uploading, then smoke, evidence and docs run as usual.
4. Before the next release, within its 2-day window, add the MCP server's trusted publisher
   (one-time setup, step 1). From then on every release publishes both packages through Actions.

Never upload a tarball you built yourself: a version's bytes must be the run's approved bytes.

## Rehearsal and recovery

Ordinary CI rehearses publishing the SDK, then the MCP server, into a disposable Verdaccio registry,
byte-verifies both on a resumed run, and runs the same consumer smoke against both registry
packages. It then completes the existing pair rehearsal using verified resume. The scoped registry has no public fallback. No test upload reaches npmjs.org.

If a publish response is ambiguous or smoke fails, retain the original Actions run and artifacts.
Rerun **failed jobs in that same run**; do not start another release, rebuild under a used version,
move/delete a tag, overwrite evidence or silently relax a check. An existing SDK or MCP version is
skipped only after its downloaded bytes match approval. A newer npm `latest` makes an old release rerun
refuse instead of moving discovery backwards. A metadata/byte mismatch requires owner-led recovery.

Evidence attachment refuses conflicting existing assets. If an upload partly succeeded, retain the
original successful smoke receipt, compare existing assets to those original files, and have the
release owner upload only missing originals. Never use `--clobber` or regenerate timestamps to make
receipts match. [Rollback guidance](./release-rollback.md) distinguishes SDK recovery from historical
pair recovery; an SDK incident never authorizes changing optional MCP's tags or versions.

## Local fallback

The existing `tools/release/publish-npm.sh` remains a separately authorized SDK-only operator path
(it never uploads the MCP server).
It builds/packs from clean current main and publishes directly to npm latest without CI provenance,
using interactive npm authentication. It skips CI itself, so the same exact-commit release gates
must have passed first. Prefer the hosted path above; do not race local and hosted publication.

## MCP Registry listing

The official [MCP Registry](https://registry.modelcontextprotocol.io) lists servers by metadata
only, so list a version after its `@insiderfinance/totalfinance-mcp` package is on npm. The listing is
`distribution/mcp/server.json`, named `io.github.InsiderFinance/totalfinance`. `pnpm publication:update`
keeps its version equal to the distributions', and the package's `mcpName` field (required by the
release artifact policy) is how the registry verifies the npm package belongs to that name.

Publishing under the organization namespace needs proof that you are an **Owner** of the
`InsiderFinance` GitHub organization. The interactive `mcp-publisher login github` device flow cannot
read organization roles and grants only a personal namespace
([registry issue #1468](https://github.com/modelcontextprotocol/registry/issues/1468)). Use a classic
personal access token with the `read:org` scope from an organization Owner, or GitHub Actions OIDC
(`mcp-publisher login github-oidc` in a job with `id-token: write`). At the release tag:

```sh
cd distribution/mcp
mcp-publisher validate
mcp-publisher login github --token "$GITHUB_OWNER_TOKEN_WITH_READ_ORG"
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.InsiderFinance/totalfinance"
```

Install `mcp-publisher` from the registry's
[releases](https://github.com/modelcontextprotocol/registry/releases) or `brew install mcp-publisher`.
A registry listing never replaces npm publication or its smoke; publish it only for a version whose
npm bytes passed the release workflow.
