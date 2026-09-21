# Spec — Bond-future DV01 hedge & futures-implied yield (`@totalfinance/fixed-income`)

> Roadmap Tier 2 → Fixed income → the bond-future follow-up: "the CTD DV01 hedge ratio" and
> "forward CTD / futures-implied yield".
> Status: **shipped** as `bondFutureHedge` in `packages/fixed-income/src/futures.ts`, covered by
> `packages/fixed-income/test/futures.test.ts`, full CI green.

## Goal

`bondFuture` finds the cheapest-to-deliver and the basis/carry/implied-repo across the basket, but a desk
that trades the contract to hedge interest-rate risk needs two more things: **how much the futures price
moves per basis point** (its DV01), and therefore **how many contracts hedge a given DV01 of risk**. This
adds `bondFutureHedge`, composing `bondFuture` (to find the CTD and its conversion factor) with the bond
yield/DV01 analytics.

The standard (Hull) relations:

```
futuresDV01 = ctdDV01 / CF_ctd                    (a 1bp move in the CTD moves the invoice by CF·ΔP_ctd,
                                                    so the futures BPV is the CTD BPV divided by CF)
hedgeRatio  = positionDV01 / futuresDV01           (# contracts, per 100 face, to offset positionDV01;
                                                    SELL them to hedge a long / positive-DV01 position)
```

so hedging the **CTD itself** takes exactly `CF` contracts (`ctdDV01 / (ctdDV01/CF) = CF`) — a clean
identity the tests pin. It also reports the **futures-implied forward yield**: the CTD's yield at its
forward clean price `F·CF`, as of the delivery date — the yield the futures market is pricing in.

_Verified before implementation: `futuresDV01 = ctdDV01/CF` and `hedgeRatio(CTD) = CF` to machine
precision; `ctdDV01` matches a central finite-difference reprice of the CTD to ~1e-7 relative; and the
implied forward yield reprices the forward clean price `F·CF` exactly (round-trip)._

## Construction

Compose the existing pieces — no new pricing math:

1. `bondFuture(input)` → the CTD row (id, conversion factor, clean price) and the whole basket.
2. Per deliverable: spot yield `yⱼ = yieldToMaturity(bondⱼ, { settlementDate, price: cleanPriceⱼ })`, then
   `dv01ⱼ = yieldMetrics(bondⱼ, { settlementDate, yield: yⱼ }).dv01` (per 100 face). `futuresDV01ⱼ =
dv01ⱼ / CFⱼ` is what the futures inherit through that bond.
3. Headline the **CTD**: `ctdDV01`, `futuresDV01 = ctdDV01 / CF_ctd`, `ctdYield`.
4. **Implied forward yield**: `yieldToMaturity(ctdBond, { settlementDate: deliveryDate, price: F·CF_ctd })`.
5. If `hedgeDv01` is supplied: `hedgeRatio = hedgeDv01 / futuresDV01` (contracts per 100 face).

## API

```ts
export interface BondFutureHedgeInput extends BondFutureInput {
  /** DV01 (per 100 face) of the position to hedge. When given, the result reports `hedgeRatio`. */
  hedgeDv01?: number;
}
export interface DeliverableRisk {
  id: string;
  conversionFactor: number;
  /** Spot yield of the deliverable at its market clean price. */
  yield: number;
  /** DV01 of the cash bond per 100 face. */
  dv01: number;
  /** DV01 the futures inherit through this bond: `dv01 / CF`. */
  futuresDv01ViaBond: number;
}
export interface BondFutureHedgeResult {
  ctdId: string;
  ctdConversionFactor: number;
  ctdYield: number;
  /** DV01 of the CTD cash bond per 100 face (at its market yield). */
  ctdDv01: number;
  /** The futures contract's DV01 per 100 face of notional (`ctdDv01 / CF_ctd`). */
  futuresDv01: number;
  /** The CTD yield the futures price implies at the forward clean price `F·CF`, as of delivery. */
  impliedForwardYield: number;
  /** # futures (per 100 face) whose DV01 offsets `hedgeDv01`; present iff `hedgeDv01` was supplied. */
  hedgeRatio?: number;
  /** Per-deliverable spot yield + DV01 across the basket. */
  deliverables: DeliverableRisk[];
  assumptions: {
    conventionsVersion: string;
    futuresPrice: number;
    settlementDate: string;
    deliveryDate: string;
  };
  diagnostics: Diagnostics;
}
export function bondFutureHedge(input: BondFutureHedgeInput): BondFutureHedgeResult;
```

## Honesty / envelope contract

- **Composes, doesn't re-derive** — the CTD/basis logic is `bondFuture`; the yields/DV01s are
  `yieldToMaturity`/`yieldMetrics`. One source of truth for each.
- **The hedge direction is documented** — `hedgeRatio` is a positive contract count whose DV01 matches the
  position; the doc says to SELL them against a long (positive-DV01) book.
- **Convention disclosed** — DV01s are per 100 face (the package convention); `futuresDv01` uses the CTD's
  **spot** DV01 / CF (the Hull desk approximation), and the forward yield is reported separately so the two
  aren't conflated.
- **Guards** — a non-finite `hedgeDv01`, and everything `bondFuture` already guards (bad dates, empty
  basket, degenerate cash-and-carry), all throw a typed `QuantError`.
- **Envelope (R2)** — returns the domain object + `assumptions` + `diagnostics`.

## Build checklist

1. `bondFutureHedge` composing `bondFuture` + `yieldToMaturity` + `yieldMetrics`.
2. Per-deliverable `DeliverableRisk`; CTD headline metrics; the `F·CF` implied forward yield.
3. `hedgeDv01` → `hedgeRatio`; `ensureFinite` guard.
4. Exports in `index.ts`; a deep-sweep first-touch fixture (single-arg-object → also garbage-swept).
5. Tests: the `futuresDV01 = ctdDV01/CF` + `hedgeRatio(CTD)=CF` identities, an FD-verified `ctdDV01`, the
   forward-yield round-trip, per-deliverable risk, a supplied `hedgeDv01`, and the guards; 100% coverage.

## Deferred (explicitly)

- **The short's delivery option (CTD switching)** value — needs a rate model over the delivery window, a
  larger feature (the remaining bond-future follow-up).
- A **forward DV01** variant (DV01 as of the delivery date) and a **basket-implied contract DV01** that
  blends deliverables by delivery probability.
