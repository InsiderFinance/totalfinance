# Strategy catalogue (`@insiderfinance/totalfinance/strategy`)

The strategy package builds an option **position** from legs and computes the full profit-calculator
surface: expiration payoff, breakevens, max profit/loss, mark-to-market value + Greeks, probability of
profit / expected value (closed-form and Monte-Carlo, optionally smile-aware), and a scanner that ranks
structures. Start with instrument-first legs for custom positions, or use a named whole-position
preset when you already know the structure you want.

## Custom positions: instrument plus signed quantity

`legs.call`, `legs.put` and `legs.stock` return plain leg records. Quantity is required: positive
means long, negative means short. Options use contracts; stocks use shares. No size or direction
is silently assumed, and no strategy name is required for calculation.

```ts
import { legs, strategy } from '@insiderfinance/totalfinance/strategy';

const position = strategy([
  legs.call({ strike: 100, premium: 6, quantity: 2 }),
  legs.call({ strike: 110, premium: 2, quantity: -1 }),
]);
const payoff = position.payoff({ prices: [80, 90, 100, 110, 120] });
console.log(payoff.points);
// [
//   { underlyingPrice: 80, pnl: -1000 },
//   { underlyingPrice: 90, pnl: -1000 },
//   { underlyingPrice: 100, pnl: -1000 },
//   { underlyingPrice: 110, pnl: 1000 },
//   { underlyingPrice: 120, pnl: 2000 },
// ]
```

The same request shape works for puts: `legs.put({ strike: 90, premium: 3, quantity: -2 })`.
Stock uses its entry price: `legs.stock({ price: 100, quantity: -50 })`. Premiums and stock prices
are per share; the Position's option multiplier defaults to 100 and never scales stock shares.
Optional `expiry` and `impliedVolatility` on call/put legs preserve per-leg inputs for calendars,
diagonals and observed volatility skew. Omit `premium` with explicit model-pricing configuration
when you have strikes but no entry fills.

Raw records are equally supported. In an editor, keep these in your own state and rebuild after
edits; a constructed Position is an immutable snapshot. Zero quantity is rejected, so remove an
inactive row before calculating. Signed position quantity is not a trade instruction: a buy to
close reduces an existing short, rather than necessarily creating a long.

```ts
import type { LegInput } from '@insiderfinance/totalfinance/strategy';

const editableLegs: LegInput[] = [
  { kind: 'call', strike: 100, premium: 6, quantity: 2 },
  { kind: 'call', strike: 110, premium: 2, quantity: -1 },
];
editableLegs[0]!.quantity = -2;
const editedPosition = strategy(editableLegs);
console.log(editedPosition.pnlAtExpiry(120)); // -3600 USD
```

These constructors replace the pre-release direction-specific leg helpers. A named **Position**
preset such as `strategy.longCall(...)` remains distinct: it returns a ready-to-calculate Position,
not a leg, and its positive quantity scales the named structure. Use the three leg constructors
for custom compositions; presets are optional starting points, not an alternative leg model.

## Named position presets

Every builder is **pure and data-agnostic**: it takes explicit strikes and premiums (not a live chain)
and returns a `Position`. Leg compositions mirror the InsiderFinance option profit calculator 1:1. The
example below is bundled against the package source and executed in CI (`docs/examples/guides.test.ts`),
so it can never rot; a fuller runnable walkthrough lives in [`docs/examples/strategies.test.ts`](../examples/strategies.test.ts).

```ts
const condor = strategy.ironCondor({
  putLong: { strike: 90, premium: 0.7 },
  putShort: { strike: 95, premium: 1.5 },
  callShort: { strike: 105, premium: 1.6 },
  callLong: { strike: 110, premium: 0.8 },
});
condor.metrics(); // netCredit, maxProfit, maxLoss, breakevens
condor.probability({
  spot: 100,
  asOf: '2026-07-06T10:30:00-04:00', // a valuation instant names its time of day
  expiry: '2026-08-21',
  volatility: 0.25,
  riskFreeRate: 0.03,
}); // POP, EV
```

Conventions: **long = positive quantity, short = negative**; option `quantity` is contracts (× the 100
multiplier); stock legs are in shares (100 shares per contract of cover). Every builder accepts an
optional positive `quantity` (number of structures, default 1) that scales all legs, and an optional
`PositionConfig`. Unlike a signed custom leg, a negative preset size is rejected so it cannot invert
the named strategy.

## Directional & vertical

