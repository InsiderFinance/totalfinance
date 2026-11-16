# Community connector C2: consumer data view

Status: **C2 SDK-first technical spec approved at e1e5a910ef1ca50778c80dd68c8931952f4a6575; bounded offline implementation locally verified; final hosted checks pending.**
Approval: `754a6ffa-2218-8bba-9767-5c98b322390c`; the wrapper takes the direct source argument as corrected below.
Date: 2026-11-02. Feature: `01a19da0-2a6f-7450-89a4-2e51047b05b5`.
Current review: `d5f95724-5d5d-8c4e-9e08-b2b658fa658a`.
Earlier request/steering: `50853bf4-78d3-8bac-bcc9-9d358fb94ff6`,
`f34544c7-0432-8fbe-9464-9df4e5da2e12`, `941bb23d-461d-87e7-88b3-2cd29fbc2c4a`.
Execution remains `01a19da1-1351-7b84-b67f-58bc81698fb5`.

## Primary consumer example: configure, fetch, calculate

**Implemented C2 preview; unreleased:**

```ts
import { createInsiderFinanceProvider } from '@insiderfinance/totalfinance-connector-insiderfinance';
import { sma } from '@insiderfinance/totalfinance/technical-analysis';

const provider = createInsiderFinanceProvider(apiKey);
const prices = await provider.query({
  kind: 'price-bars',
  symbol: 'SPY',
  interval: '1d',
  from: '2026-10-26',
  to: '2026-10-28',
  limit: 100,
});
const average = sma(prices.closePrices, { period: 2 });
```

This is the recommended handoff: explicitly choose closing prices, then pass the normal numeric
array to existing SMA. There is no third import, standalone projection, values/source unwrapping,
manual report assembly, MCP prerequisite or provider-specific mapping. Named symbol/interval/date/
limit fields and period remain meaningful financial choices. No such inputs are inferred/defaulted.
The synthetic three-close sample 100, 101, 102 produces last SMA 101.5 with period 2.

The common SDK automatically constructs the small consumer view after validating the provider's
raw response. `prices.page` is the unchanged validated research DataPage, including original data,
metadata, source identity, provenance, page/row diagnostics and temporal/coverage limits. Selecting
`prices.closePrices` does not erase or overwrite that page. To inspect source limits, read
`prices.page.metadata` and `prices.page.diagnostics`; use existing sma.explain instead of sma when
engine assumptions/diagnostics are needed. No extra setup is required for either.

SMA stays a pure existing calculation and returns its ordinary result. This design does **not**
claim provenance magically follows a number or that SMA copies source warnings into its result.
The retained view is the source context for the calculation. Applications keep it when presenting
or persisting research; serializing only average cannot preserve its acquisition provenance.

## Review outcome and scope

The coordinator read all 328 lines of draft 4fc5f9d and the evidence. Exact disposition:
**"changes requested; no C2 implementation approval."** Direct credential/direct query/optional
discovery/invisible infrastructure defaults are sound in principle. That draft's third import,
projection call, values/source unwrapping and manual assembly did not demonstrate the maintainer's
low-ceremony expectation. Its blanket partial-quality refusal and broad data.incomplete_page policy
also confused field suitability and history claims. This revision replaces those decisions.

10/10 consumer lovability is an acceptance condition; technically green C1 is not consumer
acceptance. The reviewed revision is approved for bounded offline SDK implementation.
The approval corrects defineDataProvider({ provider: source }) to defineDataProvider(source), since
the source is already a single structurally unmistakable object. No extra approval loop applies.
Async/MCP implementation remains outside this approval. The [C0/C1 spec](./community-connector-foundation.md) still controls
normalized financial units, unknown times/terms, paging/error/cancellation laws and independent
community package ownership. No calculation grammar, financial default, provider-bound indicator
methods, all-purpose finance client or provider dependency in ordinary compute is introduced.

## Decision 1 — choose an SDK-owned view over standalone projections

| Candidate                   | Consumer handoff                                                        | Consequence                                                                      | Disposition |
| --------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| Previous standalone helper  | Import closePrices, project page, unwrap values, assemble source report | Small implementation but makes repeated plumbing the primary experience          | Replaced    |
| SDK consumer view           | Query once; select prices.closePrices; call existing SMA                | Common validation/projection once, raw page attached, two imports                | Recommended |
| Decorated numeric array     | Extra source properties on the series itself                            | Unneeded special array semantics; canonical scanner rejects non-index members    | Excluded    |
| Provider-bound calculations | provider.sma(...) or a universal client                                 | Couples acquisition/calculation APIs, repeats registry grammar or grows a facade | Excluded    |

