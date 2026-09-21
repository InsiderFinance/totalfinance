/**
 * The closed guard for `portfolioBacktest` (Stage 4.6, FC8 Decision 6): every member of the request
 * is validated before a single instant runs — unknown keys, `null` where omission is meant, wrong
 * types, invalid enums, non-finite numbers, an instrument without the terms its kind needs, a
 * strategy that is not exactly one of its two forms, row sets above the ceiling.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { isModelPortfolio } from '@totalfinance/portfolio';
import { hasOwn, requireExecutionPolicy, requireOrderIntent } from '../execution/validate.js';
import type {
  CouponTerms,
  AccountingPolicy,
  AssetClass,
  InstrumentKind,
  InstrumentSpecification,
  PortfolioBacktestRequest,
  PortfolioMarketData,
  PortfolioStepperRequest,
} from './types.js';

/** Decision 9: rows one run may read per row set. */
export const PORTFOLIO_ROW_CEILING = 5_000_000;

/** The coupon terms of a bond — the accrual and the redemption come from these alone. */
export function requireCouponTerms(
  functionName: string,
  field: string,
  value: unknown,
): CouponTerms {
  requireArgumentObject(functionName, field, value);
  const coupon = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, coupon, [
    'annualRate',
    'paymentsPerYear',
    'faceValuePerUnit',
    'dayCount',
    'issueDate',
    'maturityDate',
  ]);
  finiteNumber(functionName, `${field}.annualRate`, coupon['annualRate']);
  if (![1, 2, 4, 12].includes(coupon['paymentsPerYear'] as number))
    refuse(
      functionName,
      `${field}.paymentsPerYear`,
      `must be 1, 2, 4, or 12. Received ${String(coupon['paymentsPerYear'])}.`,
      ErrorCode.InputInvalidEnum,
    );
  if (
    presentNotNull(functionName, coupon, 'faceValuePerUnit', `${field}.faceValuePerUnit`) &&
    !(finiteNumber(functionName, `${field}.faceValuePerUnit`, coupon['faceValuePerUnit']) > 0)
  )
    refuse(functionName, `${field}.faceValuePerUnit`, 'must be > 0.');
  if (presentNotNull(functionName, coupon, 'dayCount', `${field}.dayCount`))
    enumValue(functionName, `${field}.dayCount`, coupon['dayCount'], [
      'ACT/365F',
      '30/360',
    ] as const);
  const issue = isoDate(functionName, `${field}.issueDate`, coupon['issueDate']);
  const maturity = isoDate(functionName, `${field}.maturityDate`, coupon['maturityDate']);
  if (!(maturity > issue))
    refuse(
      functionName,
      `${field}.maturityDate`,
      `must be after issueDate (${issue}). Received ${maturity}.`,
    );
  return value as CouponTerms;
}

/** Decision 9: instruments one run may hold. */
export const PORTFOLIO_INSTRUMENT_CEILING = 50_000;

const REQUEST_KEYS = [
  'accounting',
  'instruments',
  'marketData',
  'strategy',
  'execution',
  'externalFlows',
  'calendar',
  'window',
  'periodsPerYear',
  'seed',
] as const;
const ACCOUNTING_KEYS = ['baseCurrency', 'initialCash', 'lotRelief', 'settlement'] as const;
const INSTRUMENT_KEYS = [
  'kind',
  'currency',
  'contractMultiplier',
  'contract',
  'assetClass',
  'classification',
  'adapter',
  'roll',
  'coupon',
  'forward',
] as const;
const MARKET_DATA_KEYS = [
  'bars',
  'quotes',
  'trades',
  'orderBooks',
  'optionChains',
  'fxRates',
  'forwardRates',
  'fundingRates',
  'corporateActions',
  'dividends',
  'coupons',
] as const;
const KINDS: readonly InstrumentKind[] = [
  'equity',
  'etf',
  'option',
  'future',
  'fx-forward',
  'crypto-spot',
  'crypto-perpetual',
  'bond',
  'custom',
];
const ASSET_CLASSES: readonly AssetClass[] = [...KINDS, 'cash'];
const LOT_RELIEF = ['fifo', 'lifo', 'highest-cost', 'specific-lot'] as const;
const SETTLEMENT = ['T+0', 'T+1', 'T+2'] as const;
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;
const SCOPES = ['to-target', 'drift-only'] as const;
export const PORTFOLIO_CALENDARS = ['NYSE', 'CBOE', 'ALWAYS_OPEN'] as const;

