# C4: trustworthy mappings and a complete first author journey

Status: **approved for bounded offline implementation at d6cc42b; review a55531a4**.
Date: 2026-11-11. Task `01a19da0-2a6f-7450-89a4-2e51047b05b5`, existing execution
`01a19da1-1351-7b84-b67f-58bc81698fb5`. Request `d934bdb1-173a-84e5-914a-b1c63364ca2f`.

The maintainer authorized these repairs. This checkpoint reviews the written public contract,
not whether to begin the already authorized work. The consumer flow remains exactly C3:
`data.connect(provider)` → `priceBars(request)` → existing `technicalAnalysis.sma(prices.closePrices, {period})`.
No new client, indicator grammar, registration, MCP infrastructure or financial default.

## Evidence and integration

The full independent review and synthetic evidence under the originating checkout's
`docs/reviews/pr26-first-consumer-2026-11-02.md` and `pr26-consumer-evidence/` are controlling
reproductions. Their original observations must not be rewritten. The earlier C3 no-blocker
acceptance and green CI at `e5e9e95433d798bbaa9378386f2f391568ce7fba` are historical and
superseded as the current review disposition. New acceptance requires correcting these findings.
The coordinator's additional receipt is `/tmp/tf-pr26-review-assessment-repro.json`.

New SDK tree: `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c4-review`, branch
`totalfinance/community-connector-review-updates`, created at exact e5e9e95. Fetched main is
`ca122ab3115ea08cc8789fd7d1be8380382fdc6c`; common merge base is
`d50b401ee237006c75c76ef90784e5dcde1439a3`.
Main integration was attempted without committing. It exposes real authored and derived conflicts;
the attempt was aborted so this spec checkpoint has a clean, independently reviewable commit.
Integration is the first implementation slice, not complete or a product blocker. Never edit or
switch the shared/originating/C1/C2/C3 trees. Preserve main's 0.1.3 versions, upstream TA bar
projection/runtime/dogfood and release tooling. No new release bump. Resolve authored conflicts
by retaining both changes; regenerate derived conflicts after final integrated source. Do not
resolve generated evidence by pretending either old inventory is the combined result.

## 1. Raw author typing; consumer inference unchanged

Replace only the raw source method declaration in `packages/core/src/data-types.ts`:

```ts
query(
  request: DataRequest,
  options?: DataCallOptions,
): Promise<DataPage<PriceBarRecord> | DataPage<OptionChainResearchRecord>>;
```

`DataProviderSource` keeps identity/version/capabilities. No new overload, factory, helper alias
or distribution. A daily-only author can write `async query(request: DataRequest):
Promise<DataPage<PriceBarRecord>>`, explicitly reject unsupported requests, and return a naturally
typed page without `as DataPage<never>` or a conditional-return assertion. This union is of the
existing homogeneous pages, not `DataPage<PriceBarRecord | OptionChainResearchRecord>`.
The existing DataPage kind field is not made a new generic type parameter in this repair.
Runtime validation still enforces request/response kind and every row, including continuations.

Keep consumer `DataProvider.query<R extends DataRequest>(request: R, options?: DataCallOptions):
Promise<DataViewFor<R>>` and all C3 connection/window declarations unchanged. Migrate wrapper,
fixture, kit and independent InsiderFinance source to the new raw signature. Internal SDK narrowing
may need a checked assertion; normal author teaching must not. Strict NodeNext and Bundler tests
compile an independent daily-only package, preserve consumer inference/readonly inputs, and show
wrong response kind refusing at runtime. Do not claim compatibility with registry packages lacking
these unreleased exports. The external preview's local SDK peer/dev metadata must track the actual
0.1.3 tarball without changing its 0.0.0 package version or claiming published compatibility.

## 2. Adjustment facts must agree when both are known

In common page validation, for each price row:

