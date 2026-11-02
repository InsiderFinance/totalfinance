# Community connector C2: SDK-first consumer rework

Status: **provisional SDK-first review candidate; no C2 runtime implementation approved or started.**
Date: 2026-11-02. Feature task: `01a19da0-2a6f-7450-89a4-2e51047b05b5`.
Required request: `50853bf4-78d3-8bac-bcc9-9d358fb94ff6`.
Controlling later steering: `f34544c7-0432-8fbe-9464-9df4e5da2e12` and
`941bb23d-461d-87e7-88b3-2cd29fbc2c4a`.
Execution: `01a19da1-1351-7b84-b67f-58bc81698fb5` (existing feature execution remains linked).

## Outcome and review boundary

A connector supplies normalized inputs to existing TotalFinance calculations. An ordinary SDK user
must be able to configure a key, acquire a bounded sample and calculate from it without MCP/server/
pack registration or provider-specific field mapping. The primary checkpoint is the short SDK
example below, not another infrastructure layer. C1 source/CI acceptance is not consumer acceptance;
PR26 stays draft pending this review.

The maintainer's later feedback supersedes the earlier request to freeze a full host/async design
now. This document makes a concrete minimal SDK proposal for review and records the optional host
requirements separately. It does not declare an async runtime necessary for lovability. The
coordinator is resolving the product promise with the maintainer; these proposed signatures are
not already available or approved. Revise them before implementing if that discussion changes the
expected experience. Do not defend a poor unreleased API merely because it passed technical gates.

The [C0/C1 spec](./community-connector-foundation.md) still controls financial types, source clocks,
paging, validation, quality and community ownership. C2 proposes changing poor unreleased call
shapes rather than preserving them with aliases or building a large client facade. No provider
implementation/credential is imported into core/root/browser compute. No financial algorithm,
indicator grammar, portfolio accounting or paper approval policy changes.

## Three paths, kept explicit

| Audience                | Interaction                                                                                 | C1 state                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Provider author         | Implement the normalized capability/query protocol and pass the public kit                  | Reviewed source and offline compatibility proofs exist                               |
| SDK user                | Fetch normalized data; project shared input shapes; call an existing calculation            | Works with generic query plus manual projection; this is the friction C2 must repair |
| Optional agent/MCP host | Configure the same SDK path once, offer acquisition tools and keep large samples in handles | Not implemented by C1; not a prerequisite for SDK use                                |

A second import such as sma selects the calculation the user wants. It does not mean the connector
is unconnected: the value returned by acquisition becomes that function's input. A provider does
not need its own copy of sma, and a pure sma call does not need a configured provider. The same
engine continues to accept arrays loaded from a file, another provider or caller-owned data.

## Baseline and isolation

Reviewed SDK head: `b5c3c83fbeb9197dde9714cfeee9b8fb2e960083`, draft PR26.
Reviewed external provider: `c492d2d15a1aeeb0ba2104fe55066d017bf66474`, private/provisional 0.0.0,
local repository `/Users/agent/ri/.work/repos/totalfinance-insiderfinance-connector`, no remote.
Neither reviewed tree is edited here. This worktree is
`/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c2-addendum`, branch
`totalfinance/community-connector-c2-spec`, based exactly on that SDK head.

