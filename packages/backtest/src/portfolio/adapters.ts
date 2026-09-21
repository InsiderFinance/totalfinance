/**
 * The built-in instrument adapters (Stage 4.6, FC8 Decision 6a): how each kind marks, which
 * lifecycle facts it emits as FC7 event payloads, and how its fills settle. Every adapter is pure
 * and deterministic; `assertInstrumentAdapterConformance` proves a caller's own.
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isoDateToEpochMs,
  requireArgumentObject,
  type EpochMs,
} from '@totalfinance/core';
import { requireCouponTerms, requireInstrumentSpecification } from './validate.js';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { bonds } from '@totalfinance/fixed-income/bonds';
import { selectQuotePrice } from '@totalfinance/options';
import type { PortfolioEvent } from '@totalfinance/portfolio';
import type {
  CouponTerms,
  FillTerms,
  InstrumentAdapter,
  InstrumentKind,
  InstrumentSpecification,
  LifecycleInput,
  MarkInput,
  MarkOutcome,
} from './types.js';

const DAY_MS = 86_400_000;

const dateOf = (ms: EpochMs): string =>
  new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

/** A rational approximation of a split ratio as positive integers (2 → 2:1, 0.5 → 1:2, 1.5 → 3:2). */
export function splitShares(ratio: number): {
  sharesAfterSplit: number;
  sharesBeforeSplit: number;
} {
  for (let before = 1; before <= 1000; before += 1) {
    const after = ratio * before;
    if (Math.abs(after - Math.round(after)) < 1e-9 && Math.round(after) >= 1) {
      return { sharesAfterSplit: Math.round(after), sharesBeforeSplit: before };
    }
  }
  throw new InputError(
    `splitShares: a split ratio of ${ratio} is not a ratio of small integers (at most 1000 shares before).`,
    {
      code: ErrorCode.InputOutOfRange,
      context: { ratio },
    },
  );
}

/**
 * Finite accrued interest per unit of quantity at the instant, from the coupon terms alone.
 * Refuses terms whose calculation overflows, even when their individual fields are finite.
 */
export function accruedFromTerms(terms: CouponTerms, asOf: EpochMs): number {
  requireCouponTerms('accruedFromTerms', 'terms', terms);
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) {
    throw new InputError(
      `accruedFromTerms: asOf must be a finite epoch-millisecond timestamp. Received ${JSON.stringify(asOf)}.`,
      {
        code: typeof asOf === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
        context: { function: 'accruedFromTerms', field: 'asOf' },
      },
    );
  }
  if (asOf <= isoDateToEpochMs(terms.issueDate) || asOf >= isoDateToEpochMs(terms.maturityDate))
    return 0;
  // The fixed-income owner supplies calendar coupon boundaries, front stubs, month ends and
  // day counts. Keep the backtest's declared face/day-count defaults when adapting its terms.
  const bond = bonds.fixedRate({
    issueDate: terms.issueDate,
    maturityDate: terms.maturityDate,
    couponRate: terms.annualRate,
    frequency: terms.paymentsPerYear,
    faceValue: terms.faceValuePerUnit ?? 1,
    dayCount: terms.dayCount ?? 'ACT/365F',
  });
  const date = dateOf(asOf);
  // No accrual at a coupon boundary, even if the owner's full-period coupon would overflow
  // before multiplying it by a zero elapsed fraction. Boundaries still belong to its schedule.
  if (bond.schedule.some((period) => period.accrualStart === date)) return 0;
  const accrued = bond.accrued(date);
  if (!Number.isFinite(accrued)) {
    throw new InputError(
      'accruedFromTerms: terms produce non-finite accrued interest; rescale faceValuePerUnit or use terms whose accrual is representable as a finite number.',
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'accruedFromTerms',
          field: 'terms',
          annualRate: terms.annualRate,
          faceValuePerUnit: terms.faceValuePerUnit ?? 1,
          asOf,
        },
      },
    );
  }
  return accrued;
}