The view has only data access, not pricing/indicator methods. Explicit closePrices states which
financial field is analyzed; there is no implicit OHLC selection. An additional strict ohlcvBars
selection supports existing bar-input calculations without unknown-volume-as-zero:

```ts
// Existing vwap imported from technical-analysis; no new calculation API.
const volumeAverage = vwap(prices.ohlcvBars);
```

A missing required volume on any row throws while selecting ohlcvBars, before vwap executes.
It does not prevent fetching, inspecting or computing SMA from known closes on that same page.
The raw page remains interoperable with caller-owned transforms and other tools at prices.page.
Existing pure calculations continue accepting ordinary arrays/files/other providers' data.

## Decision 2 — exact proposed provider and consumer signatures

Common SDK types belong to the existing opt-in `@insiderfinance/totalfinance/core/data` entry.
The following revised source API replaces the unreleased C1 call shapes:

```ts
interface DataCallOptions {
  readonly signal?: AbortSignal;
}

// Authored by an external package; normalized raw responses, no view implementation.
interface DataProviderSource {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: 1;
  capabilities(options?: DataCallOptions): Promise<DataCapabilities>;
  query<R extends DataRequest>(
    request: R,
    options?: DataCallOptions,
  ): Promise<DataPage<DataFor<R>>>;
}

interface OhlcvInput {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}
interface PriceBarsView {
  readonly kind: 'price-bars';
  readonly page: DataPage<PriceBarRecord>;
  readonly closePrices: readonly number[];
  readonly ohlcvBars: readonly OhlcvInput[];
}
interface OptionChainResearchView {
  readonly kind: 'option-chain-research';
  readonly page: DataPage<OptionChainResearchRecord>;
}
type DataView = PriceBarsView | OptionChainResearchView;
type DataViewFor<R extends DataRequest> = R['kind'] extends 'price-bars'
  ? PriceBarsView
  : R['kind'] extends 'option-chain-research'
    ? OptionChainResearchView
    : DataView;

// Consumed by applications; query constructs the common view automatically.
interface DataProvider {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: 1;
  capabilities(options?: DataCallOptions): Promise<DataCapabilities>;
  query<R extends DataRequest>(request: R, options?: DataCallOptions): Promise<DataViewFor<R>>;
}
// Common SDK boundary, no provider import or network implementation in core.
declare function defineDataProvider(source: DataProviderSource): DataProvider;
// Advanced raw-page restoration; not needed in normal fetch/calculate onboarding.
declare function createDataView(page: unknown): DataView;
```

Options is optional, closed and limited to signal. Discovery accepts omission rather than requiring
an empty object. Requests retain the existing C1 discriminated grammar and explicit bounds. Source
and consumer protocols are deliberately different return types; one function must not ambiguously
return a raw page or view. The external factory builds a raw source and calls the public common
SDK defineDataProvider exactly once; provider authors implement no projection/view or indicator.

`defineDataProvider` uses the same existing C1 request/raw-page validation, immutable copies and
safe errors; after validation it builds the consumer view. createDataView uses the same shared
structural row/page validator for raw/serialized inputs, with no invented original query. Bounds/
filters/resource/snapshot checks remain at the query/provider boundary. Public construction and
stored-data use do not duplicate validation in a transport. The SDK owns all field-selection rules.

C2 deliberately replaces unreleased query({ request, signal? }), required capabilities({}), and the
old raw consumer result with direct query/options and a consumer view. No gratuitous aliases,
Promise-or-value unions or dual raw/view query modes. DataPage/PriceBarRecord/OptionResearchTerms
and wire protocol DATA_CONTRACT_VERSION 1 keep the same financial/temporal meaning; source calling
syntax and the consumer return type change together under review. The wrapper, kit, fixture,
external package and public examples must all migrate before fresh packed compatibility is claimed.

The public kit checks consumer DataProvider results, compares view.page against its existing exact
expected raw pages and additionally verifies view/array/field-selection laws. It never repairs a
bad page/view or rebuild it to hide a failure. Expected arrays come from independent golden facts,
not another invocation of the view constructor. Wrapper/source tests exercise raw source failures; expected-pages
comparison still refutes wrong bounds/filter/pin/ordering facts. No conformance acceptance of C1
source syntax is claimed for C2; all participating local packages use the exact reviewed SDK tarball.

