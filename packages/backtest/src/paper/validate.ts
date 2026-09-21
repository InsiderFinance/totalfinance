/**
 * The paper broker's doors (Stage 7B.2, Decision 7): the construction input and the instrument
 * terms, in the (functionName, label, value) order the library uses everywhere.
 */
import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type { CreatePaperBrokerInput, PaperInstrument } from './types.js';

const CREATE_KEYS = [
  'execution',
  'baseCurrency',
  'journal',
  'sourceId',
  'accountId',
  'instruments',
] as const;
const INSTRUMENT_KEYS = [
  'currency',
  'contractMultiplier',
  'settlementStyle',
  'contract',
  'settlementLag',
] as const;
const SETTLEMENT_STYLES = ['cash-on-trade', 'variation-margin'] as const;
const MAX_EPOCH_MS = 8.64e15;

export function requireIdentity(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-empty string. Received ${value === null ? 'null' : typeof value === 'string' ? "''" : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
}

export function requireEpochMs(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a finite epoch-millisecond timestamp. Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      {
        code: typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_EPOCH_MS) {
    throw new InputError(
      `${functionName}: ${field} must be an integer epoch-millisecond timestamp within ±8.64e15. Received ${String(value)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field },
      },
    );
  }
}

/** An ISO-4217-shaped currency code: three uppercase letters. */
export function requireCurrency(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  requireIdentity(functionName, field, value);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a three-letter uppercase currency code. Received ${JSON.stringify(value)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field },
      },
    );
  }
}

export function requirePaperInstrument(
  functionName: string,
  label: string,
  value: unknown,
): PaperInstrument {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, INSTRUMENT_KEYS);
  const record = value as Record<string, unknown>;
  requireCurrency(functionName, `${label}.currency`, record['currency']);
  if (record['contractMultiplier'] !== undefined) {
    const multiplier = record['contractMultiplier'];
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || !(multiplier > 0)) {
      throw new InputError(
        `${functionName}: ${label}.contractMultiplier must be a finite number > 0. Received ${String(multiplier)}.`,
        {
          code:
            typeof multiplier === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.contractMultiplier` },
        },
      );
    }
  }
  if (
    record['settlementStyle'] !== undefined &&
    !(SETTLEMENT_STYLES as readonly unknown[]).includes(record['settlementStyle'])
  ) {
    throw new InputError(
      `${functionName}: ${label}.settlementStyle must be one of ${SETTLEMENT_STYLES.map((s) => `'${s}'`).join(', ')}. Received ${JSON.stringify(record['settlementStyle'])}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: `${label}.settlementStyle` },
      },
    );
  }
  if (record['contract'] !== undefined)
    requireArgumentObject(functionName, `${label}.contract`, record['contract']);
  if (
    record['settlementLag'] !== undefined &&
    ![0, 1, 2].includes(record['settlementLag'] as number)
  ) {
    throw new InputError(
      `${functionName}: ${label}.settlementLag must be 0, 1, or 2 sessions. Received ${JSON.stringify(record['settlementLag'])}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.settlementLag` },
      },
    );
  }
  return value as PaperInstrument;
}

export function requirePaperInstruments(
  functionName: string,
  label: string,
  value: unknown,
): Readonly<Record<string, PaperInstrument>> {
  if (value === undefined) return {};
  requireArgumentObject(functionName, label, value);
  for (const [instrumentId, terms] of Object.entries(value as Record<string, unknown>)) {
    requireIdentity(functionName, `${label} key`, instrumentId);
    requirePaperInstrument(functionName, `${label}[${JSON.stringify(instrumentId)}]`, terms);
  }
  return value as Readonly<Record<string, PaperInstrument>>;
}

export function requireCreatePaperBrokerInput(
  functionName: string,
  label: string,
  value: unknown,
): CreatePaperBrokerInput {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, CREATE_KEYS);
  const record = value as Record<string, unknown>;
  requireCurrency(functionName, `${label}.baseCurrency`, record['baseCurrency']);
  requireIdentity(functionName, `${label}.sourceId`, record['sourceId']);
  requireIdentity(functionName, `${label}.accountId`, record['accountId']);
  if (record['journal'] !== undefined && !Array.isArray(record['journal'])) {
    throw new InputError(`${functionName}: ${label}.journal must be an array of journal events.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: `${label}.journal` },
    });
  }
  return value as CreatePaperBrokerInput;
}
