# Spec — American exercise analytics (`@totalfinance/options`)

> Roadmap Tier 2 → Options & vol → _"Exercise-boundary analytics and early-exercise premium
> decomposition for American options."_ Status: **shipped** as `americanExercise` in
> `packages/options/src/exercise.ts`, covered by `packages/options/test/exercise.test.ts`, full CI green.

## Goal

Every US equity option is American, and two questions follow from that every day: **"how much of this
option's value is the right to exercise early?"** and **"at what price should I exercise?"**
`americanExercise` answers both in one call — it decomposes the American value into its **European value
plus the early-exercise premium**, recovers the **exercise boundary** `S*(τ)` (the critical spot at
which holding stops being optimal) over the option's remaining life, and tells you plainly whether to
**exercise now**. Built by composing the existing closed-form American engine (`bawPrice`) with the BSM
European price — no new pricing model, just the analytics a holder actually needs.

## Why Barone–Adesi–Whaley

The pack uses `bawPrice` (already in the package) for the American value because it has a property the
analytics need: **it returns _exactly_ the intrinsic value inside the exercise region** (`S − K` for a
call, `K − S` for a put once past the critical spot). That makes everything internally consistent — the
early-exercise premium is exactly `0` iff the option should be exercised now iff the spot is past the
recovered boundary. A more accurate value engine (Bjerksund–Stensland 2002, or a lattice for discrete
dividends) is a documented follow-up; consistency of the _decision_ matters more here than the last
basis point of the _value_.

## Early-exercise premium decomposition

```
american   = bawPrice({ type, spot: S, strike: K, t: τ, riskFreeRate: r, dividendYield: q, volatility: σ })
european   = blackScholesPrice({ type, spot: S, strike: K, t: τ, riskFreeRate: r, dividendYield: q, volatility: σ })
premium    = max(0, american − european)               // the value of exercising early
intrinsic  = max(type=call ? S−K : K−S, 0)
timeValue  = american − intrinsic                       // ≥ 0
```

- `premium` is the dollars the early-exercise right adds; `premiumFractionOfValue = premium / american`.
- **`shouldExerciseNow`** = `intrinsic > 0` **and** `american − intrinsic < tolerance` — i.e. the American
  value has collapsed to intrinsic, so there is no time value left to give up by exercising. (Exactly
  the boundary condition, read off the value.)
- `earlyExerciseCanBeOptimal` — `false` for a **non-dividend call** (`q = 0 ⟹ b ≥ r`), where early
  exercise is never optimal and `american = european`, `premium = 0`, `criticalSpot = null`.

## Exercise boundary `S*(τ)`

The critical spot is recovered from `bawPrice` by bisection on the exact-intrinsic property: `S*` is the
edge of the region where `bawPrice(type, S, …) = intrinsic(S)`.

- **Put** — exercise region is **low** spot: `S* = sup { S : american(S) = K − S }`. Bisect on
  `[εK, K]` (`εK` exercises, `K` continues).
- **Dividend call** — exercise region is **high** spot: `S* = inf { S : american(S) = S − K }`. Bisect on
  `[K, K·M]` with `M` expanded until the upper bracket is in the exercise region.

`criticalSpot` is `S*(τ)` at the current maturity `τ`. The full **boundary curve** is `S*` evaluated over
a grid of maturities from `τ` down to `τ/N` (default `N = 24`), so a holder sees the whole trigger path
— a put's boundary **rises toward `K`** as expiry approaches (verified: `S* = 75.95, 83.73, 94.91` at
`τ = 1, 0.25, 0.01` for `K=100, r=5%, σ=25%`); a dividend call's **falls toward `K·max(1, r/q)`**.

`spotToBoundary` reports the signed gap the underlying must travel to reach exercise:
`(S − S*)/S` for a put (positive ⇒ above the boundary, still holding), `(S* − S)/S` for a call.

## Honesty / envelope contract

