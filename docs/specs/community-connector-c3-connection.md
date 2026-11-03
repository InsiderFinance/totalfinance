# Community connector C3: connect, fetch a window, calculate

Status: **proposed, spec only; coordinator technical review required before runtime work**.
Date: 2026-11-02. Feature: `01a19da0-2a6f-7450-89a4-2e51047b05b5`.
Request: `3974edf7-0690-81d9-ba59-8f39791dc6da`.
Base: SDK `71da9d1fb674932f5fc21a780039aeccd9186d6b`; provider C2
`075d5951d096828fd8eef01e40d8361359281eca`. This document proposes no release/version change.

## Outcome: the approved complete example

**Future target, not a runnable C2 API.** Preserve this primary example verbatim in meaning and calls:

```ts
import { data, technicalAnalysis } from '@insiderfinance/totalfinance';
import { createInsiderFinanceProvider } from '@insiderfinance/totalfinance-connector-insiderfinance';
const apiKey = process.env.INSIDERFINANCE_API_KEY;
if (!apiKey) throw new Error('Set INSIDERFINANCE_API_KEY');
const marketData = data.connect(createInsiderFinanceProvider(apiKey));
const prices = await marketData.priceBars({
  symbol: 'SPY',
  interval: '1d',
  from: '2026-09-01',
  to: '2026-10-28',
});
const averages = technicalAnalysis.sma(prices.closePrices, { period: 20 });
console.log(averages.at(-1));
```

The maintainer replied “Yes love that” to this experience. That approves the relationship and
onboarding, not the pagination/default/error/storage details proposed below. TotalFinance binds the
explicitly supplied provider, acquires normalized data, and supplies named native arrays to existing
calculations. The external package owns authentication, HTTP and source mapping. Neither installing
nor importing anything registers a provider. No third import, projection call, manual envelope,
mandatory kind/limit, injected clock/fetch/origin, MCP server or pack configuration is needed.

The source view remains available after calculation. Pure SMA accepts ordinary caller-owned arrays
and keeps its existing outputs, assumptions and diagnostics; acquisition warnings do not magically
attach to its numeric result. Selecting closePrices explicitly chooses closes. No financial symbol,
interval, dates, lookback period, adjustment conversion or missing number is inferred.

## Scope and controlling history

[C0/C1](./community-connector-foundation.md) controls research units, source/availability clocks,
quality, error redaction and independent packages. [C2](./community-connector-c2-integration.md)
provides immutable page views and strict field selection. Its final source/installed/hosted
[receipts](../reviews/community-connectors-c2-2026-11-02.md) are historical C2 acceptance, not C3 proof.
The Ri task records the later green C2 head; older pending checkboxes in those historical records
are not a claim of current failure. Preserve the rejected C2 design and recovery history.

C3 narrowly supersedes the earlier no-root-data and no-auto-paging requirements: root data becomes
a provider-neutral consumer namespace, and priceBars promises bounded terminal pagination. Raw query
remains one page. CONTRIBUTING's prohibition on provider/network implementations inside the library
still excludes HTTP, credentials and vendor code: this explicit SDK orchestration invokes a supplied
provider, as the existing wrapper already does. Ordinary calculations never acquire data.

No all-purpose finance client, provider-bound indicator, registry, plugin installer, cache, retry,
background prefetch, streaming, calendar filling, execution permission, API-server rewrite or MCP/
async-worker runtime is included. Later agent/MCP work composes this SDK path after separate review.

## Decision 1 — one connector boundary, retain the C2 validated consumer

`connect(provider: DataProvider, options?: DataConnectionOptions): ConnectedData` accepts exactly
the existing C2 validated consumer protocol: query returns DataViewFor<R>, whose .page is raw data.
It does **not** accept DataProviderSource, DataPage, provider factories or a raw-page/view union.
The external factory continues returning DataProvider by calling defineDataProvider(source).
Raw provider authors continue implementing DataProviderSource and binding it with that constructor.
Fixture providers follow the same route. There is no central inclusion approval.

