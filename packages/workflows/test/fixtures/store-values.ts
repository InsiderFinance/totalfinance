import { contentHash } from '@totalfinance/core/artifacts';
import type { AuthorizationGrant, ExecutionJournalEvent } from '@totalfinance/portfolio/trade';
import type { JobRecord } from '@totalfinance/workflows';

export const CREATED = Date.parse('2026-09-06T12:00:00Z');
export const JOURNAL = 'shared:journal';

export function event(eventId: string, journalId = JOURNAL): ExecutionJournalEvent {
  return {
    eventId,
    journalId,
    orderId: eventId,
    planHash: 'plan',
    eventType: 'proposed',
    timestampMs: 1_000,
    detail: {},
    sourceId: 'shared',
    provenance: {},
  };
}

export function grant(id: string): AuthorizationGrant {
  const body: Omit<AuthorizationGrant, 'contentHash'> = {
    kind: 'totalfinance.authorization-grant',
    schemaVersion: 1,
    grantId: id,
    planHash: 'plan',
    preflightHash: 'preflight',
    portfolioHash: 'portfolio',
    marketHash: 'market',
    marketAsOf: 1_000,
    marketMaximumAgeMs: 60_000,
    mode: 'paper',
    accountId: 'main',
    baseCurrency: 'USD',
    orderIds: ['order'],
    comboIds: [],
    variance: { maximumQuantityRatio: 0, maximumNotionalRatio: 0, maximumSlippageBps: 0 },
    issuedAt: 1_000,
    expiresAt: 61_000,
    approvedBy: 'approver',
    requiredScope: null,
    idempotencyKeys: [id],
  };
  return { ...body, contentHash: contentHash(body) };
}

export function job(): JobRecord {
  return {
    id: 'job-1',
    operation: { id: 'test', version: '1' },
    state: 'running',
    progress: null,
    inputsHash: 'input',
    seed: null,
    submittedAt: new Date(CREATED).toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    usage: { elapsedMs: null },
  };
}
