# TotalFinance — Full Implementation Review (2026-08-01)

> **Historical external review at `a3ed2ce4`.** Findings are frozen evidence against that commit;
> current statuses and decisions live in [`implementation-order.md`](./implementation-order.md) and
> the [`library-alignment-spec.md`](./library-alignment-spec.md); statuses are not tracked here.
> Retired spellings appearing below are quoted as evidence, not as executable guidance.

**Method.** PR #303 head reviewed in an isolated worktree. Full spec stack read (alignment spec,
Phase 3A/3B decision ledgers, the Phase 3B.N naming spec, implementation order, roadmap,
platform-completeness, agent-native platform, data layer). The built library was exercised as a
cold-start consumer (happy paths, deliberate misuse, streaming round-trips, GEX, strategy, MCP
claims). Suites ran green on an independent machine: 290 package test files / 4,624 tests + 86
files / 1,038 tests + the executable docs suite (the slow `tools/` conformance generations were
skipped). Six specialist deep-dives covered all 15 packages and independently re-derived ~70
reference values (own normal CDFs, hand-traced HRP, Hull's conversion-factor tables,
Fang–Oosterlee Heston goldens, TA-Lib textbook RSI). Everything marked "verified" was executed,
not inferred.

---

## 1. Verdict

**The architecture, discipline, and honesty machinery are already #1-grade — no quant library in
any language has an equivalent.** The `.explain()` envelope, teaching errors with stable codes,
runtime finiteness postconditions, seeded determinism, batch≡stream proven per indicator, generated
docs that cannot rot, and external golden certification are collectively category-defining. The
math is genuinely right where checked: Heston COS matches Fang–Oosterlee to **6e-9**, SABR Hagan is
**bit-identical** to an independent implementation, HRP/deflated-Sharpe/PBO reproduce López de
Prado exactly, CME conversion factors match Hull to 1e-4, GEX arithmetic is exact.

