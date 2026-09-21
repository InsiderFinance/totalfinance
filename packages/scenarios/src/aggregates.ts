import { ErrorCode, InputError, PostconditionError, stableSum } from '@totalfinance/core';
import { checkedAdd, scanCanonicalData, deepFreezeDetached } from './internal/data.js';
import type {
  ScenarioAggregateRow,
  ScenarioAxisRow,
  ScenarioBaseAggregateSet,
  ScenarioBaseCell,
  ScenarioCell,
  ScenarioOutcomeAggregateSet,
  ScenarioTargetAxisRow,
} from './types.js';

type AggregateGroup = ScenarioAggregateRow['group'];

const GROUP_ORDER = [
  'target',
  'underlying',
  'strategy',
  'account',
  'book',
  'tag',
  'grand-total',
] as const satisfies readonly AggregateGroup[];

const INCOMPLETE_BASE_REASON =
  'At least one constituent base valuation failed; partial aggregate totals are intentionally omitted.';
const INCOMPLETE_SCENARIO_REASON =
  'At least one constituent scenario valuation failed or was blocked by a base valuation failure; partial aggregate totals are intentionally omitted.';

interface AggregateMembership {
  readonly group: AggregateGroup;
  readonly key: string;
  readonly targetIndexes: readonly number[];
}

type AggregateTargetIdentity = Pick<
  ScenarioTargetAxisRow,
  'targetIndex' | 'id' | 'underlying' | 'strategy' | 'account' | 'book' | 'tags'
>;

export interface BuildScenarioAggregatesInput {
  readonly targets: readonly ScenarioTargetAxisRow[];
  readonly scenarioAxis: readonly ScenarioAxisRow[];
  readonly base: readonly ScenarioBaseCell[];
  /** Flat scenario-major grid: `scenarioIndex * targetCount + targetIndex`. */
  readonly cells: readonly ScenarioCell[];
  readonly reportingCurrency: string;
}

export interface ScenarioAggregates {
  readonly base: ScenarioBaseAggregateSet;
  readonly scenarios: readonly ScenarioOutcomeAggregateSet[];
}

function aggregateShapeError(message: string): never {
  throw new InputError(`buildScenarioAggregates: ${message}`, {
    code: ErrorCode.InputWrongShape,
    context: { function: 'buildScenarioAggregates' },
  });
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addMembership(family: Map<string, number[]>, key: string, targetIndex: number): void {
  const indexes = family.get(key);
  if (indexes === undefined) family.set(key, [targetIndex]);
  else indexes.push(targetIndex);
}

function buildMemberships(
  targetAxis: readonly AggregateTargetIdentity[],
): readonly AggregateMembership[] {
  const families = new Map<AggregateGroup, Map<string, number[]>>();
  for (const group of GROUP_ORDER) families.set(group, new Map());

  for (let targetIndex = 0; targetIndex < targetAxis.length; targetIndex++) {
    const target = targetAxis[targetIndex]!;
    if (target.targetIndex !== targetIndex) {
      aggregateShapeError(
        `targetAxis[${targetIndex}].targetIndex must equal its axis position ${targetIndex}.`,
      );
    }
    addMembership(families.get('target')!, target.id, targetIndex);
    if (target.underlying !== undefined) {
      addMembership(families.get('underlying')!, target.underlying, targetIndex);
    }
    if (target.strategy !== undefined) {
      addMembership(families.get('strategy')!, target.strategy, targetIndex);
    }
    if (target.account !== undefined) {
      addMembership(families.get('account')!, target.account, targetIndex);
    }
    if (target.book !== undefined) {
      addMembership(families.get('book')!, target.book, targetIndex);
    }
    for (const tag of target.tags) addMembership(families.get('tag')!, tag, targetIndex);
    addMembership(families.get('grand-total')!, 'all', targetIndex);
  }

  const memberships: AggregateMembership[] = [];
  for (const group of GROUP_ORDER) {
    const family = families.get(group)!;
    const keys = [...family.keys()].sort(compareKeys);
    for (const key of keys) {
      memberships.push({ group, key, targetIndexes: Object.freeze(family.get(key)!.slice()) });
    }
  }
  return Object.freeze(memberships);
}

const WORST_INCOMPLETE_REASON =
  'At least one constituent scenario valuation failed or was blocked by a base valuation failure; partial aggregate totals are intentionally omitted.';

/**
 * Exact conservative canonical-data reserve for retained aggregate wrappers and worst-case rows.
 * It iterates memberships but never materializes the scenario-by-row product before Barrier B.
 */
export function estimateScenarioAggregateWork(input: {
  readonly targets: readonly AggregateTargetIdentity[];
  readonly scenarioNames: readonly string[];
  readonly reportingCurrency: string;
}): number {
  const memberships = buildMemberships(input.targets);
  const rowOptions = {
    functionName: 'runScenarios',
    label: 'aggregate row reserve',
    requireFiniteNumbers: true,
  } as const;
  let rowsWork = 0;
  for (const membership of memberships) {
    const targetIds = membership.targetIndexes.map((index) => input.targets[index]!.id);
    rowsWork = checkedAdd(
      'runScenarios',
      'aggregate row reserve',
      rowsWork,
      scanCanonicalData(
        {
          group: membership.group,
          key: membership.key,
          reportingCurrency: input.reportingCurrency,
          status: 'incomplete',
          baseValue: null,
          scenarioValue: null,
          pnl: null,
          targetIds,
          failedTargetIds: targetIds,
          reason: WORST_INCOMPLETE_REASON,
        },
        rowOptions,
      ),
    );
  }

  const baseSkeleton = {
    kind: 'base',
    scenarioIndex: null,
    scenarioName: null,
    rows: [],
  } as const;
  let total = scanCanonicalData(
    { base: baseSkeleton, scenarios: [] },
    {
      functionName: 'runScenarios',
      label: 'aggregate result reserve',
      requireFiniteNumbers: true,
    },
  );
  total = checkedAdd(
    'runScenarios',
    'base aggregate rows reserve',
    total,
    memberships.length + rowsWork,
  );
  for (let scenarioIndex = 0; scenarioIndex < input.scenarioNames.length; scenarioIndex++) {
    const scenarioSkeleton = {
      kind: 'scenario',
      scenarioIndex,
      scenarioName: input.scenarioNames[scenarioIndex]!,
      rows: [],
    } as const;
    const wrapperWork = scanCanonicalData(scenarioSkeleton, {
      functionName: 'runScenarios',
      label: 'scenario aggregate wrapper reserve',
      requireFiniteNumbers: true,
    });
    total = checkedAdd(
      'runScenarios',
      'scenario aggregate reserve',
      total,
      1 + wrapperWork + memberships.length + rowsWork,
    );
  }
  return total;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PostconditionError(
      `buildScenarioAggregates: successful constituent ${path} must be finite.`,
      {
        code: ErrorCode.PostconditionNonFinite,
        context: { function: 'buildScenarioAggregates', path },
      },
    );
  }
  return value;
}

