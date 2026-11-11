# Community data connectors

[No-key first success and connector author journey](./community-connector-first-success.md).

TotalFinance's opt-in research contract lets independently maintained provider packages supply price
bars and option-chain research. Provider authors own their packages, releases and support. No
TotalFinance inclusion PR, central allowlist or listing is required. Ordinary calculations still
accept caller data and load no provider, network client or credential.

This connector contract is unreleased; registry SDK0.1.3 does not contain these subpaths.
Start with the [no-key source-checkout journey](./community-connector-first-success.md), which
builds the local SDK and an independently packed cents-based provider without internal receipts,
maintainer paths or credentials. Then use the reference connector with separately configured access.
An external provider's provisional peer version alone never proves registry compatibility.

## Fetch data and calculate

Install the SDK and your chosen connector in the same application. For this unreleased preview,
install both tested local tarballs; registry SDK 0.1.3 does not yet provide this contract.
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

`priceBars` completes terminal pagination or refuses explicitly: default pageSize1000, maxPages20,
maxRecords20000, plus one capability-discovery call. Providers can meter discovery; InsiderFinance's
is local. These are operational call/record bounds, not financial assumptions or upstream credits.
Connection options set ceilings; per-call overrides may only lower them. A nonterminal cursor at
an exhausted ceiling throws `data.window_budget_exceeded`, never a successful truncated sample.
Manual `marketData.query` retains explicit kind/limit/cursor controls and reads exactly one page
without discovery. No retries, background reads, automatic smaller query or cursor restart.

`closePrices` is a normal frozen native array accepted by existing SMA/SMA.explain. The complete
source remains in **prices.window.pages**, preserving each page's identity, warnings, clocks,
coverage, quality and adjustment facts. Terminal pagination does not establish continuous history,
known availability, live liquidity or enough rows for your chosen period. Pure calculation results
do not automatically inherit provenance; keep the view/window when presenting research.

`prices.ohlcvBars` supplies actual OHLCV rows for existing VWAP and bar indicators. Selecting it
refuses if any row has unknown volume; known closes remain usable, including partial-quality pages.
Zero volume stays zero. No selection fetches, reads a clock, fills gaps or changes adjustment basis.
Persist/hash **prices.window**; `createPriceBarsWindowView(savedWindow)` from `/data` restores it
without a provider. Serializing the parent view does not trigger strict OHLCV selection.

The root data namespace and named `/data` exports share one SDK implementation. Provider authors'
advanced `/core/data` entry remains available for raw page types, defineDataProvider and createDataView.
Ordinary compute imports still accept caller data and contain no provider/network/credential code.

## Build a community connector

The [minimal fixture provider](../examples/community-connector-fixture.ts) imports only the public
SDK. It is a small example, not a built-in provider service or a package requiring registration.
The [synthetic facts](../examples/community-connector-facts.ts) contain no licensed responses.

Use `createFixtureDataProvider` from that example with its explicit `id`, `version`, capabilities
and request/page entries. The adjacent facts module supplies a synthetic daily request, bar and full
page metadata. Run `validateDataProvider` with named expected-page probes and explicit maxPages,
maxRecords and timeoutMs bounds. The [first-touch fixture](../../tools/first-touch/fixtures/core-data.ts)
and [installed consumer test](../../tools/community-connectors-consumer.test.ts) show the complete
working calls. Implement `DataProviderSource` with raw normalized pages, then call
`defineDataProvider(source)` directly. The SDK validates those pages and supplies the same consumer
view for every provider; connector authors implement no price projection or calculation engine.

`defineDataProvider` lives at `@insiderfinance/totalfinance/core/data`. Construction checks the
structural protocol and binds it without calling provider methods. Each call validates its request
and response; valid data is copied and deeply frozen. Control objects reject unknown keys; research
records can retain harmless JSON decoration. Nonfinite or malformed financial facts are refused,
not dropped or converted to plausible values. The independent kit inspects its supplied provider
directly and does not repair invalid output.

## Discover and query explicitly

A raw source implements `capabilities(options?)` and `query(request, options?)`, returning
Promises; options is the optional `{ signal }` control. Its capabilities return a descriptor and
its query returns a normalized `DataPage`. The public consumer uses the same direct request grammar,
but receives an SDK-owned view with `.page` and the selections appropriate to its kind.
No particular dataset is mandatory. Discovery describes supported behavior; it does not
grant account access or redistribution rights. Unsupported kinds/intervals produce
`data.unsupported_capability`; malformed known requests produce typed input errors.

Price bars require symbol, interval (`1d` or `1m`), from, to and limit. Daily bounds are inclusive real
session dates; minute bounds are inclusive zoned instants spanning at most 31 days. Chains require
symbol, an explicit latest/session/snapshot-id selector and limit, with optional expiration, right
and strike filters. Limits are bounded by both the contract and the provider. No financial value is defaulted. This low-level query never auto-pages; the higher-level
priceBars workflow alone walks a bounded window.

A continuation contains only kind, the **same symbol**, cursor and limit. The provider retains the
original filters and source pin. A cursor is opaque continuation data, not authority. Changing a
resource or losing its pinned snapshot refuses; callers must deliberately decide whether to start
a new query. Bars disclose best-effort pagination because source corrections can change later
reads. Snapshot-pinned chains retain their actual source snapshot identity. Supply an AbortSignal
for cancellation or a host deadline; there is no implicit retry, delay or cache policy.

## Read the metadata before computing

A daily bar's midnight-UTC timestamp can be a **session-date label**. A minute bar's interval start
is separate from source receive/observation time. Source storage, API generation, host receipt and
first public availability are separate facts. Null means unknown; fetching now never supplies the
missing historical instant. The existing Provenance record carries only clocks actually known.

Source quality `complete` does not prove continuous historical coverage. Bounds can enclose a long
gap; missing sessions/minutes are not filled. Keep the returned source issues, observed-only
coverage and adjustment basis with any analysis. Split-only prices are not dividend-adjusted total
returns. Every v1 capability is research-oriented: `pointInTime: false` and
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