What separates this state from "loved" is not architecture. It is four finite things: **(a)** a
short list of real, confirmed bugs (two high-severity, one in the dashboard's own GEX convention),
**(b)** rename-artifact shrapnel from the 3B.N sweep ("MonteCarloGinley"), **(c)** enforcement gaps
exactly where the mechanical gates stop (class methods, newest modules), and **(d)** a front door
that was stale about its own status. All are days of work, not months.

| Package            | Score | Package       | Score |
| ------------------ | ----- | ------------- | ----- |
| options            | 9.2   | risk          | 8.5   |
| technical-analysis | 9.0   | volatility    | 8.5   |
| performance        | 9.0   | mcp           | 8.0   |
| calendars          | 9.0   | crypto        | 7.5   |
| strategy           | 8.8   | structure     | 7.5   |
| fixed-income       | 8.7   | core/umbrella | 9.5   |
| math               | 8.5   | backtest      | 8.5   |

---

## 2. The design questions

### 2.1 Object inputs vs. positional arguments

The settled Phase 3A grammar (Law 14/D13, enforced by the generated signature manifest over all
3,313 public callables) is endorsed in full:

- **One flat named object whenever scalars are financially confusable** — including expert kernels.
  Killing the "kernels get positional args" exception was correct; a transposed positional
  Black-Scholes call is a plausible wrong number, and import depth never made it safe.
- **Positional retained only where roles are structurally unmistakable**: `normalCdf(x)`,
  `dot(a, b)`, `brent(objective, lowerBound, upperBound, options)`, `rsi(closes, { period: 14 })`,
  `position.pnlAtExpiry(spot)`. Object-wrapping these would be ceremony, not safety. The 30
  retained high-level pairs (P01–P30) each carry a written rationale; drift fails CI.
- **Columnar object-of-arrays for throughput**, so objects are never the batch bottleneck.

Two riders. TypeScript named fields do not survive to JavaScript runtime, so **object args are only
as safe as their runtime validation** — exactly why Phase 3B (unknown-key/missing-field/wrong-type
rejection on every object boundary, kernels included) is correctly release-blocking. And names are
only as safe as their truth — the naming spec's own closeout says it best: _"a naming ratchet
proves that no name contains a banned string. It cannot prove that a name is TRUE."_

### 2.2 Call shapes deep in the kernels and internals (verified)

Question: does the discipline hold _inside_ the library — private helpers, kernel internals,
cross-module calls — or is there a parallel positional architecture under the public objects?

**It holds, and it is mechanically enforced.** Three layers of evidence:

1. **Independent AST scan.** A compiler-based sweep of all 261 source files for **non-exported**
   functions (including private class methods and arrow consts) taking ≥3 number-typed parameters —
   the exact shape where a transposition yields a plausible wrong number — found **17 functions
   total, zero of them financial coordinates**: adaptive-Simpson recursion state, xoshiro RNG state
   words, PCHIP endpoint slopes, lerp coordinates, beta continued fractions, the Genz
   `bvu(sh, sk, r)` literature kernel, modular multiply, Ledoit–Wolf shrinkage internals (leading
   typed series/matrix arguments), clamps, and `shiftMonthKey(year, month, delta)` calendar
   arithmetic. **No internal `(spot, strike, time, rate, volatility)`-style signature exists
   anywhere.**
2. **The kernel pattern is the ideal one.** `packages/options/src/bsm.ts` is representative: the
   kernel takes one named `BlackScholesKernelInput`, guards it, and even the _internal_ helper
   `d1d2(input)` takes the same named object. Literature symbols (`S, K, T, r, q, sigma`) exist
   only as destructured locals inside a single function scope — never as positional parameters
   crossing a function boundary. Naming law N8 ("private scope earns brevity") applied exactly as
   intended.
3. **It is a standing CI gate, not a one-time audit.**
   `tools/manifest/internal-signature-inventory.ts` + `internal-signature-policy.ts` +
   `internal-signature-conformance.test.ts` regenerate the internal financial-signature scan on
   every run. The policy contains exactly **8 reviewed exceptions**, each with a written rationale
   (conventional curve value/time/compounding order, tree-rollback callbacks,
   `between(subject, lower, upper)`, validation protocols, clamp). A new internal positional
   financial signature fails CI.

Residual caveats — shape right, something else lagging: **(a)** runtime truth on raw kernels is the
known Phase 3B gap (reproduced at head: `blackScholesPrice` with `volatility` omitted returns
`NaN`; an unknown `sigma` key is silently ignored) — correctly sequenced as release-blocking;
**(b)** the remaining shape defect class is not positional-vs-object but _optionality encoding
constraints_: ~36 boundaries where "exactly one of" is expressed as several optional fields instead
of a discriminated union (already self-identified for 3B.2 — endorse and prioritize); **(c)**
class-method options bags occasionally skip Law 12 (see §3) — enforcement drift on methods, not a
shape decision.

### 2.3 Naming

Phase 3B.N is the strongest shipped naming discipline reviewed anywhere: 19,508 public identities
dispositioned to zero unresolved, units in names, an allowlist with written rationales, the
ambiguity veto, ratified divergences honestly recorded. Essentially every decision is right,
including `technical-analysis` over `ta`.

Residue to clean — **bulk-rename artifacts, i.e. spelled-out names that are false** (verified):
public **`MonteCarloGinleyStream`** (McGinley Dynamic mangled by the `mc`→`MonteCarlo` sweep;
`resolveIndicatorName('McGinley Dynamic')` returns `undefined` while the fictional name resolves) —
`technical-analysis/src/moving-averages.ts:670`, `aliases.ts:80`; **"MonteCarloNeil–Frey"**
citations (`risk/src/evt.ts:9,376,414`); resample interval-millisecond locals named
**`impliedVolatility`** (`technical-analysis/src/resample.ts:169-317`); stale `packages/ta/` output
paths in all four golden-vector generators. Smaller drift:
`conditionalValueAtRiskMaximumIterations` beside inherited `maximumIterations` in one options bag
(risk/optimize.ts:1320); `volatility` vs `impliedVolatility` for the same scalar within
`volatility/src/event.ts`; `grad`/`lambda0`/`rcond`/`maxSweeps`/`CarryInterp` leftovers;
`AmericanExerciseResult.style` carrying `'call' | 'put'`.

### 2.4 Composition, imports, and data flow

A real strength. Umbrella root is exactly 18 names (5 curated hoists + 13 namespaces); symmetric
deep entrypoints; `sideEffects: false`; CI-enforced bundle budgets generated into docs (BSM deep
entrypoint 8.1 KB gzip, verified). Core's `OptionQuote` feeds `volatilitySurface`, `exposure`, and
`strategyFromChain` unchanged; a TA `.explain()` envelope drops directly into
`backtest.vectorized` as a signal with warmup auto-handled; `BacktestResult.performance` _is_ a
`PerformanceSummary`; `bootstrapMultiCurve` output _is_ the `SwapCurves` the rates functions take.
The verified SMA-cross → backtest → metrics → VaR → overfit-verdict journey is ~15 lines with zero
reshaping.

Seams: **(1)** chain ceremony — hand-building an `OptionQuote` needs `contract` + `style` +
`resolvedExpiry` spread + `timestampMs` per row; a `quoteFrom(...)`/columnar `chainFrom({...})`
adapter (the `barsFromColumns` gesture) is the single highest-leverage ergonomic add, and it is
pure compute — it should not wait for the data layer. **(2)** `skew()` cannot accept an existing
surface — it re-fits internally (volatility/src/skew.ts:127). **(3)** Two chain-row grammars
(nested `OptionQuote` vs flat `ScanQuoteRow`) and one grammar break (`varianceIndex` /
`tailRiskIndex` flat bags vs `{quotes, market, config}`).

### 2.5 Error handling

Best-in-class, verified extensively: unknown keys teach with did-you-mean plus the allowed-field
list; `type: 'Call'` refuses to price the other leg; positional calls corrected with the exact fix;
wrong-shape objects echo received keys against expected slots; plausibility warnings catch
percent-as-decimal; stable dot-namespaced codes an agent can branch on.

Gaps: **(1)** the known Phase 3B raw-kernel hole (above); **(2)** the same class in _new_ N7 code —
`snapshotOf(stream)` silently accepted a stream object as its string `kind` parameter; **(3)**
`QuantError.toJSON()` still missing — `JSON.stringify(err)` drops `message` (the alignment spec's
own retraction record promised a versioned `toJSON`).

---

## 3. Confirmed defects (all verified with repro, ranked)

**High severity:**

1. **`structure`: `callWall` wrong under `dealerShortGamma`** — signed max instead of absolute
   (exposure.ts:821-826; `putWall` does it right). Verified: a 10-lot strike beats a 10,000-OI
   wall. This is the flagship convention for the commercial GEX tie-in; no test covers walls under
   sign-flipped conventions.
2. **`options`: CRR/trinomial lattices do not bound risk-neutral probabilities**
   (engines/tree.ts:45-75). σ=5%, r=30% gives p>1 → price **40.34 vs true 25.92 (+56%)**,
   `converged: true`, zero warnings. One bounds check fixes the library's only observed violation
   of its own no-silent-degradation law.
3. **`crypto`: 7 of 8 facades skip `finalizeResult`** — verified `futuresBasis` returning
   `fairFuture: Infinity` inside a successful envelope (carry.ts:286 et al.).
4. **`risk`: near-singular covariance passes silently** — `minVariance` on a rank-1 matrix returns
   arbitrary weights, `converged: true`, no warning (optimize.ts:616). Conditioning diagnostics
   exist in `covariance()`; the optimizers never gate on them.

**Medium:**

5. **`strategy`: builder slot ordering documented but unenforced** — `ironCondor` with swapped put
   strikes silently builds a _debit_ structure classifying as `inverseIronCondor` while
   `constructedAs` says `ironCondor` (builders.ts:161-184).
6. **`strategy`: `strategyFromChain` raw `TypeError`** on flat rows (from-chain.ts:125) — the only
   raw TypeError found in the flagship packages.
7. **`structure`: `atSpot()` unguarded** (NaN in → NaN out on the per-tick path);
   **`scenarioMap()`/`levels()` skip Law 12** — typo'd knobs silently run defaults. Pattern: class
   _methods_ sit outside the facade wrapper's guards.
8. **`options`: `usEquityCall/Put` reject every zoned-datetime expiry** with self-contradictory
   advice (contract.ts:194-217); **`market()` is not frozen** while every other artifact is.
9. **Cross-package unit footgun: `riskFreeRate` is per-period in `risk`'s `maxSharpe` but annual in
   `performance`/`backtest`.**
10. **`fixed-income`**: YTM/YTC Brent bracket capped at 100% (distressed bonds at 40 throw "did not
    converge"); `couponRate: 5` (meant 5%) prices silently; `zeroRate(0)` returns 0% on
    bootstrapped curves; non-ISDA CDS conventions undisclosed.
11. **`backtest`**: `percent` sizing ignores the option multiplier (~100× mis-target on option
    positions); `performance` nulls degenerate `hitRate` where the tear sheet zeros it.
12. **`math`**: differential-evolution convergence-on-final-generation misreported; `kalmanSmooth`
    crashes on validator-approved models; `gaussLegendreNodes` returns mutable cached arrays
    (verified corruption); normal-CDF tail accuracy overclaim (8e-9 relative near z≈7.5 vs claimed
    ~1e-15); `profitFactor` JSDoc promises `Infinity`, returns `null`.
13. **`volatility`**: crossed quotes build a surface with garbage IVs and zero warnings;
    `riskNeutralDistribution` silently clamps negative density (a butterfly-arbitrage signal,
    erased).
14. **`calendars`**: `'weekly'` expirations are Friday-only — no Mon/Wed/Fri, no daily 0DTE —
    while the sibling package ships a `zeroDaysToExpiryWall`.

Meta-pattern: **bugs cluster where the laws stop being mechanically enforced** — post-arithmetic
postconditions, class methods, sign-flipped conventions, newest-module grammar. The input door is
armored; the exit door is occasionally open. Two cheap structural responses: route rich-class
methods through the same guard/finite-walker facades use, and add convention-flip property tests.

---

## 4. Missing-lovable features (ordered by leverage)

1. **Chain adapter + one-shot chain journey** — quotes → surface + GEX + skew + expected move
   without ceremony.
2. **TA `computeAll`** — a pandas-ta-Strategy equivalent; the registry already has everything
   needed.
3. **Multi-asset vectorized backtest** (weights matrix).
4. **MCP fixed-income tools + a quickstart in the MCP README** — the fixed-income engine surfaces
   as _one_ MCP tool; dotted tool names will be mangled by `[a-zA-Z0-9_-]`-enforcing clients
   (underscores travel better); `fixed-income` pack vs `fixed_income` prefix inconsistency.
5. **Structure flywheel**: OI-delta positioning (two-day chain diff — the honest path to a real
   `tradeSignedAggressor`), GEX term-decomposed profiles, charm decay ladder, per-expiry max pain,
   sticky-delta scan.
6. **VaR backtesting** (Kupiec/Christoffersen).
7. **Options**: Jäckel rational IV (reserved slot exists), lattice-extracted early-exercise
   boundary, Longstaff–Schwartz American MC, true discrete-dividend lattice.
8. **Vol**: arbitrage-free surface repair (Fengler / Andreasen–Huge), OHLC realized-volatility
   estimators feeding the cone, SVI-JW round-trip.
9. **Fixed income**: SOFR compounding-in-arrears, ISDA standard CDS upfront, street-convention
   yield.
10. **Backtest/TA**: trade-level analytics (MAE/MFE, R-multiples); session-anchored + streaming
    resample.

---

## 5. Plan agreement and adjustments

The build and the sequence are endorsed — including the self-overrulings (killing the kernel
positional exception; retracting compact facade vocabulary). Adjustments recommended:

1. **A confirmed-defect burn-down slice from §3** before/alongside Phase 3B — several are
   silent-wrong-number defects, which the global stop conditions already say block advancement.
2. **Claim the npm names now.** Neither `totalfinance` nor the `@totalfinance` scope exists on the registry
   (verified 404 at review time). Publish placeholders — the name is the brand and it is squattable.
3. **Pull MCP FI tools, the quickstart, and underscore tool IDs ahead of launch** — tool IDs are
   wire contracts that hurt to change later.
4. **Front-door truthfulness** — the root README described 3B.N as current after it closed
   (corrected in the same change that adds this document); the PR description still names retired
   package identities and stale counts; install/MCP quickstarts reference unpublished packages.
5. **Institutionalize the review lessons as gates**: a limitations-audit registry (caveats are
   disclosed beautifully where someone thought of them and not at all where they didn't);
   method-guard routing; convention-flip tests.

## 6. Robustness additions (recommendations)

1. **Extend the TA certification apparatus to options/vol/fixed-income** — QuantLib and py_vollib
   golden generators with provenance-stamped committed fixtures (the Fang–Oosterlee Heston value
   verified externally in this review should be a committed fixture).
2. **Cross-engine differential fuzzing in CI (seeded)** — random valid contracts → every capable
   engine must agree within stated tolerance; would have caught the lattice p>1 class
   automatically. Plus a per-engine no-arbitrage property pack (parity, monotonicity, convexity,
   calendar).
3. **Route class methods through the facade machinery** — shared method-guard helper (first-touch +
   Law-12 keys + Law-7 finite walk) with a conformance sweep asserting coverage.
4. **Metamorphic invariance tests** — global sign-flip invariance for walls/levels, currency-scale
   invariance, greek unit-scaling identities, time translation.
5. **Condition-number gates on optimizers** (eigenvalues are already computed).
6. **Domain-of-validity contracts** — extreme-input property tests asserting finite-or-typed-error,
   plus documented per-kernel validity domains.
7. **Discriminated unions for the ~36 "exactly-one-of" boundaries** (already identified for 3B.2).
8. **Serialization version-skew fixtures** for every serializable artifact (the TA v1-snapshot
   rejection is the template).
9. **DST/timezone boundary fixtures** for expiry resolution.
10. **A generated limitations registry** per module.
11. **VaR backtesting** (also a feature; listed here because it hardens the risk numbers).
12. **`QuantError.toJSON()`** (versioned, includes `message`).

## 7. Agent-readiness additions (recommendations)

The [agent-native platform direction](./agent-native-portfolio-and-trading-platform.md) is endorsed
as written — ledger/journal split, propose→preflight→authorize→execute→reconcile, the deterministic
environment, Agent Bench, handles/jobs/stores, transport parity, and the AT0–AT8 sequencing. The
additions below are the layer it does not yet have:

1. **Self-healing errors** — a machine-applicable `fix` field on teaching errors
   (corrected-request skeleton / rename map) so agents recover mechanically in one round trip; the
   bench already measures recovery — make it a contract.
2. **A first-class `uncertainty` channel in the envelope** (MC standard error, IV conditioning,
   calibration RMSE, quantile cones) so agents propagate error bars instead of over-trusting
   points.
3. **Verbosity/context-budget contract per operation** (`summary | standard | full` plus
   response-size metadata; cap the MCP JSON mirror in compact modes).
4. **Staleness verdicts via injected `now`** — purity-preserving `dataAgeMs` + typed staleness
   warnings against per-operation freshness policies.
5. **Citation IDs** — short content-hash handles on artifacts/envelopes so agent prose cites
   recomputable evidence.
6. **A pure `diffPortfolios(a, b)` primitive** — the general typed economic delta underneath
   preflight, drift monitoring, and "what changed since yesterday."
7. **Batch sub-requests over MCP** (per-row envelopes + batch summary; budgets already bound it).
8. **Golden journey transcripts as fixtures** — committed ideal tool-call sequences with expected
   envelopes for the flagship journeys; seeds Agent Bench and is the executable `llms-full.txt`.
9. **A public adversarial-data red-team pack** — injection strings inside symbols/news/provenance
   fields, asserting they never alter semantics, policy, or authorization.
10. **From the existing backlog, prioritized for agents**: FI MCP tools (pillars-in/pillars-out
    keeps statelessness), the MCP server `instructions` string, `completions` for enum-heavy
    arguments, underscore tool IDs before they freeze.

---

## 8. Evidence snapshot

Verified externally in this review: BSM canonical 10.4506; Heston COS vs Fang–Oosterlee 6e-9; SABR
Hagan bit-identical; barrier in/out parity; CRR→BSM O(1/n) convergence; BAW/BS93/BS02 correct
lower-bound ordering; TA-Lib textbook RSI/MACD/Bollinger/ATR/engulfing; Renko bricks; VIX-strip
replication 0.20008 on a flat 0.2 smile; SVI recovery rmse 1e-13; planted butterfly/calendar
arbitrage caught; Breeden–Litzenberger density vs analytic lognormal to 0.004%; GEX per-strike
arithmetic <1e-9; max pain brute-forced; HRP recursive bisection hand-traced; deflated Sharpe vs
Bailey & López de Prado to 5e-11; historical VaR/ES type-7 conventions; accrued interest 30/360 and
ACT/ACT exact; two-instrument bootstrap discount factors exact; Black swaption recomposed; CDS par
vs credit triangle; CME conversion factors vs Hull; Vasicek closed form; crypto
funding/basis/liquidation closed forms.

Known and owned at review time (not new findings): the raw-kernel runtime gap (Phase 3B,
release-blocking); three flaky stochastic tests; performance/WASM deferred; live layer deferred.