This choice preserves the factory signature, current independent provider runtime, source protocol,
fixture and validateDataProvider kit. Choosing raw sources instead would change every factory and
the conformance target without improving the approved user example. A structurally similar object
returning raw pages is refused as data.invalid_response when queried, never shape-guessed or adapted.
Construction checks identity/version/method shape and captures bound methods without calling them;
there is no runtime brand/allowlist and no claim that construction proves behavioral conformance.

ConnectedData retains id/version/contractVersion, capabilities(options?) and generic
query(request, options?) from DataProvider, plus priceBars. Advanced query keeps exactly C2's
explicit kind/resource/limit/cursor grammar and one-page view result, with zero discovery or auto-
paging. Chains remain available only through this research query; no chain-window or pricing API.
Provider authors do not implement priceBars, projections, calculations or a second protocol.

Every connected read revalidates its consumed output. Inspect property descriptors before reading
.page; a behavioral source property is invalid and is never invoked as validation. Extract reusable pure C2 view-envelope checks
from the kit into an internal module: frozen plain view, exact descriptors/kind/page, validated
frozen raw page, and no serialization/getter surprises. Share request/page validation and sequence
checks with existing core components. Keep kit expected-facts comparison independent; never wrap or
rebuild a bad provider view to certify it. Do not import the whole conformance runner into runtime.

Array correspondence is checked at selection time: consume the provider view's actual closePrices
or ohlcvBars and compare every value/order/native-array/freeze property against its retained raw rows
before concatenation. A lying selector refuses; it is not replaced with a reconstructed array.
Fetching a window does not force OHLCV selection. The kit still eagerly tests both selectors as a
verification operation, including the expected missing-volume refusal. Common pure selection checks
are shared, while independent golden arrays/mutants remain the oracle. Unexpected provider errors
are sanitized through the existing typed boundary; no copied validation/error system in the facade.

## Decision 2 — exact placement and public names

| Surface             | Proposed owner and exports                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow/runtime    | New `packages/core/src/data-connection.ts`, internal sequence/selection helpers beside existing data validation/view code; no TA/provider/Node imports  |
| Types               | `packages/core/src/data-types.ts`: types below, re-exported by existing core/data                                                                       |
| Advanced source/API | Existing `@insiderfinance/totalfinance/core/data`: C2 names plus connect and createPriceBarsWindowView; core main stays unchanged                       |
| Consumer entry      | New `packages/totalfinance/src/data.ts`: curated connect/createPriceBarsWindowView and their nameable types, re-exporting the same core implementations |
| Root namespace      | `packages/totalfinance/src/index.ts`: `export * as data from './data.js'`; type-only exports for the new public parameters/results                      |
| Public subpath      | `@insiderfinance/totalfinance/data` maps to `modules/totalfinance/dist/data` in the existing distribution                                               |
| Kit                 | Existing opt-in `/core/data-conformance`, unchanged input protocol; new workflow/mutant cases exercise ConnectedData too                                |

The assembler currently intentionally skips every non-root umbrella subpath. Add a narrowly curated
`./data` exception in tools/assemble-distribution.ts and publicSourcePaths in tools/public-packages.ts,
with export-map/nameability/source-rewrite tests. Do not accidentally expose all private umbrella
aliases or add another distribution/workspace. Register the private umbrella ./data export and
typesVersions entry consistently. Its facade is the root namespace's exact module, not a parallel
implementation. Existing /core/data remains the provider-author/advanced door, not a retired alias;
it has the wider protocol surface. No flat root connect export or root conformance runner.

Exact new type names: PriceBarsWindowRequest, DataConnectionOptions, PriceBarsWindowOptions,
ConnectedData, PriceBarsWindow and PriceBarsWindowView. Export those and the existing DataProvider,
DataCallOptions, DataCapabilities, DataRequest, DataViewFor, DataPage, PriceBarRecord and OhlcvInput
as type-only names from /data and root, so every public method's inputs/results are nameable. The
runtime /data surface has exactly connect and createPriceBarsWindowView. Internal shared modules
are data-view-validation.ts and data-sequence-validation.ts; neither gets a public export map.
Core/data also exports the two new runtime functions, with no circular facade/core dependency.

