/**
 * Stage 7A slice 2 — the journey operations are THIN compositions: every `structured` output is the
 * direct function's result verbatim (canonical JSON equality), wire-only restrictions are narrower
 * schemas (a callback field is an unknown key), and every array input is count-safe (`MAX_ROWS`).
 */

import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  QuantError,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import {
  canonicalJsonOf,
  compareAnalysisArtifacts,
  createAnalysisArtifact,
  createMarketSnapshot,
  createScenarioSet,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';
import { resolvedExpiry } from '@totalfinance/core';
import { fees, slippage } from '@totalfinance/backtest';
import { optionsBacktest, type ChainSnapshot } from '@totalfinance/backtest/options';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  monitorPortfolio,
  portfolioPnl,
  portfolioSnapshot,
  portfolioTimeline,
  proposePortfolioRebalance,
  readPortfolioLedgerSnapshot,
  type InvestmentPolicy,
} from '@totalfinance/portfolio';
import {
  discountedCashFlowFromStatements,
  discountedCashFlowSensitivityTable,
} from '@totalfinance/valuation';
import {
  runScenarios,
  scenarioPortfolioBinding,
  scenarioTarget,
  scenarioTargetsFromPortfolio,
} from '@totalfinance/scenarios';
import { eventStudy, rankUniverse, scoreUniverse, screenUniverse } from '@totalfinance/research';
import {
  MAX_ROWS,
  OPERATION_BUDGETS,
  backtestPack,
  createMemoryArtifactStore,
  createOperationRegistry,
  journeyOperations,
  journeyPacks,
  jsonSafe,
  researchPack,
  runOperation,
} from '@totalfinance/workflows';

const codeOf = (thunk: () => unknown): string | undefined => {
  try {
    thunk();
    return undefined;
  } catch (error) {
    return error instanceof QuantError ? error.code : `not-a-QuantError: ${String(error)}`;
  }
};

const operation = (id: string) => {
  const found = [...journeyOperations(), ...backtestPack().operations].find(
    (candidate) => candidate.id === id,
  );
  if (!found) throw new Error(`no journey operation ${id}`);
  return found;
};

/** Canonical JSON of a direct result and of an operation's structured output must be byte-identical. */
const canonical = (value: unknown): string => canonicalJsonOf(jsonSafe(value) as never);

// ── research fixtures (small, self-contained) ─────────────────────────────────────────────────

const AS_OF = Date.UTC(2026, 0, 31);
const fieldDefinitions = [
  { fieldName: 'momentum', kind: 'numeric' as const, unit: 'decimal ratio' },
  { fieldName: 'value', kind: 'numeric' as const },
  { fieldName: 'sector', kind: 'category' as const },
];
const observations = [
  {
    instrumentId: 'AAA',
    availableTimestampMs: AS_OF - 1,
    fields: { momentum: 0.12, value: 3.1, sector: 'tech' },
  },
  {
    instrumentId: 'BBB',
    availableTimestampMs: AS_OF - 1,
    fields: { momentum: -0.04, value: 1.2, sector: 'energy' },
  },
  {
    instrumentId: 'CCC',
    availableTimestampMs: AS_OF - 1,
    fields: { momentum: 0.31, value: null, sector: 'tech' },
  },
  {
    instrumentId: 'DDD',
    availableTimestampMs: AS_OF - 1,
    fields: { momentum: 0.05, value: 2.2, sector: 'health' },
  },
];
const universe = { universeId: 'fixture', asOf: AS_OF, observations, fieldDefinitions };

describe('the journey packs', () => {
  it('are five opt-in packs of twelve operations, registrable beside the defaults, with ids in the wire grammar', () => {
    const packs = journeyPacks();
    expect(packs.map((pack) => pack.name)).toEqual([
      'portfolio',
      'scenario',
      'research',
      'artifact',
      'valuation',
    ]);
    expect(journeyOperations().map((op) => op.id)).toEqual([
      'totalfinance.portfolio.snapshot',
      'totalfinance.portfolio.explain_pnl',
      'totalfinance.portfolio.analyze',
      'totalfinance.portfolio.rebalance_proposal',
      'totalfinance.scenario.run',
      'totalfinance.research.screen',
      'totalfinance.research.rank',
      'totalfinance.research.score',
      'totalfinance.research.event_study',
      'totalfinance.artifact.read',
      'totalfinance.artifact.compare',
      'totalfinance.valuation.company',
    ]);
    const registry = createOperationRegistry({ packs: [...journeyPacks()] });
    expect(registry.size).toBe(12);
    for (const op of journeyOperations()) {
      expect(op.sideEffect).toBe('none');
      expect(op.authorization).toBe('none');
      expect(op.outputSchema).not.toBeNull();
    }
  });
});