C1 [fast CI](https://github.com/InsiderFinance/totalfinance/actions/runs/41523330653) passed eight jobs
(coverage skipped); [full CI](https://github.com/InsiderFinance/totalfinance/actions/runs/41523446543)
passed all 23. The [C1 record](../reviews/community-connectors-c1-2026-11-02.md) and Ri task preserve
source corrections, independent review, tarball hashes and installed proofs. These receipts certify
C1 technical behavior, not this unimplemented SDK experience or connected-agent acceptance.

## Decision 1 — proposed normal-use factory and infrastructure overrides

Recommend one direct credential argument:

```ts
// Proposed C2; this spelling is not accepted by C1.
const provider = createInsiderFinanceProvider(apiKey);
```

Target external signature: `createInsiderFinanceProvider(apiKey: string, overrides?: InsiderFinanceProviderOptions): DataProvider`.
Options are the closed optional fields baseUrl, fetch and now. Do not retain the old config-object
spelling as an alias. The earlier `{ apiKey }` request is recorded as superseded for this review
candidate by the subsequent instruction to reassess sole-value wrappers. A single credential is
not a financially confusable scalar group; named financial query/parameter inputs remain objects.
The coordinator must accept this revised signature before implementation.

For this private 0.0.0 preview, omitted baseUrl selects exactly
`https://api-staging.insiderfinance.workers.dev`. This is a documented staging preview default,
not a production endpoint, deployment change, live data receipt or grant to read. Production
default selection belongs to a separately authorized release. No environment guessing from a key,
fallback origin, key discovery or constructor request is allowed.

Omitted fetch captures/binds native global fetch; omitted now supplies deferred Date.now. Both
remain overridable for synthetic tests and custom hosts. No normal example mentions now. Its only
uses remain response-receipt time and HTTP-date retry-delay evaluation. It never supplies source
observation, availability, valuation, bar time, expiry, rate or volatility. Construction and local
InsiderFinance discovery perform zero HTTP calls and zero clock reads.

Only undefined means omission. Explicit null/wrong-type fetch/now, invalid clock return values,
empty URL or non-HTTPS/userinfo/path/query/fragment origins refuse with existing typed input errors.
A missing native fetch without override uses ConfigurationError with registered input.missing_field
and safe field context. A blank/non-string key retains the explicit data.authentication_required
refusal without its value in context. Redirect refusal and C1 safe error mapping remain unchanged.
No implicit retry, timeout, allowance reset or grant change accompanies these defaults.

## Decision 2 — revise the generic query once, without a second facade

Recommend the direct object request `provider.query(request, options?)` instead of
`provider.query({ request, signal? })`. Keep the existing named DataRequest fields and all bounds.
Options is the closed optional `{ signal?: AbortSignal }`; its presence represents a genuine
behavioral option, not a required wrapper. Discovery remains `provider.capabilities(options?)`
with options optional rather than requiring an empty object. No duplicated named price-bars API,
universal client, provider-bound calculation methods or alternate indicator parameters are added.

Provider implementers, defineDataProvider, the kit, fixture, external provider and packed examples
change together. There is exactly one query implementation. No C1 aliases/overloads survive just
for compatibility with an unreleased interface. This is a reviewed C2 source API break; it does not
change normalized DataPage fields, financial/time semantics or DATA_CONTRACT_VERSION 1. That
constant describes the research-data protocol, not calling-syntax SemVer. Package versions remain
unchanged in this local preview, and fresh exact tarball compatibility must be recorded.

Requests still require symbol, explicit interval/from/to/limit or chain snapshot/filter inputs.
There is no default symbol, lookback, sampling interval, as-of time, page limit or financial input.
One query returns one page and performs at most one upstream data request; it does not silently
retry, cache, auto-page or convert EOD research into current liquidity. A continuation still repeats
resource identity, cursor and limit, with the corrected retained original filters/pins enforced.

## Decision 3 — shared projections, existing calculation, visible source

The following is the proposed SDK-first review example. It must become a runnable installed
synthetic example after technical review; it is not claimed to run against C1 today:

```ts
import { createInsiderFinanceProvider } from '@insiderfinance/totalfinance-connector-insiderfinance';
import { closePrices } from '@insiderfinance/totalfinance/core/data';
import { sma } from '@insiderfinance/totalfinance/technical-analysis';

const provider = createInsiderFinanceProvider(apiKey);
const page = await provider.query({
  kind: 'price-bars',
  symbol: 'SPY',
  interval: '1d',
  from: '2026-10-26',
  to: '2026-10-28',
  limit: 100,
});
const prices = closePrices(page);
const research = {
  calculation: sma.explain(prices.values, { period: 2 }),
  source: prices.source,
};
```

The sample dates/prices are synthetic facts. The ordinary API example includes no MCP, packs,
clock/fetch injection or provider-specific mapping. The output explicitly keeps the existing
calculation explain result and its source together; neither engine diagnostics nor source warnings
are hidden or overwritten. It is ordinary JavaScript composition, not a new calculation wrapper.
No public helper wraps sma, reimplements its math or attaches all indicators to a data client.

Two strict, provider-neutral projection functions are proposed in the existing opt-in /core/data
entry, not a new distribution or core/root re-export:

- closePrices(page): `{ readonly values: readonly number[]; readonly source: DataPage<PriceBarRecord> }`.
  Copies the actual closes in page order; accepts known zero values. No price calculation.
- ohlcvBars(page): `{ readonly values: readonly OhlcvInput[]; readonly source: DataPage<PriceBarRecord> }`.
  OhlcvInput has required finite open/high/low/close/volume, with nonnegative volume; it is structurally
  usable by existing BarInput consumers. No dependency on technical-analysis is introduced in core.

Both take a single research page directly, without a sole-value object wrapper. All returned data
is immutable. source is the validated, frozen complete original page (same source identity, clocks,
provenance, metadata, assumptions and page/row diagnostics), never a fabricated observation or a
lossy flattened summary. It need not be copied again when already safely owned. The projection
values correspond exactly to source.data and cannot be sorted/truncated/filled independently.

The second concrete calculation example uses the same acquired page and existing VWAP:

```ts
// Proposed C2 shared projection, existing TotalFinance calculation.
const bars = ohlcvBars(page);
const research = {
  calculation: vwap.explain(bars.values),
  source: bars.source,
};
```

The application imports existing vwap from technical-analysis. Missing volume on any row refuses
with InputError input.missing_field before any indicator runs; context names the row/field without
secret data. Volume zero is preserved. This check matters because current VWAP/OBV leaves use
`bar.volume ?? 0`; an acquired-data projection must not turn an unknown financial input into that
implicit assumption. closePrices can still project known closes from a page with unknown volume;
it does not claim those values are suitable for a volume-based indicator. Missing OHLC or nonfinite
source data is already a C1 invalid-response refusal and stays one. No forward filling, conversion
of unknown to zero, guessed adjustment or override of financial requirements is offered.

The current public barsFromColumns and columnsFromBars converters remain usable for caller-owned
canonical arrays. They do not unwrap research pages or preserve their metadata. columnsFromBars
selects columns from the first row, so it cannot prove mixed acquired rows have volume. The
framework's closes helper is not exported from the public technical-analysis entry. These findings
justify two small strict projections, not a new engine/client or a whole per-indicator requirement
registry. Existing Bar and BarInput contracts remain unchanged.

Both projections revalidate stored/serialized page structure, rows, clocks, metadata and within-page
ordering through shared private C1 validator components extracted from pageData as needed. They
cannot verify an original query that was not supplied, and must not invent one; query bounds/pins
remain the query wrapper/provider responsibility. A malformed page uses data.invalid_response, a
wrong protocol version uses data.contract_version_unsupported, and a non-price page uses
data.unsupported_capability. Do not duplicate financial validation in a transport. Refuse an empty
sample, source quality partial/unavailable,
or non-null nextCursor with registered `data.incomplete_page` (DataError, safe reason context).
Do not silently calculate the first page and describe it as the requested history. No partial-data
bypass is added. A terminal continuation alone can represent only that page's sample: source keeps
the original facts, and no helper/summary calls any terminal page complete history. Page status
cannot establish calendar continuity or recover earlier pages that the caller did not supply.
General multi-page assembly is outside this minimal checkpoint; no auto-paging framework is added.

Unknown/observed-only coverage, adjustment, freshness and source clock warnings remain in source.
A terminal cursor only means pagination ended. Daily midnight is still a date label, minute start
is not observation, and unknown availability still prevents a PIT guarantee. Results describe an
indicator over supplied observations, not a total-return series or an executable quote. Warmup and
indicator parameter defaults remain the existing explicit engine conventions, not provider defaults.
Chains remain option-chain research records; no projection manufactures roots/OCC, multipliers,
rate, volatility, exact expiry/valuation or market/fill inputs.

The product review must decide whether this short explicit acquisition/projection/calculation path
meets the expected experience. If the maintainer wants one specific composed workflow instead,
revise this unreleased proposal around that demonstrated workflow before implementation. Do not
add an all-purpose facade to avoid asking what should happen to actual data and diagnostics.

## Current versus proposed contract impact

| Surface                     | C1 today                                                       | Proposed SDK-first rework                                                  |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Factory                     | All of baseUrl/apiKey/fetch/now required in config object      | Direct apiKey; optional infrastructure overrides; staging preview default  |
| Query                       | query({ request, signal? })                                    | query(request, { signal? }?)                                               |
| Discovery                   | capabilities({})                                               | capabilities() or capabilities({ signal })                                 |
| Price-to-calculation bridge | Manual page.data.map(row => row.bar.close)                     | Strict shared closePrices/ohlcvBars; complete source retained              |
| Calculations                | Existing sma/vwap/etc accept caller data                       | Same functions, imports, registry, parameters and numeric behavior         |
| Financial/data protocol     | C1 v1 normalized rows/pages, explicit unknowns, one-page reads | Unchanged; projection rejects unsuitable input rather than repair it       |
| Host/agent                  | No acquisition registration                                    | Still not implied by this SDK slice; optional orchestration follows review |

The current installed C1 rehearsal already proves direct manually projected closes -> existing SMA
101.5 on shared synthetic fixture/HTTP facts. That is baseline calculation proof, not acceptance of
C1 ceremony. The new example must be proved without that manual provider-specific mapping and with
source diagnostics preserved. No new call shape/projection is advertised as currently implemented.

## Optional host continuation, deliberately not this checkpoint

The preceding proposal of createTotalFinanceMcpServer({ artifacts: host.artifacts,
dataProvider: provider }) remains a candidate host convenience, not the primary SDK setup. It
would bind one provider-neutral operation pack; advanced callers could compose dataPack explicitly.
Preserve exact tools/packs selection: convenience with either explicit tools or packs, even empty,
refuses a registration conflict; profile plus convenience explicitly selects profile + data.
Multiple bound data packs/providers or duplicate ids refuse. No provider calls occur at registration.
Explicit writable artifact storage, credentials and request allowance stay with the host.

That later slice should reuse the accepted SDK projections and source metadata with versioned
research-page report handles, not introduce another normalization/calculation implementation.
Trace dynamic capabilities -> one explicit page query -> validated content-addressed handle ->
existing technical_analysis.calculate. Tool discovery must distinguish configured provider identity
from queried access/coverage facts. No request/cost should be hidden by discovery or startup.

Existing operations/runOperation/registry.run/tool.run are synchronous. An async MCP callback does
not make them awaitable. If that host slice is approved, a separate technical design must preserve
sync return/throw behavior and extract shared prepare/finalize logic rather than duplicate schema,
budget, handle, envelope or error handling. Pre/in-flight/body abort and configured deadlines need
a real AbortSignal and rejection of late success before storage. Metered reads remain host-owned;
no retry/refill/account probe or new execution capability. Workers reconstruct built-in profiles
and cannot recover provider closures; acquisition must not be submitted to them or serialize keys.
This is an identified dependency for optional orchestration, not permission to implement an async
runtime now. Its precise public types/transport rollout remain deferred until SDK review resolves.

## Ownership and ordered review/implementation slices

1. **C2.0, this checkpoint:** review the concrete short SDK example and source/missing-field behavior.
   The coordinator confirms/revises the direct-key/direct-query grammar and two projections with the
   maintainer. This draft stays provisional until that product and technical review occurs.
2. **C2.1, only after review:** separate isolated provider branch/worktree for factory/query rework;
   SDK core/data wrapper/kit/fixture changes and pure projections on a separate SDK branch. No new
   provider remote or distribution package. Keep private app implementation out of these modules.
3. **C2.2:** public-consumer working example, proof matrix and truthful documentation. Freeze the
   accepted consumer experience before planning optional agent/MCP integration against it.
4. **Later optional host addendum:** dataProvider convenience, advanced dataPack, async shared runtime,
   one-page versioned handles and existing TA operation handoff. Review first; no runtime work now.
5. **Later connected acceptance:** separately configured access/new confirmed allowance, staging,
   installed-agent parity and actual agent/paper/App evidence. Never infer these from synthetic tests.

The SDK owns the protocol wrapper, two pure projections and kit. The external repository owns
credential/default-host/fetch implementation and HTTP mapping. The consuming app owns display of
source/calculation diagnostics and its allowance. MCP/workflow owners compose the same accepted
path later. No library-level global provider, central inclusion approval or remote installation.

## Targeted proof plan and exit checks

All runtime checks below are planned; none are claimed passed for unimplemented C2:

- [ ] Normal-use installed example: only apiKey setup, direct normalized query, shared projection,
      existing SMA explain; no MCP, mandatory clock/fetch options or provider-specific field map.
- [ ] Factory constructor/discovery zero-request/zero-clock controls; fake native fetch proves the
      staging preview default without a network request. Custom fetch/now/origin retain compatibility;
      null/wrong/unsafe overrides and invalid receipt instants refuse. Source unknown times stay null.
- [ ] Revise the exact same public wrapper/kit/fixture/HTTP mapping and first-touch coverage to the
      reviewed query/discovery grammar. No old-spelling aliases; TypeScript and JS teach old misuse.
- [ ] Identical fixture/HTTP closes yield unchanged full SMA explain output and 101.5 last value;
      OHLCV yields unchanged VWAP explain. Full source identity/row times/page+row diagnostics survive
      projection and appear alongside engine assumptions/diagnostics without overwriting either.
- [ ] Independent defects: missing volume first/later row, null vs zero, malformed OHLC/nonfinite,
      wrong kind/version, mutated input, nonterminal page, empty/partial quality refuse as specified.
      Zero volume/price values remain facts; no data gap fill, inferred clock, rate or other term.
- [ ] Preserve corrected original bounds/nextFrom/filter/pin/order/resource cursor tests and C1
      typed access/entitlement/throttle/allowance/redaction controls. Abort before fetch, during
      fetch and body parsing remains typed data.aborted with no retry or accepted late page.
- [ ] Public callable/manifest/first-touch/API/type misuse/generated-contract and affected ordered
      generation pass; measured defects zero and no budget/gate weakening. No new projection imports
      an indicator/provider implementation into core/root/browser compute or bundles credentials.
- [ ] Fresh SDK/provider tarballs install outside both repositories and run the accepted example
      with synthetic fixture/HTTP implementations. Record source commits, SHA256, pinned Node/pnpm;
      NodeNext/Bundler/ESM and unchanged ordinary compute/browser/guard-only bundle gates pass.
- [ ] Optional host review later specifies selection/discovery/handle validation, sync/async contracts,
      safe errors, cancellation/deadlines, metered host grants, worker exclusion and applicable
      registry/MCP/HTTP parity before implementation. It is not silently included in SDK acceptance.

Use Node 22.23.2/pnpm 10.32.0, frozen installs, focused tests and scoped formatting. After accepted
source is final, regenerate affected owners in documented order: signature -> naming -> contract ->
enforcement -> validation -> API -> README -> llms -> bundle -> OpenAPI -> docs; record any omissions
because inputs are unchanged. Current-head hosted rules remain in force, including a full exact-head
run for CI/enforcement/runtime-support gate changes. Local tarball compatibility never claims the
registry SDK 0.1.2 contains unreleased exports. No version bump or publication is authorized.

## Current truthful checkpoint

This branch contains this provisional written spec, queue/review documentation and generated docs
inventory only. Documentation checks are evidence about that work, not C2 runtime acceptance.
The actual unresolved product choice is whether the short explicit SDK path above meets the
maintainer's desired integration, or which specific composed workflow should replace it. The
coordinator is discussing that choice; no generic permission loop is introduced here. Preview
staging origin is already selected, now remains invisible, and no live access is needed for review.

C1 heads and green CI stay intact; PR26 remains draft. No staging read, secret access, old allowance
reuse/reset, key/grant mutation, active account/paper/journal/policy change, merge, release/publication,
deployment, remote repository or recurring automation has occurred or is implied by this document.