## Decision 3 — arrays, validation, serialization and bundle ownership

The arrays are plain native arrays with Array.prototype, dense numeric indexes and no extra source
properties, custom subclasses or proxies. Arrays and constructed OHLCV rows are frozen; values
retain the original row order and exact canonical units. This is immediately compatible with existing SMA/BarInput consumers.
It also avoids non-index metadata members, which the current canonical-data scanner rejects on
arrays. The parent view, rather than a decorated array, retains the source page.

The immutable view's kind/page are enumerable read-only data properties. closePrices and ohlcvBars
are nonenumerable read-only accessors built by common SDK code. Each materializes/caches at most
one frozen array per view when selected; no re-fetch, hidden async work or financial computation.
Lazy ohlcvBars is necessary: building a view must not reject unknown volume before a user can
select closes. JSON enumeration must not invoke this strict selection accidentally.

The canonical persisted/transported object is **view.page**, not the behavior-bearing view.
`JSON.stringify(view.page)` and contentHash(view.page) retain the unchanged raw-page semantics.
`JSON.stringify(view)` contains only kind and page; it neither materializes arrays nor invokes
strict getters. To restore, parse the stored raw page and call createDataView, then narrow on kind.
Do not accept the view itself as a canonical artifact: canonical scanning rejects accessor-bearing
objects. JSON.stringify(view.closePrices) is deliberately just numeric data with no provenance;
ordinary array transformations similarly produce values without a retained view. No custom toJSON,
array serialization patch, global registry, hidden source lookup or second wire schema is added.

Both selections validate actual consumed fields on every row, never only the first. Validation is
shared with C1 raw-page components; malformed OHLC/nonfinite fields cannot become an accepted page
merely because a calculation would ignore them. Missing optional volume is a legitimate raw-page
unknown, not a malformed required close. Type-specific field refusal uses existing InputError
input.missing_field with safe row/field context; malformed response, protocol mismatch and unsupported
kind retain the existing data.invalid_response/data.contract_version_unsupported/data.unsupported_capability
semantics at their applicable boundary. Chains have no price-array selectors; callers must narrow
kind/use the raw research records, not price incomplete terms or manufacture a fill.

Source ownership is exact: view.page is the validated frozen raw page, including identity,
provenance, generation/receipt/observation/availability clocks, page/row diagnostics, quality,
freshness, adjustment, coverage and nextCursor. Selection does not edit or discard any of it.
Engine assumptions/diagnostics remain engine-owned and unchanged. No source warning is copied into
or allowed to overwrite an existing explain result. Future composed reports can reference the
retained page/handle explicitly; this slice does not add that report API.

New implementation ownership, if approved: common view code in packages/core/src/data-view.ts,
shared types in data-types.ts, exports and integration in existing data.ts/data-validation.ts;
focused tests beside core data tests. No technical-analysis import in core: OhlcvInput is structural
OHLCV data, assignable to existing BarInput. The external package owns only its factory/defaults/
HTTP mapping. Existing SDK assembly exposes core/data without root/main re-export or a new package.
No provider or view module may become a dependency of ordinary options/TA/root/browser compute.
View code is reached from the opt-in data entry; existing bundle/guard-only budgets must hold.

## Decision 4 — field suitability is separate from source quality

No blanket quality.partial refusal and no data.incomplete_page code/policy are introduced.

| Validated page facts                                           | closePrices/SMA                         | ohlcvBars/VWAP                           | Source handling                                                              |
| -------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| All actual closes, volume unknown, quality partial             | Allowed                                 | Missing-field refusal on selecting OHLCV | Preserve partial status and missing-volume diagnostics                       |
| Known OHLCV, another nonblocking quality issue                 | Allowed                                 | Allowed                                  | Preserve issue; neither selection upgrades quality                           |
| Zero close or zero volume                                      | Preserve actual zero                    | Preserve actual zero                     | Existing engine handles its defined zero-input behavior                      |
| Required close/OHLC malformed or nonfinite                     | Invalid raw-page refusal                | Invalid raw-page refusal                 | Never skip/repair the row                                                    |
| Empty valid page                                               | Empty array                             | Empty array                              | Preserve empty/quality/coverage facts; existing engine empty/warmup behavior |
| Unavailable/unknown quality label with otherwise valid rows    | Known fields remain selectable          | Actual required fields still required    | Label is disclosed, not a new policy ban                                     |
| Unknown observation/availability, EOD or split-only adjustment | Research calculation on supplied values | Same, when fields known                  | Retain every limitation; no PIT/live/total-return claim                      |

