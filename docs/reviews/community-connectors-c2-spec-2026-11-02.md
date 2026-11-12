# C2 SDK-first provisional specification handoff — 2026-11-02

Status: **historical spec review; e1e5a910 approved for bounded offline implementation.**
The original rejected handoff and later revision/approval remain below; current implementation evidence
is in [the C2 record](./community-connectors-c2-2026-11-02.md).
Feature `01a19da0-2a6f-7450-89a4-2e51047b05b5` stays in progress with existing execution
`01a19da1-1351-7b84-b67f-58bc81698fb5` attached.

The sections through Verification and limitations below retain the original 4fc5f9d handoff as
historical evidence. The appended coordinator disposition and revision supersede its helper design,
quality refusal and unresolved broad product question; they do not erase that review history.

## Isolation and controlling feedback

New worktree: `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c2-addendum`.
New branch: `totalfinance/community-connector-c2-spec`, based on reviewed SDK
`b5c3c83fbeb9197dde9714cfeee9b8fb2e960083`. No branch switch or edit in shared/C1 checkouts.
External provider C1 remains `c492d2d15a1aeeb0ba2104fe55066d017bf66474` at the same local-only repository.
PR26 remains draft, with its original green fast/full exact-head checks intact.

Required request 50853bf4-78d3-8bac-bcc9-9d358fb94ff6 initially asked for decision-complete host
integration. Later messages f34544c7-0432-8fbe-9464-9df4e5da2e12 and
941bb23d-461d-87e7-88b3-2cd29fbc2c4a explicitly changed the next checkpoint: keep it provisional,
show ordinary SDK data-to-existing-calculation use first, reassess unnecessary wrappers, and do not
start async-runtime implementation. The [C2 draft](../specs/community-connector-c2-integration.md)
follows that later steering. It is not marked decision-complete while the primary experience is
being resolved with the maintainer. No generic permission question is introduced.

## Concrete review candidate

- Direct credential factory argument with optional infrastructure overrides; documented private
  preview staging origin and invisible native fetch/receipt-clock defaults. No environment guess.
- Direct query request rather than query({ request }), optional discovery options rather than
  mandatory empty objects; revise the unreleased interface/kit together without aliases.
- Shared pure closePrices and ohlcvBars projections in the existing opt-in core/data subpath,
  preserving the complete frozen source page beside projected values. Existing SMA/VWAP explain
  calls and engine behavior remain unchanged. No provider-specific manual mapping in the target.
- Explicit malformed/missing/zero/partial/pagination/source-time rules; missing volume refuses
  OHLCV projection before a volume-based engine can apply an implicit zero.
- Optional MCP convenience/advanced composition requirements remain documented as later work;
  the host/async API is not frozen or approved in this SDK-first checkpoint.

The genuine unresolved product question is whether the short explicit SDK sequence is the desired
experience, or which specific composed workflow the maintainer wants instead. Factory/query and
projection signatures are concrete proposed choices for that review, not implemented exports.
The staging preview origin is already selected by the request and needs no new deployment decision.

## Evidence inspected

Read AGENTS/CONTRIBUTING, the controlling C0/C1 spec and full original agreed direction, the active
queue, current provider factory/query/README and installed rehearsal, core data types/validation,
TA public exports/framework/columns/VWAP/OBV/registry, workflow operation/registry/runtime/stores/
profiles/workers, MCP server/tools/tool-kit and programmatic HTTP host contracts. C1 original
source and independent/hosted acceptance are preserved as prior evidence.

The existing installed smoke path uses public SMA on manually projected normalized closes and
asserts 101.5; this proves engine composition today but does not justify poor consumer ceremony.
Confirmed that barsFromColumns/columnsFromBars are public, whereas closes is internal and is not
publicly exported. columnsFromBars derives columns from the first row and is not a mixed-field
acquisition validator. Existing VWAP/OBV use volume ?? 0. Those concrete facts motivate the strict
shared projection candidate; no new financial calculation is needed.

The sync operation contracts cannot simply accept an async provider callback. That is a dependency
for optional agent/host orchestration, not a reason to make SDK users configure MCP or implement a
new runtime before validating the consumer example.

## Verification and limitations

Pinned Node 22.23.2 / pnpm 10.32.0 selected explicitly. Frozen install passed with unchanged lockfile.
It printed the existing cyclic-workspace warning and missing not-yet-built distribution binary-link
warnings; no build or dependency graph change was needed for this documentation-only work.

Scoped pinned Prettier formats only the changed Markdown and generated documentation inventory.
The inventory is regenerated by its existing tools/manifest/docs-inventory.ts owner, never edited
by hand. Documentation conformance passed 23/23 on the SDK-first draft before this receipt was
added; final inventory/format/conformance/diff checks cover the committed set as well.