Root now reaches provider-neutral acquisition code, intentionally revising C2's stronger promise
that even view modules stay off root. It still reaches no provider package, credentials, native
fetch/clock default implementation, Node networking, environment access or remote installation.
Named ordinary compute entrypoints keep their existing dependency graphs and ceilings. Root import
and connect construction perform no reads; only explicit acquisition calls invoke the bound provider.

## Decision 3 — requests, operational budgets and metered calls

Proposed declarations, with existing types imported rather than redefined:

```ts
interface PriceBarsWindowRequest {
  readonly symbol: string;
  readonly interval: '1d' | '1m';
  readonly from: string;
  readonly to: string;
}
interface DataConnectionOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxRecords?: number;
}
interface PriceBarsWindowOptions extends DataConnectionOptions {
  readonly signal?: AbortSignal;
}
interface ConnectedData extends DataProvider {
  priceBars(
    request: PriceBarsWindowRequest,
    options?: PriceBarsWindowOptions,
  ): Promise<PriceBarsWindowView>;
}
declare function connect(provider: DataProvider, options?: DataConnectionOptions): ConnectedData;
declare function createPriceBarsWindowView(window: unknown): PriceBarsWindowView;
```

Request/options objects are closed, readonly inputs are copied without mutation, undefined alone
means omission. No `kind`, `limit`, cursor or filters in the high-level priceBars request. Reuse
PriceBarsRequest validation by constructing its explicit kind and operational limit. Daily dates
are inclusive session labels; minute bounds are inclusive zoned bar-start instants, still at most
31 days. Preserve symbol rules and unsupported interval refusals. No new financial date grammar.

Connection defaults: pageSize 1,000, maxPages 20, maxRecords 20,000. These are operational work limits,
not financial assumptions or upstream allowance. Each is a positive safe integer. Hard bounds are
pageSize <= 2,000, maxPages <= 100, maxRecords <= 100,000, matching existing protocol/kit limits.
Explicit connection options may raise defaults only within hard bounds. Call overrides may only
lower/equal the connection's resolved ceilings; attempts to raise them refuse before discovery.
No need to supply all three; their independent limits both apply, even if their product differs.

Each priceBars call performs exactly one capabilities call, then at most maxPages sequential query
calls. Discovery is fresh per call, not a cache or connection-time request; it may itself be a
provider-metered read. Thus at most maxPages + 1 provider invocations. For InsiderFinance, discovery
is local and each query is at most one HTTP request. Other providers must disclose their own upstream
costs: this is a provider-call budget, never a billing/request-allowance guarantee. No other calls,
retries, speculative reads, parallel page fetches or metadata probes. Hosts enforce real account/
tenant budgets in their bound provider; these SDK counters cannot authorize or replenish them.

Validate discovery and require price-bars/interval support; access denied refuses entitlement before
query, unknown access permits the explicit attempted read. Consistency/maxPageSize claims must match
actual pages. If pageSize was omitted at both levels, use min(1,000, declared maxPageSize). An explicit
pageSize above the declared max refuses; never silently shrink an override. Before each data call,
send limit=min(effective pageSize, remaining maxRecords). Limits can shrink on continuation; do not
rewrite opaque cursors. If remaining records/pages is zero and the last cursor is non-null, refuse
without another call. A terminal page exactly at either ceiling succeeds. Count every attempted
query, including empty/error/aborted ones; counters are local to that operation and not reused.

## Decision 4 — terminal walk and data honesty

First query contains kind price-bars, original symbol/interval/from/to and explicit computed limit.
Continuation contains only repeated kind/symbol, exact nextCursor and computed limit. Never decode,
rewrite, log or merge provider cursors. Reject repeated cursors/cycles and nonadvancing keys. Preserve
InsiderFinance's existing original-bound/nextFrom/pinned-to validation; do not move it into API server
work. SDK validates **every** raw page against the original financial bounds/interval as well as
its actual continuation envelope, so an adapter's later-page filter escape cannot pass the workflow.

