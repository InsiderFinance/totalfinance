# Community data connectors

[No-key first success and connector author journey](./community-connector-first-success.md).

TotalFinance's opt-in research contract lets independently maintained provider packages supply price
bars and option-chain research. Provider authors own their packages, releases and support. No
TotalFinance inclusion PR, central allowlist or listing is required. Ordinary calculations still
accept caller data and load no provider, network client or credential.

This connector contract is unreleased; registry SDK0.1.4 does not contain these subpaths.
Start with the [no-key source-checkout journey](./community-connector-first-success.md), which
builds the local SDK and an independently packed cents-based provider without internal receipts,
maintainer paths or credentials. Then use the reference connector with separately configured access.
An external provider's provisional peer version alone never proves registry compatibility.

## Fetch data and calculate

Install the SDK and your chosen connector in the same application. For this unreleased preview,
install both tested local tarballs; registry SDK 0.1.4 does not yet provide this contract.
TotalFinance binds your installed connector once, fetches a bounded window and supplies named arrays
to its existing calculations:

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

The environment variable is read by your application, never by TotalFinance. The private connector
preview defaults to the documented staging origin, native fetch and response-receipt clock;
fetch/now/baseUrl overrides remain optional. Construction and local discovery cause no HTTP reads.
Configure access and a new request allowance before real reads. The
[exact installed example](../examples/community-connector-connection.ts) is verified with synthetic
one/multiple-page HTTP facts, not a live-data receipt. There is no MCP/server/pack prerequisite.

`priceBars` returns only after terminal pagination, or throws a typed refusal. Defaults are
pageSize1000, maxPages20, maxReads21 (including one capability discovery) and maxRecords20000.
These are HOST work ceilings, not financial assumptions, provider maxima or paid request credits.
The host hard limits are10000 rows/page,100 pages,101 invoked reads and100000 records, with bounded
canonical work/bytes. Call options may lower connection ceilings. There are no automatic retries,
background reads, fallback query or cache. An exhausted window is never a partial success.

The ordinary named arrays are frozen native arrays. `closePrices` feeds existing SMA/SMA.explain.
`ohlcvBars` supplies OHLCV for VWAP; `bars` supplies canonical timestamped Bar records with actual
volume, source adjusted flags and supplied vwap. Unknown volume blocks strict OHLCV/bars only,
never zero-fills or needlessly blocks valid closes. Partial quality is not a blanket refusal.
`selections` lists these choices without evaluating lazy getters; JSON serialization is safe even
when volume is unknown. For an engine that takes ownership of a mutable array, use an ordinary copy:

```ts
const result = backtest.vectorized({ ...explicitBacktestOptions, data: [...prices.bars] });
const sampled = technicalAnalysis.resample(prices.bars, explicitInterval, explicitOptions);
```

Source pages stay in **prices.window.pages**, with every timestamp, warning, quality/coverage,
identity and basis fact. Store `prices.window` and, after any explicit decision, `prices.selection`.
`data.createPriceBarsWindowView(savedWindow, savedSelection)` restores without a provider. Terminal
paging does not certify continuous history, point-in-time availability, live liquidity or enough
rows for a chosen period. Pure engine results do not automatically inherit source metadata.

## Author a minimal source, use one common SDK normalization

The [no-key starter](../../examples/community-connectors/starter/src/index.ts) maps a genuinely
different cents-based vendor schema using public imports. The copied independent
[Alpaca-style example](../../examples/community-connectors/alpaca-style/src/index.ts) keeps actual
04Z daily timestamps and passes vendor page tokens directly. Both have their own install boundary,
lock and independently expected records/pages. Original independent review observations are unchanged.

A factory returns **DataProviderSource**, protocol `totalfinance-data-source`, contractVersion2.
`data.connect(source)` is the consumer handoff; `defineDataProvider(source)` from `/core/data` is
an advanced one-page consumer binding. Do not return a consumer wrapper from a source factory.
Construction performs no discovery/network work. The SDK owns common metadata/provenance stamping,
unknown clocks and immutable projections; the external package owns auth, HTTP, cancellation and
source mapping, with at most one vendor request per source query and no hidden retries.

The raw source implements:

```ts
capabilities(options?: DataCallOptions): Promise<readonly DataCapabilityDeclaration[]>;
query(query: DataQuery, page: DataPageOptions): Promise<SourcePriceBarsPage | SourceOptionChainPage>;
```

Every query call receives the **same original financial query** plus separate
`{limit,cursor:string|null,pins:DataPins|null,signal?}`. Authors supply actual rows and per-page
facts: dataset id/version, receipt time, adjustment, consistency and bar timestamp convention.
Dataset/basis/consistency may differ between queries; they are not global provider defaults.
Optional absent clocks/freshness/coverage remain unknown. No rates, IV, roots, multipliers or
financial adjustments are invented. Unsupported capabilities refuse explicitly.

Discovery declares finite understood intervals:1m,5m,15m,30m,1h,4h,1d,1w,1mo. Intraday bounds
are inclusive zoned instants; day/week/month bounds are inclusive session labels. Unknown safe
future tokens such as1s are ignored with counts while supported ones remain available. Malformed
known declarations still refuse. Provider ceilings may exceed host limits. InsiderFinance currently
supports daily/minute bars with its own2000-row and minute31-day restrictions; those are not
universal SDK vendor laws. Its chains remain incomplete EOD research.

