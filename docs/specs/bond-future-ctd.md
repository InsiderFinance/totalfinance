# Spec — Bond futures & cheapest-to-deliver (`@totalfinance/fixed-income`)

> Roadmap Tier 2 → Fixed income → _"bond futures + CTD analytics."_ Status: **shipped** as
> `bondFuture` + `conversionFactor` in `packages/fixed-income/src/futures.ts`, covered by
> `packages/fixed-income/test/futures.test.ts`, full CI green.

## Goal

A Treasury bond future doesn't settle to one bond — the short may deliver any of a **basket** of
eligible bonds, each scaled by a published **conversion factor** (CF) that normalizes its price to the
contract's 6% notional coupon. The whole game is: **which bond is cheapest to deliver (CTD)**, and how
rich/cheap is the future versus the cash bond? This tool answers both, composing the existing `Bond`
machinery (schedule, accrued interest, cash flows):

- the **CME/CBOT conversion factor** for each deliverable (computed, or overridden with the exchange's);
- **gross basis** `= cleanPrice − F·CF` — the cash-vs-future price gap;
- **carry** `= coupon income − financing cost` over the hold to delivery;
- **net basis** `= gross basis − carry` — the basis after carry;
- the **implied repo rate** — the annualized return of the buy-bond / deliver-into-future trade, which
  is the _repo-independent_ measure of cheapness;
- the **CTD**: the deliverable with the **highest implied repo rate** (equivalently the lowest net basis).

## Conversion factor (CME formula)

Per $1 face, the price of the bond on the **first day of the delivery month** that would make it yield
the contract's notional coupon `y` (default `6%`), with the time to maturity **rounded down to whole
quarters** — the exchange's deterministic convention. Let `c` be the bond's (semiannual) coupon rate,
`n` whole years and `z ∈ {0,3,6,9}` months to maturity after rounding, and `semi = y/2`:

```
if z < 7:  base = (1+semi)^(−2n)          ;  v = z
else:      base = (1+semi)^(−(2n+1))      ;  v = z − 6
a = (1+semi)^(−v/6)
b = (c/2)·(6 − v)/6
d = (c/y)·(1 − base)
CF = a·(c/2 + base + d) − b
```

_Verified: Hull's 20y-2m, 10%-coupon example → **1.4623**; a bond whose coupon equals the 6% notional →
**exactly 1.0000**; CF > 1 when `c > y`, CF < 1 when `c < y`._ Assumes **semiannual** coupons (the
Treasury/Gilt convention); disclosed, and any deliverable may carry an exchange-published `conversionFactor`
override instead.

## Basis, carry, and the implied repo rate

For a deliverable bought (clean) at `P` on `settlementDate` and delivered on `deliveryDate`, with
accrued interest `AIₛ`/`A_d` at those dates and interim coupons `cᵢ` paid (with `cash` timing) in
`(settlement, delivery]`:

```
purchase   = P + AIₛ                    (dirty cost today)
invoice    = F·CF + A_d                 (what the short receives on delivery)
grossBasis = P − F·CF
carry      = (Σcᵢ + A_d − AIₛ) − purchase·repo·τ         (τ = ACT/360 to delivery)
netBasis   = grossBasis − carry
```

The **implied repo rate** is the financing rate that makes the cash-and-carry break even — buy the bond
dirty today, finance it, collect and reinvest interim coupons, deliver at the invoice — solved exactly
(ACT/360, with each coupon reinvested over its own `τᵢ` from payment to delivery):

```
IRR = [invoice + Σcᵢ − purchase] / [purchase·τ − Σ cᵢ·τᵢ]
```

_Verified: `purchase·(1 + IRR·τ) == invoice + Σ cᵢ·(1 + IRR·τᵢ)` to machine precision — IRR is the exact
break-even rate._ The **CTD is the max-IRR deliverable**; because higher IRR ⇔ lower net basis under a
common repo, the max-IRR and min-net-basis rankings agree (asserted in the tests). IRR is the primary
ranking because it is **independent of the assumed repo**, whereas net basis is quoted _at_ the supplied
repo.

## Honesty / envelope contract

- **CTD by the repo-independent measure** — ranked by implied repo rate, not by net basis (which depends
  on the `repoRate` input); the two agree and that agreement is tested.
- **Disclosure** — the semiannual-coupon CF assumption, and whether each CF was `computed` or `supplied`;
  a deliverable that matures on/before delivery is rejected (not silently mispriced).
- **First-touch guards** — non-object input, non-finite/negative `futuresPrice`/`repoRate`, an empty
  basket, a `deliveryDate` on/before `settlementDate`, a malformed `Bond`, and a bond maturing before
  delivery all throw a typed `QuantError`; never a `NaN`.
- **Domain-object envelope (R2)** — `bondFuture` returns a `BondFutureResult` (per-deliverable rows +
  the CTD + `assumptions` + `diagnostics`); `conversionFactor` returns a `ConversionFactorResult`
  (`factor` + the rounding breakdown + envelope).

## API

```ts
interface ConversionFactorInput {
  bond: Bond; // the deliverable (its coupon + maturity drive the factor)
  deliveryDate: string; // CF is computed from the first day of this date's month
  notionalCoupon?: number; // contract notional (decimal); default 0.06
}
interface ConversionFactorResult {
  factor: number;
  wholeYears: number; // n
  extraMonths: number; // z ∈ {0,3,6,9}
  notionalCoupon: number;
  assumptions: { conventionsVersion: string; couponFrequency: 'semiannual' };
  diagnostics: Diagnostics;
}
function conversionFactor(input: ConversionFactorInput): ConversionFactorResult;

interface DeliverableBond {
  bond: Bond;
  cleanPrice: number; // per 100 face
  id?: string; // label for reporting; defaults to the basket index
  conversionFactor?: number; // exchange override; else computed
}
interface BondFutureInput {
  futuresPrice: number; // per 100 face
  settlementDate: string; // when the cash bond is bought
  deliveryDate: string; // when the short delivers
  repoRate: number; // ACT/360 financing rate (decimal) for carry / net basis
  notionalCoupon?: number; // default 0.06
  deliverables: DeliverableBond[];
}
interface DeliverableAnalysis {
  id: string;
  conversionFactor: number;
  conversionFactorSource: 'computed' | 'supplied';
  cleanPrice: number;
  accruedAtSettlement: number;
  accruedAtDelivery: number;
  interimCoupons: number;
  purchaseCost: number; // dirty at settlement
  invoicePrice: number; // F·CF + A_d
  grossBasis: number;
  carry: number;
  netBasis: number;
  impliedRepoRate: number;
  isCheapestToDeliver: boolean;
}
interface BondFutureResult {
  deliverables: DeliverableAnalysis[]; // sorted by implied repo rate, descending (CTD first)
  cheapestToDeliver: DeliverableAnalysis;
  yearsToDelivery: number;
  summary: string;
  assumptions: {
    conventionsVersion: string;
    futuresPrice: number;
    repoRate: number;
    notionalCoupon: number;
    settlementDate: string;
    deliveryDate: string;
  };
  diagnostics: Diagnostics;
}
function bondFuture(input: BondFutureInput): BondFutureResult;
```

## Build checklist

1. **`conversionFactor`** — parse delivery month + maturity, whole-quarter rounding to `(n, z)`, the CME
   formula, envelope; reject a bond maturing on/before the delivery month.
2. **`bondFuture`** — per deliverable: CF (computed/supplied), `AIₛ`/`A_d` via `bond.accrued`, interim
   coupons via `bond.futureCashflows` filtered to `(settlement, delivery]`, gross/net basis, carry, and
   the exact break-even implied repo rate; select the max-IRR CTD; sort rows CTD-first.
3. **Envelope + exports + API report + READMEs/llms.** (Single-arg object inputs ⇒ first-touch **garbage
   sweep**; no deep-sweep fixture.)
4. **Tests** — CF vs Hull `1.4623`, the at-par `1.0000`, and the `z = 9` branch; the IRR break-even
   identity; the CTD is max-IRR **and** min-net-basis (same bond); a supplied CF overrides the computed
   one (`source: 'supplied'`); carry sign (positive-carry bond) and `netBasis = grossBasis − carry`;
   guards (bad input, empty basket, delivery ≤ settlement, bond maturing before delivery).

## Deferred (explicitly)

- **The delivery option** — the short's timing/quality/wildcard options (the CTD can switch as rates
  move); this milestone is a static snapshot at one `(futuresPrice, deliveryDate)`.
- **Forward CTD & the futures-implied forward yield**, and a **net-basis → option-value** decomposition.
- **Non-Treasury conventions** — annual-coupon (some Gilt/Euro) CF variants and per-exchange rounding
  quirks beyond the standard whole-quarter/6% rule.
- **CTD DV01 / hedge ratio** (`= DV01_ctd / CF_ctd`) for futures hedging — a natural follow-up once the
  basket analytics are in place.