All pages must retain provider identity, symbol/kind, provenance dataset/sourceVersion, datasetId/
datasetVersion, snapshotId (including null), sessionDate (including null), consistency and adjustment.
Require consistent known/unknown bar.adjusted flags across rows/pages; reject a switch rather than
concatenate incompatible bases. Reuse row-key/identity rules: strictly ascending timestamp keys
within/across pages, unique timestamps, no sorting/deduplication/repair. Empty terminal pages are
valid, including after earlier rows; an empty nonterminal page is already invalid in C1. No required
row count or expected calendar is inferred. On restoration enforce the same sequence laws.

Receipts, source generation, row observation/availability/storage clocks, quality, freshness,
warnings and coverage bounds may vary legitimately across pages and are preserved separately.
Do not demand identical receipt clocks or silently pick first/last metadata as a whole-window fact.
Snapshot consistency requires a real stable pin; best-effort bars remain best-effort even with
stable dataset IDs. Null pins/times never become a synthesized snapshot/asOf. EOD and all v1
executionEligibility labels stay research-only. Complete row quality and terminal pagination prove
neither continuous coverage, freshness, point-in-time safety, live fills nor a complete lookback.

Return only after nextCursor is null. Never return a successful truncated window, partial-success
union or a resumable error result. On failure prior reads may already be charged; callers explicitly
choosing manual paging use query instead. No automatic fallback to a smaller window/latest snapshot.

## Decision 5 — result, canonical storage and field selection

```ts
interface PriceBarsWindow {
  readonly version: 1;
  readonly kind: 'price-bars-window';
  readonly request: PriceBarsWindowRequest;
  readonly pages: readonly DataPage<PriceBarRecord>[];
  readonly pagination: {
    readonly status: 'terminal';
    readonly pageSize: number;
    readonly pageCalls: number;
    readonly records: number;
  };
}
interface PriceBarsWindowView {
  readonly kind: 'price-bars-window';
  readonly window: PriceBarsWindow;
  readonly closePrices: readonly number[];
  readonly ohlcvBars: readonly OhlcvInput[];
}
```

There is at least one retained page on success, even for an empty window. pageCalls equals pages.length;
records is exactly their total rows; pageSize is the effective selected size before remaining-record
clamping. Do not persist signal, provider methods/key or inferred financial metadata. The version
above describes the new window storage shape, not a change to source DATA_CONTRACT_VERSION 1.
Each original frozen page is retained without changing any field, cursor, warning or time. The
window itself is frozen canonical plain data; it has no fabricated aggregate DataPage or .page alias.
Per-page assumptions/diagnostics remain at window.pages[i]; no synthetic combined convention/date/
coverage value. No new artifact handle kind or result-envelope exception: this is an acquisition
container, and calculations keep their existing result laws. Source identity survives in every page.

The parent view uses C2 descriptor laws: enumerable frozen kind/window, nonenumerable cached array
getters, no custom toJSON. JSON.stringify(view) enumerates only kind/window and never invokes OHLCV.
Canonical hashing/storage uses prices.window. createPriceBarsWindowView(parsedWindow) validates
version, closed storage shape, original request, pages, terminal last cursor, nonterminal earlier
cursors, uniqueness, page-call/row totals, hard limits and cross-page invariants before restoring.
It cannot authenticate historical provider behavior or prove that a stored cursor wasn't forged;
it proves the represented facts, not external coverage. Reuse createDataView/page checks internally,
without fetching or consulting a clock. Persisted window restoration needs no provider binding.

Closes and OHLCV concatenate source selections in retained page/row order; they are frozen, dense
plain native arrays with no decorations/subclasses/proxies. Each getter is finite local work bounded
by actual collected records, caches on success, and validates full array-to-raw correspondence.
No getter fetches or reads time. Missing first/later volume refuses only OHLCV using InputMissingField
with safe field, pageIndex, rowIndex and global index. No zero filling; actual zero survives.
Known closes remain usable with partial/unknown/unavailable quality, gaps and unknown times; all
limitations remain in retained pages. Malformed required OHLC/nonfinite rows refuse acquisition.
Empty arrays and insufficient SMA history retain existing engine behavior; no invented warmup rows.
Chains retain C2 incomplete terms and have no automatic pricing/fill conversion.

