# Option-flow drift — compute only what drift reports

Status: DR1 implemented (2026-10-07). DR2–DR5 proposed, awaiting maintainer decisions. A bounded
amendment to the published `@insiderfinance/totalfinance@0.1.2`; `implementation-order.md` owns its
place in the queue. This amendment does not authorize a version bump, npm publication, MCP
expansion, site deployment, or changes to any private application.

## Why

`optionFlowDrift` has a consumer that charts one session's per-minute premium changes live. It reads
the session's half-day flag and, for each minute, the six premium totals, bullish and bearish volume
and the trade count. It recomputes the whole session tape, up to 50,000 prints, on every change. Three
measured costs sit in the library:

- **Drift ran all of `flow()` and discarded most of it.** Each call validated and classified every
  print — which drift needs — and also flagged blocks, open/close and 0DTE trades and detected sweeps
  and spreads, which drift never reported. On a 50,000-print session that was about half of drift's
  time after the 0DTE market-day fix (#6, merged and not yet published), and most of it before.
- **A caller that needs per-minute changes gets everything.** With `bucketMinutes: 1` the same
  minutes are built twice (`minutes` and `buckets`), each with a `cumulative` row, a price overlay and
  a copy of every print. There is no way to ask for less.
- **Every update is a full recompute.** A live session gains a few prints per second, and a vendor
  can correct a print after the fact. The only API takes the whole tape, so a consumer that adds 20
  prints re-validates, re-sorts and re-sums all 50,000, and re-sends them across any worker boundary.

## Released consumers

0.1.2 is published. Every change here is additive or internal: no existing name, option, result
field, unit, default, error code or error message changes.

## Outcome

| Need                                                   | API                                                       |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Full drift: minutes, buckets, cumulative, prices, rows | `optionFlowDrift(input)` (unchanged, about 1.9× faster)   |
| One session's per-minute changes                       | `optionFlowDriftMinutes(input)` (proposed, DR2)           |
| A live session, updated as prints arrive or change     | `createOptionFlowDriftTracker({ session, config })` (DR3) |

All three run one per-print path, so they cannot disagree about a print.

## Decisions

1. **One per-print path (DR1, implemented).** `packages/structure/src/flow.ts` exports, to the
   package only, `classifyPrint`: the validation, premium and side classification `flow()` applies
   to every print, in that order and with those errors. `flow()` uses it unchanged. `optionFlowDrift`
   uses it instead of constructing a `FlowAnalysis`, so drift no longer computes blocks, 0DTE flags,
   open/close estimates, sweeps or spreads. `flow()` resolved every contract expiry for its 0DTE
   flag, so an unparseable expiry has always failed drift; drift resolves it to keep that error.
   `requireClassificationSource` is shared the same way. Proof: the full result and every error
   (name, code and message) equal the published 0.1.2 on 71 cases
   (`option-flow-drift-released-parity.test.ts`), and `flow()` itself is unchanged.
2. **A compact per-minute result (DR2, proposed).** `optionFlowDriftMinutes(input)` takes
   `optionFlowDrift`'s input without `config.priceOverlay` and `config.bucketMinutes`, which it refuses
   with a teaching error that names `optionFlowDrift`. It returns `session` as today; `minutes`, each
   `{ startTimestampMs, endTimestampMs, partial, change }`; and `summary`; plus the same assumptions,
   less the overlay and bucket fields, and the same diagnostics. Every `session`, `change` and `summary`
   value is bit-identical to `optionFlowDrift`'s for the same input. It builds no `buckets`, no
   `cumulative` rows, no prices and no print copies.
   - Not chosen: an `outputs` list on `optionFlowDrift`, as the selective Greeks use. Drift's parts
     sit at different levels (two interval arrays; per interval a change, a cumulative row, a price
     and print rows), so one list would mix levels and need conditional result types. A separate
     function has one small result type, and the tracker returns the same type.
3. **An incremental tracker (DR3, proposed).** `createOptionFlowDriftTracker({ session, config })`,
   with `optionFlowDriftMinutes`' config, returns:
   - `upsert(trades)`. Every trade needs an `id`; an ID is what makes a correction addressable. A new
     ID is appended. A known ID replaces that print where it stands, so ties order as if the tape had
     been corrected in place. Validation is identical to the batch functions and atomic: the whole
     call is checked before anything changes.
   - `remove(ids)`. An unknown ID is refused. Atomic.
   - `setAsOf(timestampMs)`. Moves the exclusive cutoff, forward or back.
   - Each of the three returns `{ changedMinutes }`, the start times of the minutes whose `change`
     moved, so a caller can forward only those.
   - `result()`. Deep-equal, bit for bit, to `optionFlowDriftMinutes` over the current prints in
     position order with the current cutoff.
   - **Exactness.** A touched minute is re-summed from its prints in (timestamp, position) order — the
     batch order — so arrival order never changes a bit. `summary` is summed the same way on
     `result()`.
   - **Cost.** An append touches the minutes its prints fall in: about 130 prints per minute on a
     50,000-print session. Memory is one compact record per print.
   - Not chosen: running sums updated print by print. They are cheaper, but out-of-order arrival
     would change last bits against the batch result, and subtracting a corrected print cannot exactly
     undo adding it.
4. **Errors name the function that was called (DR2–DR3).** The two new functions report
   `optionFlowDriftMinutes: trades[3] …` and the tracker method. `optionFlowDrift` keeps its released
   messages, which name `flow`; changing them is a separate decision, outside this amendment.
5. **Rules carried over unchanged.** Classification policies and their defaults, the premium rule,
   the duplicate policy, session and cutoff boundaries, half days, symbol scope and the heuristics
   are `optionFlowDrift`'s, by construction (decision 1).
6. **Changesets.** DR1 is a patch with no API change. DR2–DR3 add public API; the version they ship
   in is the maintainer's call at release.

## Ordered checklist and exit evidence

- [x] DR1: the shared per-print path; the released-parity golden captured from the published 0.1.2;
      before/after benchmark (below).
- [ ] DR2: `optionFlowDriftMinutes`; bit-identical to `optionFlowDrift` on the released-parity cases;
      refusal tests; first-touch fixture, manifests, docs.
- [ ] DR3: the tracker; property tests over random upsert/remove/setAsOf sequences against the batch
      result, bit for bit; atomicity; exact `changedMinutes`; a per-append cost test.
- [ ] DR4: generated artifacts in the documented order, bundle budgets from measurements,
      packed-consumer coverage, README and llms.
- [ ] DR5: benchmarks — `optionFlowDriftMinutes` against `optionFlowDrift` at 10,000 and 50,000
      prints; tracker appends of 1 and 100 prints and one correction on a 50,000-print session.

## Verification record

### DR1 — 2026-10-07

- **Parity.** 71 cases captured from the published 0.1.2 by
  `tools/golden/capture-option-flow-drift-baseline.mjs` and checked by
  `option-flow-drift-released-parity.test.ts`:
  - tapes of 0 to 2,000 prints, with and without IDs, crossed with seven configs;
  - a half day and a closed day;
  - 13 malformed inputs, including which of two bad prints is reported.

  Red-checked: dropping the expiry resolution fails its case, and perturbing premiums by one part in
  10¹⁵ fails 34. A wider local comparison against `main` matched 85 of 85 drift cases (up to 20,000
  prints) and 340 of 340 `flow()` results.

- **Speed.** `tools/bench/flow-tape.mjs`, 50,000 prints, one-minute buckets, Node 22.23.2, Apple
  M4, three alternating rounds, load average 5–8 (other agent sessions; repeat on an idle machine
  before quoting outside this spec):

  | Workload                   | main (`ec6ae2d`) |          DR1 |
  | -------------------------- | ---------------: | -----------: |
  | `optionFlowDrift`, 50,000  |     68.0–72.7 ms | 36.4–38.0 ms |
  | `flow`, 50,000 (unchanged) |     40.0–42.9 ms | 37.3–40.6 ms |

- **Bundles.** The shared helpers live in `packages/structure/src/flow-print.ts`, which is not a
  package entrypoint, so no public API is added (the naming manifest and `llms-full.txt` are
  unchanged). The umbrella import grows 51 B gzip (710,091 → 710,142 B), 2 B under its line, so its
  budget moves 693.5 → 693.75 KB from that measurement; `workflows` grows 71 B and keeps 165 B.
- **What remains in drift** (CPU profile, 50,000 prints): per-print validation and classification
  about half; building `minutes` and `buckets` with their print copies about a fifth; the duplicate
  check about a seventh. DR2 removes the second build, the copies, the cumulative rows and the
  prices for callers that need only changes.

## For consumers

A consumer that recomputes a whole session on every change can keep one tracker per session, send
it only new and corrected prints, and forward only `changedMinutes`. Until DR3 lands, call
`optionFlowDrift` as today; DR1 makes it about twice as fast with identical results.
