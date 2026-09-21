# Spec — Phase 3B decision ledger

> **Status: AUTHORITATIVE decisions; execution queued after Phase 3B.N.** This ledger records the
> settled answers for Phase 3B at the completed Wave 6 head (`8e59ca96`). Public path labels in this
> file describe the pre-normalization baseline; the
> [public naming specification](./phase-3b-public-naming-normalization.md) owns their final names
> without changing the H/P/C decision identities. The ordered runtime implementation and commit
> boundaries live in
> [`phase-3b-runtime-semantic-closeout.md`](./phase-3b-runtime-semantic-closeout.md); permanent API
> laws live in [`library-alignment-spec.md`](../library-alignment-spec.md). An executor implements
> these decisions and may reopen one only with a reproduced counterexample. Ordinary implementation
> preference is not grounds to improvise a different public contract.

## How to use this ledger

The decisions below are settled. An unchecked box means the implementation, generated linkage, and
acceptance evidence have not landed yet; it does **not** mean the executor should choose a different
answer.

Phase 3B.N first binds and normalizes the public vocabulary. Phase 3B.0 then binds every ID in this
file to stable generated contract and fixture IDs. If either generated inventory discovers an
additional helper answer, positional pair, naming conflict, or semantic conflict, add it to the
owning ledger with a decision before migrating its package. Never hide a new question by changing a
role, alias, or generated identity.

## Live handoff snapshot

| Inventory                                          | Post-Wave-6 baseline |
| -------------------------------------------------- | -------------------: |
| Public callable paths                              |                3,313 |
| Exports                                            |                2,501 |
| Constructors                                       |                  166 |
| Class methods                                      |                  344 |
| Interface methods                                  |                   51 |
| Returned-artifact methods                          |                  251 |
| Helper quant-answer paths                          |                   35 |
| Deduplicated helper quant-answer operations        |                   27 |
| High-level positional-pair paths                   |                   33 |
| Deduplicated high-level positional-pair operations |                   30 |

The 3,313 path count is coverage input, not 3,313 handwritten validators. Phase 3B.0 must replace
source-line-based alias guesses with stable public-path, canonical implementation, contract, and
validator identities.

## Result-decision vocabulary

- **Ratify plain:** keep the direct scalar/array/object because it is the complete unsurprising
  answer. Add the source-controlled rationale and any required validation fix.
- **Facade:** preserve the current simple direct result and add `.explain()` with assumptions and
  diagnostics. This improves responsibility without making the common call ceremonial.
- **Report:** change the direct result because the current bare value loses information required to
  interpret it safely.

Result grammar and migration impact are separate decisions. Every H entry has one or more
source-controlled impact labels:

- **`ratification-only`** — no accepted-input, successful-result, runtime-error, or TypeScript
  contract changes; only rationale/evidence closes;
- **`additive-surface`** — the existing direct answer remains and a companion such as `.explain()`
  is added;
- **`validation-tightening`** — malformed, non-finite, structurally invalid, or semantically invalid
  inputs that previously leaked through now reject typed;
- **`semantic-correction`** — a previously fabricated, clamped, ignored, or otherwise misleading
  outcome changes;
- **`successful-result-shape-break`** — a successful direct result changes shape because the old
  shape was incomplete or encoded absence dishonestly; and
- **`source/type-break`** — a TypeScript input or result contract changes even when ordinary valid
  numerical answers do not.

The settled impact inventory is:

| H IDs                  | Impact labels                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| H01                    | `validation-tightening`                                                     |
| H02, H04               | `additive-surface`, `source/type-break`                                     |
| H03                    | `additive-surface`, `semantic-correction`                                   |
| H05, H21, H22, H27     | `additive-surface`                                                          |
| H06, H13–H18, H25, H26 | `ratification-only`                                                         |
| H07, H08, H09          | `validation-tightening`, `semantic-correction`                              |
| H10, H11, H12, H19     | `successful-result-shape-break`, `source/type-break`, `semantic-correction` |
| H20                    | `validation-tightening`                                                     |
| H23, H24               | `additive-surface`, `validation-tightening`, `semantic-correction`          |

