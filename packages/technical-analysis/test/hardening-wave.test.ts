import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import * as ta from '@totalfinance/technical-analysis';
import type { BarInput } from '@totalfinance/technical-analysis';
import { SCHEMA_VERSION, snapshotOf } from '@totalfinance/technical-analysis/framework';
import {
  resolveIndicator,
  resolveIndicatorName,
  aliasesOf,
} from '@totalfinance/technical-analysis/aliases';
import { marketStructure, gapFill } from '@totalfinance/technical-analysis/price-action';

/**
 * Hardening wave — the reviewed, reproduced defects of this pass, each pinned by the property that
 * failed before the fix. Grouped by finding so a regression names the finding it re-opens.
 */

// ─────────────────────────────── shared fixtures ───────────────────────────────

/** Smooth, strictly positive, no flat windows and no zero crossings. */
const CLOSES = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.05);
const BARS: BarInput[] = CLOSES.map((c, i) => {
  const open = i === 0 ? c : CLOSES[i - 1]!;
  return {
    open,
    high: Math.max(open, c) + 0.8 + (i % 5) * 0.1,
    low: Math.min(open, c) - 0.8 - (i % 4) * 0.1,
    close: c,
    volume: 1000 + ((i * 37) % 500),
  };
});

/** The same series with bar `i` blanked out — one missing print in an otherwise clean feed. */
function seriesWithGapAt(i: number): number[] {
  const out = [...CLOSES];
  out[i] = NaN;
  return out;
}
function barsWithGapAt(i: number): BarInput[] {
  const out = BARS.map((b) => ({ ...b }));
  out[i] = { open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN };
  return out;
}

const isNan = (x: unknown): boolean => typeof x === 'number' && Number.isNaN(x);

// ══════════════════════════════════════════════════════════════════════════════
// [P2] interior-NaN latch: one NaN permanently poisoned every subtract-on-evict
// accumulator. The window must flow the NaN through and then RECOVER.
// ══════════════════════════════════════════════════════════════════════════════

interface NanCase {
  name: string;
  input: 'series' | 'bars';
  run: (input: readonly never[]) => readonly unknown[];
  /** Field to read from a record-valued indicator. */
  field?: string;
  /**
   * Bars of NaN a single bad sample produces, counted from the bad bar. `period` for a plain window;
   * `period + 1` when the indicator differences against the previous bar, since one bad print
   * corrupts two consecutive differences.
   */
  span: number;
  /**
   * `exact` — a pure window: once the sample leaves, the values ARE the clean series again (to float
   * noise; a subtract-on-evict sum is order-dependent, so the last ULPs can differ — measured
   * ~1e-13 absolute here).
   * `finite` — the indicator carries a recursion (KAMA/VIDYA/VFI's smoothing), which is HELD across
   * the gap instead of being fed a NaN; it recovers to finite values that legitimately differ from
   * the gap-free series because the filter saw fewer updates.
   */
  recovery: 'exact' | 'finite';
}

const PERIOD = 5;
const NAN_FAMILY: NanCase[] = [
  // ── series accumulators ──
  {
    name: 'sma',
    input: 'series',
    run: (s) => ta.sma(s as unknown as number[], { period: PERIOD }),
    span: PERIOD,
    recovery: 'exact',
  },
  {
    name: 'cmo',
    input: 'series',
    run: (s) => ta.cmo(s as unknown as number[], { period: PERIOD }),
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'dpo',
    input: 'series',
    run: (s) => ta.dpo(s as unknown as number[], { period: PERIOD }),
    span: PERIOD,
    recovery: 'exact',
  },
  {
    name: 'efficiencyRatio',
    input: 'series',
    run: (s) => ta.efficiencyRatio(s as unknown as number[], { period: PERIOD }),
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'psychologicalLine',
    input: 'series',
    run: (s) => ta.psychologicalLine(s as unknown as number[], { period: PERIOD }),
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'vidya',
    input: 'series',
    run: (s) => ta.vidya(s as unknown as number[], { period: PERIOD, cmoPeriod: PERIOD }),
    span: PERIOD + 1,
    recovery: 'finite',
  },
  {
    name: 'kama',
    input: 'series',
    run: (s) => ta.kama(s as unknown as number[], { period: PERIOD, fast: 2, slow: 30 }),
    span: PERIOD + 1,
    recovery: 'finite',
  },
  // ── bar accumulators ──
  {
    name: 'cci',
    input: 'bars',
    run: (b) => ta.cci(b as unknown as BarInput[], { period: PERIOD }),
    span: PERIOD,
    recovery: 'exact',
  },
  {
    name: 'chaikinMoneyFlow',
    input: 'bars',
    run: (b) => ta.chaikinMoneyFlow(b as unknown as BarInput[], { period: PERIOD }),
    span: PERIOD,
    recovery: 'exact',
  },
  {
    name: 'mfi',
    input: 'bars',
    run: (b) => ta.mfi(b as unknown as BarInput[], { period: PERIOD }),
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'vwma',
    input: 'bars',
    run: (b) => ta.vwma(b as unknown as BarInput[], { period: PERIOD }),
    span: PERIOD,
    recovery: 'exact',
  },
  {
    name: 'rollingVwap',
    input: 'bars',
    run: (b) => ta.rollingVwap(b as unknown as BarInput[], { period: PERIOD }),
    span: PERIOD,
    recovery: 'exact',
  },
  {
    name: 'vortex.viPlus',
    input: 'bars',
    run: (b) => ta.vortex(b as unknown as BarInput[], { period: PERIOD }),
    field: 'viPlus',
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'ultimateOscillator',
    input: 'bars',
    run: (b) => ta.ultimateOscillator(b as unknown as BarInput[], { short: 2, medium: 3, long: 5 }),
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'brar.ar',
    input: 'bars',
    run: (b) => ta.brar(b as unknown as BarInput[], { period: PERIOD }),
    field: 'popularityIndex',
    span: PERIOD + 1,
    recovery: 'exact',
  },
  {
    name: 'vfi',
    input: 'bars',
    run: (b) =>
      ta.vfi(b as unknown as BarInput[], {
        period: 8,
        smooth: 3,
        coefficient: 0.2,
        volumeCutoff: 2.5,
      }),
    span: 8,
    recovery: 'finite',
  },
];

