# Spec — Stage 4.5 calibration and research artifacts

> **Status:** `ACCEPTED` (authored 2026-09-01; adversarially reviewed and revised 2026-09-02 — every
> finding is resolved in the [review record](#review-record) below). This is the decision-complete
> contract required by [`../implementation-order.md`](../implementation-order.md) §4.5 before any
> Stage 4.5 code lands. It becomes `COMPLETE @ <commit>` after every slice, its executable
> acceptance laws, generated artifacts, packed consumers, and the full repository gate are green at
> one exact commit.
>
> **Queue authority:** [`../implementation-order.md`](../implementation-order.md) §4.5. This file
> owns the API, semantics, package placement, bounded-work policy, implementation slices, and exit
> evidence for Stage 4.5. It does not reopen Gate B, Gate C, FC3, FC7, Stage 4.4b, or any direct
> calibration, research, backtest, performance, or risk API beyond the additive changes named in
> Decision 8.
>
> **Permanent API authority:** the fifteen laws in
> [`../library-alignment-spec.md`](../library-alignment-spec.md) §1, the fourteen-point permanent
> lovability and correctness gate and Decisions D1–D20 in
> [`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md),
> Gate B's Decisions 1–8 in [`gate-b-artifact-spine.md`](./gate-b-artifact-spine.md), Program 5 and
> Program 11 in [`../platform-completeness-roadmap.md`](../platform-completeness-roadmap.md), the
> naming laws N1–N10 in
> [`phase-3b-public-naming-normalization.md`](./phase-3b-public-naming-normalization.md), and the
> artifact save/replay precedent of [`shared-scenario-runner.md`](./shared-scenario-runner.md)
> Decision 13. Every new public identity enters the naming, signature, runtime, field, result,
> finite-success, manifest, package-graph, packed-consumer, and bundle ratchets in its first
> implementation commit.

## Outcome

A developer who has just called `calibrateSsvi(...)`, `fitGarch(...)`, `curves.bootstrap(...)`,
`bootstrapHazardFromCds(...)`, `screenUniverse(...)`, `eventStudy(...)`, or
`informationCoefficient(...)` must be able to — in one obvious call each, with no framework, class
hierarchy, registry, storage adapter, or provider —

- **describe** the fit or run in one standard grammar (parameters, objective, convergence,
  residuals, model risk, input identity, model version) without losing a single field of the direct
  result;
- **save** it as an identified, immutable, migration-governed artifact through the existing Gate B
  spine and **restore** it later with its hash re-verified;
- **evaluate** a restored fitted model directly (a volatility at a strike and expiry, a discount
  factor at a date, a survival probability, a GARCH forecast) through the same direct function a
  fresh fit would use;
- **compare** two fits or two research runs under the same market — parameter by parameter, row by
  row, instrument by instrument — with every difference named and nothing summarized away;
- **replay** the producing calculation from the artifact's stored inputs (or from referenced data
  the caller supplies and the artifact can verify) and prove byte identity or list exactly what
  differs;
- **warm-start** a new calibration from a saved fit, and measure a fit's **stability** across nearby
  starting points and its **holdout** residuals — through the direct calibrators, never a second
  engine.

Every direct function keeps its signature, result, and independence. The artifacts add persistence,
identity, comparison, replay, and diagnostics; they add no calculation of their own.

## Non-goals

Stage 4.5 does **not** add:

- a model catalogue, registry, or discovery service — Program 5's "registry metadata" is satisfied
  by the frozen `FITTED_MODEL_FAMILIES` / `RESEARCH_RUN_KINDS` descriptor constants (Decision 2 and
  Decision 4: data, not a runtime registry; the spine is storage- and registry-agnostic by Gate B
  Decision 5);
- storage, I/O, or a database — artifacts are values; the caller persists them with
  `canonicalJsonOf` and restores them with `fromCanonicalJson` (Gate B Decision 7);
- backtest run artifacts, sweep/child-run lineage, or cancellation/checkpoint state — those are
  FC8's "Reproducible research artifacts" (`finance-portfolio-backtesting-completeness.md` §FC8)
  and remain Stage 4.6;
- incremental or scheduled recalibration — Stage 4.5 delivers warm-start inputs and stability
  diagnostics; a recalibration loop is a Stage 7 workflow;
- artifacts for the swaption cube, surface PCA, local volatility (`localVolatilitySurface`), or the
  volatility term/skew analytics — they are derived analytics over surfaces, not calibrations to
  market data; the surface they derive from IS covered (family `volatility-surface`), and each is
  deferred with that reason;
- a `@totalfinance/risk` fitted-model family for `fitGeneralizedParetoTail` — it is a tail-risk
  estimator whose `GeneralizedParetoFit` is already a Law-2 report the spine saves directly
  (`createAnalysisArtifact({ artifactType: 'risk.generalized-pareto-tail', … })`, proven by one
  fixture in slice 5); a typed family needs the EVT value-at-risk/expected-shortfall evaluators
  mapped and a fourth `./artifacts` subpath, which is a risk-artifact decision for the Stage 4.6
  contract, not Program 5's calibration list. The exhaustiveness law in Decision 2 is therefore
  scoped, on purpose, to `@totalfinance/volatility` and the `@totalfinance/fixed-income` bootstraps;
- a volatility snapshot bridge — a `MarketSnapshot.observations.surfaces` entry is an implied-vol
  grid, and projecting a fitted model onto a grid is a consumer's evaluation choice (which strikes,
  which expiries), not a property of the fit; Program 5's "used in a book/scenario calculation" is
  closed for curves (Decision 2, the `rateCurveFromYieldCurve` bridge) and deferred for volatility
  with this reason;
- MCP tools, CLI verbs, or OpenAPI operations for artifacts — Stage 7A adapts the then-green
  surface; nothing here may become their hidden implementation home;
- a second envelope kind — there is no `FittedModelArtifact` or `ResearchRunArtifact` type. An
  `AnalysisArtifact` with a dot-namespaced `artifactType` and a typed `result` IS the artifact
  (the scenario runner's Decision 13 precedent, made a law here: **one envelope, many result
  schemas**).

## Decision 1 — package and import placement

**Decision.** No new package. Structural contracts land in the spine; every semantic adapter lands
in the domain package that owns the direct function it adapts, on a new **subpath-only**
`./artifacts` entrypoint.

| Home                                        | Adds                                                                                                                                                                                                                                                                                                        | Why here                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@totalfinance/core/artifacts` (L1)         | `FittedModelSummary` grammar and its validator; `compareAnalysisArtifacts`; `artifactReplayParity`; `scanCanonicalData` (the bounded stored-data scanner, promoted from `@totalfinance/scenarios`' internal module — Decision 9); the artifact error and warning codes in Decision 10.                      | Structural, model-agnostic, JSON-safe; the same layer that owns `AnalysisArtifact`, canonical JSON, and content hashes (Gate B Decision 1). Core knows no model. Reachable ONLY at `@totalfinance/core/artifacts` — core's root and the umbrella's `totalfinance/core` do not re-export the spine (the Gate B hot-path rule). |
| `@totalfinance/volatility/artifacts` (L3)   | `fittedModelArtifact`, `readFittedModel`, `evaluateFittedModel`, `replayFittedModel`, `compareFittedModels`, `warmStartFrom`, `fittedModelStability`, `fittedModelHoldout`, and the frozen `FITTED_MODEL_FAMILIES` descriptor over the twelve volatility families in Decision 2.                            | The direct calibrators and evaluators live here; the adapters call them. Volatility already depends on options (for `sabrVolatility` / `hestonImpliedVolatility`) — no new edge.                                                                                                                                              |
| `@totalfinance/fixed-income/artifacts` (L3) | The same eight verbs and descriptor over the four curve families (discount, projection, multi-curve, hazard). The additive direct mappers `rateCurveFromYieldCurve` / `yieldCurveFromRateCurve` land on the package ROOT beside `curves` (they are domain conversions, not artifact adapters — Decision 2). | Curve bootstraps and survival curves live here. `yieldCurveFromRateCurve` is the extraction of the bond pricer's private `buildDiscountCurve` (the pricer calls the public function afterwards — one engine); `rateCurveFromYieldCurve` is the fixed-income half of Gate B's open "Domain mappers" acceptance box.            |
| `@totalfinance/research/artifacts` (L4)     | `researchRunArtifact`, `readResearchRun`, `replayResearchRun`, `compareResearchRuns`, and the frozen `RESEARCH_RUN_KINDS` descriptor over the eleven FC3 operations, with a structurally validated optional `hygiene` block.                                                                                | FC3's operations live here. Research cannot import risk (FC0 graph), so the hygiene block is a validated structural echo of risk's result shapes — see Decision 4 — with a compile-time parity fixture.                                                                                                                       |
| `totalfinance` umbrella (L6)                | **Nothing.** The umbrella exposes domain roots only (`totalfinance/<domain>` is `export *` of the package root); a spine adapter is imported package-direct, exactly as `@totalfinance/fixed-income/pricer`, `@totalfinance/options/pricer`, and `@totalfinance/scenarios/portfolio` are today.             | D20 (no root hoist), alignment law 3, and the umbrella-symmetry gate stay untouched; no nested `src/<domain>/artifacts.ts` files or `dist` paths that no gate has seen.                                                                                                                                                       |

**Why subpath-only, not root + subpath.** Two precedents exist: `@totalfinance/portfolio` re-exports
`./policy` from its root (domain semantics that happen to hash), while the Gate C pricer adapters
are subpath-only (`bondDiscountCurvePricer` is not on the fixed-income root). Artifact adapters are
the second kind: they ride the spine (canonical JSON, SHA-256, envelope validation), and putting
them on a compute root would make every non-tree-shaken `@totalfinance/volatility` / `@totalfinance/research`
bundle pay for serialization — the exact cost the Gate B hot-path rule exists to keep out of
pricing bundles. The research root budget (22 KB) is therefore unchanged by this stage; the three
new entrypoints get their own measured budgets (Decision 9, slice 6).

Import shape a cold user sees (the README's first example for each subpath):

```ts
import { calibrateSsvi } from '@totalfinance/volatility/ssvi';
import {
  fittedModelArtifact,
  readFittedModel,
  evaluateFittedModel,
} from '@totalfinance/volatility/artifacts';
import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';

const fit = calibrateSsvi(surface, { weight: 'vega' }); // the direct call, unchanged
const artifact = fittedModelArtifact({
  family: 'ssvi',
  fit,
  calibration: { surface, options: { weight: 'vega' } },
  snapshotHash: marketSnapshotContentHash(snapshot),
});
const stored = canonicalJsonOf(artifact); // → your file, database, or message
const { report } = readFittedModel({ artifact: fromCanonicalJson(stored) });
evaluateFittedModel({
  model: report,
  at: { logMoneyness: [-0.1, 0, 0.1], timeToExpiryYears: 0.5 },
});
```

`JSON.parse` is never the restore door: it leaves the library's `{ nonFinite }` wrappers as plain
objects, and `readAnalysisArtifact` then refuses the envelope (`serialization.unsupported_value`).
Every README example, fixture, and packed consumer in this stage restores through
`fromCanonicalJson`.

**Rejected:** a `@totalfinance/models` package (a fourth home for volatility semantics, an L4/L5
composition package that must import every calibrating package to know its result types, and a
second place a user must learn); putting the fitted-model grammar only in prose (Program 5 asks
for "a standard artifact grammar", which is a type with a validator, not a convention); a
`FittedModelArtifact` envelope kind (Gate B already stamps, hashes, validates, and migrates one
envelope; a second one is a second replay law); umbrella deep subpaths (they do not exist for any
domain today and would need nested source files, `dist` paths, and export-map rows no gate covers).

## Decision 2 — the fitted-model report grammar and the model families

**Decision.** A fitted model is described by ONE report shape, built by pure projection from the
direct result — no field of the direct result is dropped, renamed, or recomputed:

```ts
// @totalfinance/core/artifacts — structural, model-agnostic
interface FittedModelSummary {
  /** Dot-namespaced family, e.g. 'volatility.ssvi', 'fixed-income.discount-curve'. */
  family: string;
  /** The family's integer semantics/shape version; bumps when the calibrator's result shape or meaning changes. */
  modelVersion: number;
  /** Flat, named, JSON-safe parameters — the numbers a reader would want to diff (dot paths for nested members). */
  parameters: Record<string, number | number[] | string>;
  objective: {
    kind:
      | 'root-mean-square-error'
      | 'log-likelihood'
      | 'r-squared'
      | 'exact-fit'
      | 'exact-bootstrap'
      | 'not-applicable';
    value: number | null;
    /** The objective's unit or basis, e.g. 'total variance', 'implied volatility', 'log-likelihood'. */
    unit: string;
    /** Required exactly when `value` is null. */
    reason?: string;
  };
  convergence: { converged: boolean; iterations: number | null; reason?: string };
  /** Null when the family has no per-point residual (with the reason in `modelRisk.notes`). */
  residuals: {
    count: number;
    rootMeanSquare: number | null;
    maximumAbsolute: number | null;
    unit: string;
    /** Where the numbers came from — the calibrator's own report or the family's direct evaluator re-issued at the calibration points. */
    source: 'reported-by-calibrator' | 'direct-evaluator';
  } | null;
  /** The family's honesty flags — what a reader must know before trusting the parameters. */
  modelRisk: {
    /** Butterfly/calendar freedom for smiles and surfaces; null where the notion does not apply. */
    arbitrageFree: boolean | null;
    /** The coordinate range the fit was calibrated over; evaluation outside it warns. */
    calibratedRange: Record<string, { minimum: number; maximum: number }>;
    notes: string[];
  };
  /** The weighting the calibrator applied, when it applied one ('uniform', 'vega', 'ordinary least squares'…). */
  weighting: string | null;
  /** Identity of what was fitted: hash of the calibration input (embedded and referenced parts), and the market snapshot when one was read. */
  inputIdentity: { calibrationHash: string; snapshotHash: string | null };
  warningCount: number;
}
```

**Parameter flattening.** `summary.parameters` is flat by design (a diff reads one level). Nested
calibrator members flatten by dot path: `phi.kind: 'power-law'`, `phi.eta`, `phi.gamma` (or
`phi.lambda`); term structures become aligned vectors under one prefix —
`thetaTerm.timeToExpiryYears: number[]`, `thetaTerm.theta: number[]`, `thetaTerm.rho: number[]`
(eSSVI); HAR-RV's `coefficients.const`, `coefficients.daily`, `coefficients.weekly`,
`coefficients.monthly`. The verbatim `fit` keeps the nesting; the summary is a projection.

Each domain package returns a **typed report** around the summary:

```ts
// @totalfinance/volatility/artifacts (the fixed-income shape is identical with its own families)
interface FittedModelReport<Family extends VolatilityModelFamily = VolatilityModelFamily> {
  family: Family;
  modelVersion: number;
  summary: FittedModelSummary;
  /** The direct calibrator's result, VERBATIM (for `volatility-surface`, the surface's own `toJSON()` snapshot; for curves, the curve's own data members — see the curve table). */
  fit: FitOf<Family>;
  /**
   * The calibrator's input, verbatim (deeply copied and frozen) — except that a behavior object
   * (a `YieldCurve` inside `HazardBootstrapOptions`) is stored as its data through the named mapper,
   * and a family's declared bulk row set may be a `TableHandle` instead of the rows (Decision 9).
   */
  calibration: Referenced<CalibrationOf<Family>>;
  /** Table references for every bulk row set that was not embedded (Gate B TableHandle), keyed by the row set's name. */
  referencedData: Record<string, TableHandle>;
  assumptions: {
    conventionsVersion: string;
    family: Family;
    modelVersion: number;
    /** The direct function whose result this is, e.g. 'calibrateSsvi'. */
    calibrator: string;
    /** The direct function `evaluateFittedModel` dispatches to, or null with the reason in `modelRisk.notes`. */
    evaluator: string | null;
    /** 'embedded' when every row set is embedded; 'referenced' when at least one is a TableHandle. */
    inputPolicy: 'embedded' | 'referenced';
    /** Curve families only: the currency the artifact input declared (a curve without a unit is a number without one). */
    currency?: string;
    /** Prose statement of the projection convention. String-typed by design. */
    projection: string;
  };
  diagnostics: {
    warnings: QuantWarning[];
    fitWarningCount: number;
    /** Canonical bytes of the embedded calibration (Decision 9's `maximumEmbeddedBytes` law). */
    embeddedCalibrationBytes: number;
    referencedRowSets: string[];
  };
}
```

The report satisfies the true Law-2 floor (`assumptions` object, `diagnostics.warnings` array), so
`createAnalysisArtifact` saves it verbatim; the artifact's `result` IS the report.

**The volatility families** (`VolatilityModelFamily`). The exhaustiveness law: every
`calibrate*` / `fit*` export of `@totalfinance/volatility` has a row, and a row names an export that
exists; a new calibrator without a row is a spec defect the manifest gate catches (the
`FITTED_MODEL_FAMILIES` descriptor is diffed against the manifest's `calibrate*`/`fit*` rows).
Every evaluator call below is the exact direct call with every non-default option threaded from the
stored fit or calibration; `values` is `(number | null)[]` with a per-point `reasons` entry for
every null (a failed inversion, a coordinate the model refuses) — never a NaN and never a silent
drop.

| family               | calibrator (verbatim result)                                     | `calibration` input (bulk row set in **bold** — Decision 9)                                                          | evaluator (`evaluateFittedModel` → direct call)                                                                                                                                                                                                                                                                                                                           | `summary.parameters`                                                                          | objective                                                                           | residuals                                                          | model risk                                                                                                |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `svi`                | `calibrateSvi` → `SVICalibrationResult`                          | `{ smile: SVISmileInput; options?: SVICalibrationOptions }`                                                          | `sviVolatility(fit.parameters, k, timeToExpiryYears)` at `{ logMoneyness: number[]; timeToExpiryYears?: number }`; the maturity is `at.timeToExpiryYears`, else `calibration.options.timeToExpiryYears`, else a teaching refusal ("pass a maturity, or call `sviTotalVariance` for total variance") — the unit never switches silently                                    | `a b rho m sigma`                                                                             | RMSE, total variance                                                                | `direct-evaluator` (`sviTotalVariance` at `smile.k` vs `smile.w`)  | `butterflyFree`, `minButterflyG`; calibrated `logMoneyness` range                                         |
| `ssvi`               | `calibrateSsvi` → `SSVICalibration`                              | `{ surface: SSVICalibrationInput; options?: SSVICalibrationOptions }` — **`surface.slices`**                         | `ssviVolatility(fit.parameters, k, t)` at `{ logMoneyness: number[]; timeToExpiryYears: number[] }` (the grid is the cross product)                                                                                                                                                                                                                                       | `rho`, `phi.*`, `thetaTerm.timeToExpiryYears[]`, `thetaTerm.theta[]`                          | RMSE, total variance (`perSliceRmse` rides verbatim in `fit`)                       | `direct-evaluator` over every slice point                          | `arbitrage.butterflyArbitrageFree` ∧ `calendarArbitrageFree`; `minButterflyG`, `sufficientConditionsHold` |
| `essvi`              | `calibrateEssvi` → `ESSVICalibration`                            | `{ surface: ESSVICalibrationInput; options?: ESSVICalibrationOptions }` — **`surface.slices`**                       | `essviVolatility(fit.parameters, k, t)` at the same grid shape                                                                                                                                                                                                                                                                                                            | `phi.*`, `thetaTerm.timeToExpiryYears[]`, `thetaTerm.theta[]`, `thetaTerm.rho[]`              | RMSE, total variance                                                                | `direct-evaluator`                                                 | as SSVI plus `minCalendarSlope`                                                                           |
| `sabr-smile`         | `calibrateSabrSmile` → `SABRCalibrationResult`                   | `{ smile: SABRSmileInput; options?: SABRCalibrationOptions }`                                                        | `@totalfinance/options` `sabrVolatility({ input: { forward: smile.forward, strike, timeToExpiryYears: smile.timeToExpiryYears }, parameters: fit.parameters, options: { volatilityType: fit.assumptions.volatilityType } })` at `{ strikes: number[] }`                                                                                                                   | `alpha beta rho nu`                                                                           | RMSE, implied volatility                                                            | `direct-evaluator`                                                 | `beta` fixed (echoed); `volatilityType`; strike range                                                     |
| `heston-surface`     | `calibrateHestonSurface` → `HestonSurfaceFit`                    | `HestonSurfaceCalibrationInput` — **`targets`**                                                                      | `@totalfinance/options` `hestonImpliedVolatility({ type, input: { spot, strike, timeToExpiryYears, riskFreeRate, dividendYield }, parameters: fit.parameters, options: { terms: calibration.options?.terms ?? 128, greeks: false } })` at `{ type: 'call' \| 'put'; strikes: number[]; timeToExpiryYears: number[] }`; a non-converged inversion → null with its `reason` | `kappa theta sigma rho v0`                                                                    | RMSE, implied volatility (`rmseTolerance` echoed)                                   | `direct-evaluator` with `type: 'call'` (the calibrator's own type) | Feller `2κθ ≥ σ²` (a parameter identity, not a pricing); k and t ranges                                   |
| `vanna-volga`        | `calibrateVannaVolga` → `VannaVolgaSmile`                        | `VannaVolgaInput`                                                                                                    | `calibrateVannaVolga({ ...calibration, strikes })` at `{ strikes: number[] }` (an exact pillar construction re-issued at new strikes — not a re-fit)                                                                                                                                                                                                                      | the three pillar strikes and volatilities                                                     | `exact-fit`, value 0                                                                | null (exact by construction)                                       | strike range; `deltaConvention`                                                                           |
| `vanna-volga-5`      | `calibrateVannaVolga5` → `VannaVolga5Smile`                      | `VannaVolga5Input`                                                                                                   | `calibrateVannaVolga5({ ...calibration, strikes })` at new strikes                                                                                                                                                                                                                                                                                                        | the five pillars                                                                              | `exact-fit`, value 0                                                                | null                                                               | strike range; `wingExtrapolation`                                                                         |
| `event-volatility`   | `calibrateEventVolatility` → `EventVolatilityCalibration`        | `FitEventVolatilityOptions` verbatim (`termStructure`, `eventDate`, `asOf`, `baseVolatility?`) — **`termStructure`** | `eventVolatilityAtExpiry({ fit, expiries })` at `{ expiries: string[] }` — the model's own forward evaluation `√(σ_base²·T + J²·[spans]) / √T`, added as a direct public function beside the calibrator in Decision 8 (the calibrator's `perExpiry.fittedVolatility` is computed through the same shared helper — one engine)                                             | `baseVolatility eventMove eventVariance daysToEvent`                                          | R² (`fit.rSquared`), total variance                                                 | `reported-by-calibrator` (`perExpiry[].residual`)                  | expiry range; `spansEvent` per expiry                                                                     |
| `event-move`         | `calibrateEventMove` → `EventMoveCalibration`                    | `{ observations: EventMoveObservation[] }` — **`observations`**                                                      | none — a historical statistic, not a model: `evaluator: null` with the reason                                                                                                                                                                                                                                                                                             | `ratio bias overpricedFraction meanAbsoluteError averageImplied averageRealized`              | `not-applicable` (reason: an aggregate of past events has no fitted objective)      | `reported-by-calibrator` (`perEvent[].error`)                      | `count`                                                                                                   |
| `garch`              | `fitGarch` → `GarchFit`                                          | `{ returns: number[]; options?: GarchFitOptions }` — **`returns`**                                                   | `garchForecast({ fit, lastVariance, horizonPeriods })` at `{ lastVariance: number; horizonPeriods: number }` — both caller-supplied (the fit does not carry the last conditional variance)                                                                                                                                                                                | `omega alpha beta persistence longRunVariance`                                                | log-likelihood (null with reason when degenerate)                                   | null (no per-point residual surface)                               | `persistence < 1` stationarity; `mean` policy                                                             |
| `har-rv`             | `fitHarRv` → `HarRvFit`                                          | `{ realizedVariances: number[]; options?: HarRvOptions }` — **`realizedVariances`**                                  | `harRvForecast(fit, history)` at `{ history: number[] }` — one step ahead only (`horizonKind: 'one-step-ahead'`)                                                                                                                                                                                                                                                          | `coefficients.const coefficients.daily coefficients.weekly coefficients.monthly`              | R² (null with reason for a flat response)                                           | `reported-by-calibrator` (`fit.residuals`)                         | `windows`                                                                                                 |
| `volatility-surface` | `volatilitySurface` → `VolatilitySurface` (stored as `toJSON()`) | `VolatilitySurfaceInput` — **`quotes`**                                                                              | `VolatilitySurface.fromJSON(fit).lookup(strike, expiry)` at `{ strikes: number[]; expiry: string \| number }` — the diagnostics-bearing form, so the surface's own `volatility.surface_extrapolated` warning is what discloses extrapolation                                                                                                                              | `model` + the global `ssvi.*` / `essvi.*` / `heston.*` parameters when the model carries them | `not-applicable` (reason: per-slice diagnostics ride verbatim in `fit.diagnostics`) | null                                                               | `fit.diagnostics`; strike/expiry ranges                                                                   |

**The fixed-income families** (`CurveModelFamily`). A `YieldCurve` or `SurvivalCurve` is a behavior
object; the artifact stores its **data members verbatim** (plus the one datum the members do not
show) and restores the behavior through the curve module's own builder:

```ts
/** A YieldCurve's own data — its non-method members plus the origin policy. */
interface YieldCurveData {
  referenceDate: string;
  dayCount: FixedIncomeDayCount;
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
  /** How `zeroRate(referenceDate)` is answered when a pillar sits on it: 'quoted' | 'limit'. */
  zeroRateAtOrigin: ZeroRateAtOrigin;
  pillars: CurvePillar[]; // { date, tenorYears, zero, discount }
}
/** A SurvivalCurve's own data. */
interface SurvivalCurveData {
  referenceDate: string;
  dayCount: FixedIncomeDayCount;
  pillars: SurvivalPillar[]; // { date, tenorYears, cumulativeHazard, survival, hazard }
}
```

Restore is byte-exact by construction, through the curve's own state rather than a public
constructor (slice 4 landing amendment). A `YieldCurve`'s canonical state is its continuous zeros
at pillar times (`buildCurve({ ts, zeros, dates, … })`; every pillar `discount` is
`exp(−zero·tenorYears)` of it), and the stored pillars carry exactly that state. The public
constructors cannot reproduce every curve bit for bit: `fromDiscountFactors` derives the zero as
`−ln D / t` and `fromZeroRates` round-trips the zero through its discount, so one of the two
derived fields moves by an ulp for a `curves.flat` / `fromZeroRates` input — and under zero-space
interpolation (`linearZero`, the flat curve's default) that ulp moves every query between
pillars, which made a hazard bootstrap replayed over a restored flat discount curve differ in the
last digits. So the restore rebuilds through the module's builder over the stored `tenorYears`
and `zero` (with `date` as the pillar label), and `yieldCurveDataOf` reads the one datum the
pillars do not show — whether `zeroRate(referenceDate)` echoes a quoted origin pillar or takes
the first segment's t → 0⁺ limit — off the curve's registered build state (`'quoted'` for
`fromZeroRates`, `'limit'` for `fromDiscountFactors`, bootstraps, and `flat`; a structurally valid
curve from another copy of the package is read off its behavior). Stored pillars whose
`discount` is not `exp(−zero·tenorYears)` were edited after the curve wrote them and are refused
(`input.wrong_shape`) with the rebuild-from-quotes remedy. Survival curves restore through
`credit.survivalFromHazards` over `pillars.map(p => [p.date, p.hazard])`, whose piecewise-constant
forward hazard IS the stored `hazard`. The exit law is **equality**, not a tolerance: `discount`,
`zeroRate`, `forwardRate`, `survival`, and `hazard` agree `===` at every pillar and on a
between-pillar grid, and a replay over restored input curves is byte-identical.

| family             | calibrator                   | stored `fit`                                                                                                | `calibration` input (behavior objects stored as data)                                                                             | evaluator                                                                                                  | objective         |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| `discount-curve`   | `curves.bootstrap`           | `YieldCurveData`                                                                                            | `{ instruments: BootstrapInstrument[]; options: BootstrapOptions }`                                                               | restored curve's `discount` / `zeroRate` / `forwardRate` / `instantaneousForward` at `{ dates: string[] }` | `exact-bootstrap` |
| `projection-curve` | `curves.bootstrapProjection` | `YieldCurveData`                                                                                            | `{ instruments; options: ProjectionBootstrapOptions }` — the adapter accepts the LIVE `discountCurve` and stores its data         | as above                                                                                                   | `exact-bootstrap` |
| `multi-curve`      | `curves.bootstrapMultiCurve` | `{ discountCurve: YieldCurveData; forecastCurve: YieldCurveData }` (the `MultiCurve` field names, verbatim) | `{ options: MultiCurveBootstrapOptions }` (`referenceDate`, `dayCount?`, `interpolation?`, `extrapolation?`, `ois`, `projection`) | both curves' evaluators at `{ curve: 'discountCurve' \| 'forecastCurve'; dates: string[] }`                | `exact-bootstrap` |
| `hazard-curve`     | `bootstrapHazardFromCds`     | `SurvivalCurveData`                                                                                         | `{ quotes: CdsQuote[]; options: HazardBootstrapOptions }` — the live `discountCurve: YieldCurve` is stored as `YieldCurveData`    | restored survival curve's `survival` / `hazard` / `defaultProbability` at `{ dates: string[] }`            | `exact-bootstrap` |

Every curve artifact input requires `currency` (echoed in `assumptions.currency`): the curve object
does not carry one, and a stored curve without a currency is a number without a unit. The objective
is `exact-bootstrap` with `value: null` and the reason "a bootstrap reprices its instruments exactly
by construction; repricing residuals are reported by `fittedModelHoldout`" (Decision 8).

**The snapshot bridge (Program 5's "used in a book/scenario calculation").** Two additive direct
mappers land on the `@totalfinance/fixed-income` root, both closed single-object requests:

- `yieldCurveFromRateCurve({ curve: RateCurve; interpolation: CurveInterpolation; extrapolation: CurveExtrapolation })`
  — the bond pricer's private `buildDiscountCurve` made public and unchanged in behavior (UTC
  midnight `asOf` → `referenceDate`; `curves.fromZeroRates` under the curve's own `dayCount` and
  `compounding`; a stored `interpolation` that conflicts with the requested one refuses exactly as
  the pricer does today). `bondDiscountCurvePricer` calls it afterwards — one engine.
- `rateCurveFromYieldCurve({ curve: YieldCurve; currency: string })` — core `RateCurve` data:
  `asOf` = the reference date at UTC midnight, `compounding: 'continuous'` (a `CurvePillar.zero`
  IS continuous — no option, no default), `points` = every pillar's `{ date, zeroRate: zero }`
  including the reference-date anchor (core accepts pillars at `asOf`), `interpolation` echoed. A
  curve whose `dayCount` is `ACT/ACT` or `30E/360` refuses with `InputInvalidEnum` and the teaching
  that core's `RateCurve` accepts `ACT/365F`, `ACT/360`, `30/360` — widening
  `RATE_CURVE_DAY_COUNTS` is a core market-data decision this stage does not take. A restored
  `discount-curve` fit therefore drops into `MarketSnapshot.observations.curves` and
  `bondDiscountCurvePricer` in one call, which closes Program 5's exit-gate clause for curves and
  the fixed-income half of Gate B's open "Domain mappers" box.

**Model versions.** Every family declares an integer `modelVersion` (all `1` at landing) in the
`FITTED_MODEL_FAMILIES` descriptor. It bumps when the calibrator's **result shape or meaning**
changes. Read policy is Gate B's applied at the report level (Decision 5): same version restores;
newer refuses (`artifact.model_version_unsupported`); older restores only through a registered,
family-scoped report migration. A report migration is a **shape** rewrite; it may not compute
parameters — a semantic change is a recalibration, and the artifact preserves the verbatim
`calibration` precisely so that `replayFittedModel` can re-issue it under the new semantics.

**The descriptor.** Each `./artifacts` subpath exports a frozen, data-only constant — Program 5's
"registry metadata" without a registry, and the one thing Stage 7A reads:

```ts
const FITTED_MODEL_FAMILIES: Readonly<Record<VolatilityModelFamily, FittedModelFamilyDescriptor>>;
interface FittedModelFamilyDescriptor {
  family: string; // 'ssvi'
  qualifiedFamily: string; // 'volatility.ssvi'
  modelVersion: number;
  calibrator: string; // 'calibrateSsvi'
  evaluator: string | null;
  warmStart: boolean; // Decision 8
  referenceableRowSets: readonly string[]; // Decision 9
  costClass: 'closed-form' | 'least-squares' | 'iterative-pricing' | 'bootstrap' | 'statistic';
  /** What the family needs (data) and what it answers (products) — prose, string-typed by design. */
  requiredData: string;
  supportedProducts: string;
}
```

**Rejected:** a universal `parameters: number[]` vector (a positional list hides units and
meaning — law 4); dropping the verbatim `fit` in favor of the summary (the summary is a projection;
the fit is the truth, and replay compares the truth); storing curves as core `RateCurve` (it has no
`extrapolation`, carries only zero rates so a `fromZeroRates` rebuild drifts by ulps from the
discount-anchored bootstrap, and cannot hold `ACT/ACT` / `30E/360` curves — the live object's own
data is the only lossless form); a `survivalCurveFromPillars` helper (`credit.survivalFromHazards`
already is that constructor); string model versions (`'ssvi/1'` cannot step through the one
migration registry Gate B allows).

## Decision 3 — one obvious call per verb

Each domain `./artifacts` subpath exposes the same eight verbs; their request objects are closed
(law 12) and their results are Law-2 reports or Gate B envelopes.

```ts
fittedModelArtifact(input: FittedModelInput & {
  snapshotHash?: string; libraryVersion?: string; createdFrom?: string[]; provenance?: Provenance;
}): AnalysisArtifact;                                                       // = createAnalysisArtifact over the projected report
readFittedModel(input: { artifact: AnalysisArtifact; migrations?: ArtifactMigrationRegistry }): {
  report: FittedModelReport; artifact: AnalysisArtifact;
  migrationsApplied: AppliedMigration[]; modelMigrationsApplied: AppliedMigration[];
};
evaluateFittedModel(input: { model: FittedModelReport | AnalysisArtifact; at: EvaluationOf<Family> }): FittedModelEvaluation;
replayFittedModel(input: { artifact: AnalysisArtifact; migrations?; referencedData?: Record<string, unknown[]>; libraryVersion?: string }): FittedModelReplay;
compareFittedModels(input: { baseline: FittedModelReport | AnalysisArtifact; candidate: same; tolerance?: ComparisonTolerance; evaluation?: ComparisonEvaluationOf<Family>; limits? }): FittedModelComparison;
warmStartFrom(input: { model: FittedModelReport | AnalysisArtifact }): WarmStartOf<Family>;
fittedModelStability(input: FittedModelStabilityInput): FittedModelStabilityReport;
fittedModelHoldout(input: FittedModelHoldoutInput): FittedModelHoldoutReport;
```

- **The report is not a separate verb.** `fittedModelArtifact(...).result` IS the projected report,
  and `readFittedModel(...).report` returns it typed; a `fittedModel` projection-only verb would be
  a second call for one concept (lovability rule 1).
- `fittedModelArtifact` is exactly
  `createAnalysisArtifact({ artifactType: '<package>.fitted-model', producedBy: { operation: <calibrator>, libraryVersion? }, inputs: { snapshotHash?, parameters: { family, modelVersion, calibrationHash } }, createdFrom?, result: <report>, tables: <referencedData>, provenance? })`.
  `inputs` carries **identity, not bulk** (Gate B Decision 5): the verbatim calibration lives once,
  in `result.calibration`; `calibrationHash` covers the embedded members and every referenced
  handle's hash. The `artifactType` names the package (`'volatility.fitted-model'`,
  `'fixed-income.fitted-model'`); the family lives in the result and in `inputs.parameters`, so the
  artifact id covers both.
- `readFittedModel` calls `readAnalysisArtifact` (hash and `inputsHash` re-verified; envelope
  migrations applied only through the caller's registry), refuses a foreign `artifactType` with
  the teaching that names the package that owns it (`artifact.family_mismatch`), applies the
  caller's registry a second time at the **report** level (Decision 5), re-validates the result as
  a report of a known family and version, and returns the typed report **with the envelope and
  both migration echoes** — Gate B's read report is never discarded.
- `evaluateFittedModel` accepts the report or the artifact (reading it first — the two request arms
  are structurally distinct: an envelope carries the literal `kind: 'totalfinance.analysis-artifact'`
  and `id`, a report carries `family`, `summary`, and `fit`; the generated closed-request spec
  selects the arm by that literal and structurally otherwise), dispatches to the family's direct
  evaluator with the fit's parameters verbatim, and returns
  `{ family, at, values: (number | null)[], reasons: Array<{ index: number; reason: string }>, unit, assumptions: { conventionsVersion, evaluator, options: <the non-default options threaded>, extrapolation: string }, diagnostics: { warnings: QuantWarning[]; outsideCalibratedRange: number } }`.
  A coordinate outside `summary.modelRisk.calibratedRange` is still evaluated (the model is
  defined there) but is counted and warned — with the EXISTING `volatility.surface_extrapolated`
  for every volatility family and the new `curve.extrapolated` for curves; a curve whose stored
  `extrapolation` is `'throw'` refuses exactly as the live curve does (the adapter never softens
  the curve's own law) — Program 5's "extrapolation regime" made visible, never silent.
- `replayFittedModel` re-issues the direct calibrator with the stored `calibration` verbatim
  (rebuilding behavior objects from stored data, substituting caller-supplied rows for referenced
  row sets after hash verification) and returns
  `{ recomputed: FittedModelReport, parity: ArtifactReplayParity, artifactId, assumptions, diagnostics }`
  (Decision 7). It exists because every family's replay is fully data-driven and the four steps
  (restore, rebuild, re-issue, byte-compare) are the same for all sixteen families — unlike the
  scenario runner's replay, which needs per-target behavior rebinding and so stayed a direct rerun
  (Decision 13 there).
- `compareFittedModels` refuses two different families with the teaching to use
  `compareAnalysisArtifacts` for a structural diff (Decision 6).
- `warmStartFrom` returns the family's start option filled from the saved fit (Decision 8) — the
  value a caller spreads into the next calibration's options. Families with no starting point
  refuse with `artifact.operation_unsupported` and the reason.

The research subpath exposes the analogous four verbs (`researchRunArtifact`, `readResearchRun`,
`replayResearchRun`, `compareResearchRuns`); research runs have no evaluator, warm start,
stability, or holdout — a screen is not a model.

## Decision 4 — research-run artifacts

**Decision.** A research run is one of the eleven FC3 operations' results, verbatim, plus the
inputs that reproduce it and an optional statistical-hygiene block:

```ts
type ResearchRunKind =
  | 'screen'
  | 'rank'
  | 'score' // screening.ts
  | 'event-study'
  | 'aggregate-event-studies' // events.ts
  | 'information-coefficient'
  | 'factor-spread-return'
  | 'factor-turnover'
  | 'factor-decay'
  | 'quantile-portfolios'
  | 'composite-factor-score'; // factors.ts

interface ResearchRunReport<Kind extends ResearchRunKind = ResearchRunKind> {
  kind: Kind;
  runVersion: number;
  /** The direct operation's result, verbatim. */
  run: RunOf<Kind>;
  /** The operation's input with bulk rows either embedded or replaced by verified table references. */
  inputs: Referenced<InputOf<Kind>>;
  /** Table references for every bulk row set that was not embedded (Gate B TableHandle). */
  referencedData: Record<string, TableHandle>;
  /** Statistical-hygiene results the caller attaches, verbatim — computed by @totalfinance/risk, never here. */
  hygiene: ResearchHygieneBlock | null;
  /** The versioned recipe the caller says produced the factor, when one did (FC3: a recipe is a versioned artifact). */
  recipe: FactorRecipe | null;
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    runVersion: number;
    operation: string; // 'screenUniverse', 'eventStudy', …
    replayable: boolean; // false exactly when a non-serializable callback participated
    /** The callback field that made the run non-replayable, when one did. */
    nonReplayableField: string | null;
    inputPolicy: 'embedded' | 'referenced';
    embeddedRowLimit: number;
    projection: string;
  };
  diagnostics: {
    warnings: QuantWarning[];
    embeddedRows: number;
    referencedRows: number;
    runWarningCount: number;
  };
}
```

- **Bulk row sets** per kind — `observations` (screen, rank, score); `events`,
  `returnObservations`, `marketReturns` (event-study); `studies` (aggregate-event-studies);
  `factorEntries`, `forwardReturns`, `entries`, `horizons[].forwardReturns`, `components[].entries`
  (the factor kinds); `previousPortfolios`, `currentPortfolios` (factor-turnover) — embed verbatim
  when their row count is at or below `embeddedRowLimit` (Decision 9). Above it, the caller passes a
  `TableHandle` per row set in `referencedData`; the handle's `contentHash` must equal
  `contentHash(rows)` over the canonical bytes of the rows the caller holds, and the report records
  the `rowCount`. Nothing is silently truncated.
- **Table handle minting** (`createTableHandle` needs `columnCount`): an array of records mints
  `columns` = the sorted union of the rows' own keys and `columnCount = columns.length`; an array
  of numbers (a GARCH `returns` vector in Decision 9's shared law) mints one column, `['value']`.
  The adapters expose this as the direct helper `tableHandleForRows({ rows })` on
  `@totalfinance/core/artifacts` so every package mints the same handle for the same rows.
- **Run-of-runs kinds.** `aggregate-event-studies` takes `EventStudyResult[]` and `factor-turnover`
  takes two quantile-portfolio results; they embed those prior results verbatim under
  `embeddedRowLimit` (a study or a portfolio set counts as one row), and the caller may pass the
  parent artifact ids in `createdFrom` so the lineage is walkable — no result is recomputed.
- **Transforms and recipes.** `winsorizeFactor`, `standardizeFactor`, `neutralizeFactor`, and
  `alignEventWindows` are not run kinds: their results become the next operation's input rows, and
  each is a Law-2 report the spine saves directly (`createAnalysisArtifact({ artifactType:
'research.transform', … })`) and links by `createdFrom` — one fixture proves it, no code. A
  `FactorRecipe` the caller used is passed as `recipe` and stored verbatim in the report (so it is
  covered by the artifact id); `CANONICAL_FACTOR_RECIPES` entries are exactly such values.
- **Replay** (`replayResearchRun({ artifact, migrations?, referencedData?: Record<string, unknown[]>, libraryVersion? })`)
  re-issues the direct operation with the embedded inputs, substituting caller-supplied rows for
  every referenced table after re-verifying each hash (`artifact.referenced_data_mismatch` on any
  difference); a run whose input carried a non-serializable callback (`customPredicate`, an
  `expectedReturnModel` of `model: 'custom'`) is `replayable: false` in the report — the callback
  field is recorded and the stored input omits it (the direct operation already classifies it as
  `'non-serializable caller predicate'`) — and `replayResearchRun` refuses with
  `artifact.not_replayable` naming the field.
- **The hygiene block** is a closed record of up to six verbatim risk results —
  `{ protocol?: ResearchVerdict; deflatedSharpe?: DeflatedSharpeResult; backtestOverfitting?: BacktestOverfittingProbabilityResult; leakage?: LeakageReport; parameterSweep?: ParameterSweepResult; multipleTesting?: MultipleTestResult }`
  (`adjustPValues`' result joins the block: it is the sixth hygiene function the queue names).
  `@totalfinance/research` may not import `@totalfinance/risk` (FC0 graph), so it declares these shapes
  structurally and validates **the fields it consumes** at the boundary: the block's own keys are
  closed, `protocol.verdict` is in its literal set, and every consumed number is finite OR a
  disclosed non-finite the producing law made legal (`minTrackRecordLength` is `Infinity` when the
  Sharpe is at or below its benchmark — the canonical serializer round-trips it). The copies are
  otherwise **open** structural artifacts (Law 12 `open` policy — risk's `assumptions` records are
  open by declaration), and a compile-time parity fixture in `tools/` asserts mutual assignability
  with risk's declarations (the `scenarios-signature-compatibility.compile.ts` precedent). The
  block is never recomputed here — Program 11 lineage, D7 no second engine. A hygiene result is
  also a Law-2 report in its own right (except `MultipleTestResult`, which carries no
  `assumptions` and rides only inside the block), saveable directly through
  `createAnalysisArtifact({ artifactType: 'risk.research-protocol', … })` and linked by
  `createdFrom` — one fixture proves it.
- **Identity:** `researchRunArtifact` is
  `createAnalysisArtifact({ artifactType: 'research.run', producedBy: { operation }, inputs: { snapshotHash?, parameters: { kind, runVersion, inputsHash: contentHash(embedded inputs), referenced: { <rowSet>: <contentHash> } } }, result: report, tables: referencedData })`
  — identity, not bulk; the referenced tables ride in the envelope's own `tables` slot, so the
  artifact id covers their hashes.
- **`RESEARCH_RUN_KINDS`** is the frozen descriptor
  (`{ kind, runVersion, operation, bulkRowSets, callbackFields, replayableWithoutCallbacks, costClass, requiredData }`),
  the research twin of `FITTED_MODEL_FAMILIES` (slice 5 landing amendment: `callbackFields` names
  the input fields that make a run non-replayable when they carry a caller function, and
  `requiredData` says in words what the kind consumes — the two members a reader asks first).
- **Slice 5 landing amendments.** (1) A run kind is identified by its operation's assumption
  signature, not by its top-level keys alone: `screen`, `rank`, and `score` results share
  `{ assumptions, diagnostics, rows }`, so `researchRunArtifact` also requires the assumption
  members the operation always reports (`orderBy` / `rankBy` + `tiePolicy` / `components`, …) and
  refuses a screen result saved under `'rank'` with the missing member named. (2) A row set is an
  array and its elements are its rows — each `EventStudyResult` in `studies` and each quantile
  portfolio in `previousPortfolios` / `currentPortfolios` counts as one row against
  `embeddedRowLimit`. (3) `Referenced<T>` is the deep mapping (every bulk array may be a handle,
  a function member is never stored), so a stored `factor-decay` input carries the handle inside
  `horizons[i]`. (4) Concrete row-set labels index wildcards (`horizons[0].forwardReturns`,
  `components[1].entries`) in `referenceRowSets`, `referencedData`, and replay. (5) The read
  door echoes both migration lists under the names Decision 5 fixes for every read door
  (`migrationsApplied`, `modelMigrationsApplied` — the second is the run-level list).

**Rejected:** embedding unbounded universes (Gate B Decision 5's "identity, not bulk"); a research
package dependency on risk for the hygiene types (the FC0 graph and layer law; risk composes
research outputs, not the reverse); auto-running `researchProtocol` inside the adapter (a hidden
second computation with hidden parameters); a closed-key validator over risk's results (it would
refuse legitimate results whose `assumptions` are open by declaration).

## Decision 5 — identity, save, restore, and migration (Gate B, applied at two levels)

- Every artifact is an `AnalysisArtifact`; `id` is the content hash of the body; `inputs.inputsHash`
  is stamped and re-verified; the top-level `conventionsVersion` is library-stamped; `provenance`
  sits outside the id (Gate B Decision 5). Nothing in this stage adds a second hash, a timestamp,
  a UUID, or a storage call.
- `libraryVersion` is caller-supplied and optional (the spine's law: the caller states what ran; no
  package introspection). Replay and comparison DISCLOSE a library-version difference as a warning
  (`artifact.library_version_differs`); they never refuse on it — numerical parity across library
  versions is the semantic-parity law's tolerance regime, not an identity law.
- **Envelope level (unchanged).** The envelope's `schemaVersion` is the `AnalysisArtifact` schema;
  `readAnalysisArtifact` applies the caller's registry to it under the kind
  `'totalfinance.analysis-artifact'`.
- **Report level (this stage).** The report's `modelVersion` / `runVersion` is an integer, and an
  older stored report restores only through steps registered in the SAME caller-supplied registry
  under a family-scoped kind: `'volatility.fitted-model:ssvi'`, `'fixed-income.fitted-model:
discount-curve'`, `'research.run:screen'`. The reader presents the report to the registry through
  its envelope view `{ kind, schemaVersion: <modelVersion>, report }`, so `registry.upgrade({
envelope: view, targetVersion })` runs the one policy Gate B already implements (single steps,
  human description, missing-link refusal, every step echoed); the reader unwraps the migrated
  `report` and validates it as current. Both echo lists are returned (`migrationsApplied`,
  `modelMigrationsApplied`). One registry, one policy, two levels; no auto-upgrade, no best-effort
  partial migration, and a migration may rewrite shape but never compute parameters.
- Restore is clock-free, locale-free, and consults no process-global registry; the migration
  registry is an argument (Decision 7 of Gate B).

## Decision 6 — comparison semantics

Two comparison laws, one structural and one typed. Both sides of every comparison are named
`baseline` and `candidate` — never `a` / `b` (law 4, lovability rule 2; single-letter tokens are
per-identity pardons reserved for the SVI parameter names).

**`compareAnalysisArtifacts({ baseline, candidate, tolerance?, limits? })` (core, structural).**
Refuses two different `artifactType`s (`artifact.type_mismatch` — the teaching names both types).
Otherwise walks both results' canonical forms leaf by leaf and reports:

```ts
interface ArtifactComparison {
  artifactType: string;
  identical: boolean; // same id
  artifactIds: { baseline: string; candidate: string };
  inputs: {
    sameInputsHash: boolean;
    sameSnapshotHash: boolean | null;
    parameterDifferences: ValueDifference[];
  };
  producedBy: {
    sameOperation: boolean;
    libraryVersions: { baseline: string | null; candidate: string | null };
    conventionsVersions: { baseline: string; candidate: string };
  };
  result: {
    differences: ValueDifference[];
    addedPaths: string[];
    removedPaths: string[];
    comparedLeafCount: number;
    truncated: boolean;
  };
  warningCounts: { baseline: number; candidate: number };
  withinTolerance: boolean | null; // null without a tolerance
  assumptions: {
    conventionsVersion: string;
    tolerance: ComparisonTolerance | null;
    limits: { maximumDifferences: number; maximumLeaves: number };
    comparison: string;
  };
  diagnostics: { warnings: QuantWarning[] };
}
interface ValueDifference {
  path: string;
  baselineValue: unknown;
  candidateValue: unknown;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  withinTolerance: boolean | null;
}
interface ComparisonTolerance {
  absolute: number;
  relative: number;
} // both required when given — a half-stated tolerance is a guess
```

Numeric leaves report absolute and relative deltas (relative null when the baseline is 0);
non-numeric leaves report the two values; paths use dot/bracket notation; arrays compare
positionally and report length differences as added/removed paths. Disclosed non-finite leaves
compare by their wrapper (`{ nonFinite }`) and never produce a NaN delta. `sameSnapshotHash` is null
when either side has no snapshot hash; a different snapshot is a warning
(`artifact.comparison_different_market`): the two fits are still comparable, but the reader is
told the market moved.

**`compareFittedModels` (domain, typed).** Same family required. Reports, beyond the structural
diff of the two verbatim fits:

- per-parameter deltas from `summary.parameters` (named, absolute and relative);
- objective delta with unit; convergence of both; residual RMS delta;
- `modelRisk` changes (an arbitrage-free fit that became arbitrageable is a named finding);
- `sameMarket: boolean | null`; `sameCalibrationInput: boolean` (calibration hashes);
- a **shared-grid evaluation difference** through the direct evaluator — the number a trader asks
  for first — with an explicit placement rule per family:
  - smiles (`svi`, `sabr-smile`, `vanna-volga*`): `gridPoints` (default 256) uniform in the
    union of the two calibrated log-moneyness (or strike) ranges;
  - surfaces (`ssvi`, `essvi`, `heston-surface`, `volatility-surface`): the same uniform
    log-moneyness grid crossed with the union of the two fits' calibrated maturities (the slices'
    or targets' `timeToExpiryYears`; the surface's expiries) — the evaluator budget counts the
    cross product;
  - `event-volatility`: the union of the two fitted expiries;
  - curves: the union of the two pillar dates, on `discount` and `zeroRate` (and `survival` /
    `hazard` for hazard curves);
  - `garch` / `har-rv`: NO default grid — the forecasting inputs are the caller's economics, so
    `evaluation` is REQUIRED for these families (`{ lastVariance, horizonPeriods: number[] }` /
    `{ history }`); omitted, the report carries `evaluation: null` with the reason;
  - `event-move`: `evaluation: null` (no evaluator).
    The section reports the maximum and root-mean-square difference, the grid, and the count of
    points where either side answered null.

**`compareResearchRuns` (research, typed).** Same kind required. Reports `sameUniverse` and
`sameAsOf` (null for the factor kinds, whose inputs carry neither), `sameFilter` / `sameRankBy` /
`sameComponents` where the kind has them, and per kind: membership (`entered`, `exited`, `kept`
counts and ids, listed up to `listedIds` with the remainder counted), rank moves (largest movers,
capped), score deltas (mean and maximum absolute, per-instrument up to the cap), exclusion-reason
deltas, information-coefficient and spread deltas, average-abnormal-return deltas per session
offset, and the hygiene verdict change when both carry a block.

**Rejected:** a single "similarity score" (a number that hides which parameter moved);
tolerance defaults (a hidden economic judgment — law 6 and lovability rule 6); silently comparing
two families (one `rmse` is total variance, another implied volatility — law 4); hidden forecast
horizons ("1, 5, 22 periods" is an economic constant the caller must state).

## Decision 7 — replay and parity

Replay is the producing operation re-issued, never a runner (Gate B Decision 7; scenario runner
Decision 13):

1. `readFittedModel` / `readResearchRun` restores and verifies the artifact (both migration
   levels);
2. the adapter re-issues the family's direct function with the stored, verbatim calibration/inputs
   (curves and hazard bootstraps rebuild their input curves from stored `YieldCurveData` through
   the curve module's stored-state rebuild, Decision 2; research and the referenceable calibration
   row sets substitute
   caller-supplied rows after hash verification);
3. `artifactReplayParity({ saved, recomputed, limits? })` (core) compares `canonicalJsonOf` bytes of
   the verbatim `fit` / `run` and lists the first `maximumDifferences` differing paths with values;
4. the replay report echoes `libraryVersion` (saved vs current, when the caller supplies the
   current one) and warns when they differ.

Parity is exact bytes, not a tolerance: a calibration is deterministic given its inputs, so a
byte difference is a finding (a changed calibrator, a changed dependency, a platform-math
difference) that the artifact makes visible. `fitGarch` is the one seeded calibration in the
library (three seeded restarts under `options.seed`, default `0x61726368`); its seed is part of the
stored `calibration.options`, so replay runs under the same seed and stays byte-exact — the family's
`modelRisk.notes` say so. (`hestonMonteCarlo*` are pricers, not calibrators.)

`ArtifactReplayParity` (core):

```ts
interface ArtifactReplayParity {
  identical: boolean;
  savedHash: string;
  recomputedHash: string;
  differences: ValueDifference[];
  truncated: boolean;
  assumptions: { conventionsVersion: string; comparison: 'canonical JSON bytes' };
  diagnostics: { warnings: QuantWarning[] };
}
```

## Decision 8 — warm starts, stability, and holdout diagnostics (Program 5, bounded, no second engine)

**Direct-API changes (all additive except the two renames; slice 2 lands them before any artifact
stores a fit, so no fixture's bytes churn within the stage).**

| direct function                        | change                                                                                                                                                                                                                                                                                                                                                                       | free start members (closed)                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `calibrateSvi`                         | `options.initialParameters?: { m: number; sigma: number }` — the outer search over `(m, σ)`; `a, b, ρ` are solved by the inner normal equations and are NOT accepted (a member the search cannot honor is refused, never ignored). The supplied start is tried FIRST; the four built-in starts still run; ties keep the first, so a warm start never loses to a cold fit.    | `m`, `sigma`                                 |
| `calibrateSsvi`                        | `options.initialParameters?: { rho: number; phi: SSVIPhi }` — `phi.kind` must equal the effective `options.phi` (else a teaching refusal); `thetaTerm` is fixed from the data and is not a start.                                                                                                                                                                            | `rho`, `phi.eta`/`phi.gamma` or `phi.lambda` |
| `calibrateEssvi`                       | `options.initialParameters?: { rho: number \| number[]; phi: SSVIPhi }` — a scalar `rho` broadcasts to every knot, an array must match the slice count; a supplied start REPLACES the internal SSVI warm start (echoed as `assumptions.initialParameters: 'supplied' \| 'ssvi-warm-start'`).                                                                                 | `rho[]`, `phi.*`                             |
| `calibrateSabrSmile`                   | `options.initialParameters?: { alpha: number; rho: number; nu: number }` — `beta` stays an option (fixed, never fitted).                                                                                                                                                                                                                                                     | `alpha`, `rho`, `nu`                         |
| `calibrateHestonSurface`               | `options.seed` is RENAMED `options.initialParameters` (same `Partial<HestonParameters>` semantics: unspecified members keep their data-derived starts). Law 4: `seed` names randomness everywhere else in the library; N9: the old key is deleted and refused with the teaching (naming ledger row).                                                                         | `v0`, `theta`, `kappa`, `sigma`, `rho`       |
| `volatilitySurface` (`SurfaceConfig`)  | `config.hestonSeed` is RENAMED `config.hestonInitialParameters` in the same commit — it threads into the option above, and the library keeps ONE name for one starting point.                                                                                                                                                                                                | as Heston                                    |
| `fitGarch`                             | `options.initialParameters?: { alpha: number; beta: number }` — replaces the primary `[0.05, 0.9]` start; `omega` is derived by variance targeting and is not a start; the three seeded restarts still run (`options.seed` keeps its randomness meaning).                                                                                                                    | `alpha`, `beta`                              |
| `calibrateEventVolatility` (beside it) | NEW direct evaluator `eventVolatilityAtExpiry({ fit: EventVolatilityCalibration; expiries: string[] })` → `{ values: number[]; rows: Array<{ expiry, timeToExpiryYears, spansEvent, value }>; assumptions; diagnostics }` — the model's forward ATM volatility; the calibrator's own `perExpiry.fittedVolatility` is computed through the same internal helper (one engine). | —                                            |
| `curves` (root)                        | NEW `yieldCurveFromRateCurve`, `rateCurveFromYieldCurve` (Decision 2); `bondDiscountCurvePricer` refactored to call the former.                                                                                                                                                                                                                                              | —                                            |
| `@totalfinance/core` root              | `requireRateCurveData` (the existing core `RateCurve` validator) becomes a public export, so the fixed-income mappers prove curve data through the ONE law the market snapshot applies — no second validator (decided at slice 2 landing).                                                                                                                                   | —                                            |

Every calibrator that gains `initialParameters` echoes `assumptions.initialParameters:
'supplied' | 'default'` (eSSVI: `'supplied' | 'ssvi-warm-start'`). A warm start changes where the
search begins, never the objective. `warmStartFrom` fills exactly the member set above from a saved
fit: `{ initialParameters: { m, sigma } }` for SVI, `{ initialParameters: { rho, phi } }` for
SSVI/eSSVI (eSSVI's per-knot `rho[]`), `{ initialParameters: { alpha, rho, nu } }` for SABR,
`{ initialParameters: { v0, theta, kappa, sigma, rho } }` for Heston,
`{ config: { hestonInitialParameters } }` for a `volatility-surface` whose `model` is `'heston'`,
`{ initialParameters: { alpha, beta } }` for GARCH. `vanna-volga*`, `event-*`, `har-rv`, and a
non-Heston `volatility-surface` refuse with `artifact.operation_unsupported` and the reason (exact
or closed-form fits have no search to start). The fixed-income subpath exports **no**
`warmStartFrom` and **no** `fittedModelStability` (slice 4 landing amendment): every curve family
is an exact bootstrap, so a verb that refused every input would be a dead door — the enforcement
gate reads a public function whose valid calls are all refused as defective, and it is right; the
descriptor's `warmStart: false` discloses the absence with its reason instead.

- **Stability.** `fittedModelStability({ family, calibration, restarts, perturbation: { relative }, seed, tolerance? })`
  re-runs the direct calibrator `restarts` times from starting points jittered around the base
  fit's free start members by a seeded, deterministic relative perturbation (the seed is REQUIRED
  and echoed — lovability rule 8; the generator is the library's `mulberry32`), and reports
  per-parameter minimum/maximum/standard deviation over `summary.parameters`, objective spread,
  the convergence count, and `stable: boolean | null` (null without a tolerance; with one, every
  parameter's spread within `tolerance`). Supported exactly for the warm-startable families;
  others refuse with the reason.
- **Holdout.** `fittedModelHoldout({ family, calibration, holdout })` where `holdout` is
  `{ indices: number[] }` or `{ everyNth: number; offset: number }` for cross-sectional families, and
  `{ lastCount: number }` for time-series families (a prefix fit with one-step-ahead forecast
  residuals through the direct forecaster — an interleaved split of a time series would be a
  plausible wrong answer; decided at slice 3 landing; GARCH refuses because its fit exposes no
  conditional-variance path to forecast from without a second recursion) (deterministic; no random
  split without an explicit seed, and no default split) — fits on the retained points through the
  direct calibrator, evaluates the direct evaluator on the held-out points, and reports in-sample
  and out-of-sample residual RMS/maximum with the counts (`residuals.source: 'direct-evaluator'`
  in both, consistent with Decision 2). The point set per family is the bulk row set (`smile`
  points, `slices[].k`, `targets`, `termStructure`, `returns`, `realizedVariances`, `quotes`);
  `vanna-volga*` and `event-move` refuse (no held-out evaluation exists). For curves, the twin
  diagnostic reprices every calibration instrument with the restored curve through the package's
  existing instrument valuation (the bootstrap's own residual function, exported
  package-internally) and reports the repricing residuals per instrument — Program 5's
  "residuals" for a family whose fit is exact by construction.

## Decision 9 — bounded synchronous work

Every verb is synchronous and returns a complete value, so it refuses unsafe work before
allocation, exactly as the scenario runner does (Decision 10 there). Limits are validated as
positive safe integers; a caller may lower a default or opt up to the hard maximum, never past it.

| Limit                                      | Default     | Hard maximum | Meaning                                                                                                                                   |
| ------------------------------------------ | ----------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `maximumEmbeddedBytes` (embedded input)    | `1_048_576` | `8_388_608`  | canonical bytes of an embedded calibration/run input; larger refuses (`artifact.embedded_input_too_large`) with the teaching to reference |
| `embeddedRowLimit` (bulk row sets)         | `5_000`     | `50_000`     | rows embedded per referenceable row set; above it a `TableHandle` is required                                                             |
| `maximumDifferences` (comparison, parity)  | `1_000`     | `100_000`    | differences retained; the rest are counted (`truncated: true`)                                                                            |
| `maximumLeaves` (comparison, parity)       | n/a         | `2_000_000`  | leaves walked by one comparison; above it the comparison refuses before walking                                                           |
| `restarts` (stability)                     | n/a         | `64`         | direct calibrations one stability call may issue                                                                                          |
| `gridPoints` (typed comparison)            | `256`       | `4_096`      | evaluator calls per fit per maturity in a typed comparison; surfaces multiply by the maturity count                                       |
| holdout evaluations                        | n/a         | `100_000`    | held-out points evaluated by one holdout call                                                                                             |
| `listedIds` (research comparison sections) | `200`       | `10_000`     | membership/mover ids listed; the remainder is counted                                                                                     |

**The scanner.** The byte and leaf preflights never clone or hash an oversized value first: they
run the stop-at-limit iterative scanner the scenario runner already implements
(`scanCanonicalData` — cycles, depth, custom prototypes, sparse arrays, symbols, accessors,
functions in data, and coercion hooks refused without invoking them; Barrier A's cost formula).
Slice 1 promotes it unchanged from `@totalfinance/scenarios/src/internal/data.ts` to
`@totalfinance/core/artifacts` (a public, manifest-classified helper) and `@totalfinance/scenarios` imports
it from there — one scanner, one cost law, no copy. `embeddedCalibrationBytes` is then the
canonical byte length of the embedded members, computed once, after the scan admitted them.

**One input policy for both subpaths.** The caller always passes the calibration WITH its rows (it just calibrated on them) and names the row sets to reference in `referenceRowSets`; the adapter mints each `TableHandle` through `tableHandleForRows` and stores it in the row set's place (decided at slice 3 landing — one call, no hand-minted handles, and the projection still sees the rows). `Referenced<T>` is the STORED shape: it replaces exactly the family's/kind's
declared bulk row sets (Decision 2's bold members; Decision 4's list) with `T[K] | TableHandle`;
every other member always embeds (it is small by construction, and the byte limit still applies).
A referenced row set is re-verified on replay by hash. `assumptions.inputPolicy` says which form
the artifact holds.

Counts follow the library's count-safety law (safe integers, caps, typed refusals for `2^32`,
`2^53 + 2`, `1e308`, negative, and fractional budgets).

## Decision 10 — failure behavior and stable codes

New `ErrorCode` members (registered in `@totalfinance/core`, codes gate):

| Code                                 | Owner  | Meaning                                                                                                       |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| `artifact.type_mismatch`             | core   | `compareAnalysisArtifacts` received two different `artifactType`s (core knows no family)                      |
| `artifact.family_mismatch`           | domain | a verb received an artifact/report of another package, family, or research kind                               |
| `artifact.model_version_unsupported` | domain | a stored `modelVersion` / `runVersion` newer than this build, or older with no registered report migration    |
| `artifact.not_replayable`            | domain | the stored inputs carried a non-serializable callback; replay cannot re-issue the call (the field is named)   |
| `artifact.referenced_data_mismatch`  | domain | caller-supplied rows do not hash to the artifact's table handle                                               |
| `artifact.embedded_input_too_large`  | core   | an embedded input exceeds `maximumEmbeddedBytes`                                                              |
| `artifact.operation_unsupported`     | domain | the family has no evaluator / warm start / stability / holdout (the teaching names the family and the reason) |

New `WarningCode` members: `artifact.library_version_differs`,
`artifact.comparison_different_market`, `curve.extrapolated`. Volatility extrapolation reuses the
existing `volatility.surface_extrapolated` (no second name for one warning — law 4).

Every `diagnostics.warnings` entry in this stage is a `QuantWarning` (`{ code, message, severity, context? }`) so a warning is machine-readable by its registered code, never a bare string.

Every request is closed (law 12) and validated at runtime (law 15) with teaching errors that name
the field, the expected shape or unit, and a corrected minimal call; `null` is never coalesced into
omission; hostile inputs (accessors, `toJSON` hooks, class instances, cycles) are refused at the
boundary and never reach a calibrator. Results are deeply frozen and finite (law 7); undefined
metrics are `null` with a reason.

## Decision 11 — determinism, immutability, provenance

- No verb reads a clock, locale, environment, or process-global registry; the migration registry
  and every behavior are arguments.
- No verb mutates a fit, calibration input, artifact, table, or option object; reports snapshot
  their inputs (deep copy, deep freeze).
- `snapshotHash`, `createdFrom`, `provenance`, `libraryVersion`, `modelVersion`, and the
  calibration hash survive save → restore → evaluate → compare → replay unchanged (lovability rule
  10); a comparison names both artifact ids and a replay names the id it read.

## Ordered implementation slices

Only one slice owns shared contracts at a time. Every slice formats only changed files, runs
strict typecheck/lint/build, regenerates every source-owned artifact through the one chain
(signature → naming → contract → enforcement → validation → api → README/llms → bundle → docs),
hand-classifies every new export in its manifest, runs the affected package and architecture
suites, and lands with tests, generated evidence, and a slice record in this file. Direct-API
changes land BEFORE any artifact stores a fit (slice 2 before 3), so no stored fixture's bytes
churn inside the stage.

| Slice | Contents                                                                                                                                                                                                                                                                                                                                                                    | Evidence at landing                                                                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Core structural contracts: `FittedModelSummary` + validator, `ComparisonTolerance`, `ValueDifference`, `compareAnalysisArtifacts`, `artifactReplayParity`, `tableHandleForRows`, the promoted `scanCanonicalData` (scenarios re-pointed, no behavior change), the error/warning codes, the bounded walk.                                                                    | Hand-computed comparison and parity fixtures incl. non-finite wrappers, truncation, tolerance verdicts, hostile inputs; the scenarios suite unchanged; manifest rows; the `@totalfinance/core/artifacts` budget reconciled from evidence.    |
| 2     | Direct-API changes: `initialParameters` on SVI/SSVI/eSSVI/SABR/GARCH with the `assumptions.initialParameters` echo; the Heston `seed` → `initialParameters` and `hestonSeed` → `hestonInitialParameters` renames (naming ledger, refused old keys); `eventVolatilityAtExpiry`; `yieldCurveFromRateCurve` (extracted; pricer re-pointed) and `rateCurveFromYieldCurve`.      | Warm-start fixtures (supplied start echoed; SVI never worse than cold on the penalized objective); old-key refusal evidence; the pricer's suite unchanged; `ACT/ACT` refusal teaching; mapped-curve equivalence (`bondDiscountCurvePricer`). |
| 3     | `@totalfinance/volatility/artifacts`: the twelve families' projections, `FITTED_MODEL_FAMILIES`, the eight verbs incl. `warmStartFrom`, `fittedModelStability`, `fittedModelHoldout`; referenced row sets; extrapolation warnings.                                                                                                                                          | One fixture per family: describe → save → `canonicalJsonOf`/`fromCanonicalJson` round trip → restore → evaluate equals the direct call → replay parity identical → compare against a shifted fit; stability and holdout fixtures.            |
| 4     | `@totalfinance/fixed-income/artifacts`: the four curve families over `YieldCurveData` / `SurvivalCurveData`; restored-curve equality law; curve repricing residuals in `fittedModelHoldout`; the snapshot bridge fixture (restored curve → `rateCurveFromYieldCurve` → `MarketSnapshot` → `bondDiscountCurvePricer` equals the live curve's price).                         | Round-trip and parity fixtures per family; `===` equality at and between pillars; hazard bootstrap replay with a stored discount curve; repricing residuals hand-checked.                                                                    |
| 5     | `@totalfinance/research/artifacts`: the eleven run kinds, embedded/referenced rows, `recipe`, the hygiene block with its compile-time parity fixture, `replayResearchRun` with verified referenced data, `compareResearchRuns`, `RESEARCH_RUN_KINDS`; the direct-save fixtures for hygiene results, transforms, and `fitGeneralizedParetoTail`.                             | Screen/rank/score/event-study/factor fixtures incl. referenced-data replay, hash mismatch refusal, non-replayable callback refusal, membership/rank deltas, `Infinity` `minTrackRecordLength` round trip.                                    |
| 6     | Packed consumers (Node, browser bundle in `node:vm`, worker) for save → JSON → restore → evaluate → replay parity across the three subpaths; README snippets; generated docs; the three new entrypoints' `package.json` exports (trailing `default`), vitest aliases, manifest entrypoints, and bundle budgets from evidence; tracker and queue closeout; next-row handoff. | Packed hashes agree across environments; every controlling tracker names the same commit; the preview lane's next rows are obvious.                                                                                                          |

**Ratchet consequences named up front (so no slice discovers them).** Three new `./artifacts`
entrypoints each need a `package.json` `exports` entry ending in `default`, a `vitest.config.ts`
alias, manifest `entrypoints` rows, and a `tools/bundle-size/budgets.ts` entry; every new export is
a closed single-object request (no new multi-arg positional export, so no deep-sweep fixture is
required beyond the first-touch happy-path fixtures every analysis export gets); the umbrella budget
does not move (nothing rides it); `@totalfinance/core/artifacts` grows by the comparison walk, the
summary validator, and the scanner (expected +3 to +5 KB gzip, reconciled from evidence);
`@totalfinance/scenarios` re-points to the promoted scanner (measured at landing: it grew 0.8 KB, the
scanner's closed options request, not shrank); the research root budget is unchanged.

## Acceptance and exit gate

### API and directness

- [x] Every direct calibration, research, hygiene, curve, backtest, performance, and risk function
      keeps its signature and behavior; the only direct-API changes are those in Decision 8's table
      (additive options and evaluators, the two renames recorded in the naming ledger, and the
      pricer's internal re-point to the public mapper).
- [x] A cold TypeScript user runs each subpath's README example (save → `canonicalJsonOf` →
      `fromCanonicalJson` → restore → evaluate → replay → compare) with no cast, class, registry,
      storage adapter, or provider.
- [x] Exported declarations narrow every family/kind union; a report passes directly to
      `createAnalysisArtifact` with no escape hatch.
- [x] JavaScript receives the same teaching errors for every malformed request.
- [x] The three subpaths are package-direct; the umbrella and every package root are unchanged.

### Grammar, identity, and replay

- [x] Every `calibrate*` / `fit*` export of `@totalfinance/volatility` and every fixed-income bootstrap
      has a family row, a projection, an evaluator or a recorded reason, a descriptor entry, and a
      fixture; the descriptor lists no family the code lacks and no calibrator the descriptor lacks.
- [x] Projections are verbatim: the stored `fit`/`run` deep-equals the direct result; saving
      through `createAnalysisArtifact` is the identity on it; `inputs.parameters` carries hashes,
      never bulk.
- [x] Restore re-verifies the body hash and `inputsHash`; a tampered artifact, an unknown family, a
      newer `modelVersion`, an older one with no registered report migration, and a foreign
      `artifactType` are refused with their stable codes; a registered report migration is applied
      and echoed in `modelMigrationsApplied`.
- [x] Replay parity is byte-identical for every family and kind on the fixtures (GARCH under its
      stored seed); a deliberately changed calibration input yields a non-identical parity report
      naming the first differing paths.
- [x] Referenced rows (research and the referenceable calibration row sets) replay only when their
      hashes match; a mismatch refuses; a non-serializable callback is `replayable: false` and
      refuses replay by name.

### Evaluation, comparison, and diagnostics

- [x] `evaluateFittedModel` equals the direct evaluator field-for-field on every family that has
      one (every non-default option threaded: SABR `volatilityType`, Heston `terms` and `type`,
      SVI maturity), including the restored `VolatilitySurface` and every curve at and between
      pillars under `===`.
- [x] Extrapolation outside the calibrated range is counted and warned (`volatility.surface_extrapolated`,
      `curve.extrapolated`), never silent; a curve's `extrapolation: 'throw'` still throws.
- [x] `compareAnalysisArtifacts` refuses different types, reports every leaf difference up to the
      cap with `truncated` honesty, handles disclosed non-finite wrappers without a NaN, and answers
      `withinTolerance` only under an explicit two-sided tolerance.
- [x] `compareFittedModels` / `compareResearchRuns` report the typed deltas in Decision 6 on
      hand-computed fixtures, including a market-moved warning, an arbitrage-status change, the
      stated grid placement, and a null `evaluation` with reason for a forecasting family without
      caller-supplied inputs.
- [x] Warm starts change only the starting point (same objective, echoed; unsupported members
      refused); stability and holdout reports are deterministic under their seed/split, bounded,
      and refuse unsupported families.
- [x] A restored discount curve prices a bond through `bondDiscountCurvePricer` via
      `rateCurveFromYieldCurve` to the same value as the live curve (Program 5's book clause).

### Determinism, safety, and bounded work

- [x] Same inputs produce byte-identical artifacts and reports in Node, a browser bundle, and a
      worker.
- [x] Every limit in Decision 9 refuses absurd counts with typed errors before allocation; an
      oversized embedded input refuses with the teaching to reference it, through the promoted
      scanner, without cloning or hashing it first.
- [x] No verb mutates its inputs; every result is deeply frozen and finite; hostile inputs never
      reach a calibrator.
- [x] No package reads a clock, network, credential, database, provider, or process-global registry.

### Repository evidence

- [x] Every new export is hand-classified in its manifest on its first commit; naming, signature,
      runtime, field, result, finite-success, realization, declared-coverage, count-safety, and
      spec-mapping ratchets carry zero new debt; the naming ledger records both renames.
- [x] API reports, generated README/llms references, package inventories, umbrella symmetry,
      layer/package graph, codes, export maps, and generated-output drift gates are green.
- [x] Packed Node/browser/worker consumers use tarballs, not workspace aliases.
- [x] Measured package/entrypoint gzip budgets are updated from evidence with stated headroom.
- [x] Full affected tests and the full repository typecheck/lint/build/test/api gate are green at
      one exact commit named in every controlling tracker.

## Slice 1 (landed 2026-09-02) — core structural contracts

Executes the spine half of Decisions 2, 4, 6, 7, 9, and 10: the grammar every calibration adapter
projects into, the two comparison laws, the promoted bounded scanner, the row-set handle law, and the
stable codes — with no domain semantics (core still knows no model).

### What landed (`@totalfinance/core/artifacts`, all subpath-only)

- **`scanCanonicalData` / `CanonicalDataScanOptions` / `canonicalStringWorkUnits` /
  `CANONICAL_DATA_MAX_DEPTH`** (`canonical-scan.ts`) — the Stage 4.4b Barrier A scanner promoted
  verbatim in behavior (cost law, refusals without invocation, stop-at-limit budget), with its
  options object now a closed, typed request (unknown keys, missing names, malformed limits
  refuse) and a zero work budget admitted as "nothing left" (the runner passes an exhausted
  remainder and expects the limit refusal). `@totalfinance/scenarios/src/internal/data.ts` imports and
  re-exports it; its 521-test suite passes unchanged.
- **`compareAnalysisArtifacts` / `artifactReplayParity`** (`comparison.ts`) — Decision 6/7 exactly:
  `baseline` / `candidate` naming, canonical-tree walk (objects by key set, arrays positionally with
  trailing extras as added/removed paths, numbers by `candidate − baseline` and relative over
  `|baseline|`, disclosed non-finite leaves by their wrapper — no NaN delta can be produced), an
  explicit two-sided tolerance (`|Δ| ≤ absolute + relative · |baseline|`) with `withinTolerance`
  null without one, honest truncation (`truncated`, `differenceCount`), `artifact.type_mismatch`
  on different types, market-moved and library-version WARNINGS, both sides proven through the
  scanner before the read door copies or hashes them, and count-safe `limits` (defaults 1,000 /
  2,000,000; hard maxima 100,000 / 2,000,000 — `COMPARISON_LIMITS`). Parity is byte-exact over
  `contentHash`, and a saved or recomputed side must be a plain object (a bare `null` "result" was
  the one defect the enforcement probe found in the first measurement; it is refused now).
- **`FittedModelSummary` / `requireFittedModelSummary` / `isFittedModelSummary`**
  (`fitted-model-summary.ts`) — the Decision 2 grammar with its complete validator: closed keys at
  every level, dot-namespaced `family`, positive-integer `modelVersion`, flat finite parameters
  (dot paths for nested members), the objective-reason law (a null value needs a reason, a number
  refuses one), ordered calibrated ranges, content-hash identities, and a hostile-shape scan
  before any field is read. The predicate is the validator behind a boolean door.
- **`tableHandleForRows`** (`table-handle.ts`) — Decision 4's one column law (records → sorted
  key union; numbers → `['value']`; mixed or nested rows refuse with the projection teaching) over
  `contentHash(rows)`, so a receiver proves supplied rows are the referenced ones by re-minting.
- **Codes** — `artifact.type_mismatch`, `artifact.family_mismatch`,
  `artifact.model_version_unsupported`, `artifact.not_replayable`,
  `artifact.referenced_data_mismatch`, `artifact.embedded_input_too_large`,
  `artifact.operation_unsupported`; warnings `artifact.library_version_differs`,
  `artifact.comparison_different_market`, `curve.extrapolated`. Every warning this stage emits is
  a `QuantWarning` with a registered code (Decision 10).

### Enrolment (the package stays measured whole)

- Nine hand-classified manifest rows in `tools/manifest/packages/core.json` (two constants, six
  helpers incl. the two `open`-policy predicates/scanner with their policy notes, two `analysis`
  reports, one `artifact` constructor); six first-touch fixtures in
  `tools/first-touch/fixtures/core-artifacts.ts`.
- Regeneration chain green end to end; enforcement `candidates 5,129 · enforced 2,364 ·
partial 2,584 · unmeasured 181 · defective 0 · direct failures 0` (the first measurement's one
  defective record, `artifactReplayParity` accepting `saved: null`, was fixed at the source, not
  ledgered).
- Bundle budgets reconciled from evidence in `tools/bundle-size/budgets.ts`: `@totalfinance/core/artifacts`
  16.5 → 23 KB (measured 23,159 B: the scanner, the comparison walk, the summary validator,
  `tableHandleForRows`); the ten registered codes moved six thin-headroom entrypoints that carry
  core's central tables whole — `options/black-scholes` 10.75 → 11, `performance/sharpe` 7.75 → 8,
  `technical-analysis/rsi` 7.5 → 7.75, `fixed-income/lattice` 12 → 12.25,
  `fixed-income/convertible` 8 → 8.25, `commodities` 10 → 10.25 KB (each 18–155 B over its old
  line, no new imports). `@totalfinance/scenarios` measured 69.2 KB under its unchanged 70 KB; the
  umbrella 567.0 KB under its unchanged 567 KB.
- Tests: 39 new test cases across four files (`artifacts-canonical-scan`,
  `artifacts-comparison`, `artifacts-fitted-model-summary`, `artifacts-table-rows`) — the cost
  law's golden values, refusals proven without invocation, the stop-at-limit budget, leaf-by-leaf
  honesty incl. non-finite wrappers and truncation, tolerance verdicts, type-mismatch and
  tampered-artifact refusals, count-safety of every limit, the summary honesty rules, and the
  column law.

### Acceptance laws this slice closes (partial rows of the exit gate)

- `compareAnalysisArtifacts` refuses different types, reports every leaf difference up to the cap
  with `truncated` honesty, handles disclosed non-finite wrappers without a NaN, and answers
  `withinTolerance` only under an explicit two-sided tolerance — **closed**.
- Every limit in Decision 9 that core owns (`maximumDifferences`, `maximumLeaves`, the scanner's
  `maximumWorkUnits` / `maximumDepth`) refuses absurd counts with typed errors before allocation —
  **closed for core**; the domain limits close with their slices.
- Manifest, naming, signature, contract, enforcement, validation, api, docs, and bundle gates green
  at this commit with zero new debt — **closed for this slice**.

### Deferred by this slice (each with its decided home)

- Nothing from Decision 1's core row. The domain verbs, families, and descriptors are slices 3–5;
  the direct-API warm-start options and renames are slice 2 (next).

## Slice 2 (landed 2026-09-02) — direct-API warm starts, the two renames, and the curve mappers

Executes Decision 8's direct-API table before any artifact stores a fit (the X1 discipline), so every
stored fixture from slice 3 onward carries the final shapes.

### What landed

- **Warm starts, per family, in the free members only.** `calibrateSvi` takes
  `initialParameters: SVIWarmStart` (`{ m, sigma }` — a NAMED interface so the canonical `m` has
  one naming scope, the `SSVIPhi` precedent), tried FIRST ahead of the four built-in starts so a
  warm start is never worse than cold; `calibrateSsvi` `{ rho, phi }` and `calibrateEssvi`
  `{ rho: number | number[], phi }` (a scalar ρ broadcasts, an array must match the knot count, and
  a supplied start REPLACES the internal global-SSVI warm start — `assumptions.initialParameters:
'supplied' | 'ssvi-warm-start'`, `diagnostics.method` names which ran) share one internal start
  validator that refuses a start in the other φ family; `calibrateSabrSmile` `{ alpha, rho, nu }`
  (β stays an option); `fitGarch` `{ alpha, beta }` replaces the primary `(0.05, 0.90)` start
  while the three seeded restarts still run and `seed` keeps its randomness meaning. Every
  calibrator echoes `assumptions.initialParameters`; a member the search cannot honor (`a`, `b`,
  `ρ` for SVI; `thetaTerm`; `β`; `ω`) is an unknown key, refused with the did-you-mean teaching.
- **The renames, clean (N9/N10).** `calibrateHestonSurface`'s `options.seed` is
  `options.initialParameters` (same partial-pin semantics, echoed as `'supplied' | 'default'`) and
  `SurfaceConfig.hestonSeed` is `hestonInitialParameters`; both old keys throw
  `input.unknown_field` naming the replacement. Two `COMPILE_FAIL_FIXTURES` (`landsIn: '4.5'`) with
  runtime rejection evidence in `tools/naming-removals.test.ts`; the settled-vocabulary table gained
  the `seed` → `initialParameters` row; the retired-forms count is 96 of 96.
- **`eventVolatilityAtExpiry({ fit, expiries })`** — the event-volatility family's forward door. The
  calibrator now exposes the exact `baseVariance` beside `baseVolatility` (as `eventVariance` sits
  beside `eventMove`) and records `assumptions.asOf`, so the evaluator reproduces
  `perExpiry.fittedVolatility` bit for bit through the one shared formula and needs no second
  maturity origin. Its `fit` is proven whole by a generated closed-request spec (the roster gained
  the boundary): a hand-built partial fit teaches instead of mispricing.
- **`yieldCurveFromRateCurve` / `rateCurveFromYieldCurve`** on the fixed-income root
  (`curve-mappers.ts`). The former is the bond pricer's private `buildDiscountCurve` made public and
  unchanged; the pricer calls it and re-throws its refusals under `pricer.observation_invalid` with
  the curve identity (its adapter tests pass unchanged). The latter emits core data proven by core's
  `requireRateCurveData` (now a public core export) — every pillar including the anchor, continuous
  zeros, interpolation echoed, `ACT/ACT`/`30E/360` refused by name — and round-trips to an equal
  curve at and between pillars. A half-object is not a curve: every declared method and convention
  is checked (the enforcement probe found the two-method guard accepting a nulled `addSpread`; it is
  complete now).

### Enrolment

- Manifest rows: `eventVolatilityAtExpiry` (analysis/report, `.` + `./earnings`),
  `yieldCurveFromRateCurve` and `rateCurveFromYieldCurve` (artifact, root), core
  `requireRateCurveData` (helper, root; signature-policy CORE_INFRASTRUCTURE row); first-touch
  fixtures for all four (join pin 1,099 → 1,103); the `SVIWarmStart` scoped-symbol pardon.
- Regeneration chain green; enforcement `candidates 5,138 · enforced 2,364 · partial 2,593 ·
unmeasured 181 · defective 0 · direct failures 0` (the first measurement's six defective records —
  the curve half-object and the evaluator's unproven `fit` shape, mirrored through umbrella
  aliases — were fixed at the source).
- Budgets: the umbrella 567 → 570 KB (measured 583,351 B = 569.7 KB, headroom 329 B — the warm
  starts, the evaluator with its generated spec, the mappers, and the core validator on the root);
  `@totalfinance/core` root 14.8 → 16.5 KB under its unchanged 20 KB (the market-data validators now
  ride the root).
- Tests: 21 new test cases (`warm-starts`, `event-volatility-evaluator`, `curve-mappers`, the two
  removal-evidence cases); two pre-existing hand-built `GarchFit` literals gained the echo field.

### Acceptance laws this slice closes

- The only direct-API changes are Decision 8's table plus the two additions decided at landing
  (`baseVariance`/`assumptions.asOf` on the event fit; `requireRateCurveData` public) — every other
  direct function keeps its signature and behavior — **closed**.
- Warm starts change only the starting point (same objective, echoed; unsupported members refused)
  — **closed**.
- A restored discount curve prices a bond through `bondDiscountCurvePricer` via the mapper to the
  same value as the live curve — **closed** (`curve-mappers.test.ts`, the pricer parity case).

### Deferred by this slice

- Nothing. `warmStartFrom`, stability, and holdout consume these options in slice 3.

## Slice 3 (landed 2026-09-02) — `@totalfinance/volatility/artifacts`

Executes Decisions 1–3 and 5–9 for the twelve volatility families: the subpath-only adapter, the
family table, the eight verbs, and the descriptor.

### What landed

- **`fitted-model-families.ts`** (internal) — one row per `calibrate*` / `fit*` export: the direct
  calibrator to re-issue, the pure projection into core's `FittedModelSummary` (dot-path flattening
  for `phi.*`, `thetaTerm.*`, `coefficients.*`; residuals `direct-evaluator` where the family has
  an evaluator over its calibration points, `reported-by-calibrator` where the fit carries them,
  `null` with the reason where neither exists), the exact evaluator call with every non-default
  option threaded (SABR `volatilityType`, Heston `type` + `terms` with a null-with-reason on a
  failed inversion, the SVI maturity rule, the surface's diagnostics-bearing `lookup`), the warm
  start it fills, the free start members it perturbs, the bulk row set it may reference, and its
  holdout partition. `FITTED_MODEL_FAMILIES` is the frozen data projection of that table.
- **`fitted-model-artifacts.ts`** (public through `./artifacts`) — `fittedModelArtifact`
  (identity in `inputs.parameters`, bulk once in `result`, `referenceRowSets` minting handles,
  the scanner preflight re-voiced as `artifact.embedded_input_too_large` with the referencing
  teaching, exact canonical-byte and row limits), `readFittedModel` (Gate B read door → foreign
  type refusal naming the owning package → the caller's registry applied a second time under the
  family-scoped kind `volatility.fitted-model:<family>` through the `{ kind, schemaVersion, report }`
  view → report re-validation, both echo lists returned), `evaluateFittedModel` (values with
  per-point reasons, coordinates, extrapolation counted against the STORED calibrated range so a
  referenced artifact still discloses it), `replayFittedModel` (referenced rows re-verified by hash,
  `artifactReplayParity` byte parity, library-version disclosure), `compareFittedModels`
  (baseline/candidate, named parameter deltas — unchanged parameters are not differences — the
  structural fit diff through the parity walk, and the shared-grid evaluation difference under the
  per-family placement rule; forecasting families require caller-supplied `evaluation`),
  `warmStartFrom`, `fittedModelStability` (seeded `mulberry32`, domain-clamped perturbations of the
  free start members, per-parameter spread, convergence count, tolerance verdict), and
  `fittedModelHoldout` (deterministic cross-sectional splits, the time-series prefix split for
  HAR-RV, refusals with reasons for GARCH, the exact pillar constructions, and the statistic).
- **Decisions at landing.** (1) The caller names row sets to reference (`referenceRowSets`) and
  the adapter mints the handles — one call, no hand-minted handles, the projection still sees the
  rows; the stored shape is exactly Decision 9's. (2) Time-series holdout is a prefix split
  (`{ lastCount }`); GARCH holdout is refused with the reason. (3) `fittedModelArtifact` accepts
  the live `VolatilitySurface` and snapshots it. (4) The subpath deliberately bundles the whole
  family table (every calibrator and evaluator plus the spine): 84,979 B gzip, budget 85 KB — a
  consumer that only calibrates imports the calibrator subpath and pays none of it.

### Enrolment

- `./artifacts` export map entry (trailing `default`), vitest alias, twelve manifest rows (three
  constants, one artifact constructor, two helpers, six analysis reports), eight first-touch
  fixtures (`volatility-artifacts.ts`; join pin 1,103 → 1,111), the `'har-rv'` canonical-term
  pardon (the family literal spells the model as `fitHarRv` does).
- Regeneration chain green; enforcement `candidates 5,146 · enforced 2,368 · partial 2,597 ·
unmeasured 181 · defective 0 · direct failures 0` (the first measurement's one defect —
  `referenceRowSets: null` coalesced into omission — fixed at the source).
- Tests: 21 test cases in `fitted-model-artifacts.test.ts` — every family through describe →
  save → canonical round trip → restore → evaluate equals the direct call → replay parity
  byte-identical → compare against a shifted fit; the descriptor law; the read-door refusals and
  a registered report migration; referenced rows (handle stored, hash-verified replay, mismatch
  and missing-rows refusals, over-limit rows and bytes with the teaching); warm starts,
  seeded/deterministic stability, deterministic holdout; comparison honesty. The whole volatility
  suite passes unchanged beside it.

### Gate findings at landing (each fixed at its source, none ledgered)

- The enforcement probe: `referenceRowSets: null` coalesced into omission — refused now.
- Count safety: every count that rides a supplied fit, report, or artifact (`iterations`,
  `warningCount`, `fitWarningCount`, `residuals.count`, `result.*`) is a reported fact, not a
  budget — one policy branch in `count-semantics.ts` classifies those coordinates as magnitudes;
  the verbs' own budgets stay resources and `holdout.lastCount` gained its variant fixture in
  `overflow-variants.ts`.
- Union parity: `VolatilityFittedModelReport<F>` / `FitOf<F>` are declaration templates over the
  twelve-family union (the checker distributes F, the artifact records the erased declaration) —
  the five report/fit parameters joined the uninstantiated-template route list, and the two read
  doors' function-membered registry joined the undescribed allowlist, both with reasons.
- Internal signatures: the comparison grid helper takes one named request (three positional
  numerics are an unreviewed vector).
- The published bundle table pins its row count: 20 → 21.

### Acceptance laws this slice closes (volatility rows)

- Every `calibrate*` / `fit*` export has a family row, a projection, an evaluator or a recorded
  reason, a descriptor entry, and a fixture — **closed for volatility** (`FITTED_MODEL_FAMILIES`
  is diffed against the package's exports in the test).
- Projections are verbatim; `inputs.parameters` carries hashes, never bulk — **closed**.
- Restore re-verifies both hashes; tampered, foreign, newer, and unmigrated-older artifacts refuse
  with their codes; a registered report migration is applied and echoed — **closed**.
- Replay parity byte-identical on every family (GARCH under its stored seed) — **closed**.
- Referenced rows replay only when their hashes match — **closed**.
- `evaluateFittedModel` equals the direct evaluator field-for-field on every family with one;
  extrapolation counted and warned — **closed for volatility**.
- Warm starts, stability, holdout deterministic, bounded, refusing unsupported families — **closed**.

### Deferred by this slice

- The packed browser/worker consumers and README snippets for the subpath — slice 6.
- The fixed-income and research halves — slices 4 and 5.

## Slice 4 (landed 2026-09-03) — `@totalfinance/fixed-income/artifacts`

Executes Decisions 1–3 and 5–9 for the four curve families over their stored data, and lifts the
adapter machinery the volatility slice wrote into one shared kit in core so the second domain
adapter is a table and a thin door, not a second copy.

### What landed

- **`@totalfinance/core/artifacts` — the fitted-model kit** (`fitted-model-kit.ts`, public through
  the spine, and therefore closed and typed at its own doors like every other export):
  `ARTIFACT_WORK_LIMITS` (one limits table with named defaults and maxima for
  embedded bytes, embedded rows, comparison differences and leaves, grid points, restarts, holdout
  evaluations, listed ids), `requireWorkLimit` / `requireComparisonTolerance` (the closed
  validators every verb's budgets and tolerances pass through), `applyReportMigrations` (the
  family-scoped `{ kind, schemaVersion, report }` migration walk with the newer / unmigrated-older
  refusals), `verifyReferencedRows` (hash verification of caller-supplied rows against a stored
  handle), `flattenSummaryParameters` (over a validated summary), and `residualStatistics`. The
  volatility adapter was
  refactored onto it with its 21 tests unchanged — one engine, two domains.
- **`curve-data.ts`** (internal) — `YieldCurveData` / `SurvivalCurveData` with their closed
  validators, the built-curve guards (`requireBuiltYieldCurve`, `requireBuiltSurvivalCurve`:
  every declared method, the conventions, well-formed pillars), `yieldCurveDataOf` /
  `survivalCurveDataOf`, and the exact restores `yieldCurveFromData` / `survivalCurveFromData`.
  The curve mappers now share the guard and the enums.
- **`fitted-model-families.ts`** (internal) — the four rows `discount-curve`, `projection-curve`,
  `multi-curve`, `hazard-curve`: the bootstrap to re-issue, the stored ⇄ live conversion of the
  fit and of every live curve inside the calibration (`rowSets`, `liveCurves` paths), the
  repricing residual of each calibration instrument through the PUBLIC valuations
  (`forwardRate` for deposits / FRAs / futures under their own day counts, `swapRate` for swaps and
  OIS under the bootstrap's effective conventions, `cdsParSpread` for CDS quotes), the evaluators
  (`discount` / `zeroRate` / `forwardRate` / `instantaneousForward`; `survival` / `hazard` /
  `defaultProbability`) over `{ dates }` with the multi-curve `{ curve }` selector, and the
  instrument-count partition. `FITTED_MODEL_FAMILIES` / `CURVE_MODEL_FAMILIES` are the frozen
  projections.
- **`fitted-model-artifacts.ts`** (public through `./artifacts`) — the same eight verbs as the
  volatility subpath with the same shapes (`fittedModelArtifact` requiring `currency`, the read
  door under `fixed-income.fitted-model:<family>`, `evaluateFittedModel` with per-point reasons
  and the extrapolation count against the stored pillar range, `replayFittedModel` byte parity,
  `compareFittedModels` with `CurveEvaluationDifference` rows per measure on the union of the two
  pillar grids and `sameCurrency`), `fittedModelHoldout` (`{ indices }` / `{ everyNth, offset }`
  over the calibration instruments, the retained set re-bootstrapped through the direct
  bootstrap, per-instrument `heldOut` repricing residuals in the family's unit). The subpath
  exports **six** verbs, not eight: `warmStartFrom` and `fittedModelStability` are absent, because
  an exact bootstrap has no start to warm and no restart to perturb, and a verb that refuses every
  input is a dead door (the first cut exported both as always-refusing; the enforcement gate
  flagged them, and the descriptor's `warmStart: false` with its reason is the honest disclosure).
- **Decisions at landing.** (1) **Restore rebuilds from the stored state, not through a public
  constructor** — Decision 2 amended above: the public constructors move a derived field by an
  ulp for `curves.flat` / `fromZeroRates` inputs, and under `linearZero` that ulp reached a hazard
  bootstrap's replay; the curve module now registers each curve's build state, `YieldCurveData`
  carries `zeroRateAtOrigin: 'quoted' | 'limit'`, and edited pillars (discount ≠
  `exp(−zero·tenor)`) are refused. (2) Swap and OIS residuals reprice under the bootstrap's
  effective conventions (`fixedFrequency` semiannual / OIS annual, `30/360` fixed, quarterly
  `ACT/360` float) — the first cut used `swapRate`'s defaults and reported a 27 bp OIS "residual"
  that was a convention mismatch, not a fit error. (3) Bootstrap residuals are honest at the
  root-finder's tolerance (≈1e-7 in rate space), and the tests assert that, not 1e-8. (4) A
  `throw`-extrapolation curve cannot be bootstrapped (its partial curve refuses the pillar solve):
  the throw law is the curve's, tested with the curve.

### Enrolment

- `./artifacts` export map entry (trailing `default`), vitest alias, eleven manifest rows in
  `fixed-income.json` plus the kit's rows in `core.json`, first-touch fixtures
  (`fixed-income-artifacts.ts`, `core-artifacts.ts` extended; join pin 1,111 → 1,123), the
  count-semantics head set extended to the `fixed-income.*` verbs, the bundle-doc row pin
  21 → 22.
- Bundles: `@totalfinance/fixed-income/artifacts` measured 41,636 B gzip, budget 42 KB;
  `@totalfinance/core/artifacts` 23 → 24.5 KB for the kit (measured 24,804 B).
- Regeneration chain green; enforcement `candidates 5,158 · enforced 2,376 · partial 2,601 ·
unmeasured 181 · defective 0 · direct failures 0` (the first measurement's seven defects — five
  kit doors and the two dead-door verbs — fixed at the source, below).
- Tests: 13 test cases in `fitted-model-artifacts.test.ts` — every family through describe →
  save → canonical round trip → restore exactly (`===` at and between pillars) → evaluate equals
  the live curve → replay parity byte-identical (the hazard bootstrap over a restored flat
  discount curve included) → compare against a shifted fit; the snapshot bridge (restored curve
  → `rateCurveFromYieldCurve` → `MarketSnapshot` → `bondDiscountCurvePricer` equals the live
  price); the descriptor; the read-door refusals and a registered report migration; repricing
  holdout hand-checked against the public valuations; the unsupported-operation refusals; the
  closed vocabularies. The whole fixed-income, core, volatility-artifact, and scenarios suites
  pass beside it (62 files, 946 tests in the regression run).

### Gate findings at landing (each fixed at its source, none ledgered)

- The enforcement probe, first measurement — seven defects. Five were the kit's own doors:
  helpers that are public through the spine accepted unknown keys, null or missing
  `functionName` / `field` / `kind` / `subject`, malformed laws, and a foreign `migrations` object,
  and `flattenSummaryParameters` took a bare parameter record — every helper now closes and types
  its request (`requireKitRequest`), the flattener takes the whole summary through
  `requireFittedModelSummary`, and the two omittable raw fields (`value`, `tolerance`) are declared
  optional because omission IS their default. Two were the fixed-income `warmStartFrom` /
  `fittedModelStability` verbs whose every valid call was refused — removed (above).
- The `./curves` entrypoint maps straight onto `curves.ts`, so the state accessors first added
  there leaked into the public surface (manifest, garbage sweep, three unresolved `ts` naming
  identities, a retired-form survivor in the 3B.N mapping) — moved into the internal
  `curve-state.ts` (record on build, builder registered at load), and the public surface is
  unchanged by the restore machinery.
- Count safety: the counts a supplied summary reports (`convergence.iterations`,
  `residuals.count`, `warningCount`) are magnitudes at the flattener's door — one policy branch;
  and `verifyReferencedRows` accepted a handle whose `rowCount` disagreed with the rows it
  hashed — a handle must describe the rows in every member, refused as
  `artifact.referenced_data_mismatch`.
- Union parity: `CurveFittedModelReport<F>` / `CalibrationOf<F>` distribute over the four-family
  union (the bootstrap option shapes, their instrument unions, and the live discount curve's
  callable surface inside a calibration) — five template routes and three read-door allowlist
  entries with reasons; the callable-surface walk now honours the same template prefixes the
  union walk already did (it had no exemption path, so a live curve's methods under a distributed
  family arm read as thirty-two gaps).
- Budgets: `@totalfinance/core/artifacts` 24 → 24.5 KB once the kit's doors closed (24,804 B);
  `@totalfinance/fixed-income/artifacts` measured 41,636 B under 42 KB; the bundle table pins 22
  rows; the fixture/contract join 1,111 → 1,123.

### Acceptance laws this slice closes (fixed-income rows)

- Every curve bootstrap has a family row, a stored form, an exact restore, an evaluator, a
  descriptor entry, and a fixture — **closed for fixed-income**.
- Restored curves agree `===` with the live curve at and between pillars; replay parity is
  byte-identical on every family, including bootstraps over restored input curves — **closed**.
- Holdout reprices held-out instruments through the public valuations, deterministically, with
  the retained set re-bootstrapped by the direct call — **closed**.
- No warm-start or stability verb is exported for exact bootstraps; the descriptor discloses the
  absence with its reason — **closed**.
- The snapshot bridge prices through the pricer to the live value — **closed**.

### Deferred by this slice

- The packed browser/worker consumers and README snippets for the subpath — slice 6.
- The research half — slice 5.

## Slice 5 (landed 2026-09-03) — `@totalfinance/research/artifacts`

Executes Decisions 1 and 4–7 (with 9–11) for the eleven FC3 run kinds: the subpath-only adapter,
the run-kind table, the four verbs, the structural hygiene block with its compile-time parity
fixture, and the direct-save fixtures.

### What landed

- **`research-run-kinds.ts`** (internal) — one row per FC3 operation: the direct operation to
  re-issue, the bulk row-set patterns (`observations`; `events` / `returnObservations` /
  `marketReturns`; `studies`; `factorEntries` / `forwardReturns`; `entries`;
  `previousPortfolios` / `currentPortfolios`; `horizons[].forwardReturns`;
  `components[].entries`), the caller-callback fields (`customPredicate`;
  `expectedReturnModel.expectedReturn` under `model: 'custom'`), the result's closed top-level keys
  and required assumption members, the identity members a comparison reports, and the typed
  section accessors (members, ranks, scores, exclusion reasons, coefficients, abnormal returns,
  per-quantile turnover, per-horizon decay, portfolios). `RESEARCH_RUN_KINDS` is the frozen data
  projection; wildcard row sets resolve to concrete labels per input.
- **`research-hygiene.ts`** (internal) — the six risk result shapes declared structurally
  (`HygieneResearchVerdict`, `HygieneDeflatedSharpe`, `HygieneBacktestOverfitting`,
  `HygieneLeakageReport`, `HygieneParameterSweep`, `HygieneMultipleTest`) and `requireHygieneBlock`:
  closed block keys, each present member's declared top-level keys, every consumed field checked
  (verdict literal set, probabilities in `[0, 1]`, counts, `minTrackRecordLength` finite or
  `+Infinity`, a clean report lists no leaks, one decision per test), `assumptions` open.
  `tools/manifest/research-hygiene-parity.compile.ts` proves mutual assignability with risk's
  declarations in both directions at typecheck time.
- **`research-run-artifacts.ts`** (public through `./artifacts`) — `researchRunArtifact` (the run
  shape-checked against its kind's signature and stored verbatim; callbacks recorded as
  `nonReplayableField` and stripped; row sets embedded under the limit or referenced by minted
  handles with locators; canonical-byte and row limits with the referencing teaching; the hygiene
  block and the recipe validated and stored verbatim; identity in `inputs.parameters` = `{ kind,
runVersion, inputsHash, referenced }`, handles in the envelope's `tables`), `readResearchRun`
  (Gate B read door → foreign-type refusal naming the owning package → the run-level migration
  policy under `research.run:<kind>` through the shared kit → report re-validation incl.
  `replayable` ⇔ `nonReplayableField` consistency), `replayResearchRun` (refuses a non-replayable
  run by field name with `artifact.not_replayable`; referenced rows re-verified by hash; the
  operation re-issued; byte parity; library-version disclosure), and `compareResearchRuns` (same
  kind required; `sameUniverse` / `sameAsOf` / `sameFilter` / `sameRankBy` / `sameComponents` /
  `sameInputs`; the typed sections per kind with `listedIds` caps and counted remainders; the
  hygiene verdict change; the structural run diff; a
  `artifact.comparison_different_universe` warning — a new registered code — when the population
  moved).
- **Decisions at landing.** (1) Kind identity by assumption signature (Decision 4 amendment). (2)
  Rows are array elements, one per study or portfolio. (3) No evaluator, warm start, stability, or
  holdout verb exists on this subpath — a screen is not a model — and the test asserts the
  runtime export set exactly. (4) The subpath bundles every FC3 operation and the spine: 40,598 B
  gzip, budget 41 KB.

### Enrolment

- `./artifacts` export map entry (trailing `default`), vitest alias, seven manifest rows (three
  constants, four verbs), four first-touch fixtures (`research-artifacts.ts`; join pin 1,123 →
  1,127), the count-semantics head set extended to the `research.*` verbs (`run` joins the
  supplied-report path branch), the bundle-doc row pin 22 → 23, the warning code
  `artifact.comparison_different_universe` registered in core.
- Regeneration chain green; enforcement `candidates 5,162 · enforced 2,379 · partial 2,602 ·
unmeasured 181 · defective 0 · direct failures 0`; naming identities 31,951 with 0 unresolved.
- Tests: 35 test cases in `research-run-artifacts.test.ts` — every kind through describe → save
  → canonical round trip → read → replay parity byte-identical → compare against a perturbed run
  with the kind's typed sections and the self-comparison identity; referenced rows for every kind
  (handle with locator stored, hash-verified replay, mismatch and missing-rows refusals, unknown
  label, unreferenced locator, rows over the limit with the teaching); the non-replayable callback
  law for `customPredicate` and the custom expected-return model; the hygiene block (verbatim
  storage, the disclosed `Infinity` round trip, the verdict change, closed keys with open
  assumptions, the consumed-field refusals); the recipe (verbatim, covered by the id, malformed
  refusals); the transform direct-save fixture linked by `createdFrom`; the descriptor law; the
  read-door refusals and a registered run migration; comparison refusals, the different-universe
  warning, and the `listedIds` cap. `packages/risk/test/artifact-direct-save.test.ts` — a
  `researchProtocol` verdict, a deflated-Sharpe result, and a `fitGeneralizedParetoTail` fit saved
  directly and read back byte-identically, and the producer's own `Infinity` round-tripping.

### Gate findings at landing (each fixed at its source, none ledgered)

- The enforcement probe's first measurement of the four verbs and the kit-backed doors: zero
  defects (the slice-4 kit hardening paid forward).
- Count safety: the counts a supplied hygiene block carries (`trialCount` on the protocol, the
  deflated-Sharpe result, and the parameter sweep) are reported facts, never budgets — one policy
  branch classifies `hygiene.*` coordinates as magnitudes at the save door.
- Union parity: `RunOf<Kind>` / `ResearchRunReport<Kind>` distribute over the eleven-kind union
  (eleven assumption shapes, ten diagnostics shapes, and their depth frontiers) — three template
  routes and the two read-door allowlist entries with reasons.
- Pins: the fixture/contract join 1,123 → 1,127; the bundle table 22 → 23 rows;
  `@totalfinance/research/artifacts` measured 40,598 B under 41 KB.

### Acceptance laws this slice closes (research rows)

- Every FC3 operation has a run kind, a stored form, a replay, a descriptor entry, and a fixture —
  **closed for research**.
- Replay parity byte-identical on every kind; referenced rows replay only when their hashes
  match; a run with a caller function refuses replay by name — **closed**.
- The hygiene block is verbatim, structurally validated, never recomputed, and kept in lock-step
  with risk's declarations at compile time — **closed**.
- `compareResearchRuns` reports the typed deltas of Decision 6 on every kind — **closed**.

### Deferred by this slice

- The packed browser/worker consumers and README snippets for the three subpaths, and the
  Stage 4.5 closeout — slice 6.

## Slice 6 (landed 2026-09-03) — packed consumers, README snippets, closeout

Executes the slice-6 row: the three subpaths proven from the PUBLISHED artifacts in Node, a
worker, and a web-only browser bundle; a CI-run README example per subpath; the read doors made
cast-free for a JSON-restored value; and the stage closeout.

### What landed

- **`tools/packed-consumer.test.ts`** — one artifact journey in plain JS over the three
  `./artifacts` subpaths (an SVI smile calibrated and saved; a discount curve bootstrapped and
  saved; a screen saved with its rows referenced by content hash): save → `canonicalJsonOf` →
  `fromCanonicalJson` → restore → evaluate → replay parity → compare, every law asserted from
  inside the journey, whose canonical bytes (artifact ids, restored reports, parity flags) must
  agree byte for byte in Node ESM, a `worker_threads` worker, and an esbuild browser bundle run in
  a `node:vm` context with web globals only — from the packed tarballs, not the workspace.
- **`docs/examples/readme-snippets.test.ts`** — a CI-run example per subpath
  (`@totalfinance/volatility/artifacts`, `@totalfinance/fixed-income/artifacts`,
  `@totalfinance/research/artifacts`), and **`tools/readme-gen.ts`** extended so an
  `it('<pkg>/<subpath>', …)` block renders as its own `## Example — \`<pkg>/<subpath>\`` section
  after the root example (the generator previously keyed one example per package). The three
  package READMEs regenerate with the sections.
- **Read doors take a JSON-restored value without a cast.** The exit gate's first lovability row
  ("a cold TypeScript user runs each subpath's README example … with no cast") failed on the very
  first snippet: `fromCanonicalJson` returns `unknown` by contract and the domain read doors
  declared `artifact: AnalysisArtifact`, so every restore needed `as typeof artifact`.
  `readFittedModel` / `replayFittedModel` (both packages) and `readResearchRun` /
  `replayResearchRun` now declare `artifact: unknown` — the same contract as
  `readAnalysisArtifact`, which validates at runtime and never trusts a declaration — and the
  snippets carry no assertion at all (`BootstrapInstrument[]` and `ScreenUniverseInput` type the
  inputs, so no `as const` either). `compareFittedModels` / `compareResearchRuns` /
  `evaluateFittedModel` keep their typed `report | AnalysisArtifact` parameters: a JSON value
  enters through the read door, which is the one place the type is earned.
- **Closeout.** This is the last code commit of Stage 4.5. A docs-only closeout commit follows
  it (the Stage 4.4b precedent: code at `3095cf914`, closeout at `9d8403cdd`) that ticks the exit
  gate above against each slice's evidence, writes the completion record naming this commit, and
  flips every controlling tracker (`docs/implementation-order.md`,
  `docs/specs/finance-portfolio-backtesting-completeness.md`,
  `docs/platform-completeness-roadmap.md`, `docs/README.md`) to `COMPLETE @ <this commit>` with
  Preview P1 and Stage 7A as the next dependency-ready rows.

### Enrolment

- No new export, manifest row, fixture, or budget: the packed journey, the three snippet blocks,
  and the generator extension are evidence and documentation over the surface slices 3–5 landed.
  The read doors' `artifact: unknown` re-declaration regenerated the signature, contract,
  enforcement, validation, and API ledgers and the three packages' API reports (`api:check`
  green); enforcement `candidates 5,162 · enforced 2,379 · partial 2,602 · unmeasured 181 ·
defective 0 · direct failures 0`; naming identities 31,951 with 0 unresolved.
- The three package READMEs regenerate with their `## Example — \`<pkg>/artifacts\`` sections
  and typecheck-and-run as published inside the packed-consumer gate (the existing "generated
  READMEs against the packed install" cases pick the new sections up unchanged).

### Gate findings at landing (each fixed at its source, none ledgered)

- None. The full tools gate suite (48 files, 2,843 tests) passed on the first run after the
  cast-free re-declaration: the read/replay doors were already on the union-parity undescribed
  allowlist with the runtime-validation reason, so `artifact: unknown` changed no gate's answer.

### Acceptance laws this slice closes

- Same inputs produce byte-identical artifacts and reports in Node, a browser bundle, and a
  worker — **closed** (the packed journey).
- A cold TypeScript user runs each subpath's README example with no cast, class, registry, storage
  adapter, or provider — **closed** (the three CI-run snippets).
- The three subpaths are package-direct; the umbrella and every package root are unchanged —
  **closed** (the umbrella budget did not move; no root re-exports them).

## Review record

The 2026-09-02 adversarial review (read-only, against laws 1–15, the lovability gate, D1–D20,
Gate B, Program 5/11, the queue's §4.5 list, and the code) returned "accept with revisions". Every
finding and its resolution, so the next reader need not re-derive them:

| Finding                                                     | Resolution in this revision                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 string `modelVersion` had no migration mechanism         | integer versions; family-scoped report migrations through the one registry via the envelope view (Decision 5)                                          |
| B2 read doors discarded Gate B's read report                | `readFittedModel` / `readResearchRun` return `{ report, artifact, migrationsApplied, modelMigrationsApplied }`                                         |
| B3 bulk stored twice                                        | `inputs.parameters` carries hashes only; the verbatim input lives once in `result` (Decisions 3, 4)                                                    |
| B4 hygiene validator refused real risk results              | consumed-field validation, open structural copies, `Infinity` round trip (Decision 4)                                                                  |
| B5 `{ a, b }` public fields                                 | `baseline` / `candidate` everywhere (Decision 6)                                                                                                       |
| B6 incomplete rename, false "no seeded calibration"         | `hestonSeed` → `hestonInitialParameters` in the same commit; GARCH's seed named and replayed (Decisions 7, 8)                                          |
| B7 `Partial<Parameters>` starts would be silent no-ops      | per-family closed free-start sets; unsupported members refused (Decision 8)                                                                            |
| B8 GARCH/HAR-RV evaluators uncallable, hidden horizons      | `{ lastVariance, horizonPeriods }` / `{ history }`; comparison `evaluation` required for forecasting families (Decisions 2, 6)                         |
| B9 `volatility-surface` chains could not be saved           | one input policy: declared bulk row sets embed or reference by `TableHandle` (Decision 9)                                                              |
| B10 `discount-curve` mapping under-specified                | curves store their own data (`YieldCurveData`); the snapshot bridge is a separate mapper with the UTC-midnight and day-count rules stated (Decision 2) |
| B11 two "additive" APIs duplicated code                     | `yieldCurveFromRateCurve` is the extracted pricer helper; no `survivalCurveFromPillars`                                                                |
| B12 `multi-curve` renamed verbatim fields                   | `MultiCurveBootstrapOptions` and `{ discountCurve, forecastCurve }` verbatim (Decision 2)                                                              |
| B13 four families without an evaluator parity decision      | exact direct calls with every non-default option, `(number \| null)[]` with reasons (Decision 2)                                                       |
| B14 duplicated extrapolation warning                        | `volatility.surface_extrapolated` reused; `curve.extrapolated` added; `'throw'` honored (Decisions 3, 10)                                              |
| F1 umbrella deep subpaths do not exist                      | subpath-only adapters, package-direct like the pricer adapters; umbrella untouched (Decision 1)                                                        |
| F2–F5 event, SSVI, surface field names                      | rows corrected to `FitEventVolatilityOptions`, `calibrateEventMove(observations)`, `butterflyArbitrageFree`/`calendarArbitrageFree`, `lookup`          |
| F6 `TableHandle.columnCount` derivation                     | `tableHandleForRows` column law (Decision 4)                                                                                                           |
| F7 manifest rows are not registry metadata                  | frozen `FITTED_MODEL_FAMILIES` / `RESEARCH_RUN_KINDS` descriptors (Decisions 2, 4)                                                                     |
| L1 `JSON.parse` restore                                     | `fromCanonicalJson` everywhere (Decision 1)                                                                                                            |
| L2 nine verbs, replay-helper precedent                      | `fittedModel` / `researchRun` dropped; `replayFittedModel` justified (Decision 3)                                                                      |
| L3 live curves had to be pre-converted                      | adapters accept live curves and store data (Decision 2)                                                                                                |
| L4 grid placement                                           | stated per family (Decision 6)                                                                                                                         |
| L5 nested parameters                                        | dot-path flattening law (Decision 2)                                                                                                                   |
| L6 residual inconsistency                                   | `residuals.source`; the direct evaluator is not a second engine (Decisions 2, 8)                                                                       |
| L7 one code, three meanings                                 | `artifact.type_mismatch` (core) and `artifact.family_mismatch` (domain) (Decision 10)                                                                  |
| L8 dishonest event-volatility teaching                      | `eventVolatilityAtExpiry` direct evaluator (Decisions 2, 8)                                                                                            |
| L9 factor kinds have no universe/asOf                       | null with reason (Decision 6)                                                                                                                          |
| S1 hygiene functions only attached, `adjustPValues` missing | direct-save fixture; `multipleTesting` in the block (Decision 4)                                                                                       |
| S2 transforms and recipes undecided                         | transforms are the next input and directly saveable; `recipe` stored (Decision 4)                                                                      |
| S3 run-of-runs kinds                                        | embedded verbatim under the row limit plus `createdFrom` (Decision 4)                                                                                  |
| S4 book/scenario clause                                     | curve bridge closed; volatility deferred with reason (Non-goals, Decision 2)                                                                           |
| S5 registry metadata                                        | descriptors (Decisions 2, 4)                                                                                                                           |
| S6 Gate B mapper box                                        | `rateCurveFromYieldCurve` closes its fixed-income half (Decision 2)                                                                                    |
| S7 `fitGeneralizedParetoTail`                               | out of scope with the reason and its home (Non-goals)                                                                                                  |
| X1 rename churn across slices                               | direct-API changes are slice 2, before any stored fit                                                                                                  |
| X2 curve restore not byte-exact                             | `fromDiscountFactors` over stored pillars — the bootstrap's own constructor (Decision 2)                                                               |
| X3 no named scanner                                         | `scanCanonicalData` promoted to core, scenarios re-pointed (Decision 9)                                                                                |
| X4 ratchet consequences unnamed                             | listed under the slices; single-object requests avoid multi-arg fixtures                                                                               |
| X5 union request discriminant                               | stated: the envelope's literal `kind`, structural selection otherwise (Decision 3)                                                                     |

## Completion record and next handoff

**Stage 4.5 is COMPLETE @ `795dd999f` (2026-09-03).** Six slices landed in order from this contract —
core structural contracts (`d99391536`), direct-API warm starts, the two renames, and the curve
mappers (`13b31f096`), `@totalfinance/volatility/artifacts` (`1029515ff`),
`@totalfinance/fixed-income/artifacts` (`a655d0c01`), `@totalfinance/research/artifacts` (`cebe2c046`),
and the packed consumers, README snippets, cast-free read doors, and closeout (`795dd999f`). Every
exit-gate row above is ticked against the evidence its slice record names.

- **Surface.** Sixteen fitted-model families (twelve volatility, four curve) and eleven research
  run kinds; three subpath-only `./artifacts` entrypoints (no root, no umbrella re-export — the
  umbrella budget did not move); the shared fitted-model kit in `@totalfinance/core/artifacts`
  (`ARTIFACT_WORK_LIMITS`, the closed work-limit / tolerance / migration / referenced-row /
  flattening / residual helpers); two new registered warning codes
  (`artifact.comparison_different_universe`, `curve.extrapolated`) and seven `artifact.*` error
  codes; direct calculation APIs preserved and extended only per Decision 8's table.
- **Evidence at the closing commit.** Full CI green (455 test files, 9,902 tests at slice 5;
  the slice-6 record carries its own count), `api:check` green, packed consumers green in Node, a
  worker, and a web-only browser bundle for the three subpaths; enforcement `defective 0 · direct
failures 0`; naming `unresolved 0`; every bundle under its evidence-dated budget (23 budgeted
  rows); the fixture/contract join pinned; the cells of the live-gated closeout docs refreshed
  from the ledgers.
- **Lovability rows honoured.** One obvious call per verb; `baseline` / `candidate`; no
  tolerance defaults; no single similarity score; warnings never license a non-finite; every
  refusal carries a stable code and a teaching; a JSON-restored value enters through a read door
  with no cast; no verb that refuses every input is exported.

**Next rows (dependency-ready now that the shared artifact/research contracts are frozen):**
Preview P1 (options marking truthfulness, `docs/specs/options-backtest.md`) and Stage 7A (local
operations, CLI, OpenAPI, and MCP — AT2 and the local/read-only part of AT3) may proceed in
parallel; the operation registry must not advertise `optionsBacktest` until P1 is green. Stage 5A
follows both; Stage 4.6 remains after the preview lane. The queue in
`docs/implementation-order.md` is authoritative.
