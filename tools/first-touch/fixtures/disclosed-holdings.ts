import type {
  CompareDisclosedHoldingsInput,
  DisclosedHolding,
  DisclosedHoldingsSnapshot,
} from '@totalfinance/portfolio/disclosed-holdings';
import type { FixtureThunk } from '../inputs.js';

export function disclosedHolding(
  id = 'A',
  quantity = '10',
  reportedValue = '100',
): DisclosedHolding {
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
    otherManagerIds: [],
    evidenceIds: [`evidence-${id}`],
    reviewReasons: [],
  };
}

export function disclosedSnapshot(
  periodEnd: string,
  holdings: DisclosedHolding[],
): DisclosedHoldingsSnapshot {
  return {
    managerId: 'manager-1',
    periodEnd,
    reportIds: [`report-${periodEnd}`],
    evidenceIds: [`source-${periodEnd}`],
    reportComplete: true,
    mappingComplete: true,
    comparisonEligible: true,
    reviewReasons: [],
    holdings,
  };
}

export function disclosedInput(): CompareDisclosedHoldingsInput {
  return {
    baseline: disclosedSnapshot('2026-03-31', [disclosedHolding()]),
    current: disclosedSnapshot('2026-06-30', [disclosedHolding('A', '12', '150')]),
    comparisonMode: 'reported-period-change',
    policy: {
      supportedProfile: 'common-stock-shares-v1',
      discretionPolicy: 'sole-without-other-managers',
      ratioDecimalPlaces: 12,
    },
  };
}

export const DISCLOSED_HOLDINGS_FIXTURES: Record<string, FixtureThunk> = {
  'portfolio.compareDisclosedHoldings': () => [disclosedInput()],
};