| Page adjustment             | Row adjusted flag     | Result         |
| --------------------------- | --------------------- | -------------- |
| unadjusted                  | false                 | retain         |
| split or split-and-dividend | true                  | retain         |
| unadjusted                  | true                  | refuse         |
| split or split-and-dividend | false                 | refuse         |
| unknown                     | true, false or absent | retain exactly |
| any valid basis             | absent                | retain exactly |

No inference or insertion of a flag/basis. Existing strict cross-row/page basis consistency stays;
C4 does not relax mixing unknown/known rows across a sequence. Shared `pageData` validation enforces
this relationship before a view is usable, covering raw wrapper, createDataView, connected query,
priceBars, canonical window restore and kit. No adjustment arithmetic or source mapping conversion.

## 3. Real option identity is the final ordering tie-breaker

Common chain row key becomes the tuple
`[terms.expiry, terms.strike, callBeforePut, sourceContractId]`. Numeric strike comparison and
call=0/put=1 stay unchanged. Compare IDs by deterministic JavaScript string code-unit ordering,
case-sensitive, with no locale sorting/normalization. Use actual supplied IDs, never root or a
manufactured OCC identity. Keep independent sourceContractId uniqueness within/across pages even
when duplicate IDs have different terms. Strict tuple order still refuses reversed ties.

Apply shared rowKey/compareKeys semantics to wrapper, sequence checks and kit. Two roots/IDs with
the same expiry/strike/right can appear in one page or adjacent pages when ordered by real ID.
No sorting, dropping records or changing terms to make a page conform.

The reference adapter's private cursor key currently has three terms and validates that arity.
Its feed already merges roots. Keep that provider-specific cursor format, original filters,
opaque upstream token, resource and snapshot pins unchanged; core's broader ordering does not
require that narrower adapter to manufacture additional rows or rewrite old cursors. Inspect and
rerun its same-term/ID collision refusal tests separately. A new concrete adapter defect would
need a focused correction, not a speculative cursor redesign.

## 4. Safe actionable response diagnostics

Retain outer `DataError` / `data.invalid_response`. Add controlled context fields to SDK-generated
response-validation errors; no new ErrorCode registry member or public runtime export is needed:

```ts
// Context schema, not a second public error class.
{
  phase: 'capabilities' | 'page' | 'view' | 'sequence' | 'window',
  path: string,          // SDK-authored canonical schema path only
  reason: 'missing_field' | 'wrong_type' | 'not_finite' | 'out_of_range'
    | 'invalid_enum' | 'inconsistent' | 'out_of_order' | 'duplicate_identity'
    | 'invalid_structure',
  validationCode: string, // registered input.* code for primitive failures;
                          // data.invalid_response for semantic failures
  rowIndex?: number,    // zero-based within the offending page
  pageIndex?: number,   // zero-based, only where an actual page walk knows it
}
```

Existing safe provider identity may remain in context where already available; do not add symbol,
ID, dataset value or provider error text. Indices must be finite nonnegative safe integers. Paths
use schema tokens and `[]`, with indices separate: `data[].bar.close`, `metadata.datasetId`,
`data[].bar.adjusted`, `data[].quote.ask`, `data[].theoreticalPrice`, `data[].sourceContractId`,
`data.order`. Unknown-key failures name only the known containing schema path, never the key.
Only a finite set of SDK schema tokens from explicit field loops can form a path. No copying of
arbitrary QuantError.context, string parsing of upstream messages, raw values, URLs, cursors,
payloads, causes or header/body dumps. A provider-thrown error cannot supply these diagnostic
facts merely by imitating their keys. Unclassified validation exceptions get controlled
phase/path plus `invalid_structure`, not invented precise field blame.

Examples (stable meaning; public door names match the actual method):

- `defineDataProvider.query: invalid research data at data[].bar.close (not_finite).`
  Context phase=page, path=data[].bar.close, reason=not_finite,
  validationCode=input.not_finite, rowIndex=0. A window can additionally attach pageIndex=1.
