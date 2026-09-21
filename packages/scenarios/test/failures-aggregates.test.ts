import { describe, expect, it } from 'vitest';
import { ErrorCode, QuantError } from '@totalfinance/core';
import { buildScenarioAggregates } from '../src/aggregates.js';
import {
  snapshotScenarioFailure,
  throwScenarioFailure,
  type ScenarioFailureCoordinates,
} from '../src/internal/failures.js';
import type {
  ScenarioBaseCell,
  ScenarioCell,
  ScenarioExecutionFailure,
  ScenarioTargetAxisRow,
} from '../src/types.js';

const COORDINATES: ScenarioFailureCoordinates = {
  targetIndex: 1,
  targetId: 'broken',
  scenarioIndex: 0,
  scenarioName: 'stress',
  valuationMethod: 'full-revaluation',
};

function target(input: {
  targetIndex: number;
  id: string;
  underlying?: string;
  strategy?: string;
  account?: string;
  book?: string;
  tags?: readonly string[];
}): ScenarioTargetAxisRow {
  return {
    targetIndex: input.targetIndex,
    id: input.id,
    quantity: 1,
    contractMultiplier: 1,
    currency: 'USD',
    tags: input.tags ?? [],
    targetDescriptorHash: `sha256:${'0'.repeat(64)}`,
    valuationMethod: 'taylor',
    taylor: { baseValuePerUnit: 1, sensitivities: {}, factors: {} },
    taylorDescriptorHash: `sha256:${'1'.repeat(64)}`,
    ...(input.underlying === undefined ? {} : { underlying: input.underlying }),
    ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(input.book === undefined ? {} : { book: input.book }),
  };
}

function completeBase(targetIndex: number, targetId: string, value: number): ScenarioBaseCell {
  return {
    kind: 'base',
    status: 'complete',
    targetIndex,
    targetId,
    reportingPositionValue: value,
  } as ScenarioBaseCell;
}

function completeCell(
  targetIndex: number,
  targetId: string,
  value: number,
  pnl: number,
): ScenarioCell {
  return {
    kind: 'scenario',
    status: 'complete',
    targetIndex,
    targetId,
    scenarioIndex: 0,
    scenarioName: 'stress',
    reportingPositionValue: value,
    reportingPnl: pnl,
  } as ScenarioCell;
}

function failedCell(
  targetIndex: number,
  targetId: string,
  failure: ScenarioExecutionFailure,
): ScenarioCell {
  return {
    kind: 'scenario',
    status: 'failed',
    targetIndex,
    targetId,
    scenarioIndex: 0,
    scenarioName: 'stress',
    valuationMethod: 'full-revaluation',
    valuePerUnit: null,
    positionValue: null,
    reportingPositionValue: null,
    localPnl: null,
    reportingPnl: null,
    failure,
  };
}

describe('scenario failure snapshots', () => {
  it('preserves bounded QuantError code, message, and detached canonical context', () => {
    const context = { venue: 'XNAS', nested: { retry: false } };
    const original = new QuantError('market unavailable', {
      code: 'test.market_unavailable',
      context,
    });
    const failure = snapshotScenarioFailure(original, COORDINATES);
    context.nested.retry = true;

    expect(failure).toEqual({
      code: 'test.market_unavailable',
      message: 'market unavailable',
      context: { venue: 'XNAS', nested: { retry: false } },
      contextStatus: 'preserved',
      ...COORDINATES,
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.context)).toBe(true);
    expect(Object.isFrozen((failure.context as { nested: object }).nested)).toBe(true);
  });

  it('never invokes hostile getters or arbitrary serialization/coercion hooks', () => {
    let reads = 0;
    const hostile = Object.create(Error.prototype);
    Object.defineProperties(hostile, {
      message: {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('must not execute');
        },
      },
      context: {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('must not execute');
        },
      },
      toJSON: {
        value() {
          reads += 1;
        },
      },
      toString: {
        value() {
          reads += 1;
        },
      },
    });

    const failure = snapshotScenarioFailure(hostile, COORDINATES);
    expect(reads).toBe(0);
    expect(failure).toMatchObject({
      code: ErrorCode.ScenarioCellFailed,
      message: 'Scenario cell execution failed without a safe error message.',
      context: null,
      contextStatus: 'omitted-unsafe',
    });
  });

  it('omits cyclic, non-finite, or oversized context rather than retaining unsafe data', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const context of [cyclic, { value: Number.NaN }, { text: 'x'.repeat(20_000) }]) {
      const failure = snapshotScenarioFailure(
        new QuantError('unsafe context', { code: 'test.unsafe', context }),
        COORDINATES,
      );
      expect(failure.context).toBeNull();
      expect(failure.contextStatus).toBe('omitted-unsafe');
    }
  });

  it('preserves the exact original thrown value as fail-fast cause', () => {
    const original = { reason: 'opaque vendor throw' };
    const snapshot = snapshotScenarioFailure(original, COORDINATES);
    let thrown: unknown;
    try {
      throwScenarioFailure(snapshot, original);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(QuantError);
    expect((thrown as QuantError).cause).toBe(original);
    expect((thrown as QuantError).code).toBe(ErrorCode.ScenarioCellFailed);
  });
});

