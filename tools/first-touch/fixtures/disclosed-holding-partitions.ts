import type {
  CompareDisclosedHoldingPartitionsInput,
  DisclosedHoldingPartition,
  DisclosedHoldingPartitionsSnapshot,
} from '@totalfinance/portfolio/disclosed-holding-partitions';
import type { FixtureThunk } from '../inputs.js';

export function partitionHolding(
  id = 'A',
  quantity = '10',
  reportedValue = '100',
): DisclosedHoldingPartition {
  return {
    holdingId: `holding-${id}`,
    issuerId: `issuer-${id}`,
    securityId: `security-${id}`,
    classId: `class-${id}`,
    mappingStatus: 'mapped',
    instrumentType: 'common_stock',
    quantity,
    quantityUnit: 'SH',
    reportedValue,
    valueCurrency: 'USD',
    valueScale: '1',
    putCall: 'none',
    investmentDiscretion: 'SOLE',
    sourceReportId: 'report',
    otherManagerReferences: [],
    evidenceIds: [`evidence-${id}`],
    reviewReasons: [],
  };
}

export function partitionSnapshot(
  periodEnd: string,
  holdings: DisclosedHoldingPartition[],
): DisclosedHoldingPartitionsSnapshot {
  return {
    managerId: 'manager-1',
    periodEnd,
    reportIds: ['report'],
    evidenceIds: [`source-${periodEnd}`],
    reportComplete: true,
    mappingComplete: true,
    comparisonEligible: true,
    reviewReasons: [],
    holdings,
  };
}

export function partitionInput(): CompareDisclosedHoldingPartitionsInput {
  return {
    baseline: partitionSnapshot('2026-03-31', [partitionHolding()]),
    current: partitionSnapshot('2026-06-30', [partitionHolding('A', '12', '150')]),
    comparisonMode: 'reported-period-change',
    policy: {
      supportedProfile: 'common-stock-reported-partitions-v1',
      discretionPolicy: 'reported-partitions-without-cross-manager-netting',
      ratioDecimalPlaces: 12,
    },
  };
}

export const DISCLOSED_HOLDING_PARTITION_FIXTURES: Record<string, FixtureThunk> = {
  'portfolio.compareDisclosedHoldingPartitions': () => [partitionInput()],
};
