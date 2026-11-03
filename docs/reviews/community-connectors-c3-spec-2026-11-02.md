# Community connector C3 spec review evidence

Status: **spec-only review candidate; no C3 runtime approval or implementation**.
Request `3974edf7-0690-81d9-ba59-8f39791dc6da`; existing feature
`01a19da0-2a6f-7450-89a4-2e51047b05b5`, execution `01a19da1-1351-7b84-b67f-58bc81698fb5`.

## Isolation and authority

Read the entire current Ri task body through get_task (revision15 at start), including C0/C1 review
corrections, rejected C2 projection, accepted view, interrupted implementation/recovery and final
C2 green receipts. Verified the existing execution/task link via list_task_executions. No new task
or execution. The maintainer approved the root-import/key/connect/priceBars/existing-SMA experience;
the coordinator requested a decision-complete spec before runtime work, not another infrastructure
proposal or a generic maintainer approval question.

Created local worktree `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c3-connection`, branch
`totalfinance/community-connector-c3-connection`, based exactly on
`71da9d1fb674932f5fc21a780039aeccd9186d6b`. The [spec](../specs/community-connector-c3-connection.md)
and active queue are the authored deliverables. No remote push, PR edit or branch switch occurred.

C1 SDK b5c3c83/provider c492d2d and C2 SDK71da9d1/provider075d595 remain immutable historical heads.
The current C2 source is SDK7daa6cde/provider47c2883; coordinator receipts report 546 SDK tests/21
files and83 provider tests locally and installed. C2 exact-head fast41542589873 (8 jobs) and
full41542644979 (23 jobs) passed. These are read from the durable Ri handoff, not rerun in C3.
Artifact SHA256: SDK23193bf720db33cd9ac1780a3f9525e81d021b99f260223ae1d65d883d22d5bf;
provider442ae93eeee5f48284918f83c4f16ac9b9ca5cb99ebeceaec650da1074ba5b9e.
Their stored C2 records supersede this execution's interrupted snapshot; that partial snapshot is
not current implementation status. No C3 implementation/consumer/hosted acceptance is claimed.

## Source evidence read

Read AGENTS.md, CONTRIBUTING.md, current implementation queue, the complete C0 foundation and C2
consumer-view specs, C2 final review receipts and external VERIFICATION.md. Checked data-layer.md
against the later controlling specs; its old fluent client/provider inventory does not override the
community model. Relevant current source observations:

| Evidence at the stated base                                                                      | Finding and design consequence                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| packages/core/src/data-types.ts and data.ts                                                      | Distinct raw DataProviderSource and validated consumer DataProvider; generic query returns SDK view. Keep consumer as one connector boundary and preserve factory/kit protocol. Construction binds methods without calls.                  |
| packages/core/src/data-validation.ts: requestData, pageData, rowKey/compareKeys                  | Existing closed financial grammar, real date/instant bounds, original first-page filter validation, row/page source/time/OHLC laws. Apply original bounds on every window page; share these validators rather than invent another runtime. |
| packages/core/src/data-view.ts                                                                   | C2 lazy immutable native arrays, field-specific missing volume, page storage/restoration; reuse their rules for a distinct retained-pages window, without a fake aggregate page.                                                           |
| packages/core/src/data-conformance.ts                                                            | Independent expected facts plus view/array correspondence, bounded walks and snapshot/order/identity laws. Keep runner separate; extract only small pure shared validation, retaining independent mutants.                                 |
| packages/totalfinance/src/index.ts and package.json                                              | Existing namespace topology and root import tradeoffs; core dependency already exists. Add curated data namespace/facade, with no provider dependency.                                                                                     |
| tools/assemble-distribution.ts: expectedMetadata and tools/public-packages.ts: publicSourcePaths | Both skip non-root umbrella exports today. /data requires an explicit narrow export-path exception and tests, not merely a source file or source alias.                                                                                    |
| tools/bundle-size/{measure,workspace-alias,budgets,consumer-fixtures}.ts                         | Whole exports use esbuild/browser/ES2022/gzip; installed consumers are separate. Existing 696.25KiB ceiling and narrower budgets remain unchanged pending measurement.                                                                     |
| packages/technical-analysis/src/{index,overlap,bars}.ts                                          | Existing SMA/SMA.explain and VWAP/BarInput provide the calculation side; no engine/indicator grammar change is necessary.                                                                                                                  |
| Provider C2 src/index.ts: factory and query/cursor validation                                    | Direct key, optional native infrastructure defaults, local discovery, one HTTP per query. Original bounds/exact nextFrom, resource/dataset/snapshot pins already validated. High-level SDK walk must preserve those checks.                |

No linked API-server source was edited or queried. Existing C0 source-backed HTTP mapping evidence
and current adapter source suffice for this SDK composition proposal; no guessed endpoint/payload
or new source mapping is introduced. Preview default remains the documented staging origin, with
no production selection, constructor request or live access permission.

