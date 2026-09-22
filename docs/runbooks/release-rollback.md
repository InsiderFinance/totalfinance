# Runbook — partial-publish recovery and rollback

**Owner:** the maintainer who approved the `npm-publish` environment for the affected artifact.
If unavailable, the repository owner explicitly takes over in the release thread before acting.
All commands below require separate maintainer authorization; they are not automatic remediation.

The complete public roster is `@insiderfinance/totalfinance` and
`@insiderfinance/totalfinance-mcp`, at one exact version. Main has no runtime dependencies; MCP
requires that exact main version. Uploads and dist-tag changes are **not atomic**. Candidate is
publicly installable even before latest promotion. Never claim an all-or-nothing npm transaction.

## 0. Freeze and communicate

Stop announcement, promotion and website deployment. Record the exact commit, original workflow run,
reviewer, approved `RELEASE_HASHES.json`, both tarballs, authentication mode, observed registry metadata,
current dist-tags and the first failing command. Keep the original artifacts; do not overwrite them
with another pack, delete evidence, rewrite Git history or reuse a version for changed bytes.

Tell consumers whether main only, both candidates, or a partially promoted pair exists, what can be
installed safely, and who owns recovery. A public 404 does not establish ownership. Authentication,
registry availability and consumer failures have different remedies; identify which actually failed.

## 1. Partial publication: main succeeded, MCP failed

1. Leave `latest` unchanged. Main at `candidate` is already public; this is not a completed pair.
2. Preserve the original approved artifact and checkout. Inspect the error and resolve only the
   authorized npm rights, transient registry failure or publisher configuration. First-pair bootstrap
   may still require the original short-lived token to create MCP; OIDC setup is per package.
3. Rerun **the original failed publish job**, retaining its original artifact and environment approval.
   The workflow's `--resume` revalidates both local tarballs first, reads registry metadata and
   downloads already published main, and skips it **only if size/hash and package contract match**.
   It then uploads the missing MCP tarball at the exact approved main dependency. An ambiguous
   timeout is handled the same way: remote bytes determine whether an upload already succeeded.
4. If remote main differs from approval, or MCP needs code/metadata changes, stop. Do not weaken
   verification, republish main, rebuild MCP under the used number, or simply skip an error. Deprecate
   the affected existing versions as appropriate and prepare a new coherent pair (for example 0.1.1)
   through the complete release gates. Never fabricate a missing package solely to complete a roster.
5. Run the public-registry smoke from the original run. Only after both exact artifacts pass may the
   candidate release be recorded and the owner separately approve `latest` promotion.

If both uploads succeeded but smoke, tagging or GitHub release creation failed, rerun only the failed
job from the original run. Do not re-dispatch verify or rebuild approval artifacts. The smoke job is
bounded/retryable and does not republish. If a registry mismatch or behavioral failure persists,
proceed to rollback. Preserve an existing release/tag as incident evidence instead of deleting it.

### GitHub finalization recovery

The finalizer dereferences the remote tag to the approved commit, downloads and compares every
existing evidence asset byte-for-byte, uploads only missing files, and publishes a draft only after
the exact four-file roster is verified. It never overwrites assets, moves tags, or advances npm
`latest`. A conflicting tag, duplicate/extra/incomplete asset, non-prerelease, or differing bytes
stops recovery: preserve the state and have the release owner resolve the incident explicitly;
do not delete evidence or use `--clobber`. A repeated smoke generates a new receipt timestamp. If
the original receipt was already attached, retain it: a new receipt is not interchangeable bytes.
Each smoke attempt is retained independently as
`totalfinance-registry-smoke-<version>-attempt-<github.run_attempt>`; never overwrite an older artifact.
If the release already has a receipt asset, use the exact receipt from the attempt that uploaded
that asset, **not automatically the latest attempt**. Download it from that original successful
smoke attempt's retained artifact (or the existing release asset) and preserve it separately as
`release/original-SMOKE_RECEIPT-0.1.0.json`; keep the newer receipt too. If no receipt asset exists,
use the chosen successful public-smoke attempt's unchanged receipt. Never edit `verifiedAt` to make
files match. Retain the original approved pair and manifest. In a clean
checkout of that exact commit, the following checks existing state without mutations; after separate
owner approval, add `--finalize` to resume missing uploads/finalize the draft using those same files.
The receipt is revalidated as clean, same-commit, matched public-registry evidence. Verify the final
success message before continuing to promotion. Neither rebuilding nor rerunning all release jobs
is recovery for an evidence conflict.

