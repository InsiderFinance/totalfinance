# Spec — Gate C: narrow structural extension contracts (`@totalfinance/core/pricing`)

> Platform roadmap "Gate C — add narrow structural extension contracts" / implementation order §4.3.
> Status: **COMPLETE for Gate C.** The protocol, requirement grammar, selection-report grammar,
> conformance kit, and reference adapter are CODE
> (`packages/core/src/pricing.ts`, `packages/options/src/pricer.ts`) with their acceptance laws
> executable (`packages/core/test/pricing.test.ts`, `packages/options/test/pricer-adapter.test.ts`).
> Gate D's first real runner and the scheduled bond adapter are now owned by
> [`shared-scenario-runner.md`](./shared-scenario-runner.md); this document remains their settled
> protocol authority.

## Goal

Gate D's book must run one scenario across mixed instruments — an equity line, an option, a bond —
without TotalFinance growing a universal instrument superclass, a mutable global evaluation date, or a
stringly typed mega-dispatch. The missing piece is a NARROW protocol that lets a runner ask any
position three questions:

1. **Can you price this?** (`supports`)
2. **What do you need from the market?** (`requirements` — typed descriptors, as data)
3. **Price it from these observations.** (`price` — returning the EXISTING Law-2 envelope)

Everything else — engines, Greeks, batch, selection — is capability-declared and behaviorally
verified. Every constraint below is the roadmap's, verbatim: small `Pricer`/requirements protocols
with explicit capabilities; conformance probes with caller-supplied fixtures; explicit engine
selection and inspectable automatic selection; adapters around existing direct functions and batch
paths — no second pricing implementation; no universal instrument superclass, no mutable global
evaluation date, no stringly typed mega-dispatch.

## Precedents adapted (not duplicated)

Gate C is mostly a PROMOTION of machinery the options package already proved, plus one honest gap
each existing surface has:

| Existing precedent                                                                  | What it already does                                                                         | The gap Gate C closes                                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OptionPricingEngine` (`options/engines.ts`)                                        | structural `{ name, version, capabilities, supports, price }`, verified capabilities (Law 8) | option-only; takes a full `OptionMarket`, so a runner cannot know WHICH fields a pricing consumes                        |
| `engines.auto()` + `diagnostics.engine`/`autoReason`                                | automatic selection with a one-sentence reason                                               | the considered CANDIDATES and their rejection reasons were private to `resolveAutoDelegate`                              |
| `defineOptionPricingEngine` / `validateOptionPricingEngine`                         | structural registration + behavioral probes with caller-supplied fixtures                    | engine-shaped only; no requirement-honesty probes (an engine gets the whole market handed to it)                         |
| `compareEngines`                                                                    | inspectable panel comparison, failed rows disclosed                                          | a comparison tool, not a per-result disclosure                                                                           |
| fixed-income heads (`bonds.*`, `yieldToMaturity(bond, …)`)                          | instrument-object + market-input pricing heads                                               | no machine-readable "what market state does valuing this bond need"                                                      |
| `strategy` per-leg dispatch (`position.ts` → `@totalfinance/options/black-scholes`) | multi-leg mark-to-market with per-leg IVs                                                    | the "what a leg needs" contract is implicit in code (spot + per-leg iv + rate), invisible to a heterogeneous-book runner |

The design rule throughout: where a precedent exists, Gate C FORMALIZES its disclosure; it never
re-decides. `engines.auto()` keeps making the routing decision — Gate C only made it show its
candidate table. The adapter calls `option.price` — it never re-prices.

## Decision 1 — The Pricer protocol

```ts
interface Pricer<TInstrument, TValuation extends PricerValuationResult = Computed<number>> {
  readonly name: string;
  readonly version: string;
  readonly capabilities: PricerCapabilities; // { greeks, randomness, batch } — verified
  supports(instrument: TInstrument): boolean;
  requirements(instrument: TInstrument): readonly MarketRequirement[];
  price(input: { instrument; observations; request? }): TValuation;
  priceBatch?(input: { instruments; observations; request? }): readonly TValuation[];
}
```

**How small can it be?** Exactly this. Gate D's runner needs `supports` to route, `requirements` to
gather one snapshot's worth of observations for a mixed book, and `price` to value under base and
shocked observations. Identity + capabilities exist because selection reports and conformance
verdicts must NAME the thing they judge (the engine protocol's proven shape). Nothing else made the
cut:

- **`price` is not a capability** — a Pricer that cannot price is not a Pricer.
- **`scenarios` is not a capability** — repricing under shocked observations IS what
  `price(observations)` means. Because market state arrives as explicit observations rather than a
  god object, every conformant pricer supports scenarios structurally; a flag would be noise.
  _Rejected alternative:_ a `scenario(input)` method on the protocol — it would force every adapter
  to reimplement shock plumbing that belongs in Gate D's ONE shared runner (no-second-engine, for
  scenarios).
- **`greeks` mirrors the engine grammar** (`analytic | finite-difference | delegated | none`) —
  adopted verbatim from `EngineCapabilities` rather than a boolean, because "how" is the honest
  claim the kit can verify and the caller can budget around.
- **Result type = the EXISTING Law-2 envelope.** `TValuation extends PricerValuationResult`, whose
  structural floor is `{ value, assumptions: { conventionsVersion }, diagnostics: { warnings } }`.
  `Computed<number>` remains the compatibility default, while a domain may expose richer assumption
  vocabularies and result fields without losing them at the protocol boundary. The options adapter
  therefore returns its real `PriceResult` unchanged, and the fixed-income adapter returns its real
  domain result unchanged. _Rejected alternative:_ a new parallel `PricerResult` envelope — Law 2
  forbids a second grammar, and the conformance kit enforces the same structural floor with the
  existing `isComputed`/`assertFiniteValue` walkers.
- **Stateless family, not a bound object.** `price` takes the instrument per call (like
  `engine.price({ contract, … })`), so one pricer serves a whole book and holds no evaluation
  state. _Rejected alternative:_ `makePricer(position) → { price(observations) }` bound pairs —
  they smuggle instrument state into the pricer and double the object count for a book of N
  positions with zero information gained.
- **No universal instrument superclass.** `TInstrument` is a free structural type parameter. A
  custom pricer for a custom instrument shape needs no base class, no lifecycle methods, no
  registration (structural-extension law #8).

`priceBatch` is the optional second method (one coherent observation set, many instruments — the
book fast path, matching how the roadmap's batch constraint reads for Gate D). `capabilities.batch`
and the method's presence must agree in both directions (`definePricer` refuses either lie), and the
kit proves batch-vs-scalar agreement result-for-result. _Rejected alternative:_ batch as a separate
`BatchPricer` interface — two protocol names for one concept is exactly the mega-dispatch smell the
gate forbids.

## Decision 2 — The requirements protocol

"What do you need?" is answered with DATA: a closed discriminated union of typed descriptors.

```ts
type MarketRequirement =
  | { kind: 'valuationInstant'; optional?: boolean }
  | { kind: 'spot'; symbol: string; optional?: boolean }
  | { kind: 'forward'; symbol: string; expiresAt: EpochMs; optional?: boolean }
  | {
      kind: 'impliedVolatility';
      symbol: string;
      strike: number;
      expiresAt: EpochMs;
      optional?: boolean;
    }
  | { kind: 'riskFreeRate'; currency: string; optional?: boolean }
  | { kind: 'dividendYield'; symbol: string; optional?: boolean }
  | { kind: 'discountCurve'; curveId: string; currency: string; optional?: boolean };
