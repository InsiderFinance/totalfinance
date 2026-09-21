import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, type Computed } from '@totalfinance/core';
import {
  canonicalJsonOf,
  createAnalysisArtifact,
  createMarketSnapshot,
  createScenarioSet,
  fromCanonicalJson,
  marketSnapshotContentHash,
  readAnalysisArtifact,
  readMarketSnapshot,
  readScenarioSet,
  scenarioSetContentHash,
  type MarketSnapshot,
  type ScenarioSet,
} from '@totalfinance/core/artifacts';
import {
  requireObservationValue,
  type MarketRequirement,
  type Pricer,
} from '@totalfinance/core/pricing';
import {
  runScenarios,
  scenarioTarget,
  type RunScenariosOptions,
  type ScenarioBehaviorIdentity,
  type ScenarioFactorHandler,
  type ScenarioMarketResolver,
  type ScenarioReplayParameters,
  type ScenarioReplayTargetBinding,
  type ScenarioRunResult,
  type ScenarioTarget,
  type ScenarioTargetAxisRow,
} from '../src/index.js';

const AS_OF = Date.UTC(2026, 7, 30);
const EXPIRY = Date.UTC(2027, 7, 30);

function persisted<T>(value: T): unknown {
  return fromCanonicalJson(canonicalJsonOf(value));
}

function saveScenarioRun(result: ScenarioRunResult) {
  return createAnalysisArtifact({
    artifactType: 'scenarios.run',
    producedBy: { operation: 'runScenarios' },
    inputs: {
      snapshotHash: result.assumptions.marketSnapshotHash,
      parameters: {
        scenarioSetHash: result.assumptions.scenarioSetHash,
        targets: result.targetAxis,
        run: result.assumptions.replayParameters,
      },
    },
    // Compile-time evidence: ScenarioRunResult is directly accepted without a cast or spread.
    result,
  });
}

function restoredScenarioResult(value: Record<string, unknown>): ScenarioRunResult {
  if (
    !Array.isArray(value['targetAxis']) ||
    value['assumptions'] === null ||
    typeof value['assumptions'] !== 'object'
  ) {
    throw new Error('stored scenarios.run result does not have the Stage 4.4b result shape');
  }
  return value as ScenarioRunResult;
}

function descriptorWithoutIndex(row: ScenarioTargetAxisRow): Record<string, unknown> {
  const { targetIndex: _targetIndex, ...descriptor } = row;
  return descriptor;
}

function targetsFromOrderedBindings(
  rows: readonly ScenarioTargetAxisRow[],
  bindings: readonly ScenarioReplayTargetBinding[],
): readonly ScenarioTarget[] {
  if (bindings.length !== rows.length) {
    throw new Error(
      `replay requires exactly one target binding per saved row; received ${bindings.length} for ${rows.length}`,
    );
  }

  const seen = new Set<string>();
  return rows.map((row, index) => {
    const binding = bindings[index]!;
    if (seen.has(binding.targetId)) {
      throw new Error(`replay target binding ${JSON.stringify(binding.targetId)} is duplicated`);
    }
    seen.add(binding.targetId);
    if (binding.targetId !== row.id || binding.target.id !== row.id) {
      throw new Error(
        `replay target binding ${index} must be ${JSON.stringify(row.id)} in saved row order`,
      );
    }
    if (canonicalJsonOf({ ...binding.target }) !== canonicalJsonOf(descriptorWithoutIndex(row))) {
      throw new Error(
        `replay target binding ${JSON.stringify(row.id)} does not match its complete saved descriptor`,
      );
    }
    return binding.target;
  });
}

