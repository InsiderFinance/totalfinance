/**
 * Internal (not an entrypoint): the build state behind every `YieldCurve` this package constructs,
 * keyed to the curve object, and the way back — the exact restore the artifact layer needs
 * (Stage 4.5 Decision 2). Lives outside `curves.ts` on purpose: `./curves` is a public entrypoint
 * mapped straight onto that module, so anything it exports is API; the state is not.
 *
 * `curves.ts` records each built curve here and registers its builder at load; `curve-data.ts`
 * reads the state to store a curve and rebuilds through the registered builder to restore one.
 */

import type { CurveExtrapolation, CurveInterpolation, YieldCurve } from './curves.js';
import type { FixedIncomeDayCount } from './conventions.js';

/** The canonical state a yield curve is built from: continuous zeros at pillar times. */
export interface YieldCurveState {
  referenceDate: string;
  dayCount: FixedIncomeDayCount;
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
  ts: number[];
  zeros: number[]; // continuous zeros aligned to ts
  /**
   * Original input pillar dates aligned to `ts`, present when the curve was built from dated
   * points. Pillars keep these EXACT strings: reconstructing a date from a year fraction drifts
   * by days under non-365 day counts (`ACT/360`, `30/360`), so key-rate-duration reports would
   * label pillars with dates the caller never supplied. Absent (e.g. `curves.flat`) ⇒ the date is
   * reconstructed under the curve's actual day count.
   */
  dates?: ReadonlyArray<string | undefined>;
  /**
   * Whether a pillar AT the reference date (t = 0) carries a zero the caller actually quoted.
   *
   * `fromZeroRates` is given one; `fromDiscountFactors` (and therefore every bootstrap) is not —
   * its origin pillar is the `DF = 1` anchor, and `−ln(1)/0` is indeterminate, so it stores 0 as a
   * placeholder. The two cases produce IDENTICAL discount functions but must answer
   * `zeroRate(referenceDate)` differently: echo the datum when there is one, take the first
   * segment's t→0⁺ limit when there is not.
   */
  originZeroKnown?: boolean;
}

const CURVE_STATES = new WeakMap<YieldCurve, YieldCurveState>();
let builder: ((state: YieldCurveState) => YieldCurve) | undefined;

/** Called by the curve builder for every curve it returns. */
export function recordCurveState(curve: YieldCurve, state: YieldCurveState): void {
  CURVE_STATES.set(curve, state);
}

/** Called once by `curves.ts` at load, so the restore can rebuild without a module cycle. */
export function registerCurveBuilder(build: (state: YieldCurveState) => YieldCurve): void {
  builder = build;
}

/** The state a curve was built from, when this package built it. */
export function yieldCurveStateOf(curve: YieldCurve): Readonly<YieldCurveState> | undefined {
  return CURVE_STATES.get(curve);
}

/** Rebuild a curve from stored state — the exact inverse of {@link yieldCurveStateOf}. */
export function buildYieldCurveFromState(state: YieldCurveState): YieldCurve {
  if (builder === undefined) {
    // Unreachable through any public entrypoint (every importer of the artifact layer loads
    // `curves.ts` first); kept as a plain error so a broken build graph fails loudly, not silently.
    throw new Error(
      'curve-state: the curve builder is not registered — `curves.ts` was not loaded.',
    );
  }
  return builder({ ...state, ts: state.ts.slice(), zeros: state.zeros.slice() });
}