/** The entitlement is fixed by the signed holding before this instant's orders execute. */
const signedIncomeEvents = (
  input: LifecycleInput,
  incomeType: 'dividend' | 'coupon',
  amountPerUnit: number,
  payDate?: string,
): PortfolioEvent[] => {
  if (input.held === null || input.held.quantity === 0 || amountPerUnit === 0) return [];
  const settle = payDate === undefined ? undefined : isoDateToEpochMs(payDate);
  return [
    {
      eventType: 'income.received',
      incomeType,
      amount: amountPerUnit * input.held.quantity * input.held.contractMultiplier,
      currency: input.specification.currency,
      instrumentId: input.instrumentId,
      // A pay date already reached (including a same-day midnight before the observation) is
      // immediate cash, not a settlement timestamp preceding the engine's event envelope.
      ...(settle !== undefined && settle > input.asOf ? { settleTimestampMs: settle } : {}),
    },
  ];
};

const corporateActionEvents = (input: LifecycleInput): PortfolioEvent[] => {
  const events: PortfolioEvent[] = [];
  if (input.held === null) return events;
  for (const action of input.facts.corporateActions) {
    if (action.symbol !== input.instrumentId) continue;
    switch (action.type) {
      case 'split':
      case 'reverseSplit': {
        const shares = splitShares(action.ratio ?? 1);
        events.push({ eventType: 'corporate.split', instrumentId: input.instrumentId, ...shares });
        break;
      }
      case 'symbolChange':
        events.push({
          eventType: 'corporate.symbol-change',
          fromInstrumentId: input.instrumentId,
          toInstrumentId: action.newSymbol ?? '',
        });
        break;
      case 'merger': {
        const details = (action.details ?? {}) as { sharesPerShare?: number };
        events.push({
          eventType: 'corporate.merger',
          fromInstrumentId: input.instrumentId,
          ...(action.newSymbol !== undefined ? { toInstrumentId: action.newSymbol } : {}),
          ...(details.sharesPerShare !== undefined
            ? { sharesPerShare: details.sharesPerShare }
            : {}),
          ...(action.cash !== undefined
            ? { cashPerShare: action.cash, currency: input.specification.currency }
            : {}),
        });
        break;
      }
      case 'spinoff': {
        const details = (action.details ?? {}) as {
          childInstrumentId?: string;
          sharesPerParentShare?: number;
          basisAllocationFraction?: number;
        };
        if (
          details.childInstrumentId === undefined ||
          details.sharesPerParentShare === undefined ||
          details.basisAllocationFraction === undefined
        ) {
          throw new InputError(
            `corporateActionEvents: a spin-off on ${input.instrumentId} effective ${action.effectiveDate} needs details.childInstrumentId, details.sharesPerParentShare, and details.basisAllocationFraction — the ledger allocates basis explicitly, never by guess.`,
            {
              code: ErrorCode.BacktestUnsupportedCorporateAction,
              context: { instrumentId: input.instrumentId, effectiveDate: action.effectiveDate },
            },
          );
        }
        events.push({
          eventType: 'corporate.spin-off',
          parentInstrumentId: input.instrumentId,
          childInstrumentId: details.childInstrumentId,
          sharesPerParentShare: details.sharesPerParentShare,
          basisAllocationFraction: details.basisAllocationFraction,
        });
        break;
      }
      case 'dividend':
        if (action.cash !== undefined && action.cash > 0) {
          // Corporate actions use effectiveDate for entitlement; details may carry payDate.
          events.push(
            ...signedIncomeEvents(
              input,
              'dividend',
              action.cash,
              action.details?.['payDate'] as string | undefined,
            ),
          );
        }
        break;
      case 'other':
        break;
    }
  }
  return events;
};

const dividendEvents = (input: LifecycleInput): PortfolioEvent[] => {
  return input.facts.dividends
    .filter((d) => d.instrumentId === input.instrumentId)
    .flatMap((d) => signedIncomeEvents(input, 'dividend', d.amount, d.payDate));
};