describe('research journey operations equal the direct calls', () => {
  it('screen: the structured output is screenUniverse(...) verbatim', () => {
    const input = {
      ...universe,
      filter: {
        all: [
          { field: 'momentum', operator: 'greaterThan', value: 0 },
          { field: 'sector', operator: 'equals', value: 'tech' },
        ],
      },
      missingValuePolicy: 'exclude' as const,
      orderBy: [{ field: 'momentum', direction: 'descending' as const }],
      limit: 5,
    };
    const direct = screenUniverse(input as never);
    const result = runOperation({ operation: operation('totalfinance.research.screen'), input });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(direct.rows.map((row) => row.instrumentId)).toEqual(['CCC', 'AAA']);
    expect(result.summary).toContain('2 of 4');
  });

  it('rank and score: verbatim, including the assumptions the direct call echoes', () => {
    const rankInput = {
      ...universe,
      rankBy: { field: 'momentum', direction: 'descending' as const },
      tiePolicy: 'competition' as const,
      missingValuePolicy: 'exclude' as const,
    };
    const rank = runOperation({
      operation: operation('totalfinance.research.rank'),
      input: rankInput,
    });
    expect(canonical(rank.structured)).toBe(canonical(rankUniverse(rankInput)));
    const scoreInput = {
      ...universe,
      components: [
        {
          field: 'momentum',
          weight: 2,
          direction: 'higher-is-better' as const,
          standardization: 'z-score' as const,
        },
        {
          field: 'value',
          weight: 1,
          direction: 'lower-is-better' as const,
          standardization: 'percentile-rank' as const,
        },
      ],
      missingValuePolicy: 'renormalize-weights' as const,
    };
    const score = runOperation({
      operation: operation('totalfinance.research.score'),
      input: scoreInput,
    });
    expect(canonical(score.structured)).toBe(canonical(scoreUniverse(scoreInput)));
  });

  it('event study: verbatim under a serializable model; the custom model is not a wire value', () => {
    // Forty consecutive weekdays from Monday 2026-01-05.
    const dates: string[] = [];
    for (let day = 0; dates.length < 40; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 5 + day));
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      dates.push(date.toISOString().slice(0, 10));
    }
    const returnObservations = dates.map((tradingSessionDate, index) => ({
      instrumentId: 'AAA',
      tradingSessionDate,
      simpleReturn: 0.001 * ((index % 7) - 3),
    }));
    const input = {
      events: [
        {
          eventId: 'e1',
          instrumentId: 'AAA',
          eventType: 'earnings',
          announcedTimestampMs: Date.UTC(2026, 1, 16) + 1, // a Monday inside the series
        },
      ],
      returnObservations,
      eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
      estimationWindow: { startTradingSessionOffset: -20, endTradingSessionOffset: -5 },
      expectedReturnModel: { model: 'mean-adjusted' as const },
      overlappingEventPolicy: 'reject' as const,
    };
    const direct = eventStudy(input);
    const result = runOperation({
      operation: operation('totalfinance.research.event_study'),
      input,
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.research.event_study'),
          input: { ...input, expectedReturnModel: { model: 'custom', expectedReturn: () => 0 } },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('a caller predicate is not a wire field: screen refuses customPredicate as an unknown key', () => {
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.research.screen'),
          input: {
            ...universe,
            missingValuePolicy: 'exclude',
            orderBy: [],
            customPredicate: () => true,
          },
        }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('count safety: more than MAX_ROWS observations is refused with the row cap named', () => {
    const many = Array.from({ length: MAX_ROWS + 1 }, (_, index) => ({
      instrumentId: `I${index}`,
      availableTimestampMs: AS_OF - 1,
      fields: { momentum: index / 10_000, value: 1, sector: 'x' },
    }));
    const thunk = () =>
      runOperation({
        operation: operation('totalfinance.research.rank'),
        input: {
          ...universe,
          observations: many,
          rankBy: { field: 'momentum', direction: 'ascending' },
          tiePolicy: 'dense',
          missingValuePolicy: 'exclude',
        },
      });
    expect(codeOf(thunk)).toBe(ErrorCode.InputOutOfRange);
    expect(() => thunk()).toThrow(/observations/);
  });

  it('the research pack is exactly the four research operations', () => {
    expect(researchPack().operations.map((op) => op.id)).toEqual([
      'totalfinance.research.screen',
      'totalfinance.research.rank',
      'totalfinance.research.score',
      'totalfinance.research.event_study',
    ]);
  });
});

// ── scenarios ─────────────────────────────────────────────────────────────────────────────────

const SCENARIO_AS_OF = Date.UTC(2026, 7, 30);
const scenarioSet = () =>
  createScenarioSet({
    name: 'journey',
    scenarios: [
      { name: 'spot up 10%', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
      { name: 'spot down 20%', shocks: [{ factor: 'spot', kind: 'percent', value: -0.2 }] },
    ],
  });
const scenarioMarket = () =>
  createMarketSnapshot({
    asOf: SCENARIO_AS_OF,
    observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
  });
const portfolioState = () =>
  applyPortfolioEvents({
    portfolio: { baseCurrency: 'USD' },
    events: [
      {
        eventId: 'journey-fill',
        schemaVersion: 1,
        eventType: 'trade.fill',
        sourceId: 'journey',
        accountId: 'primary',
        effectiveTimestampMs: SCENARIO_AS_OF - 86_400_000,
        recordedTimestampMs: SCENARIO_AS_OF - 86_400_000,
        event: {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 2,
          pricePerUnit: 100,
          currency: 'USD',
        },
        provenance: {},
      },
    ],
  });
const wireJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The same wire copy typed as a plain record — what a store `put` and a handle field receive. */
const wireRecord = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('scenario.run equals runScenarios over the serializable target kinds', () => {
  it('spot and taylor targets: verbatim', () => {
    const spot = {
      id: 'aapl-stock',
      symbol: 'AAPL',
      quantity: 2,
      currency: 'USD',
      tags: ['equity'],
    };
    const taylor = {
      id: 'aapl-delta-one',
      quantity: 3,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'AAPL',
      baseValuePerUnit: 100,
      greeks: { delta: 1 },
      factors: { spot: { subject: 'AAPL', level: 100 } },
    };
    const direct = runScenarios({
      scenarioSet: scenarioSet(),
      market: scenarioMarket(),
      targets: [scenarioTarget.spot(spot), scenarioTarget.taylor(taylor)],
      reportingCurrency: 'USD',
      options: { failureMode: 'fail-fast', seed: 7 },
    });
    const result = runOperation({
      operation: operation('totalfinance.scenario.run'),
      input: wireJson({
        scenarioSet: scenarioSet(),
        market: scenarioMarket(),
        targets: [
          { kind: 'spot', ...spot },
          { kind: 'taylor', ...taylor },
        ],
        reportingCurrency: 'USD',
        options: { failureMode: 'fail-fast', seed: 7 },
      }),
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(direct.layout.cellCount).toBe(4);
    expect(result.summary).toBe('2 scenarios × 2 targets = 4 cells');
  });

  it('a portfolio target binds through Taylor bindings: verbatim against scenarioTargetsFromPortfolio', () => {
    const binding = {
      id: 'primary-aapl',
      accountId: 'primary',
      instrumentId: 'AAPL',
      baseValuePerUnit: 100,
      greeks: { delta: 1 },
      factors: { spot: { subject: 'AAPL', level: 100 } },
    };
    const direct = runScenarios({
      scenarioSet: scenarioSet(),
      market: scenarioMarket(),
      targets: scenarioTargetsFromPortfolio({
        state: portfolioState(),
        bindings: [scenarioPortfolioBinding.taylor(binding)],
      }),
    });
    const result = runOperation({
      operation: operation('totalfinance.scenario.run'),
      input: wireJson({
        scenarioSet: scenarioSet(),
        market: scenarioMarket(),
        targets: [{ kind: 'portfolio', portfolio: portfolioState(), bindings: [binding] }],
      }),
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
  });

  it('a pricer is not a wire value: an unknown target kind and a resolver option are refused', () => {
    const base = { scenarioSet: wireJson(scenarioSet()), market: wireJson(scenarioMarket()) };
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.scenario.run'),
          input: { ...base, targets: [{ kind: 'fullRevaluation', id: 'x', pricer: () => 0 }] },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.scenario.run'),
          input: {
            ...base,
            targets: [{ kind: 'spot', id: 'a', symbol: 'AAPL', quantity: 1, currency: 'USD' }],
            options: { marketResolvers: [] },
          },
        }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });
});

// ── artifacts ─────────────────────────────────────────────────────────────────────────────────

const artifactOf = (value: number) =>
  createAnalysisArtifact({
    artifactType: 'options.chain-analysis',
    producedBy: { operation: 'analyzeChain' },
    inputs: { parameters: { minOpenInterest: 100 } },
    result: {
      value,
      rows: [1, 2, 3],
      nested: { a: 1 },
      label: 'x'.repeat(300),
      flag: true,
      nothing: null,
      assumptions: { conventionsVersion: 'fixture', method: 'fixture' },
      diagnostics: { warnings: [] },
    },
  });

describe('artifact.read and artifact.compare', () => {
  it('read: identity, producer, tables, warnings, and a bounded preview of the validated artifact', () => {
    const artifact = wireJson(artifactOf(1.5));
    const direct = readAnalysisArtifact({ artifact });
    const result = runOperation({
      operation: operation('totalfinance.artifact.read'),
      input: { artifact },
    });
    expect(result.structured['id']).toBe(direct.artifact.id);
    expect(result.structured['artifactType']).toBe('options.chain-analysis');
    expect(result.structured['producedBy']).toEqual({ operation: 'analyzeChain' });
    expect(result.structured['tables']).toEqual([]);
    expect(result.structured['warnings']).toEqual([]);
    const preview = result.structured['preview'] as {
      keys: string[];
      fields: Record<string, unknown>;
      truncated: boolean;
    };
    expect(preview.truncated).toBe(false);
    expect(preview.fields['value']).toBe(1.5);
    expect(preview.fields['rows']).toEqual({ array: true, length: 3 });
    expect(preview.fields['nested']).toEqual({ object: true, keys: 1 });
    expect((preview.fields['label'] as string).length).toBe(257);
    expect(preview.fields['flag']).toBe(true);
    expect(preview.fields['nothing']).toBeNull();
    // A tampered artifact is refused by the read door, exactly as the direct call refuses it.
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.artifact.read'),
          input: { artifact: { ...artifact, result: { ...artifact.result, value: 2 } } },
        }),
      ),
    ).toBe(ErrorCode.ArtifactIdMismatch);
  });

  it('compare: verbatim, with and without a tolerance', () => {
    const baseline = wireJson(artifactOf(1.5));
    const candidate = wireJson(artifactOf(1.5005));
    const direct = compareAnalysisArtifacts({
      baseline: readAnalysisArtifact({ artifact: baseline }).artifact,
      candidate: readAnalysisArtifact({ artifact: candidate }).artifact,
      tolerance: { absolute: 0.001, relative: 0 },
    });
    const result = runOperation({
      operation: operation('totalfinance.artifact.compare'),
      input: { baseline, candidate, tolerance: { absolute: 0.001, relative: 0 } },
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(direct.withinTolerance).toBe(true);
    expect(result.summary).toContain('within tolerance');
    const plain = runOperation({
      operation: operation('totalfinance.artifact.compare'),
      input: { baseline, candidate },
    });
    expect((plain.structured as { withinTolerance: unknown }).withinTolerance).toBeNull();
  });
});

// ── portfolio ─────────────────────────────────────────────────────────────────────────────────

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId: 'journey',
    accountId: 'main',
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
  };
}
const ledgerEvents = () => [
  envelope('dep-1', Date.UTC(2026, 0, 1, 15), {
    eventType: 'cash.deposit',
    amount: 100_000,
    currency: 'USD',
  }),
  envelope('fill-1', Date.UTC(2026, 0, 10, 15), {
    eventType: 'trade.fill',
    instrumentId: 'AAPL',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 150,
    currency: 'USD',
  }),
  envelope('dep-2', Date.UTC(2026, 1, 1, 12), {
    eventType: 'cash.deposit',
    amount: 20_000,
    currency: 'USD',
  }),
  envelope('wd-1', Date.UTC(2026, 2, 1, 12), {
    eventType: 'cash.withdrawal',
    amount: 5_000,
    currency: 'USD',
  }),
];
const ledger = () =>
  createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: ledgerEvents() as never,
  });
const market = (asOf: string, applePrice: number) =>
  createMarketSnapshot({
    asOf,
    observations: { spots: { AAPL: { price: applePrice, currency: 'USD' } } },
  });
const marks = () => [
  { valuationDate: '2026-01-02', market: market('2026-01-02', 150) },
  { valuationDate: '2026-02-01', market: market('2026-02-01', 160) },
  { valuationDate: '2026-03-01', market: market('2026-03-01', 155) },
  { valuationDate: '2026-04-01', market: market('2026-04-01', 162) },
];
const policy = (): InvestmentPolicy => ({
  targets: [
    { group: { instrumentId: 'AAPL' }, weight: 0.2 },
    { group: { assetClass: 'cash' }, weight: 0.8 },
  ],
  driftBand: 0.03,
  minimumCash: 10_000,
  limits: { maximumPositionWeight: 0.25, maximumDrawdown: 0.2, maximumGrossLeverage: 1.5 },
});

describe('portfolio journey operations equal the direct calls', () => {
  it('snapshot: from the ledger envelope and from a PortfolioState, both verbatim', () => {
    const asOf = '2026-03-01T00:00:00Z';
    const direct = portfolioSnapshot({
      portfolio: ledger().state,
      asOf,
      market: market(asOf, 155),
    });
    const fromEnvelope = runOperation({
      operation: operation('totalfinance.portfolio.snapshot'),
      input: wireJson({ portfolio: ledger().toJSON(), asOf, market: market(asOf, 155) }),
    });
    const fromState = runOperation({
      operation: operation('totalfinance.portfolio.snapshot'),
      input: wireJson({ portfolio: ledger().state, asOf, market: market(asOf, 155) }),
    });
    expect(canonical(fromEnvelope.structured)).toBe(canonical(direct));
    expect(canonical(fromState.structured)).toBe(canonical(direct));
    expect(fromEnvelope.summary).toContain(`NAV ${direct.netAssetValue.toFixed(2)} USD`);
    // A tampered envelope is refused by the read door, exactly as the direct call refuses it.
    const tampered = { ...wireJson(ledger().toJSON()), lotRelief: 'lifo' };
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.portfolio.snapshot'),
          input: { portfolio: tampered, asOf, market: wireJson(market(asOf, 155)) },
        }),
      ),
    ).toBe(codeOf(() => readPortfolioLedgerSnapshot({ snapshot: tampered })));
  });

  it('explain_pnl: verbatim between two marks, with an instrument classification', () => {
    const [, from, to] = marks();
    const instrumentClassification = { AAPL: { assetClass: 'equity', tags: ['tech'] } };
    const direct = portfolioPnl({
      ledger: ledger(),
      from: from!,
      to: to!,
      instrumentClassification,
    });
    const result = runOperation({
      operation: operation('totalfinance.portfolio.explain_pnl'),
      input: wireJson({ ledger: ledger().toJSON(), from, to, instrumentClassification }),
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(result.summary).toContain('2026-02-01 → 2026-03-01');
  });

  it('analyze: snapshot alone; snapshot + timeline; snapshot + timeline + monitor — three verbatim results', () => {
    const asOf = '2026-03-01T00:00:00Z';
    const base = { ledger: ledger().toJSON(), asOf, market: market(asOf, 155) };
    const snapshotOnly = runOperation({
      operation: operation('totalfinance.portfolio.analyze'),
      input: wireJson(base),
    });
    const directSnapshot = portfolioSnapshot({
      portfolio: ledger().state,
      asOf,
      market: market(asOf, 155),
    });
    const structured = snapshotOnly.structured as {
      snapshot: unknown;
      timeline: unknown;
      monitor: unknown;
      assumptions: Record<string, unknown>;
    };
    expect(canonical(structured.snapshot)).toBe(canonical(directSnapshot));
    expect(structured.timeline).toBeNull();
    expect(structured.monitor).toBeNull();
    expect(structured.assumptions['timeline']).toBe('omitted: no marks supplied');

    const full = runOperation({
      operation: operation('totalfinance.portfolio.analyze'),
      input: wireJson({
        ...base,
        marks: marks(),
        monitor: { policy: policy(), previousState: null },
      }),
    });
    const fullStructured = full.structured as { timeline: unknown; monitor: unknown };
    expect(canonical(fullStructured.timeline)).toBe(
      canonical(portfolioTimeline({ ledger: ledger(), valuationMarks: marks() })),
    );
    expect(canonical(fullStructured.monitor)).toBe(
      canonical(
        monitorPortfolio({
          portfolio: ledger().state,
          market: market(asOf, 155),
          asOf,
          policy: policy(),
          previousState: null,
        }),
      ),
    );
    expect(full.summary).toMatch(/marks; \d+ alerts/);
  });

  it('null is not omission on the wire: a null policy is refused, and previousState is required with a monitor', () => {
    const asOf = '2026-03-01T00:00:00Z';
    const base = wireJson({ ledger: ledger().toJSON(), asOf, market: market(asOf, 155) });
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.portfolio.analyze'),
          input: { ...base, monitor: { policy: null, previousState: null } },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        runOperation({
          operation: operation('totalfinance.portfolio.analyze'),
          input: { ...base, monitor: { policy: policy() } },
        }),
      ),
    ).toBe(ErrorCode.InputMissingField);
  });
});