- `createDataView: invalid research data at metadata.datasetId (missing_field).`
  Context phase=page, path=metadata.datasetId, reason=missing_field,
  validationCode=input.missing_field. No rowIndex for a page field.
- Adjustment contradiction: path=data[].bar.adjusted, reason=inconsistent,
  validationCode=data.invalid_response and the offending row index.

Use existing narrow validation phases. Local row-validation catches annotate the row they are
validating; window/kit loops annotate page index when known. Pass detail explicitly through local
functions/errors; no mutable global validation context. Generate controlled diagnostics at the
validation site or a closed mapping of known SDK validator paths/codes; never trust arbitrary
provider-thrown fields. Replace lossy catches in data-call/createDataView/window restore and kit
with the same narrow conversion. Do not wrap the async acquisition loop in a new teaching catch.
Preserve auth/rate/allowance/version/abort classes, codes and existing safe error laws.

Kit failures remain `data.nonconformant` with their existing provider/probe/law context, plus a
nested `validation` object containing exactly the schema above when an SDK validation failure is
available. Expected-page equality mismatches keep their independent expected-facts law; never
include expected/actual raw values. Input expectation errors remain caller input failures.
A deliberately broken starter mapping of `cents` directly to `close: NaN` must identify close;
fixing that one mapping to `close: row.closeCents / 100` must pass without inspecting SDK internals.

## 5. Narrow premium policy

Normalized bid/ask/mid/last/mark and non-null theoreticalPrice must be finite and >=0.
Zero remains valid; absent optional quotes and null theoreticalPrice remain unknown. Negative
premium refuses the whole page with data.invalid_response, safe field path and reason=out_of_range;
no repair, dropped row or clean acceptance with a warning. Preserve crossed-market research
warnings for otherwise valid nonnegative prices. This rule does not apply to Greeks, underlyingPrice,
general OHLC prices or source timestamps. No live-liquidity guarantee or broader quote redesign.
Existing core compute quote types are not changed. C0 required finiteness but never affirmatively
promised negative option premiums; this intentionally tightens the unreleased normalized research
boundary, with no identified controlling conflict.

## 6. No-key first success and independent author package

Add `examples/community-connectors/starter/` as teaching files **outside pnpm workspaces**, not a
new SDK package. It is private 0.0.0, independently built/packed/installed, uses public imports,
and has its own lockfile. It is a tiny synthetic daily-only source, no network or credentials.
Vendor JSON uses `{ticker, session, openCents, highCents, lowCents, closeCents, shares}` with
explicit USD cents → USD/share scaling (100,102,104 closes; volume10). All source dates, basis,
unknown observation/availability clocks and synthetic receipt facts are declared, not inferred.
Its warnings disclose observed-only/gapped research data. It maps different JSON rather than
accepting already normalized pages. Two pages (2+1 rows) and an independently written expected-page
test exercise the public shared kit; no imported private fixture builder or aliases.

The human guide will give these exact repository-relative steps, executed verbatim in acceptance:

```sh
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm build
mkdir -p .local-connector-artifacts
(cd distribution/totalfinance && pnpm pack --pack-destination ../../.local-connector-artifacts)
node examples/community-connectors/starter/prepare-sdk.mjs .local-connector-artifacts/insiderfinance-totalfinance-0.1.3.tgz
(cd examples/community-connectors/starter && pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm pack --pack-destination ../../../.local-connector-artifacts)
node examples/community-connectors/starter/run-consumer.mjs .local-connector-artifacts
```

The starter uses a local SDK dev tarball and an ordinary SDK peer, not workspace linking.
`prepare-sdk.mjs` copies the supplied artifact to ignored sdk.tgz and runs the pinned pnpm with
`install --lockfile-only` to prepare the lock for that actual artifact before frozen install.
Keep dependency versions pinned in the template; validate that only the local SDK integrity and
its actual version change. Ship no SDK binary or machine-specific path. The clean consumer runner
creates a temporary project from the two actual packed paths, creates its lock and repeats frozen
install. No registry SDK fallback. Record hashes for both artifacts and prepared locks.