/** Project an indicator's aligned output to a plain number series. */
const project = (out: readonly unknown[], field?: string): number[] =>
  out.map((v) =>
    field === undefined
      ? (v as number)
      : v == null
        ? NaN
        : ((v as Record<string, number>)[field] as number),
  );

describe('[P2] interior NaN flows through the window and then recovers', () => {
  const gapAt = 120; // well past every warmup, far from the end

  for (const c of NAN_FAMILY) {
    it(`${c.name}: NaN exactly on [${gapAt}, ${gapAt}+${c.span - 1}], never a permanent latch`, () => {
      const clean = project(
        c.run((c.input === 'series' ? CLOSES : BARS) as unknown as never[]),
        c.field,
      );
      const dirty = project(
        c.run(
          (c.input === 'series'
            ? seriesWithGapAt(gapAt)
            : barsWithGapAt(gapAt)) as unknown as never[],
        ),
        c.field,
      );
      expect(dirty).toHaveLength(clean.length);

      // The bad sample is inside the window for exactly `span` bars…
      for (let i = gapAt; i < gapAt + c.span; i++) {
        expect(isNan(dirty[i]), `${c.name}[${i}] should be NaN (inside the gap window)`).toBe(true);
      }
      // …and the very next bar is a real number again — the latch this test exists for.
      const after = gapAt + c.span;
      expect(
        Number.isFinite(dirty[after]),
        `${c.name}[${after}] must recover to a finite value (got ${String(dirty[after])})`,
      ).toBe(true);
      // Nothing later may be NaN either: a latch shows up as an all-NaN tail.
      for (let i = after; i < clean.length; i++) {
        expect(Number.isFinite(dirty[i]), `${c.name}[${i}] latched to NaN`).toBe(true);
      }

      // Nothing BEFORE the gap can move: those bars never saw the bad sample. Bit-identical.
      for (let i = 0; i < gapAt; i++) {
        expect(Object.is(dirty[i], clean[i]), `${c.name}[${i}] changed before the gap`).toBe(true);
      }
      if (c.recovery === 'exact') {
        // After the window clears, the values are the clean ones again — to float noise, not to the
        // bit. A subtract-on-evict sum is order-dependent (float addition is not associative), and
        // the gapped run adds/subtracts one term fewer, so the last ULPs of the accumulator differ.
        // Measured worst case on this fixture: ~1e-13 absolute. A real regression (a latch, a wrong
        // window) is NaN or percent-level, orders of magnitude outside this.
        for (let i = after; i < clean.length; i++) {
          const tolerance = Math.max(1e-9, 1e-9 * Math.abs(clean[i]!));
          expect(
            Math.abs(dirty[i]! - clean[i]!),
            `${c.name}[${i}] differs after recovery: ${String(dirty[i])} vs ${String(clean[i])}`,
          ).toBeLessThanOrEqual(tolerance);
        }
      }
      // `finite` indicators carry a recursion that is HELD across the gap, so their tail legitimately
      // differs from the gap-free series; the assertions above already pin that it stays finite.
    });
  }

  it('batch ≡ stream on a series with an interior NaN (parity survives the gate)', () => {
    for (const c of NAN_FAMILY) {
      const input = (c.input === 'series' ? seriesWithGapAt(gapAt) : barsWithGapAt(gapAt)) as
        | number[]
        | BarInput[];
      const batch = project(c.run(input as unknown as never[]), c.field);
      // Re-drive the same computation one bar at a time through the streaming facade.
      const streamOut: number[] = [];
      const stream = STREAMS[c.name]!();
      for (const x of input as readonly unknown[]) {
        const r = stream.next(x as never) as number | Record<string, number> | null;
        streamOut.push(
          r === null
            ? NaN
            : c.field === undefined
              ? (r as number)
              : (r as Record<string, number>)[c.field]!,
        );
      }
      for (let i = 0; i < batch.length; i++) {
        expect(Object.is(streamOut[i], batch[i]), `${c.name}[${i}] batch ≠ stream`).toBe(true);
      }
    }
  });
});