describe('deterministic scenario aggregates', () => {
  const targets = [
    target({
      targetIndex: 0,
      id: 'zeta',
      underlying: 'MSFT',
      strategy: 'growth',
      account: 'taxable',
      book: 'long-term',
      tags: ['large-cap', 'tech'],
    }),
    target({
      targetIndex: 1,
      id: 'alpha',
      underlying: 'AAPL',
      strategy: 'growth',
      account: 'ira',
      book: 'long-term',
      tags: ['tech'],
    }),
  ];
  const scenarioAxis = [
    {
      scenarioIndex: 0,
      name: 'stress',
      scenarioHash: `sha256:${'2'.repeat(64)}`,
      overrideCount: 0,
      shockCount: 1,
    },
  ];

  it('uses fixed family order, lexicographic keys, and target-axis member order', () => {
    const aggregates = buildScenarioAggregates({
      targets,
      scenarioAxis,
      base: [completeBase(0, 'zeta', 100), completeBase(1, 'alpha', 200)],
      cells: [completeCell(0, 'zeta', 110, 10), completeCell(1, 'alpha', 180, -20)],
      reportingCurrency: 'USD',
    });

    expect(aggregates.scenarios[0]!.rows.map(({ group, key }) => `${group}:${key}`)).toEqual([
      'target:alpha',
      'target:zeta',
      'underlying:AAPL',
      'underlying:MSFT',
      'strategy:growth',
      'account:ira',
      'account:taxable',
      'book:long-term',
      'tag:large-cap',
      'tag:tech',
      'grand-total:all',
    ]);
    const growth = aggregates.scenarios[0]!.rows.find(
      (row) => row.group === 'strategy' && row.key === 'growth',
    );
    expect(growth).toEqual({
      group: 'strategy',
      key: 'growth',
      reportingCurrency: 'USD',
      status: 'complete',
      baseValue: 300,
      scenarioValue: 290,
      pnl: -10,
      targetIds: ['zeta', 'alpha'],
      failedTargetIds: [],
    });
    expect(Object.isFrozen(aggregates)).toBe(true);
    expect(Object.isFrozen(aggregates.scenarios[0]!.rows)).toBe(true);
  });

  it('invalidates only groups containing a failed target and never publishes partial totals', () => {
    const failure = snapshotScenarioFailure(new Error('bad cell'), COORDINATES);
    const aggregates = buildScenarioAggregates({
      targets,
      scenarioAxis,
      base: [completeBase(0, 'zeta', 100), completeBase(1, 'alpha', 200)],
      cells: [completeCell(0, 'zeta', 110, 10), failedCell(1, 'alpha', failure)],
      reportingCurrency: 'USD',
    });
    const rows = aggregates.scenarios[0]!.rows;
    const unaffected = rows.find((row) => row.group === 'underlying' && row.key === 'MSFT');
    const affected = rows.find((row) => row.group === 'underlying' && row.key === 'AAPL');
    const grand = rows.find((row) => row.group === 'grand-total');

    expect(unaffected).toMatchObject({
      status: 'complete',
      baseValue: 100,
      scenarioValue: 110,
      pnl: 10,
      failedTargetIds: [],
    });
    for (const row of [affected, grand]) {
      expect(row).toMatchObject({
        status: 'incomplete',
        baseValue: null,
        scenarioValue: null,
        pnl: null,
        failedTargetIds: ['alpha'],
      });
    }
  });

  it('refuses grids whose cells do not match scenario-major coordinates', () => {
    expect(() =>
      buildScenarioAggregates({
        targets,
        scenarioAxis,
        base: [completeBase(0, 'zeta', 100), completeBase(1, 'alpha', 200)],
        cells: [completeCell(1, 'alpha', 180, -20), completeCell(0, 'zeta', 110, 10)],
        reportingCurrency: 'USD',
      }),
    ).toThrow(/does not match scenarioAxis/);
  });
});
