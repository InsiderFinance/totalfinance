# C5: author protocol, deliberate resume and research-bar quality

Status: **technical re-review approved at467a9ed; bounded offline implementation in progress**.
2026-11-12. Task01a19da0-2a6f-7450-89a4-2e51047b05b5; execution01a19da1-1351-7b84-b67f-58bc81698fb5.
Request f417317e-89d8-8c08-8867-defc21e5f479. Maintainer authorized “Make the revision”.
This is the required engineering checkpoint, not another maintainer permission request.

## Consumer and author first

The controlling clean experience stays exactly:

```ts
import { data, technicalAnalysis } from '@insiderfinance/totalfinance';
import { createInsiderFinanceProvider } from '@insiderfinance/totalfinance-connector-insiderfinance';
const marketData = data.connect(createInsiderFinanceProvider(apiKey));
const prices = await marketData.priceBars({
  symbol: 'SPY',
  interval: '1d',
  from: '2026-09-01',
  to: '2026-10-28',
});
const averages = technicalAnalysis.sma(prices.closePrices, { period: 20 });
```

All examples here are proposed C5, not current C4 API. No obligatory host/clock/fetch/origin/MCP
configuration, projection import or provider-bound indicator. Existing functions still accept arrays.

A plain external author returns a SOURCE, without building a consumer wrapper or encoding queries
into cursors. A daily-only synthetic vendor mapping has this shape (body is a locally typed synthetic vendor
response with descriptive vendor fields; `readVendor` owns HTTP/auth/cancellation and returns one response, never retries):

```ts
import type {
  DataProviderSource,
  DataQuery,
  DataPageOptions,
  SourcePriceBarsPage,
} from '@insiderfinance/totalfinance/core/data';
export function createExampleProvider(): DataProviderSource {
  return {
    protocol: 'totalfinance-data-source',
    contractVersion: 2,
    id: 'example',
    version: '0.0.0',
    async capabilities() {
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 10000,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query(query: DataQuery, page: DataPageOptions): Promise<SourcePriceBarsPage> {
      if (query.kind !== 'price-bars' || query.interval !== '1d') throw unsupported();
      const body = await readVendor({
        symbol: query.symbol,
        start: query.from,
        end: query.to,
        page_token: page.cursor,
        limit: page.limit,
        signal: page.signal,
      });
      return {
        data: body.bars.map((b) => ({
          bar: {
            timestampMs: Date.parse(b.timestamp),
            open: b.openPrice,
            high: b.highPrice,
            low: b.lowPrice,
            close: b.closePrice,
            volume: b.shareVolume,
          },
          sessionDate: b.session,
        })),
        nextCursor: body.next_page_token,
        facts: {
          dataset: { id: 'example-bars', version: 'v2' },
          sourceSymbol: body.symbol,
          receivedTimestampMs: body.receivedTimestampMs,
          adjustment: 'unadjusted',
          consistency: 'best-effort',
          timestampConvention: 'session-start',
        },
      };
    },
  };
}
```

`unsupported()` above stands for the existing registered unsupported error, not a new helper export;
`b.session` is an explicit vendor session label, not a date inferred by the SDK. The executed
guide will include full vendor types and error construction. No conditional-return assertions.
The SDK constructs metadata/provenance/unknown-time records and immutable views once, commonly.

For finite suspect observations, acquisition succeeds and retains the originals:

```ts
console.log(prices.issues); // controlled page/row/rule/affected-fields; no provider text
// prices.closePrices throws data.suspect_observations if an unresolved issue affects close.
const chosen = prices.resolve({
  action: 'exclude',
  reason: 'Exclude contradictory OHLC observations',
});
const averages = technicalAnalysis.sma(chosen.closePrices, { period: 20 });
console.log(chosen.selection); // explicit exclusions, source row references and decision reason
// Alternatively: resolve({action:'use',reason:'...'}), or explicit OHLC corrections below.
```

A failed walk rejects, never succeeds partially. Deliberate persist/resume is separate:

```ts
try {
  await marketData.priceBars(request);
} catch (error) {
  const checkpoint = data.priceBarsCheckpoint(error);
  if (checkpoint) {
    await saveCheckpoint(JSON.stringify(checkpoint)); // caller-owned private storage
  } else throw error;
}
// Later, explicit retry/access decision; increased HOST budgets only when actually needed.
const resumed = await data
  .connect(provider, { maxPages: 40, maxReads: 60, maxRecords: 40000 })
  .resumePriceBars(JSON.parse(await loadCheckpoint()));
```

Checkpoint data may contain licensed rows and opaque cursors. It is not an error log/public message.
No example executes a real request in C5 acceptance; native HTTP/key facts are synthetic.

## 1. One boundary, common ownership and exact author protocol

Public placement remains `/core/data` for contract/source/wrapper, `/core/data-conformance` for the
kit, curated `/data` and root `data` for orchestration. No flat root connect export, third SDK
package, provider dependency, registry, plugin installer, transport/compute changes or TA import in core.

Change the unreleased source protocol coherently to DATA_CONTRACT_VERSION=2. This is NOT a package
release bump. Existing stored version1 pages/windows remain restorable under their old strict laws;
new v2 outputs/checkpoints are distinguishable. No old source-call aliases or shape unions.

Exact signature changes (readonly fields throughout):

- DataQuery = PriceBarsQuery | OptionChainResearchQuery. These are existing initial financial
  requests with `limit` removed. PriceBarsQuery has kind/symbol/interval/from/to; chain retains
  snapshot and every existing expiration/strike/right filter. No continuation-only query variant.