## Exact proposal and limits

The primary file stays the maintainer-approved two-import root example. connect takes only the
C2 DataProvider, synchronous and call-free at construction. New priceBars omits kind/limit and
walks to terminal within operational ceilings (default1000 rows/page,20 calls,20000 records;
one capabilities call in addition). Calls may lower host ceilings; no retries/cache/background work.
Advanced query remains one page and chains remain research only.

Result is a frozen view with closePrices/strict lazy ohlcvBars and canonical window record containing
original request, every original page and terminal page-call/row counts. No merged provenance/time/
coverage/quality fiction. createPriceBarsWindowView restores that record locally; selector lies
refuse against raw correspondence. Unknown volume blocks only OHLCV, not closes; no blanket partial
quality ban. Original bounds, identity/order/cursor/pins/adjustment changes refuse, as do unfinished
budget walks. One new workflow code data.window_budget_exceeded distinguishes metering refusal
from upstream exhausted allowance. Caller signal/deadline propagates and prevents late success.

No unresolved product choice is needed for this technical review. Proposed defaults/storage/error
details are recommendations for review, not details the maintainer has already seen or approved.
The exact root feature budget is a later measurement-dependent review gate; no threshold edits here.

## Documentation-pass verification

Pinned Node22.23.2 / pnpm10.32.0. Frozen install passed with unchanged lockfile. Existing cyclic
workspace and absent not-yet-built CLI bin-link warnings were observed; no runtime build needed
for this documentation-only change.

Measured **unchanged C2 source** using existing tools/bundle-size/measure.ts + workspaceAlias,
esbuild0.25.12, repeated identically twice: 2,636,332 minified bytes, **712,661 gzip bytes**. Ceiling712,960; headroom299 bytes.
This measures no proposed C3 source. No registry/helper optimization or gate edit is justified from
this baseline. C3 must record its actual marginal graph/bytes before proposing a root-only change.

Final documentation conformance passes **24/24 tests** in tools/docs-conformance.test.ts. The affected
inventory generator reports **247 surfaces, 4,641 executable fences, zero findings** (175 truthfulness,
61 vocabulary). Scoped pinned Prettier and git diff --check pass; the lockfile is unchanged.
Both reviewed C2 worktrees were rechecked read-only: clean at the exact heads above; provider has
no remotes. These documentation checks do not certify C3 runtime or alter C2 hosted acceptance. Runtime/API/generation/packed tests are future C3 acceptance and
are not claimed by a doc check. Only the affected documentation inventory generator is run here;
source signatures/contracts/enforcement/API/build/bundle documents have no changed inputs.

Exact documentation commands in the new worktree:

```sh
export PATH=/Users/agent/Library/pnpm/nodejs/22.23.2/bin:$PATH
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm exec prettier --write docs/specs/community-connector-c3-connection.md docs/reviews/community-connectors-c3-spec-2026-11-02.md docs/implementation-order.md
pnpm exec tsx tools/manifest/docs-inventory.ts
pnpm exec prettier --write tools/manifest/public-docs.json
pnpm exec vitest run tools/docs-conformance.test.ts
pnpm exec prettier --check docs/specs/community-connector-c3-connection.md docs/reviews/community-connectors-c3-spec-2026-11-02.md docs/implementation-order.md tools/manifest/public-docs.json
git diff --check
```

The inventory was regenerated after final authored edits; it was not manually patched. No source,
release metadata, generated API, generator implementation, gate or threshold changed. The commit
containing this document is the spec handoff commit; its exact SHA is returned through Ri so it need
not be embedded recursively in its own evidence.

## Excluded actions and remaining acceptance

Feature stays in_progress; PR26 stays draft/open/unmerged at reviewed C2 head. C3 technical review
precedes runtime and any later implementation branch/PR updates. Consumer10/10, connected staging
with separately configured access/new allowance, agent glue, paper journey and App remain distinct.
No secrets/environment-key read, staging request, allowance reset/reuse, key/grant/account/paper
operation, provider repository edit/remote creation, API-server edit, version/release/publication/
deployment, recurring automation or live execution occurred.

## C3 technical approval and bounded implementation

Request3fa03c0a-dcc3-8e42-a19a-63e21bc53649 approved spec f6c99cfed38dc44c6ca0cc6279cf5a703014f04e
after the coordinator read all374 lines and full evidence. Clarifications recorded before code:
SDK output arrays are ordinary frozen native arrays; browser validation cannot detect every
transparent provider Proxy. Advanced query stays one-page/zero-discovery, and lazy delegated
selectors share the window checks without repairing lies or eagerly touching OHLCV.

Root ceiling712960B and all narrower gates remain unmodified. Actual source and installed
measurements must return for technical review before any threshold edit if they exceed ceilings;
new /data initial budgets require that measured review too. Source/local checks are intermediate,
not hosted/complete acceptance. Feature stays in_progress and reviewed C2 trees remain untouched.