/** Stream factories matching `NAN_FAMILY` (batch is derived from these by construction). */
const STREAMS: Record<string, () => { next: (x: never) => unknown }> = {
  sma: () => ta.sma.stream({ period: PERIOD }),
  cmo: () => ta.cmo.stream({ period: PERIOD }),
  dpo: () => ta.dpo.stream({ period: PERIOD }),
  efficiencyRatio: () => ta.efficiencyRatio.stream({ period: PERIOD }),
  psychologicalLine: () => ta.psychologicalLine.stream({ period: PERIOD }),
  vidya: () => ta.vidya.stream({ period: PERIOD, cmoPeriod: PERIOD }),
  kama: () => ta.kama.stream({ period: PERIOD, fast: 2, slow: 30 }),
  cci: () => ta.cci.stream({ period: PERIOD }),
  chaikinMoneyFlow: () => ta.chaikinMoneyFlow.stream({ period: PERIOD }),
  mfi: () => ta.mfi.stream({ period: PERIOD }),
  vwma: () => ta.vwma.stream({ period: PERIOD }),
  rollingVwap: () => ta.rollingVwap.stream({ period: PERIOD }),
  'vortex.viPlus': () => ta.vortex.stream({ period: PERIOD }),
  ultimateOscillator: () => ta.ultimateOscillator.stream({ short: 2, medium: 3, long: 5 }),
  'brar.ar': () => ta.brar.stream({ period: PERIOD }),
  vfi: () => ta.vfi.stream({ period: 8, smooth: 3, coefficient: 0.2, volumeCutoff: 2.5 }),
};

describe('[P2] interior NaN never pulls the warmup boundary EARLIER', () => {
  it('a gap inside the warmup region cannot make the gap itself the "first value"', () => {
    // The gate emits NaN only once the window is full — i.e. at or after the bar the indicator could
    // legitimately first emit — so a gap can delay the first value but never manufacture one.
    for (const c of NAN_FAMILY) {
      const cleanInput = (c.input === 'series' ? CLOSES : BARS) as number[] | BarInput[];
      const gapInput = (c.input === 'series' ? seriesWithGapAt(2) : barsWithGapAt(2)) as
        | number[]
        | BarInput[];
      const indicator = EXPLAINERS[c.name]!;
      expect(
        indicator(gapInput as never),
        `${c.name}: a warmup-region gap moved the first value earlier`,
      ).toBeGreaterThanOrEqual(indicator(cleanInput as never));
    }
  });

  it('a pure window keeps the exact same warmup (sma), a held recursion may need longer (vfi)', () => {
    expect(ta.sma.explain(seriesWithGapAt(2), { period: PERIOD }).diagnostics.warmup).toBe(
      ta.sma.explain(CLOSES, { period: PERIOD }).diagnostics.warmup,
    );
    // VFI holds its state while the bad VOLUME is inside the 8-bar volume window, so its first value
    // is genuinely later — the average it needs does not exist until the bad sample leaves.
    expect(
      ta.vfi.explain(barsWithGapAt(2), { period: 8, smooth: 3 }).diagnostics.warmup,
    ).toBeGreaterThan(ta.vfi.explain(BARS, { period: 8, smooth: 3 }).diagnostics.warmup);
  });
});

