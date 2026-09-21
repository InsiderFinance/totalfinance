# Spec — Research-protocol pack (`@totalfinance/risk`)

> Roadmap Tier 3 → "Agent-native": _"A research-protocol pack: hypothesis → walk-forward test →
> deflated-Sharpe verdict, so agents do statistically honest research by construction (the
> anti-overfitting machinery already exists)."_ Status: **shipped** as `researchProtocol` in
> `packages/risk/src/research-protocol.ts`, covered by `packages/risk/test/research-protocol.test.ts`,
> full CI green.

## Goal

Overfitting is the #1 way a backtest lies: try enough configurations and one will look brilliant by
chance. The primitives to defend against it exist (`deflatedSharpeRatio`, `walkForwardSplits`,
`probabilisticSharpeRatio`) but an agent has to know to chain them correctly. `researchProtocol` bundles
the discipline into **one call that returns a verdict**: given the selected strategy's returns, **how
many configurations were tried**, and (ideally) its **out-of-sample** returns, it deflates the Sharpe
for selection, checks out-of-sample survival, and returns `significant` / `inconclusive` /
`likely-overfit` with a prose rationale an agent relays — so honest research is the path of least
resistance, not an extra step.

## Why this is a composition, not a re-implementation

Every statistic comes from `research.ts`; the pack sequences them and renders a verdict:

- `sharpeStatistics(returns)` — per-observation Sharpe + skew/kurtosis for the non-normal adjustment.
- `probabilisticSharpeRatio(stats, benchmark)` — P(true Sharpe > benchmark).
- `deflatedSharpeRatio(stats, trials)` — the PSR against the **expected maximum** Sharpe `N` trials
  produce by chance (Bailey & López de Prado 2014), so selecting the best of a sweep is penalized.
- `walkForwardSplits` / `backtest.walkForward` produce the out-of-sample returns the caller passes in.

## The verdict logic

1. **Deflate.** `deflatedSharpe = P(true SR > SR₀)` where `SR₀` is the expected-max Sharpe of `trialCount`
   (or `0` for a single pre-registered hypothesis, i.e. no selection). `deflatedSharpe ≥ confidence`
   (default 0.95) is **necessary** — an in-sample edge that doesn't clear the multiple-testing bar is
   selection, not skill.
2. **Confirm out-of-sample** (when OOS returns are given). Compute the OOS Sharpe and the **degradation**
   `1 − SR_oos / SR_is`. A vanished edge (`SR_oos ≤ 0`) fails; a halved edge (`degradation > 0.5`) is
   suspect.
3. **Verdict:**
   - `likely-overfit` — deflation fails, **or** OOS given and `SR_oos ≤ 0`.
   - `significant` — deflation passes **and** OOS given with `SR_oos > 0` and `degradation ≤ 0.5`.
   - `inconclusive` — deflation passes but there's **no OOS** (confirm it), or OOS is positive-but-halved.

Only deflation **and** out-of-sample survival earns `significant`: an in-sample number alone — however
deflated — is never enough. This is the "honest by construction" contract.

`minTrackRecordLength` (MinTRL) is reported too: the observations needed for `deflatedSharpe ≥
confidence`, i.e. `1 + [1 − γ₃·SR + (γ₄−1)/4·SR²]·(Z_c/(SR − SR₀))²` (`∞` when `SR ≤ SR₀` — never
significant at any length).

## API

```ts
interface ResearchProtocolInput {
  /** The selected strategy's in-sample return series (per period). */
  returns: ArrayLike<number>;
  /**
   * The pool that produced the selection, for deflation. Omit for a single pre-registered hypothesis
   * (no selection → SR₀ = 0). `trialSharpes` are the per-observation Sharpes of every config tried.
   */
  trials?: { trialSharpes: ArrayLike<number> } | { trialCount: number; varianceSharpe: number };
  /** Out-of-sample (e.g. walk-forward) returns of the SAME strategy — confirmatory. */
  outOfSampleReturns?: ArrayLike<number>;
  /** Confidence for "significant" (0,1); default 0.95. */
  confidence?: number;
  /** Periods per year for the annualized read-outs; default 252. */
  periodsPerYear?: number;
  riskFreeRate?: number;
}
interface ResearchVerdict {
  verdict: 'significant' | 'inconclusive' | 'likely-overfit';
  inSample: { sharpe: number; annualizedSharpe: number; observations: number };
  deflatedSharpe: number; // P(true SR > SR₀)
  probabilisticSharpe: number; // un-deflated (benchmark 0)
  expectedMaxSharpe: number; // SR₀
  trialCount: number;
  /** Observations needed for deflatedSharpe ≥ confidence (∞ when SR ≤ SR₀). */
  minTrackRecordLength: number;
  outOfSample?: { sharpe: number; annualizedSharpe: number; degradation: number };
  rationale: string; // prose an agent relays
  assumptions: { conventionsVersion: string; confidence: number; periodsPerYear: number };
  diagnostics: Diagnostics;
}
function researchProtocol(input: ResearchProtocolInput): ResearchVerdict;
```

## Honesty / envelope contract

- **`significant` requires OOS survival** — deflation alone caps at `inconclusive`; the rationale then
  says exactly what's missing ("passes deflation; provide out-of-sample returns to confirm").
- **No fabricated confidence** — `SR ≤ SR₀` ⇒ `minTrackRecordLength = ∞` and the verdict cannot be
  `significant`; a negative OOS Sharpe ⇒ `likely-overfit`, never hedged.
- **Deflation is disclosed** — `trialCount`, `expectedMaxSharpe`, and the un-deflated `probabilisticSharpe`
  all surface, so the selection penalty is visible.
- Typed guards (≥ 3 in-sample returns; valid `confidence`/`periodsPerYear`; `trials` well-formed); pure
  and deterministic.

## Build checklist

1. **Types** — the interfaces above.
2. **Stats** — `sharpeStatistics` in-sample; `deflatedSharpeRatio` (or PSR when no `trials`); `sharpeStatistics` +
   `probabilisticSharpeRatio` OOS.
3. **MinTRL** — closed form from the PSR denominator; `∞` when `SR ≤ SR₀`.
4. **Verdict + rationale** — the three-way logic above and its prose.
5. **Exports + API report + READMEs/llms.**
6. **Tests** — a strong single strategy (high deflated Sharpe) + good OOS ⇒ `significant`; the best of
   many random trials (deflated Sharpe collapses) ⇒ `likely-overfit`; deflation-passes-but-no-OOS ⇒
   `inconclusive` (disclosed); a vanished OOS edge ⇒ `likely-overfit`; MinTRL is finite when `SR > SR₀`
   and `∞` otherwise; the un-deflated PSR ≥ the deflated one; the rationale carries the numbers, no
   `NaN`; envelope/guards.

## Deferred (explicitly)

- **Run the walk-forward for the caller** — a convenience that takes a `backtest.walkForward` result and
  extracts the OOS returns automatically (v1 takes the returns directly).
- **PBO** (probability of backtest overfitting, combinatorially-symmetric CV) as a second overfitting
  lens alongside the deflated Sharpe.
- **A deflated Sortino / Calmar** variant for non-Sharpe objectives.