- DataPageOptions = {limit:number; cursor:string|null; pins:DataPins|null; signal?:AbortSignal}.
  DataPins = {datasetId:string; datasetVersion:string; snapshotId:string|null;
  sessionDate:string|null; adjustment:DataPageMetadata['adjustment'];
  consistency:'snapshot'|'best-effort';
  temporal:{kind:'price-bars';interval:DataInterval;timestampConvention:PriceBarRecord['timestampConvention']}
  |{kind:'option-chain-research'}}. SDK sends null pins on first call, accepted first-page
  pins thereafter. Provider must pass required vendor pins on; it cannot upgrade unknown pins.
- DataProviderSource = {protocol:'totalfinance-data-source'; contractVersion:2; id; version;
  capabilities(options?:DataCallOptions):Promise<readonly DataCapabilityDeclaration[]>;
  query(query:DataQuery,page:DataPageOptions):Promise<SourcePriceBarsPage|SourceOptionChainPage>}.
- SourcePriceBarsPage = {data:readonly SourcePriceBarRecord[]; nextCursor:string|null;
  facts:PriceBarsPageFacts; diagnostics?:Diagnostics}.
  SourcePriceBarRecord = {bar:Omit<Bar,'symbol'>; sessionDate?:string|null;
  times?:ObservationTimes; source?:string|null; provisional?:boolean|null; revision?:number|null;
  diagnostics?:Diagnostics}. Bar timestamp and OHLC remain required finite facts. No adjusted flag
  is inferred. SourceOptionChainPage has the same outer keys, existing homogeneous
  OptionChainResearchRecord data, and CommonPageFacts (no price timestamp convention).
- CommonPageFacts = {dataset:{id:string;version:string}; receivedTimestampMs:number;
  adjustment:DataPageMetadata['adjustment']; consistency:'snapshot'|'best-effort';
  sourceSymbol?:string; snapshotId?:string|null; sessionDate?:string|null;
  sourceGeneratedTimestampMs?:number|null; times?:ObservationTimes;
  freshness?:DataPageMetadata['freshness']; coverage?:DataPageMetadata['coverage'];
  quality?:DataPageMetadata['quality']; access?:DataPageMetadata['access']; requestId?:string}.
  PriceBarsPageFacts adds required timestampConvention (section4).
- defineDataProvider(source:DataProviderSource):DataProvider remains the advanced validated consumer
  constructor. `DataProvider.query<R extends DataQuery>(query:R, options:{limit:number;
cursor?:DataContinuation;signal?:AbortSignal}):Promise<DataViewFor<R>>` is one page, zero discovery.
  DataQueryBinding={provider:{id:string;version:string};query:DataQuery}.
  DataContinuation={version:2;binding:DataQueryBinding;cursor:string;pins:DataPins}.
  Both price-bar and chain one-page views expose continuation of this shape or null. SDK compares supplied financial query
  exactly, rejecting conflicts before invocation; manual caller does not assemble pins.
- data.connect(source:DataProviderSource, options?:DataConnectionOptions):ConnectedData.
  ConnectedData exposes capabilities/query plus priceBars and resumePriceBars. External factory
  returns DataProviderSource, NOT DataProvider. Passing a C4 validated consumer fails the protocol
  and method/contract preflight before discovery/query. No ambiguity between raw page and view.

The full original frozen query is passed on EVERY source call. Only limit/cursor/pins/signal vary.
Wrappers copy inputs, do not mutate/freeze caller objects. SDK stamps contractVersion/kind/symbol,
provider identity, provenance.dataset/sourceVersion/receivedAt from facts, convention constant and
research-only eligibility. Authors supply dataset/adjustment/consistency PER PAGE, not per provider.
Omitted optional facts mean UNKNOWN, never a clock, price, basis, rate or coverage default: explicit
canonical null times; unknown freshness/coverage/quality/access; empty diagnostics. Non-null
sourceSymbol is checked against query; echoed identity must be mapped by authors when vendor supplies
it. Unknown-key/duplicate source envelope fields refuse, not ignored copies that conceal contradictions.
Per-row symbol and provenance copies disappear from author input. Adjusted row flag remains optional
and independent; when known C4 adjustment consistency still applies, with no inferred true/false.

Canonical v2 DataPage retains existing normalized fields and adds exactly one SDK-stamped
`binding:DataQueryBinding` plus `issues:readonly ResearchBarIssue[]`. No separate page interval:
bar interval lives only in binding.query.interval. Every binding holds the complete original query,
including chain snapshot/expiration/strike/right filters, and exact provider package id/version.
Authors supply none of this duplicated binding. Canonical price-bar pages also retain a required
page.timestampConvention copied from explicit source page facts, including on empty pages; each
canonical row keeps its existing timestampConvention stamped from that same fact and must agree.
This retains temporal pins even when the first accepted page has zero rows. Chains have neither
page timestampConvention nor OHLC selectors; their bar issues are empty.

createDataView(page:unknown,selection?:unknown) validates v2 binding, kind/symbol/provenance identity,
all rows against stored original filters/bounds, pins/conventions and canonical schema before
constructing a view. For nextCursor non-null it deterministically constructs continuation from
page.binding, nextCursor and accepted page facts (including page timestampConvention on empty bars); terminal page yields null. No financial bound
or provider version is inferred from rows/provenance.datasetVersion. Advanced consumer query takes
that continuation and compares its binding.query to supplied query and binding.provider to actual
bound source id/version BEFORE invocation, with zero discovery. A modified external query/token
binding or different provider version refuses before I/O. Arbitrary consistently rewritten stored
facts cannot be authenticated; this is validation of represented data, not tamper-proof provenance.
Legacy v1 createDataView can still restore its raw page/selectors under old laws but exposes no
usable continuation (continuation:null, continuationStatus:'unavailable-legacy-context' when a cursor
exists, 'terminal' otherwise). It never invents query/version. V2 statuses are 'available' or
'terminal'. Legacy callers with external original context must start an explicit new query;
there is no implicit v1 continuation upgrade/alias.