```sh
pnpm exec tsx tools/release/finalize-github-release.ts --dir release/approved --receipt release/original-SMOKE_RECEIPT-0.1.0.json --expect-version 0.1.0
# Only after separate release-owner approval, repeat the same command with --finalize.
```

## 2. Partial latest promotion

`release:promote` validates **both** published versions and clean public-smoke evidence before the
first tag mutation, updates main then MCP, and reads both tags back. A failure after the first update
can still leave different latest versions.

The owner chooses explicitly: finish promotion by rerunning the same command with the same approved
artifacts/receipt and `--approve-latest`, or restore **both** latest tags to the recorded prior good
pair. Do not use package version numbers alone as proof that the artifacts match. Retain before/after
tag readback and the decision in the incident record.

## 3. Roll back discovery tags

If a previous verified pair exists, restore its latest tag for both packages using an authorized npm
login/2FA. Set `PREV` to an actual previously verified version, not a guessed predecessor:

```sh
PREV=0.1.0
npm dist-tag add "@insiderfinance/totalfinance@$PREV" latest --registry https://registry.npmjs.org
npm dist-tag add "@insiderfinance/totalfinance-mcp@$PREV" latest --registry https://registry.npmjs.org
npm view @insiderfinance/totalfinance dist-tags --json --registry https://registry.npmjs.org
npm view @insiderfinance/totalfinance-mcp dist-tags --json --registry https://registry.npmjs.org
```

On the first release there is **no** previous good version. Explicitly remove any affected `latest`
tag instead of pointing it at a fictitious version. Also remove `candidate` if it still targets the
bad version, without disturbing a later healthy candidate. Inspect before mutation:

```sh
npm dist-tag rm @insiderfinance/totalfinance latest --registry https://registry.npmjs.org
npm dist-tag rm @insiderfinance/totalfinance-mcp latest --registry https://registry.npmjs.org
# Remove each affected candidate tag only after checking its current target.
npm dist-tag rm @insiderfinance/totalfinance candidate --registry https://registry.npmjs.org
npm dist-tag rm @insiderfinance/totalfinance-mcp candidate --registry https://registry.npmjs.org
```

Absent tags/packages are expected in a partial first release; record that explicitly. Tag removal
does not make exact-version installs inaccessible. Smoke a restored pair from its original checkout,
expectations and retained artifacts, not the newer broken checkout.

## 4. Deprecate, or exceptionally unpublish

Prefer clear deprecation of each **existing affected** version:

```sh
BAD=0.1.0
npm deprecate "@insiderfinance/totalfinance@$BAD" "Withdrawn: <reason>. <verified replacement or do not use>." --registry https://registry.npmjs.org
npm deprecate "@insiderfinance/totalfinance-mcp@$BAD" "Withdrawn: <reason>. <verified replacement or do not use>." --registry https://registry.npmjs.org
```

Unpublish is exceptional and requires checking the [current npm policy](https://docs.npmjs.com/policies/unpublish/),
dependents and explicit owner approval. The 72-hour window is not unconditional permission; npm
can refuse. If allowed and chosen, remove MCP first, then main (dependency order reversed). Never
unpublish unrelated/private aliases. An unpublished version cannot be reused; ship a new number.

Mark the GitHub release/title/notes withdrawn and link the incident. Keep the tag, release commit,
manifest, original tarballs and receipts as immutable audit evidence; do not delete them to make a
failed release look like it never happened.

## 5. Documentation, record and corrected release

If the affected website was deployed, the deployment owner separately approves restoring the last
good verified static artifact (or truthful development/unavailable status if none exists). Do not
rebuild historical pages from current source, relabel rehearsal receipts, or erase version archives.
Npm tag changes do not update the website. Follow [the site guide](../../site/README.md).

Record timeline, affected artifacts/versions/tags, hashes, exact commands/results, owner and consumer
instructions in `docs/evidence/release-rollback-<version>.md`. A correction gets a new changeset naming
both public packages, a new coherent version, the full landing standard, fresh artifacts and a new
approval. The old version's approved bytes are never modified.

## Message template

> **TotalFinance `<version>` is `<partially published / candidate withdrawn / rolled back>`.**
> Observed: `<main only / both packages / mismatched latest tags, with exact versions>`.
> Impact: `<what a consumer could observe>`.
> Action: `<pin verified pair / do not install affected versions; no replacement yet>`.
> Recovery: `<resume original approved MCP upload / restore tags / new version and issue>`.
> Website status: `<not deployed / restored artifact / separately approved recovery>`.
> Owner and next update: `<maintainer, time>`.