const markFromObservations = (input: MarkInput): MarkOutcome => {
  const { latest } = input;
  if (latest.quote !== undefined)
    return { pricePerUnit: (latest.quote.bid + latest.quote.ask) / 2, source: 'quote.mid' };
  if (latest.bar !== undefined) return { pricePerUnit: latest.bar.close, source: 'bar.close' };
  if (latest.trade !== undefined)
    return { pricePerUnit: latest.trade.price, source: 'trade.price' };
  if (latest.orderBook !== undefined) {
    const bid = latest.orderBook.bids[0]?.price;
    const ask = latest.orderBook.asks[0]?.price;
    if (bid !== undefined && ask !== undefined)
      return { pricePerUnit: (bid + ask) / 2, source: 'order-book.mid' };
  }
  return { unavailable: 'missing' };
};

const cashOnTrade = (spec: InstrumentSpecification): FillTerms => ({
  settlementStyle: 'cash-on-trade',
  ...(spec.contractMultiplier !== undefined ? { contractMultiplier: spec.contractMultiplier } : {}),
});

const equityAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'equity',
  version: '1',
  mark: markFromObservations,
  lifecycle: (input) => [...corporateActionEvents(input), ...dividendEvents(input)],
  fillTerms: cashOnTrade,
});

const etfAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  ...equityAdapter,
  kind: 'etf',
});
const cryptoSpotAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'crypto-spot',
  version: '1',
  mark: markFromObservations,
  lifecycle: () => [],
  fillTerms: cashOnTrade,
});

const optionAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'option',
  version: '1',
  mark: (input) => {
    const q = input.latest.chainQuote;
    if (q === undefined) return { unavailable: 'missing' };
    const price = selectQuotePrice(q, 'mid');
    if (price === undefined || !Number.isFinite(price)) return { unavailable: 'unpriceable' };
    return { pricePerUnit: price, source: 'chain.mid' };
  },
  lifecycle: (input) => {
    const terms = input.specification.contract;
    if (input.held === null || terms === undefined || terms.kind !== 'option') return [];
    if (input.asOf < terms.expiryTimestampMs) return [];
    if (input.previousAsOf !== null && input.previousAsOf >= terms.expiryTimestampMs) return [];
    if (input.underlyingMark === null) {
      throw new InputError(
        `${input.instrumentId} expires at ${terms.expiryTimestampMs} but its underlying ${terms.underlyingInstrumentId} has no mark at ${input.asOf} — an expiry settles at intrinsic from the underlying's mark, never a guess.`,
        {
          code: ErrorCode.BacktestMarkUnavailable,
          context: { instrumentId: input.instrumentId, asOf: input.asOf },
        },
      );
    }
    const S = input.underlyingMark;
    const intrinsic =
      terms.type === 'call'
        ? Math.max(S - terms.strikePricePerUnit, 0)
        : Math.max(terms.strikePricePerUnit - S, 0);
    const quantity = Math.abs(input.held.quantity);
    if (intrinsic <= 0)
      return [{ eventType: 'derivative.expiration', instrumentId: input.instrumentId, quantity }];
    const settlement = { kind: 'cash' as const, settlementPricePerUnit: S };
    return input.held.quantity > 0
      ? [
          {
            eventType: 'derivative.exercise',
            instrumentId: input.instrumentId,
            quantity,
            settlement,
            premiumTreatment: 'realize',
          },
        ]
      : [
          {
            eventType: 'derivative.assignment',
            instrumentId: input.instrumentId,
            quantity,
            settlement,
            premiumTreatment: 'realize',
          },
        ];
  },
  fillTerms: (spec) => ({
    settlementStyle: 'cash-on-trade',
    contractMultiplier: spec.contractMultiplier ?? 100,
    ...(spec.contract !== undefined ? { contract: spec.contract } : {}),
  }),
});

const futureAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'future',
  version: '1',
  mark: markFromObservations,
  lifecycle: (input) => {
    const events: PortfolioEvent[] = [];
    if (input.held === null || input.mark === null) return events;
    // daily variation margin at the mark
    events.push({
      eventType: 'derivative.variation-margin',
      instrumentId: input.instrumentId,
      settlementPricePerUnit: input.mark.pricePerUnit,
    });
    return events;
  },
  fillTerms: (spec) => ({
    settlementStyle: 'variation-margin',
    contractMultiplier: spec.contractMultiplier ?? 1,
    ...(spec.contract !== undefined ? { contract: spec.contract } : {}),
  }),
});

const cryptoPerpetualAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'crypto-perpetual',
  version: '1',
  mark: markFromObservations,
  lifecycle: (input) => {
    const events: PortfolioEvent[] = [];
    if (input.held === null || input.mark === null) return events;
    events.push({
      eventType: 'derivative.variation-margin',
      instrumentId: input.instrumentId,
      settlementPricePerUnit: input.mark.pricePerUnit,
    });
    const notional =
      Math.abs(input.held.quantity) * input.held.contractMultiplier * input.mark.pricePerUnit;
    for (const funding of input.facts.fundingRates) {
      if (funding.instrumentId !== input.instrumentId) continue;
      const amount = Math.abs(funding.fundingRate) * notional;
      if (amount === 0) continue;
      // positive rate: longs pay shorts
      const pays = funding.fundingRate > 0 === input.held.quantity > 0;
      events.push(
        pays
          ? {
              eventType: 'financing.charge',
              financingType: 'funding-payment',
              amount,
              currency: input.specification.currency,
              instrumentId: input.instrumentId,
            }
          : {
              eventType: 'income.received',
              incomeType: 'funding-receipt',
              amount,
              currency: input.specification.currency,
              instrumentId: input.instrumentId,
            },
      );
    }
    return events;
  },
  fillTerms: (spec) => ({
    settlementStyle: 'variation-margin',
    contractMultiplier: spec.contractMultiplier ?? 1,
    ...(spec.contract !== undefined ? { contract: spec.contract } : {}),
  }),
});

const fxForwardAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'fx-forward',
  version: '1',
  mark: (input) => {
    if (input.latest.forwardRate === undefined) return { unavailable: 'missing' };
    return { pricePerUnit: input.latest.forwardRate, source: 'forward-rate' };
  },
  lifecycle: (input) => {
    const forward = input.specification.forward;
    if (input.held === null || input.held.quantity === 0 || forward === undefined) return [];
    if (input.asOf < forward.maturityTimestampMs) return [];
    if (input.previousAsOf !== null && input.previousAsOf >= forward.maturityTimestampMs) return [];
    // A long receives base and pays quote; a short delivers base and receives quote. The engine
    // closes the position separately at its contract rate — this adapter emits only the exchange.
    const units = Math.abs(input.held.quantity);
    const long = input.held.quantity > 0;
    return [
      {
        eventType: 'cash.conversion',
        fromCurrency: long ? forward.quoteCurrency : forward.baseCurrency,
        toCurrency: long ? forward.baseCurrency : forward.quoteCurrency,
        fromAmount: long ? units * forward.contractRate : units,
        toAmount: long ? units : units * forward.contractRate,
      },
    ];
  },
  fillTerms: () => ({ settlementStyle: 'cash-on-trade' }),
});

const bondAdapter: InstrumentAdapter = Object.freeze<InstrumentAdapter>({
  kind: 'bond',
  version: '1',
  mark: (input) => {
    const clean = markFromObservations(input);
    if ('unavailable' in clean) return clean;
    const terms = input.specification.coupon;
    const accrued = terms === undefined ? 0 : accruedFromTerms(terms, input.asOf);
    return { pricePerUnit: clean.pricePerUnit + accrued, source: `${clean.source}+accrued` };
  },
  lifecycle: (input) => {
    const events: PortfolioEvent[] = [];
    if (input.held === null || input.held.quantity === 0) return events;
    for (const coupon of input.facts.coupons) {
      if (coupon.instrumentId !== input.instrumentId) continue;
      events.push(...signedIncomeEvents(input, 'coupon', coupon.amountPerUnit));
    }
    const terms = input.specification.coupon;
    if (terms !== undefined) {
      const maturity = isoDateToEpochMs(terms.maturityDate);
      if (
        input.asOf >= maturity &&
        (input.previousAsOf === null || input.previousAsOf < maturity)
      ) {
        events.push({
          eventType: 'fixed-income.redemption',
          instrumentId: input.instrumentId,
          redemptionType: 'maturity',
          quantity: Math.abs(input.held.quantity),
          pricePerUnit: terms.faceValuePerUnit ?? 1,
          currency: input.specification.currency,
        });
      }
    }
    return events;
  },
  fillTerms: cashOnTrade,
  accrued: ({ specification, asOf }) =>
    specification.coupon === undefined ? 0 : accruedFromTerms(specification.coupon, asOf),
});

