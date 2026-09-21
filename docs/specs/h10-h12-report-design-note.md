# H10–H12 report design note (Phase 3B.3 — drafting only, not implemented)

The three remaining Risk heads in the phase-3b decision ledger are successful-result-shape breaks:
each returns a detached plain value today and must return a report in the library's Law 2 grammar
(`assumptions: { conventionsVersion, … }` + `diagnostics: { warnings }` + named fields — the
`CdsValuation` / `BacktestResult` / `PortfolioVaRResult` shape). This note records the target
shapes, the breakage, and the migration list. Source lives in `packages/risk/src/value-at-risk.ts`
(H10) and `packages/risk/src/scenario.ts` (H11, H12).

## H10 — `riskContributions`

Current: `riskContributions(weights: ArrayLike<number>, covariance: Matrix): RiskContribution[]`
where `RiskContribution = { asset, marginal, component, percent }` and zero portfolio volatility
fabricates `marginal: 0, percent: 0` (value-at-risk.ts:663–667).

Ledger demands: portfolio volatility + contribution rows + assumptions + diagnostics; rename
`percent` → `fraction` (it sums to 1); zero-σ rows carry `null` with a field-specific reason.

```ts
export interface RiskContributionRow {
  asset: number;
  /** ∂σ_p/∂w_i; null when σ_p = 0 (undefined derivative), with a DegenerateInput warning. */
  marginal: number | null;
  /** w_i · marginal; Σ component = σ_p. Null under the same degenerate case. */
  component: number | null;
  /** component / σ_p; Σ fraction = 1. Renamed from `percent`. Null under the same case. */
  fraction: number | null;
}
export interface RiskContributionsResult {
  assumptions: { conventionsVersion: string; assets: number; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] }; // WarningCode.DegenerateInput names the null fields
  portfolioVolatility: number;
  contributions: RiskContributionRow[];
}
```

Breaks: `packages/risk/test/value-at-risk.test.ts:195–200` (array reduce over `c.percent` /
`c.component`), `packages/risk/test/index.test.ts:41–42` (`rc.reduce(… c.percent)`).
`packages/risk/test/portfolio-covariance-contract.test.ts:123` survives (asserts a throw).

## H11 — `stressTest`

Current: `stressTest<T>(input: StressTestInput<T>): ScenarioResult[]` — a bare array of
`{ scenario, pnl, byPosition, attribution }` rows (scenario.ts:491). Two ledger defects: no
envelope, and the custom-reprice path defaults the base mark to zero
(`const base = pos.greeks?.value ?? 0;`, scenario.ts:508).

```ts
export interface StressTestResult {
  assumptions: {
    conventionsVersion: string;
    scenarios: number;
    positions: number;
    /** Book-level valuation summary: 'greeks-taylor' | 'custom-reprice' | 'mixed'. */
    valuation: string;
    [k: string]: unknown;
  };
  diagnostics: { warnings: QuantWarning[] };
  scenarios: ScenarioResult[]; // rows unchanged; PositionScenarioResult gains
  // `valuationMethod: 'greeks-taylor' | 'reprice'`
}
```

Semantic correction: when `options.reprice` is supplied, a position must carry an explicit current
mark — a new dedicated `Position.value?: number` or `greeks.value`; neither present ⇒ typed
`input.missing_field` rejection (ledger verification line 335), never an assumed 0 base.

Breaks: `packages/risk/test/scenario.test.ts:179–211` (array indexing `res[0]`, and the two pins
`expect('assumptions' in r.attribution).toBe(false)` documenting the old "helper stays plain"
role — those assertions invert on the ENVELOPE while inner attributions stay bare),
`packages/risk/test/index.test.ts:50–57` (`stress[0]!.pnl`). `packages/risk/src/book.ts:319`
migrates to `stressTest({ … }).scenarios` so `BookReport.scenarios?: ScenarioResult[]` and
`packages/risk/test/book.test.ts:116–123` stay unchanged (no nested envelope inside a report).

## H12 — `scenarioGrid`

Current: `scenarioGrid(input: ScenarioGridInput): number[][]` — a detached matrix; the axes and
the percent-vs-absolute shock semantics live only in the caller's head (scenario.ts:556).

```ts
export interface ResolvedGridShock {
  factor: 'spot' | 'volatility';
  kind: 'percent' | 'absolute';
  value: number;
  /** The resolved ABSOLUTE move applied (percent spot shocks scaled by greeks.spot). */
  resolvedMove: number;
}
export interface ScenarioGridResult {
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
  spotAxis: ResolvedGridShock[];
  volatilityAxis: ResolvedGridShock[];
  /** pnl[i][j] = P&L per unit at spotAxis[i] × volatilityAxis[j]. */
  pnl: number[][];
}
```

A serialized result is then self-interpreting without separately retained input axes (ledger
verification line 336). The resolved moves come from the same `taylorPnlKernel` moves echo that
`taylorPnl` already discloses.

Breaks: `packages/risk/test/scenario.test.ts:214–226` (direct `grid[i][j]` indexing and
`toHaveLength(3)` → `res.pnl`).

## Migration list (grep of the repo, excluding the two defining files)

- `packages/risk/src/book.ts:319` — the only in-library consumer (`stressTest`); see H11 above.
- `packages/risk/src/index.ts:21,30,36,46–47` — re-export the new result types
  (`RiskContributionsResult`, `StressTestResult`, `ScenarioGridResult`, `ResolvedGridShock`);
  `packages/totalfinance/src/index.ts:81` re-exports `ScenarioGridInput` and inherits the rest.
- Tests: the files/lines named per head above, plus `packages/risk/test/index.test.ts:15,18`
  (export-surface list, unchanged names).
- `tools/first-touch/fixtures/fi-vol-risk.ts:557,582,585` — input thunks, shape-agnostic; no edit.
- `tools/manifest/conformance.test.ts:468–473` — delist `risk:riskContributions`,
  `risk:stressTest`, `risk:scenarioGrid` from the shrink-only `HELPER_QUANT_ANSWER_BACKLOG`, and
  hand-reclassify the three in `tools/manifest/packages/risk.json` (Manifest Law 1 — never
  `manifest:update`).
- Artifacts: regenerate naming → contract → enforcement → validation → signatures in order per
  `totalfinance/docs/implementation-order.md` (explicitly out of scope for this drafting pass).
