/**
 * WS1.11: every documented @totalfinance/volatility module must have a subpath in the package `exports` map,
 * otherwise `import '@totalfinance/volatility/metrics'` throws ERR_PACKAGE_PATH_NOT_EXPORTED at runtime. This
 * test imports each deep entrypoint and asserts a known export resolves.
 */

import { describe, expect, it } from 'vitest';
import { varianceSwapRate } from '@totalfinance/volatility/analytics';
import { impliedVolatilityRank } from '@totalfinance/volatility/metrics';
import { localVolatilitySurface } from '@totalfinance/volatility/local-volatility';
import { calibrateHestonSurface } from '@totalfinance/volatility/heston-surface';
import { skew } from '@totalfinance/volatility/skew';
import { VolatilitySurface } from '@totalfinance/volatility/surface';

describe('@totalfinance/volatility deep entrypoints (WS1.11)', () => {
  it('analytics / metrics / local-volatility / heston-surface are importable per-feature', () => {
    expect(typeof varianceSwapRate).toBe('function');
    expect(typeof impliedVolatilityRank).toBe('function');
    expect(typeof localVolatilitySurface).toBe('function');
    expect(typeof calibrateHestonSurface).toBe('function');
  });

  it('metrics.impliedVolatilityRank computes against a history (0–100 scale)', () => {
    expect(
      impliedVolatilityRank.explain({ current: 0.3, history: [0.2, 0.25, 0.3, 0.35, 0.4] }).value,
    ).toBeCloseTo(50, 6);
  });

  it('previously-wired entrypoints still resolve', () => {
    expect(typeof skew).toBe('function');
    expect(typeof VolatilitySurface).toBe('function');
  });
});