```ts
import { createDataView } from '@insiderfinance/totalfinance/core/data';
const first = await marketData.query(filteredChainQuery, { limit: 100 });
const restored = createDataView(JSON.parse(JSON.stringify(first.page)));
if (restored.continuation) {
  await marketData.query(filteredChainQuery, { limit: 100, cursor: restored.continuation });
}
```

The common materializer/page/sequence validator never prices, sorts, deduplicates, repairs values
or generates expected answers. Dataset/version/pin/adjustment/consistency AND bar interval/convention
remain constant within a window, restored window or checkpoint; independent queries may differ.
Null best-effort pins never become snapshot/PIT guarantees. C4 chain term/ID/premium laws remain.

## 2. Finite capability and host safety contract

Supported interval literals: 1m,5m,15m,30m,1h,4h,1d,1w,1mo. This is a finite initial understood set,
not every vendor timeframe or a numeric interval DSL. Intraday bounds are inclusive zoned ISO instants;
daily/weekly/monthly bounds are inclusive explicit session labels YYYY-MM-DD. No mixed/zone-free
bounds, range reversal or default dates. No universal31-day constraint. Week/month durations are not
constant milliseconds; no inferred calendar coverage or bar alignment grid. Actual source start
and session labels govern bounds (section4), never generated expected sessions.

Known capability declaration: {kind;intervals;maxPageSize;consistency:readonly modes[];
pointInTime:false;access; maxWindowMs?:number; maxSessionDays?:number}. Bars intervals nonempty,
chains intervals empty. Optional range ceilings apply only to instant/session query respectively;
positive safe integers, no guessed trading-day meaning. For instant bounds maxWindowMs permits
exactly `toEpochMs-fromEpochMs <= maxWindowMs` (inclusive endpoints, zero span allowed). For session
bounds maxSessionDays counts Gregorian dates inclusively as `(toUtcDateMs-fromUtcDateMs)/86400000+1`;
equal dates count1, weekends/holidays count, no exchange calendar is consulted. Only these explicit
provider ceilings restrict spans; the SDK does not infer an interval-duration-based span ceiling. IF declares its actual2000 and minute31-day
restriction; independent Alpaca-style preview declares10000 and supported additional intervals.
Provider ceilings are source facts, not host limits. maxPageSize positive safe integer need not be
<= host cap. Requests never exceed min(provider ceiling, explicit host ceiling, remaining records).
Explicit impossible override refuses; omitted pageSize negotiates min(1000, provider ceiling).

Unknown capability kinds are ignored with a controlled unsupported-kind discovery note. Unknown
well-formed raw tokens (ASCII1–32 characters matching `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`) are ignored within a known kind, with a
controlled unsupported-interval note; no arbitrary text copied into warnings. Token framing only
bounds safe identifiers, never parses numeric duration or treats new units as understood. Thus1s,
1y and a future named token can be ignored while1d remains supported. Empty/whitespace/control/
nonstring/oversize tokens refuse, as do duplicate raw tokens before filtering; ['1d','1s'] yields1d
plus ignored.intervals1. Unknown kind plus a known kind preserves the latter. Malformed known entries
(0 size, bad mode/type, duplicate kind/interval, malformed token) still refuse the descriptor.
A known kind left with no understood intervals is unavailable, not a reason to disable other kinds.
Discovery returns validated understood DataCapabilities plus ignored counts, not arbitrary future
payloads. The descriptor scanner remains bounded before dispatch; query unknown interval refuses.

Operational defaults remain pageSize1000,maxPages20,maxRecords20000. Add maxReads21 (discovery
included). Hard host ceilings: pageSize10000, maxPages100 accepted pages, maxReads101 attempted
provider invocations, maxRecords100000,8MiB canonical bytes/page,64MiB total accepted canonical pages.
These are deliberately host safety bounds, not vendor maximums. Keep bounded canonical scanner work
2M/page; restore checks aggregate incrementally with hard total20M work units. Strings/descriptors
are bounded under scanner rules before canonical sizing; no speculative unbounded stringify.
Capability lists at most64 entries/64 interval strings per entry, existing symbol/cursor/string bounds.
No larger registry/helper optimization or cap edit is preapproved. Connection options add maxReads;
call options can only lower resolved connection limits. PageSize explicit larger than host hard cap
refuses before source call. Reads measure provider invocations, not billing: provider authors must
perform at most one vendor data request per query, disclose discovery cost, and do no hidden retries.
Hosts enforce actual request allowances externally; SDK limits do not grant access or paid reads.