```

An observation is `{ requirement, value }` with the value typed per kind — and every value is
PLAIN, SERIALIZABLE DATA, because the observation list is documented serializable/replayable
beside Gate B snapshots: scalars for prices/rates; the workspace `asOf` grammar for
`valuationInstant`, validated through core `resolveAsOf` (the snapshot's own resolution — loose
prose and impossible calendar dates teach at the observation door); and core's plain-data
`RateCurve` for `discountCurve` — the SAME payload a snapshot's `curves` section stores, checked
by the one shared core curve validator. A `discountCurve` requirement names its curve by
`curveId`, which IS the snapshot `observations.curves` label (e.g. `'USD.sofr'`) — a snapshot
stores multiple same-currency curves under caller labels, so a currency alone cannot identify
one; `currency` stays a subject field AND is cross-checked against the satisfying curve's own
declared currency, so a USD requirement can never be satisfied by an EUR curve sitting under the
requested label. Consumers (e.g. a fixed-income adapter) evaluate the
curve with their own machinery; the protocol never carries methods. Identity is
`requirementKey(...)` — kind plus subject fields in declaration order
(`impliedVolatility(symbol=AAPL, strike=200, expiresAt=…)`,
`discountCurve(curveId=USD.sofr, currency=USD)`); the `optional` marker is not
identity.

Decisions and their reasons:

- **`valuationInstant` is a requirement, not ambient state.** This is what makes "no mutable global
  evaluation date" STRUCTURAL rather than aspirational: two books can value at two instants
  concurrently, and a time-shift scenario shocks an observation like any other input. _Rejected
  alternative:_ an `asOf` field on `PricerPriceInput` — a second when-grammar beside the
  observations, and the one input a runner could no longer shock uniformly.
- **Missing required ⇒ the teaching error, never a guess.** `requireObservationValue` throws
  `pricer.requirement_unsatisfied` naming the exact descriptor, what WAS received, and the fix. The
  code is registered in the core `ErrorCode` registry (F15 discipline) and is load-bearing: the
  conformance kit demands exactly this code, so all pricers fail identically and a runner can
  branch on it. `missingRequirements(...)` is the pre-flight that reports EVERY gap at once for a
  book.
- **`optional: true` for consume-if-present inputs with a disclosed default** (the options
  adapter's `dividendYield`, defaulting to 0 under the already-disclosed `assumptions.dividendModel`).
  This exists because requirement honesty is BIDIRECTIONAL: the kit proves undeclared observations
  cannot influence a result, so "silently reads dividendYield when handed one" would otherwise be
  unrepresentable-but-real behavior. _Rejected alternatives:_ (a) all-required — hostile (every
  caller must invent a 0), and unfaithful to the wrapped function's real contract; (b) a separate
  `{ required, optional }` return shape — two lists to keep aligned where one marker suffices.
- **A closed union, not a registry.** Extending the vocabulary = one reviewed union member + one
  row in the subject-field table + one value type. _Rejected alternative:_
  `{ kind: string, …anything }` open descriptors — that IS the stringly typed mega-dispatch the
  gate names, and it would make snapshot compatibility (Gate B) unverifiable.
- **Gate B coupling is a shared vocabulary, not an import.** Descriptors NAME snapshot observation
  kinds; `@totalfinance/core/pricing` never imports the artifacts module (which lands in parallel at
  `@totalfinance/core/artifacts`). A snapshot satisfies requirements by kind+subject lookup; the
  observation list itself serializes beside snapshots for replay. When Gate B lands, its
  observation-kind names MUST adopt this union (or extend it here) — recorded as an open item
  below.
- **No god market object.** A runner knows exactly which observations each position consumes — so a
  heterogeneous book can gather the union, diff two positions' needs, and attribute a scenario's
  effect to the observations it shocked. This is precisely what `strategy`'s implicit per-leg
  contract (spot + per-leg IV + rate, hard-coded in `position.ts`) could never tell a runner.

## Decision 3 — Explicit + inspectable engine selection

**Explicit selection** stays what it already is everywhere in the library: pass the ENGINE OBJECT.
The adapter factory takes `optionContractPricer({ engine: engines.binomial({ steps: 501 }) })` —
the same objects `option.price` accepts, so there is no name-to-engine registry and no new grammar
for "use THIS engine". _Rejected alternative:_ `engine: 'binomial-leisen-reimer'` string selection
on the protocol — stringly dispatch, and it would break custom engines which exist only as objects.

**Inspectable automatic selection** is a structured report at `diagnostics.selection`
(`Diagnostics` gained one optional field in core — one diagnostics grammar, no parallel scheme):

```ts
interface SelectionReport {
  mode: 'explicit' | 'automatic';
  selected: { name: string; version?: string };
  reason: string; // automatic: the same sentence autoReason carries
  candidates?: readonly { name; eligible; reason }[]; // automatic only; the chosen one must appear, eligible
}
```

- The report FORMALIZES `diagnostics.engine` + `diagnostics.autoReason` (which remain, for
  compatibility); `selected.name` must agree with `engine` — the kit enforces "one selection, one
  story".
- **The routing function owns the disclosure.** `resolveAutoDelegate` — the single source of
  routing truth in `engines.auto()` — now returns its candidate table (each considered engine, an
  eligibility verdict, and a one-sentence reason: the Black-76 forward-only rule, the
  no-dividend-call early-exercise theorem, the speed/accuracy objective) and `auto().price` emits
  the report. Adapters PROPAGATE reports; they never reconstruct them. _Rejected alternative:_ the
  adapter enumerating a panel via public `supports()` calls and synthesizing reasons — it would
  re-derive (and eventually contradict) the routing table: a second implementation of the DECISION,
  which is the precise thing law #4 forbids.
- `mode: 'explicit'` must carry NO candidates — an empty considered-list would fabricate
  deliberation that never happened. `mode: 'automatic'` must carry a non-empty list containing the
  selected engine as an eligible row (completeness law). A caller passing `engines.auto(...)`
  explicitly gets an AUTOMATIC report — auto genuinely chose, and the report never lies about
  agency.
- Selection disclosure is validated whenever present, and made MANDATORY per-probe via the kit's
  `expectSelection` (the kit cannot know from the outside which pricers select; the caller states
  where a report must exist). _Rejected alternative:_ a `selection` capability flag — a claim about
  disclosure is itself just disclosure; the probe expectation is the verifiable form.

## Decision 4 — The conformance kit

`validatePricer(pricer, probes)` — the `validateOptionPricingEngine` pattern, generalized, with the
requirement-honesty probes only this protocol can have. The CALLER supplies fixtures (instrument +
full observations), because the kit cannot invent meaningful market data for an arbitrary domain —
the same reasoning `defineOptionPricingEngine` documents for staying side-effect-free.
`definePricer` remains the cheap structural half (identity, capability enums, method presence,
batch coherence, frozen + bound result).

Per probe, the kit proves — and each failure TEACHES with `pricer.nonconformant` naming the probe,
the broken law, and the fix:

1. **supports honesty** — boolean, true for the probe (a rejected probe instrument is a FIXTURE
   error, `input.wrong_shape`, so "your fixture is wrong" and "your pricer is broken" never blur);
2. **requirements validity + stability** — valid descriptors, duplicate-free, and identical across
   two calls (a runner must be able to gather-then-price);
3. **result grammar + finite success** — `isComputed` (Law 2) and the library's own
   `assertFiniteValue` full-depth walk (Law 7): never a new checker, so the protocol cannot drift
   from the house laws;
4. **requirement honesty, both directions** — each REQUIRED observation removed one at a time must
   throw `pricer.requirement_unsatisfied` with the kind named (never a silent guess, never a bare
   `Error`); each OPTIONAL observation removed must still price; and undeclared observations (the
   probe's extras plus an injected foreign one) must leave the value bit-identical — a pricer
   cannot consume what it does not declare;
5. **capability honesty** — `randomness` per the randomness law below (repeat-call complete-result
   identity for `'none'` plus the seed-ignoring law; the four seeded laws under a fixed seed for
   `'seeded'`); `greeks` mode ⇒ a greeks object with finite-or-null leaves exactly when claimed;
   `batch` ⇒ `priceBatch` agrees with `price` result-for-result (for `'seeded'`, under the batch
   seed-derivation law) — and every seed law is re-proved ON the batch path, on an
   at-least-two-instrument batch (2026-08-23, fourth external review; see the randomness law);
6. **selection honesty** — any present report validates against the grammar and agrees with
   `diagnostics.engine`; `expectSelection` makes it mandatory.

_Rejected alternatives:_ (a) kit-supplied synthetic fixtures — impossible without a universal
instrument model, which the gate forbids; (b) a vitest-only test-helper export — the kit is a
RUNTIME public API (like `validateOptionPricingEngine`) so third parties run it in their own CI
against their own fixtures, in any framework; (c) warnings instead of throws for soft failures —
a conformance verdict that can be ignored is marketing.

### The randomness law (2026-08-23, second external review)

`PricerCapabilities.deterministic: boolean` was replaced by `randomness: 'none' | 'seeded'`
(pre-1.0 rename). The boolean made `deterministic: false` legal while every conformance probe
compared complete canonical results byte-for-byte — so a minimal, correctly-self-declared
stochastic pricer was rejected as an undeclared-data consumer, and the only way to "pass" was to
lie about determinism. Skipping the byte-for-byte probes for stochastic pricers was rejected too:
it would leave the conformance laws unproved exactly where they are hardest to hold. Instead the
kit adopts explicit seeded semantics, and every law is proved under a fixed seed:

- **No free-running mode.** A pricer whose results the kit cannot reproduce under a fixed seed
  makes claims the kit cannot verify, and a claim the kit cannot verify is marketing. Free-running
  randomness is non-conformant by construction.
- **`'none'`** — repeat-call complete-result identity, PLUS the seed-ignoring law: a supplied
  `request.seed` must change nothing (verified with-seed vs without-seed). A "deterministic"
  pricer that reads a seed is consuming randomness it did not declare.
- **`'seeded'`** — `request.seed` (a non-negative safe integer) is REQUIRED: its absence is a
  typed `input.missing_field` refusal naming `request.seed`, never a silent default. The seed is
  echoed at `assumptions.seed` (a stochastic result must name what reproduces it), two same-seed
  calls return byte-identical complete results, and undeclared-observation independence is proved
  under the same fixed seed.
- **The batch seed-derivation law** — `priceBatch(instruments, obs, { …request, seed })` item `i`
  must deep-equal `price(instruments[i], obs, { …request, seed: seed + i })`. One documented,
  stable derivation, so a batch replays item-by-item through the scalar path; the kit probes a
  two-copy batch so the derivation (not just seed reuse) is exercised, and refuses (typed) a
  seeded batch probe whose `seed + instruments.length − 1` would exceed
  `Number.MAX_SAFE_INTEGER` — silently colliding derived seeds would fabricate independence.
- **Every seed law is proved on the batch path too (2026-08-23, fourth external review).** The
  laws above were originally proved only against `price()`, and the reviewer built two pricers
  that passed the kit on that gap: a `'seeded'` pricer whose scalar path refused a missing seed
  while its `priceBatch()` silently defaulted one, and a `'none'` pricer whose scalar path
  ignored seeds while its `priceBatch()` changed under one. A law proved on one entry point
  licenses the lie on the other, so the kit now probes `priceBatch()` with at least TWO
  instruments in BOTH modes (a single-instrument batch never exercises per-item behavior past
  item 0) and proves: a `'none'` batch deep-equals the per-item scalar results, ignores a
  supplied seed item-for-item, and holds still under undeclared observations; a `'seeded'` batch
  without `request.seed` is the same typed `input.missing_field` refusal naming `request.seed`
  as the scalar path (a batch that silently defaults a seed is nonconformant — a defaulted seed
  is unreproducible, since no caller can replay results priced under randomness they never
  chose), holds still under undeclared observations at the fixed seed, and still obeys the
  derivation law above.

## Decision 5 — Adapters, not engines (the worked example)

`optionContractPricer(options?)` (`packages/options/src/pricer.ts`) wraps the EXISTING
`option.price`:

- `requirements(contract)` = valuationInstant, spot(underlying),
  impliedVolatility(underlying, strike, expiresAt), riskFreeRate(contract.currency ?? 'USD'),
  dividendYield(underlying, optional) — a direct transcription of what `OptionMarket` consumes;
- `price` = look up those observations (via the core helpers, so the teaching errors are the
  protocol's), assemble the EXISTING `OptionMarket` literal, call the EXISTING `priceOption`, and
  return its `PriceResult` untouched — except the additive explicit-mode `selection` report when
  the caller pinned an engine (auto's report arrives already attached from the routing site);
- the `greeks` capability is INHERITED from the chosen engine's own verified capabilities, never
  re-asserted; `randomness: 'none'` for every engine — options engines that draw (Monte Carlo,
  local vol) take their seed at ENGINE CONSTRUCTION and echo it on the result, so the wrapped
  engine object is a pure function of (contract, market) and repeat-call identity is the
  verifiable truth (a per-call `request.seed` has no engine input to flow into and is ignored,
  per the `'none'` seed-ignoring law); `batch: false` honestly, see below.

The file's only runtime logic is field mapping — the parity law (below) pins it at bit-exactness,
so the protocol provably adds ZERO pricing code. _Rejected alternative:_ an adapter that calls the
`blackScholesPrice` kernel directly "for speed" — it would re-implement `option.price`'s engine
gate, dividend handling, and assumption echo: a second pricing path one refactor away from
disagreeing with the first.

**Batch adapter (designed, deliberately deferred):** the options batch paths (`@totalfinance/options/batch`) are
strike/vol-COLUMNAR over one market — a chain shape — while `priceBatch` is instrument-columnar
over one observation set — a book shape. An `optionChainPricer` adapting the columnar path lands
only when a measured acceleration workload can preserve each contract's declared volatility
requirement and Gate C's exact per-item seed law. Stage 4.4b intentionally runs scalar: wiring
`batch: true` around today's chain shape would claim semantic parity it cannot provide. This is an
acceleration decision, not missing runner correctness.

**Second adapter (implemented in Stage 4.4b):** fixed-income's
`bondDiscountCurvePricer({ curveId, currency, priceType, interpolation, extrapolation })` declares
`{ valuationInstant, discountCurve(curveId, currency) }` and wraps the existing bond pricing heads.
The `discountCurve` observation is core's plain-data `RateCurve` (the snapshot payload), while the
domain package owns evaluation and interpolation. Clean/dirty basis, interpolation, and
extrapolation are explicit factory economics. The adapter projects the resolved epoch to its
containing UTC settlement date, so it participates honestly in global time scenarios instead of
pinning settlement outside market state. Its implementation and parity laws are owned by the
shared-runner spec.

## Decision 6 — Placement

| Piece                                                             | Home                                                    | Layer                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Protocol, requirement grammar, selection grammar, conformance kit | `@totalfinance/core/pricing` (subpath, like `./schema`) | L1 — "error taxonomy, invariants, conventions, contract types — the trusted foundation" |
| `Diagnostics.selection` field + `Pricer*` error codes             | core (`diagnostics.ts`, `errors.ts`)                    | L1 (additive to existing grammars/registries)                                           |
| Reference adapter                                                 | `@totalfinance/options/pricer`, beside `pro.ts`         | L3, beside the function it wraps                                                        |
| Selection candidates disclosure                                   | `options/engines.ts` (`resolveAutoDelegate`)            | L3 (the routing site)                                                                   |

Justification against the layer model and FC0 graph: the protocol is CONTRACT TYPES plus
zero-dependency validation — core's charter — and it is symmetrical with Gate B's parallel
placement of artifacts at `@totalfinance/core/artifacts`. Adapters live beside the functions they wrap
(L3+), depending downward on core. **No package gains any dependency edge**: options→core already
exists; core still imports nothing. `tools/layer-model.test.ts` and the FC0 matrix in
`tools/package-graph.test.ts` pass unchanged (verified). Gate D's book (L4) will consume the
protocol from L1 and adapters from L3 — all downward.

_Rejected alternatives:_ (a) a new `@totalfinance/pricing` package — a package whose entire content is
one interface family fails the no-abstraction-tax test, and every domain package would need a new
edge to it (seven registration points each, for nothing core can't already carry); (b) protocol in
`@totalfinance/options` — fixed-income/crypto/fundamentals adapters would then depend on the options
package for types, a sideways edge with no pricing content; (c) core's main index — the pricing
protocol is opt-in extension machinery; the main entry stays free of it exactly like the schema
facade (spec §6), so compute entrypoints never pay for it.

## Acceptance laws

- [x] **Adapter parity (1e-15/bit-exact).** For the same contract and equivalent market,
      `optionContractPricer().price(...)` and `option.price(...)` agree with `Object.is` on value
      and EVERY Greek, and deep-equal on assumptions; diagnostics differ at most by the additive
      explicit-selection report. CLOSED in `packages/options/test/pricer-adapter.test.ts`
      (automatic AND pinned-engine variants; `request.greeks` passthrough included).
- [x] **Selection-report completeness.** Automatic mode: non-empty candidates, the selected engine
      present and eligible, `diagnostics.engine === selection.selected.name`,
      `autoReason === selection.reason`; explicit mode: no candidates ever. CLOSED in the grammar
      tests (core) and the routing-table tests (options: put/accuracy, speed objective, the
      no-dividend-call theorem, the forward-route rejection reason).
- [x] **Conformance-kit refutation.** A conformant toy pricer PASSES `validatePricer` against
      caller-supplied fixtures, and ten single-defect mutants FAIL it, each with a teaching
      `pricer.nonconformant`: determinism liar, NaN success, envelope abandonment, undeclared
      consumption, silent required-default, wrong error taxonomy, greeks lie, batch disagreement,
      missing/malformed selection report, unstable requirements. CLOSED in
      `packages/core/test/pricing.test.ts` (a kit that cannot refute proves nothing).
- [x] **Requirement teaching.** Missing required observations throw
      `pricer.requirement_unsatisfied` naming the exact descriptor and listing what WAS received;
      malformed descriptors/observations teach with the closed kind list and per-kind value types.
      CLOSED in both test files.
- [x] **The real adapter passes its own kit.** `validatePricer(optionContractPricer(), probes)`
      green with real option fixtures, `expectSelection` in both modes. CLOSED.
- [x] **No upward edges.** Layer-model + package-graph + codes-conformance gates green at this
      slice. CLOSED (exit code 0).
- [x] **Gate B vocabulary adoption.** BOUND at the Gate C landing (2026-08-20 — C landed second):
      `valuationInstant` is satisfied from snapshot METADATA (`MarketSnapshot.asOf` is a top-level
      envelope field, not an observation section) — a runner projects `asOf` into the requirement;
      `spot`/`riskFreeRate`/`dividendYield`/`impliedVolatility`/`discountCurve` map to the
      snapshot's `spots`/`riskFreeRates`/`dividendYields`/`volatilities`+`surfaces`/`curves`
      sections. One vocabulary, never forked; the executable projection (and its equivalence
      fixtures) lands with Gate D's runner, which is the first consumer of both.
- [x] **Batch disposition is explicit.** Stage 4.4b uses scalar `price`; today's option-chain
      columns cannot represent per-contract requirement lists or Gate C's exact seed derivation.
      A batch adapter remains a measured acceleration extension and cannot block or silently alter
      the shared runner.

## Draft state and landing checklist

CLOSED at the Gate C serial landing (2026-08-20, `stage4(4.3)`): the draft wired only what review
needed; the landing then hand-classified every export (13 Law-1 rows in `core.json`, 2 in
`options.json`), added the missing `./pricer` exports entry, regenerated the api-reports and doc
indices, and added the first-touch fixtures for every multi-arg head plus Law-14 rows for the
3-positional observation helpers. This section is retained as the record of what the draft
deliberately deferred; nothing here remains owed.

## Open questions (decided where defensible)

- **Should `requirements()` throw on unsupported instruments?** Decided NO: runners gate on
  `supports` first (documented on the interface); requirements are pure data derivation. An
  unrepresentable instrument still teaches via the engines' own `supports` head, unchanged.
- **Curve/surface observation kinds beyond `discountCurve`** (vol surface, dividend schedule,
  funding curve): deferred until an adapter needs one — each is a one-union-member extension, and
  guessing them now is vocabulary invented without a consumer.
- **`requirementKey` performance** (validates per lookup, O(n²) on big books): acceptable for the
  contract slice; if Gate D measures it, the fix is an internal memo keyed by reference — contract
  unchanged. Not a reason to pre-build.
- **`valuationInstant` in snapshots — DECIDED, not open.** This question closed when the "Gate B
  vocabulary adoption" acceptance law above was bound (2026-08-20): `valuationInstant` is
  snapshot-level METADATA — `MarketSnapshot.asOf` is a top-level envelope field, not an
  observation section — and a runner PROJECTS `asOf` into the requirement's observation. (An
  earlier revision of this section still listed the question as genuinely open while the checked
  law bound it; a spec that marks one decision both bound and open licenses whichever reading a
  correspondent prefers, so the record now speaks once.)