A transport/auth/entitlement/service failure still throws the existing typed error; it does not
turn into an apparently successful empty view. Quality metadata cannot authorize access, trading
or a stronger financial assumption. Known values plus warnings remain research facts; unknown
required inputs remain unknown/refuse at the consuming selection. User-owned pure arrays remain
subject to existing leaf contracts; the view does not secretly change every calculation's behavior.

## Decision 5 — one-page sample semantics, no complete-history promise

provider.query returns one explicit page, and the view exposes exactly that page's rows, even when
nextCursor is non-null or the page is a terminal continuation. Arrays contain no implicit prior/
next page, no sorting, gap fill, skipped row, annualization or lookback inference. Selection neither
makes another request nor refuses simply because a cursor exists. A caller explicitly asks for a
continuation using the repeated resource/cursor/limit laws, and each returned view remains a page.

The primary example calculates SMA over the **returned page**. It does not claim to represent the
whole from/to history; page size and source nextCursor are explicit, and page metadata remains
attached. A null cursor says only that pagination ended, never that source historical coverage is
continuous, availability was known or a complete expected calendar was observed. Partial quality
also does not make known selected values disappear. No data.incomplete_page bypass matrix remains.

A future requested-window workflow would have a different obligation: track the original request,
walk within explicit budgets, retain page identities/pins and refuse an unfinished requested window
rather than return an apparently complete result. No such workflow, completeness assertion or
auto-paging mechanism is part of this view. The contract's unit is one page of research observations.

## Decision 6 — external preview defaults stay invisible

External signature: `createInsiderFinanceProvider(apiKey: string, overrides?: InsiderFinanceProviderOptions): DataProvider`.
Options is the closed optional baseUrl/fetch/now object. The direct credential is structurally
unmistakable; named financial query/period inputs remain objects. No old factory-config alias.

For the private 0.0.0 internal preview only, omitted baseUrl is exactly
`https://api-staging.insiderfinance.workers.dev`. This documented preview default is not production,
a deployment change or staging-read permission. Production default selection belongs to an
authorized release. No environment guessing, fallback origin, key discovery or constructor request.
Omitted fetch captures/binds global native fetch; omitted now uses deferred Date.now for response
receipt and HTTP-date retry advice only. Normal use never supplies/reads a clock. Source observation,
availability, valuation, expiry, rates/volatility and other unknown financial terms stay unchanged.

Only undefined means omission. Null/wrong-type overrides, unsafe origin, invalid receipt instants
and blank/invalid credentials retain safe typed refusal. Missing native fetch without override uses
ConfigurationError with registered input.missing_field. Construction/local discovery do not call
fetch or now. Custom injection still enables synthetic HTTP/clock tests; no automatic retry, cache,
request allowance, grant change, clock-based source default or live fill permission is introduced.

## Current versus proposed and acceptance ownership

C1 currently requires infrastructure config, query({ request }) and manual
page.data.map(row => row.bar.close) before an existing SMA call. Revision 4fc5f9d replaced that map
with another imported helper/values/source report. This revision instead gives common consumer
query a data view with explicitly selected native arrays and its raw page attached. The calculation
imports, parameter grammar, numeric result and ordinary raw-data interoperability stay unchanged.
No SDK-only view is represented as an already implemented or published C1 feature.

The revised call shapes/view are technically approved, with direct defineDataProvider(source).
10/10 consumer acceptance,
not merely test pass status, remains the exit condition for the reworked experience. This candidate
chooses the minimal view against the alternatives above; it does not defer that evaluation to a
broad question. There is no additional unresolved endpoint/product dependency needed to review it.

## Synthetic proof acceptance

- [x] A clean installed consumer runs the exact two-import key/query/SMA example using fake global
      fetch and a three-row raw fixture [100, 101, 102]; last period-2 value is 101.5. Fixture and
      external HTTP provider use the same SDK view with no provider-specific projection code.