function assertBehaviorOrder(
  label: string,
  saved: readonly ScenarioBehaviorIdentity[],
  rebound: readonly ScenarioBehaviorIdentity[],
): void {
  if (rebound.length < saved.length) {
    throw new Error(
      `${label} are missing ${saved.length - rebound.length} saved behavior identity entries`,
    );
  }
  if (rebound.length > saved.length) {
    throw new Error(
      `${label} contain ${rebound.length - saved.length} extra behavior identity entries`,
    );
  }

  const seen = new Set<string>();
  for (let index = 0; index < rebound.length; index++) {
    const identity = rebound[index]!;
    const key = canonicalJsonOf(identity);
    if (seen.has(key)) {
      throw new Error(
        `${label} duplicate ${JSON.stringify(identity.name)}@${JSON.stringify(identity.version)} at index ${index}`,
      );
    }
    seen.add(key);
  }

  for (let index = 0; index < saved.length; index++) {
    const expected = saved[index]!;
    const received = rebound[index]!;
    if (canonicalJsonOf(received) === canonicalJsonOf(expected)) continue;
    if (saved.some((identity) => canonicalJsonOf(identity) === canonicalJsonOf(received))) {
      throw new Error(
        `${label} are reordered at index ${index}; expected ${JSON.stringify(expected.name)}@${JSON.stringify(expected.version)} but received ${JSON.stringify(received.name)}@${JSON.stringify(received.version)}`,
      );
    }
    throw new Error(
      `${label} contain undeclared identity ${JSON.stringify(received.name)}@${JSON.stringify(received.version)} at index ${index}`,
    );
  }
}

function behaviorIdentities(
  behaviors: readonly { readonly name: string; readonly version: string }[],
): readonly ScenarioBehaviorIdentity[] {
  return behaviors.map(({ name, version }) => ({ name, version }));
}

function behaviorRebindingError(
  label: string,
  saved: readonly ScenarioBehaviorIdentity[],
  rebound: readonly ScenarioBehaviorIdentity[],
): string {
  try {
    assertBehaviorOrder(label, saved, rebound);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error(`${label} rebinding unexpectedly succeeded`);
}

function replayOptions(
  replay: ScenarioReplayParameters,
  behavior: Pick<RunScenariosOptions, 'marketResolvers' | 'factorHandlers'> = {},
): RunScenariosOptions {
  return {
    failureMode: replay.failureMode,
    ...(replay.seed === null ? {} : { seed: replay.seed }),
    maximumValuationCells: replay.maximumValuationCells,
    maximumWorkUnits: replay.maximumWorkUnits,
    ...(behavior.marketResolvers === undefined
      ? {}
      : { marketResolvers: behavior.marketResolvers }),
    ...(behavior.factorHandlers === undefined ? {} : { factorHandlers: behavior.factorHandlers }),
  };
}

function rebuildTaylorTarget(row: ScenarioTargetAxisRow): ScenarioTarget {
  if (row.valuationMethod !== 'taylor') {
    throw new Error(`saved target ${JSON.stringify(row.id)} is not a Taylor target`);
  }
  return scenarioTarget.taylor({
    id: row.id,
    quantity: row.quantity,
    contractMultiplier: row.contractMultiplier,
    currency: row.currency,
    ...(row.underlying === undefined ? {} : { underlying: row.underlying }),
    ...(row.strategy === undefined ? {} : { strategy: row.strategy }),
    ...(row.account === undefined ? {} : { account: row.account }),
    ...(row.book === undefined ? {} : { book: row.book }),
    tags: row.tags,
    baseValuePerUnit: row.taylor.baseValuePerUnit,
    greeks: row.taylor.sensitivities,
    factors: row.taylor.factors,
  });
}

function restoreInputs(scenarioSet: ScenarioSet, market: MarketSnapshot) {
  const restoredScenarioSet = readScenarioSet({
    scenarioSet: persisted(scenarioSet),
  }).scenarioSet;
  const restoredMarket = readMarketSnapshot({ snapshot: persisted(market) }).snapshot;
  return { scenarioSet: restoredScenarioSet, market: restoredMarket };
}

interface ForwardCertificateDescriptor {
  readonly kind: 'example.forward-certificate';
  readonly symbol: string;
  readonly expiresAt: number;
  readonly additiveSpread: number;
}

interface ForwardCertificate {
  readonly descriptor: ForwardCertificateDescriptor;
  readonly runtimeSpread: () => number;
}

interface ForwardCertificateResult extends Computed<number> {
  readonly forward: number;
  readonly additiveSpread: number;
}

interface PricerCounters {
  supports: number;
  requirements: number;
  price: number;
}

interface BehaviorCounters {
  fallbackResolver: number;
  forwardResolver: number;
  liquidityHandler: number;
  executionCostHandler: number;
}

function forwardResolvers(counters: BehaviorCounters): readonly ScenarioMarketResolver[] {
  return [
    {
      name: 'example.forward-fallback',
      version: '1.0.0',
      resolve: () => {
        counters.fallbackResolver++;
        return undefined;
      },
    },
    {
      name: 'example.forward-source',
      version: '2026-08-30',
      resolve: ({ requirement }) => {
        counters.forwardResolver++;
        return requirement.kind === 'forward' ? { requirement, value: 104 } : undefined;
      },
    },
  ];
}

function forwardFactorHandlers(counters: BehaviorCounters): readonly ScenarioFactorHandler[] {
  return [
    {
      factor: 'liquidityPremium',
      name: 'example.liquidity-premium-handler',
      version: '1.2.0',
      apply: ({ instruction, observations }) => {
        counters.liquidityHandler++;
        return observations.map((observation) =>
          observation.requirement.kind === 'forward'
            ? {
                requirement: observation.requirement,
                value: (observation.value as number) + instruction.value,
              }
            : observation,
        );
      },
    },
    {
      factor: 'executionCost',
      name: 'example.execution-cost-handler',
      version: '2.0.0',
      apply: ({ instruction, observations }) => {
        counters.executionCostHandler++;
        return observations.map((observation) =>
          observation.requirement.kind === 'forward'
            ? {
                requirement: observation.requirement,
                value: (observation.value as number) - instruction.value,
              }
            : observation,
        );
      },
    },
  ];
}

function readForwardCertificateDescriptor(value: unknown): ForwardCertificateDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('forward-certificate replay descriptor must be an object');
  }
  const descriptor = value as Record<string, unknown>;
  if (
    descriptor['kind'] !== 'example.forward-certificate' ||
    typeof descriptor['symbol'] !== 'string' ||
    typeof descriptor['expiresAt'] !== 'number' ||
    typeof descriptor['additiveSpread'] !== 'number'
  ) {
    throw new Error('forward-certificate replay descriptor is malformed');
  }
  return {
    kind: descriptor['kind'],
    symbol: descriptor['symbol'],
    expiresAt: descriptor['expiresAt'],
    additiveSpread: descriptor['additiveSpread'],
  };
}

