/**
 * Namespace wiring (DX2.2) — the grouped `heston.*` / `sabr.*` / `localVolatility.*` / `gbm.*` objects must
 * reference the exact same flat functions they replace. These identity assertions guarantee the
 * namespace is a zero-cost re-grouping (no wrapper, no copy) so callers can migrate off the deprecated
 * flats without any behaviour change.
 */
import { describe, expect, it } from 'vitest';
import * as optionsRoot from '@totalfinance/options';
import { gbm, heston, localVolatility, sabr } from '@totalfinance/options';
import {
  hestonCosineExpansionPrice,
  hestonImpliedVolatility,
  hestonMonteCarloEstimate,
  hestonPrice,
  hestonMonteCarloPrice,
} from '@totalfinance/options/heston';
import {
  sabrMonteCarloEstimate,
  sabrPrice,
  sabrMonteCarloPrice,
  sabrVolatility,
} from '@totalfinance/options/sabr';
import {
  dupireLocalVolatility,
  localVolatilityGrid,
  localVolatilityMonteCarloEstimate,
  localVolatilityMonteCarloPrice,
} from '@totalfinance/options/local-volatility';
import { gbmPath, gbmTerminal } from '@totalfinance/options/monte-carlo';

describe('heston namespace', () => {
  it('is identical to the expert-subpath kernels (curated ↔ expert coherence)', () => {
    expect(heston.price).toBe(hestonPrice);
    expect(heston.monteCarloPrice).toBe(hestonMonteCarloPrice);
    expect(heston.cosineExpansion).toBe(hestonCosineExpansionPrice);
    expect(heston.impliedVolatility).toBe(hestonImpliedVolatility);
    expect(heston.monteCarloEstimate).toBe(hestonMonteCarloEstimate);
  });
});

describe('sabr namespace', () => {
  it('is identical to the expert-subpath kernels', () => {
    expect(sabr.volatility).toBe(sabrVolatility);
    expect(sabr.price).toBe(sabrPrice);
    expect(sabr.monteCarloPrice).toBe(sabrMonteCarloPrice);
    expect(sabr.monteCarloEstimate).toBe(sabrMonteCarloEstimate);
  });
});

describe('localVolatility namespace', () => {
  it('is identical to the expert-subpath kernels', () => {
    expect(localVolatility.fromImplied).toBe(dupireLocalVolatility);
    expect(localVolatility.grid).toBe(localVolatilityGrid);
    expect(localVolatility.monteCarloPrice).toBe(localVolatilityMonteCarloPrice);
    expect(localVolatility.monteCarloEstimate).toBe(localVolatilityMonteCarloEstimate);
  });
});

describe('gbm namespace', () => {
  it('is identical to the expert-subpath kernels', () => {
    expect(gbm.path).toBe(gbmPath);
    expect(gbm.terminal).toBe(gbmTerminal);
  });
});

describe('root surface (specification D5 / Law 3)', () => {
  it('no longer leaks the flat kernel aliases — namespaces are the curated root form', () => {
    const root = optionsRoot as Record<string, unknown>;
    for (const gone of [
      'hestonPrice',
      'hestonMonteCarloPrice',
      'hestonCosineExpansionPrice',
      'hestonImpliedVolatility',
      'hestonMonteCarloEstimate',
      'sabrVolatility',
      'sabrPrice',
      'sabrMonteCarloPrice',
      'sabrMonteCarloEstimate',
      'dupireLocalVolatility',
      'localVolatilityGrid',
      'localVolatilityMonteCarloPrice',
      'localVolatilityMonteCarloEstimate',
      'gbmPath',
      'gbmTerminal',
    ]) {
      expect(root[gone], `${gone} should not be a root export`).toBeUndefined();
    }
  });
});
