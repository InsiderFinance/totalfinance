import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, ErrorCode, isQuantError, type Computed } from '@totalfinance/core';
import type { Pricer } from '@totalfinance/core/pricing';
import {
  applyPortfolioEvents,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type PortfolioState,
} from '@totalfinance/portfolio';
import { scenarioPortfolioBinding, scenarioTargetsFromPortfolio } from '../src/portfolio.js';
import { validateScenarioTarget } from '../src/targets.js';

interface TestInstrument {
  readonly symbol: string;
}

function testPricer(calls: string[]): Pricer<TestInstrument> {
  return {
    name: 'test.portfolio-binding',
    version: '1.0.0',
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports(instrument) {
      calls.push(`supports:${instrument.symbol}`);
      return true;
    },
    requirements(instrument) {
      calls.push(`requirements:${instrument.symbol}`);
      return [{ kind: 'spot', symbol: instrument.symbol }];
    },
    price({ instrument }) {
      calls.push(`price:${instrument.symbol}`);
      return {
        value: 100,
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      } satisfies Computed<number>;
    },
  };
}

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
): PortfolioEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event.eventType,
    sourceId: 'scenario-portfolio-test',
    accountId,
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
  };
}

function fill(
  eventId: string,
  sequence: number,
  accountId: string,
  instrumentId: string,
  quantity: number,
  currency: string,
  options: {
    readonly contractMultiplier?: number;
    readonly contract?: Extract<PortfolioEvent, { eventType: 'trade.fill' }>['contract'];
  } = {},
): PortfolioEventEnvelope {
  return envelope(eventId, Date.UTC(2026, 0, sequence, 15), accountId, {
    eventType: 'trade.fill',
    instrumentId,
    side: quantity > 0 ? 'buy' : 'sell',
    quantity: Math.abs(quantity),
    pricePerUnit: 10,
    currency,
    ...(options.contractMultiplier !== undefined
      ? { contractMultiplier: options.contractMultiplier }
      : {}),
    ...(options.contract !== undefined ? { contract: options.contract } : {}),
  });
}

function portfolioState(): PortfolioState {
  return applyPortfolioEvents({
    portfolio: { baseCurrency: 'USD' },
    events: [
      // Deliberately reverse lexical account/instrument order. The adapter owns deterministic
      // account-then-instrument ordering rather than inheriting insertion order.
      fill('fill-msft', 2, 'zeta', 'MSFT', 3, 'USD'),
      fill('fill-sap', 3, 'alpha', 'SAP', 5, 'EUR'),
      fill('fill-call', 4, 'alpha', 'AAPL-CALL', 2, 'USD', {
        contractMultiplier: 100,
        contract: {
          kind: 'option',
          underlyingInstrumentId: 'AAPL',
          type: 'call',
          strikePricePerUnit: 200,
          expiryTimestampMs: Date.UTC(2026, 5, 19, 20),
        },
      }),
    ],
  });
}

function fullBinding(
  calls: string[],
  overrides: Partial<{
    id: string;
    accountId: string;
    instrumentId: string;
    symbol: string;
  }> = {},
) {
  const id = overrides.id ?? 'target-call';
  const accountId = overrides.accountId ?? 'alpha';
  const instrumentId = overrides.instrumentId ?? 'AAPL-CALL';
  const symbol = overrides.symbol ?? 'AAPL';
  return scenarioPortfolioBinding.fullRevaluation({
    id,
    accountId,
    instrumentId,
    instrument: { symbol },
    instrumentDescriptor: { kind: 'test-instrument', symbol },
    pricer: testPricer(calls),
    strategy: 'covered-call',
    book: 'household',
    tags: ['long-term'],
  });
}

function taylorBinding(
  overrides: Partial<{ id: string; accountId: string; instrumentId: string }> = {},
) {
  return scenarioPortfolioBinding.taylor({
    id: overrides.id ?? 'target-sap',
    accountId: overrides.accountId ?? 'alpha',
    instrumentId: overrides.instrumentId ?? 'SAP',
    baseValuePerUnit: 215,
    greeks: { delta: 0.8, gamma: 0.01 },
    factors: { spot: { subject: 'SAP', level: 215 } },
    strategy: 'international-equity',
    tags: ['equity'],
  });
}

function msftBinding(calls: string[], id = 'target-msft') {
  return fullBinding(calls, {
    id,
    accountId: 'zeta',
    instrumentId: 'MSFT',
    symbol: 'MSFT',
  });
}