function finiteSum(values: readonly number[], path: string): number {
  const total = stableSum(values);
  if (!Number.isFinite(total)) {
    throw new PostconditionError(
      `buildScenarioAggregates: ${path} is not representable as a finite aggregate.`,
      {
        code: ErrorCode.PostconditionNonFinite,
        context: { function: 'buildScenarioAggregates', path },
      },
    );
  }
  return total;
}

function targetIdsFor(
  membership: AggregateMembership,
  targetAxis: readonly ScenarioTargetAxisRow[],
): readonly string[] {
  return membership.targetIndexes.map((targetIndex) => targetAxis[targetIndex]!.id);
}

function incompleteRow(
  membership: AggregateMembership,
  targetAxis: readonly ScenarioTargetAxisRow[],
  failedIndexes: ReadonlySet<number>,
  reportingCurrency: string,
  reason: string,
): ScenarioAggregateRow {
  const failedTargetIds = membership.targetIndexes
    .filter((targetIndex) => failedIndexes.has(targetIndex))
    .map((targetIndex) => targetAxis[targetIndex]!.id);
  return {
    group: membership.group,
    key: membership.key,
    reportingCurrency,
    status: 'incomplete',
    baseValue: null,
    scenarioValue: null,
    pnl: null,
    targetIds: targetIdsFor(membership, targetAxis),
    failedTargetIds,
    reason,
  };
}

function buildBaseRows(
  memberships: readonly AggregateMembership[],
  targetAxis: readonly ScenarioTargetAxisRow[],
  base: readonly ScenarioBaseCell[],
  reportingCurrency: string,
): readonly ScenarioAggregateRow[] {
  const failedIndexes = new Set<number>();
  for (let targetIndex = 0; targetIndex < base.length; targetIndex++) {
    const cell = base[targetIndex]!;
    if (cell.targetIndex !== targetIndex || cell.targetId !== targetAxis[targetIndex]!.id) {
      aggregateShapeError(`base[${targetIndex}] does not match targetAxis[${targetIndex}].`);
    }
    if (cell.status !== 'complete') failedIndexes.add(targetIndex);
  }

  return memberships.map((membership) => {
    if (membership.targetIndexes.some((targetIndex) => failedIndexes.has(targetIndex))) {
      return incompleteRow(
        membership,
        targetAxis,
        failedIndexes,
        reportingCurrency,
        INCOMPLETE_BASE_REASON,
      );
    }
    const baseValue = finiteSum(
      membership.targetIndexes.map((targetIndex) =>
        requireFinite(
          base[targetIndex]!.reportingPositionValue,
          `base[${targetIndex}].reportingPositionValue`,
        ),
      ),
      `${membership.group}:${membership.key}.baseValue`,
    );
    return {
      group: membership.group,
      key: membership.key,
      reportingCurrency,
      status: 'complete',
      baseValue,
      scenarioValue: baseValue,
      pnl: 0,
      targetIds: targetIdsFor(membership, targetAxis),
      failedTargetIds: [],
    } satisfies ScenarioAggregateRow;
  });
}