/** `explain(...).diagnostics.warmup` per `NAN_FAMILY` entry. */
const EXPLAINERS: Record<string, (input: never) => number> = {
  sma: (i) => ta.sma.explain(i, { period: PERIOD }).diagnostics.warmup,
  cmo: (i) => ta.cmo.explain(i, { period: PERIOD }).diagnostics.warmup,
  dpo: (i) => ta.dpo.explain(i, { period: PERIOD }).diagnostics.warmup,
  efficiencyRatio: (i) => ta.efficiencyRatio.explain(i, { period: PERIOD }).diagnostics.warmup,
  psychologicalLine: (i) => ta.psychologicalLine.explain(i, { period: PERIOD }).diagnostics.warmup,
  vidya: (i) => ta.vidya.explain(i, { period: PERIOD, cmoPeriod: PERIOD }).diagnostics.warmup,
  kama: (i) => ta.kama.explain(i, { period: PERIOD, fast: 2, slow: 30 }).diagnostics.warmup,
  cci: (i) => ta.cci.explain(i, { period: PERIOD }).diagnostics.warmup,
  chaikinMoneyFlow: (i) => ta.chaikinMoneyFlow.explain(i, { period: PERIOD }).diagnostics.warmup,
  mfi: (i) => ta.mfi.explain(i, { period: PERIOD }).diagnostics.warmup,
  vwma: (i) => ta.vwma.explain(i, { period: PERIOD }).diagnostics.warmup,
  rollingVwap: (i) => ta.rollingVwap.explain(i, { period: PERIOD }).diagnostics.warmup,
  'vortex.viPlus': (i) => ta.vortex.explain(i, { period: PERIOD }).diagnostics.warmup,
  ultimateOscillator: (i) =>
    ta.ultimateOscillator.explain(i, { short: 2, medium: 3, long: 5 }).diagnostics.warmup,
  'brar.ar': (i) => ta.brar.explain(i, { period: PERIOD }).diagnostics.warmup,
  vfi: (i) =>
    ta.vfi.explain(i, { period: 8, smooth: 3, coefficient: 0.2, volumeCutoff: 2.5 }).diagnostics
      .warmup,
};