The clean temporary consumer imports the starter package by its packed name and SDK root, with
no source-path import. It prints SMA(2)=103 and VWAP=102, retains source pages/warnings alongside
those displayed results, and restores canonical windows. For SMA(20), check
`last === undefined || !Number.isFinite(last)` and print an insufficient-history message; no
non-null assertion, zero filling or extra fetch. The runner also executes an intentional broken
close mapping, asserts the exact safe diagnostic, fixes the single field and repeats success.
A compact guide shows swapping only the provider binding to the independent InsiderFinance
factory after separately configured access/allowance. Its approved root/key/window/SMA example
stays unchanged and is tested separately with synthetic HTTP (one/three pages,119.5).

Link the compact journey from README, docs index, connector guide, and generator-owned
`tools/llms-docs.ts` journey/entry sources. Do not hand-edit llms outputs or require reading the
full catalog. State current daily/minute bars and incomplete option research scope; future
fundamentals/flow/other intervals need a reviewed capability, not a universal extension DSL.

## Ordered implementation and acceptance after technical review

- [x] Integrate exact fetched main in this tree: retain 0.1.3/upstream source/release proof, resolve
      authored conflicts; defer derived conflict resolution to affected generators, refresh actual
      live counts. Preserve original review/evidence; replay it with new expected dispositions in a
      separate runner/output, never overwrite its probe-results.json.
- [x] Add failing-then-passing adjustment tests both directions and true/false/unknown controls at
      raw wrapper/view/query/window/restore/kit and freshly installed public doors.
- [x] Add distinct same-term option identities within/across pages and kit; reversed tie/duplicate
      IDs still refuse. Reference adapter cursor/filter/pin tests stay intact.
- [x] Implement controlled response diagnostics and negative premiums (each field, zero/null,
      nonfinite, negative Greek/underlying controls); one-defect mutants and redaction controls
      reject malicious key/value/URL/cursor/text/context leakage. Kit retains useful safe detail.
- [x] Change only raw author signature; migrate fixtures/kit/provider and compile natural daily-only
      author under strict NodeNext/Bundler, consumer inference/readonly and wrong-kind refusal.
- [ ] Build the independent starter and execute the written recipe verbatim from a clean checkout;
      shared independent expected pages, SMA103/VWAP102, intentional-error repair, insufficient history,
      warnings/storage and provider-binding interchangeability. Copy only public synthetic review material.
- [ ] Separate provider worktree based exactly8e21edb if needed; no remote. Build/typecheck/frozen
      install/test/pack against actual new SDK. Preserve all83 existing provider tests and corpus.
- [x] Measure unchanged whole/installed/guard/browser caps on main alone, integrated pre-repair
      source and final candidate to separate upstream growth from C4. Retain the C3 703KiB root cap
      and stricter narrow checks; no additive cap arithmetic or shared optimization. Return concrete
      overage/graphs for technical review before any cap edit.
- [ ] After final source, affected ordered generation, zero defects, actual fixture/tracker counts,
      types/API/scoped lint+format and fresh installed SDK/provider/starter proofs. No extra local full
      CI/coverage/regen:check required. Then fast-forward existing draft PR26 (no force), rewrite its
      description and require fresh exact-head fast AND full hosted CI. Earlier e5 green is historical.

Feature remains in_progress. No merge/publication/version bump/deployment/provider remote/API-server
changes, staging/secrets/allowance/key/grant/account/paper operations, recurring automation or live
execution. No unresolved product choice; coordinator review of this concrete contract is next.

## Approval precision (2026-11-11)

