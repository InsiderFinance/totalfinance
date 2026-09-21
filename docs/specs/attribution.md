# Spec — Return attribution (`@totalfinance/risk`)

> Roadmap Tier 2 → Portfolio & risk → _"Attribution: Brinson, factor P&L, statistical factor models
> (PCA / Barra-lite)."_ Status: **shipped** as `factorAttribution` and `brinsonAttribution` in
> `packages/risk/src/attribution.ts`, covered by `packages/risk/test/attribution.test.ts`, full CI
> green. (The statistical/PCA factor model already exists as `factorExposure`/`pca`.)

## Goal

Two questions every book owner asks after the fact: **"where did my return come from — factors or
skill?"** and **"did I beat the benchmark by allocating or by picking?"** The package has the
statistical factor model (`pca`/`factorExposure`) but no _return_ attribution. This adds the two
classics, each decomposing a realized return into named, additive pieces that **reconstruct the total
exactly**:

- **`factorAttribution`** — regress a return series on observable **factor** returns (market, size,
  value, momentum, …) and split the realized return into a contribution per factor plus a **specific**
  (skill/alpha) residual.
- **`brinsonAttribution`** — split a portfolio's **active** return vs a benchmark into **allocation**
  (sector bets), **selection** (security picks), and **interaction**.

## Factor P&L attribution

Regress the (excess) return series `r_t` on the `K` factor return series via OLS (from `@totalfinance/math`):

```
r_t = α + Σ_k β_k·f_{k,t} + ε_t
```

- `β_k` is the **exposure** (loading) to factor `k`, with its t-stat; `α` is the per-period specific
  return; `R²`/`R̄²` measure how much of the variance the factors explain.
- **Factor contribution** to the realized (arithmetic) return: `contribution_k = β_k · Σ_t f_{k,t}` —
  exposure × the factor's cumulative return over the window.
- **Specific return** = `n·α` (the cumulative intercept — the part no factor explains).
- **Exact identity** (the whole point): with an intercept, OLS residuals sum to zero, so
  `totalReturn = Σ_t r_t = n·α + Σ_k β_k·Σ_t f_{k,t} = specificReturn + Σ_k contribution_k` **exactly**
  (verified to machine precision). Nothing is unattributed.
- `riskFreeRate` (per period, default 0) is subtracted from `r_t` first, so `α` is a genuine excess-return
  alpha when the factors are excess returns.

## Brinson attribution

Given segments (sectors/buckets) with portfolio/benchmark weights and returns, and totals
`R_p = Σ w^p_i·r^p_i`, `R_b = Σ w^b_i·r^b_i`, the per-segment effects:

- **Allocation** — over/under-weighting a segment. **Brinson–Fachler** (default, benchmark-relative):
  `(w^p_i − w^b_i)·(r^b_i − R_b)`; **Brinson–Hood–Beebower** (`method: 'brinson-hood-beebower'`):
  `(w^p_i − w^b_i)·r^b_i`.
- **Selection** — picking better than the benchmark within a segment: `w^b_i·(r^p_i − r^b_i)`.
- **Interaction** — the cross term: `(w^p_i − w^b_i)·(r^p_i − r^b_i)`.

**Identity**: `allocation + selection + interaction = R_p − R_b` (the active return). This holds to
machine precision **always for Brinson–Hood–Beebower**, and for **Brinson–Fachler iff `Σw^p = Σw^b`**
(equal/unit weights — a fully-invested book). BF and BHB then give the **same** allocation total (they
differ per-segment by `R_b·(w^p_i − w^b_i)`, which sums to zero at equal weights). When the BF effects
fail to reconcile (unequal/non-unit weights) the residual `R_b·(Σw^p − Σw^b)` is detected directly and
disclosed via a `risk.brinson_weights` warning — never a falsely-claimed reconciliation; the caller can
normalize the weights or switch to `brinson-hood-beebower`.

## Honesty / envelope contract

- **Exact reconstruction, disclosed** — factor attribution sums back to the total return to machine
  precision (OLS residuals vanish); Brinson sums to the active return exactly (always for BHB, and for
  BF at equal weights). There is no silent "other" bucket — any BF residual is measured and surfaced.