- **Decision-consistent** — `shouldExerciseNow ⟺ premium reads 0 (american = intrinsic) ⟺ spot past
`criticalSpot`; the three never disagree because they all come from the one BAW value.
- **Never-optimal is explicit** — a non-dividend call reports `earlyExerciseCanBeOptimal = false`,
  `criticalSpot = null`, and an empty boundary curve, not a fabricated trigger.
- **Continuous-yield scope, disclosed** — the closed form uses the continuous dividend yield `q`. Discrete
  dividends (the real driver of _call_ early exercise, right before an ex-date) are flagged with a
  `options.exercise_discrete_dividends` warning recommending a lattice; the analysis still runs on the
  yield-equivalent, clearly labelled.
- **No boundary fabricated past resolution** — if the bisection can't bracket the boundary (e.g. a
  degenerate `τ→0`), that maturity is omitted from the curve rather than guessed.
- Typed guards (positive spot/strike/vol, finite rate/yield, `τ > 0`); pure and deterministic.

## API

```ts
interface AmericanExerciseOptions {
  /** Number of maturities in the boundary curve (from τ down to τ/N); default 24. 0 skips the curve. */
  boundaryPoints?: number;
}
interface BoundaryPoint {
  yearsToExpiry: number;
  criticalSpot: number;
}
interface AmericanExerciseResult {
  style: 'call' | 'put';
  spot: number;
  american: number;
  european: number;
  earlyExercisePremium: number; // american − european ≥ 0
  premiumFractionOfValue: number; // premium / american
  intrinsic: number;
  timeValue: number; // american − intrinsic ≥ 0
  earlyExerciseCanBeOptimal: boolean;
  criticalSpot: number | null; // S*(τ) now; null when never optimal
  shouldExerciseNow: boolean;
  spotToBoundary: number | null; // signed fraction of spot to the boundary
  boundary: BoundaryPoint[]; // S*(τ) curve over the life (empty when never optimal)
  rationale: string; // prose an agent relays
  assumptions: {
    conventionsVersion: string;
    valueEngine: 'barone-adesi-whaley';
    dividendModel: 'none' | 'continuousYield' | 'discreteSchedule';
    timeToExpiryYears: number;
  };
  diagnostics: Diagnostics;
}
function americanExercise(
  contract: OptionContract,
  market: OptionMarket,
  opts?: AmericanExerciseOptions,
): AmericanExerciseResult;
```

## Build checklist

1. **Params** — extract `S, K, r, q, σ, τ, type` from `contract`/`market` (the `american-iv` pattern:
   `timeToExpiryYears`, `resolveAsOf`, `dividendYield ?? 0`); guards.
2. **Decomposition** — `american` (BAW), `european` (BSM), `premium`, `timeValue`, `shouldExerciseNow`.
3. **Boundary** — `criticalSpot` bisection (put/call orientation, bracket expansion), `earlyExerciseCanBeOptimal`.
4. **Curve** — `S*(τ)` over the maturity grid; omit unbracketable points.
5. **Rationale + disclosures** — prose; discrete-dividend warning.
6. **Exports + API report + READMEs/llms** (+ deep-sweep fixture — `americanExercise` is contract+market,
   a two-arg callable).
7. **Tests** — put premium/value vs a known BAW figure; boundary consistent with `shouldExerciseNow`
   (spot past `S*` ⟺ exercise now); the put boundary rises toward `K` as `τ→0`; a non-dividend call has
   zero premium, `earlyExerciseCanBeOptimal=false`, empty boundary; a dividend call has a finite high-spot
   boundary; a deep-ITM put says exercise now with ~zero time value; discrete-dividend warning; guards.

## Deferred (explicitly)

- **Discrete-dividend lattice boundary** — the exact call boundary right before each ex-date (v1 uses the
  continuous-yield closed form and discloses).
- **Higher-accuracy value engine** — Bjerksund–Stensland 2002 / a lattice for the `american`/`premium`
  magnitude (v1 uses BAW for decision-consistency).
- **Early-exercise greeks** — the sensitivity of the boundary and premium to spot/vol/rate/time.
- **Bermudan** (discrete exercise dates) analytics.