Every entry beyond `ratification-only` requires an exact before/after regression fixture, a real
packed-consumer journey, generated API/schema/doc updates, and a changeset or release-note entry.
When accepted inputs or successful result shapes change, add concise migration guidance. Reproduced
defects are evidence inputs; never commit a red gate or ratchet the defective behavior as expected.

## Helper quant-answer decisions

### Fixed income

- [x] **H01 — `cdsBasis`, `credit.cdsBasis` — ratify plain.** Keep the number. Validate both
      coordinates as finite, require/document one decimal-annualized spread basis, and document
      `positive = CDS rich relative to the bond`. CLOSED 2026-08-17: both coordinates were already
      required-finite with per-field unit hints ("decimal, not basis points"); the sign convention
      now leads the JSDoc, pinned in the H03/H01 regression.
- [x] **H02 — `cdsParSpread` — facade.** Keep the scalar direct result and add `.explain()` with
      protection-leg PV, risky annuity, recovery, schedule conventions, and diagnostics. Introduce
      `ParCdsSpecification = Omit<CdsSpecification, 'spread'>`; a par-spread calculation must not require an irrelevant
      current spread. CLOSED 2026-08-17: the facade lands on `seriesFacade`; the legs ride the new
      core `Diagnostics.decomposition` slot (parSpread = protectionLeg / riskyAnnuity, auditable);
      a supplied `spread` now TEACHES (`input.unknown_field`) rather than silently implying it
      mattered; regression pins before (required) and after (rejected) in credit.test.ts.
- [x] **H03 — `creditSpreadCurve`, `credit.creditSpreadCurve` — facade.** Keep the points array and
      add `.explain()` with reference date, recovery, frequency, day count, accrual-on-default,
      protection integration, and diagnostics. Propagate `accrualOnDefault` and `protectionSteps`
      into every CDS calculation. The current key allowlist explicitly accepts both fields, then
      this operation drops them while the sibling hazard bootstrap forwards them. Prove each field
      materially affects the calculation or reject it; accepted-but-ignored is a Law 12 defect.
      CLOSED 2026-08-17: the propagation half landed in an earlier wave WITH the materiality proof
      (the bootstrap→spread-curve round trip missed its own quotes by ~0.24bp when the two fields
      were dropped — pinned in the round-trip tests); the facade half lands now, echoing every
      per-tenor convention including both material fields.
- [x] **H04 — `swapRate` — facade.** Keep the scalar par rate and add `.explain()` with annuity,
      floating-leg PV, conventions, and diagnostics. CLOSED 2026-08-17: same shape as H02 — the
      legs ride `Diagnostics.decomposition` (parRate = floatLegPresentValue / annuity), a supplied
      `fixedRate` teaches, and the old path's rejection had named the WRONG function (`swapValue:`,
      the forwarded-contract defect) — the facade validates under its OWN name. Accept
      `ParSwapSpecification = Omit<SwapSpecification, 'fixedRate'>`; a par-rate calculation must not require an
      irrelevant fixed coupon.
- [x] **H05 — `yieldToCall` — facade.** Keep the scalar yield and mirror
      `yieldToMaturity.explain()`. Echo resolved call price, clean/dirty input basis, accrued
      interest, solver bracket/iterations/convergence, bond conventions, and diagnostics.
      CLOSED 2026-08-17: solver facts in diagnostics (brent/converged/iterations), resolved call
      price + settlement accrued in `decomposition`, callDate/priceType echoed in assumptions
      (YieldToCallAssumptions widens BondAssumptions); regression beside the distressed-callable
      test.

### Options

- [x] **H06 — `priceMany` — ratify plain.** Keep `PriceResult[]`; each row is already a responsible
      result. Do not add a redundant batch envelope. Preserve index-specific contract and runtime
      errors. CLOSED 2026-08-19: the ratification probe FAILED its own premise — only the shape
      check named the row; `engine.supports` delegation and per-row pricing errors escaped with no
      index. Every per-row failure now re-raises as the SAME class and code with `contracts[i]`
      leading the message, `contractIndex` in context, and the original as `cause`; regression in
      batch.test.ts.