- [x] Existing sma and sma.explain over view.closePrices equal their results on the plain numeric
      reference array, including warmup/assumptions/diagnostics. Existing vwap matches complete OHLCV.
      Type tests accept readonly arrays and preserve raw .page compatibility; no engine source changes.
- [x] One-defect facts: missing first/later volume + quality.partial still permits identical closes/
      SMA, but selecting ohlcvBars throws before VWAP. Zero survives; unrelated source issues do not
      block known values. Invalid required OHLC/nonfinite data refuses; empty valid page stays empty.
      Unknown-volume tests use legitimate normalized fixtures; do not weaken actual required HTTP
      source fields to force a synthetic case through the adapter. Those source failures still refuse.
- [x] Non-null cursor and terminal continuation both expose exactly their own rows without another
      HTTP request or completeness claim. All original bounds/filter/nextFrom/pin/order/resource
      and typed entitlement/rate/allowance/redaction/cancellation controls remain exercised.
- [x] view.page retains exact canonical data, metadata, row/page warnings, identity and all null
      clocks. Lazy selection does not mutate input or source. Frozen native arrays have no non-index
      members; serializing the view does not invoke OHLCV access. Persist/restore .page gives equal
      values and source with no hidden lookup. Direct calculation results remain ordinary results.
- [x] API-key-only constructor/discovery do zero fetch/clock work. Native preview default and valid
      overrides use injected synthetic facts; invalid overrides refuse. No source-time substitution.
- [x] Wrapper/kit/fixture/source and consumer types, first-touch, API/generated contracts and packed
      NodeNext/Bundler/ESM proofs migrate together; generated measured defects zero, whole/installed/
      guard-only/browser bundle budgets unchanged. Record exact new local tarball hashes and commits.

The offline cases above now pass on Node 22.23.2/pnpm 10.32.0, including fresh installed SDK/provider
tarballs. Exact commands, artifact provenance and remaining hosted acceptance are recorded in the
[C2 implementation evidence](../reviews/community-connectors-c2-2026-11-02.md). The earlier spec-only
review remains historical evidence and does not certify this implementation.

## Isolation, history and later work

Worktree `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c2-addendum`, branch
`totalfinance/community-connector-c2-spec`. It is based on reviewed SDK
`b5c3c83fbeb9197dde9714cfeee9b8fb2e960083`, not on a changed PR26 head. Reviewed provider remains
`c492d2d15a1aeeb0ba2104fe55066d017bf66474` in its local-only repository. Their C1 exact-head
[fast](https://github.com/InsiderFinance/totalfinance/actions/runs/41523330653) and
[full](https://github.com/InsiderFinance/totalfinance/actions/runs/41523446543) green receipts remain
technical C1 evidence; they do not certify consumer acceptance. PR26 stays draft, feature in progress.
The [review record](../reviews/community-connectors-c2-spec-2026-11-02.md) and Ri task retain the
previous candidate and changes-requested disposition rather than erasing review history.

MCP/agent orchestration remains optional later composition of this same SDK path. No host/server/
pack prerequisite or async-runtime implementation is included here. Any later versioned-handle,
exact-selection, cancellation/deadline, metered-read and worker-binding design needs its own
review; it must reuse the accepted common data view/engine rather than copy logic into transports.

C1 trees, shared/linked checkouts and active accounting/approval stores are untouched. Bounded runtime work is authorized by the technical approval. No staging/secret/allowance/account/
paper operation, merge, version/publication/deployment, remote provider repository or recurring
automation is authorized or performed. Package versions
remain unchanged and local tarballs never claim registry SDK0.1.2 has unreleased exports. Consumer
view implementation is locally verified under that approval; final hosted acceptance remains open.

## Approved implementation ledger

- [x] Technical review approved at e1e5a910, with direct defineDataProvider(source) correction.
- [x] SDK source/consumer split, immutable view/restoration and shared validation implemented/tested.
- [x] Independent kit, fixtures, examples, first-touch/type/JS misuse and view mutants migrated.
- [x] Separate provider worktree direct-key/defaults/query migration and safe error/cancellation tests.
- [x] Exact primary two-import installed consumer and parity/quality/missing-field/serialization proof.
- [x] Public generated contracts and unchanged bundle/packed/browser gates pass at final source.
- [ ] Reviewable commits and draft PR26 fast-forward, fresh fast/full exact-head hosted checks.
- [ ] Later separately authorized connected/agent/App acceptance (not implied by offline proofs).