## Decision 6 — errors and cancellation

Existing input.\* codes handle malformed closed controls, over-ceiling overrides and invalid bounds.
Unsupported kind/interval uses existing UnsupportedError/DataUnsupportedCapability; incompatible
protocol/window version uses ConfigurationError/DataContractVersionUnsupported. Preserve typed
auth/entitlement/rate/allowance/snapshot/not-found/service errors; never retry them automatically.
Invalid page/view, changed pin/basis/resource, duplicate/order/bounds/cursor cycle or lying selector
uses DataError/DataInvalidResponse. Unexpected exceptions are sanitized, without arbitrary causes.

Add exactly one workflow refusal: `ErrorCode.DataWindowBudgetExceeded = 'data.window_budget_exceeded'`,
DataError, retryable false, safe context provider/kind plus limit ('maxPages' or 'maxRecords'),
pageCalls/records/maxPages/maxRecords. If both limits bind, maxPages wins deterministically. Never
attach partial pages, request URL, cursor, credential, HTTP bodies or arbitrary provider text. A
host can choose another bounded explicit call, but this refusal grants no upstream allowance.
No broad data.incomplete_page code or quality bypass policy returns.

Validate controls first, then check pre-abort before any provider method; check abort again before
each discovery/query and after each awaited boundary, including provider body parsing. Abort always
uses DataAborted with safe context. Pass the exact caller signal to provider calls. Race active
provider promises against that signal so an ignoring provider cannot deliver a late successful
window; observe late settlement to avoid unhandled rejections and remove listeners in finally.
No next-page call after abort/failure. Cancellation cannot uncharge an already started request.
Connection owns no implicit wall-clock deadline: hosts can pass a deadline-bound AbortSignal (including
AbortSignal.timeout). That deadline is reported as DataAborted, not source staleness. With no signal,
bounded call counts do not promise bounded elapsed time. No clock in view/sequence computation.

## Decision 7 — measurement before bundle policy

The current whole-root ceiling is **696.25 KiB = 712,960 bytes gzip**. Source index currently exposes
domain namespaces; data.ts -> data-validation/data-view -> core errors/provenance/helpers is a new
root-reachable branch. Core main does not import it today. A documentation-pass baseline measurement
of unchanged 71da9d1 is 712,661 bytes gzip (299 bytes headroom); this is not a C3 estimate. The root already reaches many shared
helpers, so summing the separate data bundle would overstate marginal bytes. The new facade must
not import data-conformance/canonical test machinery wholesale. No guessed byte allowance is approved.

Before any proposed gate edit, on pinned Node/pnpm/esbuild measure unchanged 71da9d1 and final C3
source using tools/bundle-size/measure.ts plus workspaceAlias. Record min/gzip bytes, exact commits,
delta, module graph and repeated identical measurement. Measure fresh installed root namespace and
named /data consumers under existing bundlers; retain all whole narrow-domain, installed-function,
guard-only and browser structural ceilings. Root-namespace esbuild retention tradeoffs remain
documented; no credential/provider/network module may enter even the whole SDK root.

If the unchanged whole-root ceiling fails solely because the approved namespace makes legitimate
new code reachable, stop for a concrete technical budget review: propose **only** that root ceiling,
with measured bytes/delta and minimal explicit headroom. Add measured new /data used-function/whole
ceilings at that review. No blanket budget increase, threshold guess, helper/registry optimization,
warning removal or weaker structural gate to make it pass. This spec-only branch edits no budgets.

## Ordered implementation slices after review

1. Connection/types and common validation reuse; unchanged one-page C2/kit tests plus closed-input,
   bound-method/zero-construction-read and wrong raw-source response tests. Curate public manifests/
   first-touch fixtures for new functions and returned methods. No generic callback framework.
