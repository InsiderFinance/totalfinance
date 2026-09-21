# ADR 0002 - Acceleration (WASM/native) decision after Phase 5

- Status: **Accepted**
- Date: 2026-06-29
- Deciders: TotalFinance maintainers
- Related: spec §2 (design law #10, "correctness before speed"), §19 (Performance Architecture),
  §24 (Phase-7 acceptance gate: "optional WASM/native acceleration" + "benchmark suite")

> **Current implementation authority:** this ADR preserves the Phase-5 decision not to accelerate
> without measured end-to-end benefit and the benchmark evidence behind it. The later
> [MCP, acceleration, and data-growth strategy](../mcp-acceleration-data-growth-strategy.md)
> supersedes its provisional backend-selection order and owns any future WASM/native API. The
> [Phase 3B.N naming specification](../specs/phase-3b-public-naming-normalization.md) owns every
> public name in that implementation. Do not implement the historical “native → WASM → TypeScript”
> sentence below as an implicit fallback contract.

## Context

The Phase-5 acceptance gate asks: **"Benchmarks decide whether WASM/native work is justified."** Design
law #10 is _correctness before speed_ — pure-TypeScript reference kernels ship first, and an accelerated
backend is added only "after benchmarks identify a real hot path" (§19.1). WASM/native acceleration and a
full benchmark suite are themselves Phase-7 deliverables (§24); this ADR records the Phase-5 decision and
the evidence behind it.

## Measurements

Representative benchmarks were added for the Phase-5 hot kernels (run via `pnpm bench`, Node, single
core, Apple Silicon; `vitest bench`):

| Kernel                                             | Mean      | Throughput  |
| -------------------------------------------------- | --------- | ----------- |
| Heston COS European price (256 terms)              | ~0.091 ms | ~10,970 / s |
| Implied vol solve (Brent/Newton)                   | ~0.78 µs  | ~1.29 M / s |
| SVI surface calibration (3 expiries × 15 strikes)  | ~3.3 ms   | ~300 / s    |
| Vectorized backtest (2,000 bars, weekly + costs)   | ~0.60 ms  | ~1,680 / s  |
| Event-driven backtest (2,000 bars, broker sim)     | ~0.27 ms  | ~3,750 / s  |
| Constrained min-variance (20 assets, sector cap)   | ~0.43 ms  | ~2,340 / s  |
| CVaR optimization (250 scenarios × 20 assets)      | ~32.6 ms  | ~31 / s     |
| Scenario map 121×3×4 over ~360 contracts (Phase 3) | ~265 ms   | ~3.8 / s    |

## Decision

**No WASM/native acceleration is justified in Phase 5.** Every Phase-5 reference kernel completes in
sub-millisecond to low-tens-of-milliseconds on a single core — comfortably inside interactive latency
budgets for the request shapes these APIs serve (price a contract, fit one expiry's smile, run a backtest
over a few thousand bars, optimize a few-dozen-asset book). The pure-TypeScript kernels are correct
(cross-validated analytic↔simulation and against closed-form/KKT references) and fast enough. Adding a
WASM/native backend now would add build complexity, a correctness-parity surface, and bundle weight for
no user-visible benefit.

## What would change the decision (Phase-7 reassessment)

The two heaviest kernels are **batch/analytical, not interactive**, and are the first candidates to
revisit when the Phase-7 benchmark suite lands:

- **Scenario maps** (~265 ms for a 1,452-cell grid over ~360 contracts) — already labelled an
  "acceleration-need benchmark"; a struct-of-arrays typed-array kernel is the natural first port.
- **CVaR optimization** (~33 ms; projected-subgradient, scales with scenarios × assets × iterations) —
  large scenario sets (10k+ × 100+ assets) would push this into the hundreds of ms.

Per §19.2-3 the path is _native if installed → WASM → TypeScript_, and any accelerated backend must match
the reference outputs within documented tolerances (law #10). Until a real workload crosses an interactive
threshold, the reference kernels stand. The `pnpm bench` files committed alongside this ADR are the seed of
the Phase-7 suite.
