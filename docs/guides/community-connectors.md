# Community data connectors

TotalFinance's opt-in research contract lets independently maintained provider packages supply price
bars and option-chain research. Provider authors own their packages, releases and support. No
TotalFinance inclusion PR, central allowlist or listing is required. Ordinary calculations still
accept caller data and load no provider, network client or credential.

This addition is unreleased. The current registry SDK does not contain these subpaths; use the
fresh local SDK/provider tarballs named in the [implementation evidence](../reviews/community-connectors-c1-2026-11-02.md)
until an SDK release is separately authorized. An external provider's provisional peer version is
not proof that an older registry artifact contains a new export.

## Start with a synthetic provider

The [minimal fixture provider](../examples/community-connector-fixture.ts) imports only the public
SDK. It is a small example, not a built-in provider service or a package requiring registration.
The [synthetic facts](../examples/community-connector-facts.ts) contain no licensed responses.

Use `createFixtureDataProvider` from that example with its explicit `id`, `version`, capabilities
and request/page entries. The adjacent facts module supplies a synthetic daily request, bar and full
page metadata. Run `validateDataProvider` with named expected-page probes and explicit maxPages,
maxRecords and timeoutMs bounds. The [first-touch fixture](../../tools/first-touch/fixtures/core-data.ts)
and [installed consumer test](../../tools/community-connectors-consumer.test.ts) show the complete
working calls. After a successful query, project `record.bar.close` into existing TA functions;
no provider-aware calculation is required.

`defineDataProvider` lives at `@insiderfinance/totalfinance/core/data`. Construction checks the
structural protocol and binds it without calling provider methods. Each call validates its request
and response; valid data is copied and deeply frozen. Control objects reject unknown keys; research
records can retain harmless JSON decoration. Nonfinite or malformed financial facts are refused,
not dropped or converted to plausible values. The independent kit inspects its supplied provider
directly and does not repair invalid output.

## Discover and query explicitly

A provider implements `capabilities({ signal? })` and `query({ request, signal? })`, returning
Promises. No particular dataset is mandatory. Discovery describes supported behavior; it does not
grant account access or redistribution rights. Unsupported kinds/intervals produce
`data.unsupported_capability`; malformed known requests produce typed input errors.

Price bars require symbol, interval (`1d` or `1m`), from, to and limit. Daily bounds are inclusive real
session dates; minute bounds are inclusive zoned instants spanning at most 31 days. Chains require
symbol, an explicit latest/session/snapshot-id selector and limit, with optional expiration, right
and strike filters. Limits are bounded by both the contract and the provider. Nothing supplies a
financial default or automatically fetches all pages.

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