Advanced `marketData.query(originalQuery,{limit,cursor?,signal?})` is one page, zero discovery.
For manual continuation pass its `view.continuation`, never construct a cursor-only financial query.
A v2 canonical page stores exact original query and provider id/version so JSON restoration can
recreate the continuation. A legacy v1 restored nonterminal page explicitly cannot reconstruct it.
All original bounds/filters/pins/identities/order and temporal conventions remain validated.
The [public fixture](../examples/community-connector-fixture.ts) and common kit use the same boundary.

## Deliberately resume failed work

```ts
try {
  await marketData.priceBars(request);
} catch (error) {
  const checkpoint = data.priceBarsCheckpoint(error);
  if (!checkpoint) throw error;
  await savePrivateCheckpoint(JSON.stringify(checkpoint));
}
// A deliberate host decision, possibly after resolving access/rate/allowance conditions:
const prices = await marketData.resumePriceBars(JSON.parse(await loadPrivateCheckpoint()));
```

Checkpoints are separate private storage, never serialized into public error text/context. They
retain validated accepted pages, original binding/query/cursor/pins, paging policy and consumed
reads/pages/records. Resume validates these before I/O, negotiates one fresh discovery and never
refetches accepted pages. Failed/aborted invoked reads remain consumed; pre-dispatch abort costs0.
Accepted zero-row nonterminal pages retain their cursor and pins. No crash-atomic or upstream
idempotency guarantee is made; a repeated failed page can incur another vendor charge.

A new connection's larger DEFAULT does not raise saved budgets. Only explicit permissible
constructor/resume increases authorize more HOST work, never provider credit. Resolved page size
stays pinned and must fit current connection/provider/hard ceilings. Automatic unresolved sizing
negotiates min(saved base1000,current connection ceiling,provider maximum). A smaller ceiling or
expired source pin can refuse; no cursor restart, hidden counter reset or new allowance is granted.

## Explicit choices for suspect finite observations

Finite contradictory OHLC is acquired unchanged with controlled `issues` (page/row/rule/fields).
A selector stops with `data.suspect_observations` only when an unresolved issue affects a field it
uses. For high<close, the SDK cannot know which operand is wrong. Valid closes with an unrelated
open-only issue stay usable. Essential identity, nonfinite required data, adjustment/filter/pin
contradictions and negative normalized option premiums remain hard refusals.

```ts
console.log(prices.issues);
const chosen = prices.resolve({ action: 'exclude', reason: 'Independent research review' });
const averages = technicalAnalysis.sma(chosen.closePrices, { period: 20 });
console.log({ averages, decisions: chosen.selection, source: chosen.window.pages });
```

`resolve({action:'use',reason})` deliberately retains questionable inputs; existing pure leaves
still enforce their own validations. `correct` requires explicit finite OHLC replacements and a
reason; it never changes raw source rows or invents volume/identity/time. Selections retain ordered
source-row correspondence and explicit decisions; exclusion does not imply continuous history or
sufficient lookback. Persist source and selection separately to revalidate/replay them on restore.

## Read the metadata before computing

A daily source timestamp can be04Z/session-start, or midnight UTC can be a **session-date label**. Keep its declared convention and explicit session label; neither is observation or availability. A minute bar's interval start
is separate from source receive/observation time. Source storage, API generation, host receipt and
first public availability are separate facts. Null means unknown; fetching now never supplies the
missing historical instant. The existing Provenance record carries only clocks actually known.

Source quality `complete` does not prove continuous historical coverage. Bounds can enclose a long
gap; missing sessions/minutes are not filled. Keep the returned source issues, observed-only
coverage and adjustment basis with any analysis. Split-only prices are not dividend-adjusted total
returns. Every protocol2 capability is research-oriented: `pointInTime: false` and
`executionEligibility: 'research-only'` grant no liquidity or trade eligibility guarantee.

An incomplete chain acquisition record is deliberately different from a complete `OptionQuote`.
It retains source IDs, missing terms, quotes, supplied Greeks and diagnostics. It does not invent
listed roots/OCC symbols, multipliers, exercise/settlement style, exact expiry or valuation time,
rates or volatility. Source model price remains separate from observed quote fields. Obtain missing
inputs independently and validate them through the existing public builders before pricing; this
contract offers no automatic pricing, market-snapshot or fill conversion.

## Verify an external package

Provider implementations import the public SDK just like any application. Keep credentials and
HTTP mappings in the independent provider package. The maintained InsiderFinance package uses this
same route; it is not an exception or an internal workspace advertised as installable.

Run the framework-independent kit against hand-authored expected pages and error/abort probes.
Pin receipt clocks, provider identity and opaque cursor constants explicitly. Test capability
truthfulness, ordering/identity within and across pages, source pins, finite/null/zero handling,
input immutability, bounded walks, cancellation, access/rate-limit errors and error redaction.
Expected metadata may differ by provider; do not erase financial, temporal or quality differences
to make a comparison pass. A kit that cannot reject one-defect provider mutants proves little.

Pack and install both SDK and provider in a clean consumer with no workspace aliases. Compile with
NodeNext and Bundler resolution, execute ordinary ESM, verify SDK QuantError identity and run the
same research workflow against fixture and HTTP implementations. The explicit local rehearsal is
`tools/community-connectors-provider-smoke.ts`; its inputs are two supplied tarballs and synthetic
tests, never credentials. Offline fixtures establish mapping behavior, not upstream deployment,
actual entitlements, historical completeness, licensed redistribution or a real-agent result.

Authentication, entitlement, throttles, exhausted allowance, snapshot expiry, cancellation and
service/data failures have distinct registered codes. Retry advice is metadata; the connector does
not issue a second request. API-01's published pagination instructions remain a separate app/API
task. API-02–05 coverage, temporal model, freshness and methodology findings remain source-qualified
limits rather than an invitation to rewrite the server or invent missing inputs.
