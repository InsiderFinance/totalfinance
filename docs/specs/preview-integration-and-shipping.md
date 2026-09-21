# Stage 5A — preview integration and shipping

_Status: contract DRAFTED 2026-09-03 for review; implements the queue row "Stage 5A — preview
integration and shipping" of [`implementation-order.md`](../implementation-order.md) §5 and the
every-public-publish gate it states. Same method as Stage 4.5, Preview P1, and Stage 7A: a
decision-complete contract first, then slices with tests, generated evidence, and a closeout that
names one commit._

## Outcome

A clean consumer can install an explicitly pre-1.0 TotalFinance preview from the public npm registry and
run the same journeys the repository proves: the direct SDK, the `totalfinance` CLI, `totalfinance-http`, and
the MCP server — from the published artifacts, not the workspace. Every artifact in the fixed package
group carries complete, truthful metadata; every gate that blocks a publish passes at one exact
commit; the release is produced by automation that a maintainer approves, with dry-run hashes,
provenance, a matching tag and GitHub release, and rollback ownership written down BEFORE the first
publish. Nothing about the core contracts changes. Amended 2026-09-04: by the maintainer's decision
to continue the queue while this publish waited on organization actions, Stages 4.6 and 4.7 closed
BEFORE the preview shipped, so the preview now ships over the core frozen in fact; the stable label
still waits on Stage 5B.

## Non-goals

- No stable API label, no "final release" claim — the preview stays explicitly pre-1.0 (amended
  2026-09-04: FC8 and FC9 closed before the publish by the maintainer's decision; their completion is
  recorded in their own contracts, never claimed by this one).
- No redesign of settled contracts. A defect found while shipping returns to the alignment process;
  it is not fixed by a metadata edit.
- No connected data, no `@totalfinance/data`, no MCP Apps, no hosted service (Stage 7B and the data
  layer own those).
