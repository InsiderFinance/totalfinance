/**
 * FC4 — first-touch fixtures for the `@totalfinance/performance` flow-aware analyses. Thunks build
 * FRESH inputs per call; probes mutate what they are given. Flows are dated on valuation dates so
 * the canonical fixtures exercise the mark-first attribution path rather than the gap path — the
 * gap behaviors are covered by the package tests.
 */

import { type FixtureThunk } from '../inputs.js';

const valuations = (): unknown[] => [
  { valuationDate: '2024-01-01', netAssetValue: 1_000 },
  { valuationDate: '2024-02-01', netAssetValue: 1_150 },
  { valuationDate: '2024-03-01', netAssetValue: 1_120 },
];

const flowsOnValuationDates = (): unknown[] => [
  { cashFlowDate: '2024-02-01', amount: 100, label: 'february deposit' },
];

export const PERFORMANCE_FLOW_AWARE_FIXTURES: Record<string, FixtureThunk> = {
  'performance.timeWeightedReturn': () => [
    {
      valuations: valuations(),
      externalCashFlows: flowsOnValuationDates(),
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    },
  ],
  'performance.moneyWeightedReturn': () => [
    {
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-07-01', netAssetValue: 1_180 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-03-01', amount: 100, label: 'march deposit' }],
    },
  ],
  'performance.modifiedDietzReturn': () => [
    {
      valuations: [
        { valuationDate: '2024-01-01', netAssetValue: 1_000 },
        { valuationDate: '2024-03-31', netAssetValue: 1_180 },
      ],
      externalCashFlows: [{ cashFlowDate: '2024-02-15', amount: 100 }],
    },
  ],
  'performance.linkSubperiodReturns': () => [
    { subperiodReturns: [0.02, -0.01, 0.015], linking: 'geometric' },
  ],
  'performance.segmentExternalFlows': () => [
    {
      externalCashFlows: [
        { cashFlowDate: '2024-01-05', amount: 1_000, accountId: 'brokerage' },
        { cashFlowDate: '2024-02-05', amount: -400, accountId: 'brokerage' },
        { cashFlowDate: '2024-02-05', amount: 400, accountId: 'retirement' },
      ],
    },
  ],
  'performance.portfolioReturnIndex': () => [
    {
      valuations: valuations(),
      externalCashFlows: flowsOnValuationDates(),
      baseValue: 100,
    },
  ],
  'performance.benchmarkRelativeTimeline': () => [
    {
      portfolioIndex: [
        { date: '2024-01-01', indexValue: 100 },
        { date: '2024-02-01', indexValue: 104 },
        { date: '2024-03-01', indexValue: 103 },
      ],
      benchmarkReturns: [
        { date: '2024-02-01', simpleReturn: 0.02 },
        { date: '2024-03-01', simpleReturn: 0.005 },
      ],
      benchmarkBasis: 'total-return',
    },
  ],
  'performance.contributionByGroup': () => [
    {
      groupReturns: [
        { groupLabel: 'equities', weight: 0.6, simpleReturn: 0.02 },
        { groupLabel: 'bonds', weight: 0.4, simpleReturn: 0.005 },
      ],
    },
  ],
};
