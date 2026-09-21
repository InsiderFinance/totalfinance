# App dogfooding implementation tracker

Status: implementation complete; integrated checks green. Browser/data acceptance and rollout
remain gated below. Implements the repairs and all recommended app migration slices of
[the comparison and adoption plan](./app-dogfooding-comparison.md), requested September 7, 2026.

The additional reusable SDK capabilities discovered during adoption are tracked separately in
[dogfooding-driven library value](../specs/dogfooding-library-value.md). They extend the library's
supplied-Greek, chain-health and saved-comparison workflows; they do not change the app's default
engine or waive this document's browser/data acceptance gates.

## Implementation decisions

- Preserve the app's ACT/365.25 elapsed time, 16:00 Eastern date-only expiry, 100-share option
  multiplier and near-expiry intrinsic cutoff in the compatibility adapter. Do not alter `asOf`
  or change the public TotalFinance conventions to produce matching numbers.
- Keep the legacy engine as the default. Provide explicit shadow and opt-in TotalFinance modes, a
  rollback, and bounded comparison diagnostics; no production deployment or global enablement.
- Keep observed skew and current GEX/DEX sign/wall definitions. Repair the inconsistent GEX IV
  simulation snapshot without redefining those metrics.
- The user subsequently approved the later GEX/DEX, observed-skew and premium-drift migrations.
  Port the relevant PR #286 functionality onto current develop without overwriting newer app work;
  do not publish packages or deploy the app as part of implementation.
- Browser acceptance and production rollback exercises are evidence gates, not checkboxes to mark
  complete from source tests. Local app browser inspection was requested, but the subsequent browser
  permission prompt denied access to `127.0.0.1:3100`. Browser acceptance is blocked; do not bypass
  the denied action through another browser or automation route.

## Implementation checklist

- [x] Repair stock-independent option expiry inference and regression-test natural raw positions.
- [x] Correct app stock strategy sizing for multiple units and isolate Jest from library Vitest.
- [x] Propagate unavailable IV and zero-cost return states through pricing, results and UI.
- [x] Use a consistent adjusted-IV GEX headline/profile/root snapshot; preserve observed skew.
- [x] Build a typed prepared OPC adapter using public batch pricing, terminal settlement, stock
      P&L, first-order Greeks, strike injection and break-even refinement.
- [x] Wire graph, payoff table and time scrub through one engine-selection seam with default-off
      shadow/opt-in controls, safe rollback and bounded diagnostic output.
- [x] Verify all 58 app strategy builders, sizes 1/2/10, calendar/diagonal/time boundaries,
      recorded quote IV outcomes, malformed inputs and comparison diagnostics.
- [x] Consume packed artifacts through Yarn and verify public exports/types/browser bundling.
- [x] Add public observed-skew analysis and migrate the app's observational skew adapter, retaining
      actual observed wings and explicit unavailable results rather than fitted substitutes.
- [x] Add guarded GEX/DEX model comparison and opt-in paths with visible observed/model labels,
      explicit conventions and unchanged app-specific sign/wall semantics.
- [x] Add public session-aware option-premium drift, explicit classification provenance and causal
      price overlays; integrate the net-drift app workflow without changing current flow features.
- [x] Run targeted and integrated tests/typechecks; reconcile findings against the original plan.
- [x] Update handoff documentation with exact verification evidence and remaining external gates.
- [ ] Browser chart/table/scrub, failure-state, GEX/skew/drift and mobile acceptance.

Each item is checked only after verification. The original comparison is historical evidence;
this tracker records the repairs and actual adoption status.

## What is implemented

### A/B: repairs and OPC

The five stock builders scale shares with strategy units; raw stock-plus-dated-option positions
no longer invent a stock expiry. Failed IV is unavailable, not a fabricated 15.1%, and an explicit
user estimate is labelled as such. Zero-cost return percentages carry a reason instead of Infinity.
The maximum-risk percentage similarly reports unavailable for zero, missing or unbounded loss;
neither an epsilon nor a fabricated $1 denominator survives. Both new financial-ratio helpers take
named object arguments. The table tooltip explains the particular unavailable ratio being displayed.
Live zero-spot pricing uses its analytic limit, and break-even refinement no longer invents roots
after a rounded zero plateau.

