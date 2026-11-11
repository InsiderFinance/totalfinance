import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOperationRegistry,
  createMemoryArtifactStore,
  portfolioPack,
  tradePack,
  DEFAULT_CAPABILITIES,
  type ArtifactStore,
} from '../src/index.js';
import { createFileArtifactStore } from '../src/local/index.js';

const at = Date.UTC(2026, 0, 5);
const deposit = (i: number) => ({
  eventId: `cash-${i}`,
  schemaVersion: 1,
  eventType: 'cash.deposit',
  sourceId: 'synthetic',
  accountId: 'example',
  effectiveTimestampMs: at + i,
  recordedTimestampMs: at + i,
  event: { eventType: 'cash.deposit', amount: 10, currency: 'USD' },
  provenance: {},
});
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
const registry = () => createOperationRegistry({ packs: [portfolioPack(), tradePack()] });
const run = (artifacts: ArtifactStore, id: string, input: Record<string, unknown>) =>
  registry().run({
    id: `totalfinance.portfolio.${id}`,
    input,
    artifacts,
    createdTimestampMs: at,
    capabilities: [...DEFAULT_CAPABILITIES, 'portfolio:write'],
  });

describe('cold portfolio create/open/inspect journey', () => {
  it.each(['memory', 'file'] as const)(
    'starts empty, writes explicit cash and reopens in a fresh registry/store (%s)',
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'totalfinance-bootstrap-'));
      directories.push(directory);
      const store = () => (kind === 'file' ? createFileArtifactStore({ directory }) : memory);
      const memory = createMemoryArtifactStore();
      const created = run(store(), 'create', {
        portfolioId: 'research',
        baseCurrency: 'USD',
        events: [],
        createdTimestampMs: at,
      });
      expect(created.structured).toMatchObject({
        portfolioId: 'research',
        eventCount: 0,
        lotRelief: 'fifo',
        inspectOperation: 'totalfinance.portfolio.inspect',
      });
      const handle = created.structured['handle'];
      const empty = run(store(), 'inspect', { portfolio: handle, section: 'cash' });
      expect(empty.structured).toMatchObject({ total: 0, rows: [], portfolioId: 'research' });
      const recorded = run(store(), 'record_events', {
        portfolio: handle,
        events: [deposit(0)],
        createdTimestampMs: at,
      });
      const reopened = run(store(), 'inspect', {
        portfolio: recorded.structured['handle'],
        section: 'cash',
      });
      expect(reopened.structured).toMatchObject({
        eventCount: 1,
        total: 1,
        rows: [{ accountId: 'example', currency: 'USD', fields: { totalAmount: 10 } }],
      });
      const filled = run(store(), 'record_events', {
        portfolio: recorded.structured['handle'],
        createdTimestampMs: at,
        events: [
          {
            ...deposit(1),
            eventType: 'trade.fill',
            event: {
              eventType: 'trade.fill',
              instrumentId: 'TEST',
              side: 'buy',
              quantity: 1,
              pricePerUnit: 5,
              currency: 'USD',
            },
          },
        ],
      });
      const positions = run(store(), 'inspect', {
        portfolio: filled.structured['handle'],
        section: 'positions',
      });
      expect(positions.structured).toMatchObject({
        eventCount: 2,
        total: 1,
        rows: [
          {
            accountId: 'example',
            instrumentId: 'TEST',
            fields: {
              quantity: 1,
              currency: 'USD',
              contractMultiplier: 1,
              lots: { array: true, length: 1 },
            },
          },
        ],
      });
      expect(run(store(), 'inspect', { portfolio: handle }).structured['eventCount']).toBe(0);
      expect(
        run(store(), 'create', {
          portfolioId: 'research',
          baseCurrency: 'USD',
          events: [],
          createdTimestampMs: at,
        }).structured['handle'],
      ).toEqual(handle);
    },
  );

  it('teaches the additional inspection pack and capability from a trade-only registry', () => {
    const onlyTrade = createOperationRegistry({ packs: [tradePack()] });
    const description = JSON.stringify(onlyTrade.describe('totalfinance.portfolio.create'));
    expect(description).toContain('portfolioPack');
    expect(description).toContain('both trade and portfolio packs');
    expect(description).toContain('--profile full');
    expect(() => onlyTrade.require('totalfinance.portfolio.inspect')).toThrow();
    const created = onlyTrade.run({
      id: 'totalfinance.portfolio.create',
      input: { portfolioId: 'isolated', baseCurrency: 'USD', events: [], createdTimestampMs: at },
      artifacts: createMemoryArtifactStore(),
      createdTimestampMs: at,
      capabilities: ['portfolio:write'],
    });
    expect(created.summary).toContain('portfolio pack');
    expect(created.summary).toContain('portfolio:read');
  });

  it('returns bounded indexed previews and explicit continuation', () => {
    const artifacts = createMemoryArtifactStore();
    const created = run(artifacts, 'create', {
      portfolioId: 'paged',
      baseCurrency: 'USD',
      events: Array.from({ length: 105 }, (_, i) => deposit(i)),
      createdTimestampMs: at,
    });
    const page = run(artifacts, 'inspect', {
      portfolio: created.structured['handle'],
      section: 'events',
      offset: 100,
      limit: 3,
    });
    expect(page.structured).toMatchObject({ total: 105, offset: 100, limit: 3, nextOffset: 103 });
    expect(page.structured['rows']).toHaveLength(3);
    expect((page.structured['rows'] as unknown[])[0]).toMatchObject({
      fields: { eventId: 'cash-100' },
      event: { fields: { amount: 10 } },
    });
    expect(() =>
      run(artifacts, 'inspect', { portfolio: created.structured['handle'], limit: 101 }),
    ).toThrow(expect.objectContaining({ code: 'input.out_of_range' }));
  });

  it('refuses missing authority/store, invented funding, invalid input and unavailable handles', () => {
    const r = registry();
    expect(() => r.run({ id: 'totalfinance.portfolio.create', input: {} })).toThrow(
      expect.objectContaining({ code: 'operation.capability_missing' }),
    );
    expect(() =>
      r.run({
        id: 'totalfinance.portfolio.create',
        capabilities: ['portfolio:write'],
        input: { portfolioId: 'a', baseCurrency: 'USD', events: [], createdTimestampMs: at },
      }),
    ).toThrow(expect.objectContaining({ code: 'operation.handle_store_missing' }));
    const artifacts = createMemoryArtifactStore();
    for (const input of [
      { portfolioId: 'a', baseCurrency: 'USD', createdTimestampMs: at },
      {
        portfolioId: 'a',
        baseCurrency: 'USD',
        events: [],
        initialCash: 100,
        createdTimestampMs: at,
      },
      { portfolioId: '', baseCurrency: 'USD', events: [], createdTimestampMs: at },
    ])
      expect(() => run(artifacts, 'create', input)).toThrow(
        expect.objectContaining({ name: 'InputError' }),
      );
    expect(() =>
      run(artifacts, 'inspect', {
        portfolio: `totalfinance://portfolios/sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(expect.objectContaining({ name: 'InputError' }));
    expect(() =>
      r.run({ id: 'totalfinance.portfolio.inspect', capabilities: [], input: {} }),
    ).toThrow(expect.objectContaining({ code: 'operation.capability_missing' }));
  });
});