function rehydrateForwardCertificate(value: unknown): ForwardCertificate {
  const descriptor = readForwardCertificateDescriptor(value);
  return {
    descriptor,
    runtimeSpread: () => descriptor.additiveSpread,
  };
}

function forwardCertificatePricer(
  counters: PricerCounters,
): Pricer<ForwardCertificate, ForwardCertificateResult> {
  return {
    name: 'example.forward-certificate-pricer',
    version: '1.0.0',
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: (instrument) => {
      counters.supports++;
      return instrument.descriptor.kind === 'example.forward-certificate';
    },
    requirements: (instrument) => {
      counters.requirements++;
      return [
        {
          kind: 'forward',
          symbol: instrument.descriptor.symbol,
          expiresAt: instrument.descriptor.expiresAt,
        },
      ];
    },
    price: ({ instrument, observations }) => {
      counters.price++;
      const requirement: MarketRequirement & { kind: 'forward' } = {
        kind: 'forward',
        symbol: instrument.descriptor.symbol,
        expiresAt: instrument.descriptor.expiresAt,
      };
      const forward = requireObservationValue(
        'example.forward-certificate-pricer.price',
        observations,
        requirement,
      );
      const additiveSpread = instrument.runtimeSpread();
      return {
        value: forward + additiveSpread,
        forward,
        additiveSpread,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      };
    },
  };
}