### Risk

- [x] **H07 — `portfolioVariance` — ratify plain.** CLOSED 2026-08-19: a probe proved four real
      gaps — NaN/Infinity covariance cells returned silently, asymmetric matrices accepted, and a
      MATERIALLY NEGATIVE quadratic form (−0.43 from an indefinite Σ) clamped to 0. Now
      `requireFiniteSymmetric` guards every covariance consumer and a negative wᵀΣw throws
      `linalg.not_positive_definite`; only FP noise inside a documented tolerance clamps.
      Keep the number. Validate every weight and
      covariance element as finite, enforce symmetry, reject a materially negative quadratic form,
      and clamp only a tiny documented floating-point negative tolerance.
- [x] **H08 — `portfolioVolatility` — ratify plain.** CLOSED 2026-08-19: delegation confirmed;
      errors now report under its OWN name (the forwarded-contract defect, again).
      Keep the number and delegate to H07's corrected
      covariance/variance contract.
- [x] **H09 — `diversificationRatio` — ratify plain after correcting the degenerate case.**
      CLOSED 2026-08-19: a zero-volatility book (all-zero Σ, or a fully hedged pair) returned the
      plausible-but-false 1; it now throws `input.degenerate` naming the zero volatility. A
      zero-volatility denominator has no finite ratio. Throw a typed degenerate-input error instead
      of returning the plausible but false value `1`.
- [x] **H10 — `riskContributions` — report.** CLOSED 2026-08-19 (drafted in the design note, implemented per it): Return portfolio volatility, contribution rows,
      assumptions, and diagnostics. Rename `percent` to `fraction` because the field sums to one.
      For zero portfolio volatility, undefined marginal/component/fraction values are `null` with a
      field-specific reason, never fabricated zeros.