function buildScenarioRows(
  memberships: readonly AggregateMembership[],
  targetAxis: readonly ScenarioTargetAxisRow[],
  base: readonly ScenarioBaseCell[],
  cells: readonly ScenarioCell[],
  reportingCurrency: string,
): readonly ScenarioAggregateRow[] {
  const failedIndexes = new Set<number>();
  for (let targetIndex = 0; targetIndex < targetAxis.length; targetIndex++) {
    if (base[targetIndex]!.status !== 'complete' || cells[targetIndex]!.status !== 'complete') {
      failedIndexes.add(targetIndex);
    }
  }

  return memberships.map((membership) => {
    if (membership.targetIndexes.some((targetIndex) => failedIndexes.has(targetIndex))) {
      return incompleteRow(
        membership,
        targetAxis,
        failedIndexes,
        reportingCurrency,
        INCOMPLETE_SCENARIO_REASON,
      );
    }
    const baseValue = finiteSum(
      membership.targetIndexes.map((targetIndex) =>
        requireFinite(
          base[targetIndex]!.reportingPositionValue,
          `base[${targetIndex}].reportingPositionValue`,
        ),
      ),
      `${membership.group}:${membership.key}.baseValue`,
    );
    const scenarioValue = finiteSum(
      membership.targetIndexes.map((targetIndex) =>
        requireFinite(
          cells[targetIndex]!.reportingPositionValue,
          `scenarioCell[${targetIndex}].reportingPositionValue`,
        ),
      ),
      `${membership.group}:${membership.key}.scenarioValue`,
    );
    const pnl = finiteSum(
      membership.targetIndexes.map((targetIndex) =>
        requireFinite(
          cells[targetIndex]!.reportingPnl,
          `scenarioCell[${targetIndex}].reportingPnl`,
        ),
      ),
      `${membership.group}:${membership.key}.pnl`,
    );
    return {
      group: membership.group,
      key: membership.key,
      reportingCurrency,
      status: 'complete',
      baseValue,
      scenarioValue,
      pnl,
      targetIds: targetIdsFor(membership, targetAxis),
      failedTargetIds: [],
    } satisfies ScenarioAggregateRow;
  });
}

/** Build all deterministic base/scenario aggregate families from the runner's flat result grid. */
export function buildScenarioAggregates(input: BuildScenarioAggregatesInput): ScenarioAggregates {
  const targetCount = input.targets.length;
  if (targetCount === 0) aggregateShapeError('targets must be non-empty.');
  if (input.base.length !== targetCount) {
    aggregateShapeError(`base length ${input.base.length} must equal target count ${targetCount}.`);
  }
  if (input.cells.length !== targetCount * input.scenarioAxis.length) {
    aggregateShapeError(
      `cells length ${input.cells.length} must equal targetCount * scenarioCount (${targetCount * input.scenarioAxis.length}).`,
    );
  }

  const memberships = buildMemberships(input.targets);
  const baseRows = buildBaseRows(memberships, input.targets, input.base, input.reportingCurrency);
  const scenarios: ScenarioOutcomeAggregateSet[] = input.scenarioAxis.map((scenario, axisIndex) => {
    if (scenario.scenarioIndex !== axisIndex) {
      aggregateShapeError(
        `scenarioAxis[${axisIndex}].scenarioIndex must equal its axis position ${axisIndex}.`,
      );
    }
    const offset = axisIndex * targetCount;
    const scenarioCells = input.cells.slice(offset, offset + targetCount);
    for (let targetIndex = 0; targetIndex < targetCount; targetIndex++) {
      const cell = scenarioCells[targetIndex]!;
      if (
        cell.targetIndex !== targetIndex ||
        cell.targetId !== input.targets[targetIndex]!.id ||
        cell.scenarioIndex !== axisIndex ||
        cell.scenarioName !== scenario.name
      ) {
        aggregateShapeError(
          `cells[${offset + targetIndex}] does not match scenarioAxis[${axisIndex}] and targets[${targetIndex}].`,
        );
      }
    }
    return {
      kind: 'scenario',
      scenarioIndex: axisIndex,
      scenarioName: scenario.name,
      rows: buildScenarioRows(
        memberships,
        input.targets,
        input.base,
        scenarioCells,
        input.reportingCurrency,
      ),
    };
  });

  const result: ScenarioAggregates = {
    base: {
      kind: 'base',
      scenarioIndex: null,
      scenarioName: null,
      rows: baseRows,
    },
    scenarios,
  };
  return deepFreezeDetached(result) as ScenarioAggregates;
}
