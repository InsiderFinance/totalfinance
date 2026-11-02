# Community connector foundation and the external InsiderFinance provider

Status: **C0 proposed for technical review; C1 not started.** Future-target API, not shipped API.
Date: 2026-11-02. Base: `d50b401ee237006c75c76ef90784e5dcde1439a3` (merged repair PR #25).
Task: `01a19da0-2a6f-7450-89a4-2e51047b05b5`.

## Outcome and authority

An independently installed package can supply bounded price-bar and option-chain research pages
through the same public contract as a small fixture provider. TotalFinance owns the contract,
framework-independent compatibility kit, documentation and example. Provider authors own their
packages, releases and support; they need no TotalFinance inclusion PR, listing or provider approval.
The maintained InsiderFinance implementation must use precisely that external path.

This implements the community ownership direction agreed on October 28, read in full from the
originating, uncommitted planning record at
`/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-61e10f/docs/specs/community-connectors-and-agent-dogfood.md`.
That checkout is read-only for this work. This spec records the decisions needed to implement its
C0/C1 lane in an independent worktree. The [queue](../implementation-order.md) owns ordering;
[alignment laws](../library-alignment-spec.md) and the current two-package publication policy apply.
The [dogfood report](../reviews/agent-dogfood-2026-10-28.md) remains original evidence, including its
November 2 amendments. The three library repairs are already merged; they are not this feature.

The broad adapter inventories in [data-layer.md](../data-layer.md) and the
[MCP/data strategy](../mcp-acceleration-data-growth-strategy.md) describe possible community coverage,
not a TotalFinance maintenance commitment or prerequisites. This spec supersedes their mandatory
`bars`, Promise-or-iterable union, required exact page `asOf`, implied built-in vendor inventory and
proposed front-door implementation for this bounded slice. The extension precedent is
[Gate C](./gate-c-extension-contracts.md): structural contracts and a runnable public kit, without
registration or a new engine.

## Non-goals and the review checkpoint

No compute redesign, provider fetch in compute, additional TotalFinance distribution package,
provider registry, marketplace, universal REST mapper, fluent client, subscription API, cache
service, hosted data store, MCP tool/App redesign, account reads or execution capability. No changes
to InsiderFinance server source, API-01's separate task, entitlements, keys or ingestion pipelines.
No release version changes, publication, remote repository creation, deployment, schedules or live
execution. Existing portfolio/journal stores and private responses are untouched.

The current task authorizes offline contract, fixture and HTTP mapping work. C0 is returned to the
coordinating chat for technical spec review before the first public implementation line, as required
by [CONTRIBUTING.md](../../CONTRIBUTING.md). Review is the next engineering checkpoint, not a new
maintainer permission request for the agreed feature. C1 can proceed after that review. Staging
verification and replacement of existing agent glue remain later, separately evidenced acceptance.

## Decision 1 — exact placement and package compatibility

| Piece                                                    | Source / public import                                                                         | Ownership and dependency                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Types, boundary validation, immutable structural wrapper | `packages/core/src/data.ts` → `@insiderfinance/totalfinance/core/data`                         | Pure L1 contract/validation; relative imports within core; no network, credentials, clock or Node imports   |
| Shared compatibility kit                                 | `packages/core/src/data-conformance.ts` → `@insiderfinance/totalfinance/core/data-conformance` | Opt-in L1 extension verification, no test framework dependency                                              |
| Synthetic fixture example                                | `docs/examples/community-connector-fixture.ts`                                                 | Public SDK imports; no new workspace/package; exercised as an installed consumer as well as in source tests |
| Contract/kit tests                                       | `packages/core/test/data.test.ts`, `packages/core/test/data-conformance.test.ts`               | Core's own tests and first-touch/contract evidence                                                          |
| Outside-consumer proof                                   | `tools/community-connectors-consumer.test.ts`                                                  | Fresh tarballs, no workspace aliases, network data forbidden                                                |
| Provider repository                                      | `/Users/agent/ri/.work/repos/totalfinance-insiderfinance-connector`                            | Separate local Git repository created in C1, not a monorepo workspace or a linked app folder                |
| Provider entry                                           | `src/index.ts` → provisional `@insiderfinance/totalfinance-connector-insiderfinance`           | Node-only independent package, no private app imports or copied app implementation                          |

Add `./data` and `./data-conformance` to core's source exports and `typesVersions`. The existing
distribution assembler derives `./core/data` and `./core/data-conformance`; synchronize through
`pnpm publication:update`, without changing any version. No root hoist, core main re-export or new
dependency edge. `packages/*` remains private; only the two existing `distribution/*` packages are
TotalFinance releases. The external connector is not added to their Changesets fixed group.

Provider provisional metadata: `version: "0.0.0"`, `private: true` as a publication guard,
`type: "module"`, `sideEffects: false`, Apache-2.0, Node `>=22.13.0`, pnpm `10.32.0`, `.nvmrc`
`22.23.2`; exports `.` with `types`, `import`, `default` pointing into `dist`, plus `./package.json`;
pack only `dist`, README, license and stability notice. No install script. Use TypeScript `NodeNext`
with ESM `.js` imports. `private` does not prevent local pack/install; this is an independently
installable package, not a third advertised TotalFinance distribution or a registry release.

Its provisional peer is exactly `@insiderfinance/totalfinance: "0.1.2"`, satisfied in this work by
the freshly assembled SDK tarball, with the same tarball as its development input. This **does not
claim registry 0.1.2 has the new subpaths**: it does not. Record SDK commit and both tarball SHA-256s
in receipts. Do not broaden peer compatibility or select a release version until publication is
separately authorized. A future published provider must name the actual released SDK containing
these exports. No remote repository URL or npm name availability is claimed.

`DATA_CONTRACT_VERSION = 1` is a protocol version, not a package release version. Descriptor and page
versions must equal 1; the wrapper/kit refuses others with `data.contract_version_unsupported`.
Provider package version and source dataset version are separate strings. Do not infer protocol
support from package SemVer, and do not use duplicated SDK error classes bundled into the provider.

## Decision 2 — one bounded query operation, capability discovery as facts

The following is the exact target request/protocol grammar. Connector-owned properties are readonly in emitted
declarations; reused canonical core types retain their existing declarations; constructors copy and deeply freeze data they own. `signal` and methods are behavior,
not serialized page data. The wrapper binds provider methods and does not freeze caller objects.

```ts
type DataKind = 'price-bars' | 'option-chain-research';

interface PriceBarsRequest {
  kind: 'price-bars';
  symbol: string;
  interval: '1d' | '1m';
  from: string;
  to: string;
  limit: number;
}

interface OptionChainResearchRequest {
  kind: 'option-chain-research';
  symbol: string;
  snapshot:
    | { kind: 'latest' }
    | { kind: 'session'; sessionDate: string }
    | { kind: 'id'; snapshotId: string };
  expirationFrom?: string;
  expirationTo?: string;
  rights?: readonly ('call' | 'put')[];
  minStrike?: number;
  maxStrike?: number;
  limit: number;
}

interface DataContinuationRequest {
  kind: DataKind;
  symbol: string;
  cursor: string;
  limit: number;
}

type DataRequest = PriceBarsRequest | OptionChainResearchRequest | DataContinuationRequest;
type DataFor<R extends DataRequest> = R['kind'] extends 'price-bars'
  ? PriceBarRecord
  : R['kind'] extends 'option-chain-research'
    ? OptionChainResearchRecord
    : PriceBarRecord | OptionChainResearchRecord;

interface DataCapability {
  kind: DataKind;
  intervals: readonly ('1d' | '1m')[];
  maxPageSize: number;
  consistency: 'snapshot' | 'best-effort';
  pointInTime: false;
  access: 'unknown' | 'granted' | 'denied';
}

interface DataCapabilities {
  contractVersion: 1;
  providerId: string;
  providerVersion: string;
  capabilities: readonly DataCapability[];
}

interface DataProvider {
  id: string;
  version: string;
  contractVersion: 1;
  capabilities(input: { signal?: AbortSignal }): Promise<DataCapabilities>;
  query<R extends DataRequest>(input: {
    request: R;
    signal?: AbortSignal;
  }): Promise<DataPage<DataFor<R>>>;
}
```

No data method is mandatory individually. An options-only provider declares only the options kind;
its `intervals` is empty. Capabilities are supported behavior, not a claim of current account access,
available symbol coverage or redistribution rights. C1 InsiderFinance discovery is local and causes
zero HTTP calls: both kinds, `1d`/`1m` bars, max 2,000, chain `snapshot`, bars `best-effort`,
`pointInTime: false`, `access: 'unknown'`. The API still authorizes each actual read. No `/account`
probe or hidden data request. An unknown future string at the query boundary is a typed unsupported
capability refusal; malformed known-kind requests use input errors. No suggested-provider allowlist.

Every control object is closed, including nested `snapshot`; continuation forbids all first-page
filters. Required strings are nonempty and bounded: symbol 128 characters, snapshot ID 2,048,
cursor 16,384. Provider-specific symbol restrictions may narrow this with an explicit error; C1 uses
the API's `[A-Z][A-Z0-9.]{0,9}` rule and never silently changes resource identity. Limits are positive
safe integers, at most 2,000 and at most the provider's declared bound. No default limit, date range,
interval, snapshot selection, adjustment fallback or financial value.

Daily `from`/`to` are real `YYYY-MM-DD` session labels, inclusive. Minute bounds are zoned ISO
instants, inclusive bar starts; require `from <= to` and at most 31 days. No timezone-free datetime
or implicit host zone. Chain date filters are real dates, ordered; strike bounds finite positive and
ordered; rights is nonempty, duplicate-free, at most two. Order is ascending timestamp for bars,
expiration/strike/call-before-put for chains. There is no generic namespaced dataset escape hatch in
v1: a future proprietary feed gets its own external interface or a reviewed contract extension.

`defineDataProvider({ provider })` is the sole structural constructor. It checks identity, versions
and method presence, validates every request and returned page, and returns an immutable bound
wrapper. Capability coherence is checked when discovery is called, not at construction. Query
validation checks the v1 hard bounds without an implicit discovery call; each provider enforces
its own narrower declared bounds, which the kit independently verifies. Construction never calls
provider methods or fetches. Discovery remains
async so a future provider can explicitly obtain remote facts, with cancellation, without changing
the signature. Neither installing nor importing a provider registers or activates it.

## Decision 3 — preserve the frozen compute types and represent research honestly

`Bar`, `OptionContract`, `OptionQuote`, `OptionQuoteGreeks`, `Provenance`, `Assumptions` and
`Diagnostics` already exist at the public `/core` entry. Do not change their requiredness or pretend
an incomplete chain is an `OptionQuote[]`. Reuse them where they mean what the source says.

```ts
interface ObservationTimes {
  observedTimestampMs: number | null;
  availableTimestampMs: number | null;
  sourceStoredTimestampMs: number | null;
}

interface PriceBarRecord {
  bar: Bar;
  sessionDate: string | null;
  timestampConvention: 'session-label-midnight-utc' | 'interval-start';
  times: ObservationTimes;
  source: string | null;
  provisional: boolean | null;
  revision: number | null;
  diagnostics: Diagnostics;
}

interface OptionResearchTerms {
  underlying: OptionContract['underlying'];
  type: OptionContract['type'];
  strike: OptionContract['strike'];
  expiry: OptionContract['expiry'];
  root: string | null;
  occSymbol: string | null;
  multiplier: number | null;
  currency: string | null;
  style: OptionContract['style'] | null;
  settlement: NonNullable<OptionContract['settlement']> | null;
  expiresAt: number | null;
  termsStatus: 'verified' | 'incomplete';
}

interface OptionChainResearchRecord {
  sourceContractId: string;
  terms: OptionResearchTerms;
  times: ObservationTimes;
  quote: Pick<
    OptionQuote,
    | 'bid'
    | 'ask'
    | 'mid'
    | 'last'
    | 'mark'
    | 'volume'
    | 'openInterest'
    | 'underlyingPrice'
    | 'impliedVolatility'
  >;
  greeks: OptionQuoteGreeks | null;
  theoreticalPrice: number | null;
  openInterestSessionDate: string | null;
  diagnostics: Diagnostics;
}
```

This is an acquisition record, not a second pricing contract. Numeric quote fields retain existing
OptionQuote units: price per underlying unit, annual decimal IV, open interest in contracts; Greek
units are the existing display units (delta per $1, gamma per $1 squared, theta per day, vega per
volatility point, rho per percentage point of rate). Gamma's abbreviated source description is
qualified by `chainSql.ts`'s explicit column semantics, not guessed from a response alone.
No IV calculation, Greek calculation, price midpoint calculation or GEX is added in the adapter.
Preserve the API's supplied rounded midpoint and theoretical price separately from observed quotes.
Null source quote/Greek members become omitted optional core fields, with field-naming diagnostics;
missing delta makes `greeks: null`, never delta zero. Unknown quote status and other source facts
survive in typed warning context, not through a raw provider response attached to the public record.

Missing or ill-typed required identity, OHLC, date, timestamp or nonfinite numeric facts refuse the
whole page as `data.invalid_response`; optional null facts remain unknown with diagnostics. Do not
silently drop malformed rows. Validate OHLC ordering (`low <= open/close <= high`), volume and open
interest nonnegative, revision a nonnegative safe integer, and positive strike/multiplier when
known. Zero bid and zero open interest are facts, not missing. Crossed quotes remain visible with
`data.crossed_market` diagnostics; they do not become a fabricated two-sided quote. Structural row
objects are open for harmless JSON decoration; consumed fields are validated and finite; config
objects are closed. The built wrapper copies/freezes outputs and the input remains untouched.

There is deliberately no automatic conversion into `OptionQuote`, market snapshot or fill. A caller
must obtain independently verified terms, expiry convention/instant, multiplier when needed,
observation time and any pricing inputs before using the existing builders/engines. Root and OCC
symbol may remain optional in a compute contract, but cannot be fabricated or reconstructed from
the terms-based provider ID. A missing rate, dividend policy or volatility is never filled by this
connector. C1's worked research workflow displays rows and projects bars into existing TA input;
the incomplete chain's pricing handoff explicitly refuses rather than claiming a successful price.

## Decision 4 — page metadata, clocks, quality and coverage

```ts
interface DataPage<T> {
  contractVersion: 1;
  kind: DataKind;
  symbol: string;
  data: readonly T[];
  nextCursor: string | null;
  provenance: Provenance;
  metadata: DataPageMetadata;
  assumptions: Assumptions;
  diagnostics: Diagnostics;
}

interface DataPageMetadata {
  datasetId: string;
  datasetVersion: string;
  snapshotId: string | null;
  sessionDate: string | null;
  sourceGeneratedTimestampMs: number | null;
  receivedTimestampMs: number;
  times: ObservationTimes;
  consistency: 'snapshot' | 'best-effort';
  freshness: {
    status:
      | 'current'
      | 'stale'
      | 'session-closed'
      | 'historical'
      | 'end-of-day'
      | 'stored'
      | 'unknown';
    configuredDelayMs: number | null;
    evaluatedTimestampMs: number | null;
  };
  coverage: {
    status: 'continuous' | 'observed-only' | 'unknown';
    start: string | null;
    end: string | null;
  };
  adjustment: 'unadjusted' | 'split' | 'split-and-dividend' | 'unknown';
  quality: {
    status: 'complete' | 'partial' | 'unavailable' | 'unknown';
    issues: readonly { source: string; code: string; message: string }[];
  };
  access: 'unknown' | 'granted' | 'denied';
  executionEligibility: 'research-only';
}
```

Page and each row keep times separately. Null explicitly means not known; it is never substituted
with session close, UTC midnight, HTTP receipt, server `generatedAt` or chain `storedAt`.
`receivedTimestampMs` is the host's fetch completion clock, not a financial observation. All epoch
fields are finite safe integer milliseconds and parsed datetimes must have a zone. Page times are
non-null only if supported for the entire represented observation; do not collapse mixed row times
to a falsely exact instant. Available time, if actually supplied, must not precede observed time.
Null availability forbids a claim of historical point-in-time safety.

Provenance reuses the existing closed type: required nonempty `provider`, `dataset`; `sourceVersion`
from dataset version, `requestId` when provided, `receivedAt` from receipt, `asOf` only for a known
exact observation instant. Do not add session dates/availability keys to `Provenance` or use it to
claim the unknown source instant. `assumptions.conventionsVersion` uses the existing constant;
no artificial rate, volatility, compounding or valuation date is added. Diagnostics reuse existing
structured `QuantWarning`/`Diagnostics`; adapter warnings receive registered stable codes in C1.
Provider quality issue codes stay namespaced source facts in `quality.issues` and warning context,
not newly invented TotalFinance error codes for every upstream string.

Register six connector warning codes in `WarningCode`: `data.unknown_times` (names the unknown clock
fields), `data.incomplete_terms` (names missing terms and any source-assumed multiplier),
`data.coverage_unverified`, `data.research_only`, `data.missing_field` (optional quote/Greek fields),
and `data.source_issue` (upstream quality/freshness facts with source code). Reuse the reserved
`data.crossed_market` code for a crossed quote diagnostic. Group repeated page limitations once per
page; put row-specific missing fields/issues in the row diagnostics, sorted by field/code and
deduplicated. Preserve source issue text as source facts while generated warnings use stable library
teaching text; no credential-bearing HTTP error details enter these warnings.

`coverage.start/end` are provider-reported bounds, never proof of continuity. C1 always reports
`observed-only` when bounds exist and `unknown` otherwise, even if upstream quality says complete.
Keep upstream quality status and issues as facts; add the coverage limitation diagnostic. No
calendar-derived continuous claim or filled missing session/minute. Empty data is legal, preserves
unknown coverage, and does not establish zero activity outside the query. Request pagination
completion means the requested pages ended, not that historical coverage was complete.

Freshness retains source status; `configuredDelaySeconds: 0` maps to zero configured delay, not
real-time. No local stale-age guess from an unknown source time. C1 maps `endOfDay` to `end-of-day`,
`sessionClosed` to `session-closed`, `stored` to `stored`; other documented values preserve meaning,
unknown statuses produce `unknown` plus a diagnostic. Every v1 page is `research-only`, even minute
bars. This is an affirmative limitation, not execution authorization. The existing separately
authorized paper broker remains responsible for its observation/availability eligibility policy.

## Decision 5 — pagination, bounds and cancellation

One `query` performs at most one upstream data request and returns at most `limit` rows; no implicit
full-chain fetch, retry, rate-limit sleep or metadata probe. Returned cursors are opaque to consumers
and include provider ID, contract version, original resource and original normalized query. C1 can
encode its own versioned JSON in base64url; this is a local continuation descriptor, not a signed
authorization credential. Strictly validate it on use, bound its size, forbid remote URL fields,
and never log upstream cursors. No mutable process cursor registry is required.

Chains carry the upstream opaque cursor without decoding/forging it. Continuation sends path symbol
**again**, `cursor` and `limit` only. The server source actually requires symbol and rejects a cursor
for another symbol. C1 also rejects a conflicting external resource before HTTP, and checks the
returned `meta.symbol` and snapshot identity across pages. Different snapshot, nonascending rows,
duplicate IDs or a repeated/nonadvancing cursor are invalid responses, never automatically restarted
from latest. API-01's published cursor-alone instruction is not repeated in examples; fixing the
server's documentation remains its separate owner.

Bars encode the original interval, symbol and upper bound plus the returned `nextFrom`; daily
continuation uses the original `to`, minute continuation must echo the returned pinned `to`.
Both must advance strictly beyond the last returned key and remain within original bounds. Bars
have no immutable snapshot pin: disclose `best-effort`, since corrections can change another page
or a replay. Do not mint a dataset snapshot identity from retrieval time. Chains preserve their
real source snapshot ID. Provider wrappers validate within-page ordering; the kit validates adjacent
pages using the original probe's expected keys and pinned facts.

The kit has explicit `maxPages` and `maxRecords` bounds. It fails instead of silently passing a
truncated walk. Ordinary callers own their own whole-query budgets; no public auto-paging helper is
added in C1. Pre-aborted discovery/query rejects before calling the provider/HTTP. In-flight
cancellation passes the exact signal to fetch, rejects `data.aborted` even if cancellation arrives
while the response body is read, and stops before another page. A late success after abort is not
conformant. No implicit timeout or retry policy; the host can supply a deadline-bound AbortSignal.

## Decision 6 — typed failures and safe context

Use the existing `InputError`, `UnsupportedError`, `ConfigurationError` and `DataError` subclasses
of `QuantError`, including existing versioned `toJSON()`. Register the following additions in core's
`ErrorCode` registry and reference them from public code (no string-only parallel taxonomy):

| Code                                | Class / meaning                                                            | InsiderFinance mapping                                                     |
| ----------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `data.unsupported_capability`       | UnsupportedError; unsupported kind/interval/PIT behavior                   | Local descriptor mismatch; upstream 422 `unsupported`                      |
| `data.contract_version_unsupported` | ConfigurationError; incompatible provider/page/cursor protocol             | Local only                                                                 |
| `data.authentication_required`      | DataError; absent/invalid credential                                       | 401 `invalid_credentials`; absent config refuses before HTTP               |
| `data.entitlement_required`         | DataError; credential lacks dataset/capability                             | 403 `capability_denied`                                                    |
| `data.rate_limited`                 | DataError; request/concurrency throttle                                    | 429 `rate_limited`, `concurrency_limited`                                  |
| `data.allowance_exhausted`          | DataError; budget is exhausted, not an automatic retry                     | 429 `allowance_exhausted`                                                  |
| `data.snapshot_expired`             | DataError; continuation cannot retain its source snapshot                  | 410 `snapshot_expired`                                                     |
| `data.invalid_cursor`               | InputError; malformed/version-compatible conflicting local cursor          | Decode, resource/filter mismatch                                           |
| `data.not_found`                    | DataError; source says resource absent                                     | 404 `not_found`                                                            |
| `data.invalid_request`              | InputError; upstream rejected an otherwise locally accepted request        | 400 `invalid_request` with safe field paths                                |
| `data.invalid_response`             | DataError; malformed/nonfinite/mismatched payload or impossible pagination | Invalid 2xx JSON/envelope; wrong symbol/snapshot; unexpected problem shape |
| `data.unavailable`                  | DataError; transport/service failure                                       | Fetch failure, 5xx; other HTTP failures with explicit status               |
| `data.aborted`                      | DataError; caller cancelled                                                | Signal aborted before/during fetch/body                                    |
| `data.nonconformant`                | DataError; supplied provider fails a named compatibility law               | Kit only                                                                   |

Malformed caller inputs continue using registered `input.*` codes (required, unknown key, wrong
type, invalid enum, nonfinite, range). Error context always names provider/kind when known;
safe optional context includes HTTP status, upstream code, request ID, field paths, `retryable`,
and nonnegative `retryAfterMs`. Auth/entitlement/allowance/snapshot/input failures are not retryable
unchanged. Throttle/service failures may be retryable; this is advice, never an automatic request.
Parse numeric `retryAfterSeconds` and numeric or HTTP-date `Retry-After` using the explicit host
clock; preserve the most conservative valid delay when both exist. No invented retry time if absent.
Redact arbitrary upstream detail, header dumps, full URLs with query, response bodies, apiKey and
cursor from errors, serialization and cause. Stable teaching text plus safe field paths suffices.
No cached response changes are introduced, and no paid connection URL is fabricated.

## Decision 7 — source-backed InsiderFinance HTTP mapping

Evidence inspected offline in linked app HEAD `b3e5ed6e848fd3e8c8a132a725a93db923556f71`.
Relevant listed paths were clean when inspected; the linked app otherwise has unrelated changes.
These paths are relative to `/Users/agent/code/insiderfinance-app`; no private code is copied here:

| Source                                                               | Contract fact and consequence                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-workers/api/src/v1/prices/operations.ts`, `prices/minuteBars.ts` | GET `/v1/prices/:symbol/bars`; 1d/1m only, 2,000 rows, inclusive bounds, ascending data, `pagination.nextFrom`; minute `pagination.to` pins upper bound                            |
| `cf-workers/api/src/v1/options/chains.ts`                            | GET `/v1/options/chains/:symbol`; limit default 500 upstream (connector always explicit), max 2,000; `asOf` session or `snapshotId`; pinned `nextCursor`; requires repeated symbol |
| `cf-workers/api/src/v1/options/chainSql.ts`                          | Row fields/units; expired contracts omitted relative to snapshot session, not request clock; rounded source IV and midpoint, theoretical price separate                            |
| `cf-workers/api/src/v1/common/instruments.ts`                        | Terms-based provisional ID, merged roots; root/symbol null; premiumMultiplier 100 is a standard assumption, not measured contract terms                                            |
| `cf-workers/api/src/v1/common/meta.ts`                               | Dataset id/version, quality status, freshness vocabulary; quality complete concerns captured population, not continuous history                                                    |
| `cf-workers/api/src/operations/executor.ts`                          | Gateway adds `meta.generatedAt`, per-caller `meta.requestId`; pagination may be absent when terminal                                                                               |
| `cf-workers/api/src/http/problem.ts`, `auth/apiKey.ts`               | RFC 9457 problem body with code/requestId/errors, retry seconds/header; Authorization Bearer                                                                                       |
| `docs/api-mcp.md`, `docs/api-v1-implementation.md`                   | Staging origin and dated EOD contract; older claim that intraday is unavailable is superseded by inspected minute source, not evidence of deployment                               |

Source evidence is not a staging deployment receipt. No new staging request was made. The earlier
developer API design's realtime/OCC claims are aspirational and conflict with actual implemented
contracts; they do not license the mapper to fabricate missing fields.

Provider factory: `createInsiderFinanceProvider({ baseUrl, apiKey, fetch, now })`. All four required;
`now: () => number` supplies receipt/deadline/error clock, `fetch` is a host-supplied standard fetch
function. Construction and discovery do not call either. No environment/keychain lookup in the
package, and credentials are not part of `DataProvider` or serialized descriptors. Require an HTTPS
origin without path/query/fragment/userinfo, set `redirect: 'error'`, and construct only the two fixed
resource paths. C1 tests inject fetch entirely in memory, so require no local server or HTTP exception.
Host example uses `https://api-staging.insiderfinance.workers.dev`, supplies its own credential and
clock explicitly, and performs no read on import. No production origin default.

Mapping rules, in addition to Decisions 2–6:

1. Daily request passes `interval=1d`, from/to/limit exactly. Each `sessionDate` maps to the existing
   Bar timestamp as midnight UTC **only as a date label** (`session-label-midnight-utc`); observation,
   availability and stored times remain null. Map symbol from validated `meta.symbol`, OHLC/volume
   verbatim, `volumeWeightedAveragePrice` → `vwap` when non-null, `adjusted: true` from split-only
   metadata. Set adjustment `split`, dividends false disclosed in quality. No exchange-close or
   total-return claim; no fake source observation time. Transaction count is not volume.
2. Minute request passes zoned bounds and interval=1m. `timestamp` → Bar interval start,
   `observedAt` → observed time (source receive time per source disclosure), source/provisional/revision
   retained, `adjusted: false`. Interval start is not observed/available time. `availableTimestampMs`
   remains null: observedAt does not establish first public availability. Preserve limited-source
   and observed-coverage issues and stored freshness. Do not claim consolidated executable liquidity.
3. Chain snapshot latest adds no pin query; session → `asOf`; id → `snapshotId`. Map expiration/rights/
   strikes to corresponding REST filters, never `asOf` as an exact instant. Preserve dataset version,
   snapshot ID/session/storedAt and null valuationAt; `spot.observedAt: null` remains unknown. Do not
   use `generatedAt` for valuation. Preserve source contract ID without claiming OCC identity.
4. Terms use underlyingSymbol/right/strike/expirationDate/currency, root/symbol → root/occSymbol.
   C1 sets multiplier/style/settlement/expiresAt null and termsStatus incomplete: the chain does not
   establish verified terms, and the optional contract-definition endpoint's standard assumptions
   do not repair them. Preserve the reported `premiumMultiplier` in a typed diagnostic context
   (`reportedMultiplier`, `status: 'source-assumed'`), never as verified normalized multiplier.
   No extra contract-definition request. Per-row quote/IV/Greeks/open interest/underlyingPrice map
   supplied finite fields only. Keep `openInterestDate` with the inferred previous-session warning.
5. `meta.generatedAt` is source generation time only, `snapshot.storedAt` is source storage time
   only, host clock supplies receipt. Daily global coverage bounds stay observed-only. Chain source
   quality complete does not erase missing terms or unknown time. Every EOD page gets a stable
   research-only warning; a contract expiring before the host date remains research history and
   cannot become live-eligible because fetched now. No inferred expiry instant at session close.
6. The four data findings stay explicit: API-02 → no continuous coverage inference; API-03 → no
   exposure/model-rate endpoint in this capability and no historical-PIT claim; API-04 → EOD/
   unknown valuation/expired-at-receipt limitations; API-05 → no flow ratio remapped or recomputed,
   with source methodologies linked in provider README rather than guessing denominator semantics.

## Decision 8 — shared proof plan and tests that can refute it

Public kit API:
`validateDataProvider({ provider, probes, maxPages, maxRecords, timeoutMs }): Promise<void>`.
Positive completion means all supplied laws passed; a broken provider throws `data.nonconformant`
with probe name, law and safe mismatch path. Invalid kit inputs use input errors. Bounds are explicit
positive safe integers (maxPages ≤ 100, maxRecords ≤ 100,000 per probe; timeoutMs ≤ 30,000 for each
discovery/query/started-latch wait). Timeouts fail the named conformance law, never approve a
truncated check. These are verification work limits, not financial-time assumptions.
The kit never discovers credentials,
fetches its own fixtures or calls unknown live resources. It is side-effecting only by executing the
caller-supplied provider/probes; construction is not behavioral verification.

Probe data is a closed union:
`{ name, kind: 'pages', request, expectedPages }`,
`{ name, kind: 'error', request, expectedCode }`, or
`{ name, kind: 'abort', request, waitUntilStarted }`.
`expectedPages` is a nonempty array of complete DataPages, including synthetic cursor/time facts;
requests begin at a first page. The kit uses nextCursor to build continuation with repeated symbol
and explicit limit. It checks exact canonical equality to every expected page, including nulls,
diagnostics, snapshot, source times and terminal cursor, not only row count or envelope shape.
Inputs and expected pages must themselves validate; malformed expectations are fixture errors.
The kit inspects the supplied provider directly, without wrapping/repairing its output. It separately
validates actual shape/finiteness/freeze, capability membership, page-size bounds,
cross-page key ordering/uniqueness, resource/snapshot consistency, no input mutation, and that the
observed page count ends exactly where expected. Volatile receipt/request IDs must be pinned by the
test host, not ignored globally by the kit. No callback comparator that can approve every output.

For abort probes `waitUntilStarted: () => Promise<void>` waits for the fixture transport's started
latch. The kit owns the controller, starts and retains the query promise, awaits that latch under
the work timeout, aborts the controller and requires that actual query to reject `data.aborted`.
A callback cannot substitute its own expected error for the provider's result. The kit also performs
the pre-aborted query itself and verifies the same behavior
for pre-aborted discovery. Fixture/injected HTTP providers supply a latch; no unreliable wall-clock
sleep or real staging cancellation is required. The exported probe union and callback signatures
are declared in `data-conformance.ts`, not inferred from test-only functions.

Use hand-authored synthetic facts, never saved licensed responses. C1 fixture/HTTP corpus:

| Case                                             | Explicit expectation                                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily 3 rows, limit 2                            | Two pages, source daily labels, original to retained, split-only basis, unknown times, observed-only coverage                                                                       |
| Daily 2000–2026 enclosing bounds with a long gap | No continuous or full-coverage claim despite upstream complete; no fabricated rows                                                                                                  |
| Minute 3 rows, limit 2                           | Pinned to retained, missing minute remains missing; source, revision, provisional, observed time distinct from interval/receipt; unknown availability                               |
| Chain 3 contracts, limit 2                       | Same dataset/snapshot/session across two pages; expiration/strike/right ordering; repeated symbol, no repeated filters on continuation                                              |
| Chain unknown terms                              | Null root/OCC/expiry instant/multiplier/style; source-assumed 100 only in diagnostic context; no default rate/IV; no auto-pricing                                                   |
| Missing/zero/crossed fields                      | Null optional source values → omitted optional normalized fields plus diagnostics; zero values retained; crossed market disclosed                                                   |
| Empty query                                      | Empty data is legal with terminal cursor, metadata and explicit coverage limits                                                                                                     |
| Invalid resource/cursor/filter/pin               | Typed local rejection before HTTP; upstream 410 mapped; replaced snapshot and nonadvancing page rejected                                                                            |
| Error matrix                                     | 401/403, each 429 code, 400/404/410/422/5xx, malformed JSON/problem, network error; stable classes/codes, sanitized context, no retries                                             |
| Malformed/lying provider                         | Wrong protocol, missing capability, NaN, mutated input, unfrozen output, false complete coverage, reordered/duplicate rows, changed snapshot, late success after abort fail the kit |
| Cancellation                                     | Pre-abort causes zero transport calls; abort during fetch and body read rejects; no page-after-abort                                                                                |
| Units/time                                       | Decimal IV and existing Greek scales unchanged; date labels not valuation instants; generated/stored/observed/received/available remain distinct                                    |

Run the **same financial and temporal facts** through the public fixture example and through the
external provider with an injected fake fetch returning source-shaped JSON. Build each provider's
exact expected pages from those common facts plus explicit provider identity/version/cursor constants;
provenance identities and opaque cursor encodings need not be equal across providers. No numeric,
time, coverage, quality or missing-term field is normalized away for comparison. The external package
owns those HTTP fixtures and request assertions. The SDK kit supplies the validation logic through
public imports; provider authors can supply their own fixtures without central inclusion.
Add deliberate one-defect mutants to prove each substantive kit law rejects a lie. Kit output alone
cannot prove actual upstream deployment, access, request charging or historical completeness.

Packed proof creates a temporary consumer outside both repositories, clears NODE_PATH, installs
fresh SDK and provider tarballs with pnpm, and copies the fixture example as consumer code.
Check strict TypeScript NodeNext and Bundler resolution, JavaScript ESM execution, `instanceof`
against the consumer's SDK QuantError, shared conformance, and the unchanged research workflow
against both providers. Inspect installed dependencies/imports for zero `workspace:`, private
aliases, app paths or absolute checkout paths. No provider dependency/secret/network fetch enters
an ordinary `/options` or `/core` browser bundle; include existing bundle-budget tests. Record actual
tarball hashes, SDK/provider commit IDs, node/pnpm and commands. A local pack is not publication.

## Ordered C1 slices and verification ownership

1. **C1.1 — public types and validated wrapper.** Core subpaths, codes and warnings, capability/
   request/page rules, immutable outputs, core tests, manifest classifications, first-touch fixtures,
   generated contract/API evidence and packed import/error proof. No credentialed implementation in
   core. Review each public callable under Laws 1/2/7/12/14/15, including interface methods and callbacks.
2. **C1.2 — shared kit and fixture example.** Implement the exact probe protocol, bounded walks,
   structural laws, cancellation and mutation refutation. First-touch probes are synthetic and
   bounded. Verify public example using packed SDK imports; no test framework in runtime exports.
3. **C1.3 — standalone provider.** Initialize only the selected local repository, implement required
   host configuration and two HTTP mappings, error matrix and cursor semantics. Synthetic HTTP tests
   and the same public kit must pass against installed SDK. Commit provider lockfile; thereafter
   install frozen. No private workspace/app import and no staging read.
4. **C1.4 — external installation and docs.** Pack/install both artifacts in a clean consumer, run
   parity/conformance, compile misuse tests, bundle checks and the worked research example. Document
   package-version limitations and missing financial facts. Update affected generator sources then
   regenerate in the documented order after all integration source changes are final.
5. **Later acceptance — staging and agent convergence.** With separately configured credentials and
   an explicitly confirmed new allowance, perform bounded read-only verification; then replace the
   agent glue against pinned inputs, preserving active store/approval authority. Keep actual agent,
   paper-journey and MCP App acceptance distinct. The prior allowance is exhausted and is not reset.

Per slice use Node 22.23.2 / pnpm 10.32.0, frozen install, focused Vitest files, scoped lint/Prettier,
typecheck and build as needed. When public/bundle source changes, include relevant first-touch,
generated-contract, installed-consumer and `tools/bundle-size/budgets.test.ts` checks. Curate manifest
rows by hand; never `manifest:update`. Run affected generation once source settles:
signature → naming → contract → enforcement → validation → API → README → llms → bundle → OpenAPI
→ docs, omitting generators with no changed inputs only with explicit recorded rationale. Verify
enforcement defective zero. No gate weakening or manual evidence editing. Hosted clean regeneration
and current-head fast PR checks own normal landing gates; full hosted checks are required for any
CI/enforcement/Node-support changes. This feature does not propose those changes. Do not merge
unrelated work onto red main. No merge is authorized for this feature by PR #25's approval.

## Existing pilot context, not a new execution policy

The original paper account started with USD 100,000; preserve its actual ledger and cash rather than
recreate or top it up. The current report supersedes its earlier token-share, USD 1,000 order and
initial weight ceilings: the latest recorded exploratory policy uses a 99% SPY target with a cash
buffer. Execution remains SPY, paper-only, long-only and without borrowing/leverage; broader ticker
research does not by itself expand the execution universe. These are the operator's existing facts,
not connector defaults or a new portfolio strategy selected by C0.

The maintainer already granted standing paper authority without per-trade confirmation. Exact
plans/snapshots still need the existing trusted grant path; an agent assertion is not a grant.
Do not reinstate per-trade prompts or initial sizing ceilings through this feature. Research cost
sensitivities/preflight allowances remain separate from the idealized broker's actually charged
costs. No current request allowance remains; later staging acceptance needs an explicitly confirmed
allowance and host credential configuration, not a reset of the consumed one. C0/C1 offline work
does not exercise or amend the standing paper policy, store, execution journal or permissions.

## Acceptance ledger

- [x] Read full Ri task and agreed direction; attach this execution to the existing in-progress task.
- [x] Confirm isolated worktree at fetched origin/main including PR #25; preserve linked checkouts.
- [x] Define public placement, provisional external package, protocol, error/time semantics and exact
      offline compatibility/HTTP proof plan against inspected source.
- [ ] C0 technical review returned and resolved by the coordinating chat.
- [ ] C1.1 public contract, runtime validation and generated/installed proofs pass.
- [ ] C1.2 fixture and shared kit pass; single-defect mutants are rejected.
- [ ] C1.3 independent provider passes the same kit and HTTP mapping/error/cancellation fixtures.
- [ ] C1.4 fresh SDK/provider packs install in a clean consumer; research workflow agrees and preserves
      incomplete terms, EOD limits, unknown time, noncontinuous coverage and provider independence.
- [ ] Separately authorized staging reads verify actual deployment/access with a bounded new allowance.
- [ ] Agent glue replaced with installed provider and pinned-input parity; actual agent journey and
      subsequent paper/MCP App acceptance recorded separately.

C0 is a reviewable proposal, not implementation or contract freeze. There is no unresolved product
choice required to start the offline slices after technical review. Publication compatibility,
live access and agent convergence retain explicit later gates rather than invented credentials,
fabricated financial terms or redundant generic approval prompts.