/** The built-in adapters, keyed by kind. */
export const instrumentAdapters: Readonly<
  Record<Exclude<InstrumentKind, 'custom'>, InstrumentAdapter>
> = Object.freeze({
  equity: equityAdapter,
  etf: etfAdapter,
  option: optionAdapter,
  future: futureAdapter,
  'fx-forward': fxForwardAdapter,
  'crypto-spot': cryptoSpotAdapter,
  'crypto-perpetual': cryptoPerpetualAdapter,
  bond: bondAdapter,
});

/** The adapter a specification uses: its own for `custom`, the built-in otherwise. */
export function adapterFor(
  instrumentId: string,
  specification: InstrumentSpecification,
): InstrumentAdapter {
  const functionName = 'adapterFor';
  if (typeof instrumentId !== 'string' || instrumentId.length === 0) {
    throw new InputError(
      `${functionName}: instrumentId must be a non-empty string. Received ${JSON.stringify(instrumentId)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'instrumentId' },
      },
    );
  }
  requireInstrumentSpecification(functionName, `instruments.${instrumentId}`, specification);
  if (specification.kind === 'custom') {
    if (specification.adapter === undefined) {
      throw new InputError(
        `instruments.${instrumentId} is 'custom' and names no adapter — a custom instrument brings its own.`,
        {
          code: ErrorCode.InputMissingField,
          context: { field: `instruments.${instrumentId}.adapter` },
        },
      );
    }
    return specification.adapter;
  }
  if (specification.adapter !== undefined) {
    throw new InputError(
      `instruments.${instrumentId} is '${specification.kind}', a built-in kind, and also names an adapter — a built-in kind uses instrumentAdapters.${specification.kind}; declare kind: 'custom' to bring your own.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: `instruments.${instrumentId}.adapter` },
      },
    );
  }
  return instrumentAdapters[specification.kind];
}

/**
 * A fixture's bytes for the mutation and determinism checks: the specification's adapter is
 * behavior (functions), so it is projected to its identity — the rest is data and hashes whole.
 */
function fixtureBytes(fixture: MarkInput | LifecycleInput): string {
  const adapter = fixture.specification.adapter;
  return canonicalJsonOf({
    ...fixture,
    specification: {
      ...fixture.specification,
      ...(adapter === undefined
        ? {}
        : { adapter: { kind: adapter.kind, version: adapter.version } }),
    },
  });
}

