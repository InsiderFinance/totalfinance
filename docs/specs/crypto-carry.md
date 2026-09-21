# Spec — Crypto perpetual & futures carry (`@totalfinance/crypto`)

> Roadmap Tier 2 → Crypto → "Funding-rate/basis/carry analytics for perps". The **first package** in the
> Crypto tier (the `24/7` calendar already lives in `@totalfinance/calendars`; the inverse _option_ lives in
> `@totalfinance/options`).
> Status: **shipped** as `@totalfinance/crypto` (`perpetualFunding`, `futuresBasis`, `predictedFunding`,
> `fundingBasisSpread`), covered by `packages/crypto/test/carry.test.ts`, full CI green.

## Goal

Every crypto trader watches the **funding rate** and the **basis**. A perpetual swap has no expiry; it is
tethered to spot by a periodic **funding** payment (longs pay shorts when funding is positive). A dated
future trades at a **basis** to spot that is really an implied cost-of-carry. The two are the **same
number** in equilibrium — the perp's annualized funding and the future's annualized basis both equal the
carry `r − q` — so the spread between them is a clean cross-instrument signal, and the gap between either
and the actual financing cost is a cash-and-carry arbitrage. This package turns the raw quotes into those
annualized, comparable, no-arbitrage-grounded numbers. All five functions are **deterministic** (no
stochastic model): the verification is exact identities, no-arb round-trips, and limiting cases.

`@totalfinance/crypto` depends only on `@totalfinance/core`; it is browser-safe and does no data fetching.

## The functions

### `perpetualFunding` — funding rate → annualized carry

From a realized funding rate and the mark/index prices:

```
premium              = markPrice/indexPrice − 1
periodsPerYear       = (365·24) / intervalHours              (1095 for the standard 8h interval)
annualizedSimple     = fundingRate · periodsPerYear
annualizedCompounded = (1 + fundingRate)^periodsPerYear − 1
longCarry            = −annualizedSimple                     (a long perp PAYS funding when it is positive)
shortCarry          = +annualizedSimple
```

`annualizedSimple` **is** the perp's implied cost-of-carry `r − q`. A 0.01 %/8h funding annualizes to
+10.95 % simple / +11.57 % compounded — the yearly drag on a long. Extreme funding (|annualized| over the
`extremeAnnualized` threshold, default 100 %/yr) is flagged `crypto.extreme_funding`.

### `futuresBasis` — dated future → basis & cash-and-carry

```
basis            = future − spot
basisFraction         = future/spot − 1
annualizedSimple = basisFraction / t
annualizedLog    = ln(future/spot) / t                       (the implied r − q)
structure        = contango (future > spot) | backwardation (future < spot) | flat
```

When a `financingRate` r (and optional `coinYield` q) is supplied, the no-arbitrage future and the
cash-and-carry edge are added:

```
fairFuture = spot · e^{(r−q)·t}
richness   = future − fairFuture                             (riskless profit at expiry, per unit, of short-future + carry-spot)
carryArbitrage   = annualizedLog − (r − q)                         (annualized excess of long-spot / short-future over financing)
```

At the fair future these are exactly 0 (verified to 1e-15). A `|carryArbitrage|` above `arbitrageThreshold`
(default 5 %/yr) is flagged `crypto.carry_arbitrage`.

### `predictedFunding` — the venue funding formula

The exchange (Binance-style) next-interval funding from the premium index and an interest-rate component:

```
fundingRate = premium + clamp(interestRate − premium, −clamp, +clamp)      (clamp default 0.0005)
            → capped to ±cap if a hard cap is supplied
```

When the premium is small (`|interestRate − premium| ≤ clamp`) the funding equals the interest rate; when
the premium dominates it tracks the premium (minus the clamp). `capped` discloses whether the hard cap
bound.

### `fundingBasisSpread` — the perp-vs-future no-arb signal

Composes the two carries on the same underlying:

```
fundingImpliedCarry = perpetualFunding(...).annualizedSimple
basisImpliedCarry   = futuresBasis(...).annualizedLog
spread              = basisImpliedCarry − fundingImpliedCarry
signal              = future-rich (spread > tolerance) | perp-rich (spread < −tolerance) | aligned
```

`future-rich` ⇒ the term future's implied carry exceeds the perp funding: long perp / short future
harvests the spread; `perp-rich` is the reverse.

### `optionsBasisSpread` — the put-call-parity synthetic forward vs the dated future

The options market prices a **synthetic forward** with no volatility model, straight from put-call parity
(a call and a put at the same strike/expiry). Reconciling it against the dated future is a third leg of
the same no-arbitrage triangle (spot ↔ perp ↔ future ↔ options-synthetic all imply the carry `r − q`):

```
optionsImpliedForward = strike + e^{rt}·(call − put)          # put-call parity, USD numéraire
optionsImpliedCarry   = ln(optionsImpliedForward / spot) / t
basisImpliedCarry     = ln(future / spot) / t
spread                = basisImpliedCarry − optionsImpliedCarry
signal                = future-rich (spread > tolerance) | options-rich (spread < −tolerance) | aligned
```