Primary evidence: [Alpaca stock bars](https://docs.alpaca.markets/us/reference/stockbars) documents
10000 returned points and page_token, with additional timeframes. [Polygon's own client contract](https://github.com/polygon-io/client-php/blob/master/docs/Api/CryptoaggregatesApi.md)
describes50000 BASE aggregates queried, not a universal returned-row limit. This scope chooses
understood intervals and host bounds explicitly; no staging/vendor data request verified here.

## 3. Safe errors across SDK copies and useful teaching

Common data-call boundary owns validation/sanitization, not instanceof across package copies.
Recognize existing QuantError data/input/unsupported code via own data descriptors (`code`,
optional plain `context`), registered allowed code subset and validated fields; never invoke foreign
toJSON/getters or trust name/message/cause. A copied real DataError/data.rate_limited retains code,
boolean retryable and finite nonnegative retryAfterMs (plus HTTP status100..599). Reconstruct a local
typed error, with SDK text. Arbitrary same-code objects cannot smuggle other context/text.
This is a portable shape contract, not authentication of foreign objects.

Add opt-in public DataProviderError in `/core/data` for vetted guidance and local debug ownership:
constructor({code:allowed provider code; guidance?:{field:KnownDataField;rule:DataGuidanceRule};
retryable?:boolean;retryAfterMs?:number;status?:number;cause?:unknown}). Its versioned own
`dataFailure` descriptor is {version:1,code,guidance?,retryable?,retryAfterMs?,status?}; cross-copy
boundary validates exact closed data shape and reconstructs locally. No arbitrary public message
parameter. Invalid safe declaration becomes generic provider failure. Existing DataError authors
still work by code, with generic SDK guidance, not their original arbitrary message.

KnownDataField is finite schema paths used by C4 plus request.symbol/from/to/limit/interval and
request.from/to. Rules: uppercase_symbol, zoned_instant_required, session_date_required,
ordered_bounds, page_limit, unsupported_interval, source_domain_rule. Each has SDK teaching text;
source_domain_rule says provider rejected the field, without claiming its arbitrary rule was proven.
IF lowercase teaches “query: request.symbol requires uppercase provider symbols; supply SPY.”
(the SPY example is SDK literal, never interpolated caller text). Wrong bounds and page sizes name
the applicable door/field/range; more rows than limit uses out_of_range; dataset mismatch uses
inconsistent. No silent uppercase/sort/date repair. Pure request validation stays InputError.
C4 controlled page/capabilities/schema paths/reasons/indices remain; only SDK validation can produce
trusted research ResponseIssue details. Unknown throws from source invocation become new registered
DataError/data.provider_failure, retryable false by default, not invalid market data. Known transport
unavailable/throttle/auth/access codes remain. No automatic retries anywhere.

Optional cause is local nonenumerable diagnostic ownership: never copied to context, toJSON, JSON
serialization or logs by the SDK. Unknown provider throws may be retained as local nonenumerable
cause on the normalized error for explicit host inspection; hosts must not publish that object.
No arbitrary own property forwarding, URL/body/cursor/secret text, mutable global context, broad
async acquisition try/catch or generic logging system. Use narrow existing invocation/validation
phases; page-loop failure annotation only captures checkpoint (section5), not error-message rewriting.

## 4. Time, native views and honest discoverability

Extend normalized timestampConvention with session-start. Keep session-label-midnight-utc and
interval-start. IF date-only labels can continue explicit midnight-label mapping; Alpaca-style
actual04Z stays04Z with explicit source sessionDate and session-start. Never convert actual04Z to
midnight. session-start requires sessionDate for1d/1w/1mo; interval-start is intraday, sessionDate
nullable; midnight-label requires exact midnight plus matching date. No implicit timezone or
session-date derivation. Bounds for session queries use explicit sessionDate; intraday uses actual
start timestamp. Ordering/identity use actual timestamp and strict session-label progression for
session queries; conflicting same-session duplicate is refused. Timestamp is never observation,
availability, valuation or guaranteed exchange-open time. Existing unknown clocks stay null.

Only price-bar page/window views expose closePrices/ohlcvBars/bars, issues/selection and resolve.
Chain views expose raw page/continuation and research metadata, never OHLC selectors/decisions.
Add `bars:readonly TimestampedOhlcvInput[]`, where the exact type is
`Readonly<Bar & {volume:number}>`. Project every defined canonical Bar field: symbol, timestampMs,
OHLC, actual volume, optional adjusted and vwap. Preserve adjusted:true, adjusted:false, absent
adjusted and vwap:0/absent exactly; never derive flags from page adjustment metadata or compute vwap.
No source decoration is needed on arrays. OhlcvInput-only selection keeps its existing shape; bars is the canonical financial-flag-preserving projection. Strict selection requires actual volume on EVERY row,
even though resample TimeBar makes it optional and its current engine treats absence as zero.
No selector performs calculation/clock/fetch, no compute/backtest/resample API changes.

Existing vectorized options require mutable Bar[] ownership; a readonly native selection is NOT
assignable directly. Teach an ordinary array ownership copy, without assertions:

```ts
const result = backtest.vectorized({ ...explicitBacktestOptions, data: [...prices.bars] });
const sampled = technicalAnalysis.resample(
  prices.bars,
  explicitResampleInterval,
  explicitResampleOptions,
);
```

Caller supplies all existing engine policies/options and signals, aligned to selected sourceRows.
The ownership copy does not change frozen source rows. Resample accepts ArrayLike directly.
Verify vectorized result assumptions.corporateAction equals the independent source-Bar baseline
for true/false/absent flags (its current data[0].adjusted behavior stays unchanged), plus exact zero
vwap projection and actual engine parity. Deliberate use of suspect bars never bypasses leaf guards.

Price-bar views have enumerable frozen data `selections:['closePrices','ohlcvBars','bars']` and
issues/selection. Numeric selectors remain nonenumerable lazy cached getters. Object.keys/console
can discover choices without invoking strict getters. JSON enumerates kind/page-or-window/
continuation-and-status/selections/issues/selection only; unknown volume cannot make it throw.
Persist canonical page/window and selection, not getters. Native frozen Array.prototype arrays,
no Proxy/decorations. Chain serialization has no bar-only properties.

Temporal pin law: DataPins.temporal for bars is derived from binding.query.interval plus first-page
explicit canonical page.timestampConvention, and every page's rows must match that convention. Shared sequence
validation checks this tuple on live walk, canonical window restore, checkpoint restore/resume and
kit, even when both individual pages are valid daily records. Mixed midnight-label/session-start
refuses as data.invalid_response/inconsistent before accepting the changed page. Adapter code does
not rebuild this guard.04Z stays04Z; session labels stay explicit, with no claim of exchange-open,
observation or availability. Chains use temporal.kind only and no invented bar interval/convention.

## 5. Deliberate resumability, not partial success

ConnectedData adds resumePriceBars(checkpoint:unknown,options?:PriceBarsWindowOptions):Promise<PriceBarsWindowView>.
The single explicit accessor priceBarsCheckpoint(error:unknown):PriceBarsCheckpoint|undefined is
exported by `/data` and root data, with one common implementation. Existing normalized error
classes/codes remain intact, including InputError provider refusals. The walk attaches a readonly
nonenumerable checkpoint data property to its locally normalized error. The accessor uses an own
data descriptor and the same bounded checkpoint validator (no foreign getters/methods), returning
undefined if absent and refusing malformed supplied checkpoint data. No pages/cursors in message,
context/toJSON/ordinary JSON serialization. Reading/persisting the checkpoint is deliberate. This
one accessor avoids a new window error hierarchy; no general error-helper framework.
Input preflight failures have no checkpoint. Zero-page invocation failures can retain initial state
for honest accounting.
Canonical checkpoint exact outer shape:
{version:1,kind:'price-bars-checkpoint',contractVersion:2,binding:DataQueryBinding,
pages:readonly DataPage<PriceBarRecord>[],next:DataContinuation|null,
progress:{status:'incomplete',acceptedPages:number,records:number,reads:number},
paging:{requested:{mode:'automatic'}|{mode:'explicit',size:number},
state:{status:'unresolved'}|{status:'resolved',effectiveSize:number}},
limits:{maxPages:number,maxReads:number,maxRecords:number},bytes:number}.
Binding.query must be PriceBarsQuery. No duplicate pageSize in limits. No signals/credentials/methods
or source errors. next.binding must equal checkpoint binding and every retained page.binding;
next.pins match first accepted page including temporal tuple; next.cursor equals last nextCursor.

A failed INITIAL discovery stores requested automatic/explicit policy and unresolved size, with
reads incremented1 and zero accepted pages. Resume can negotiate automatic min(1000,provider ceiling)
after its discovery; a provider ceiling50 therefore resolves50. Explicit1000 against50 still
refuses after discovery (that consumed read retained), leaving size unresolved. Resolve effective
size after successful negotiation; once resolved it stays pinned on resume, including a failed first
query. Any accepted page requires resolved size. With accepted pages a changed capability ceiling
below pinned size refuses, never silently shrinks. Before accepting any page a caller wanting a
different size must deliberately start a different operation; this is not a counter-reset mechanism.

ONLY pages.length===0/acceptedPages===0 with next:null means initial source request, whether
paging is unresolved or resolved. No inference from records===0. Accepted empty nonterminal pages
are explicitly permitted in v2 if nextCursor is non-null, different and unseen. They count as a page
and read, retain dataset/temporal pins and their cursor, and cannot reset paging/query/order state.
Order tracks last nonempty row key through empty pages. Repeated/cyclic cursor refuses; finite
page/read ceilings bound even a stream of distinct empty cursors. Accepted terminal empty page
finishes success; a terminal page never creates incomplete state. Legacy v1 laws remain unchanged.

Seen cursors/order keys are recomputed from retained pages; no untrusted independent last-key state.
Accepted page count equals pages.length, records equals row sum; reads >= acceptedPages+1 (at least
one discovery) and can be larger from failed/aborted/discovery attempts. Every count is bounded by
hard limits; stored limit exhaustion is a valid checkpoint state, not a successful window. bytes
must match bounded canonical page sizes. No checksum authenticates caller-edited facts or actual
external billing history. Represented-state validation, not tamper-proof ledger/crash-atomic storage.

PriceBarsWindow exact v2 outer shape is {version:2,kind:'price-bars-window',contractVersion:2,
binding:DataQueryBinding,pages:readonly DataPage<PriceBarRecord>[],
pagination:{status:'terminal',pageSize:number,pageCalls:number,reads:number,records:number},bytes:number}.
pageCalls counts accepted pages; reads includes failed attempts and discovery. It retains original
query, accepted pages and terminal status. At least one terminal page for empty success. Counts no
longer falsely equate reads with pages after resumed failures; source per-page clocks remain intact.
Checkpoint creation deep-copies/freezes accepted pages; copies may share immutable internal objects,
never mutate caller input. It stores normalized accepted facts, not unvalidated/failed response data.

Before resume: bounded scan and revalidate every page/query/provider/dataset/pin/adjustment/order/
filter/cursor-cycle/count/byte fact and contract version. Bind exact provider id/version (host must
also supply the correct access binding; credentials are not compared/persisted). Reject forged/raw
source boundary or mismatched binding before reads. Fresh capability negotiation costs ONE additional
read, resolves unresolved paging policy or checks the pinned effective size/pins as above. No accepted-page refetch.
No automatic new snapshot on expiry. Source410 remains data.snapshot_expired, with prior checkpoint.

Before invoking discovery or query, increment reads once; failed/aborted invocation remains charged
to consumed SDK work. Pre-aborted signal before invocation increments nothing. Accept a page only
after body/validation/post-await abort checks; if abort races acceptance, whichever synchronous check
runs first defines commitment. Late successes after abort are ignored. Failed unaccepted page may
be requested again only by explicit resume; vendor may have charged twice. No server idempotency or
identical best-effort retry promise. Invalid page after a successful upstream read consumes a read
but is not accepted. Do not continue automatically after invalid data. Query attempts are sequential.

At budget exhaustion refuse before another call and retain the checkpoint. Resume never resets
reads/pages/records. Budget merge for each k in maxPages/maxReads/maxRecords is exact:
S[k]=stored limit, C[k]=resolved connection ceiling, E[k]=explicit constructor option if present,
R[k]=explicit resume option if present. Candidate[k]=R[k] if supplied, else E[k] if supplied,
else S[k]. Require positive safe integer <=C[k] and hard cap, and no limit below consumed work.
A smaller explicitly selected limit may constrain remaining work; an explicit increase authorizes
only that host work. A bare new connection's larger DEFAULT C does NOT change S. R is a call
ceiling <=C even if constructor default was used. For example saved maxReads5 on a default21-read
connection still uses5; explicit resume maxReads10 can raise it to10 within C21. A new connection
with explicit maxReads60 can raise it to60 without requiring a second redundant resume option.
If default C is LOWER than stored S, refuse with checkpoint before I/O until host explicitly binds
sufficient ceilings or requests a permissible reduced limit; never silently replace S with defaults.

Paging policy is separate and immutable on resume: options.pageSize on resume must be absent or
exactly the original explicit size; an original automatic policy cannot be changed by resume or
connection defaults. Accepted pages pin effectiveSize as above. A larger explicit constructor
pageSize is not a request to alter that saved policy. Budgets are limits for the entire resumed
operation, not incremental grants. Creating a connection/signal or waiting never resets them.

Before resumed discovery reserve room for at least ONE discovery and ONE query (reads+2<=maxReads),
and one additional accepted page/record capacity; otherwise refuse before I/O with unchanged
checkpoint, no charging invented reads. Discovery failure consumes exactly1 read. Discovery that
succeeds but rejects capabilities/paging/range/entitlement also consumes1, updating the checkpoint
before refusal; it does not consume a query. Pre-aborted resume with a valid checkpoint rethrows data.aborted with unchanged checkpoint/counters and zero calls. Post-discovery pre-abort consumes no query read.
Before actual query dispatch recheck abort/limits, increment1, then retain that consumed read on
failure/body abort/validation refusal. If a lower record budget would prevent even a terminal
empty query, conservatively refuse without an extra read; do not spend beyond declared budgets.
All pre-I/O resume budget/capability/policy refusals attach the last validated checkpoint; malformed
checkpoint input itself remains InputError with no trusted checkpoint. Late source successes are
not accepted after abort. New limits are recorded only after successful local merge validation.
No provider allowance is granted or reset. Retryable failures require explicit host/access choice;
no automatic retries/background jobs/cache or generic page-job abstraction.

## 6. Suspect observations and smallest explicit choices

Acquisition validates structure/identity/finite required numbers and preserves them. Replace only
finite OHLC inequality hard failures with deterministic controlled ResearchBarIssues. Rule list:
low_above_high (affects allOHLC), open_outside_range (affects open/low/high), close_outside_range
(affects close/low/high). Each issue has {pageIndex,rowIndex,rule,fields:readonly OHLCField[]}.
No numeric source values/arbitrary provider text. Nonfinite/wrong-type essential inputs still
refuse; negative/missing actual volume keeps prior field rules. Adjustment/dataset/pin/bounds/order
contradictions and C4 option premiums remain hard errors. Independent source quality warnings are
not automatically blocking; never a blanket partial ban.

Views expose issues immediately, even when acquisition succeeds. Default selectors STOP with new
registered data.suspect_observations only if an unresolved issue intersects fields they consume.
For high<close, closes are affected: the SDK cannot know which operand is wrong. A truly unrelated
issue (e.g. open outside range) does not block a known close. OHLCV and bars consume all OHLC and
actual volume. Error identifies controlled rule/row/selection without copying values.

Page/window views add resolve(choice:ResearchBarChoice):same view type. Choice is a closed union:
{action:'exclude'|'use';rows?:readonly RowReference[];reason:string} OR
{action:'correct';corrections:readonly {row:RowReference;values:Partial<Pick<Bar,'open'|'high'|'low'|'close'>>}[];
reason:string}. RowReference={pageIndex:number;rowIndex:number}; page views require pageIndex0. Omitted
rows means all currently unresolved suspect rows, never clean rows; explicit rows must identify
existing issues. reason nonblank <=512 characters is caller-owned research text, never error text.
No zero-filling or invented correction. Correct action requires at least one finite explicit OHLC
replacement per row, revalidates complete resulting OHLC inequalities, and refuses if still suspect.
Cannot change identity/time/volume/adjustment/dataset/terms or manufacture missing volume here.
Empty/duplicate/conflicting row choices and repeated resolution of a resolved row refuse.

resolve returns a NEW view with same immutable original page/window, generated native arrays and a
canonical `selection` record {version:1,decisions:readonly ResearchBarChoice[],sourceRows:readonly RowReference[]}
listing included row references in source order. Excluded rows are absent from projections; original
source rows/issues remain. Corrected values affect projections only; decision ledger preserves
explicit replacements and reason. Use is a visible deliberate override, never clean-validation
certification: unchanged pure calculations may still refuse contradictory OHLC. STOP remains
available by doing nothing, not another required policy object. No callbacks, transforms, hidden
sorting or per-indicator wrappers. Selections stay aligned across close/OHLCV/bars; caller signals
must use included sourceRows after exclusions; no implied continuous history/complete lookback.

Persist originals and selection separately. createDataView(page:unknown,selection?:unknown) and
createPriceBarsWindowView(window:unknown,selection?:unknown) revalidate source, recompute issues,
validate/replay decisions and exact sourceRows before restoring. No overwritten original, fabricated
source provenance or silent reapplication of arbitrary transforms. Serializing a view exposes the
selection decision record without invoking getters. Display/retain it with any research result;
plain engine output does not magically carry source metadata. User text is private storage content,
not allowed into serialized SDK errors. A provider cannot authorize choices on behalf of the caller.

## 7. Compatibility, independent kit and measured closure

This supersedes C0-C4 only where explicit: raw query/envelope, source binding, capability negotiation,
session timestamps, suspect inequalities, windowv2 and checkpoints. Frozen core Bar/option/compute
units, option terms/Greek/premium/C4 safe schema laws, pure calculations and independent packages
remain. C4 approved3bc356f and all reports/probes stay immutable history, not C5 certification.

SDK package0.1.3 metadata is inherited, not a claim registry0.1.3 has C5 exports. Protocol2 is checked
at construction; no semver inference. Preview provider peer remains exact local0.1.3 with actual file
integrity/SDK commit and tarball hashes. At authorized release, select the real first shipping SDK
version and peer range limited to that supported pre-1.0 minor (>=first supported patch,<next minor),
not all0.x or a fabricated future release. Compatibility means protocol plus conformance corpus,
not class identity. No release version selected or publication/remote created in this task.

Retain independent expected normalized-page probes; add concise independent expected-record probes
with literal OHLC/time/terms/units and literal expected facts (dataset/basis/times/coverage), not calls
to SDK normalization or the provider under test. The kit can compare duplicated mechanical envelope
identities to query/declarations as laws without making authors repeat every null/constant. Source
and consumer tests prove actual fields correspond, not reconstruct a correct selector over a lie.
One-defect unit-scale expected-values mutant must fail even though finite structurally valid.
Expected fixtures remain InputErrors before provider invocation, actual faults DataErrors with C4
detail/page indices. Independently installed SDK copies must pass real typed error/refusal cases.

Ordered implementation after coordinator review:

- [x] Read task/review/evidence and prior contracts; new isolated tree from exact3bc356f.
- [x] Record fetched mainca122ab3115ea08cc8789fd7d1be8380382fdc6c: already ancestor of base, no new merge needed now.
- [x] Coordinator technical re-review approved467a9ed before runtime changes; prior rejection retained below.
- [x] Source protocol/common normalization/finite negotiation, pre-read misuse rejection; migrate IF
      in separate provider worktree from29b02e0, no remote. Keep all83 original behaviors/corpus,
      migrating signatures, and a copied independent Alpaca-style author (original unchanged).
- [x] Cross-copy safe errors/teaching/network classification and every C4 diagnostic/redaction law.
- [x] Native timestamped selections/serialization and source04Z/session facts; unchanged engine parity.
- [x] Explicit checkpoint/resume with failure accounting and separate private storage; independent
      rate-limit page3, discovery failure, record/page/read exhaustion, pre/in-flight/body abort,
      expired pin and malformed restore mutants. No accepted read repeats, skips or duplicates;
      explicit increased budget vs hidden-reset/allowance refusal, best-effort uncertainty disclosed.
- [x] Suspect OHLC acquisition, field-intersection STOP, exclusion/use/correction and replay/storage;
      partial/empty/zero/missing-volume, clean source and immutable decisions/correspondence mutants.
- [x] Fresh independently packed SDK/IF/starter/Alpaca-style consumers, strict no-assertion author and
      readonly consumer NodeNext/Bundler; shared independent oracle, one/three-page119.5,103/102/101.5,
      SMA.explain/VWAP/backtest/resample structural parity and no-key guide executed verbatim.
- [x] Final concrete baseline/candidate whole+installed min/gzip/retained graphs and repeated bytes.
      All C4 caps stay until technical measurement review; no shared optimization or settings edits.
- [x] Source-final affected ordered generators (signature→naming→contract→enforcement→validation→API→
      README→LLM→reference/bundle→OpenAPI→docs), zero measured defects/truthful joined counters,
      public/first-touch/API/types/scoped lint+format/full existing packed/whole/browser/guard gates.
- [ ] Reviewable SDK/provider commits, fast-forward SAME draftPR26 only after local gates; fresh
      exact-head FAST+FULL hosted runs, no post-green commit without rerun. Feature stays in_progress.

Node22.23.2/pnpm10.32.0 frozen installs. Spec approval alone did not certify runtime. Offline proofs are in the C5 closure report; no
MCP/App/agent glue or connected acceptance is claimed. No merge/publication/new release version/deployment/provider remote/API-server
edits/staging/secret/allowance/key/grant/account/paper/recurring/live operations. No unresolved
external product choice is deferred: defaults, semantics and choices above are concrete review
proposals, not claims the maintainer already endorsed unseen details.

Precision: DataCapabilityDeclaration uses bounded string kind/interval tokens on the raw wire, so
future entries can be represented without TypeScript assertions. The understood DataCapabilities
consumer result has contractVersion2/providerId/providerVersion, validated known capability records
and ignored:{kinds:number,intervals:number}; no future payload is forwarded. Known consistency modes
must match each query's actual per-page facts. Snapshot mode requires a non-null real source pin.
Price-bar page issues use pageIndex0 at one-page scope; window issues copy controlled issue records with actual
page index without altering retained page facts. Selection defaults to version1/empty decisions/all
sourceRows; the window retains original pages regardless of selection. New source protocol is
rejected by old SDKs; restore supports old v1 under old laws without quietly migrating financial facts.
Public types named here belong to data-types.ts; normalization/negotiation stay data-validation/data.ts,
selectors data-view, window/checkpoint work data-connection (a narrow checkpoint module if needed).
Public errors/codes use the existing core registry and opt-in data error boundary, no registry rewrite.

## Re-review acceptance additions (101c2e57, 2026-11-12)

- [x] Persist/restore nonterminal bars AND filtered chain pages, compare exact binding/query/pins/
      cursor, continue with zero discovery; mismatched supplied query/bound provider refuses before
      I/O; no inferred dates/version for legacy v1. All v2 pages in stored windows match binding.
- [x] Failed initial discovery automatic1000 then provider50 negotiates50; explicit1000 refuses;
      post-discovery refusal count retained; saved low limits on larger default connection unchanged;
      explicit constructor/resume increases work; insufficient reads refuses with checkpoint/zero I/O.
- [x] Accepted empty nonterminal first/intermediate page preserves next cursor/counts/pins/effective
      size and last nonempty order key; resume never restarts from first query or refetches it.
- [x] Timestamped bars preserve true/false/absent adjusted and zero/absent vwap, every actual
      timestamp/volume; strict TS proves ownership-copy backtest and direct ArrayLike resample;
      actual engine results/assumptions equal independent canonical-Bar reference inputs.
- [x] ['1d','1s'] and ['1d','1y'] keep1d/count ignored; malformed-type/empty/control/oversize/duplicate
      raw token rejects; unknown kind mixed with supported kind cannot disable the latter.
- [x] Individually valid daily midnight and04Z session-start pages mixed across a live/restored/
      resumed window fail shared temporal pin law and kit; homogeneous04Z works without any inferred
      observation/availability. Span equality/equal-date/weekend cases verify exact provider ceilings.

Review disposition at6f3fdd6 is changes_requested, not runtime approval. These corrections replace
ambiguous earlier prose without changing maintainer scope. Re-review required before implementation.

## Technical approval and host-ceiling precision (872db889, 2026-11-12)

Coordinator approved467a9ed after full re-review; review01a1d0a5-1685-72ed-95e6-cdfcfa3670ee,
output01a1d0a0-c7c8-790e-baa4-f4d8cf974c4e. All prior changes_requested history remains.
Before runtime: resumed resolved effectiveSize must fit CURRENT connection page-size ceiling,
provider maximum and hard cap; a lower connection ceiling refuses BEFORE upstream I/O with unchanged
validated checkpoint, never shrinks or resets. Unresolved automatic paging negotiates min(saved
base1000,current connection ceiling,provider maximum). Original explicit size must fit all ceilings.
Larger/default connections do not alter saved policy or budgets. A pre-dispatch abort that invokes
no source consumes ZERO reads; increment occurs at actual invocation. Focused lower-ceiling tests
for unresolved/resolved states and zero-invocation abort are required. Bounded offline implementation
is now authorized, not implementation/feature/merge acceptance; no new permission checkpoint.

## Measured implementation checkpoint — 2026-11-12

The approved runtime is implemented and has meaningful source/independent installed proofs; it is
NOT accepted/complete. See the [single final scoped-source budget proposal](../reviews/community-connectors-c5-budget-2026-11-12.md).
Current thresholds are unchanged and nine whole/five installed data overages remain recorded red.
Generation and combined merge acceptance await technical budget disposition, then current-head
public/packed/generated/hosted checks. Prior checklist boxes are not marked complete merely from
iteration tests. Source2/v2 observations, selection decisions, resume counters and original financial
facts remain canonical; no registry release or live-data acceptance is claimed.

## Measured review45c974dc and required source corrections

The coordinator approved ONLY the fourteen exact measured cap increases for fingerprint ee0784bc;
restoration Rollup14080B and all unrelated/upstream caps/settings/exclusions remain. This is not final
implementation or merge acceptance. The three reproduced corrections are now permanent controls:
query captures numeric options and immutable owned continuation/pins synchronously before scheduling;
caller-owned objects remain mutable and AbortSignal is retained. Existing general input refusals
admit only input.wrong_type/missing_field/not_finite/out_of_range/invalid_enum, rebuilt as local
InputError with SDK text, explicit validated guidance only and private cause. Unknown input.\* does
not qualify. Opt-in kit/selector compatibility uses the same bounded registered-code/own-data reader,
not SDK class identity; exact independent refusal context/correspondence is still checked. Foreign
getters/messages/toJSON/raw contexts do not become public facts. Global isQuantError is unchanged.

Initial mutation/input regressions failed7/7 before fixes, then pass; real separately installed copies
pass input/error/pre/in-flight abort/missing-volume/suspect-selector kit controls. The measured final
candidate still must fit reviewed caps and complete source-final generation/current-head hosted gates.

Final local source/packed/generator receipts: [C5 closure](../reviews/community-connectors-c5-closure-2026-11-12.md). Hosted exact-head and coordinator implementation acceptance remain open at this commit; feature in_progress.

## Continuation preflight correction (ca176773, 2026-11-12)

225c1bb FAST/FULL green and its independently accepted controls remain historical evidence. The
coordinator reproduced a raw RangeError because the owned continuation copy was made before its
existing bounded validation. The narrow correction validates the ORIGINAL continuation once through
continuationData synchronously, then canonical-copies/freezes that validated data before async
dispatch. No public shape, scanner, serializer, catch or error catalog changes. Caller ownership and
real AbortSignal remain intact. Cyclic/accessor/work-limit controls refuse as existing typed
data.invalid_response with zero source invocations; post-call limit/query/nested-pin mutations cannot
change dispatched controls. Permanent source and actual separate-installed-copy checks cover both
laws. New actual source/packs must fit unchanged reviewed caps and fresh exact-head FAST/FULL before
implementation acceptance; no merge authority.