// ── options backtest ──────────────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 0, 5);
const DAY_MS = 86_400_000;
const isoDay = (offsetDays: number): string =>
  new Date(T0 + offsetDays * DAY_MS).toISOString().slice(0, 10);

/** One dated chain snapshot: mid + delta from the BSM pricer, so selection and marking are coherent. */
function chainSnapshot(dayOffset: number, spot: number, expiry: string): ChainSnapshot {
  const date = isoDay(dayOffset);
  // An end-of-day chain is observed at the close (a valuation instant, never a bare date).
  const ts = usEquitySessionInstant(date, 'close');
  const t = (optionExpiryToMs(expiry) - ts) / (DAY_MS * 365);
  const vol = 0.2;
  const rate = 0.04;
  const quotes: ChainSnapshot['quotes'] = [];
  for (let strike = 80; strike <= 120; strike += 5) {
    for (const type of ['call', 'put'] as const) {
      const pricing = {
        type,
        spot,
        strike,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        dividendYield: 0,
        volatility: vol,
      };
      quotes.push({
        contract: {
          underlying: 'XYZ',
          type,
          style: 'european',
          strike,
          expiry,
          ...resolvedExpiry(expiry),
          multiplier: 100,
        },
        timestampMs: ts,
        mid: blackScholesPrice(pricing),
        impliedVolatility: vol,
        greeks: { delta: blackScholesGreeks(pricing).delta },
        underlyingPrice: spot,
      });
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}
/** Weekly snapshots over a flat underlying; the listed expiry (day 56) sits past the last snapshot (day 49), so every quote prices. */
const chains = () => {
  const expiry = isoDay(56);
  return Array.from({ length: 8 }, (_, index) => chainSnapshot(index * 7, 100, expiry));
};

describe('backtest.options_run equals optionsBacktest with declarative cost models', () => {
  it('verbatim, including the marking policy echo and the cost-model labels', () => {
    const shared = {
      initialCapital: 100_000,
      riskFreeRate: 0.04,
      entry: {
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'bullPutSpread' as const,
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.5, daysToExpiry: 21 },
      marking: { volatility: 'current-quote' as const, missingMark: 'entry-volatility' as const },
    };
    const direct = optionsBacktest({
      ...shared,
      chains: chains(),
      commission: fees.bps(2),
      slippage: slippage.spread(0.01),
    });
    const result = runOperation({
      operation: operation('totalfinance.backtest.options_run'),
      input: wireJson({
        ...shared,
        chains: chains(),
        commission: { model: 'bps', bps: 2 },
        slippage: { model: 'spread', spread: 0.01 },
      }),
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(direct.trades.length).toBeGreaterThan(0);
    expect(
      (result.structured as { assumptions: { commission: string } }).assumptions.commission,
    ).toBe('bps(2)');
    expect(result.summary).toContain('current-quote marking');
  });

  it('callbacks are not wire values: a build entry, an exit predicate, and a chain generator are refused', () => {
    const base = wireJson({
      chains: chains(),
      riskFreeRate: 0.04,
      entry: { daysToExpiry: { target: 45 }, structure: 'strangle', select: { shortDelta: 0.2 } },
      exit: { profitTarget: 0.5 },
    });
    const op = operation('totalfinance.backtest.options_run');
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { ...base, entry: { daysToExpiry: { target: 45 }, build: () => null } },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { ...base, exit: { profitTarget: 0.5, when: () => true } },
        }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: {
            ...base,
            chains: (function* () {
              yield base.chains[0];
            })(),
          },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { ...base, commission: { model: 'perTrade', amount: 1 } },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('the operation is job-class and, until the runner lands, does not claim cancellation', () => {
    const op = operation('totalfinance.backtest.options_run');
    expect(op.costClass).toBe('job');
    expect(op.supportsCancellation).toBe(false);
  });
});

// ── handles and the spill ─────────────────────────────────────────────────────────────────────

const CREATED_AT = Date.parse('2026-09-03T14:00:00Z');

describe('handles resolve through the supplied store before validation (Decision 5)', () => {
  it('artifact.compare over two report handles — as uris and as handle objects — equals the inline call', () => {
    const store = createMemoryArtifactStore();
    const baseline = wireRecord(artifactOf(1.5));
    const candidate = wireRecord(artifactOf(1.75));
    const baselineHandle = store.put({
      value: baseline,
      kind: 'report',
      createdTimestampMs: CREATED_AT,
    });
    const candidateHandle = store.put({
      value: candidate,
      kind: 'report',
      createdTimestampMs: CREATED_AT,
    });
    const op = operation('totalfinance.artifact.compare');
    const inline = runOperation({ operation: op, input: { baseline, candidate } });
    const byUri = runOperation({
      operation: op,
      input: { baseline: baselineHandle.uri, candidate: candidateHandle.uri },
      artifacts: store,
      createdTimestampMs: CREATED_AT,
    });
    const byHandle = runOperation({
      operation: op,
      input: { baseline: baselineHandle, candidate: candidateHandle },
      artifacts: store,
      createdTimestampMs: CREATED_AT,
    });
    expect(canonical(byUri.structured)).toBe(canonical(inline.structured));
    expect(canonical(byHandle.structured)).toBe(canonical(inline.structured));
    expect(byUri.identity.inputsHash).toBe(inline.identity.inputsHash); // the RESOLVED input is the identity
  });

  it('a nested path (explain_pnl from.market / to.market) resolves a market handle', () => {
    const store = createMemoryArtifactStore();
    const [, from, to] = marks();
    const fromMarket = store.put({
      value: wireRecord(from!.market),
      kind: 'market',
      createdTimestampMs: CREATED_AT,
    });
    const toMarket = store.put({
      value: wireRecord(to!.market),
      kind: 'market',
      createdTimestampMs: CREATED_AT,
    });
    const op = operation('totalfinance.portfolio.explain_pnl');
    const inline = runOperation({
      operation: op,
      input: wireJson({ ledger: ledger().toJSON(), from, to }),
    });
    const viaHandles = runOperation({
      operation: op,
      input: {
        ledger: wireJson(ledger().toJSON()),
        from: { valuationDate: from!.valuationDate, market: fromMarket.uri },
        to: { valuationDate: to!.valuationDate, market: toMarket },
      },
      artifacts: store,
      createdTimestampMs: CREATED_AT,
    });
    expect(canonical(viaHandles.structured)).toBe(canonical(inline.structured));
  });

  it('refuses a missing store, an unknown uri, a job handle, and a store whose kind disagrees with the uri', () => {
    const store = createMemoryArtifactStore();
    const baseline = wireRecord(artifactOf(1.5));
    const handle = store.put({ value: baseline, kind: 'report', createdTimestampMs: CREATED_AT });
    const op = operation('totalfinance.artifact.compare');
    expect(
      codeOf(() =>
        runOperation({ operation: op, input: { baseline: handle.uri, candidate: baseline } }),
      ),
    ).toBe(ErrorCode.OperationHandleStoreMissing);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { baseline: 'totalfinance://reports/sha256:missing', candidate: baseline },
          artifacts: store,
          createdTimestampMs: CREATED_AT,
        }),
      ),
    ).toBe(ErrorCode.OperationHandleUnknown);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { baseline: 'totalfinance://jobs/job-1', candidate: baseline },
          artifacts: store,
          createdTimestampMs: CREATED_AT,
        }),
      ),
    ).toBe(ErrorCode.OperationHandleKindMismatch);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { baseline: 'totalfinance://nowhere/x', candidate: baseline },
          artifacts: store,
          createdTimestampMs: CREATED_AT,
        }),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    // A reader that answers a markets uri with a report handle is a broken store, not data.
    const lying = {
      get: () => ({ handle, value: baseline }),
      list: () => [handle],
    };
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { baseline: 'totalfinance://markets/sha256:abc', candidate: baseline },
          artifacts: lying,
        }),
      ),
    ).toBe(ErrorCode.OperationHandleKindMismatch);
    // A resolved value that is the wrong envelope for its field is the schema's own refusal.
    const marketHandle = store.put({
      value: wireRecord(marks()[0]!.market),
      kind: 'market',
      createdTimestampMs: CREATED_AT,
    });
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: { baseline: marketHandle.uri, candidate: baseline },
          artifacts: store,
          createdTimestampMs: CREATED_AT,
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
  });
});