`future-rich` ⇒ the future prices a richer forward than the options synthetic: sell the future / buy the
synthetic (long call + short put); `options-rich` is the reverse. An inconsistent quote (a non-positive
parity forward) is refused with a typed error rather than emitting a NaN carry (Law 7). _Note:_ USD-cash
numéraire (parity in USD); for coin-quoted Deribit prices, scale by the index first.

## Honesty / envelope contract

- **No hidden model** — every output is an exact identity over the inputs; disclosed as `model: 'carry'`
  with `engine` per function. Simple and log/compounded annualizations are **both** returned rather than
  picking one convention silently.
- **Cash-and-carry only when financing is given** — `fairFuture`/`richness`/`carryArbitrage` are `undefined`
  unless `financingRate` is supplied (no invented financing rate).
- **Flags, not silence** — extreme funding and a live carry arbitrage are surfaced as typed
  `crypto.*` warnings in `diagnostics.warnings`, never swallowed.
- **First-touch guards** — non-object input; non-positive `markPrice`/`indexPrice`/`spot`/`future`/`t`/
  `intervalHours`; non-finite `fundingRate`/`premium`/rates — all throw a typed `QuantError`. All four are
  single-object-argument functions ⇒ the first-touch **garbage sweep** covers them (no fixture needed).
- **Envelope (R2)** — each returns a domain object carrying `assumptions` + `diagnostics`.

## API

```ts
interface PerpetualFundingInput {
  markPrice: number;
  indexPrice: number;
  /** Realized funding for the interval (fraction; 0.0001 = 0.01 %). Longs pay shorts when positive. */
  fundingRate: number;
  /** Funding interval in hours. Default 8. */
  intervalHours?: number;
  /** |annualized| above which funding is flagged extreme. Default 1 (100 %/yr). */
  extremeAnnualized?: number;
}
interface FuturesBasisInput {
  spot: number;
  future: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Quote financing rate — enables fairFuture/richness/carryArbitrage. */
  financingRate?: number;
  /** Coin (base) yield. Default 0. */
  coinYield?: number;
  /** |carryArbitrage| above which an arbitrage is flagged. Default 0.05. */
  arbitrageThreshold?: number;
}
interface PredictedFundingInput {
  premium: number;
  /** Interest-rate component per interval. Default 0. */
  interestRate?: number;
  /** Clamp half-width for the interest component. Default 0.0005. */
  clamp?: number;
  /** Optional hard cap on |funding|. */
  cap?: number;
}
interface FundingBasisSpreadInput {
  fundingRate: number;
  intervalHours?: number;
  spot: number;
  future: number;
  timeToExpiryYears: number;
  /** |spread| below which the two are 'aligned'. Default 0.005 (0.5 %/yr). */
  tolerance?: number;
}

function perpetualFunding(input: PerpetualFundingInput): PerpetualFunding;
function futuresBasis(input: FuturesBasisInput): FuturesBasis;
function predictedFunding(input: PredictedFundingInput): PredictedFunding;
function fundingBasisSpread(input: FundingBasisSpreadInput): FundingBasisSpread;
```

(Each result type carries the fields above plus `assumptions` and `diagnostics`.)

## Build checklist

1. **Scaffold `@totalfinance/crypto`** — package.json (root `.` entrypoint only), tsconfig.build.json,
   LICENSE, src/index.ts; register in root `tsconfig.json` paths + `tsconfig.build.json` references,
   `tools/api-report/generate.ts` ENTRYPOINTS, the umbrella `totalfinance` (index `export * as crypto` +
   package.json dep), and `tools/first-touch/garbage-sweep.test.ts` (import + PACKAGES map).
2. **Implement** the four functions with the identities above, `crypto.*` warnings, and R2 envelopes.
3. **Export + API report + READMEs/llms** (all auto-discovered from `packages/`).
4. **Tests** — annualization + compounding; fair-future round-trip (richness/carryArbitrage ≈ 0); a rich future's
   cash-and-carry edge; funding↔basis equivalence; predictedFunding's three clamp regimes + cap; the
   spread signal; extreme-funding / arbitrage flags; guards.

## Deferred (explicitly)

- **Inverse-future / inverse-perp (Deribit-style) conventions** — the coin-margined future whose delta is
  the hedge for the inverse _option_'s coin delta ([`inverse-option.md`](./inverse-option.md)); its own
  next crypto cycle.
- **A funding term structure / carry curve** across expiries, and a realized-funding backtest (basis-trade
  P&L) once the data layer lands.
- **Options-implied carry** — reconciling the perp/future carry against the box-spread / put-call-parity
  implied forward from a crypto options chain.
- **Venue-specific funding nuances** — interest-rate index specifics, dampeners, and per-venue caps
  beyond the generic clamp/cap here.