The app's prepared adapter calls public `@totalfinance/options/batch`. Graph, payoff table and time scrub
share one immutable selected-leg snapshot and one engine-selection seam. Shared input checks run
before either engine, including sparse arrays and workload limits; candidate failure does not
launder malformed input into a legacy success. Comparison checks prices/P&L, five separately scaled
Greeks, break-evens and return-on-cost consistency. A tiny debit does not amplify an otherwise
acceptable dollar difference into a false ratio mismatch. Each surface retains its own rollback
status; a matching point cannot conceal a failed table. Diagnostics are bounded and local-only,
with no cross-user SSR history or vendor-payload upload.

The model remains the app's European, zero-dividend analytic proxy. American exercise, actual
dividends, non-100 contract multipliers, different day counts, probability of profit and the app's
profit-factor heuristic have **not** been silently migrated or certified by BSM agreement.
See [OPC contracts](../../../src/screens/OptionsProfitCalculatorStrategy/volatility-and-return-contracts.md)
and [the adapter](../../../src/utils/shared/totalfinance/opcAdapter.ts).

### C: GEX/DEX and observed skew

Public batch Greeks feed the app's existing aggregation, sign, wall and concentration definitions.
The supplied-gamma/delta baseline stays distinct from the model view. GEX simulation now uses the
same shocked-IV snapshot for headline exposure, profile and roots. A model or simulated snapshot
does not enter observed change-history baselines. Filtered and unfiltered views roll back together
when a shared candidate fails. Vendor/model differences are disclosed, not forced through an
equality gate or treated as proof the vendor is wrong.

`@totalfinance/volatility` now exports `observedSkew({ quotes, market, config })`. It reports actual
observed strikes/deltas, exclusions, conventions and unavailable reasons. It never manufactures
missing wings with model interpolation. Decimal ties and symmetric moneyness windows are stable;
required fields are still checked on every quote, with an invocation-local cache for identical
expiry-coordinate validation. The app partitions quotes by expiry once, avoiding repeated whole-chain
validation. It exposes an index map, per-expiry numerical differences and raw public read inspection.
Skew availability is independent of successful exposure comparison. One server-corrected clock
drives pricing/filtering; genuine future observations remain ineligible without rewriting timestamps.

The app deliberately selects put-minus-call risk reversal. The library default is call-minus-put;
all IV/RR/BF units are decimal until the app's explicit display conversion. Missing OTM sides and
IV-bearing quote counts can differ from the legacy observer; these method differences are disclosed.
See [GEX contracts](../../../src/utils/client/gex/totalfinance-contract.md).

### D: premium drift

`@totalfinance/structure` now exports `optionFlowDrift({ trades, session, config })`, a session-aware
premium-accounting operation distinct from dealer hedging drift. Classification policy distinguishes
authoritative unknowns from missing provider classification. Raw dollars, exclusive as-of cutoffs,
regular/half-day sessions, duplicate handling, and causal named price overlays are explicit.
Unknown-premium bounds are not statistical confidence intervals. Minute and cumulative coverage
have separate fields and labels; malformed overlay values fail before zero-sentinel handling.

The relevant PR #286 UI was ported onto current develop, not merged wholesale. Flow and ticker
research retain their existing graph mode. The new default-off view uses independently authorized
all-side smart-flow requests, disclosed filter scope, an explicit Eastern session and loaded-subset
warnings. It cannot infer net flow from an ask-only feed or bypass subscription checks.
See [app usage and policy](../../../src/components/NetDrift/README.md) and
[public premium-drift semantics](../../packages/structure/OPTION-FLOW-DRIFT.md).

