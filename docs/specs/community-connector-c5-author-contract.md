# C5: author protocol, deliberate resume and research-bar quality

Status: **proposed for coordinator technical review; no C5 runtime implementation**.
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
  consistency:'snapshot'|'best-effort'}. SDK sends null pins on first call, accepted first-page
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
  DataContinuation={version:2;provider:{id,version};query:DataQuery;cursor:string;pins:DataPins}.
  View.continuation is this canonical continuation or null. SDK compares supplied financial query
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

Canonical v2 DataPage retains the existing normalized fields and meanings; adds interval for bars,
row timestampConvention stamped from page declaration, and `issues:readonly ResearchBarIssue[]`.
The common materializer validates resulting facts with common page/sequence validation. It does not
price, sort, deduplicate, repair source values or generate expected test answers. Dataset/version/
pin/adjustment/consistency still must match within a window; different independent queries may vary.
Best-effort null pins never become snapshot/PIT guarantees. Chain term/ID/premium rules stay C4.

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
positive safe integers, no guessed trading-day meaning. IF declares its actual2000 and minute31-day
restriction; independent Alpaca-style preview declares10000 and supported additional intervals.
Provider ceilings are source facts, not host limits. maxPageSize positive safe integer need not be
<= host cap. Requests never exceed min(provider ceiling, explicit host ceiling, remaining records).
Explicit impossible override refuses; omitted pageSize negotiates min(1000, provider ceiling).

