import { InputError } from '@totalfinance/core';
import { FlowAnalysis, flow, type FlowClassificationSource } from '@totalfinance/structure';
import { describe, expect, it } from 'vitest';
import { driftPrint, recordedDriftTape } from './fixtures/option-flow-drift.js';

describe('flow classification authority and per-print lineage', () => {
  it('keeps legacy fallback as the default, and reports the supplied unknown it overrode', () => {
    const analysis = flow(recordedDriftTape());
    expect(analysis.assumptions.classificationSource).toBe('provided-or-quotes');
    expect(analysis.trades[4]).toMatchObject({
      side: 'buy',
      classificationProvenance: {
        policy: 'provided-or-quotes',
        source: 'quotes',
        providedSide: 'unknown',
        reason: 'quote-rule',
      },
    });
  });

  it.each(['provided-only', 'provided-first'] as const)(
    '%s preserves authoritative unknown without discarding quotes',
    (classificationSource) => {
      const analysis = flow(recordedDriftTape(), { classificationSource });
      expect(analysis.trades[4]).toMatchObject({
        side: 'unknown',
        trade: { bid: 1, ask: 2 },
        classificationProvenance: {
          policy: classificationSource,
          source: 'provided',
          providedSide: 'unknown',
          reason: 'provided',
        },
      });
    },
  );

  it.each([
    ['provided-or-quotes', 'buy', 'quotes', 'quote-rule'],
    ['provided-first', 'buy', 'quotes', 'quote-rule'],
    ['provided-only', 'unknown', 'unavailable', 'provided-missing'],
    ['quotes-only', 'buy', 'quotes', 'quote-rule'],
  ] as const)(
    '%s handles absent labels distinctly',
    (classificationSource, side, source, reason) => {
      const trade = driftPrint();
      delete trade.aggressorSide;
      expect(flow([trade], { classificationSource }).trades[0]).toMatchObject({
        side,
        classificationProvenance: { providedSide: null, source, reason },
      });
    },
  );

  it.each(['buy', 'sell'] as const)(
    'preserves supplied %s over contradictory quotes except in quotes-only',
    (side) => {
      const trade = driftPrint({ aggressorSide: side, price: side === 'buy' ? 1 : 2 });
      for (const classificationSource of [
        'provided-first',
        'provided-only',
        'provided-or-quotes',
      ] as const) {
        expect(flow([trade], { classificationSource }).trades[0]).toMatchObject({
          side,
          classificationProvenance: { source: 'provided', providedSide: side },
        });
      }
      expect(flow([trade], { classificationSource: 'quotes-only' }).trades[0]).toMatchObject({
        side: side === 'buy' ? 'sell' : 'buy',
        classificationProvenance: { source: 'quotes', providedSide: side },
      });
    },
  );

  it.each([
    [{ price: 1.5 }, 'quote-midpoint', 'quotes'],
    [{ bid: 2, ask: 2 }, 'quotes-locked-or-crossed', 'quotes'],
    [{ bid: 3, ask: 2 }, 'quotes-locked-or-crossed', 'quotes'],
  ] as const)('reports quote-rule unknown reasons %j', (overrides, reason, source) => {
    expect(
      flow([driftPrint(overrides)], { classificationSource: 'quotes-only' }).trades[0],
    ).toMatchObject({ side: 'unknown', classificationProvenance: { source, reason } });
  });

  it('reports missing quotes even when ignoring a supplied buy', () => {
    const trade = driftPrint();
    delete trade.bid;
    expect(flow([trade], { classificationSource: 'quotes-only' }).trades[0]).toMatchObject({
      side: 'unknown',
      classificationProvenance: {
        providedSide: 'buy',
        source: 'unavailable',
        reason: 'quotes-missing',
      },
    });
  });

  it.each([null, '', 'provider', 1, false])(
    'rejects invalid source policy %s on both public boundaries',
    (classificationSource) => {
      const options = { classificationSource: classificationSource as FlowClassificationSource };
      expect(() => flow([], options)).toThrow(InputError);
      expect(() => new FlowAnalysis([], options)).toThrow(InputError);
    },
  );

  it.each([null, 'BUY', '', 1, false])(
    'rejects invalid supplied classification %s even in quotes-only',
    (aggressorSide) => {
      const trade = driftPrint({ aggressorSide: aggressorSide as never });
      for (const classificationSource of ['provided-only', 'quotes-only'] as const) {
        expect(() => flow([trade], { classificationSource })).toThrow(InputError);
      }
    },
  );

  it('keeps lineage frozen and explanatory diagnostics honest', () => {
    const result = flow([driftPrint()], { classificationSource: 'provided-only' });
    expect(Object.isFrozen(result.trades[0]!.classificationProvenance)).toBe(true);
    expect(result.diagnostics.warnings[0]!.message).toContain('provided-only');
    expect(result.diagnostics.warnings[0]!.message).toContain('not independently verified');
  });
});
