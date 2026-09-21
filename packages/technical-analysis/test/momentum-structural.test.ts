import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 160 }, (_, i) => 100 + Math.sin(i / 8) * 10 + i * 0.05);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.3,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 1000 + (i % 6) * 100,
}));

describe('TTM Squeeze', () => {
  it('emits a 0/1 squeeze flag and a finite momentum after warmup', () => {
    const r = ta.squeeze.explain(bars, {});
    for (let i = r.diagnostics.warmup; i < bars.length; i++) {
      expect([0, 1]).toContain(r.value[i]!.on);
      expect(Number.isFinite(r.value[i]!.momentum)).toBe(true);
    }
  });
  it('detects a squeeze: a low-volatility stretch turns the flag on', () => {
    // 40 quiet bars (tiny range) inside an otherwise normal series → BB collapses inside KC
    const quiet: BarInput[] = Array.from({ length: 60 }, (_, i) => ({
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100 + (i % 2 === 0 ? 0.01 : -0.01),
      volume: 100,
    }));
    const out = ta.squeeze(quiet, {});
    expect(out.slice(-1)[0]!.on).toBe(1);
  });
});

describe('SqueezePro', () => {
  it('nests compression levels: high ⊆ mid ⊆ low', () => {
    const quiet: BarInput[] = Array.from({ length: 60 }, () => ({
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100,
      volume: 100,
    }));
    for (const p of ta.squeezePro(quiet, {})) {
      if (!Number.isNaN(p.lowCompression)) {
        // tighter compression implies looser is also satisfied
        if (p.highCompression === 1) expect(p.normalCompression).toBe(1);
        if (p.normalCompression === 1) expect(p.lowCompression).toBe(1);
      }
    }
    const last = ta.squeezePro(quiet, {}).at(-1)!;
    expect(last.highCompression).toBe(1);
  });

  it('RV10 — a bad multiplier is reported as what it IS, not as a bad ordering', () => {
    /**
     * `requireOrderedMultipliers` ran before the per-value checks, so `NaN` reported
     * `input.out_of_range` with the message "must satisfy wide > normal > narrow" — because
     * `NaN > 1.5` is false. A type failure wearing a relation failure's clothes: the caller is told
     * to reorder three numbers when one of them is not a number. `Infinity` read correctly only by
     * luck, since `Infinity > 1.5` is true and it fell through to the finiteness check.
     *
     * Ordering is a relation between three already-valid numbers, so every value is validated first
     * and the relation is judged last. The final case proves the ordering check is still live.
     */
    const codeOf = (parameters: Record<string, number>): string => {
      try {
        ta.squeezePro(bars, parameters as never);
        return '(did not throw)';
      } catch (error) {
        return (error as { code?: string }).code ?? '(untyped)';
      }
    };
    for (const field of [
      'wideKeltnerChannelMultiplier',
      'normalKeltnerChannelMultiplier',
      'narrowKeltnerChannelMultiplier',
    ]) {
      expect(codeOf({ [field]: Number.NaN }), `${field}: NaN`).toBe('input.nan');
      expect(codeOf({ [field]: Number.POSITIVE_INFINITY }), `${field}: Infinity`).toBe(
        'input.not_finite',
      );
      expect(codeOf({ [field]: -1 }), `${field}: -1`).toBe('input.out_of_range');
    }
    // A genuine ordering violation — three valid numbers in the wrong relation — still reports as one.
    expect(codeOf({ wideKeltnerChannelMultiplier: 1, narrowKeltnerChannelMultiplier: 2 })).toBe(
      'input.out_of_range',
    );
    expect(
      codeOf({
        wideKeltnerChannelMultiplier: 3,
        normalKeltnerChannelMultiplier: 2,
        narrowKeltnerChannelMultiplier: 1,
      }),
    ).toBe('(did not throw)');
  });
});