Only documentation and its derived inventory change. No API/signature/financial-contract/bundle/
OpenAPI/runtime source changed, so full implementation regeneration, first-touch, packed-consumer,
bundle tests and hosted C2 runtime CI are not claimed or required for this spec-only checkpoint.
Their exact targeted future acceptance plan is in the draft. No C1 checks were rerun or invalidated
by commits on this separate branch.

No reviewed C1 tree, linked application, .env, secret, licensed response, staging service, allowance,
key/grant, active paper/account/journal/policy, release version, remote provider repository, deployment,
publication, merge or recurring automation was touched. No C2 runtime export, SDK example execution
against proposed APIs or connected-agent acceptance is claimed. The existing task/Ri outcome will
record the exact spec commit and final documentation checks after commit.

## Coordinator review of 4fc5f9d: changes requested

Request d5f95724-5d5d-8c4e-9e08-b2b658fa658a reviewed all 328 spec lines and the full evidence.
Exact disposition: **"changes requested; no C2 implementation approval."** Direct credential,
direct query, optional discovery and invisible defaults were sound in principle. The primary
example's third import, helper call, values/source unwrapping and manual report assembly did not
yet demonstrate the maintainer's requested experience. The coordinator required a small SDK-owned
consumer data view, an explicit financial field selection, field-specific missing-input refusal
rather than blanket partial-quality rejection, and precise page-sample semantics rather than a
broad data.incomplete_page policy. 10/10 consumer lovability remains an acceptance condition.
This exact disposition was appended to the feature task before revision (body revision 9), without
marking completion or implying source implementation approval.

## Revised candidate and reasoning

The primary example now has two imports: external factory plus existing SMA. It configures one
credential, queries once and passes prices.closePrices directly to SMA. Common core/data code
constructs the consumer view; providers still implement only normalized raw sources. prices.page
retains the exact validated raw page, metadata and source/page/row diagnostics. Pure calculations
and raw-page interoperability remain unchanged. No source is automatically copied into a plain
numeric result and no manual report assembly is required for the primary calculation.

The spec explicitly compares and selects this view over the old helper, decorated arrays and a
provider-bound calculation client. Series are plain frozen native arrays with no source decoration;
the parent view owns context. Strict OHLCV access is lazy so unknown volume cannot block valid
close selection. The reason for rejecting decorated arrays is concrete: the existing canonical
scanner rejects non-index array members, while existing SMA already accepts ordinary arrays.
View accessors are SDK behavior; canonical storage/hashing remains the unchanged raw .page.
Serialization/restoration and no hidden materialization of strict OHLCV fields are specified.

quality.partial and other disclosed source limits do not block known fields. Missing volume on
any row blocks only OHLCV selection/VWAP, with zero retained. Nonterminal pages and terminal
continuations expose exactly their own samples without auto-paging, refusal just for a cursor,
or complete-history assertions. The broad proposed data.incomplete_page policy/code is removed.
Invalid required financial values and typed access/cancellation failures still refuse.

Exact proposed source/consumer interfaces, view types, factory/default/override behavior, SDK-owned
placement, kit migration and a small synthetic/packed proof plan are in the revised spec. There
is no new broad question handed to the maintainer in place of a recommendation. The candidate is
provisional for technical/product review and is not claimed accepted, implemented or 10/10.
Optional agent/MCP/async work remains deferred and cannot be inferred from this revision.

## Revision verification scope

This revision changes only the written spec, queue, review evidence and derived docs inventory.
The existing pinned frozen install/lockfile is unchanged. Final documentation conformance,
inventory, scoped pinned format and diff results are recorded in the Ri outcome for this commit.
No source/API/gate/bundle/OpenAPI generation, runtime test, installed C2 artifact or hosted C2 pass
is claimed. New synthetic cases are a precise implementation proof plan, not completed evidence.
Reviewed C1 SDK/provider heads, draft PR26 and their exact-head green CI remain intact.

## Technical approval and direct source correction

Request754a6ffa-2218-8bba-9767-5c98b322390c approved the bounded SDK-first implementation at
e1e5a910ef1ca50778c80dd68c8931952f4a6575 after reading all346 lines and evidence. One consistency
correction is approved before runtime work: defineDataProvider(source), without an extra provider
envelope. Wrapper/source/consumer/kit/fixtures/examples migrate together. Earlier changes-requested
history remains above. This is technical implementation authority, not a claim of 10/10 consumer,
connected acceptance, merge or release approval. Implementation uses the existing C2 SDK worktree
and separate provider worktree /Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view,
branch connector/sdk-consumer-view, based on immutable C1c492d2d. C1 SDKb5c3c83 is untouched.