const EXAMPLE =
  "portfolioBacktest({ accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] }, instruments: { AAA: { kind: 'equity', currency: 'USD' } }, marketData: { bars }, strategy: { model: [{ group: { instrumentId: 'AAA' }, weight: 0.6 }, { group: { assetClass: 'cash' }, weight: 0.4 }], schedule: { frequency: 'monthly' } } })";

function refuse(
  functionName: string,
  field: string,
  message: string,
  code: string = ErrorCode.InputOutOfRange,
): never {
  throw new InputError(`${functionName}: ${field} ${message} Example: ${EXAMPLE}`, {
    code,
    context: { function: functionName, field },
  });
}

function finiteNumber(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number')
    refuse(
      functionName,
      field,
      `must be a finite number. Received ${value === null ? 'null' : typeof value}.`,
      ErrorCode.InputWrongType,
    );
  if (!Number.isFinite(value))
    refuse(
      functionName,
      field,
      `must be finite. Received ${String(value)}.`,
      ErrorCode.InputNotFinite,
    );
  return value;
}

function nonEmptyString(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse(
      functionName,
      field,
      `must be a non-empty string. Received ${value === null ? 'null' : typeof value}.`,
      ErrorCode.InputWrongType,
    );
  return value;
}

function enumValue<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T))
    refuse(
      functionName,
      field,
      `must be one of ${allowed.map((v) => `'${v}'`).join(' | ')}. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      ErrorCode.InputInvalidEnum,
    );
  return value as T;
}

function presentNotNull(functionName: string, record: object, key: string, field: string): boolean {
  if (!hasOwn(record, key)) return false;
  if ((record as Record<string, unknown>)[key] === null)
    refuse(
      functionName,
      field,
      'is null — omit the field to leave it unset.',
      ErrorCode.InputWrongType,
    );
  return (record as Record<string, unknown>)[key] !== undefined;
}

function boundedRows(functionName: string, field: string, value: unknown): unknown[] {
  if (!Array.isArray(value))
    refuse(
      functionName,
      field,
      `must be an array. Received ${value === null ? 'null' : typeof value}.`,
      ErrorCode.InputWrongType,
    );
  if (value.length > PORTFOLIO_ROW_CEILING)
    refuse(
      functionName,
      field,
      `has ${value.length} rows, above the ${PORTFOLIO_ROW_CEILING} one synchronous run may read — hand larger inputs to the job runner by handle.`,
      ErrorCode.BacktestInputTooLarge,
    );
  return value;
}

function isoDate(functionName: string, field: string, value: unknown): string {
  const s = nonEmptyString(functionName, field, value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)))
    refuse(
      functionName,
      field,
      `must be a 'YYYY-MM-DD' date. Received ${JSON.stringify(s)}.`,
      ErrorCode.InputWrongType,
    );
  return s;
}

function timestamp(functionName: string, field: string, value: unknown): number {
  const n = finiteNumber(functionName, field, value);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 8.64e15)
    refuse(functionName, field, `must be an epoch-millisecond instant. Received ${String(n)}.`);
  return n;
}

function requireRows(
  functionName: string,
  field: string,
  value: unknown,
  check: (row: Record<string, unknown>, at: string) => void,
): void {
  boundedRows(functionName, field, value).forEach((row, index) => {
    const at = `${field}[${index}]`;
    requireArgumentObject(functionName, at, row);
    check(row as Record<string, unknown>, at);
  });
}

export function requireAccountingPolicy(
  functionName: string,
  field: string,
  value: unknown,
): AccountingPolicy {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, ACCOUNTING_KEYS);
  const baseCurrency = nonEmptyString(
    functionName,
    `${field}.baseCurrency`,
    record['baseCurrency'],
  );
  if (!/^[A-Z]{3}$/.test(baseCurrency))
    refuse(
      functionName,
      `${field}.baseCurrency`,
      `must be an uppercase three-letter code. Received ${JSON.stringify(baseCurrency)}.`,
    );
  requireRows(functionName, `${field}.initialCash`, record['initialCash'], (row, at) => {
    ensureKnownKeys(functionName, at, row, ['currency', 'amount']);
    nonEmptyString(functionName, `${at}.currency`, row['currency']);
    const amount = finiteNumber(functionName, `${at}.amount`, row['amount']);
    if (!(amount > 0)) refuse(functionName, `${at}.amount`, `must be > 0. Received ${amount}.`);
  });
  if ((record['initialCash'] as unknown[]).length === 0)
    refuse(functionName, `${field}.initialCash`, 'must name at least one opening balance.');
  if (presentNotNull(functionName, record, 'lotRelief', `${field}.lotRelief`))
    enumValue(functionName, `${field}.lotRelief`, record['lotRelief'], LOT_RELIEF);
  if (presentNotNull(functionName, record, 'settlement', `${field}.settlement`)) {
    requireArgumentObject(functionName, `${field}.settlement`, record['settlement']);
    for (const [assetClass, lag] of Object.entries(
      record['settlement'] as Record<string, unknown>,
    )) {
      enumValue(functionName, `${field}.settlement`, assetClass, ASSET_CLASSES);
      enumValue(functionName, `${field}.settlement.${assetClass}`, lag, SETTLEMENT);
    }
  }
  return value as AccountingPolicy;
}

function requireContractTerms(functionName: string, field: string, value: unknown): void {
  requireArgumentObject(functionName, field, value);
  const terms = value as Record<string, unknown>;
  const kind = enumValue(functionName, `${field}.kind`, terms['kind'], [
    'option',
    'future',
    'perpetual',
  ] as const);
  ensureKnownKeys(
    functionName,
    field,
    terms,
    kind === 'option'
      ? ['kind', 'underlyingInstrumentId', 'type', 'strikePricePerUnit', 'expiryTimestampMs']
      : kind === 'future'
        ? ['kind', 'underlyingInstrumentId', 'expiryTimestampMs']
        : ['kind', 'underlyingInstrumentId'],
  );
  nonEmptyString(functionName, `${field}.underlyingInstrumentId`, terms['underlyingInstrumentId']);
  if (kind === 'option') {
    enumValue(functionName, `${field}.type`, terms['type'], ['call', 'put'] as const);
    const strike = finiteNumber(
      functionName,
      `${field}.strikePricePerUnit`,
      terms['strikePricePerUnit'],
    );
    if (!(strike > 0))
      refuse(functionName, `${field}.strikePricePerUnit`, `must be > 0. Received ${strike}.`);
  }
  if (kind !== 'perpetual')
    timestamp(functionName, `${field}.expiryTimestampMs`, terms['expiryTimestampMs']);
}

export function requireInstrumentSpecification(
  functionName: string,
  field: string,
  value: unknown,
): InstrumentSpecification {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, INSTRUMENT_KEYS);
  const kind = enumValue(functionName, `${field}.kind`, record['kind'], KINDS);
  const currency = nonEmptyString(functionName, `${field}.currency`, record['currency']);
  if (!/^[A-Z]{3,10}$/.test(currency))
    refuse(
      functionName,
      `${field}.currency`,
      `must be an uppercase currency code. Received ${JSON.stringify(currency)}.`,
    );
  if (presentNotNull(functionName, record, 'contractMultiplier', `${field}.contractMultiplier`)) {
    const m = finiteNumber(
      functionName,
      `${field}.contractMultiplier`,
      record['contractMultiplier'],
    );
    if (!(m > 0))
      refuse(functionName, `${field}.contractMultiplier`, `must be > 0. Received ${m}.`);
  }
  const hasContract = presentNotNull(functionName, record, 'contract', `${field}.contract`);
  if (hasContract) requireContractTerms(functionName, `${field}.contract`, record['contract']);
  const needsContract = kind === 'option' || kind === 'future' || kind === 'crypto-perpetual';
  if (needsContract && !hasContract)
    refuse(
      functionName,
      `${field}.contract`,
      `is required for a '${kind}' — the ledger stores the terms on the position.`,
      ErrorCode.InputMissingField,
    );
  if (hasContract) {
    const contractKind = (record['contract'] as { kind: string }).kind;
    const expected =
      kind === 'option'
        ? 'option'
        : kind === 'future'
          ? 'future'
          : kind === 'crypto-perpetual'
            ? 'perpetual'
            : null;
    if (expected === null)
      refuse(
        functionName,
        `${field}.contract`,
        `is not carried by a '${kind}' — omit it.`,
        ErrorCode.InputUnknownField,
      );
    if (contractKind !== expected)
      refuse(
        functionName,
        `${field}.contract.kind`,
        `must be '${expected}' for a '${kind}'. Received '${contractKind}'.`,
        ErrorCode.InputInvalidEnum,
      );
  }
  if (presentNotNull(functionName, record, 'assetClass', `${field}.assetClass`))
    enumValue(functionName, `${field}.assetClass`, record['assetClass'], ASSET_CLASSES);
  if (presentNotNull(functionName, record, 'classification', `${field}.classification`)) {
    requireArgumentObject(functionName, `${field}.classification`, record['classification']);
    ensureKnownKeys(functionName, `${field}.classification`, record['classification'] as object, [
      'underlying',
      'assetClass',
      'strategy',
      'tags',
    ]);
  }
  const hasAdapter = presentNotNull(functionName, record, 'adapter', `${field}.adapter`);
  if (kind === 'custom' && !hasAdapter)
    refuse(
      functionName,
      `${field}.adapter`,
      "is required for a 'custom' instrument — a custom instrument brings its own adapter.",
      ErrorCode.InputMissingField,
    );
  if (kind !== 'custom' && hasAdapter)
    refuse(
      functionName,
      `${field}.adapter`,
      `is not taken by a built-in kind ('${kind}') — declare kind: 'custom' to bring your own.`,
      ErrorCode.InputUnknownField,
    );
  if (hasAdapter) {
    requireArgumentObject(functionName, `${field}.adapter`, record['adapter']);
    const adapter = record['adapter'] as Record<string, unknown>;
    nonEmptyString(functionName, `${field}.adapter.kind`, adapter['kind']);
    nonEmptyString(functionName, `${field}.adapter.version`, adapter['version']);
    for (const method of ['mark', 'lifecycle', 'fillTerms']) {
      if (typeof adapter[method] !== 'function')
        refuse(
          functionName,
          `${field}.adapter.${method}`,
          'must be a function — see assertInstrumentAdapterConformance.',
          ErrorCode.InputWrongType,
        );
    }
  }
  if (presentNotNull(functionName, record, 'roll', `${field}.roll`)) {
    if (kind !== 'future')
      refuse(
        functionName,
        `${field}.roll`,
        `is only taken by a 'future'. This instrument is '${kind}'.`,
        ErrorCode.InputUnknownField,
      );
    requireArgumentObject(functionName, `${field}.roll`, record['roll']);
    const roll = record['roll'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${field}.roll`, roll, [
      'toInstrumentId',
      'sessionsBeforeExpiry',
    ]);
    nonEmptyString(functionName, `${field}.roll.toInstrumentId`, roll['toInstrumentId']);
    if (
      !Number.isSafeInteger(roll['sessionsBeforeExpiry']) ||
      (roll['sessionsBeforeExpiry'] as number) < 0
    )
      refuse(
        functionName,
        `${field}.roll.sessionsBeforeExpiry`,
        `must be a non-negative integer. Received ${String(roll['sessionsBeforeExpiry'])}.`,
      );
  }
  if (presentNotNull(functionName, record, 'coupon', `${field}.coupon`)) {
    if (kind !== 'bond')
      refuse(
        functionName,
        `${field}.coupon`,
        `is only taken by a 'bond'. This instrument is '${kind}'.`,
        ErrorCode.InputUnknownField,
      );
    requireCouponTerms(functionName, `${field}.coupon`, record['coupon']);
  } else if (kind === 'bond') {
    refuse(
      functionName,
      `${field}.coupon`,
      "is required for a 'bond' — accrued interest and the redemption come from the terms.",
      ErrorCode.InputMissingField,
    );
  }
  if (presentNotNull(functionName, record, 'forward', `${field}.forward`)) {
    if (kind !== 'fx-forward')
      refuse(
        functionName,
        `${field}.forward`,
        `is only taken by an 'fx-forward'. This instrument is '${kind}'.`,
        ErrorCode.InputUnknownField,
      );
    requireArgumentObject(functionName, `${field}.forward`, record['forward']);
    const forward = record['forward'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${field}.forward`, forward, [
      'maturityTimestampMs',
      'baseCurrency',
      'quoteCurrency',
      'contractRate',
    ]);
    timestamp(functionName, `${field}.forward.maturityTimestampMs`, forward['maturityTimestampMs']);
    nonEmptyString(functionName, `${field}.forward.baseCurrency`, forward['baseCurrency']);
    nonEmptyString(functionName, `${field}.forward.quoteCurrency`, forward['quoteCurrency']);
    if (!(finiteNumber(functionName, `${field}.forward.contractRate`, forward['contractRate']) > 0))
      refuse(functionName, `${field}.forward.contractRate`, 'must be > 0.');
    if (forward['quoteCurrency'] !== currency)
      refuse(
        functionName,
        `${field}.forward.quoteCurrency`,
        `must equal the instrument's currency (${currency}) — the forward is paid in it.`,
      );
  } else if (kind === 'fx-forward') {
    refuse(
      functionName,
      `${field}.forward`,
      "is required for an 'fx-forward'.",
      ErrorCode.InputMissingField,
    );
  }
  return value as InstrumentSpecification;
}