Both new library operations are classified public SDK surfaces and included in generated reference
and LLM documentation. They are **not new MCP tools**: the transport allowlist remains deliberate.
Agents using the SDK can call them directly; a future transport addition must keep observed skew
distinct from fitted skew and option-premium drift distinct from dealer hedging drift.

## Local controls and rollback

The app consumes six unpublished, content-addressed tarballs through ordinary public package
resolution and Yarn. Follow [packed consumption](../../../vendor/totalfinance/README.md); no app import
depends on a private TotalFinance source path. The normal working checkout and its dependencies were
not changed; this implementation lives in the isolated PR worktree.

| Feature                 | Opt-in                                                                                     | Rollback                                           |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| OPC                     | `NEXT_PUBLIC_TOTALFINANCE_OPC_MODE=shadow` or `totalfinance`                               | Unset or `legacy`, then restart/rebuild            |
| GEX/DEX + observed skew | `NEXT_PUBLIC_TOTALFINANCE_GEX_MODE=shadow` or `totalfinance`; session selector on the page | Select legacy; unset build flag for default legacy |
| Trading-premium drift   | `NEXT_PUBLIC_TOTALFINANCE_NET_DRIFT=1`                                                     | Unset; existing flow graph remains available       |

Shadow preserves displayed legacy results. OPC opt-in still requires measured agreement; GEX opt-in
permits explicitly labelled vendor/model differences. These controls do not authorize deployment,
data redistribution, publication, or live trading. Keep duplicate legacy math until browser/data
acceptance is complete and a separate rollout/removal change is approved.

For a manual local review in a worktree without its own ignored environment file, use the existing
development environment without copying credentials into tracked files. From the app root:

```sh
DOTENV_CONFIG_PATH=/absolute/path/to/existing-app/.env.development \
NEXT_PUBLIC_TOTALFINANCE_OPC_MODE=shadow \
NEXT_PUBLIC_TOTALFINANCE_GEX_MODE=shadow \
NEXT_PUBLIC_TOTALFINANCE_NET_DRIFT=1 \
node -r dotenv/config node_modules/next/dist/bin/next dev -p 3100
```

OPC is `/options-profit-calculator`; GEX is `/gamma-exposure/SPY`. The premium-drift routes and
session query parameters are listed in the NetDrift guide. Use a session available to the signed-in
development account. This recipe is for the subsequent authorized manual review; no browser pass
is claimed here and no server was left running.

## External acceptance still required

- Authenticated local browser review, chart/table/time-scrub interactions, missing-data and rollback
  UX, and desktop/mobile performance: blocked by the denied browser permission prompt. The attempted
  browser visit did not happen. No alternative browser route was used.
- Permitted fresh vendor GEX snapshots and real premium tapes. The recorded OPC fixture contains
  196 sampled June 4 quotes; GEX and drift comparison tapes are synthetic, not vendor truth.
- Runtime support/release matrix and actual production rollout approval. Local Node 26 checks and
  compile-only Next builds are not public-release or full static-generation certification.
- **Security action:** rotate the Sentry upload credential exposed by the existing webpack
  dry-run logger during local verification. No credential value is recorded here. Local/dry-run
  builds now disable both upload plugins and no longer log the Next configuration; configuration
  regressions verify this while preserving normal production uploads. Rotation remains a maintainer
  action, separate from the implemented prevention.

No live trading, data publication, package publication or deployment was performed.

## Verification evidence

Local toolchain: Node 26.5.0 on Apple M4, app TypeScript 5.4.5 / Yarn 1.22.22 and the library's pinned
TypeScript 5.9.3 / pnpm 10.32.0. This is one local runtime, not the supported-release CI matrix.

- Six genuine packed packages (1,651,611 compressed bytes) pass receipt/content-hash freshness and
  cold-cache offline/frozen Yarn installation. All 70 public entrypoints typecheck with app TS5.4.5
  in node, bundler and NodeNext resolution. Real Node ESM and a browser-target VM smoke pass, including
  forbidden private imports and absence of Node globals. The combined browser smoke fixture is
  90,683 minified bytes, not the app's complete bundle. Seven packaging-tool regressions pass.