Coordinator a55531a4 approved d6cc42b with these controlling corrections before runtime work.
The starter lives at examples/community-connectors/starter (outside examples/\*), with its OWN
pnpm-workspace.yaml packages:["."] and lockfile. Assert absence from root recursive listing and
actual tarball resolution, never root linking or registry fallback. Root globs remain unchanged.
Canonical scan runs before field validation: preserve all finite/no-accessor/work bounds while
mapping its controlled known close/metadata paths to useful diagnostics. Never echo arbitrary
scanner paths/values. No second unbounded walk. Explicit NaN/omission mapping errors are repairable
from diagnostics; finite wrong cents scaling is caught by independent expected pages, not inferred
by validation. Approval is not a merge, publication or connected acceptance.

Toolchain execution note: this host's pinned Node distribution has no corepack binary. Use installed pnpm10.32.0 directly (prepare-sdk verifies it), as CONTRIBUTING allows; no implicit toolchain mutation. The guide documents Node22.23.2/pnpm10.32.0 prerequisites.

## Concrete source checkpoint after eceb81e0

C4 scoped source, independent starter and provider migration are now implemented under unchanged
red size gates. Final scoped source tests188/188, types/lint, natural author NodeNext/Bundler,
independent starter103/102/error repair/unit oracle and final clean provider83/83 plus exact119.5
primary proofs pass. See [the final measured proposal](../reviews/community-connectors-c4-final-budget-2026-11-11.md).
No threshold has changed. Merge remains uncommitted with derived conflicts pending budget approval
and source-final ordered generation; original review and prior integration-only failure remain history.
This is not offline acceptance or a claim that generated inventories/current-head hosted CI pass.

## Known-guard correction after c07bdbc9 (2026-11-11)

The coordinator approved ONLY eight measured caps, conditional on complete known schema diagnostics.
Those exact caps are applied. Known page/row/capability SDK guards now retain controlled paths/codes
and indices, with capabilities naming its actual public door. Scanner-first explicit undefined and
nonfinite known fields stay precise; unknown/unsafe paths stay generic. Missing required objects
report missing_field without changing original request InputErrors. Caller expected-page preflight
remains an InputError with zero provider calls; actual responses remain DataErrors.

Latest215 focused source cases and83 fresh installed provider cases pass, exact root primary remains
119.5 on one/three pages. This required correction exceeds all eight approved caps with unchanged
module sets; [actual changed bytes and cause](../reviews/community-connectors-c4-known-guard-budget-2026-11-11.md)
are the required next technical checkpoint. No additional allowance is proposed. Main integration,
final ordered generation/derived conflict resolution, joined counters/API/public/hosted closure
remain open. Prior188-case and cap-proposal receipts above are historical, not current acceptance.

## Corrected-source technical approval ae690e3f (2026-11-11)

The coordinator independently passed205 data cases and16 installed schema/input controls, repeated
all final bytes/graphs and exact119.5 one/three-page root example. Known-schema correction is approved
for closure, not final generated/hosted acceptance. Only the eight revised limits apply: root723200B,
/data15872B, named15360/13312B, root15872/13312B, restore14080B each. Actual root722908B and
/data15663B include the finite SDK schema/guard diagnostic cost; all retained module sets are unchanged.
No other ceiling/settings/exclusion changes. Proceed with final ordered generation, true combined
counters and fresh installed/hosted evidence; no merge or release authority.

Final source generation: signature/naming/contract/enforcement/validation/API/README/LLM/public-reference/
bundle/OpenAPI/docs ran from combined source. Nine derived conflicts are generator-resolved; no unmerged
entries remain. Enforcement defective0, paths7971, inputs1618, results1973, validators386;
naming43849/unresolved0; docs260 surfaces/4668 executable fences/findings0. The new no-key journey is
rendered in full LLM output from its guide source. Public tracker figures were refreshed and gated.
Local full267 whole/packed gates pass. Final artifact/guide/hosted closure remains pending at this
source checkpoint; source and earlier corrected-byte receipts are not final hosted acceptance.
