/** Stage 4.4b compile-only evidence for the scenarios public surface and discriminated results. */

import {
  createAnalysisArtifact,
  createMarketSnapshot,
  createScenarioSet,
} from '@totalfinance/core/artifacts';
import { runScenarios, scenarioTarget, spotAssetPricer } from '@totalfinance/scenarios';
import {
  scenarioPortfolioBinding,
  scenarioTargetsFromPortfolio,
} from '@totalfinance/scenarios/portfolio';
import type { ScenarioFactorHandler, ScenarioMarketResolver } from '@totalfinance/scenarios';
import * as umbrella from 'totalfinance';
import * as umbrellaScenarios from 'totalfinance/scenarios';

function requireUndefinedReceiver(_receiver: undefined): void {}

function assertScenarioSignatureCompatibility(): void {
  const scenarioSet = createScenarioSet({
    name: 'compile fixture',
    scenarios: [{ name: 'spot up', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] }],
  });
  const market = createMarketSnapshot({
    asOf: Date.UTC(2026, 7, 30),
    observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
  });
  const target = scenarioTarget.spot({
    id: 'aapl-stock',
    symbol: 'AAPL',
    quantity: 2,
    currency: 'USD',
  });

  const result = runScenarios({ scenarioSet, market, targets: [target] });
  // @ts-expect-error Stage 4.4b exposes one named request object, never split positional inputs.
  runScenarios(scenarioSet, market, [target]);

  const readonlyResolver: ScenarioMarketResolver = {
    name: 'compile.readonly-resolver',
    version: '1.0.0',
    resolve: function (this: undefined, input) {
      requireUndefinedReceiver(this);
      // @ts-expect-error Resolver requirements are deeply readonly callback data.
      input.requirement.kind = 'spot';
      // @ts-expect-error Resolver snapshots are deeply readonly, including nested records.
      input.market.observations.spots = {};
      // @ts-expect-error Resolver target arrays are deeply readonly.
      input.target.tags.push('mutated');
      return undefined;
    },
  };
  const resolverRequiringReceiver: ScenarioMarketResolver = {
    name: 'compile.invalid-this-resolver',
    version: '1.0.0',
    // @ts-expect-error Resolvers are always called unbound with this === undefined.
    resolve: function (this: { token: string }) {
      return undefined;
    },
  };
  const readonlyHandler: ScenarioFactorHandler = {
    factor: 'liquidity',
    name: 'compile.readonly-handler',
    version: '1.0.0',
    apply: function (this: undefined, input) {
      requireUndefinedReceiver(this);
      // @ts-expect-error Handler instructions are deeply readonly callback data.
      input.instruction.value = 0;
      // @ts-expect-error Handler observation lists are deeply readonly.
      input.observations.push({
        requirement: { kind: 'spot', symbol: 'AAPL' },
        value: 0,
      });
      const observation = input.observations[0];
      if (observation?.requirement.kind === 'discountCurve') {
        // @ts-expect-error Handler curve pillars are recursively readonly.
        observation.value.points[0]!.zeroRate = 0;
      }
      return undefined;
    },
  };
  const handlerRequiringReceiver: ScenarioFactorHandler = {
    factor: 'liquidity',
    name: 'compile.invalid-this-handler',
    version: '1.0.0',
    // @ts-expect-error Handlers are always called unbound with this === undefined.
    apply: function (this: { token: string }) {
      return undefined;
    },
  };
  void readonlyResolver;
  void resolverRequiringReceiver;
  void readonlyHandler;
  void handlerRequiringReceiver;

  scenarioTarget.fullRevaluation({
    id: 'incompatible-pricer',
    quantity: 1,
    contractMultiplier: 1,
    currency: 'USD',
    instrument: { cusip: '91282CJL6' },
    instrumentDescriptor: { kind: 'bond', cusip: '91282CJL6' },
    // @ts-expect-error NoInfer makes the instrument authoritative; a spot pricer cannot price a bond.
    pricer: spotAssetPricer(),
  });

  scenarioPortfolioBinding.fullRevaluation({
    id: 'incompatible-portfolio-pricer',
    accountId: 'primary',
    instrumentId: 'bond',
    instrument: { cusip: '91282CJL6' },
    instrumentDescriptor: { kind: 'bond', cusip: '91282CJL6' },
    // @ts-expect-error Portfolio bindings preserve the same instrument-owned NoInfer contract.
    pricer: spotAssetPricer(),
  });

  for (const targetRow of result.targetAxis) {
    if (targetRow.valuationMethod === 'full-revaluation') {
      void targetRow.instrumentDescriptorHash;
      void targetRow.pricer.capabilities;
    } else {
      void targetRow.taylorDescriptorHash;
      void targetRow.taylor.sensitivities;
    }
  }

  for (const base of result.base) {
    if (base.status === 'failed') {
      void base.failure.code;
    } else if (base.valuationMethod === 'full-revaluation') {
      void base.pricingResult.value;
    } else {
      void base.baseValueSource;
    }
  }

  for (const cell of result.cells) {
    if (cell.status === 'failed') {
      void cell.failure.contextStatus;
      continue;
    }
    if (cell.status === 'blocked') {
      void cell.blockedByBaseFailure.targetId;
      continue;
    }
    if (cell.valuationMethod === 'full-revaluation') void cell.pricingResult.value;
    else void cell.taylorResult.total;
    for (const instruction of cell.appliedInstructions) {
      if ('after' in instruction) {
        void instruction.after;
      } else if (instruction.detail === 'discount-curve') {
        void instruction.afterCurveHash;
      } else if (instruction.detail === 'custom') {
        void instruction.handler;
      }
    }
  }

  for (const aggregate of result.aggregates.scenarios.flatMap((row) => row.rows)) {
    if (aggregate.status === 'complete') void aggregate.pnl;
    else void aggregate.reason;
  }

  createAnalysisArtifact({
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
    result,
  });

  const scopedRun: typeof runScenarios = umbrellaScenarios.runScenarios;
  const scopedTarget: typeof scenarioTarget = umbrellaScenarios.scenarioTarget;
  const scopedSpotPricer: typeof spotAssetPricer = umbrellaScenarios.spotAssetPricer;
  const scopedPortfolioBinding: typeof scenarioPortfolioBinding =
    umbrellaScenarios.scenarioPortfolioBinding;
  const scopedPortfolioAdapter: typeof scenarioTargetsFromPortfolio =
    umbrellaScenarios.scenarioTargetsFromPortfolio;
  void scopedRun;
  void scopedTarget;
  void scopedSpotPricer;
  void scopedPortfolioBinding;
  void scopedPortfolioAdapter;
  void scenarioTargetsFromPortfolio;
  void umbrella.scenarios.runScenarios;
  // @ts-expect-error Scenario operations live under totalfinance.scenarios and are never root-hoisted.
  void umbrella.runScenarios;
}

void assertScenarioSignatureCompatibility;

export {};