export function requirePortfolioMarketData(
  functionName: string,
  field: string,
  value: unknown,
): PortfolioMarketData {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, MARKET_DATA_KEYS);
  const series = (key: string, check: (row: Record<string, unknown>, at: string) => void): void => {
    if (!presentNotNull(functionName, record, key, `${field}.${key}`)) return;
    requireRows(functionName, `${field}.${key}`, record[key], check);
  };
  series('bars', (row, at) => {
    nonEmptyString(functionName, `${at}.symbol`, row['symbol']);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    for (const k of ['open', 'high', 'low', 'close'])
      finiteNumber(functionName, `${at}.${k}`, row[k]);
  });
  series('quotes', (row, at) => {
    nonEmptyString(functionName, `${at}.symbol`, row['symbol']);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    for (const k of ['bid', 'ask']) finiteNumber(functionName, `${at}.${k}`, row[k]);
  });
  series('trades', (row, at) => {
    nonEmptyString(functionName, `${at}.symbol`, row['symbol']);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    finiteNumber(functionName, `${at}.price`, row['price']);
    finiteNumber(functionName, `${at}.size`, row['size']);
  });
  series('orderBooks', (row, at) => {
    nonEmptyString(functionName, `${at}.symbol`, row['symbol']);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    for (const side of ['bids', 'asks']) {
      if (!Array.isArray(row[side]))
        refuse(
          functionName,
          `${at}.${side}`,
          'must be an array of levels.',
          ErrorCode.InputWrongType,
        );
    }
  });
  series('optionChains', (row, at) => {
    if (typeof row['asOf'] !== 'number' && typeof row['asOf'] !== 'string')
      refuse(functionName, `${at}.asOf`, 'must be an instant.', ErrorCode.InputWrongType);
    finiteNumber(functionName, `${at}.underlyingPrice`, row['underlyingPrice']);
    if (!Array.isArray(row['quotes']))
      refuse(functionName, `${at}.quotes`, 'must be an array of quotes.', ErrorCode.InputWrongType);
  });
  series('fxRates', (row, at) => {
    ensureKnownKeys(functionName, at, row, [
      'timestampMs',
      'baseCurrency',
      'quoteCurrency',
      'quotePerBase',
    ]);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    nonEmptyString(functionName, `${at}.baseCurrency`, row['baseCurrency']);
    nonEmptyString(functionName, `${at}.quoteCurrency`, row['quoteCurrency']);
    if (!(finiteNumber(functionName, `${at}.quotePerBase`, row['quotePerBase']) > 0))
      refuse(functionName, `${at}.quotePerBase`, 'must be > 0.');
  });
  series('forwardRates', (row, at) => {
    ensureKnownKeys(functionName, at, row, ['instrumentId', 'timestampMs', 'forwardRate']);
    nonEmptyString(functionName, `${at}.instrumentId`, row['instrumentId']);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    if (!(finiteNumber(functionName, `${at}.forwardRate`, row['forwardRate']) > 0))
      refuse(functionName, `${at}.forwardRate`, 'must be > 0.');
  });
  series('fundingRates', (row, at) => {
    ensureKnownKeys(functionName, at, row, ['instrumentId', 'timestampMs', 'fundingRate']);
    nonEmptyString(functionName, `${at}.instrumentId`, row['instrumentId']);
    timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
    finiteNumber(functionName, `${at}.fundingRate`, row['fundingRate']);
  });
  series('corporateActions', (row, at) => {
    nonEmptyString(functionName, `${at}.symbol`, row['symbol']);
    const effectiveDate = isoDate(functionName, `${at}.effectiveDate`, row['effectiveDate']);
    enumValue(functionName, `${at}.type`, row['type'], [
      'split',
      'reverseSplit',
      'dividend',
      'symbolChange',
      'merger',
      'spinoff',
      'other',
    ] as const);
    if (row['type'] === 'dividend' && row['details'] !== undefined) {
      requireArgumentObject(functionName, `${at}.details`, row['details']);
      const details = row['details'] as Record<string, unknown>;
      if (presentNotNull(functionName, details, 'payDate', `${at}.details.payDate`)) {
        const payDate = isoDate(functionName, `${at}.details.payDate`, details['payDate']);
        if (payDate < effectiveDate)
          refuse(functionName, `${at}.details.payDate`, 'must be on or after effectiveDate.');
      }
    }
    if (
      (row['type'] === 'split' || row['type'] === 'reverseSplit') &&
      !(typeof row['ratio'] === 'number' && Number.isFinite(row['ratio']) && row['ratio'] > 0)
    )
      refuse(
        functionName,
        `${at}.ratio`,
        `is needed by a ${String(row['type'])} (a positive ratio).`,
      );
    if (
      row['type'] === 'symbolChange' &&
      !(typeof row['newSymbol'] === 'string' && row['newSymbol'].length > 0)
    )
      refuse(
        functionName,
        `${at}.newSymbol`,
        'is needed by a symbolChange.',
        ErrorCode.InputMissingField,
      );
  });
  series('dividends', (row, at) => {
    ensureKnownKeys(functionName, at, row, ['instrumentId', 'exDate', 'amount', 'payDate']);
    nonEmptyString(functionName, `${at}.instrumentId`, row['instrumentId']);
    const exDate = isoDate(functionName, `${at}.exDate`, row['exDate']);
    if (!(finiteNumber(functionName, `${at}.amount`, row['amount']) > 0))
      refuse(functionName, `${at}.amount`, 'must be > 0.');
    if (presentNotNull(functionName, row, 'payDate', `${at}.payDate`)) {
      const payDate = isoDate(functionName, `${at}.payDate`, row['payDate']);
      if (payDate < exDate) refuse(functionName, `${at}.payDate`, 'must be on or after exDate.');
    }
  });
  series('coupons', (row, at) => {
    ensureKnownKeys(functionName, at, row, ['instrumentId', 'paymentDate', 'amountPerUnit']);
    nonEmptyString(functionName, `${at}.instrumentId`, row['instrumentId']);
    isoDate(functionName, `${at}.paymentDate`, row['paymentDate']);
    if (!(finiteNumber(functionName, `${at}.amountPerUnit`, row['amountPerUnit']) > 0))
      refuse(functionName, `${at}.amountPerUnit`, 'must be > 0.');
  });
  return value as PortfolioMarketData;
}