2. Bounded window acquisition, canonical storage/restore and lazy selectors, with independent
   source/page/selector/cursor/pin/bounds/budget/cancellation mutants. Keep engines untouched.
3. Curated /data/root assembly, exact installed example and fixture/provider interchangeability.
   Independent provider runtime need not change; fresh external installed compatibility, README/
   tests and lock/receipt evidence belong in a separate provider worktree if implementation proceeds.
4. Measure bundle gate and resolve any measured-only budget proposal before acceptance. Once source
   is final, affected signature -> naming -> contract -> enforcement -> validation -> API -> README
   -> llms -> bundle -> OpenAPI -> docs generation; zero measured defects, unchanged unmeasured/gate
   policies, fresh packs/types/public reference checks. No manual generated evidence changes.
5. Return reviewable source/receipt commits and exact-head fast/full hosted checks for PR26's combined
   changes (existing enforcement work still requires full). Further branch/PR updates need the
   implementation review's scope; this spec-only request does not change PR26. No merge authority.

## Synthetic acceptance and review exit gate

- [ ] Technical review of this exact spec and concrete defaults/result/boundary decisions before code.
- [ ] Fresh installed SDK/provider packs execute the **exact primary root-import/key/connect/window/
      period-20 SMA file above**, using independent synthetic 30-close one-page and multipage HTTP
      facts within the explicit dates, with a hand-calculated last SMA. Inject fake native fetch
      outside that file; test-only synthetic environment key, no real secret/environment inspection.
- [ ] A separate period-2 three-row [100,101,102] case proves 101.5; same existing SMA.explain and VWAP
      results as independent ordinary arrays. Second fixture provider changes only factory/binding,
      not the data/calculation path. No projection import, mapping glue or server prerequisite.
- [ ] All existing shared conformance, original continuation bounds/nextFrom/filter/pin and provider
      error/cancellation cases pass. New one-defect raw/view/selected-array mutants fail specifically;
      kit sees actual outputs and never reconstructs a lie. Independent expected full pages survive.
- [ ] One/multiple/empty/short terminal windows succeed; nonterminal at page/record ceiling refuses
      with exact call counts and no extra call. Terminal exactly at ceilings succeeds. Capability
      discovery cost, explicit override refusal/clamping rules, smaller remaining-record limit,
      cursor cycle/nonadvance, later out-of-bound row, changed adjustment/dataset/pin and order/
      duplicate identities each have independently targeted failing-then-passing regressions.
- [ ] Pre/in-flight/body/between-page abort and deadline-signal rejection, late-result suppression,
      listener cleanup, redacted serialization and typed access/allowance/service errors. No retry,
      implicit fetch from getters, silent partial success or incomplete-window result exposed.
- [ ] Every page's provenance/diagnostics/null clocks/coverage/quality/adjustment remains exact after
      collection and canonical persist/restore. Missing first/later volume blocks OHLCV only; zero/
      gaps/partial quality/empty inputs preserve field-specific C2 laws. JSON enumeration calls no
      getters; immutable native arrays and restore/source correspondence pass independent mutants.
- [ ] Public TypeScript nameability, generics/narrowing/readonly inputs, JS first-touch misuse,
      curated exports/assembler/API/generated/packed consumers and all unaffected bundle ceilings
      pass. Any measured whole-root change has a separate concrete technical review receipt.
- [ ] Exact final source/artifact hashes, local receipts and new fast/full hosted results recorded;
      C2 green is not C3 certification or maintainer acceptance of unshown details.

No unresolved product choice is needed to review this proposal: it recommends one boundary, result
shape and set of operational defaults. Those details require coordinator technical review. A final
whole-root byte limit remains deliberately measurement-dependent, not an invented product decision.
The feature remains in progress and maintainer 10/10 acceptance remains distinct from technical
proof. Live staging/new allowance, agent glue, paper journey and App remain later separate work.
No staging/secrets/allowance/key/grant/account/paper operations, API-server edits, remote provider
repository, merge, release/version/publication/deployment, recurring automation or live execution.
