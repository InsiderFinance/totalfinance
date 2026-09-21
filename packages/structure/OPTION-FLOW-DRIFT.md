# Option trade-premium drift

`optionFlowDrift` is raw premium accounting for an explicit trading session. It is **not**
`exposure(...).netDrift()` (dealer hedging estimates), `deltaAdjustedPremium()` (delta-weighted
premium), profit/loss, or an income prediction.

```ts
import { optionFlowDrift, type OptionFlowDriftTrade } from '@totalfinance/structure';
import { NYSE } from '@totalfinance/calendars';

const trades: OptionFlowDriftTrade[] = []; // canonical core OptionTrade inputs, epoch milliseconds
const result = optionFlowDrift({
  trades,
  session: { date: '2026-06-04', calendar: NYSE },
  config: {
    symbol: 'SPY',
    classificationSource: 'provided-first',
    bucketMinutes: 5,
    asOf: Date.parse('2026-06-04T15:00:00Z'),
  },
});

result.value.minutes; // separate change/cumulative totals and print provenance
result.value.buckets; // open-anchored five-minute intervals
result.value.summary;
result.assumptions; // calendar/version, policies, multipliers, threshold, cutoff
result.diagnostics.warnings; // model limitations; no probability claims
```

## Classification authority

| `classificationSource` | Supplied buy/sell | Supplied unknown | Absent classification |
| ---------------------- | ----------------- | ---------------- | --------------------- |
| `provided-or-quotes`   | Preserve          | Quote fallback   | Quote fallback        |
| `provided-first`       | Preserve          | Preserve         | Quote fallback        |
| `provided-only`        | Preserve          | Preserve         | Unknown               |
| `quotes-only`          | Quote rule        | Quote rule       | Quote rule            |

`flow()` retains `provided-or-quotes` as its backwards-compatible default. The new drift API
defaults to `provided-first`. Every print reports `classificationProvenance`, including the
applied policy, actual source/reason and `providedSide`: `null` means absent, whereas `'unknown'`
means an explicit provider label. A supplied label is authoritative under the chosen policy, not
independently verified. Bad source enums fail even when the policy would ignore the label.

The existing quote rule compares price to NBBO: at/above ask buys, at/below bid sells, and
inside-spread prices compare to the midpoint. Midpoint, locked/crossed and missing quote cases
stay unknown. There is no tick test or inferred opening/closing position in drift.

## Accounting and output meaning

- Premium is supplied `premium` (including zero), otherwise `price * size * multiplier`.
  Contract multiplier overrides `config.multiplier` (default 100). Volume remains contracts,
  never shares. Combined premiums must already be in one currency; no FX conversion occurs.
- Call drift = call buy premium − call sell premium. Put drift = put buy premium − put sell
  premium. Net directional drift = call drift − put drift.
- Call buys / put sells map to bullish premium and contracts. Call sells / put buys map to
  bearish premium and contracts. These are trade-initiation heuristics, not position intent.
- Unknown prints contribute neither signed drift nor signed volume. They remain in gross
  premium, volume and counts. Bounds are drift ± the corresponding unknown premium; net bounds
  include all unknown premium. These are worst-case sign-assignment bounds, **not statistical
  confidence intervals**.
- `classificationCoverage` = classified premium / total premium, or `null` at zero premium.
  It is data coverage, not confidence in a trade, future price move or profitable outcome.
- Each minute and larger bucket has `change` (that interval only) and `cumulative` (from open).
  The summary uses the same accounting over the whole selected interval. Empty intervals remain,
  including leading/trailing ones; changes are zero and cumulative values carry forward.
- `volumeConfirmation` is `aligned`, `opposed`, or `none` according to nonzero net premium and
  volume signs in the **same window**. Heuristic precedence is: empty/zero premium → `no-signal`;
  coverage below the configured threshold (default 0.6) → `low-coverage`; opposing volume →
  `volume-opposed`; call positive / put negative → `bullish-expansion`; the reverse →
  `bearish-expansion`; other nonzero net → `mixed-flow`; otherwise `no-signal`.

The five-print synthetic probe recorded in the September comparison yields call drift 1,500,
put drift −200, net 1,700, unknown premium 310, classification coverage 3,900/4,210, and net
bounds [1,390, 2,010]. Opting into legacy fallback instead classifies its unknown print and
produces net 2,010. The fixture is a recorded **synthetic comparison**, not a live market tape.

## Sessions, ordering and prices

`session.date` is mandatory and belongs to the calendar's timezone. NYSE is the default; core
`Calendar` and calendars `TradingCalendar` implementations are accepted. Open, close, holidays,
and early closes come from `calendar.session(date)`. Closed dates return no intervals and zero
summary totals with null coverage. Custom calendars support `24:00` close; ambiguous/nonexistent
DST boundaries and invalid/reversed session hours fail rather than being guessed.

Open is inclusive; close and `config.asOf` are exclusive. An as-of cutoff is clamped to the
selected session. No future buckets are emitted. A cutoff inside a minute produces a shortened
final bucket marked `partial`. All values are available at the **end** of the interval, not at
its start. Labeling a bucket with its start does not make its final totals usable at that time.

Scope uses exact, case-sensitive `config.symbol`; omission means marketwide. A single-symbol
scope defaults its overlay to that symbol's `OptionTrade.underlyingPrice`. Marketwide has no
default overlay: specify `config.priceOverlay: { symbol: 'SPY', quotes?, trades? }`. External
overlay rows use core `Quote` / `Trade` objects and can come from a symbol outside the premium
scope. Non-crossed positive bid/ask quotes yield midpoint prices; zero-sided/crossed quotes are
unavailable. Locked underlying quotes still provide a price (but no option aggressor signal).

Only observations within the session and strictly before the bucket end are eligible. The
latest one carries forward; missing stays `null`. No pre-session carry-in or future-price
backfill occurs. Ties prefer underlying trades, then quote midpoints, then option-print
underlying prices; last input wins within a source. Every price reports its symbol, timestamp,
and source. Input timestamps must reflect availability; embedded `underlyingPrice` is assumed
available at its option print timestamp. Publication delays, later corrections and staleness
are not reconstructed; the output retains price timestamps so callers can apply their own limits.

All supplied prints are validated, even outside the selected date/scope/cutoff. Finite numbers
are not coerced from strings; timestamps must be representable integer epoch milliseconds.
An epoch-seconds number is interpreted literally as milliseconds, not rescaled or guessed.
Trades are stably sorted by timestamp without modifying the caller's tape; equal timestamps
preserve input order and each output print retains its original `inputIndex`.

Repeated `id` values fail, even across symbols or with changed values. IDs must be tape-wide
unique; namespace provider/venue IDs when combining feeds. Without IDs, identical prints in
the consumed identity/accounting/quote fields (including sequence and venue) fail. Distinct
executions that otherwise look identical need distinct IDs. There is no silent deduplication.
Vendor decoration on data rows stays open; request, session, config and overlay option bags
reject unknown keys. Invalid inputs and non-finite arithmetic produce typed `InputError`s.

## Public availability

`optionFlowDrift` is exported from `@totalfinance/structure` and through the umbrella's structure
re-export; no deep subpath is required. Raw trade-premium drift remains distinct from dealer
hedging drift.

This is a provider-free calculation, not a data feed or execution transport. SDK availability does
not imply a dedicated MCP tool or access to an application's licensed trade tape.