- [x] **H11 — `stressTest` — report.** CLOSED 2026-08-19 (the 0-base reprice defect fixed — a position's whole revalued price had reported as P&L): Return scenarios, per-position results, valuation methods,
      assumptions, and diagnostics. Custom repricing requires an explicit current position value
      (a dedicated field or `greeks.value`); never default the base mark to zero.
- [x] **H12 — `scenarioGrid` — report.** CLOSED 2026-08-19: Return the spot-shock axis, volatility-shock axis, P&L
      cells, resolved shock semantics, assumptions, and diagnostics. A detached `number[][]` is not
      a complete answer.

### Technical analysis

The paired root and `priceAction.*` paths below are aliases and share one implementation decision.

- [x] **H13 — `divergences` — ratify plain.** Keep the explicit event list. CLOSED 2026-08-19: the enforcement campaign closed its request (nulls/keys/swing ladders); ratified as-is.
- [x] **H14 — `fibExtension`, `priceAction.fibExtension` — ratify plain.** Keep `FibLevel[]`; this is
      a deterministic geometric transformation. CLOSED 2026-08-19.
- [x] **H15 — `fibRetracement`, `priceAction.fibRetracement` — ratify plain.** Keep `FibLevel[]`. CLOSED 2026-08-19.
- [x] **H16 — `lineAt`, `priceAction.lineAt` — ratify plain.** Keep the scalar artifact evaluation. CLOSED 2026-08-19.
- [x] **H17 — `openingRangeBreakout`, `priceAction.openingRangeBreakout` — ratify plain.** CLOSED
      2026-08-19: the NaN-during-opening-range contract is documented at the head, and the MCP
      serialization path (`jsonSafe`) deep-encodes every non-finite as `null` citing TA warm-ups —
      the condition holds by construction. Keep the
      aligned numeric signal. NaN is allowed only for declared TA warm-up positions; output metadata
      and JSON/MCP serialization must identify or encode those positions as unavailable.
- [x] **H18 — `orbRetest`, `priceAction.orbRetest` — ratify plain.** Apply the same aligned-series and
      warm-up contract as H17. CLOSED 2026-08-19: same construction.
- [x] **H19 — `previousSessionLevels`, `priceAction.previousSessionLevels` — ratify the array after
      correcting absence.** Return `null` for bars in the first session rather than an object
      containing three NaNs. A first session has no prior session: this is structural absence, not a
      declared warm-up position, so the C10 warm-up NaN allowance does not apply here. CLOSED
      2026-08-19: the source returned the three-NaN object verbatim; it now returns `null` and the
      declared type is `(PriorSessionLevel | null)[]`; the pin that asserted NaN asserts null.
- [x] **H20 — `sessionRanges`, `priceAction.sessionRanges` — ratify plain.** Keep `SessionRange[]`;
      validate every consumed bar and session ID. CLOSED 2026-08-19: bars/sessionIds arrays and the
      length pairing validated; per-bar guards from the enforcement campaign.

### Volatility

- [x] **H21 — `forwardVolatility` — facade.** CLOSED 2026-08-19 (parallel draft, landed serially): Keep the scalar and add `.explain()` with near/far expiries,
      maturities, ATM total variances, forward variance, conventions, and diagnostics. Negative
      forward variance remains a typed calendar-arbitrage error.
- [x] **H22 — `calendarSkew` — facade.** CLOSED 2026-08-19: Keep the scalar and add `.explain()` with sorted near/far
      expiries, both ATM slopes, and the canonical `0.05` log-moneyness central-difference step. Keep
      that step fixed until a concrete consumer justifies a new public knob.
- [x] **H23 — `forwardSkew` — facade.** CLOSED 2026-08-19: Keep the scalar and add `.explain()`. Require `step` to be
      finite and positive; disclose it and both total-variance calculations. Stop clamping negative
      forward variance to zero and throw the same calendar-arbitrage error as `forwardVolatility`.
- [x] **H24 — `harRvForecast` — facade.** CLOSED 2026-08-19 (contributions sum exactly to the value): Keep the scalar and add `.explain()` with predictors,
      fitted windows, raw model output, assumptions, and diagnostics. A negative variance forecast
      throws a typed model-output error; do not silently clamp or return it as a successful forecast.
- [x] **H25 — `realizedImpliedSpread` — ratify plain.** Keep the named-input scalar formula and state
      its volatility-point basis. CLOSED 2026-08-19: the head states "in volatility points" with
      the sign convention; request closed by the enforcement campaign.
- [x] **H26 — `varianceRiskPremium` — ratify plain.** Keep the named-input scalar formula and state
      its annualized-variance basis. CLOSED 2026-08-19: the head now states the ANNUALIZED basis
      explicitly (both inputs annualized volatilities, result in annualized-variance units).
- [x] **H27 — `volatilityCone` — facade.** CLOSED 2026-08-19: Keep the rows array and add `.explain()` with the applied
      `periodsPerYear`, windows, observation count, annualization convention, and diagnostics.

### Result-ledger exit

The intended result is 15 ratified plain operations, nine facade upgrades, and three report upgrades.
Do not envelope ordinary formulas merely to remove them from a backlog. H01–H27 close only when the
manifest role/note, runtime implementation, API report, generated docs, fixtures, packed consumer,
and aliases agree.

## High-level positional-pair decisions

Every pair below is retained. The concepts are role-distinct or conventionally ordered, realistic
transposition either fails structurally or is implausible, and an object wrapper would add ceremony
without improving growth safety. Phase 3B.0 must bind aliases to one canonical decision.

### Fixed income

- [x] **P01 — `bootstrapHazardFromCds(quotes, options)` and
      `credit.bootstrapHazardFromCds(quotes, options)`.** Retain series/configuration. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P02 — `curves.bootstrap(instruments, options)`.** Retain series/configuration. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P03 — `curves.bootstrapProjection(instruments, options)`.** Retain
      series/configuration. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P04 — `capFloorPrice(spec, curves)`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P05 — `cdsValue(spec, curves)`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P06 — `forwardCmsRate(spec, curves)`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P07 — `forwardSwap(spec, curves)`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P08 — `fraValue(spec, { curve })`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P09 — `priceMultiCurve(bond, options)`.** Retain subject/options. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P10 — `swaptionPrice(spec, curves)`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P11 — `swapValue(spec, curves)`.** Retain instrument specification/market context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P12 — `swapXva(spec, parameters)`.** Retain instrument specification/XVA context. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P13 — `g2pp(curve, parameters)`.** Retain calibrated subject/model parameters. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P14 — `hullWhite(curve, parameters)`.** Retain calibrated subject/model parameters. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P15 — `shortRateTree(curve, options)`.** Retain calibrated subject/options.
      CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.

### Risk

- [x] **P16 — `betaWeightedDelta(positions, options)`.** Retain series/options. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P17 — `bookVaR(positions, options)`.** Retain series/options. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P18 — `deflatedSharpeRatio(statistics, trials)`.** Retain role-distinct evidence inputs. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P19 — `extremeValueTailRisk(returns, options?)`.** Retain series/options. CLOSED 2026-08-19: the phantom — its intersection options now read as an object, the grammar is series-options, and the pair never existed (recorded at the gate when 22 → 21).
- [x] **P20 — `margin(notionals, options)`.** Retain series/options. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P21 — `optionsMargin(legs, options)`.** Retain series/options. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P22 — `scenario(name, ...shocks)`.** Retain the readable builder DSL. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P23 — `shock.factor(name, change)`.** Retain role-distinct custom-factor builder arguments. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P24 — `taylorPnl(greeks, scenario)`.** Retain subject/scenario context.
      CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).