| Builder                                           | Legs                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `longCall` / `shortCall` / `longPut` / `shortPut` | single option leg                                                 |
| `cashSecuredPut`                                  | short put (same payoff; "secured" is a margin distinction)        |
| `bullCallSpread` / `bearCallSpread`               | call debit / credit vertical                                      |
| `bullPutSpread` / `bearPutSpread`                 | put credit / debit vertical                                       |
| `longCombo` / `shortCombo`                        | long call + short put / short call + long put (different strikes) |

## Ladders (3 strikes, one type)

| Builder          | Legs                                              |
| ---------------- | ------------------------------------------------- |
| `bullCallLadder` | long lower call, short middle + short upper calls |
| `bearCallLadder` | short lower call, long middle + long upper calls  |
| `bullPutLadder`  | short upper put, long middle + long lower puts    |
| `bearPutLadder`  | long upper put, short middle + short lower puts   |

## Ratio spreads & backspreads

| Builder                                      | Legs (default ratio 1×2, configurable)            |
| -------------------------------------------- | ------------------------------------------------- |
| `callRatioSpread` / `putRatioSpread`         | long 1 near option, short `ratio` further options |
| `callRatioBackspread` / `putRatioBackspread` | short 1 near option, long `ratio` further options |

## Butterflies & condors (one type)

| Builder                                          | Legs                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| `longCallButterfly` / `longPutButterfly`         | long / short×2 / long                                  |
| `shortCallButterfly` / `shortPutButterfly`       | short / long×2 / short                                 |
| `callBrokenWing` / `putBrokenWing`               | broken-wing (skip-strike) butterfly, long/short×2/long |
| `inverseCallBrokenWing` / `inversePutBrokenWing` | short/long×2/short                                     |
| `longCallCondor` / `longPutCondor`               | long / short / short / long (4 strikes)                |
| `shortCallCondor` / `shortPutCondor`             | short / long / long / short                            |

## Iron & volatility

| Builder                      | Legs                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `ironCondor`                 | long put / short put / short call / long call             |
| `inverseIronCondor`          | short outer / long inner                                  |
| `ironButterfly`              | long put wing / short body put + call / long call wing    |
| `inverseIronButterfly`       | short wings / long ATM straddle                           |
| `straddle` / `shortStraddle` | long / short call + put at one strike                     |
| `strangle` / `shortStrangle` | long / short call + put at separate strikes               |
| `guts` / `shortGuts`         | long / short ITM call (lower) + ITM put (upper)           |
| `strip` / `strap`            | long 1 call + 2 puts / long 2 calls + 1 put (same strike) |
| `jadeLizard`                 | short put + short call + long higher call                 |
| `reverseJadeLizard`          | short call + short put + long lower put                   |

## Synthetics & stock combinations

| Builder                                         | Legs                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `longSyntheticFuture` / `shortSyntheticFuture`  | long call + short put / short call + long put (same strike) |
| `syntheticPut`                                  | short stock + long call                                     |
| `coveredCall`                                   | long 100·q shares + short q calls                           |
| `protectivePut`                                 | long 100·q shares + long q puts                             |
| `collar`                                        | long stock + long protective put + short covered call       |
| `coveredShortStraddle` / `coveredShortStrangle` | long stock + short call + short put                         |

## Multi-expiry (calendars & diagonals)

These carry a **per-leg `expiry`** (short = near, long = far). Value them with `Position.value()` **at the
near expiry**, where the short leg expires to intrinsic while the long leg still holds time value — the
classic calendar "tent". The static expiration `metrics()` assumes a single terminal and is not
meaningful for these; use `value()` / `scenarioTable()` at the near-expiry date instead.

| Builder                                    | Legs                                     |
| ------------------------------------------ | ---------------------------------------- |
| `calendarCallSpread` / `calendarPutSpread` | short near + long far, same strike       |
| `diagonalCallSpread` / `diagonalPutSpread` | short near + long far, different strikes |
| `doubleDiagonal`                           | short near strangle + long far strangle  |

## Scanner

`scanStrategies(opts)` enumerates the defined-risk single-expiry structures over a strike grid, scores
each with the payoff/probability metrics plus a bid/ask liquidity score, filters (`minProbabilityOfProfit`, `maxRisk`,
`maxWidth`), and ranks by `pop | ev | return | expectedValuePerRisk`. Missing premiums are priced from a `volatility` or
per-strike `smile` via Black–Scholes. See the example test for a runnable call.