describe('projection oscillator', () => {
  it('PO sits at the projected-band position; upper ≥ lower', () => {
    const r = ta.projectionOscillator.explain(bars, { period: 14 });
    const last = r.value.at(-1)!;
    expect(last.upper).toBeGreaterThanOrEqual(last.lower);
    expect(Number.isFinite(last.po)).toBe(true);
  });
});

describe('TD Sequential', () => {
  it('counts a buy setup to 9 on nine straight closes below close[4]', () => {
    // strictly falling closes → every bar closes below 4 bars ago → buy setup increments
    const falling: BarInput[] = Array.from({ length: 20 }, (_, i) => {
      const c = 100 - i;
      return { open: c, high: c + 0.5, low: c - 0.5, close: c };
    });
    const out = ta.tdSequential(falling, {});
    const last = out.at(-1)!;
    expect(last.direction).toBe(-1); // buy side (price weakness)
    expect(last.setup).toBe(9); // capped at 9
    // the reverse: rising closes → sell setup
    const rising: BarInput[] = Array.from({ length: 20 }, (_, i) => {
      const c = 100 + i;
      return { open: c, high: c + 0.5, low: c - 0.5, close: c };
    });
    expect(ta.tdSequential(rising, {}).at(-1)!.direction).toBe(1);
    // countdown advances on a sustained run
    expect(out.at(-1)!.countdown).toBeGreaterThan(0);
  });
});

describe('structural streaming parity & snapshots', () => {
  it('all four match their streams', () => {
    for (const name of ['squeeze', 'squeezePro', 'projectionOscillator', 'tdSequential'] as const) {
      const batch = ta[name].explain(bars, {});
      const stream = ta[name].stream({});
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
  it('snapshot round-trips squeeze and tdSequential', () => {
    for (const name of ['squeeze', 'tdSequential'] as const) {
      const ref = ta[name].stream({});
      const expected = bars.map((b) => ref.next(b));
      const part = ta[name].stream({});
      for (let i = 0; i < 80; i++) part.next(bars[i]!);
      const restored = ta[name].fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 80; i < bars.length; i++) {
        const got = restored.next(bars[i]!);
        if (expected[i] === null) expect(got, name).toBeNull();
        else expect(got, name).toEqual(expected[i]);
      }
    }
  });
});

describe('squeezePro — multiplier ordering is part of the contract', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({
    high: 100 + Math.sin(i / 3) * 2 + 1,
    low: 100 + Math.sin(i / 3) * 2 - 1,
    close: 100 + Math.sin(i / 3) * 2,
  }));

  /**
   * Positivity was checked and ordering was not, so `wide: 1, narrow: 2` was accepted — and computed
   * the LOOSEST compression level from the TIGHTEST channel. The canonical warmup table shipped
   * exactly that inversion, which is how a defaults table teaches a configuration the implementation
   * never intended.
   */
  it('rejects a reversed multiplier ladder', () => {
    expect(() =>
      ta.squeezePro(bars, {
        wideKeltnerChannelMultiplier: 1,
        normalKeltnerChannelMultiplier: 1.5,
        narrowKeltnerChannelMultiplier: 2,
      }),
    ).toThrow(/wideKeltnerChannelMultiplier > normalKeltnerChannelMultiplier/);
  });

  it('rejects equal multipliers, which collapse two levels into one', () => {
    expect(() =>
      ta.squeezePro(bars, {
        wideKeltnerChannelMultiplier: 1.5,
        normalKeltnerChannelMultiplier: 1.5,
        narrowKeltnerChannelMultiplier: 1,
      }),
    ).toThrow(/must satisfy/);
  });

  it('compression is MONOTONIC: a tighter level can never fire while a looser one does not', () => {
    // The relation the names promise. It holds only because the multipliers widen in order.
    const out = ta.squeezePro(bars, {});
    let checked = 0;
    for (const point of out) {
      if (point === null) continue;
      checked += 1;
      if (point.highCompression) expect(point.normalCompression).toBeTruthy();
      if (point.normalCompression) expect(point.lowCompression).toBeTruthy();
    }
    expect(checked).toBeGreaterThan(10);
  });
});