### Strategy, structure, TA, and volatility

- [x] **P25 — `strategyFromChain(rows, options)`.** Retain series/options. CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.
- [x] **P26 — `unusualness(value, baseline)`.** Retain observation/reference-series order. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P27 — `openingRange(bars, options)` and
      `priceAction.openingRange(bars, options)`.** Retain series/options. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P28 — `pivots(bar, method?)` and `priceAction.pivots(bar, method?)`.** Retain subject/method. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P29 — `zigzag(bars, parameters)`.** Retain series/configuration. CLOSED 2026-08-19: generated ID linked; drift-evidenced by the bound pair gate (contract-conformance, exact count with per-change rationale).
- [x] **P30 — `riskNeutralDistribution(volatilitySmile, options)`.** Retain callback/evaluation context.
      CLOSED 2026-08-19 by reclassification: the inventory now files this as role `artifact` (natural-positional constructor), governed by the exported-artifact-constructor rule rather than the pair ledger; reappearance under a high-level role regenerates it as a pair and fails the bound gate.

### P-series re-entries (2026-08-19) — new decisions, not similarity

The 3B.3 facades and reports re-entered the generated set under their new roles; per the exit rule
each is a NEW decision, recorded here with its rationale:

- `cdsParSpread` (+ `.explain`) — retain (specification, curves): the same role-distinct shape as
  the ledgered `cdsValue` (P05); both coordinates are objects with disjoint members, transposition
  fails structurally.
- `creditSpreadCurve`, `credit.creditSpreadCurve` (+ `.explain` each) — retain (tenors, options):
  series/configuration, the P02-family shape.
- `swapRate` (+ `.explain`) — retain (specification, curves): the P11 `swapValue` shape.
- `riskContributions` — retain (weights, covariance): role-distinct evidence inputs beside the
  ledgered `taylorPnl` (P24); a weights vector and a covariance matrix cannot transpose.
- `harRvForecast` (+ `.explain`), `volatilityCone` (+ `.explain`) — retain: fitted-model /
  series-first heads whose second coordinate is the options object.

### Positional-ledger exit

The settled migration count for this exact live set is zero. Do not object-wrap P01–P30. Close each
entry by linking its stable callable IDs to this rationale and adding drift evidence. A newly
generated pair is a new decision; it is not covered by similarity. **EXIT MET 2026-08-19: all 30
entries closed (19 linked to generated IDs, 11 by reclassification with the regeneration
tripwire), the ten re-entries decided above, and the drift evidence is the bound pair gate — an
exact count whose every change carries a dated rationale in the assertion itself.**

## Cross-cutting decisions

