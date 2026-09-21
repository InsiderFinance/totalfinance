# The data layer — design & plan (`@totalfinance/data` + `@totalfinance/adapter-*`)

> **Status: designed, not yet built — deliberately deferred.** The compute library (phases 0–6) is
> complete and takes data as plain arguments. This document is the standing design for the data
> layer so it can be picked up later without re-deriving intent. It expands spec §13 and the data
> items in [`roadmap.md`](./roadmap.md). Nothing here is implemented yet.
> [`implementation-order.md`](./implementation-order.md) controls when it starts. The later
> [`MCP/data strategy`](./mcp-acceleration-data-growth-strategy.md) controls where it deliberately
> revises this early design, including capability discovery, separate query/subscription contracts,
> normalized result metadata, handles, and first-party data.
> The [Phase 3B.N naming specification](./specs/phase-3b-public-naming-normalization.md) controls
> every future package, method, field, parameter, schema, artifact, and MCP name. The target examples
> in this document use that canonical vocabulary. Do not reintroduce a shorter pre-normalization
> spelling when implementing them.
> The accepted
> [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
> now owns the compute-facing fundamental, event, foreign-exchange, commodity, portfolio, and
> point-in-time contracts. The data stage normalizes into those frozen contracts; it does not redesign
> them or move their calculations into providers.
>
> Why deferred: the fluent front-door API (`createTotalFinance(...).options.chain(...)...`) should be
> _felt_ against the finished compute surface — and the docs site should exist — before it hardens
> into a public contract. Building the finance-tool surface (options backtesting, P&L explain, etc.)
> first also tells us exactly which data shapes the layer must serve.

## The thesis: bring-your-own-data, always

The core never fetches. Data arrives as the normalized types already defined in `@totalfinance/core`
(`Bar`, `Quote`, `Trade`, `OptionQuote`, `OptionTrade`, `Dividend`, `CorporateAction`, `RateCurve`).
Every compute package operates on those types and knows nothing about where they came from. The data
layer is an **optional** set of packages that _produce_ those types; no compute package will ever
depend on it (the dependency rule in spec §3 forbids the upward edge).

Two hard laws carry over from the spec and must never bend:

1. **Security law (§13).** No compute or core package accepts an API key. Ever. Production web apps
   route credentialed data through their own backend; the browser packages consume already-fetched
   JSON. There is no `chainFromProvider('AAPL', { apiKey })` in any browser-safe package — by design.
   Vendor adapters that hold credentials are Node-only, opt-in, and live in their own packages.
2. **Provenance law (§13).** When data carries source metadata, results propagate it — a computed
   value can always answer "where did the inputs come from, and as of when."

## The common market-data provider interface (spec §13)

One interface covers ordinary market time-series data, with every method optional except `bars`, so
an adapter implements only what its source offers:

```ts
interface MarketDataProvider {
  bars(request: BarsRequest): Promise<Bar[]> | AsyncIterable<Bar>;
  quotes?(request: QuotesRequest): Promise<Quote[]> | AsyncIterable<Quote>;
  trades?(request: TradesRequest): Promise<Trade[]> | AsyncIterable<Trade>;
  optionChain?(request: OptionChainRequest): Promise<OptionQuote[]>;
  optionChainSeries?(request: OptionChainSeriesRequest): AsyncIterable<ChainSnapshot>; // NEW — see below
  optionTrades?(request: OptionTradesRequest): Promise<OptionTrade[]> | AsyncIterable<OptionTrade>;
  dividends?(request: DividendsRequest): Promise<Dividend[]>;
  corporateActions?(request: CorporateActionsRequest): Promise<CorporateAction[]>;
  riskFreeCurve?(request: CurveRequest): Promise<RateCurve>;
}
```

**Addition the finance-tool work surfaces:** `optionChainSeries` — a _time series_ of dated option
chains (`ChainSnapshot = { asOf: EpochMs; underlyingPrice: number; quotes: OptionQuote[] }`). Options
backtesting (roadmap §1.2) is the first consumer that needs history, not a single snapshot, so the
provider interface grows this one method. It is designed here so the adapter contract is known before
any adapter is written; the compute side (the options-backtest engine) already accepts an
`AsyncIterable<ChainSnapshot>` directly, so it works today with a hand-built iterable and gains a
provider source for free when the layer lands.

### Additional finance/research data capabilities

FC0–FC8 add normalized compute inputs that this early interface did not know about. The data stage
must add capability-specific provider interfaces or namespaced dataset-catalog entries for:

- typed financial statements, filing/revision identity, and point-in-time
  `availableTimestampMs`;
- company and economic events with announcement/effective timestamps;
- historical universe/benchmark membership and delisting outcomes;
- foreign-exchange spot, forward points/curves, fixings, and currency metadata; and
- commodity spot/futures curves plus explicit grade, location, unit, storage, and contract metadata.

Do **not** bolt every one of these methods onto `MarketDataProvider`. FC0–FC8 freeze the normalized
compute contracts first; Stage 6 then assigns coherent provider capabilities and runs them through
one data-layer conformance kit. SEC/XBRL tags and vendor-specific fields remain raw edge payloads
until an explicit mapping produces the typed valuation/research records.

## The front-door (`createTotalFinance`) and the fluent chain API

The `totalfinance` umbrella gains an optional front-door that binds a provider once and exposes
data-aware helpers. Compute stays pure; only this thin front-door touches the provider.

```ts
const totalfinanceClient = createTotalFinance({ data: someProvider });

// pull normalized data
const chain = await totalfinanceClient.data.optionChain({
  underlying: 'SPY',
  expiry: '2026-07-17',
});

// fluent chain pipeline: fill market → solve implied volatility → greeks → rows
const rows = totalfinanceClient.options
  .chain(chain)
  .withMarketFromData() // pulls spot + risk-free from the bound provider
  .impliedVolatility() // solve implied volatility per contract
  .greeks() // first-order greeks per contract
  .toRows(); // flat, table-ready
```

The chain builder is a lazy pipeline over `@totalfinance/options` batch APIs (the columnar
`blackScholes*Many` functions were built for exactly this). Each stage is pure and testable; the
provider is only touched by `withMarketFromData()`.

## Adapter packages — tiered, isomorphic first

Concrete providers ship as **separate optional packages** so none affects core bundle size:

| Tier            | Packages                                                                                                                                                           | Runtime           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Isomorphic      | `adapter-memory`, `adapter-csv`, `adapter-json`, `adapter-arrow`                                                                                                   | browser + node    |
| Server datasets | `adapter-parquet`, `adapter-sqlite`, `adapter-duckdb`, `adapter-postgres`                                                                                          | node              |
| Transports      | `adapter-rest` (generic), `adapter-ws` (generic)                                                                                                                   | isomorphic / node |
| Caches          | `cache-memory`, `cache-file`, `cache-redis`                                                                                                                        | per-tier          |
| Vendors         | `adapter-polygon`, `adapter-alpaca`, `adapter-databento`, `adapter-ibkr`, `adapter-fred`, `adapter-sec`, … — **their own repos/packages, credentialed, node-only** | node              |

**The flagship: `adapter-insiderfinance`.** The InsiderFinance flow / chain / GEX platform becomes a
first-class provider (`optionChain`, `optionChainSeries`, `trades`, and the structure feeds). This is
where the library dogfoods the product — the same normalized types the compute packages consume,
served from the platform you already run.

## Provenance propagation

When an input carries source metadata, every result derived from it carries it forward:

```ts
{
  value: 1.23,
  provenance: { provider: 'insiderfinance', dataset: 'opra-options', asOf: 1750000000000 },
  assumptions: { /* … the existing envelope … */ },
}
```

Provenance rides _alongside_ the existing `{ value, assumptions, diagnostics }` envelope — it does not
replace it. A result with no data-layer origin simply omits `provenance` (the compute packages never
synthesize it).

## Quality & normalization

The layer normalizes vendor quirks into the core types and scores what it cannot fix:

- **Normalization** — symbology (OCC/OSI ↔ the core `OptionContract`), timestamp units, price scaling,
  timezone-correct session boundaries (reusing the calendars package).
- **Quality flags** — crossed/locked NBBO, stale quotes, zero-bid, missing greeks, gaps in a series
  — surfaced as diagnostics on the normalized data so downstream compute can warn honestly (the
  `data.crossed_market` / `data.stale_quote` codes are already reserved in the core `ErrorCode`
  table for exactly this).

## MCP data handles (pairs with the hosted-MCP work)

Once the layer exists, the MCP server stops routing thousands of rows through the model's context:

- Local dataset handles (CSV / file / user adapter) and, later, hosted authenticated handles.
- Tools take a **dataset/resource ID**; the server resolves rows server-side. This lifts the 64 KB /
  context-cost ceiling on chains and histories that the July-2026 MCP review flagged.
- Every result keeps source + timestamp + version + transformation provenance.
- The aspirational `screen-options-chain` MCP prompt becomes real (it currently assumes a chain the
  server cannot fetch).

See [`roadmap.md`](./roadmap.md) → "Hosting the MCP" and "Data handles for the MCP."

## Sequencing (when to build)

1. **Before this document starts:** complete Wave 6, Phase 3B, FC0–FC9, the compute-only platform
   spine, and Phase 4 shipping in [`implementation-order.md`](./implementation-order.md).
2. **Data-contract freeze:** reconcile this early design with the later MCP/data strategy; define
   capabilities, query versus subscribe, normalized results, provenance/quality/freshness, paging,
   cancellation, and entitlement errors against the frozen market/artifact types.
3. **Reference and first-party paths:** memory/fixture and isomorphic file adapters plus the
   InsiderFinance adapter, all against one conformance kit.
4. **Then:** data handles and high-value workflows; server/vendor adapters and authenticated hosted
   operation follow only with their security, licensing, and tenancy gates.

## Open questions to resolve before building

- **Streaming vs. batch return** — every method allows `Promise<T[]> | AsyncIterable<T>`. Do we
  standardize on async iterables everywhere (uniform, back-pressure-friendly) or keep both?
- **Request shape — settled.** Every public provider method takes one semantic request object. This
  is forward-compatible and follows the library's S1 input-object grammar.
- **Cache key derivation** — deterministic hashing of `(method, request)`; where provenance fits in
  the key so a cache hit still reports the original source.
- **Chain-series granularity** — EOD snapshots first (the common backtest case); intraday is an
  adapter capability flag, not a core requirement.

---

_This is a living design doc; it graduates into `totalfinance-spec.md` §13 workstreams when the layer is
scheduled for build._