/** The conformance suite (Decision 6a): pure, deterministic, finite, JSON-safe, payloads shaped as events. */
export function assertInstrumentAdapterConformance(input: {
  adapter: InstrumentAdapter;
  fixtures: { mark: readonly MarkInput[]; lifecycle: readonly LifecycleInput[] };
}): { kind: string; version: string; marks: number; lifecycles: number } {
  const functionName = 'assertInstrumentAdapterConformance';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['adapter', 'fixtures']);
  requireArgumentObject(functionName, 'input.adapter', input.adapter);
  requireArgumentObject(functionName, 'input.fixtures', input.fixtures);
  ensureKnownKeys(functionName, 'input.fixtures', input.fixtures, ['mark', 'lifecycle']);
  const { adapter, fixtures } = input;
  for (const name of ['mark', 'lifecycle'] as const) {
    if (!Array.isArray(fixtures[name])) {
      throw new InputError(
        `${functionName}: input.fixtures.${name} must be an array of fixtures. Received ${JSON.stringify(fixtures[name])}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `input.fixtures.${name}` },
        },
      );
    }
    fixtures[name].forEach((fixture, index) =>
      requireArgumentObject(functionName, `input.fixtures.${name}[${index}]`, fixture),
    );
  }
  if (adapter.accrued !== undefined && typeof adapter.accrued !== 'function') {
    throw new InputError(
      `${functionName}: input.adapter.accrued must be a function or absent. Received ${JSON.stringify(adapter.accrued)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'input.adapter.accrued' },
      },
    );
  }
  const refuse = (message: string, context: Record<string, unknown> = {}): never => {
    throw new InputError(`${functionName}: adapter '${adapter.kind}' ${message}`, {
      code: ErrorCode.BacktestAdapterNonconformant,
      context: { function: functionName, adapter: adapter.kind, ...context },
    });
  };
  if (typeof adapter.kind !== 'string' || adapter.kind.length === 0) refuse('has no kind.');
  if (typeof adapter.version !== 'string' || adapter.version.length === 0)
    refuse('has no version.');
  for (const name of ['mark', 'lifecycle', 'fillTerms'] as const) {
    if (typeof adapter[name] !== 'function') refuse(`has no ${name}() method.`);
  }
  if (fixtures.mark.length === 0 || fixtures.lifecycle.length === 0) {
    refuse('needs at least one mark fixture and one lifecycle fixture to be proven.');
  }
  fixtures.mark.forEach((fixture, index) => {
    const before = fixtureBytes(fixture);
    const first = adapter.mark(fixture);
    const second = adapter.mark(fixture);
    if (fixtureBytes(fixture) !== before)
      refuse(`mutated mark fixture #${index}.`, { fixture: index });
    if (canonicalJsonOf(first) !== canonicalJsonOf(second))
      refuse(`marked fixture #${index} differently on a second call — a mark is deterministic.`, {
        fixture: index,
      });
    if ('unavailable' in first) {
      if (!['missing', 'ambiguous', 'stale', 'unpriceable'].includes(first.unavailable))
        refuse(
          `reported an unknown unavailability '${String(first.unavailable)}' for fixture #${index}.`,
          { fixture: index },
        );
      return;
    }
    if (typeof first.pricePerUnit !== 'number' || !Number.isFinite(first.pricePerUnit))
      refuse(`returned a non-finite mark for fixture #${index}.`, { fixture: index });
    if (typeof first.source !== 'string' || first.source.length === 0)
      refuse(`returned a mark without a source for fixture #${index}.`, { fixture: index });
  });
  fixtures.lifecycle.forEach((fixture, index) => {
    const before = fixtureBytes(fixture);
    const first = adapter.lifecycle(fixture);
    const second = adapter.lifecycle(fixture);
    if (fixtureBytes(fixture) !== before)
      refuse(`mutated lifecycle fixture #${index}.`, { fixture: index });
    if (!Array.isArray(first))
      refuse(`returned a non-array from lifecycle() for fixture #${index}.`, { fixture: index });
    if (canonicalJsonOf(first) !== canonicalJsonOf(second))
      refuse(`emitted different lifecycle events on a second call for fixture #${index}.`, {
        fixture: index,
      });
    first.forEach((event, eventIndex) => {
      if (
        event === null ||
        typeof event !== 'object' ||
        typeof (event as { eventType?: unknown }).eventType !== 'string'
      ) {
        refuse(
          `emitted a lifecycle payload without an eventType (fixture #${index}, event #${eventIndex}).`,
          { fixture: index, event: eventIndex },
        );
      }
      try {
        canonicalJsonOf(event);
      } catch (error) {
        refuse(
          `emitted a lifecycle payload that is not JSON-safe (fixture #${index}, event #${eventIndex}): ${(error as Error).message}`,
          { fixture: index, event: eventIndex },
        );
      }
    });
    const terms = adapter.fillTerms(fixture.specification);
    if (terms === null || typeof terms !== 'object') refuse('returned no fill terms.');
    if (terms.settlementStyle !== 'cash-on-trade' && terms.settlementStyle !== 'variation-margin')
      refuse(`returned an unknown settlementStyle '${String(terms.settlementStyle)}'.`);
    if (
      terms.contractMultiplier !== undefined &&
      !(Number.isFinite(terms.contractMultiplier) && terms.contractMultiplier > 0)
    )
      refuse('returned a non-positive contractMultiplier.');
  });
  return {
    kind: adapter.kind,
    version: adapter.version,
    marks: fixtures.mark.length,
    lifecycles: fixtures.lifecycle.length,
  };
}

export { dateOf as calendarDateOf };
