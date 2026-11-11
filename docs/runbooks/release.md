# Runbook — publish the SDK from a GitHub Release

Publishing a normal GitHub Release tagged `totalfinance-v<version>` authorizes that exact prepared
SDK version to npm `latest`. Actions verifies the release commit, builds and publishes on
GitHub-hosted runners, and checks public consumers. Local npm commands are unnecessary.

Only `@insiderfinance/totalfinance` is uploaded. Optional MCP metadata/tarballs remain coherent and
are validated/tested locally, but `@insiderfinance/totalfinance-mcp` is not published by this path.
The [scoped contract](../specs/github-release-npm.md) controls this automation. It does not authorize
creating a release, publishing a version, changing npm settings or deploying the website during PR
preparation. Older [candidate-pair instructions](./release-pair-legacy.md) are historical, not the
current workflow.

## One-time setup

Complete this after reviewing/merging the automation PR, before creating the first release:

1. In npm's `@insiderfinance/totalfinance` package settings, add a GitHub Actions trusted publisher:

   | Field             | Exact value                |
   | ----------------- | -------------------------- |
   | Organization/user | `InsiderFinance`           |
   | Repository        | `totalfinance`             |
   | Workflow filename | `totalfinance-release.yml` |
   | Environment       | `npm-publish`              |
   | Allowed action    | Direct `npm publish`       |

   No npm token, OTP, dist-tag permission or MCP publisher is needed. npm does not verify these
   settings on save; the first explicitly authorized release proves the actual OIDC handshake.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

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
   For 0.1.3 this is already done: do not run `release.sh` or `changeset version` again.
2. Wait for the **full main CI at the exact release commit** to pass. The release checks require
   every supported Node shard, coverage merge, static job, clean regeneration and registry rehearsal;
   a fast PR run cannot substitute. Creating the release early produces a clear refusal; rerun its
   failed verification job once main CI is green.
3. In GitHub → Releases → Draft a new release, select/create `totalfinance-v0.1.3` at the prepared
   main commit, enter the reviewed release notes, and click **Publish release**. Drafts do nothing;
   prereleases are skipped and never advance npm `latest`. Stable tags must match both prepared
   distribution versions. Publishing does not invent or bump a version.
4. Watch **TotalFinance release**. Verification checks the real tag/commit/main ancestry and exact
   full-CI evidence, then runs `pnpm run ci`, standalone `pnpm api:check`, and a second
   `pnpm test:coverage`. It packs the validated distribution pair once and retains clean-source hashes.
5. The environment-protected publish job downloads those bytes, checks all hashes/metadata and
   source identity again, and uploads **only the SDK** with provenance, public access and `latest`.
   It neither rebuilds approved bytes nor uses an npm-token fallback. SDK publication is immediately
   public; a later smoke failure does not automatically unpublish or roll back discovery.
6. Registry smoke matches the SDK's downloaded tarball to approval and installs its exact version.
   Existing numerical SDK/CLI/HTTP journeys and all strict site examples must match committed
   expectations. Optional MCP is installed from its approved local tarball solely as a test witness.
   `SDK_SMOKE_RECEIPT-<version>.json` explicitly distinguishes the registry SDK from that witness.
   It is not a two-package public-registry receipt and must not be imported as a site-release receipt.
7. Actions retains the source/pack/publication/smoke artifacts for 30 days. After smoke passes, it
   attaches the SDK tarball, pair hash manifest, source/full-CI receipt and SDK smoke receipt to the
   existing GitHub Release. It never creates another release, moves the tag or overwrites assets.
   Preserve a durable copy before Actions artifacts expire. Site publication remains separately
   authorized and is not performed here.

## Rehearsal and recovery

Ordinary CI rehearses SDK-only publishing into a disposable Verdaccio registry, proves optional MCP
is still absent, and runs the same consumer smoke. It then completes the existing pair rehearsal
using verified resume. The scoped registry has no public fallback. No test upload reaches npmjs.org.

If a publish response is ambiguous or smoke fails, retain the original Actions run and artifacts.
Rerun **failed jobs in that same run**; do not start another release, rebuild under a used version,
move/delete a tag, overwrite evidence or silently relax a check. An existing SDK version is skipped
only after its downloaded bytes match approval. A newer npm `latest` makes an old release rerun
refuse instead of moving discovery backwards. A metadata/byte mismatch requires owner-led recovery.

Evidence attachment refuses conflicting existing assets. If an upload partly succeeded, retain the
original successful smoke receipt, compare existing assets to those original files, and have the
release owner upload only missing originals. Never use `--clobber` or regenerate timestamps to make
receipts match. [Rollback guidance](./release-rollback.md) distinguishes SDK recovery from historical
pair recovery; an SDK incident never authorizes changing optional MCP's tags or versions.

## Local fallback

The existing `tools/release/publish-npm.sh` remains a separately authorized SDK-only operator path.
It builds/packs from clean current main and publishes directly to npm latest without CI provenance,
using interactive npm authentication. It skips CI itself, so the same exact-commit release gates
must have passed first. Prefer the hosted path above; do not race local and hosted publication.