describe('Stage 4.4b analysis-artifact replay', () => {
  it('restores a Taylor-only artifact, enforces exact ordered bindings, and reproduces canonical bytes', () => {
    const scenarioSet = createScenarioSet({
      name: 'Taylor replay',
      scenarios: [
        {
          name: 'risk-on',
          shocks: [
            { factor: 'spot', kind: 'absolute', value: 4 },
            { factor: 'volatility', kind: 'absolute', value: 0.02 },
          ],
        },
      ],
    });
    const market = createMarketSnapshot({
      asOf: AS_OF,
      observations: {
        spots: { AAPL: { price: 100, currency: 'USD' }, MSFT: { price: 200, currency: 'USD' } },
        volatilities: { AAPL: 0.2, MSFT: 0.25 },
      },
    });
    const targets = [
      scenarioTarget.taylor({
        id: 'aapl-taylor',
        quantity: 2,
        contractMultiplier: 100,
        currency: 'USD',
        underlying: 'AAPL',
        strategy: 'covered-call',
        account: 'taxable',
        book: 'household',
        tags: ['equity-options'],
        baseValuePerUnit: 12,
        greeks: { delta: 0.5, gamma: 0.02, vega: 7 },
        factors: {
          spot: { subject: 'AAPL', level: 100 },
          volatility: { subject: 'AAPL', level: 0.2 },
        },
      }),
      scenarioTarget.taylor({
        id: 'msft-taylor',
        quantity: -1,
        contractMultiplier: 50,
        currency: 'USD',
        underlying: 'MSFT',
        strategy: 'put-spread',
        account: 'retirement',
        book: 'household',
        tags: ['hedge'],
        baseValuePerUnit: 8,
        greeks: { delta: -0.3, gamma: 0.01, vega: 4 },
        factors: {
          spot: { subject: 'MSFT', level: 200 },
          volatility: { subject: 'MSFT', level: 0.25 },
        },
      }),
    ];
    const result = runScenarios({
      scenarioSet,
      market,
      targets,
      reportingCurrency: 'USD',
      currencyConversions: [],
      options: {
        failureMode: 'fail-fast',
        maximumValuationCells: 10_000,
        maximumWorkUnits: 20_000_000,
      },
    });
    const artifact = saveScenarioRun(result);

    expect(canonicalJsonOf(artifact.result)).toBe(canonicalJsonOf(result));
    const restored = readAnalysisArtifact({ artifact: persisted(artifact) });
    expect(restored.migrationsApplied).toEqual([]);
    const savedResult = restoredScenarioResult(restored.artifact.result);
    const restoredInputs = restoreInputs(scenarioSet, market);

    expect(scenarioSetContentHash(restoredInputs.scenarioSet)).toBe(
      savedResult.assumptions.scenarioSetHash,
    );
    expect(marketSnapshotContentHash(restoredInputs.market)).toBe(
      savedResult.assumptions.marketSnapshotHash,
    );

    const bindings: readonly ScenarioReplayTargetBinding[] = savedResult.targetAxis.map((row) => ({
      targetId: row.id,
      target: rebuildTaylorTarget(row),
    }));
    expect(() => targetsFromOrderedBindings(savedResult.targetAxis, bindings.slice(0, 1))).toThrow(
      /exactly one target binding per saved row/,
    );
    expect(() =>
      targetsFromOrderedBindings(savedResult.targetAxis, [...bindings].reverse()),
    ).toThrow(/saved row order/);
    expect(() =>
      targetsFromOrderedBindings(savedResult.targetAxis, [bindings[0]!, bindings[0]!]),
    ).toThrow(/duplicated|saved row order/);

    const reboundTargets = targetsFromOrderedBindings(savedResult.targetAxis, bindings);
    assertBehaviorOrder('market resolvers', savedResult.assumptions.replayParameters.resolvers, []);
    assertBehaviorOrder(
      'factor handlers',
      savedResult.assumptions.replayParameters.factorHandlers,
      [],
    );
    const recomputed = runScenarios({
      scenarioSet: restoredInputs.scenarioSet,
      market: restoredInputs.market,
      targets: reboundTargets,
      reportingCurrency: savedResult.assumptions.replayParameters.reportingCurrency,
      currencyConversions: savedResult.assumptions.replayParameters.currencyConversions,
      options: replayOptions(savedResult.assumptions.replayParameters),
    });

    expect(canonicalJsonOf(recomputed)).toBe(canonicalJsonOf(restored.artifact.result));
  });

  it('rehydrates a third-party target and requires exact resolver and handler identity arrays', () => {
    const scenarioSet = createScenarioSet({
      name: 'Third-party replay',
      scenarios: [
        {
          name: 'forward +3',
          shocks: [
            { factor: 'forward', target: 'ACME', kind: 'absolute', value: 3 },
            { factor: 'liquidityPremium', kind: 'absolute', value: 2 },
            { factor: 'executionCost', kind: 'absolute', value: 0.5 },
          ],
        },
      ],
    });
    const market = createMarketSnapshot({ asOf: AS_OF, observations: {} });
    const descriptor: ForwardCertificateDescriptor = {
      kind: 'example.forward-certificate',
      symbol: 'ACME',
      expiresAt: EXPIRY,
      additiveSpread: 0.75,
    };
    const originalCounters: PricerCounters = { supports: 0, requirements: 0, price: 0 };
    const target = scenarioTarget.fullRevaluation({
      id: 'acme-forward-certificate',
      quantity: 4,
      contractMultiplier: 10,
      currency: 'USD',
      underlying: 'ACME',
      strategy: 'carry',
      tags: ['third-party'],
      instrument: rehydrateForwardCertificate(descriptor),
      instrumentDescriptor: descriptor,
      pricer: forwardCertificatePricer(originalCounters),
    });
    const originalBehaviorCounters: BehaviorCounters = {
      fallbackResolver: 0,
      forwardResolver: 0,
      liquidityHandler: 0,
      executionCostHandler: 0,
    };
    const resolvers = forwardResolvers(originalBehaviorCounters);
    const factorHandlers = forwardFactorHandlers(originalBehaviorCounters);
    const result = runScenarios({
      scenarioSet,
      market,
      targets: [target],
      reportingCurrency: 'USD',
      currencyConversions: [],
      options: {
        failureMode: 'fail-fast',
        maximumValuationCells: 10_000,
        maximumWorkUnits: 20_000_000,
        marketResolvers: resolvers,
        factorHandlers,
      },
    });
    expect(originalCounters).toEqual({ supports: 1, requirements: 1, price: 2 });
    expect(originalBehaviorCounters).toEqual({
      fallbackResolver: 1,
      forwardResolver: 1,
      liquidityHandler: 1,
      executionCostHandler: 1,
    });

    const artifact = saveScenarioRun(result);
    expect(canonicalJsonOf(artifact.result)).toBe(canonicalJsonOf(result));
    const restored = readAnalysisArtifact({ artifact: persisted(artifact) });
    const savedResult = restoredScenarioResult(restored.artifact.result);
    const restoredInputs = restoreInputs(scenarioSet, market);
    const savedRow = savedResult.targetAxis[0]!;
    if (savedRow.valuationMethod !== 'full-revaluation') {
      throw new Error('expected saved full-revaluation target');
    }

    const replayCounters: PricerCounters = { supports: 0, requirements: 0, price: 0 };
    const freshTarget = scenarioTarget.fullRevaluation({
      id: savedRow.id,
      quantity: savedRow.quantity,
      contractMultiplier: savedRow.contractMultiplier,
      currency: savedRow.currency,
      ...(savedRow.underlying === undefined ? {} : { underlying: savedRow.underlying }),
      ...(savedRow.strategy === undefined ? {} : { strategy: savedRow.strategy }),
      ...(savedRow.account === undefined ? {} : { account: savedRow.account }),
      ...(savedRow.book === undefined ? {} : { book: savedRow.book }),
      tags: savedRow.tags,
      instrument: rehydrateForwardCertificate(savedRow.instrumentDescriptor),
      instrumentDescriptor: savedRow.instrumentDescriptor,
      pricer: forwardCertificatePricer(replayCounters),
    });
    const bindings: readonly ScenarioReplayTargetBinding[] = [
      { targetId: savedRow.id, target: freshTarget },
    ];
    const reboundTargets = targetsFromOrderedBindings(savedResult.targetAxis, bindings);
    const replayBehaviorCounters: BehaviorCounters = {
      fallbackResolver: 0,
      forwardResolver: 0,
      liquidityHandler: 0,
      executionCostHandler: 0,
    };
    const reboundResolvers = forwardResolvers(replayBehaviorCounters);
    const reboundFactorHandlers = forwardFactorHandlers(replayBehaviorCounters);
    const savedResolvers = savedResult.assumptions.replayParameters.resolvers;
    const savedFactorHandlers = savedResult.assumptions.replayParameters.factorHandlers;
    const reboundResolverIdentities = behaviorIdentities(reboundResolvers);
    const reboundHandlerIdentities = behaviorIdentities(reboundFactorHandlers);

    expect(
      behaviorRebindingError('market resolvers', savedResolvers, savedResolvers.slice(0, -1)),
    ).toBe('market resolvers are missing 1 saved behavior identity entries');
    expect(
      behaviorRebindingError('market resolvers', savedResolvers, [
        ...savedResolvers,
        { name: 'example.unrecorded-resolver', version: '1.0.0' },
      ]),
    ).toBe('market resolvers contain 1 extra behavior identity entries');
    expect(
      behaviorRebindingError('market resolvers', savedResolvers, [
        savedResolvers[0]!,
        savedResolvers[0]!,
      ]),
    ).toBe('market resolvers duplicate "example.forward-fallback"@"1.0.0" at index 1');
    expect(
      behaviorRebindingError('market resolvers', savedResolvers, [...savedResolvers].reverse()),
    ).toBe(
      'market resolvers are reordered at index 0; expected "example.forward-fallback"@"1.0.0" but received "example.forward-source"@"2026-08-30"',
    );

    expect(
      behaviorRebindingError(
        'factor handlers',
        savedFactorHandlers,
        savedFactorHandlers.slice(0, -1),
      ),
    ).toBe('factor handlers are missing 1 saved behavior identity entries');
    expect(
      behaviorRebindingError('factor handlers', savedFactorHandlers, [
        ...savedFactorHandlers,
        { name: 'example.unrecorded-handler', version: '1.0.0' },
      ]),
    ).toBe('factor handlers contain 1 extra behavior identity entries');
    expect(
      behaviorRebindingError('factor handlers', savedFactorHandlers, [
        savedFactorHandlers[0]!,
        savedFactorHandlers[0]!,
      ]),
    ).toBe('factor handlers duplicate "example.liquidity-premium-handler"@"1.2.0" at index 1');
    expect(
      behaviorRebindingError(
        'factor handlers',
        savedFactorHandlers,
        [...savedFactorHandlers].reverse(),
      ),
    ).toBe(
      'factor handlers are reordered at index 0; expected "example.liquidity-premium-handler"@"1.2.0" but received "example.execution-cost-handler"@"2.0.0"',
    );

    assertBehaviorOrder('market resolvers', savedResolvers, reboundResolverIdentities);
    assertBehaviorOrder('factor handlers', savedFactorHandlers, reboundHandlerIdentities);

    const recomputed = runScenarios({
      scenarioSet: restoredInputs.scenarioSet,
      market: restoredInputs.market,
      targets: reboundTargets,
      reportingCurrency: savedResult.assumptions.replayParameters.reportingCurrency,
      currencyConversions: savedResult.assumptions.replayParameters.currencyConversions,
      options: replayOptions(savedResult.assumptions.replayParameters, {
        marketResolvers: reboundResolvers,
        factorHandlers: reboundFactorHandlers,
      }),
    });

    expect(replayCounters).toEqual({ supports: 1, requirements: 1, price: 2 });
    expect(replayBehaviorCounters).toEqual({
      fallbackResolver: 1,
      forwardResolver: 1,
      liquidityHandler: 1,
      executionCostHandler: 1,
    });
    expect(canonicalJsonOf(recomputed)).toBe(canonicalJsonOf(restored.artifact.result));
  });
});