- All three opt-in flags pass the Next compile-only production build with Sentry upload plugins
  disabled. Existing Edge-runtime dependency, legacy Next configuration, Browserslist and font
  optimization warnings remain; compile mode does not run the full authenticated data/SSG workflow.
- The offline comparison runner's 24 compatibility assertions pass. It still reports the original
  196 recorded IV cases: 195 converge and one is correctly unavailable under the chosen model.
- Settled-state app repeat: **132 Jest suites / 2,127 tests pass**, plus full root
  `tsc --noEmit --incremental false` and the all-opt-in Next compilation described above.
- Settled-state `pnpm run ci` **exits 0**: formatting, lint, library/site typechecks, library build,
  public site build (1,168 routes / 9,586 export paths / 46 operations), **38 site tests**,
  **534 library test files / 11,262 tests**, coverage floors and all 25 API reports pass.
- Generated enforcement reports **2,447 enforced / 2,680 partial / 0 defective / 186 unmeasured**
  out of 5,313 candidates. These are honest whole-library evidence categories, not a claim of
  universal exhaustive validation. Both new operations are enforced; both numeric and ISO asOf
  alternatives of observedSkew are measured through real, fresh fixtures. The overlapping-union
  synthesis repair removes six stale residuals without adding an exception.
- Generated signature/naming/contract/enforcement/validation/reference/OpenAPI artifacts were
  refreshed. Naming walks 40,548 identities with zero unresolved. The new guide has one exact
  package-file allowance, not a broad Markdown inclusion. The complete umbrella measures 669,902
  bytes gzip under its deliberately updated 655 KiB budget; all 28 narrower budgets remain unchanged.
- `regen:check` itself requires a clean committed tree, so it is **not claimed** for these uncommitted
  changes. CI separately verifies generated inventories and enforcement reproducibility; all package
  freshness and API checks pass. Commit the reviewed change, then run the clean-tree regeneration
  gate before a push/release certification. Nothing in this record authorizes publication.

Reconciliation against the original proposal: A repairs and B/C/D implementation are complete.
The original browser measurements, permitted fresh vendor captures, production switch/removal of
legacy math, and registry/release approvals are deliberately not checked off as implementation
evidence. History-backed volatility additions still need defined histories; no new history-backed
rank/percentile feature or IV-solver replacement is claimed. Current OPC strike selection,
probability/score heuristics and its improved existing IV solver remain app-owned, as documented.

Repeatable benchmarks: `node scripts/totalfinance-dogfood/benchmark.mts` and the `--gex` variant; see
[runner documentation](../../../scripts/totalfinance-dogfood/README.md). Warm Node measurements, not
rendering/frame-time certification:

| Measured work                     |    Median |        p95 | Scope                                                 |
| --------------------------------- | --------: | ---------: | ----------------------------------------------------- |
| Prepared OPC 500-step curve       |  0.861 ms |   0.979 ms | Four synthetic option legs, strike injection included |
| Guarded dual-run OPC curve        |  1.248 ms |   1.364 ms | 50 samples; monetary/Greek/return/root gates match    |
| Prepared OPC 21 × 20 payoff table |  0.746 ms |   0.855 ms | 50 samples                                            |
| Observed skew                     |  5.048 ms |   7.786 ms | 4,000 synthetic quotes / 20 expiries, 20 samples      |
| Complete GEX shadow comparison    | 92.606 ms | 133.108 ms | One engine invocation, 20 samples                     |
| Complete GEX opt-in comparison    | 87.128 ms |  97.623 ms | One engine invocation, 20 samples                     |

Concurrent tests affect timings; an earlier quieter GEX sample measured about 71–79 ms. The actual
hook can calculate selected and all-expiry results separately, so the one-invocation benchmark is
not a whole-screen latency bound. The public batch path computes more than gamma alone and dual-run
mode intentionally pays for both engines. This is a reason to retain the browser/mobile rollout gate,
not evidence that WASM is necessary or that interactive performance is already acceptable.