describe('a large result spills to a writable store with a bounded preview — never a silent truncation', () => {
  const input = () =>
    wireJson({
      scenarioSet: scenarioSet(),
      market: scenarioMarket(),
      targets: [{ kind: 'spot', id: 'aapl', symbol: 'AAPL', quantity: 2, currency: 'USD' }],
    });

  it('spills above inlineResultBytes and stays inline below it; the default threshold is 256 KiB', () => {
    const store = createMemoryArtifactStore();
    const op = operation('totalfinance.scenario.run');
    const inline = runOperation({ operation: op, input: input() });
    const spilled = runOperation({
      operation: op,
      input: input(),
      artifacts: store,
      createdTimestampMs: CREATED_AT,
      inlineResultBytes: 256,
      requestId: 'req-1',
    });
    const structured = spilled.structured as {
      spilled: boolean;
      handle: { uri: string; kind: string; provenance: Record<string, unknown> };
      preview: { keys: string[]; truncated: boolean };
    };
    expect(structured.spilled).toBe(true);
    expect(structured.handle.kind).toBe('report');
    expect(structured.handle.provenance).toEqual({ requestId: 'req-1' });
    expect(structured.preview.keys).toEqual(Object.keys(inline.structured));
    expect(spilled.artifacts).toEqual([structured.handle]);
    expect(spilled.identity.artifactIds).toEqual([structured.handle.uri]);
    expect(canonical(store.get(structured.handle.uri)?.value)).toBe(canonical(inline.structured));
    expect(spilled.diagnostics.status).toBe('complete');
    // Below the threshold — or with no writable store — the result stays inline.
    const kept = runOperation({
      operation: op,
      input: input(),
      artifacts: store,
      createdTimestampMs: CREATED_AT,
    });
    expect(canonical(kept.structured)).toBe(canonical(inline.structured));
    expect(OPERATION_BUDGETS.inlineResultBytes).toEqual({ default: 262_144, maximum: 16_777_216 });
  });

  it('a writable store needs the caller clock; a threshold needs a writable store; a reader needs neither', () => {
    const op = operation('totalfinance.scenario.run');
    const store = createMemoryArtifactStore();
    expect(codeOf(() => runOperation({ operation: op, input: input(), artifacts: store }))).toBe(
      ErrorCode.InputMissingField,
    );
    const reader = { get: store.get, list: store.list };
    expect(
      codeOf(() =>
        runOperation({ operation: op, input: input(), artifacts: reader, inlineResultBytes: 1 }),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    expect(() => runOperation({ operation: op, input: input(), artifacts: reader })).not.toThrow();
    expect(
      codeOf(() =>
        runOperation({ operation: op, input: input(), artifacts: store, createdTimestampMs: 1.5 }),
      ),
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      codeOf(() =>
        runOperation({
          operation: op,
          input: input(),
          artifacts: store,
          createdTimestampMs: CREATED_AT,
          inlineResultBytes: 0,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        runOperation({ operation: op, input: input(), artifacts: { ...reader, put: 1 } as never }),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });
});

// ── Stage 4.7 slice 2: the two remaining flagship operations equal their direct calls ────────

describe('the rebalance proposal and the company valuation equal the direct calls', () => {
  it('rebalance_proposal: proposePortfolioRebalance(...) over the folded ledger, verbatim', () => {
    const snapshot = ledger().toJSON();
    const asOf = '2026-03-01T00:00:00Z';
    const input = {
      ledger: snapshot,
      asOf,
      market: market(asOf, 155),
      policy: policy(),
      scope: 'to-target' as const,
    };
    const direct = proposePortfolioRebalance({
      portfolio: readPortfolioLedgerSnapshot({ snapshot }).ledger.state,
      asOf,
      market: market(asOf, 155),
      policy: policy(),
      scope: 'to-target',
    });
    const result = runOperation({
      operation: operation('totalfinance.portfolio.rebalance_proposal'),
      input,
    });
    expect(canonical(result.structured)).toBe(canonical(direct));
    expect(result.summary).toContain('proposed');
    expect(operation('totalfinance.portfolio.rebalance_proposal').sideEffect).toBe('none');
  });

  it('valuation.company: discountedCashFlowFromStatements(...) verbatim, and the sensitivity table over the same flows', () => {
    const period = {
      periodEndDate: '2025-12-31',
      fiscalYear: 2025,
      periodType: 'year' as const,
      availableTimestampMs: Date.UTC(2026, 1, 23),
      currency: 'USD',
      monetaryScale: 1 as const,
    };
    const projection = {
      baseStatements: {
        income: { period, revenue: 1_000, operatingIncome: 180, netIncome: 132 },
        balance: {
          period,
          cashAndCashEquivalents: 150,
          accountsReceivable: 100,
          inventory: 75,
          accountsPayable: 50,
          propertyPlantEquipmentNet: 450,
          totalAssets: 1_250,
          totalDebt: 280,
          totalLiabilities: 560,
          totalEquity: 690,
        },
        cashFlow: {
          period,
          operatingCashFlow: 170,
          investingCashFlow: -100,
          financingCashFlow: -40,
        },
      },
      periods: [
        {
          periodLabel: 'FY2026',
          revenue: { amount: 1_100 },
          operatingMargin: 0.2,
          taxRate: 0.25,
          interestExpense: 20,
          depreciationAndAmortization: { amount: 50 },
          capitalExpenditure: { amount: 80 },
          accountsReceivable: { amount: 110 },
          inventory: { amount: 80 },
          accountsPayable: { amount: 55 },
          netBorrowing: 0,
          dividendsPaid: 30,
        },
        {
          periodLabel: 'FY2027',
          revenue: { growthRate: 0.1 },
          operatingMargin: 0.21,
          taxRate: 0.25,
          interestExpense: 20,
          depreciationAndAmortization: { amount: 55 },
          capitalExpenditure: { amount: 85 },
          accountsReceivable: { fractionOfRevenue: 0.1 },
          inventory: { fractionOfRevenue: 0.075 },
          accountsPayable: { fractionOfRevenue: 0.05 },
          netBorrowing: 25,
          dividendsPaid: 35,
        },
      ],
    };
    const valuation = {
      valuationBasis: 'firm' as const,
      valuationDate: '2025-12-31',
      currency: 'USD',
      annualDiscountRate: 0.09,
      compounding: 'annual' as const,
      terminalValueMethod: {
        method: 'exit-multiple' as const,
        terminalMetricAmount: 300,
        exitMultiple: 8,
      },
    };
    const sensitivity = {
      rowAxis: { variable: 'annual-discount-rate' as const, values: [0.08, 0.09, 0.1] },
      columnAxis: { variable: 'exit-multiple' as const, values: [7, 8, 9] },
    };
    const direct = discountedCashFlowFromStatements({ projection, valuation } as never);
    const table = discountedCashFlowSensitivityTable({
      discountedCashFlowInput: {
        ...valuation,
        projectedCashFlows: direct.projection.statements.map((row, index) => ({
          timeYears: index + 1,
          amount: row.freeCashFlowToFirm,
        })),
      },
      ...sensitivity,
    });
    const result = runOperation({
      operation: operation('totalfinance.valuation.company'),
      input: { projection, valuation, sensitivity },
    });
    const structured = result.structured as {
      projection: unknown;
      cashFlowsUsed: string;
      valuation: unknown;
      sensitivity: unknown;
    };
    expect(canonical(structured.projection)).toBe(canonical(direct.projection));
    expect(structured.cashFlowsUsed).toBe('freeCashFlowToFirm');
    expect(canonical(structured.valuation)).toBe(canonical(direct.valuation));
    expect(canonical(structured.sensitivity)).toBe(canonical(table));
    expect(result.summary).toContain('enterprise value');
    // without a sensitivity request the table is null and the assumptions say so
    const bare = runOperation({
      operation: operation('totalfinance.valuation.company'),
      input: { projection, valuation },
    });
    expect((bare.structured as { sensitivity: unknown }).sensitivity).toBeNull();
  });
});
