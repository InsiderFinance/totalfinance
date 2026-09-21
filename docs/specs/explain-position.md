# Spec — "Explain this position" narrative (`@totalfinance/strategy`)

> Roadmap Tier 3 → "Agent-native": _"An 'explain this position' narrative tool composing classify +
> metrics + probability + risk into prose an agent can relay."_ Status: **shipped** as `explainPosition`
> in `packages/strategy/src/explain.ts`, covered by `packages/strategy/test/explain.test.ts`, full CI
> green.

## Goal

Turn a `Position` into a **structured explanation plus a prose summary** an LLM/agent can relay verbatim
or a UI can render: what the structure **is**, the **thesis** it expresses (direction, whether it wants
movement or stability, its vol and time posture), the **economics** (credit/debit, max profit/loss,
breakevens, reward-to-risk), the **probability** of profit, and the **risks**. So "explain my iron
condor" returns a paragraph a person actually understands — grounded entirely in the exact engine
numbers, never invented.

## Why this is a composition, not a re-implementation

Every fact comes from an existing primitive; `explainPosition` narrates them:

- `classifyStrategy(position)` (classify.ts) — the structure's name(s), or none for a custom position.
- `Position.metrics()` — netDebit/credit, maxProfit, maxLoss, breakevens, reward-to-risk.
- `Position.pnlAtExpiry(S)` — the **market-free** payoff shape, for the directional / move posture.
- `Position.probability(market)` — probability of profit + expected value (needs a market).
- `Position.value(market).greeks` — delta/gamma/theta/vega, for the greek posture (needs a market).

It never fabricates a number: a claim in the prose is always a value one of the above produced.

## Postures (how the biases are derived)

- **directionalBias** `'bullish' | 'bearish' | 'neutral'` — from the payoff **tails** (market-free):
  compare `pnlAtExpiry` at a deep-low vs deep-high price; a materially higher high-side ⇒ bullish, low-side
  ⇒ bearish, comparable tails ⇒ neutral. (Size-normalized by the profit range, so it's scale-free.)
- **moveBias** `'wants-movement' | 'wants-stability' | 'neutral'` — from the payoff **shape** (market-free):
  the peak at the center (median strike) vs the tails; center-peaked ⇒ wants stability (short gamma),
  tail-peaked ⇒ wants movement (long gamma).
- **volatilityBias** `'benefits-from-rising-iv' | 'benefits-from-falling-iv' | 'neutral'` — from net **vega**
  (needs a market). **timeBias** `'decay-helps' | 'decay-hurts' | 'neutral'` — from net **theta**.

Direction and move posture are **always** available (payoff-shape). Volatility/time posture, probability, and
the raw greeks are included **when a market is available** (from `options.market` or the position's own);
if the market is insufficient (e.g. no vol for a leg without its own IV), those are omitted and the
summary says so — never a fabricated greek.

## API

```ts
interface ExplainPositionOptions {
  /** Market for probability + greeks (spot/vol/rate/asOf); merges over the position's own market. */
  market?: Partial<MarkToMarketInput>;
  /** Underlying name for the prose (e.g. 'AAPL'); default 'the underlying'. */
  underlyingLabel?: string;
}
type DirectionalBias = 'bullish' | 'bearish' | 'neutral';
type MoveBias = 'wants-movement' | 'wants-stability' | 'neutral';
type VolatilityBias = 'benefits-from-rising-iv' | 'benefits-from-falling-iv' | 'neutral';
type TimeBias = 'decay-helps' | 'decay-hurts' | 'neutral';
interface PositionExplanation {
  name: string; // the classification, or 'custom'
  aliases: string[]; // other payoff-identical names
  structure: string; // "short 1 put @ 95 ($2.00), long 1 put @ 90 ($1.00)"
  directionalBias: DirectionalBias;
  moveBias: MoveBias;
  definedRisk: boolean;
  economics: {
    net: number; // + = debit paid, − = credit received (per contract)
    maxProfit: number;
    maxLoss: number;
    breakevens: number[];
    rewardToRisk: number;
  };
  volatilityBias?: VolatilityBias; // present with a market
  timeBias?: TimeBias;
  probability?: { probabilityOfProfit: number; expectedValue: number };
  greeks?: { delta: number; gamma: number; theta: number; vega: number; rho: number };
  risks: string[]; // e.g. "Unbounded loss…", "Assignment risk on the short 95 put if ITM at expiry."
  summary: string; // the prose narrative composing all of the above
}
function explainPosition(position: Position, opts?: ExplainPositionOptions): PositionExplanation;
```

## Semantics & honesty contract

- **Grounded, never invented** — every prose claim traces to `classify`/`metrics`/`probability`/`greeks`;
  a value that couldn't be computed (no market) is omitted and the summary discloses that, rather than
  guessed. `∞`/`−∞` render as "unlimited"/"undefined risk".
- **Graceful degradation** — always returns classification + structure + economics + directional/move
  posture (all market-free); probability, greek posture, and raw greeks are added when the market allows.
- **Single-expiry** — the posture/economics use the expiration payoff; a calendar/diagonal throws the
  same typed error `metrics`/`pnlAtExpiry` already throw (a payoff diagram is single-expiration).
- Typed guards: a non-`Position`; a bad `opts`. Pure and deterministic (no clock — times are explicit).

## Build checklist

1. **Types** — the interfaces above.
2. **Facts** — `classifyStrategy`, `metrics`, the payoff-tail/shape postures; try `probability` + `value`
   for the market-dependent parts (catch a missing-market throw → omit).
3. **`structure`** — a readable leg list (sorted by strike; sign, qty, kind, strike, premium).
4. **`risks`** — undefined-risk, per-short-leg assignment risk, decay-against-you for long premium.
5. **`summary`** — compose a natural paragraph adapting to what's available (with/without market).
6. **Exports + API report + READMEs/llms.**
7. **Tests** — an iron condor reads neutral / wants-stability / short-vol / decay-helps / defined-risk,
   with the right breakevens + PoP; a bull call spread reads bullish; a long straddle reads
   wants-movement / long-vol; a naked short put flags undefined risk + assignment; a custom position is
   named 'custom' but still explained; no-market degrades gracefully (no greeks, disclosed); a
   multi-expiry position throws; the summary contains the key numbers and no `NaN`/`undefined`; every
   prose number traces to a primitive; guards.

## Deferred (explicitly)

- **Scenario narrative** ("if it drops 5%, you'd be down $X") composing `scenarioTable`.
- **A payoff picture alongside the prose** — pair with `payoffSvg` (an agent artifact with words + chart).
- **Localization / tone options** (terse vs teaching); v1 is one clear register.