- Originally no documentation-site work beyond packaged docs. Superseded for the initial launch
  by the 2026-09-07 MCP/site integration and the current
  [preview launch queue](../implementation-order.md#preview-launch-queue-2026-09-07): the site now
  ships alongside the preview, with matching release evidence and separate deployment approval.

## Decision 1 — the preview version and the fixed group

- The fixed group is every workspace package: the twenty domain and platform packages under
  `@totalfinance/*`, the umbrella `totalfinance`, the workflows registry (`@totalfinance/workflows`), and the
  three transports (`@totalfinance/cli`, `@totalfinance/http`, `@totalfinance/mcp`) — twenty-five packages. `.changeset/config.json` already declares
  `fixed: [["@totalfinance/*", "totalfinance"]]` — the umbrella and every scoped package move together.
- The first published version is **`0.1.0-preview.0`** (changesets numbers a prerelease series from 0) with the npm dist-tag **`preview`**
  (`latest` is not touched until the stable release). Later previews increment the prerelease
  counter; a preview never uses `^` compatibility promises, and the visibly-pre-1.0 requirement
  is met by the `0.` major and the `-preview` prerelease.
- The version is written into every `package.json` by changesets (`changeset version`) from ONE
  changeset file naming the whole fixed group; `git tag totalfinance-v0.1.0-preview.0` is the release tag.
- `baseBranch` in `.changeset/config.json` is `main`, the standalone repository's default branch
  (supersedes the original parent-repository `develop` setting).

## Decision 2 — the stability statement

- A new top-level `STABILITY.md` (shipped in every package through `files`) states the tiers in one
  table: **stable-by-law** (every public surface passes the alignment laws, the naming/signature/
  enforcement gates, and the transport-parity gate — but the semantic versioning promise starts at
  1.0), **preview** (the transports and the workflows registry: the wire ids and schemas are held
  through the preview series; a change ships as a new minor with a changeset entry), and
  **experimental** (any export marked `@experimental` in its API report — none at the first cut; the
  list is generated, not authored). The root `README.md` "Status" paragraph and `docs/README.md`
  are rewritten to the preview truth (the current prose still says fifteen packages and names Phase 3B
  as the release-blocking phase).
- The statement is a gate: `tools/preview-surface-audit.test.ts` (Decision 4) asserts `STABILITY.md`
  exists, is listed in every package's `files`, and that its package count and version match the
  workspace.

## Decision 3 — public metadata, per package

Every published `package.json` must satisfy, exactly (the audit enumerates each and fails on the
first miss):

| Field                            | Rule                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `version`                | the fixed-group version; `private` absent or `false`                                                                            |
| `description`, `keywords`        | non-empty; keywords include `totalfinance` and the package's domain word                                                        |
| `license`                        | `Apache-2.0`, and a `LICENSE` file in `files`                                                                                   |
| `repository`, `homepage`, `bugs` | point at the public repository (Decision 8) with the package `directory`                                                        |
| `type`, `sideEffects`            | `module`; `sideEffects: false` (the CLI / HTTP / MCP binaries are `bin` entries, not side effects)                              |
| `main` / `module` / `types`      | the built root entry; every `exports` subpath resolves to an existing `dist` file after `pnpm build`                            |
| `exports`                        | `types` before `import`/`default` in every condition; `./package.json` exported                                                 |
| `files`                          | `dist`, `src`, `etc`, `LICENSE`, `STABILITY.md`, `!dist/.tsbuildinfo`, plus only the exact public-guide additions below         |
| `engines.node`                   | `>=22.13.0` everywhere (the floor the CLI's `doctor` and the CI matrix enforce)                                                 |
| `publishConfig`                  | `access: public`, `provenance: true`                                                                                            |
| `bin` (transports)               | executable entries with the shebang line and a `dist/` target                                                                   |
| dependencies                     | only `workspace:*` (rewritten by pnpm at pack time) or pinned third-party ranges; no `devDependencies` leak into `dependencies` |

Source maps and declaration maps are already emitted (`tsconfig.base.json`); the audit asserts every
`dist/**/*.js` has a sibling `.js.map` and every `.d.ts` a `.d.ts.map`, and that `src` ships so the
maps resolve.

**Exact public-guide addition (2026-09-07 app dogfooding):** `@totalfinance/structure` also ships
`OPTION-FLOW-DRIFT.md`, documenting classification provenance, session accounting, causal price
overlays and unavailable states. It is inserted before the build-info exclusion. The preview audit
still requires exact lists for every package and verifies the guide exists without internal-plan
links; this is not permission to add a Markdown glob or ship review/spec trackers. Other packages'
lists are unchanged. The packed app check verifies this guide's actual artifact contents.

## Decision 4 — the preview-surface audit (FC9's checks over the current surface)

One gate, `tools/preview-surface-audit.test.ts`, runs the FC9 checks that apply before the preview,
over the current surface, and names each by the FC9 row it rehearses:

1. **Discovery.** The umbrella exposes every domain as a symmetric namespace (no wildcard root
   hoists) and its package count equals the fixed group minus the transports; every package README
   has an executable example (the readme-snippets test already proves them); `llms.txt` and the API
   reports are regenerable (the existing generated-docs gate).
2. **Cold user.** One executable journey per package (the readme snippet) and the end-to-end
   journey across fundamentals → valuation → screen/factor → portfolio → backtest → performance
   (`docs/examples/five-minute-journey.test.ts` and the packed-consumer journeys) run from the PACKED
   tarballs, not the workspace.
3. **Semantic parity.** `tools/transport-parity.test.ts` (Stage 7A) stays green — the preview's
   agent surfaces cannot drift from the SDK.
4. **Generated evidence.** The regeneration chain is clean at the release commit (manifest, naming,
   contract, enforcement `defective 0`, validation, API reports, READMEs, `llms.txt`, bundle budgets,
   OpenAPI, docs inventory) — `pnpm run ci` plus `pnpm api:check` at that commit is the evidence.
5. **Packed consumer.** `tools/packed-consumer.test.ts` (with the Stage 7A cases) is green.
6. **Metadata** (Decision 3), **stability statement** (Decision 2), **community and security files**
   (Decision 5), **release plumbing** (Decision 6) — each an `it`.

The audit is part of `pnpm run ci` through the tools suite, so it runs on every push, not only at
release time.

## Decision 5 — community and security files

`SECURITY.md` (how to report, the supported-version line: the latest preview only, the response
window), `CONTRIBUTING.md` (the alignment process in one page: spec first, laws, gates, the landing
standard, how to run the chain), and `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) at the
monorepo root; `CHANGELOG.md` per package written by changesets. The audit asserts presence and
non-emptiness; the wording is reviewed, not gated.

## Decision 6 — release automation and the every-public-publish gate

- **Local:** `pnpm release:dry-run` builds, runs `pnpm run ci`, packs every package of the fixed
  group (`pnpm pack` into `release/`), and writes `release/RELEASE_HASHES.json` — `{ package,
version, tarball, sha256, bytes }` per artifact plus the git commit — so the artifacts a maintainer
  approves are named by hash, not by intent.
- **Hosted:** `.github/workflows/totalfinance-release.yml`, `workflow_dispatch` only, with one input
  (the expected version). Job 1 (`verify`): the CI matrix's `pnpm run ci` on the release commit, then
  the dry-run and the hash manifest uploaded as a workflow artifact. Job 2 (`publish`): gated by a
  GitHub **environment** `npm-publish` with required reviewers — an authorized maintainer approves
  the exact hashes; then `pnpm -r publish --tag preview --provenance --access public --no-git-checks`
  (OIDC: `permissions: id-token: write`), the tag `totalfinance-v<version>` pushed, and a GitHub release
  created with the changeset notes and the hash manifest attached. The workflow refuses to run when
  the version input differs from the packages' version or when the working tree is not the tagged
  commit.
- **Amended at slice 3 (`80650531d`).** The publish job does not run `pnpm -r publish`: the
  rehearsal showed `pnpm pack` is not byte-stable across runs (the rewritten `workspace:*` dependency
  keys come out in a varying order), so a re-pack in the publish job could never equal the approved
  hashes. Instead the job downloads the `verify` artifact, re-checks every tarball's sha256 against
  `RELEASE_HASHES.json`, and uploads exactly those tarballs (`pnpm release:publish --dir approved`,
  `npm publish <tarball> --provenance` per package, OIDC-attested). What a maintainer approved is
  what reaches the registry, byte for byte.
- **Atomicity.** The fixed group publishes in one job; a failure after a partial publish is handled
  by the rollback runbook (Decision 7), never by re-running blindly.
- **Registry smoke** (Decision 9) runs as job 3 after publish and blocks the release announcement,
  not the publish.

## Decision 7 — rollback and yank ownership

`docs/runbooks/release-rollback.md`: who owns a rollback (the approving maintainer), the 72-hour npm
unpublish window versus `npm deprecate` after it, how to move the `preview` dist-tag back to the
previous version for the whole fixed group, tag and GitHub-release deletion, and the message
template. Written before the first publish; the audit asserts the file exists and names the dist-tag
command.

## Decision 8 — the public repository (settled 2026-09-21)

The maintainer selected **`https://github.com/InsiderFinance/totalfinance`**, default branch `main`,
as the standalone source of truth, and confirmed **TotalFinance** as the complete public identity.
The library lives at the repository root. The twenty-five packages, imports, CLI names, wire
namespaces, source metadata, documentation and workflows use that identity without compatibility
aliases. The [migration contract](./standalone-totalfinance-migration.md) owns extraction and proof.

This supersedes both original alternatives (a recurring subtree mirror and publication from the
private application). Only a verified library snapshot is imported; no private application or
private Git history is published. Future library work lands here.

Repository selection does not establish npm scope/package ownership, trusted publishing or the
`npm-publish` reviewers. Those remain maintainer-held gates. The manual workflow additionally
requires `TOTALFINANCE_RELEASE_ENABLED=true` and dispatch from `main`; leave it disabled until the
release prerequisites and approvals are in place. No version bump or npm publish occurs in the move.

## Decision 9 — the registry smoke

`tools/registry-smoke.ts` (`pnpm release:smoke -- --version <v> [--registry <url>]`): in a fresh
temp directory, `npm init -y`, install the fixed group at the exact version from the registry, then
run the packed-consumer journeys' scripts (the SDK five-minute journey, the CLI `operations list` and
`run`, `totalfinance-http --openapi`, the MCP tool list) and compare their canonical outputs to the
committed expectations. Rehearsed in CI against a local registry (Verdaccio in a job step, fed by the
dry-run tarballs) so the tool is proven before it ever sees npmjs.org; run for real after the
publish (Decision 6, job 3). A preview registry smoke never substitutes for the stable artifacts'
own post-publish smoke (queue §5 verbatim).

## Ordered implementation slices

| Slice | Content                                                                                                                                                                                                                                             | Evidence                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1     | Metadata and the stability statement: every `package.json` to Decision 3 (`STABILITY.md` in `files`, `publishConfig.provenance`, engines), `STABILITY.md`, the README/docs status prose rewritten, `.changeset` base branch, the preview changeset. | the audit's metadata and stability `it`s; `pnpm run ci`                                     |
| 2     | The preview-surface audit (`tools/preview-surface-audit.test.ts`) with the FC9 rehearsals of Decision 4; community and security files (Decision 5); the rollback runbook (Decision 7).                                                              | the audit green; the docs gates                                                             |
| 3     | Release plumbing: `pnpm release:dry-run` with the hash manifest; `totalfinance-release.yml` with the approval environment and provenance; the registry smoke tool rehearsed against a local registry in CI.                                         | the dry-run manifest committed as evidence under `docs/evidence/`; a rehearsal run recorded |
| 4     | The public repository decision executed (Decision 8), the preview publish under the every-public-publish gate, the real registry smoke, the announcement; closeout — trackers to `COMPLETE @ <commit>`, Stage 4.6 made the next row.                | the GitHub release, the hash manifest matching the registry tarballs, the smoke log         |

Slices 1–3 land without any organization action. Slice 4 begins only with the maintainer's Decision 8
answer and the approval environment in place.

## Amendment (2026-09-04) — the queue continued while the publish waited

Slice 4 waits on organization actions (Decision 8, the npm scope and token, the `npm-publish`
environment, and — found 2026-09-04 — the organization's GitHub Actions billing, which has kept
every hosted run from starting since 2026-09-03). By the maintainer's decision the queue continued
meanwhile: Stage 4.6 closed at `839a955e7` and Stage 4.7 at `530eb6de8`, each with its own contract
and evidence. The preview therefore ships over the frozen core rather than ahead of it. Nothing in
this contract's decisions changes: the version stays `0.1.0-preview.0`, the tiers in `STABILITY.md`
stay as written (the registry and transports remain `preview`), the every-public-publish gate is
unchanged, and the stable label waits on Stage 5B. The release notes changeset was rewritten to
describe the surface that actually ships; the dry-run and the registry smoke were rehearsed again
locally at the current head (`a426b701e`) because the hosted rehearsal cannot run: twenty-five
tarballs packed, published into a local Verdaccio, installed back and run through the consumer
journeys; one expectation re-measured — the OpenAPI document carries 48 paths for the 39 operations
(44 at the slice-3 rehearsal over 36), the twenty-three defaults, the MCP tool set, the journey
values, and the pricing envelope unchanged; the manifest under `docs/evidence` is the head's.

## Amendment (2026-09-06) — the queue continued again: Stage 7B closed before the publish

The organization actions of slice 4 were still outstanding, and by the same maintainer decision the
queue continued: Stage 7B.1 (the trading-agent environment and Agent Bench) closed at `f7677ebcb`
and Stage 7B.2 (the safe trade lifecycle and paper execution) at `44cd9d72e` (closeout
`2608890fd`), each with its own contract and evidence, and the
[September review-repair gate](./review-september-2026-repairs.md) closed at `94fb7f5f8` (causal
portfolio timing, entry buying power, signed lifecycle economics, resumable paper orders over an
authoritative journal store, trusted-store grant verification, and the HTTP server's Host/Origin
checks with a server-owned credential for enabled writes). What ships therefore also includes
`@totalfinance/backtest/environment`, `@totalfinance/backtest/paper`, `@totalfinance/portfolio/trade`, the
runtime's capabilities and stores, and the `trade` operation pack — forty-six operations in the full
profile. Nothing in this contract's decisions changes: the version stays `0.1.0-preview.0`, the
every-public-publish gate is unchanged, and the stable label waits on Stage 5B. Two decisions are
recorded here so they are not re-litigated at the publish:

- **The new subpaths keep their packages' tier.** `STABILITY.md` assigns tiers per package and
  `@totalfinance/backtest` and `@totalfinance/portfolio` are `stable-by-law`; the environment, the paper
  broker, and the trade lifecycle are held by the same executable laws as every other export
  (manifest classification, the signature policy, the enforcement probe, the generated references,
  the bundle budgets) and ship under them. The `experimental` tier stays reserved for exports the
  API report marks `@experimental`; none are.
- **The rehearsal is the head's again.** The release notes changeset was rewritten for the surface
  that ships; `pnpm release:dry-run` re-packed the twenty-five tarballs at the current head and the
  manifest under `docs/evidence` is the head's; the registry smoke's expectations were re-measured
  against a local Verdaccio at `94fb7f5f8` plus this refresh (forty-six operations in the full
  profile; the OpenAPI document carries 55 run paths; the twenty-three defaults, the MCP tool
  set, the journey values, and the pricing envelope unchanged). The manifest names the commit at
  which these tarballs were packed (the refresh in progress, before its amendment); every file the
  refresh touched after that lies outside the tarballs (this contract, the changeset, the README,
  the budgets, generated documentation), so the packed artifacts are this commit's packages.

## Amendment (2026-09-07) — MCP/site integration, with further pre-release work requested

The [MCP and public documentation experience](./mcp-and-public-docs-experience.md) was committed and
integrated over release refresh `b978b767` in `768393eb`. Keep the preceding amendment's package tiers,
twenty-five-package group, forty-six operations, fifty-five OpenAPI paths, and explicit preview release
decision. The new MCP profiles and opt-in job controls do not grant capabilities or add finance logic.
The public site is repository source under `totalfinance/site/`, with a separately built static output;
it is neither an extra published compute package nor an already-deployed service.

The earlier rehearsal is **historical, not evidence for the integrated revision**. Its recorded
`7292d43e47c1c3fd49232d6731af29a67a58fb58` could not be fetched from the PR remote during review, and
the MCP/site changes alter package contents and installed-example verification in any case. Preserve
the old record as history; do not relabel its hashes as current or use it for release approval.
Generate a fresh rehearsal from the final committed revision after the maintainer's additional
pre-release work. The public-registry smoke and retained receipt still require a real authorized
publication; a local rehearsal cannot replace them.

The maintainer explicitly requested more work before release on 2026-09-07. Integration is not a
publish instruction: follow `implementation-order.md`, complete that next scope and the outstanding
browser/host checks, then rerun the every-public-publish gate. The first release version remains
`0.1.0-preview.0`; do not change package versions or publish tags during this integration.

## Acceptance and exit gate

For the current combined library-and-website launch, execute the
[preview launch queue](../implementation-order.md#preview-launch-queue-2026-09-07) first: search,
organization/CI/integration prerequisites, domain-dependent site polish and browser/data acceptance,
then the exact-revision release gates below, registry smoke, matching docs deployment and announcement.
Prerequisite organization work can run in parallel with search; publication cannot precede approval.

- [x] Every package in the fixed group satisfies Decision 3 exactly; `STABILITY.md` ships and the
      audit reads it (slice 1 `257ebefc1`, proven by the slice 2 audit `87c4fb42d`).
- [x] The preview-surface audit rehearses FC9's discovery, cold-user, semantic-parity,
      generated-evidence, and packed-consumer checks over the current surface and is part of CI
      (slice 2, `87c4fb42d`).
- [x] `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and the rollback runbook exist before
      the first publish (slices 1–2, `87c4fb42d`).
- [x] `pnpm release:dry-run` produces the hash manifest; the release workflow refuses a version
      mismatch, requires the approval environment, publishes with provenance, tags, and creates the
      release (slice 3, `80650531d`; the workflow's first real run is slice 4).
- [ ] The registry smoke tool is proven against a local registry in CI (slice 3, `80650531d`) and run against the public
      registry after the publish (slice 4).
- [ ] The preview is published at `0.1.0-preview.0` under the `preview` dist-tag for the whole fixed
      group, atomically, from one tagged commit; clean consumers install and run the journeys from
      the public artifacts.
- [ ] Nothing in the core contracts changed by shipping work; the trackers name one commit
      (amended 2026-09-04 and 2026-09-06: Stages 4.6, 4.7, 7B.1, and 7B.2 closed at `839a955e7`,
      `530eb6de8`, `f7677ebcb`, and `44cd9d72e` before the publish, by the maintainer's decision; the
      row after this publish is Stage 5B).

## Slice records

### Slice 1 (landed 2026-09-03, `257ebefc1`) — metadata and the stability statement

**What landed.** Every one of the twenty-five `package.json` files now matches the Decision 3 table:
`publishConfig` is `{ access: 'public', provenance: true }`, `files` carries `STABILITY.md` beside
`LICENSE`, `keywords` opens with `totalfinance` and names the package's domain, `engines.node` is
`>=22.13.0`, `homepage`/`bugs` point at the public repository (the `workflows` package was missing
both), and the four packages that had no `LICENSE` copy (`commodities`, `foreign-exchange`,
`portfolio`, `research`) have one. `STABILITY.md` (Decision 2: the three tiers, the series, what every
tier shares, the fixed group) lives at the root and is copied byte-for-byte into each package.
`docs/stability.md` is rewritten as its long form — per-package tiers, what stable-by-law means before
1.0, how a tier changes — replacing the pre-normalization `stable-candidate` table that still
described names Phase 3B.N retired. The root README's Status paragraph and Packages table, and the
docs index, now say twenty-five packages, Stage 7A complete, Stage 5A current, and the
`0.1.0-preview.N` series (they said fifteen packages, `0.0.1` pinned, Phase 3B current).
`.changeset/config.json` has `baseBranch: develop` and no longer names an `@totalfinance/example-*`
ignore glob for packages that do not exist (the changesets CLI refused to run on it); the preview
changeset `first-public-preview.md` bumps all twenty-five packages `minor`, and the repository is in
pre mode under tag `preview` (`.changeset/pre.json`, `initialVersions` = 25 × `0.0.1`).
`SECURITY.md` (Decision 5) came forward from slice 2 because the stability page links to it and the
docs-conformance gate refuses a dead link.

**Decisions at landing.**

1. **The first version is `0.1.0-preview.0`, not `.1`**: changesets numbers a prerelease series from
   0; Decision 1 and the exit gate now say so.
2. **`STABILITY.md` is one file copied, not a template rendered**: the slice-2 audit asserts the copies
   are identical to the root, so a drift is a failing test rather than a stale package.
3. **Package versions stay `0.0.1` until the release step runs `changeset version`**: the bump is part
   of the tagged release commit (Decision 6), so a preview consumer never sees a version that was not
   published.

**Evidence.** `pnpm run ci` exit 0 at the landing tree (472 test files, 10,146 tests; the second `pnpm test:coverage` pass recorded in the landing commit's push); `pnpm api:check` exit 0. `tools/docs-conformance.test.ts` and `tools/generated-docs.test.ts` green over the rewritten README, docs index, and stability page; the roster, layer-model, and contract-conformance gates green over the metadata change (54 tests). `.changeset/pre.json` records `mode: pre`, `tag: preview`, twenty-five `initialVersions`.

**Gate findings at landing.** The docs-conformance gate refused `docs/stability.md → ../SECURITY.md` as a dead link, which is how `SECURITY.md` came forward from slice 2 — the gate did its job. The changesets CLI refused to run at all while `config.json` named an `@totalfinance/example-*` ignore glob for packages that do not exist; the glob was a promise about a workspace that never materialised and is gone. No ratchet moved; no generated artifact changed (metadata is outside every regeneration input).

### Slice 2 (landed 2026-09-03, `87c4fb42d`) — the preview-surface audit, community files, rollback ownership

**What landed.** `tools/preview-surface-audit.test.ts`: FC9's rows rehearsed over the current
surface on every push, each `describe` named by the row it carries. The audit reads the fixed group
from `packages/*` (never a list in the test), so a new package is audited the moment its directory
exists. It proves directly what no other gate reads — every Decision 3 metadata rule per package
(name/version/private, description, `totalfinance` + domain keyword, Apache-2.0 + `LICENSE`, the public
repository in `repository`/`homepage`/`bugs` with the package `directory`, `module` type,
`sideEffects: false`, root entry fields, `types`-first `exports` that resolve to built files and
export `./package.json`, the exact `files` list, the Node floor, `publishConfig`, `bin` shebangs
and `dist` targets on the three transports and nowhere else, dependency ranges with no
devDependency leak, `.js.map`/`.d.ts.map` beside every built file with `src` shipped); the
stability statement (the tiers, the series, the package count as a claim the file makes, every
member named, the byte-identical copy in each package, the tier per package in `docs/stability.md`,
changesets in `preview` pre-mode over exactly the fixed group); discovery (every domain package is
an umbrella namespace and subpath, no wildcard root hoist, every README has a fenced example);
and it names the gates that carry the cold-user, parity, generated-evidence, and packed-consumer
rows and asserts each is present and not excluded from the suite, plus the `ci` script's exact
order. `CONTRIBUTING.md` (spec first, the laws, the regeneration order, the landing standard, what
we say no to), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, private reporting through the
repository), and `docs/runbooks/release-rollback.md` (owner = the approving maintainer; dist-tag
reversal first for the whole group; 72-hour unpublish in dependency order versus `npm deprecate`
after it; tag and release deletion; the evidence note; the message template) — linked from the root
README's Develop section and a new "Runbooks and policies" section of the docs index.

**Decisions at landing.**

1. **The audit is a table of contents over the evidence, not a second copy of it**: rows another
   gate already proves are asserted present and wired, never re-run — no duplicated plumbing.
2. **The domain keyword is the directory name**, so the rule is objective; `structure` had only its
   marketing words (`dealer-positioning`, `gex`) and gained `structure`.
3. **The release-plumbing `it`s belong to slice 3**: a test for scripts that do not exist yet is a
   claim about the next slice, not this one.

**Evidence.** `pnpm run ci` exit 0 at the landing tree (473 test files, 10,195 tests — the audit adds 49 cases); `pnpm api:check` exit 0; the second `pnpm test:coverage` pass all green. The docs gates (`tools/docs-conformance.test.ts`, `tools/generated-docs.test.ts`, `docs/examples/readme.test.ts`) green over the new files and links.

**Gate findings at landing.** The audit's first run over the slice-1 tree failed twice, both real:
`@totalfinance/structure` lacked its domain keyword and `@totalfinance/workflows` had no `module` field —
slice 1's hand inventory had missed both, which is exactly why Decision 2 made the statement a gate
rather than a checklist. Nothing else moved. The typecheck also refused the audit's `root.scripts.ci` access (TS4111, index signature) on the first CI run; corrected to a bracket access. No ratchet moved; no generated artifact changed beyond the docs inventory.

### Slice 3 (landed 2026-09-03, `80650531d`) — release plumbing: the dry-run manifest, the approval-gated workflow, the registry smoke rehearsed

**What landed.** `pnpm release:dry-run` (`tools/release/dry-run.ts`): refuses a dirty tree, runs the
landing standard unless `--skip-ci`, packs the fixed group into the git-ignored `release/`, and
writes `RELEASE_HASHES.json` — `{ package, version, tarball, sha256, bytes }` per artifact plus the
commit; `--expect-version` refuses a tree at any other version. `pnpm release:publish`
(`tools/release/publish-tarballs.ts`) re-checks every tarball's sha256 against the manifest and
uploads exactly those tarballs — nothing is re-packed after approval — with provenance on for
npmjs.org and explicitly off for a loopback rehearsal registry, and it refuses any other host. `pnpm release:smoke`
(`tools/release/registry-smoke.ts`): a fresh directory installs the whole group at the exact version
from a registry or from the dry-run tarballs, every installed package is checked for the version,
`STABILITY.md`, and `LICENSE`, then the consumer journeys run — the five-minute SDK journey, the CLI
listing and running an operation with its result compared to the SDK's, `totalfinance-http --openapi`,
the MCP tool list — and their canonical outputs are compared to the committed
`tools/release/smoke-expected.json` (written once from the workspace tarballs with
`--write-expected`). `.github/workflows/totalfinance-release.yml`: `workflow_dispatch` only with the
exact version as input; `verify` refuses a version the tree does not carry or a tag that already
exists, runs `pnpm run ci`, and uploads the manifest; `publish` waits on the `npm-publish`
environment, downloads the approved artifact, verifies it, and publishes those tarballs under the
`preview` dist-tag with provenance from the OIDC token, pushes `totalfinance-v<version>`,
and creates the prerelease with the changelog excerpt (`tools/release/changelog-excerpt.ts`) and the
manifest attached; `smoke` installs from npmjs.org and blocks the announcement. The file locates the
library itself so it runs unchanged from the private monorepo or the public mirror. `totalfinance-ci.yml`
gains `release-rehearsal`: dry-run, a Verdaccio started in the job (`tools/release/verdaccio.yaml`:
the `@totalfinance` scope has no uplink, so a forgotten package cannot be filled in from npmjs), the
local publish, and the smoke from that registry — the publish tooling is proven on every push.
`docs/runbooks/release.md` is the driver's page; `docs/evidence/release-dry-run-<version>.json` is
the manifest of the rehearsal at this commit. The audit gains the release-plumbing `it`s.

**Decisions at landing.**

1. **The approved artifacts are what ships, not a rebuild of them.** The first design re-packed in
   the publish job and compared hashes; the rehearsal here showed two packs of one commit differ —
   `pnpm pack` rewrites `workspace:*` dependencies in a non-stable key order (nine of twenty-five
   tarballs differed by that alone). So the manifest names reviewed artifacts and the publish
   uploads them unchanged; a maintainer approves bytes, and those bytes reach the registry.
2. **One publish tool for both registries, loopback-only or npmjs.org**: provenance is decided by
   the host (attested on npmjs, off on a loopback rehearsal), and any other host is refused.
3. **Expectations are written from the tarballs, not from the workspace**: the smoke's question is
   "did the registry hand consumers what we approved?", never "does the library work?" — `pnpm run
ci` answers that before any publish.
4. **The workflow lives at the monorepo root and finds the library** rather than existing twice;
   in the mirror (Decision 8 option A) the same file runs at the root.

**Evidence.** The rehearsal at this commit: `pnpm release:dry-run --skip-ci --allow-dirty` packed 25 artifacts and wrote the manifest (committed as `docs/evidence/release-dry-run-0.0.1-rehearsal.json`); a Verdaccio started from `tools/release/verdaccio.yaml` received all 25 through `pnpm release:publish --registry http://localhost:4873` (exit 0, provenance off); `pnpm release:smoke --version 0.0.1 --registry http://localhost:4873` installed the group back from that registry and reported 23 operations, 44 OpenAPI paths, 23 MCP tools, every journey equal to the committed `tools/release/smoke-expected.json` (exit 0). `pnpm run ci` exit 0 on every step (474 files, 10,203 tests; the one documented vitest `onTaskUpdate` reporter timeout, no test failed); `pnpm api:check` exit 0; the second `pnpm test:coverage` pass all green. `tools/release/changelog-excerpt.test.ts` covers the excerpt; the audit's release-plumbing `describe` (5 cases) is green.

**Gate findings at landing.** The first `--verify` design failed its own rehearsal: nine of twenty-five re-packed tarballs differed from the manifest by the order of the rewritten `workspace:*` dependency keys in `package.json` (tar mtimes are fixed; content was identical otherwise) — recorded as Decision 1 above and the reason the publish uploads the approved tarballs. The `.gitignore` entry `release/` silently ignored `tools/release/` as well (git and prettier both), which is how four unformatted files reached `format:check`; the entry is root-anchored (`/release/`) and the audit asserts that spelling. The cancel-from-another-process CLI fixture failed once in a loaded second coverage pass (the job was already `failed` when cancelled) and passed three isolated runs and an idle full pass; the assertion now reports the record's error so the next occurrence names its cause instead of a state.

## Review record (self-review against the laws, 2026-09-03)

**Accepted 2026-09-03; implementation began with slice 1 (`257ebefc1`).** Decision 8 stays open for the
maintainer and blocks only slice 4.

- **Publish is outward-facing and irreversible** — the contract puts a human approval (the
  `npm-publish` environment) between the dry-run hashes and the registry, and writes rollback
  ownership first (queue §5's every-public-publish gate, verbatim).
- **No duplicated compute or plumbing** — the audit reuses the existing gates (parity, packed
  consumer, generated docs, readme snippets) and adds only metadata, files, and release automation.
- **Lovability** — a consumer reads one `STABILITY.md`, sees a version that says preview, gets
  source maps that resolve, and finds `SECURITY.md` where GitHub looks for it.
- **The one open decision is named** (Decision 8) rather than assumed silently; slices 1–3 do not
  depend on it.