- [ ] **C01 — Current baseline.** Wave 6 is complete, Phase 3B.N public-naming normalization is
      current, and runtime-semantic Phase 3B follows it. The live handoff contains 3,313 callable
      paths; historical Phase 3A closeout evidence may continue to state 3,310 when explicitly
      labeled historical.
- [ ] **C02 — Stable identities.** Track public path, canonical implementation, input contract,
      result contract, and validator separately. Do not use generated declaration line numbers as
      stable implementation identity.
- [ ] **C03 — Generated versus curated truth.** Generate declarations, paths, fields, aliases, and
      structural mutations. Curate meaning, units, safe ranges, defaults, null behavior, errors, and
      retained-pair rationale. A generator may not invent financial semantics.
- [ ] **C04 — Validator architecture.** Use lightweight shared TotalFinance guards and generated
      ownership metadata. Do not introduce a heavyweight parser in scalar or batch hot loops.
- [ ] **C05 — Object openness.** Requests/options/configuration and discriminated unions are closed.
      Decorated artifacts are open but validate every consumed field. Passthrough is allowed only
      when TotalFinance genuinely does not interpret the value.
- [ ] **C06 — `undefined`.** Required `undefined` is missing and rejects. Optional `undefined`
      behaves like omission. When “clear” differs from “omit,” use `null` or a discriminated action.
- [ ] **C07 — Recursive enforcement.** Validate every consumed nested field, array element, enum,
      date, callback result, and finite numeric coordinate, not only the outer object.
- [ ] **C08 — Defaults.** Keep only low-risk conventional defaults. Echo every meaning-changing
      default in assumptions. Expert kernels require every financially meaningful coordinate.
- [ ] **C09 — Units and bases.** Rates, yields, spreads, and volatility are decimal annualized unless
      explicitly named otherwise; basis-point fields end in `Bp`/`Bps`; `[0,1]` fields are
      `fraction`/`probability`/`ratio`, not `percent`; currency, multiplier, P&L basis, and time basis
      are explicit.
- [ ] **C10 — Non-finite and missing results.** Facade, analysis, artifact, MCP, and serialized
      successes are JSON-safe. Structured absence is `null` with a reason. Declared TA numeric
      warm-up series may use NaN internally/directly, but metadata and serialization must preserve
      its meaning. That exception is narrow: it covers only leading positions a declared indicator
      has not yet produced (H17/H18). A quantity that does not exist for a bar—such as H19's
      first-session prior levels—is structural absence, takes `null`, and never inherits the warm-up
      allowance. Infinity is never a successful financial answer.
- [ ] **C11 — Errors.** Reject with an exact typed `QuantError`, complete field path, safe offending
      value/context, and one-round-trip correction. Raw `TypeError`, generic invalid-input messages,
      silent ignored fields, and plausible wrong numbers fail the gate.
- [ ] **C12 — Result grammar.** Kernels/helpers return complete plain mathematics; facades keep a
      simple direct answer plus `.explain()`; analyses return inline assumptions/diagnostics;
      artifacts preserve serializable state and methods. Do not envelope by reflex.
- [ ] **C13 — Layer parity.** Raw, facade, `.explain()`, professional, batch, artifact, and MCP paths
      that answer the same question agree numerically and semantically.
- [ ] **C14 — Performance.** Validate once per public scalar request. Batch paths validate shape once
      and values without per-row object/key validation or allocation. Block more than a 5% warm
      median regression on representative 100,000-row batch workloads; report scalar absolute cost
      rather than enforcing a noisy nanosecond percentage.
- [ ] **C15 — Pre-1.0 compatibility.** Make clean breaking corrections with compile-fail evidence. Do
      not add positional/object overloads, deprecated aliases, or compatibility branches.
- [ ] **C16 — SDK/MCP/schema unity.** One contract identity drives direct SDK behavior, generated
      schemas, MCP, examples, and docs. MCP may expose fewer operations but may not rename fields,
      change defaults, reinterpret nulls, or maintain separate validation semantics.
- [ ] **C17 — Migration order.** Generate a topological package order and migrate foundations before
      consumers. Fix a shared contract once; downstream packages prove delegation.
