# Runbook — cutting a TotalFinance preview

The fixed group (twenty-five packages) releases together, from one commit, under the `preview`
dist-tag, through a human approval on the exact hashes. Nothing here is done by hand against
npmjs.org; the workflow does it, and this page is how to drive the workflow. Rollback is its own
page: [`release-rollback.md`](./release-rollback.md).

## 0. Preconditions (once)

- Complete the [current preview launch queue](../implementation-order.md#preview-launch-queue-2026-09-07)
  through integration, hosted checks, website polish and browser/data acceptance before freezing the
  release revision. That queue owns launch ordering; this runbook owns release mechanics.
- The public repository exists and the `npm-publish` GitHub environment has required reviewers
  (Decision 8 of the [Stage 5A contract](../specs/preview-integration-and-shipping.md)).
- The source home is `InsiderFinance/totalfinance`, branch `main`; commands below run at the
  repository root. Configure required reviewers and npm ownership before setting the repository
  variable `TOTALFINANCE_RELEASE_ENABLED=true`. The manual release workflow refuses otherwise.
- `NPM_TOKEN` (a granular automation token with publish rights on the `@totalfinance` scope and the
  `totalfinance` package) is a repository secret, or npm trusted publishing is configured for the
  workflow. Provenance comes from the workflow's OIDC token; nothing else is stored.

## 1. Land the version bump

The repository is in changesets pre-mode (`.changeset/pre.json`, tag `preview`), so every version is
`0.1.0-preview.N` and N advances from 0.

```sh
# Run from the root of the totalfinance checkout, on main.
pnpm exec changeset status            # every user-visible change since the last preview has an entry
pnpm exec changeset version           # bumps all twenty-five package.json files, writes CHANGELOG.md per package
pnpm install --offline                # the lockfile records the new workspace versions
pnpm run ci && pnpm api:check         # the landing standard, on the bumped tree
git commit -am "release(totalfinance): 0.1.0-preview.N"
```

Land that commit through the normal review. The version in `packages/core/package.json` is the value
the workflow expects as its input.

## 2. Rehearse locally (optional, recommended for the first few)

```sh
pnpm release:dry-run                                  # ci + pack + release/RELEASE_HASHES.json
pnpm dlx verdaccio@6 --config tools/release/verdaccio.yaml --listen 4873 &
pnpm release:publish --registry http://localhost:4873   # provenance off on a loopback registry
pnpm release:smoke --version 0.1.0-preview.N --registry http://localhost:4873
```

CI runs this same rehearsal on every push (`release-rehearsal` in `totalfinance-ci.yml`).

## 3. Dispatch the release workflow

Actions → **TotalFinance release** → _Run workflow_ on the release commit, input `version` =
`0.1.0-preview.N`. The `verify` job refuses when the packages carry a different version or the tag
already exists, runs `pnpm run ci`, and uploads `totalfinance-release-<version>` (the tarballs and
`RELEASE_HASHES.json`).

## 4. Approve the hashes

The `publish` job waits on the `npm-publish` environment. The reviewer opens the `verify` artifact,
reads `RELEASE_HASHES.json`, and approves **those** hashes. The job downloads the approved artifact,
re-checks every tarball against the manifest, and uploads exactly those tarballs
(`pnpm release:publish --dir approved`; nothing is re-packed after approval), then pushes
`totalfinance-v<version>` and creates the GitHub release (prerelease) with the changelog excerpt and the
manifest attached.

## 5. Smoke the public registry

The `smoke` job installs the group from npmjs.org into a clean directory and runs the consumer
journeys against `tools/release/smoke-expected.json`. It also compiles the public site's exact copied
examples in strict NodeNext and bundler modes, executes them against that installed group, and checks
the complete displayed results and chart data. The successful job retains
`totalfinance-registry-smoke-<version>` with `SMOKE_RECEIPT-<version>.json`.
For this combined launch, announce only after it is green **and** the matching website is deployed
and checked (step 7). If it is red,
the release is still published: follow [`release-rollback.md`](./release-rollback.md) or ship the
fix as the next preview, and say which in the release thread.

## 6. Record

Copy the manifest into the tree as evidence and link it from the release:

```sh
gh release download totalfinance-v0.1.0-preview.N -p RELEASE_HASHES.json -D /tmp/rel
cp /tmp/rel/RELEASE_HASHES.json docs/evidence/release-0.1.0-preview.N.json
```

## 7. Publish matching public documentation (separately approved)

Download the successful registry-smoke receipt from the workflow's Actions artifacts. In the checkout
for that release, import it into the site ledger; do not use a local tarball/loopback rehearsal receipt:

```sh
pnpm site:record-release /absolute/path/to/SMOKE_RECEIPT-0.1.0-preview.N.json preview
pnpm site:build
pnpm site:test
```

For subsequent releases, restore earlier immutable version directories into an archive root and set
`TOTALFINANCE_DOCS_ARCHIVES` before the build. The [site maintainer guide](../../site/README.md) owns exact
archive, static-host, cache, security-header, and browser-review requirements. Review and commit the
ledger update through the normal workflow. After the separately approved deployment, retain the built
`site/dist/versions/<version>/` artifact for future builds; old pages and assets are copied from that
artifact, never reconstructed from newer source. Deploy only `site/dist/`.

Complete real browser/keyboard/mobile checks before deployment. A supported-host WebMCP check is
separate from the browser-tool mock tests. Neither importing a receipt nor building the site publishes
packages or deploys a website. Use `stable` instead of `preview` only after the distinct stable-cutover
approval and its registry smoke. Missing release evidence must leave development labeling intact.

Smoke the deployed public domain, including search, a runnable calculation, copied code, versioned
pages and a real 404. Announce only after both this check and the public-registry smoke pass.