Unknown capability kinds are ignored with a controlled unsupported-kind discovery note. Unknown
well-formed interval tokens matching digits+(m|h|d|w|mo) are ignored within a known kind, with a
controlled unsupported-interval note; no arbitrary text copied into warnings. Malformed known entries
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
10000 returned points and page_token, with additional timeframes. [Polygon's own client contract](https://github.closePriceom/polygon-io/client-php/blob/master/docs/Api/CryptoaggregatesApi.md)
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

Add `bars:readonly TimestampedOhlcvInput[]` on page/window views, where TimestampedOhlcvInput =
OhlcvInput & {readonly symbol:string;readonly timestampMs:number}. This strict selection requires
actual volume on every row, even though resample's TimeBar type makes volume optional and its
current engine treats absence as zero. That prevents hidden zero-filling through this convenience
path. No compute/backtest/resample validators/defaults change. Compatible existing timestamped
backtest/resample inputs accept these plain immutable native rows structurally; broader required
backtest policies/costs still come from callers. No selector performs calculation, clock or fetch.

Each view has an enumerable frozen data-property `selections:['closePrices','ohlcvBars','bars']`
and enumerable issues/selection (below). Numeric selectors remain nonenumerable lazy cached getters.
Object.keys/console inspection can discover choices without invoking strict getters. JSON enumerates
kind/page-or-window/selections/issues/selection only; unknown volume never makes serialization throw.
Canonical persistence uses page/window plus an explicitly persisted selection record, not getters.
Arrays remain native frozen Array.prototype with no Proxy or decorated metadata.

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
{version:1,kind:'price-bars-checkpoint',contractVersion:2,provider:{id,version},query:PriceBarsQuery,
pages:readonly DataPage<PriceBarRecord>[],next:DataContinuation|null,
progress:{status:'incomplete',acceptedPages:number,records:number,reads:number},
limits:{pageSize,maxPages,maxReads,maxRecords},
bytes:number}. No signal, credentials, methods, mutable counters or source error. Pins in next must
match first accepted page; next.cursor must equal last accepted nextCursor; empty pages require
next=null with an explicit initial marker `acceptedPages:0` meaning next source request is first.
Terminal page never creates an incomplete checkpoint. Seen cursors/order keys are recomputed from
retained pages, not accepted blindly as separate state. Accepted pages imply a minimum read count;
reads may exceed pages+1 after failures; within hard limits. Byte count must equal bounded canonical
page size sum. No hash is claimed to authenticate caller-edited snapshots or external read history.
The guarantee is validated represented state, not a tamper-proof ledger or crash-atomic checkpoint.

PriceBarsWindow exact v2 outer shape is {version:2,kind:'price-bars-window',contractVersion:2,
provider:{id,version},query:PriceBarsQuery,pages:readonly DataPage<PriceBarRecord>[],
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
read and checks current support against stored effective page size/pins. No accepted-page refetch.
No automatic new snapshot on expiry. Source410 remains data.snapshot_expired, with prior checkpoint.

Before invoking discovery or query, increment reads once; failed/aborted invocation remains charged
to consumed SDK work. Pre-aborted signal before invocation increments nothing. Accept a page only
after body/validation/post-await abort checks; if abort races acceptance, whichever synchronous check
runs first defines commitment. Late successes after abort are ignored. Failed unaccepted page may
be requested again only by explicit resume; vendor may have charged twice. No server idempotency or
identical best-effort retry promise. Invalid page after a successful upstream read consumes a read
but is not accepted. Do not continue automatically after invalid data. Query attempts are sequential.

At budget exhaustion refuse before another call and retain checkpoint. Resume preserves consumed
reads/accepted pages/records, never resets. Default reuse of spent limits refuses before I/O when
there is insufficient room for discovery plus another query. Raising host limits must be explicit
through a new connection ceiling and/or permitted call override (never above connection or hard
caps); increases don't reset counters, don't alter prior query/page size or grant vendor allowance.
No increased allowance inferred from time, provider identity, new signal or creating a new connection.
Other retryable failures similarly require host's explicit budget/access decision. No background
jobs, retry scheduler, cache or generic page-job abstraction.

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
{action:'exclude'|'use';rows?:readonly RowRef[];reason:string} OR
{action:'correct';corrections:readonly {row:RowRef;values:Partial<Pick<Bar,'open'|'high'|'low'|'close'>>}[];
reason:string}. RowRef={pageIndex:number;rowIndex:number}; page views require pageIndex0. Omitted
rows means all currently unresolved suspect rows, never clean rows; explicit rows must identify
existing issues. reason nonblank <=512 characters is caller-owned research text, never error text.
No zero-filling or invented correction. Correct action requires at least one finite explicit OHLC
replacement per row, revalidates complete resulting OHLC inequalities, and refuses if still suspect.
Cannot change identity/time/volume/adjustment/dataset/terms or manufacture missing volume here.
Empty/duplicate/conflicting row choices and repeated resolution of a resolved row refuse.

resolve returns a NEW view with same immutable original page/window, generated native arrays and a
canonical `selection` record {version:1,decisions:readonly ResearchBarChoice[],sourceRows:readonly RowRef[]}
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
- [ ] Coordinator technical review of this concrete C5 contract; no runtime/signature changes before it.
- [ ] Source protocol/common normalization/finite negotiation, pre-read misuse rejection; migrate IF
      in separate provider worktree from29b02e0, no remote. Keep all83 original behaviors/corpus,
      migrating signatures, and a copied independent Alpaca-style author (original unchanged).
- [ ] Cross-copy safe errors/teaching/network classification and every C4 diagnostic/redaction law.
- [ ] Native timestamped selections/serialization and source04Z/session facts; unchanged engine parity.
- [ ] Explicit checkpoint/resume with failure accounting and separate private storage; independent
      rate-limit page3, discovery failure, record/page/read exhaustion, pre/in-flight/body abort,
      expired pin and malformed restore mutants. No accepted read repeats, skips or duplicates;
      explicit increased budget vs hidden-reset/allowance refusal, best-effort uncertainty disclosed.
- [ ] Suspect OHLC acquisition, field-intersection STOP, exclusion/use/correction and replay/storage;
      partial/empty/zero/missing-volume, clean source and immutable decisions/correspondence mutants.
- [ ] Fresh independently packed SDK/IF/starter/Alpaca-style consumers, strict no-assertion author and
      readonly consumer NodeNext/Bundler; shared independent oracle, one/three-page119.5,103/102/101.5,
      SMA.explain/VWAP/backtest/resample structural parity and no-key guide executed verbatim.
- [ ] Final concrete baseline/candidate whole+installed min/gzip/retained graphs and repeated bytes.
      All C4 caps stay until technical measurement review; no shared optimization or settings edits.
- [ ] Source-final affected ordered generators (signature→naming→contract→enforcement→validation→API→
      README→LLM→reference/bundle→OpenAPI→docs), zero measured defects/truthful joined counters,
      public/first-touch/API/types/scoped lint+format/full existing packed/whole/browser/guard gates.
- [ ] Reviewable SDK/provider commits, fast-forward SAME draftPR26 only after local gates; fresh
      exact-head FAST+FULL hosted runs, no post-green commit without rerun. Feature stays in_progress.

Node22.23.2/pnpm10.32.0 frozen installs. No C5 runtime, MCP/App/agent glue or connected acceptance
claimed by this spec. No merge/publication/new release version/deployment/provider remote/API-server
edits/staging/secret/allowance/key/grant/account/paper/recurring/live operations. No unresolved
external product choice is deferred: defaults, semantics and choices above are concrete review
proposals, not claims the maintainer already endorsed unseen details.

Precision: DataCapabilityDeclaration uses bounded string kind/interval tokens on the raw wire, so
future entries can be represented without TypeScript assertions. The understood DataCapabilities
consumer result has contractVersion2/providerId/providerVersion, validated known capability records
and ignored:{kinds:number,intervals:number}; no future payload is forwarded. Known consistency modes
must match each query's actual per-page facts. Snapshot mode requires a non-null real source pin.
Page issues use pageIndex0 at one-page scope; window issues copy controlled issue records with actual
page index without altering retained page facts. Selection defaults to version1/empty decisions/all
sourceRows; the window retains original pages regardless of selection. New source protocol is
rejected by old SDKs; restore supports old v1 under old laws without quietly migrating financial facts.
Public types named here belong to data-types.ts; normalization/negotiation stay data-validation/data.ts,
selectors data-view, window/checkpoint work data-connection (a narrow checkpoint module if needed).
Public errors/codes use the existing core registry and opt-in data error boundary, no registry rewrite.