- **Fit quality surfaced** — `factorAttribution` reports `R²`, `R̄²`, and per-factor t-stats, so a
  low-explanatory-power regression (specific return ≈ everything) is visible, not hidden behind
  confident-looking contributions.
- **Rank-deficiency fails loudly** — collinear or too-few-observation factor inputs surface the OLS
  error (a typed `QuantError`) rather than returning garbage betas.
- **Weight assumptions disclosed** — a non-reconciling Brinson–Fachler decomposition (unequal/non-unit
  weights) is caught by measuring the actual residual and warned, with a pointer to BHB.
- Typed guards (aligned non-empty series with `n > K+1`; ≥ 1 factor / segment; finite values); pure and
  deterministic.

## API

```ts
interface FactorSeries {
  name: string;
  returns: ArrayLike<number>;
}
interface FactorAttributionInput {
  returns: ArrayLike<number>; // the asset/portfolio return series
  factors: FactorSeries[]; // observable factor return series (aligned to `returns`)
  riskFreeRate?: number; // per-period rf subtracted from returns; default 0
}
interface FactorContribution {
  name: string;
  beta: number;
  tStatistic: number;
  contribution: number;
}
interface FactorAttribution {
  factors: FactorContribution[];
  alpha: number; // per-period intercept
  specificReturn: number; // n·alpha
  totalReturn: number; // Σ returns  (= specificReturn + Σ contributions, exact)
  rSquared: number;
  adjustedRSquared: number;
  observations: number;
  assumptions: { conventionsVersion: string; riskFreeRate: number };
  diagnostics: Diagnostics;
}
function factorAttribution(input: FactorAttributionInput): FactorAttribution;

interface BrinsonSegment {
  name: string;
  portfolioWeight: number;
  benchmarkWeight: number;
  portfolioReturn: number;
  benchmarkReturn: number;
}
interface SegmentEffect {
  name: string;
  allocation: number;
  selection: number;
  interaction: number;
  total: number;
}
interface BrinsonAttribution {
  portfolioReturn: number;
  benchmarkReturn: number;
  activeReturn: number;
  allocation: number;
  selection: number;
  interaction: number; // segment sums
  segments: SegmentEffect[];
  method: 'brinson-fachler' | 'brinson-hood-beebower';
  assumptions: { conventionsVersion: string; method: string };
  diagnostics: Diagnostics;
}
function brinsonAttribution(
  segments: BrinsonSegment[],
  opts?: { method?: 'brinson-fachler' | 'brinson-hood-beebower' },
): BrinsonAttribution;
```

## Build checklist

1. **Factor** — validate/align; subtract `riskFreeRate`; `ols(r, F)`; per-factor `β`/t-stat/contribution;
   `α`, `specificReturn`, `totalReturn`; `R²`; rank-deficiency guard.
2. **Brinson** — validate; totals `R_p`/`R_b`; per-segment allocation (Fachler/BHB)/selection/interaction;
   sums; weight-sum warning.
3. **Envelope + exports + API report + READMEs/llms** (+ deep-sweep fixtures for the new callables).
4. **Tests** — factor recovers synthetic `β`s; the `totalReturn = specificReturn + Σ contribution`
   identity holds to machine precision; `R²`/t-stats sane; `riskFreeRate` shifts `α`; a rank-deficient
   input throws; Brinson `allocation+selection+interaction = activeReturn` exactly; Fachler vs BHB agree
   on the allocation total at unit weights and the per-segment difference is `R_b·(w^p−w^b)`; non-unit
   weights warn; guards.

## Deferred (explicitly)

- **Multi-period geometric linking** (Cariño / Menchero) so single-period effects compound correctly
  across a horizonPeriods (v1 is single-period arithmetic).
- **Nested / multi-level Brinson** (sector → industry → security).
- **Risk (ex-ante) attribution** — decomposing tracking error / factor risk, not realized P&L.
- **Currency attribution** for multi-currency books.
