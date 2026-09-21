import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPABILITIES, missingCapabilities } from '@totalfinance/workflows';
import {
  REGISTRY_PROFILES,
  packsForProfile,
  registryForProfile,
} from '@totalfinance/workflows/local';

describe('task profiles preserve exact selection and grants', () => {
  it('preserves the default23 and original focused profiles', () => {
    expect(registryForProfile({ profile: 'default' }).size).toBe(23);
    expect(packsForProfile('options').map((pack) => pack.name)).toEqual(['options', 'volatility']);
    expect(packsForProfile('research').map((pack) => pack.name)).toEqual(['research']);
    expect(registryForProfile({ profile: 'full' }).size).toBe(46);
  });
  it.each([
    ['strategies', 'totalfinance.strategy.analyze'],
    ['portfolio', 'totalfinance.portfolio.explain_pnl'],
    ['valuation', 'totalfinance.valuation.company'],
    ['backtesting', 'totalfinance.backtest.vectorized_run'],
    ['scenarios', 'totalfinance.scenario.run'],
  ] as const)('%s offers a concrete task operation without privileged writes', (profile, id) => {
    const registry = registryForProfile({ profile });
    expect(registry.get(id)?.id).toBe(id);
    for (const operation of registry.list()) {
      expect(operation.sideEffect).toBe('none');
      expect(missingCapabilities(operation.requiredCapabilities, DEFAULT_CAPABILITIES)).toEqual([]);
    }
  });
  it('every profile narrows exactly, including the empty selection; results are fresh', () => {
    for (const profile of REGISTRY_PROFILES) {
      expect(registryForProfile({ profile, packs: [] }).size).toBe(0);
      const first = packsForProfile(profile)[0]!;
      expect(
        registryForProfile({ profile, packs: [first.name] })
          .list()
          .map((operation) => operation.id),
      ).toEqual(first.operations.map((operation) => operation.id));
      packsForProfile(profile).pop();
      expect(packsForProfile(profile).length).toBeGreaterThan(0);
    }
    expect(() => registryForProfile({ profile: 'valuation', packs: ['trade'] })).toThrow();
    expect(() => registryForProfile({ profile: 'full', packs: ['options', 'options'] })).toThrow();
  });
  it.each([null, undefined, [], {}, 1, '__proto__', 'constructor', 'toString', 'unknown'])(
    'rejects adversarial profile %j',
    (profile) => {
      expect(() => packsForProfile(profile as never)).toThrow();
    },
  );
});