/** The whole-request guard in the `(functionName, label, value)` order. */
const STEPPER_KEYS = REQUEST_KEYS.filter((key) => key !== 'strategy');

/** Everything but the strategy: the accounting, the instruments, the data, and the run options. */
function requireRequestCore(
  functionName: string,
  label: string,
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireArgumentObject(functionName, label, value);
  const request = value as Record<string, unknown>;
  ensureKnownKeys(functionName, label, request, keys);
  const accounting = requireAccountingPolicy(
    functionName,
    `${label}.accounting`,
    request['accounting'],
  );
  requireArgumentObject(functionName, `${label}.instruments`, request['instruments']);
  const instruments = request['instruments'] as Record<string, unknown>;
  const ids = Object.keys(instruments);
  if (ids.length === 0)
    refuse(functionName, `${label}.instruments`, 'must name at least one instrument.');
  if (ids.length > PORTFOLIO_INSTRUMENT_CEILING)
    refuse(
      functionName,
      `${label}.instruments`,
      `names ${ids.length} instruments, above the ${PORTFOLIO_INSTRUMENT_CEILING} one synchronous run may hold.`,
      ErrorCode.BacktestInputTooLarge,
    );
  for (const id of ids) {
    if (id.length === 0)
      refuse(
        functionName,
        `${label}.instruments`,
        'has an empty instrument id.',
        ErrorCode.InputWrongType,
      );
    const spec = requireInstrumentSpecification(
      functionName,
      `${label}.instruments.${id}`,
      instruments[id],
    );
    if (spec.roll !== undefined && !(spec.roll.toInstrumentId in instruments))
      refuse(
        functionName,
        `${label}.instruments.${id}.roll.toInstrumentId`,
        `names '${spec.roll.toInstrumentId}', which is not an instrument of this run.`,
      );
    if (spec.currency !== accounting.baseCurrency) {
      const fx = (request['marketData'] as Record<string, unknown> | null)?.['fxRates'];
      if (!Array.isArray(fx) || fx.length === 0)
        refuse(
          functionName,
          `${label}.marketData.fxRates`,
          `is required — instruments.${id} trades in ${spec.currency} while the base currency is ${accounting.baseCurrency}.`,
          ErrorCode.InputMissingField,
        );
    }
  }
  requirePortfolioMarketData(functionName, `${label}.marketData`, request['marketData']);
  if (presentNotNull(functionName, request, 'execution', `${label}.execution`))
    requireExecutionPolicy(functionName, `${label}.execution`, request['execution']);
  if (presentNotNull(functionName, request, 'externalFlows', `${label}.externalFlows`)) {
    requireRows(functionName, `${label}.externalFlows`, request['externalFlows'], (row, at) => {
      ensureKnownKeys(functionName, at, row, ['timestampMs', 'amount', 'currency']);
      timestamp(functionName, `${at}.timestampMs`, row['timestampMs']);
      const amount = finiteNumber(functionName, `${at}.amount`, row['amount']);
      if (amount === 0)
        refuse(
          functionName,
          `${at}.amount`,
          'must be non-zero (a contribution > 0, a withdrawal < 0).',
        );
      nonEmptyString(functionName, `${at}.currency`, row['currency']);
    });
  }
  if (presentNotNull(functionName, request, 'calendar', `${label}.calendar`))
    enumValue(functionName, `${label}.calendar`, request['calendar'], PORTFOLIO_CALENDARS);
  if (presentNotNull(functionName, request, 'window', `${label}.window`)) {
    requireArgumentObject(functionName, `${label}.window`, request['window']);
    const window = request['window'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${label}.window`, window, ['fromTimestampMs', 'toTimestampMs']);
    const from = presentNotNull(
      functionName,
      window,
      'fromTimestampMs',
      `${label}.window.fromTimestampMs`,
    )
      ? timestamp(functionName, `${label}.window.fromTimestampMs`, window['fromTimestampMs'])
      : null;
    const to = presentNotNull(
      functionName,
      window,
      'toTimestampMs',
      `${label}.window.toTimestampMs`,
    )
      ? timestamp(functionName, `${label}.window.toTimestampMs`, window['toTimestampMs'])
      : null;
    if (from !== null && to !== null && to < from)
      refuse(functionName, `${label}.window.toTimestampMs`, 'must not precede fromTimestampMs.');
  }
  if (
    presentNotNull(functionName, request, 'periodsPerYear', `${label}.periodsPerYear`) &&
    !(finiteNumber(functionName, `${label}.periodsPerYear`, request['periodsPerYear']) > 0)
  )
    refuse(functionName, `${label}.periodsPerYear`, 'must be > 0.');
  if (
    presentNotNull(functionName, request, 'seed', `${label}.seed`) &&
    !(Number.isSafeInteger(request['seed']) && (request['seed'] as number) >= 0)
  )
    refuse(functionName, `${label}.seed`, 'must be a non-negative safe integer.');
  return request;
}

export function requirePortfolioBacktestRequest(
  functionName: string,
  label: string,
  value: unknown,
): PortfolioBacktestRequest {
  const request = requireRequestCore(functionName, label, value, REQUEST_KEYS);
  // strategy: exactly one form
  requireArgumentObject(functionName, `${label}.strategy`, request['strategy']);
  const strategy = request['strategy'] as Record<string, unknown>;
  const declarative = hasOwn(strategy, 'model');
  const direct = hasOwn(strategy, 'onSession');
  if (declarative === direct)
    refuse(
      functionName,
      `${label}.strategy`,
      'must be exactly one of { model, schedule, policy?, scope? } or { onSession }.',
      declarative ? ErrorCode.InputUnknownField : ErrorCode.InputMissingField,
    );
  if (declarative) {
    ensureKnownKeys(functionName, `${label}.strategy`, strategy, [
      'model',
      'schedule',
      'policy',
      'scope',
    ]);
    const model = strategy['model'];
    if (Array.isArray(model)) {
      if (model.length === 0)
        refuse(functionName, `${label}.strategy.model`, 'must name at least one target.');
      model.forEach((target, index) => {
        requireArgumentObject(functionName, `${label}.strategy.model[${index}]`, target);
        ensureKnownKeys(functionName, `${label}.strategy.model[${index}]`, target as object, [
          'group',
          'weight',
          'riskBudget',
          'driftBand',
        ]);
      });
    } else if (!isModelPortfolio(model)) {
      refuse(
        functionName,
        `${label}.strategy.model`,
        'must be a ModelPortfolio artifact or an array of allocation targets.',
        ErrorCode.InputWrongType,
      );
    }
    requireArgumentObject(functionName, `${label}.strategy.schedule`, strategy['schedule']);
    ensureKnownKeys(functionName, `${label}.strategy.schedule`, strategy['schedule'] as object, [
      'frequency',
    ]);
    enumValue(
      functionName,
      `${label}.strategy.schedule.frequency`,
      (strategy['schedule'] as Record<string, unknown>)['frequency'],
      FREQUENCIES,
    );
    if (presentNotNull(functionName, strategy, 'policy', `${label}.strategy.policy`)) {
      requireArgumentObject(functionName, `${label}.strategy.policy`, strategy['policy']);
      const policy = strategy['policy'] as Record<string, unknown>;
      if (hasOwn(policy, 'targets') || hasOwn(policy, 'model'))
        refuse(
          functionName,
          `${label}.strategy.policy`,
          'carries targets/model — the strategy.model is the one source of targets; the policy carries the limits and handling.',
          ErrorCode.InputUnknownField,
        );
    }
    if (presentNotNull(functionName, strategy, 'scope', `${label}.strategy.scope`))
      enumValue(functionName, `${label}.strategy.scope`, strategy['scope'], SCOPES);
  } else {
    ensureKnownKeys(functionName, `${label}.strategy`, strategy, ['onSession']);
    if (typeof strategy['onSession'] !== 'function')
      refuse(
        functionName,
        `${label}.strategy.onSession`,
        'must be a function of the session context.',
        ErrorCode.InputWrongType,
      );
  }
  return value as PortfolioBacktestRequest;
}

/**
 * The stepper's request (Stage 7B.1): `portfolioBacktest`'s request without a strategy — the orders
 * come from `close()`. A `strategy` member teaches which verb wants it.
 */
export function requirePortfolioStepperRequest(
  functionName: string,
  label: string,
  value: unknown,
): PortfolioStepperRequest {
  requireArgumentObject(functionName, label, value);
  if (hasOwn(value as object, 'strategy'))
    refuse(
      functionName,
      `${label}.strategy`,
      'is not a stepper field — a stepper takes its orders from close(); portfolioBacktest is the verb that runs a strategy.',
      ErrorCode.InputUnknownField,
    );
  requireRequestCore(functionName, label, value, STEPPER_KEYS);
  return value as PortfolioStepperRequest;
}

export { requireOrderIntent };