- [ ] **C18 — Completion.** Phase 3B closes only at zero unowned contracts, unresolved semantic
      fields, missing validators, helper decisions, positional decisions, stale tracker claims, and
      packed/full-CI drift.
- [ ] **C19 — Final vocabulary prerequisite.** Execute Phase 3B.N to zero unresolved public naming
      identities before generating the runtime baseline. H/P/C IDs survive renames through stable
      implementation/contract identity. Phase 3B may not restore an old shorthand alias or invent a
      second SDK/MCP name.
- [ ] **C20 — Validation scope follows contracts, not packages.** Every public request, options,
      configuration, and discriminated-union object in every package—including `core` and `math`—is
      classified and enforced as closed, open, or passthrough. Conventional positional scalar
      mathematical primitives retain their documented mathematical/IEEE contracts and do not gain
      universal parser wrappers. Array, matrix, solver, optimizer, interpolation, callback, and
      configuration contracts validate the structural/domain preconditions they consume. A
      documented IEEE result may represent a valid mathematical problem; it may not excuse a
      malformed container, dimension, option, or callback result. Generated enforcement may exempt
      an individual contract identity, never an entire package or manifest tier. Validate once at
      the public boundary; private batch/hot loops remain unchecked after validation.

## Required seed and regression fixtures

The generated mutation harness may add more, but it must include these known failures:

- [ ] `blackScholesPrice` and `black76Price` after Phase 3B.N: omitted required `volatility`,
      near-miss key, unknown key, explicit required `undefined`, wrong primitive, and non-finite
      coordinate. Preserve linkage to the reproduced baseline `blackScholesPrice`/`vol` defect.
- [ ] H03: `accrualOnDefault` and `protectionSteps` demonstrably affect or are rejected by
      `creditSpreadCurve`; neither may be accepted as a no-op. Prove parity with the sibling CDS
      bootstrap's forwarding semantics.
- [ ] H02/H04: par-CDS/par-swap calls compile without irrelevant spread/coupon fields; the old
      requirement fails compile-time evidence.
- [ ] H07–H10: non-finite/asymmetric covariance, materially negative variance, zero-volatility
      diversification, and zero-volatility contribution semantics.
- [ ] H11: custom stress repricing without a current base value rejects rather than assuming zero.
- [ ] H12: serialized scenario grids remain interpretable without separately retained input axes.
- [ ] H19: first-session prior levels serialize as explicit absence, never NaN-filled records.
- [ ] H23: zero/non-finite step and negative forward variance reject typed.
- [ ] H24: a negative HAR variance forecast cannot be consumed as a successful forecast.

## Adjacent governed decision, not a Phase 3B blocker

The completed Wave 6 optimizer currently proves undefined-risk Kelly refusal through its internal
resolver because the public scanner enumerates only defined-risk/long-premium structures.

**Settled recommendation:** before the final platform-core freeze, add explicit `shortCall`,
`shortPut`, and ratio-spread `ScanStructure` values. Do not include undefined-risk structures in the
default scan. Require explicit structure selection plus `allowUndefinedRisk: true` for a structure
with unbounded downside. This work receives its own feature/API commit after Phase 3B and does not
expand Phase 3B's runtime-semantic scope.

## Executor handoff

1. Execute and close Phase 3B.N; do not freeze runtime contracts around the baseline shorthand.
2. Start runtime work with Phase 3B.0; do not jump directly into package edits.
3. Bind H01–H27, P01–P30, and C01–C20 to stable generated identities.
4. Land the Black-Scholes/Black-76 enforcement foundation and mutation harness atomically.
5. Migrate packages in generated dependency order, one independently green slice at a time.
6. Implement result decisions by coherent domain and remove each backlog entry in the same commit.
7. Ratify P01–P30 without changing their call shapes.
8. Run cold packed misuse journeys and burn every generated unresolved count to zero.
9. Escalate only a concrete counterexample that cannot obey this ledger; include the reproduced
   behavior, affected identities, proposed deviation, and tests.

With this ledger accepted, Phase 3B is an execution and evidence phase—not an invitation to reopen
the library's function-shape philosophy.
