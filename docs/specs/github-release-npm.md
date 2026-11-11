# GitHub Release → SDK publication

Status: scoped design reviewed; implementation and local verification complete. Final exact-head
hosted results are owned by [PR #29](https://github.com/InsiderFinance/totalfinance/pull/29), not an
embedded self-referential commit receipt. This changes release automation only.
The maintainer wants publishing a GitHub Release to replace local npm commands. No current npm
upload, version bump, MCP publication, site deployment or change to draft PR #26 is authorized.

## Decisions and review

1. A normal `release.published` event for `totalfinance-v<major>.<minor>.<patch>` is the release
   owner's authorization to publish that exact SDK version to npm `latest`. Drafts and prereleases
   do not publish. Version metadata is prepared/reviewed before tagging; automation never bumps it.
2. Keep the existing SDK-only scope used for 0.1.1/0.1.2. Packing still validates the complete
   SDK/MCP distribution pair using the existing artifact policy, but only the SDK may be uploaded.
   Existing pair/candidate/promotion tools remain available and retain their stricter contracts.
3. The tag must resolve to the checkout commit on `main`; tag version and distribution versions
   agree. Require a successful exact-SHA full `totalfinance-ci.yml` main run, including all supported
   Node shards, coverage merges, static checks, clean regeneration and registry rehearsal. A fast PR
   run cannot satisfy this gate. Then run CI, standalone API checks and independent coverage again
   in the release verification job before packing immutable artifacts.
4. Use npm OIDC trusted publishing on GitHub-hosted runners, the existing publishing Node 24 pin,
   npm >=11.5.1, and the `npm-publish` environment. Keep explicit release enablement disabled until
   account configuration is complete. No stored npm token or local OTP fallback is introduced.
   Environment tag protection must allow `totalfinance-v*`; the source/CI gate enforces main ancestry.
5. Publish previously verified clean-source bytes with provenance, public access and `latest`.
   A rerun skips an existing version only after its downloaded bytes match approval. A newer
   existing `latest` prevents an old release rerun from moving discovery backwards. There is no
   automatic rollback or deletion if upload succeeds and a later check fails.
6. Public smoke verifies the SDK's registry bytes and installs the exact SDK version. Reuse the
   existing consumer journeys and all strict site examples. Those include optional MCP, so install
   the verified local MCP tarball as an explicitly identified test witness, without uploading it.
   The new SDK-specific receipt identifies this mixed origin and cannot masquerade as the existing
   two-package public-registry/site-release receipt. Retain the manifest, tarballs and receipts in
   Actions; attach SDK evidence to the already published GitHub Release without replacing assets.
7. Rehearse the same SDK publish/smoke path against a disposable loopback registry before the
   existing pair rehearsal. Prove MCP is absent at the SDK-only stage, then complete the existing
   pair rehearsal with byte-verified resume. No public npm budget or credentials are used for tests.
8. Keep release enablement and npm authorization as explicit setup steps. Preparing this PR never
   creates a public release or flips publication on. A successful local rehearsal/full CI is not a
   successful OIDC handshake or public release.

Design review: changing only `on:` is insufficient: the old workflow rejects tag refs and existing
tags, publishes the pair under candidate, and creates a release afterwards. Replace those workflow
assumptions while preserving artifact inspection, full verification and recovery. Reuse existing
packing, registry hash checks, consumer comparisons and numerical expectations; add no second
financial implementation, generalized publishing framework or automatic token fallback.

## Ordered acceptance checklist

- [x] G1: event/tag/version/main/full-CI policy, with valid and refused synthetic release cases.
- [x] G2: SDK-only exact-byte OIDC publication/resume and registry smoke, preserving pair tools.
- [x] G3: release-event workflow, minimum job permissions, immutable artifacts, evidence attachment.
- [x] G4: loopback rehearsal proves SDK-only publication and full consumer parity before pair resume.
- [x] G5: current runbook/setup/recovery guidance and controlling workflow assertions agree.

G6 is the external landing gate: focused tests/types/lint/format and exact-head fast + full hosted
checks must pass. PR #29 records the actual final SHA, run URLs/results and unverified account
setup. A later source commit invalidates those receipts. No version bump or generated SDK/API
change is part of this PR; no local result substitutes for the hosted full gate or an OIDC handshake.

Local G1/G3/G5 evidence: 205 tests across eight release/standalone/audit files pass; typecheck,
changed-file ESLint/Prettier and actionlint 1.7.12 pass. `pnpm docs:update` reports zero findings;
only the added documentation surfaces change its inventory. SDK runtime/API/generated contracts
and all numerical smoke expectations are unchanged.

At implementation `ad1678d87cc2f104a2d25d4b9ca0cf2a8407cc15`, a clean-source 0.1.3 pack and
all five loopback commands exit 0: SDK publish, SDK resume, SDK registry smoke, pair resume, and
pair registry smoke. SDK resume proves existing bytes match; MCP is 404 before and after SDK smoke.
All 24 strict NodeNext/Bundler site examples and numerical consumer expectations match. The SDK
receipt names only the SDK as registry-published and MCP as a local tarball witness. SDK/MCP packed
bytes remain identical to the reviewed 0.1.3 preparation. The host retains command exit codes/logs
at `/tmp/totalfinance-sdk-automation-rehearsal.json`. That is loopback evidence, not a public upload.
Final-head hosted runs rehearse this again from their own clean checkout and remain a separate gate.

## External setup and release boundary

### G7: accepted uploads awaiting npm processing (2026-11-11)

The first authorized 0.1.3 upload in run 42935946287 succeeded with signed provenance at
01:46:07 UTC. npm explicitly reported that processing could take a few minutes. The immediate
readback then failed because the public registry still served 0.1.2 and returned 404 for 0.1.3.
This is a concrete readiness defect in the new SDK path, not failed publish authentication.

- Poll only public registry reads, every 15 seconds, with a 15-minute polling deadline and the
  existing bounded HTTP request timeouts. Never repeat `npm publish` in this polling loop.
- Require the original approved SDK bytes and exact latest tag before success. Preserve immediate
  refusal of changed bytes, invalid metadata, authorization/network/server errors and a newer latest.
- A deadline failure retains the original same-run/artifact recovery instructions. It never bumps
  a version, rebuilds approval, moves a tag, changes a dist-tag or substitutes a token.
- The already uploaded 0.1.3 is recovered from its original run after registry visibility; this
  tooling-only correction applies to future release commits. The 0.1.3 tag/bytes remain immutable.
- [x] Prove ready/processing/stale-tag/missing-version/deadline/integrity/HTTP/newer-latest cases
      with synthetic responses and a fake clock: 9 new readiness tests and all 214 focused release/
      standalone/audit checks pass; build, typecheck, changed-file lint/format and docs regeneration
      pass. Final-head fast/full hosted results are the follow-up PR's external landing gate.

Tracked in issue #30. The active follow-up PR owns final-head receipts. SDK 0.1.3 became publicly
readable at 01:54:19 UTC; its original release run resumed only after the registry bytes matched.
The current release is verified green, including SDK consumer smoke, without a rebuild/re-upload.
Successful recovery/publication evidence remains with the original release run and GitHub Release.
No local test is a replacement public receipt.

The owner configures npm's trusted publisher for `InsiderFinance/totalfinance`, workflow filename
`totalfinance-release.yml`, environment `npm-publish`, and direct `npm publish`. GitHub environment
tag policy and `TOTALFINANCE_RELEASE_ENABLED=true` are required before first use. npm does not
validate that connection on save; the first explicitly authorized release establishes the live
handshake. The implementation PR and its checks are reviewed before this external enablement.