function expectCode(run: () => unknown, code: string): unknown {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${code}`).toBeDefined();
  expect(isQuantError(thrown, code)).toBe(true);
  return thrown;
}

describe('durable portfolio scenario bindings', () => {
  it('enforces tag and exact-binding counts before visiting oversized array slots', () => {
    let reads = 0;
    const tags = new Array(129);
    Object.defineProperty(tags, '0', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('must not read an oversized tag slot');
      },
    });
    expect(() =>
      scenarioPortfolioBinding.fullRevaluation({
        id: 'oversized-tags',
        accountId: 'alpha',
        instrumentId: 'AAPL',
        instrument: { symbol: 'AAPL' },
        pricer: testPricer([]),
        tags,
      }),
    ).toThrow(/at most 128 tags/);

    const bindings = new Array(4);
    Object.defineProperty(bindings, '0', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('must not read a count-mismatched binding slot');
      },
    });
    expect(() =>
      scenarioTargetsFromPortfolio({
        state: portfolioState(),
        bindings,
      }),
    ).toThrow(/exactly one binding.*3 open positions.*received 4/);
    expect(reads).toBe(0);
  });

  it('captures opaque full-revaluation behavior without invoking or freezing caller values', () => {
    const calls: string[] = [];
    const instrument: TestInstrument = { symbol: 'AAPL' };
    const pricer = testPricer(calls);
    const descriptor = { kind: 'equity-option', symbol: 'AAPL' };
    const tags = ['option'];

    const binding = scenarioPortfolioBinding.fullRevaluation({
      id: 'call',
      accountId: 'alpha',
      instrumentId: 'AAPL-CALL',
      instrument,
      instrumentDescriptor: descriptor,
      pricer,
      tags,
    });

    expect(calls).toEqual([]);
    expect(binding.valuationMethod).toBe('full-revaluation');
    if (binding.valuationMethod !== 'full-revaluation') {
      throw new Error('fullRevaluation must return a full-revaluation binding');
    }
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.instrumentDescriptor)).toBe(true);
    expect(Object.isFrozen(binding.pricer)).toBe(true);
    expect(Object.getOwnPropertySymbols(binding)).toHaveLength(2);
    expect(Object.keys(binding)).not.toContain('instrument');
    expect(Object.keys(binding)).not.toContain('behavior');
    expect(Object.isFrozen(instrument)).toBe(false);
    expect(Object.isFrozen(pricer)).toBe(false);
    expect(Object.isFrozen(pricer.capabilities)).toBe(false);
    expect(Object.isFrozen(descriptor)).toBe(false);
    expect(Object.isFrozen(tags)).toBe(false);
  });

  it('captures a complete immutable Taylor descriptor', () => {
    const binding = taylorBinding();
    expect(binding).toMatchObject({
      id: 'target-sap',
      accountId: 'alpha',
      instrumentId: 'SAP',
      valuationMethod: 'taylor',
      taylor: {
        baseValuePerUnit: 215,
        sensitivities: { delta: 0.8, gamma: 0.01 },
        factors: { spot: { subject: 'SAP', level: 215 } },
      },
    });
    expect(binding.valuationMethod).toBe('taylor');
    if (binding.valuationMethod !== 'taylor') {
      throw new Error('taylor must return a Taylor binding');
    }
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.taylor)).toBe(true);
    expect(Object.getOwnPropertySymbols(binding)).toHaveLength(1);
  });

  it('uses detached ledger facts as authority and returns account/instrument lexical order', () => {
    const state = portfolioState();
    const calls: string[] = [];
    const bindings = [msftBinding(calls), taylorBinding(), fullBinding(calls)];

    const targets = scenarioTargetsFromPortfolio({ state, bindings });

    expect(targets.map((target) => target.id)).toEqual([
      'target-call',
      'target-sap',
      'target-msft',
    ]);
    expect(targets[0]).toMatchObject({
      id: 'target-call',
      quantity: 2,
      contractMultiplier: 100,
      currency: 'USD',
      underlying: 'AAPL',
      account: 'alpha',
      strategy: 'covered-call',
      book: 'household',
      tags: ['long-term'],
      valuationMethod: 'full-revaluation',
    });
    expect(targets[1]).toMatchObject({
      id: 'target-sap',
      quantity: 5,
      contractMultiplier: 1,
      currency: 'EUR',
      underlying: 'SAP',
      account: 'alpha',
      valuationMethod: 'taylor',
    });
    expect(targets[2]).toMatchObject({
      id: 'target-msft',
      quantity: 3,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'MSFT',
      account: 'zeta',
    });
    expect(targets.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(targets)).toBe(true);
    expect(calls).toEqual([]);
    expect(validateScenarioTarget(targets[0], 0).binding).not.toBeNull();
    expect(validateScenarioTarget(targets[1], 1).binding).toBeNull();
  });

  it('keeps hostile identifier strings as data rather than object-map control keys', () => {
    const calls: string[] = [];
    const state = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: [fill('hostile-fill', 2, '__proto__', 'constructor', 1, 'USD')],
    });
    const binding = fullBinding(calls, {
      id: 'toString',
      accountId: '__proto__',
      instrumentId: 'constructor',
      symbol: 'HOSTILE',
    });

    const targets = scenarioTargetsFromPortfolio({ state, bindings: [binding] });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: 'toString',
      account: '__proto__',
      underlying: 'constructor',
    });
    expect(calls).toEqual([]);
  });

  it('rejects binding attempts to override ledger-owned facts', () => {
    const calls: string[] = [];
    expectCode(
      () =>
        scenarioPortfolioBinding.fullRevaluation({
          id: 'bad',
          accountId: 'alpha',
          instrumentId: 'AAPL-CALL',
          instrument: { symbol: 'AAPL' },
          instrumentDescriptor: { symbol: 'AAPL' },
          pricer: testPricer(calls),
          quantity: 999,
          currency: 'CAD',
        } as never),
      ErrorCode.InputUnknownField,
    );
    expect(calls).toEqual([]);
  });

  it('rejects duplicate bindings for one open position', () => {
    const calls: string[] = [];
    const state = portfolioState();
    expectCode(
      () =>
        scenarioTargetsFromPortfolio({
          state,
          bindings: [
            fullBinding(calls),
            fullBinding(calls, { id: 'duplicate-position' }),
            taylorBinding(),
            msftBinding(calls),
          ],
        }),
      ErrorCode.InputOutOfRange,
    );
  });

  it('rejects duplicate target IDs across distinct open positions', () => {
    const calls: string[] = [];
    const state = portfolioState();
    expectCode(
      () =>
        scenarioTargetsFromPortfolio({
          state,
          bindings: [
            fullBinding(calls, { id: 'same' }),
            taylorBinding({ id: 'same' }),
            msftBinding(calls),
          ],
        }),
      ErrorCode.InputOutOfRange,
    );
  });

  it('rejects a binding for an unknown or closed position', () => {
    const calls: string[] = [];
    const state = portfolioState();
    expectCode(
      () =>
        scenarioTargetsFromPortfolio({
          state,
          bindings: [
            fullBinding(calls),
            taylorBinding(),
            msftBinding(calls),
            fullBinding(calls, {
              id: 'unknown',
              accountId: 'alpha',
              instrumentId: 'CLOSED',
            }),
          ],
        }),
      ErrorCode.InputOutOfRange,
    );
  });

  it('rejects a missing binding for any open position', () => {
    const calls: string[] = [];
    const state = portfolioState();
    expectCode(
      () =>
        scenarioTargetsFromPortfolio({
          state,
          bindings: [fullBinding(calls), taylorBinding()],
        }),
      ErrorCode.InputMissingField,
    );
  });

  it('rejects a hand-assembled binding lookalike', () => {
    const calls: string[] = [];
    const state = portfolioState();
    const lookalike = Object.freeze({ ...fullBinding(calls) });
    expectCode(
      () =>
        scenarioTargetsFromPortfolio({
          state,
          bindings: [lookalike as never, taylorBinding(), msftBinding(calls)],
        }),
      ErrorCode.InputWrongType,
    );
  });
});

// Compile-time pair capture: an instrument and a pricer for another instrument cannot enter the
// heterogeneous binding array through one builder call.
interface OtherInstrument {
  readonly cusip: string;
}
declare const testInstrument: TestInstrument;
declare const otherPricer: Pricer<OtherInstrument>;
const rejectMismatchedPortfolioBinding = (): void => {
  scenarioPortfolioBinding.fullRevaluation({
    id: 'bad-pair',
    accountId: 'alpha',
    instrumentId: 'AAPL-CALL',
    instrument: testInstrument,
    // @ts-expect-error — NoInfer keeps the pricer paired with the call's TestInstrument.
    pricer: otherPricer,
  });
};
void rejectMismatchedPortfolioBinding;