// ══════════════════════════════════════════════════════════════════════════════
// [P1] ichimoku: the history buffer was capped at spanB, so conversion/base
// larger than spanB sliced from a NEGATIVE index — the last few bars, silently.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P1] ichimoku computes each line over ITS OWN lookback', () => {
  // A clean 80-bar ramp: high = low = close = 100 + i, so every midpoint is exact hand math.
  const ramp: BarInput[] = Array.from({ length: 80 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
  }));
  const last = <T>(xs: readonly T[]): T => xs[xs.length - 1]!;

  it('conversion (60) > spanB (52): tenkan spans 60 bars, not the 8 the old cap left', () => {
    const r = last(ta.ichimoku(ramp, { conversion: 60, base: 26, spanB: 52 }));
    // last bar is index 79 (=179); the 60-bar window is bars 20..79 → (120 + 179) / 2 = 149.5.
    expect(r.tenkan).toBeCloseTo(149.5, 12);
    // The pre-fix value was the midpoint of the last 8 bars, (172 + 179) / 2 = 175.5.
    expect(r.tenkan).not.toBeCloseTo(175.5, 6);
    // base 26 → bars 54..79 → (154 + 179) / 2 = 166.5; spanB 52 → bars 28..79 → (128 + 179)/2.
    expect(r.kijun).toBeCloseTo(166.5, 12);
    expect(r.senkouB).toBeCloseTo(153.5, 12);
    expect(r.senkouA).toBeCloseTo((149.5 + 166.5) / 2, 12);
  });

  it('base (60) > spanB (52): kijun spans 60 bars', () => {
    const r = last(ta.ichimoku(ramp, { conversion: 9, base: 60, spanB: 52 }));
    expect(r.kijun).toBeCloseTo(149.5, 12);
    expect(r.tenkan).toBeCloseTo(175, 12); // 9-bar window: bars 71..79 → (171 + 179) / 2
    expect(r.senkouB).toBeCloseTo(153.5, 12);
  });

  it('warmup is the LONGEST lookback (a line cannot exist before its own window)', () => {
    const wide = ta.ichimoku.explain(ramp, { conversion: 60, base: 26, spanB: 52 });
    expect(wide.diagnostics.warmup).toBe(59);
    expect(wide.value[58]!.tenkan).toBeNaN();
    // The defaults are unchanged: spanB is the longest, so warmup stays at 51.
    expect(ta.ichimoku.explain(ramp, {}).diagnostics.warmup).toBe(51);
  });

  it('the defaults are untouched (the certified pandas-ta lines still hold)', () => {
    const r = last(ta.ichimoku(ramp, { conversion: 9, base: 26, spanB: 52 }));
    expect(r.tenkan).toBeCloseTo(175, 12);
    expect(r.kijun).toBeCloseTo(166.5, 12);
    expect(r.senkouB).toBeCloseTo(153.5, 12);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P2] toJSON() handed out LIVE internal references: a captured snapshot mutated
// as the stream advanced.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P2] a captured snapshot is frozen (no live internal references)', () => {
  const SNAPSHOT_STREAMS: Record<
    string,
    () => { next: (b: BarInput) => unknown; toJSON: () => unknown }
  > = {
    fairValueGaps: () => ta.fairValueGaps.stream({}),
    orderBlocks: () => ta.orderBlocks.stream({ lookback: 5 }),
    liquiditySweeps: () => ta.liquiditySweeps.stream({ lookback: 5 }),
    smcSweep: () => ta.smcSweep.stream({ period: 5 }),
    swingTrailingStop: () => ta.swingTrailingStop.stream({ strength: 2 }),
    atrTrailingStop: () => ta.atrTrailingStop.stream({ period: 5, multiplier: 3 }),
    equalHighs: () => ta.equalHighs.stream({ strength: 2 }),
    equalLows: () => ta.equalLows.stream({ strength: 2 }),
  };

  for (const [name, make] of Object.entries(SNAPSHOT_STREAMS)) {
    it(`${name}: capturing then advancing leaves the capture unchanged`, () => {
      const stream = make();
      for (const b of BARS.slice(0, 40)) stream.next(b);
      const captured = stream.toJSON();
      // `structuredClone`, not a JSON round-trip: JSON turns the NaN sentinels in a zone point into
      // null, which would make this compare unequal for reasons that have nothing to do with aliasing.
      const frozen = structuredClone(captured) as unknown;
      for (const b of BARS.slice(40, 60)) stream.next(b);
      expect(captured, `${name} snapshot mutated when the stream advanced`).toEqual(frozen);
    });
  }

  it('restore parity: a stream restored from a captured snapshot continues identically', () => {
    const cases: Record<string, { make: () => ReturnType<typeof ta.fairValueGaps.stream> }> = {};
    void cases;
    const table: [
      string,
      () => { next: (b: BarInput) => unknown; toJSON: () => unknown },
      (s: unknown) => { next: (b: BarInput) => unknown },
    ][] = [
      [
        'fairValueGaps',
        () => ta.fairValueGaps.stream({}),
        (s) => ta.fairValueGaps.fromJSON(s as never),
      ],
      [
        'orderBlocks',
        () => ta.orderBlocks.stream({ lookback: 5 }),
        (s) => ta.orderBlocks.fromJSON(s as never),
      ],
      [
        'liquiditySweeps',
        () => ta.liquiditySweeps.stream({ lookback: 5 }),
        (s) => ta.liquiditySweeps.fromJSON(s as never),
      ],
      [
        'smcSweep',
        () => ta.smcSweep.stream({ period: 5 }),
        (s) => ta.smcSweep.fromJSON(s as never),
      ],
      [
        'swingTrailingStop',
        () => ta.swingTrailingStop.stream({ strength: 2 }),
        (s) => ta.swingTrailingStop.fromJSON(s as never),
      ],
      [
        'atrTrailingStop',
        () => ta.atrTrailingStop.stream({ period: 5, multiplier: 3 }),
        (s) => ta.atrTrailingStop.fromJSON(s as never),
      ],
      [
        'equalHighs',
        () => ta.equalHighs.stream({ strength: 2 }),
        (s) => ta.equalHighs.fromJSON(s as never),
      ],
      [
        'equalLows',
        () => ta.equalLows.stream({ strength: 2 }),
        (s) => ta.equalLows.fromJSON(s as never),
      ],
    ];
    for (const [name, make, restore] of table) {
      const reference = make();
      const partial = make();
      for (const b of BARS.slice(0, 40)) {
        reference.next(b);
        partial.next(b);
      }
      // Capture, then keep driving the ORIGINAL — a live reference here would corrupt the capture
      // before it is ever restored (the review's repro).
      const captured = JSON.parse(JSON.stringify(partial.toJSON())) as unknown;
      for (const b of BARS.slice(40, 50)) partial.next(b);
      const restored = restore(captured);
      for (const b of BARS.slice(40, 60)) {
        expect(restored.next(b), `${name} restored stream diverged`).toEqual(reference.next(b));
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P2] dpo: period ≤ 2 indexed before the start of the buffer → all-NaN forever.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P2] dpo is well defined for small periods', () => {
  // 6-bar ramp, hand-computed. TotalFinance's DPO is Pring's causal form:
  //   dpo[t] = close[t − shift] − SMA(close, period)[t],  shift = ⌊period/2⌋ + 1
  const ramp = [1, 2, 3, 4, 5, 6];

  it('period 1: shift 1, SMA₁ = close[t] → dpo[t] = close[t−1] − close[t] = −1', () => {
    const out = ta.dpo(ramp, { period: 1 });
    expect(out[0]).toBeNaN(); // needs shift + 1 = 2 bars
    expect(out.slice(1)).toEqual([-1, -1, -1, -1, -1]);
  });

  it('period 2: shift 2 → dpo[t] = close[t−2] − (close[t−1] + close[t]) / 2 = −1.5', () => {
    const out = ta.dpo(ramp, { period: 2 });
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN(); // needs shift + 1 = 3 bars
    expect(out[2]).toBeCloseTo(1 - 2.5, 12);
    expect(out.slice(2)).toEqual([-1.5, -1.5, -1.5, -1.5]);
  });

  it('period 3: shift 2, window 3 → dpo[t] = close[t−2] − (sum of last 3)/3 = −2', () => {
    const out = ta.dpo(ramp, { period: 3 });
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(1 - 2, 12);
    expect(out.slice(2)).toEqual([-1, -1, -1, -1]);
  });

  it('period ≥ 3 keeps the certified warmup and values (nothing shifted)', () => {
    const out = ta.dpo.explain(CLOSES, { period: 20 });
    expect(out.diagnostics.warmup).toBe(19);
    const shift = Math.floor(20 / 2) + 1;
    for (let i = 19; i < CLOSES.length; i++) {
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += CLOSES[j]!;
      expect(out.value[i]!).toBeCloseTo(CLOSES[i - shift]! - sum / 20, 9);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P2] TRIX fabricated a 0 one bar before TA-Lib's first output, and returned 0
// (not NaN) for a zero previous EMA.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P2] trix warmup and zero-base convention', () => {
  for (const period of [3, 5, 9]) {
    it(`period ${period}: first value at TA-Lib's lookback 3·(p−1)+1 = ${3 * (period - 1) + 1}`, () => {
      const r = ta.trix.explain(CLOSES, { period });
      expect(r.diagnostics.warmup).toBe(3 * (period - 1) + 1);
      // The bar before it is warmup, not a fabricated "0% change".
      expect(r.value[3 * (period - 1)]).toBeNaN();
      expect(Number.isFinite(r.value[3 * (period - 1) + 1]!)).toBe(true);
    });
  }

  it('a zero triple-EMA base yields NaN, exactly like roc (never a silent 0)', () => {
    // An all-zero series drives the triple EMA to exactly 0, so the rate of change is undefined.
    const zeros = Array.from({ length: 30 }, () => 0);
    const r = ta.trix.explain(zeros, { period: 3 });
    // It EMITS (warmup at TA-Lib's lookback) — and what it emits is NaN, not a 0% change. Before the
    // fix this branch returned `null` forever, so the indicator silently never produced a value.
    expect(r.diagnostics.warmup).toBe(3 * (3 - 1) + 1);
    expect(r.value.slice(r.diagnostics.warmup).every((v) => Number.isNaN(v))).toBe(true);
    // roc answers the same way for a zero base — the two must not disagree.
    expect(
      ta
        .roc([0, 0, 0, 0], { period: 1 })
        .slice(1)
        .every((v) => Number.isNaN(v)),
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P3] flat-window convention: stochastic said 100, stochRSI said 0.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P3] a flat window resolves to 0 across the stochastic family', () => {
  const flatBars: BarInput[] = Array.from({ length: 40 }, () => ({
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 10,
  }));

  it('stochastic %K/%D are 0 when highest === lowest (TA-Lib STOCH/STOCHF, pandas-ta stoch)', () => {
    // Reference behavior, measured: TA-Lib 0.6.x `STOCHF(flat, flat, flat, 14, 3, 0)` → k = d = 0.0;
    // pandas-ta 0.4.x `stoch(flat, flat, flat, k=14, d=3, smooth_k=1)` → 0.0. (RSI's flat case is
    // deliberately different — 100 — because there the RS → ∞ limit is one-sided; see
    // docs/compatibility/talib-differences.md.)
    const out = ta.stochastic(flatBars, { kPeriod: 14, dPeriod: 3 });
    const lastPoint = out[out.length - 1]!;
    expect(lastPoint.k).toBe(0);
    expect(lastPoint.d).toBe(0);
  });

  it('stochRsi keeps the same convention on a flat RSI window (pandas-ta stochrsi → 0)', () => {
    const flatCloses = Array.from({ length: 80 }, () => 100);
    const out = ta.stochRsi(flatCloses, { rsiPeriod: 14, stochPeriod: 14, kPeriod: 3, dPeriod: 3 });
    const lastPoint = out[out.length - 1]!;
    expect(lastPoint.k).toBe(0);
    expect(lastPoint.d).toBe(0);
  });

  it('rsi keeps its documented 100 on the same flat series (the conventions are not merged)', () => {
    const flatCloses = Array.from({ length: 40 }, () => 100);
    expect(ta.rsi(flatCloses, { period: 14 }).at(-1)).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P3] supertrend seeded the first bars at the upper band → always direction −1.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P3] supertrend seeds long, like pandas-ta', () => {
  it('the first emitted bar is direction +1 with the line below price', () => {
    // pandas-ta initializes `dir_ = [1] * m` and fills the LONG band on the first valid bar.
    const out = ta.supertrend.explain(BARS, { period: 7, multiplier: 3 });
    const first = out.value[out.diagnostics.warmup]!;
    expect(first.direction).toBe(1);
    expect(first.supertrend).toBeLessThan(BARS[out.diagnostics.warmup]!.close);
  });

  it('the seed does not survive the first genuine flip (both seeds agree afterwards)', () => {
    const out = ta.supertrend(BARS, { period: 7, multiplier: 3 });
    const directions = new Set(
      out.filter((p) => !Number.isNaN(p.direction)).map((p) => p.direction),
    );
    expect(directions.has(1)).toBe(true);
    expect(directions.has(-1)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P3] volumeProfile split a bar's volume EQUALLY across the buckets it touched,
// while the docstring promised overlap weighting.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P3] volumeProfile allocates by overlap, not by bucket count', () => {
  it('a bar covering 5 of one bucket and 1 of the next splits 5:1 (hand-computed)', () => {
    // Global range [0, 10] with 2 bins → width 5: bucket0 = [0, 5), bucket1 = [5, 10].
    const bars: BarInput[] = [
      { open: 5, high: 10, low: 0, close: 5, volume: 100 }, // 5 + 5 → 50 / 50
      { open: 3, high: 6, low: 0, close: 3, volume: 60 }, //  5 + 1 → 50 / 10 (was 30 / 30)
      { open: 5, high: 5, low: 5, close: 5, volume: 10 }, //  zero range → all to bucket1
    ];
    const vp = ta.volumeProfile(bars, { bins: 2 });
    expect(vp.bins).toHaveLength(2);
    expect(vp.bins[0]!.volume).toBeCloseTo(100, 9); // 50 + 50
    expect(vp.bins[1]!.volume).toBeCloseTo(70, 9); //  50 + 10 + 10
    // Volume is conserved exactly — the allocation only moves it between buckets.
    expect(vp.totalVolume).toBeCloseTo(170, 9);
    expect(vp.poc).toBeCloseTo(2.5, 9); // bucket0 midpoint now wins
  });

  it('every bar’s volume is fully allocated on a realistic series', () => {
    const vp = ta.volumeProfile(BARS, { bins: 24 });
    const traded = BARS.reduce((s, b) => s + (b.volume ?? 0), 0);
    expect(vp.totalVolume).toBeCloseTo(traded, 6);
    expect(vp.bins.reduce((s, b) => s + b.volume, 0)).toBeCloseTo(traded, 6);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P3] gapFill started its fill scan at the gap bar itself.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P3] a gap is filled by a LATER bar, never by itself', () => {
  it('a gap-up bar whose own low tags the prior close is not filled by that bar', () => {
    const bars: BarInput[] = [
      { open: 9.5, high: 10, low: 9, close: 10 },
      // Opens at 11 (above the prior high) but trades back down to 9.8 ≤ prior close 10 on the
      // SAME bar. That is the gap bar, not a fill of it.
      { open: 11, high: 11.5, low: 9.8, close: 11 },
      { open: 11, high: 11.2, low: 10.5, close: 11 }, // still above 10 — no fill
    ];
    const out = gapFill(bars).events;
    expect(out).toHaveLength(1);
    expect(out[0]!.index).toBe(1);
    expect(out[0]!.filled).toBe(false);
    expect(out[0]!.fillIndex).toBe(-1);
  });

  it('the next bar trading back through the prior close still fills it', () => {
    const bars: BarInput[] = [
      { open: 9.5, high: 10, low: 9, close: 10 },
      { open: 11, high: 11.5, low: 9.8, close: 11 },
      { open: 11, high: 11.2, low: 9.5, close: 9.9 }, // reaches back to 10
    ];
    const out = gapFill(bars).events;
    expect(out[0]!.filled).toBe(true);
    expect(out[0]!.fillIndex).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [P3] marketStructure force-labeled the first swing of each kind 'LH'/'HL'.
// ══════════════════════════════════════════════════════════════════════════════

describe('[P3] the first swing of each kind has no label', () => {
  it('a clean uptrend labels the first high/low null and the rest HH/HL', () => {
    // Zig-zag with a rising bias: every later swing is higher than the last.
    const bars: BarInput[] = Array.from({ length: 24 }, (_, i) => {
      const base = 100 + i * 0.5 + (i % 4 === 2 ? 2 : i % 4 === 0 ? -2 : 0);
      return { open: base, high: base + 0.3, low: base - 0.3, close: base };
    });
    const ms = marketStructure(bars, { strength: 1 });
    const highs = ms.swings.filter((s) => s.kind === 'high');
    const lows = ms.swings.filter((s) => s.kind === 'low');
    expect(highs.length).toBeGreaterThan(1);
    expect(lows.length).toBeGreaterThan(1);
    expect(highs[0]!.label).toBeNull();
    expect(lows[0]!.label).toBeNull();
    // Only the FIRST of each kind is null; every later swing is labeled.
    for (const s of [...highs.slice(1), ...lows.slice(1)]) expect(s.label).not.toBeNull();
    expect(highs.slice(1).every((s) => s.label === 'HH')).toBe(true);
    expect(lows.slice(1).every((s) => s.label === 'HL')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [review-1] rename artifacts.
// ══════════════════════════════════════════════════════════════════════════════

describe('[review-1] McGinley Dynamic is named after McGinley', () => {
  it("resolveIndicatorName('McGinley Dynamic') → mcginley (case-insensitively)", () => {
    expect(resolveIndicatorName('McGinley Dynamic')).toBe('mcginley');
    expect(resolveIndicatorName('mcginley dynamic')).toBe('mcginley');
    expect(resolveIndicator('McGinley Dynamic')?.name).toBe('mcginley');
    expect(aliasesOf('mcginley')?.tradingview).toBe('McGinley Dynamic');
  });

  it('the fictional "MonteCarloGinley" name resolves to nothing', () => {
    expect(resolveIndicatorName('MonteCarloGinley Dynamic')).toBeUndefined();
    expect(resolveIndicatorName('MonteCarloGinley')).toBeUndefined();
    expect(resolveIndicator('MonteCarloGinleyStream')).toBeUndefined();
  });
});

describe('[review-1] pandas-ta alias spellings are the names pandas-ta actually exposes', () => {
  it('zScore maps to pandas-ta `zscore` and resolves case-insensitively', () => {
    expect(aliasesOf('zScore')?.pandas).toBe('zscore');
    expect(resolveIndicatorName('zscore')).toBe('zScore');
    expect(resolveIndicatorName('ZSCORE')).toBe('zScore');
  });

  it('standardError claims no pandas-ta name (pandas-ta has none) but still resolves', () => {
    expect(aliasesOf('standardError')?.pandas).toBeUndefined();
    expect(resolveIndicatorName('standarderror')).toBe('standardError');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// [review-1] snapshotOf(kind, state) accepted a stream as its `kind`.
// ══════════════════════════════════════════════════════════════════════════════

describe('[review-1] snapshotOf validates its kind', () => {
  it('passing a stream teaches stream.toJSON() instead of building a broken envelope', () => {
    const stream = ta.sma.stream({ period: 3 });
    expect(() => snapshotOf(stream as unknown as string, {})).toThrowError(InputError);
    try {
      snapshotOf(stream as unknown as string, {});
      expect.unreachable('snapshotOf accepted a stream as its kind');
    } catch (e) {
      expect((e as InputError).code).toBe('input.wrong_type');
      expect((e as Error).message).toMatch(/stream\.toJSON\(\)/);
    }
  });

  it('rejects a missing or empty kind', () => {
    expect(() => snapshotOf(undefined as unknown as string, {})).toThrowError(InputError);
    expect(() => snapshotOf('', {})).toThrowError(InputError);
  });

  it('still stamps a valid envelope for a real kind', () => {
    // The version comes from the constant, not a literal: 3B.1 bumped it to 3 (non-finite state is
    // encoded), and a hard-coded 2 here would have to be chased on every future bump.
    expect(snapshotOf('sma', { period: 3 })).toEqual({
      kind: 'sma',
      schemaVersion: SCHEMA_VERSION,
      state: { period: 3 },
    });
  });
});

describe('the feature pipeline and signal DSL speak the same grammar as the indicators', () => {
  // The package throws a teaching error on `rsi(series, 14)` because a bare number cannot say
  // whether it is a period, a multiplier or a lookback. Its own DSL took exactly that shape until
  // 3B.1b — and disagreed with itself, since macd/bbands/rollingVolatility already took objects.
  const bars: BarInput[] = Array.from({ length: 40 }, (_, i) => ({
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1_000,
  }));

  it('every convenience method takes its indicator’s parameter object', () => {
    const cols = ta
      .features(bars)
      .sma('close', { period: 5 }, { as: 'fast' })
      .ema('close', { period: 5 }, { as: 'expo' })
      .wma('close', { period: 5 }, { as: 'weighted' })
      .rsi('close', { period: 14 }, { as: 'momentum' })
      .atr({ period: 14 }, { as: 'range' })
      .toColumns();
    for (const alias of ['fast', 'expo', 'weighted', 'momentum', 'range'])
      expect(cols[alias], alias).toHaveLength(bars.length);
  });

  it('the column values equal calling the indicator directly with the same object', () => {
    const closes = bars.map((b) => b.close);
    const viaPipeline = ta.features(bars).sma('close', { period: 5 }, { as: 'x' }).toColumns()['x'];
    expect(viaPipeline).toEqual(ta.sma(closes, { period: 5 }));
  });

  it('a positional period is a compile error and does not quietly work at runtime', () => {
    // The type is the real guard; this pins the RUNTIME behaviour so a future loosening of the
    // signature cannot silently resurrect `sma('close', 20)` as a working call.
    expect(() =>
      (ta.features(bars) as unknown as { sma: (f: string, p: number) => unknown }).sma('close', 20),
    ).toThrow();
  });

  it('the signal DSL mirrors the pipeline, and use() takes an alias object', () => {
    const signals = ta
      .signal(bars)
      .sma('close', { period: 3 }, { as: 'fast' })
      .sma('close', { period: 8 }, { as: 'slow' })
      .use('close', ta.rsi, { period: 14 }, { as: 'rsi14' })
      .when(ta.gt('fast', 'slow'))
      .emit('long')
      .signals();
    expect(signals).toHaveLength(bars.length);
    expect(signals.some((s) => s === 'long')).toBe(true);
  });
});
