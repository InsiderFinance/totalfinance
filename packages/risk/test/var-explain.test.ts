import { describe, expect, it } from 'vitest';
import { expectedShortfall, valueAtRisk, valueAtRiskReport } from '../src/index.js';

/** DX §2.4 + WS-3: VaR facades expose .explain envelopes; prices-as-returns is flagged. */
const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
const returns = Array.from({ length: 60 }, (_, i) => 0.01 * Math.sin(i));

describe('risk explain envelopes (dx §2.4)', () => {
  it('valueAtRisk.explain echoes the applied defaults (confidence 0.95, historical, horizonPeriods 1)', () => {
    const r = valueAtRisk.explain(returns);
    expect(r.value).toBeGreaterThan(0);
    expect(r.assumptions.confidence).toBe(0.95);
    expect(r.assumptions.method).toBe('historical');
    expect(r.assumptions.horizonPeriods).toBe(1);
    expect(r.assumptions.conventionsVersion).toBeTypeOf('string');
    expect(expectedShortfall.explain(returns).value).toBeGreaterThanOrEqual(r.value);
  });

  it('plain calls still return bare numbers', () => {
    expect(valueAtRisk(returns)).toBeTypeOf('number');
    expect(expectedShortfall(returns)).toBeTypeOf('number');
  });

  it('valueAtRiskReport(prices) and valueAtRisk.explain(prices) flag input.suspicious_returns', () => {
    expect(valueAtRiskReport(prices).diagnostics.warnings.map((w) => w.code)).toContain(
      'input.suspicious_returns',
    );
    expect(valueAtRisk.explain(prices).diagnostics.warnings.map((w) => w.code)).toContain(
      'input.suspicious_returns',
    );
  });
});
