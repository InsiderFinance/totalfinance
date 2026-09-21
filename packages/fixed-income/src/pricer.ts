/**
 * Gate C adapter for bonds priced from one named discount curve.
 *
 * This module contains no pricing mathematics. It maps Gate C's plain market observations onto the
 * existing fixed-income curve builder and `priceMultiCurve`, then preserves that direct result.
 */

import {
  ErrorCode,
  InputError,
  UnsupportedError,
  ensureEnum,
  isQuantError,
  missingFieldError,
  resolveAsOf,
  type Diagnostics,
  type EpochMs,
  type RateCurve,
} from '@totalfinance/core';
import {
  definePricer,
  requireObservationValue,
  type MarketObservation,
  type MarketRequirement,
  type Pricer,
  type PricerPriceInput,
} from '@totalfinance/core/pricing';
import { priceMultiCurve, type Bond, type BondAssumptions } from './bonds.js';
import { type CurveExtrapolation, type CurveInterpolation, type YieldCurve } from './curves.js';
import { yieldCurveFromRateCurve } from './curve-mappers.js';

export const BOND_DISCOUNT_CURVE_PRICER_NAME = 'fixed-income.bond-discount-curve';
export const BOND_SETTLEMENT_DATE_PROJECTION =
  'UTC calendar date containing valuationInstant' as const;

const PRICER_VERSION = '0.0.1';
const FACTORY_KEYS = [
  'curveId',
  'currency',
  'priceType',
  'interpolation',
  'extrapolation',
] as const;
const PRICE_KEYS = ['instrument', 'observations', 'request'] as const;
const REQUEST_KEYS = ['greeks', 'seed'] as const;
const PRICE_TYPES = ['clean', 'dirty'] as const;
const INTERPOLATIONS = [
  'logLinearDiscount',
  'linearZero',
  'linearDiscount',
  'cubicZero',
  'pchipZero',
] as const satisfies readonly CurveInterpolation[];
const EXTRAPOLATIONS = [
  'flatForward',
  'flatZero',
  'throw',
] as const satisfies readonly CurveExtrapolation[];
const SUPPORTED_KINDS = ['fixed', 'zero', 'amortizing'] as const;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const FACTORY_EXAMPLE_VALUES = {
  curveId: "curveId: 'USD.treasury'",
  currency: "currency: 'USD'",
  priceType: "priceType: 'dirty'",
  interpolation: "interpolation: 'logLinearDiscount'",
  extrapolation: "extrapolation: 'flatForward'",
} as const;

type FactoryOptionKey = keyof typeof FACTORY_EXAMPLE_VALUES;

function factoryExampleFor(functionName: string, field: FactoryOptionKey): string {
  const keys = [field, ...FACTORY_KEYS.filter((key) => key !== field)];
  return `${functionName}({ ${keys.map((key) => FACTORY_EXAMPLE_VALUES[key]).join(', ')} })`;
}

interface StoredRecordOptions {
  readonly functionName: string;
  readonly label: string;
  readonly allowedKeys?: readonly string[];
  readonly requiredKeys?: readonly string[];
}

function describeContainer(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Snapshot a request or stored-data shell through own descriptors only. The returned plain record
 * is the only object later validation reads, so an accessor or coercion hook on caller input can
 * never run merely because the adapter is trying to explain a malformed call.
 */
function snapshotStoredRecord(
  value: unknown,
  options: StoredRecordOptions,
): Readonly<Record<string, unknown>> {
  const { functionName, label, allowedKeys, requiredKeys = [] } = options;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${label} must be a plain object of named stored fields, got ${describeContainer(value)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: label, received: describeContainer(value) },
      },
    );
  }
  const object = value as object;
  if (!isPlainRecord(object)) {
    throw new InputError(
      `${functionName}: ${label} must be a plain object with own stored fields — class instances and custom prototypes are not accepted here.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: label },
      },
    );
  }

  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') {
      throw new InputError(
        `${functionName}: ${label} contains a symbol key; this boundary accepts enumerable string fields only.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: label, keyType: 'symbol' },
        },
      );
    }
    if (allowedKeys !== undefined && !allowedKeys.includes(key)) {
      throw new InputError(
        `${functionName}: unknown field ${JSON.stringify(key)} in ${label}. Allowed fields: ${allowedKeys.join(', ')}.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: label, key },
        },
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new InputError(
        `${functionName}: ${label}.${key} must be an enumerable own data property — accessors and hidden members are not accepted.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.${key}` },
        },
      );
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }

  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(result, key) || result[key] === undefined) {
      throw new InputError(`${functionName}: ${label}.${key} is required.`, {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${label}.${key}` },
      });
    }
  }
  return Object.freeze(result);
}

/** Snapshot a plain dense array without reading accessor-backed slots or allocating for holes. */
function snapshotDenseArray(
  value: unknown,
  functionName: string,
  label: string,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InputError(`${functionName}: ${label} must be a plain dense array.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: label },
    });
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new InputError(`${functionName}: ${label} has an invalid length descriptor.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: `${label}.length` },
    });
  }
  const length = lengthDescriptor.value as number;
  let indexCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new InputError(
        `${functionName}: ${label} contains a non-index member; observation arrays contain dense elements only.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: label },
        },
      );
    }
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new InputError(
        `${functionName}: ${label}[${key}] must be an enumerable stored element — sparse arrays, accessors, and hidden slots are not accepted.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}[${key}]` },
        },
      );
    }
    indexCount += 1;
  }
  if (indexCount !== length) {
    throw new InputError(
      `${functionName}: ${label} must be dense; its length is ${length} but it stores ${indexCount} elements.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: label, length, storedElements: indexCount },
      },
    );
  }

  const result: unknown[] = new Array(length);
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    // The complete descriptor pass above proved this branch. Keep the postcondition explicit so a
    // hostile proxy cannot turn a missing slot into an untyped crash between the two reads.
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new InputError(`${functionName}: ${label}[${index}] changed during validation.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}[${index}]` },
      });
    }
    result[index] = descriptor.value;
  }
  return Object.freeze(result);
}

function copyStoredRecord(
  source: Readonly<Record<string, unknown>>,
  replacements: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: Object.prototype.hasOwnProperty.call(replacements, key)
        ? replacements[key]
        : source[key],
      writable: true,
    });
  }
  return Object.freeze(result);
}

function snapshotRateCurve(
  value: unknown,
  functionName: string,
  label: string,
): Readonly<Record<string, unknown>> {
  const curve = snapshotStoredRecord(value, { functionName, label });
  const replacements: Record<string, unknown> = {};

  const rawPoints = curve['points'];
  if (rawPoints !== undefined) {
    const points = snapshotDenseArray(rawPoints, functionName, `${label}.points`);
    replacements['points'] = Object.freeze(
      points.map((point, index) =>
        snapshotStoredRecord(point, {
          functionName,
          label: `${label}.points[${index}]`,
        }),
      ),
    );
  }

  const rawCompounding = curve['compounding'];
  if (
    rawCompounding !== null &&
    typeof rawCompounding === 'object' &&
    !Array.isArray(rawCompounding)
  ) {
    replacements['compounding'] = snapshotStoredRecord(rawCompounding, {
      functionName,
      label: `${label}.compounding`,
    });
  }
  return copyStoredRecord(curve, replacements);
}

function snapshotObservations(value: unknown, functionName: string): readonly MarketObservation[] {
  const observations = snapshotDenseArray(value, functionName, 'input.observations');
  return Object.freeze(
    observations.map((rawObservation, index) => {
      const label = `input.observations[${index}]`;
      const observation = snapshotStoredRecord(rawObservation, {
        functionName,
        label,
        allowedKeys: ['requirement', 'value'],
        requiredKeys: ['requirement', 'value'],
      });
      const requirement = snapshotStoredRecord(observation['requirement'], {
        functionName,
        label: `${label}.requirement`,
      });
      const valueSnapshot =
        requirement['kind'] === 'discountCurve'
          ? snapshotRateCurve(observation['value'], functionName, `${label}.value`)
          : observation['value'];
      return Object.freeze({ requirement, value: valueSnapshot }) as unknown as MarketObservation;
    }),
  );
}

export interface BondDiscountCurvePricerOptions {
  curveId: string;
  currency: string;
  priceType: 'clean' | 'dirty';
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
}

export type BondDiscountCurvePricerAssumptions = BondAssumptions & {
  /** The clean/dirty quote selected as the adapter's numeric `value`. */
  priceType: 'clean' | 'dirty';
  curveId: string;
  currency: string;
  interpolation: CurveInterpolation;
  extrapolation: CurveExtrapolation;
  /** Resolved epoch milliseconds consumed from the valuation-instant observation. */
  valuationInstant: EpochMs;
  /** The stored curve anchor, preserved exactly rather than silently rolled to valuation time. */
  curveReferenceDate: string;
  settlementDateProjection: typeof BOND_SETTLEMENT_DATE_PROJECTION;
};

/**
 * The complete direct `priceMultiCurve` result plus Gate C's scalar value and adapter disclosures.
 */
export interface BondDiscountCurvePriceResult {
  value: number;
  dirtyPrice: number;
  cleanPrice: number;
  accruedInterest: number;
  assumptions: BondDiscountCurvePricerAssumptions;
  diagnostics: Diagnostics;
}

function requireNonEmptyString(
  functionName: string,
  field: FactoryOptionKey,
  value: unknown,
): string {
  if (value === undefined) {
    throw missingFieldError(functionName, field, factoryExampleFor(functionName, field));
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InputError(`${functionName}: ${field} must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field },
    });
  }
  return value;
}

function requireFactoryOptions(
  rawOptions: BondDiscountCurvePricerOptions,
): BondDiscountCurvePricerOptions {
  const functionName = 'bondDiscountCurvePricer';
  const options = snapshotStoredRecord(rawOptions, {
    functionName,
    label: 'options',
    allowedKeys: FACTORY_KEYS,
  });
  const curveId = requireNonEmptyString(functionName, 'curveId', options['curveId']);
  const currency = requireNonEmptyString(functionName, 'currency', options['currency']);
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    const uppercased = currency.toUpperCase();
    const fix = CURRENCY_CODE_PATTERN.test(uppercased) ? ` — write it as '${uppercased}'` : '';
    throw new InputError(
      `${functionName}: currency must be an uppercase three-letter ISO-style currency code matching /^[A-Z]{3}$/ (e.g. 'USD'). Received ${JSON.stringify(currency)}${fix}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'currency', value: currency },
      },
    );
  }
  if (options['priceType'] === undefined) {
    throw missingFieldError(
      functionName,
      'priceType',
      factoryExampleFor(functionName, 'priceType'),
    );
  }
  if (options['interpolation'] === undefined) {
    throw missingFieldError(
      functionName,
      'interpolation',
      factoryExampleFor(functionName, 'interpolation'),
    );
  }
  if (options['extrapolation'] === undefined) {
    throw missingFieldError(
      functionName,
      'extrapolation',
      factoryExampleFor(functionName, 'extrapolation'),
    );
  }
  ensureEnum(options['priceType'], PRICE_TYPES, 'priceType', functionName);
  ensureEnum(options['interpolation'], INTERPOLATIONS, 'interpolation', functionName);
  ensureEnum(options['extrapolation'], EXTRAPOLATIONS, 'extrapolation', functionName);
  return Object.freeze({
    curveId,
    currency,
    priceType: options['priceType'],
    interpolation: options['interpolation'],
    extrapolation: options['extrapolation'],
  });
}

function requirementsFor(options: BondDiscountCurvePricerOptions): readonly MarketRequirement[] {
  return Object.freeze([
    Object.freeze({ kind: 'valuationInstant' as const }),
    Object.freeze({
      kind: 'discountCurve' as const,
      curveId: options.curveId,
      currency: options.currency,
    }),
  ]);
}

/**
 * Build the pricer's discount curve through the PUBLIC mapper (`yieldCurveFromRateCurve` — Stage
 * 4.5 made the former private builder public; one engine). The pricer keeps its own taxonomy: a
 * refusal the mapper voices as an input error is re-thrown here as `pricer.observation_invalid`
 * with the curve identity, so a caller of the pricer still reads one protocol.
 */
function buildDiscountCurve(
  observed: RateCurve,
  options: BondDiscountCurvePricerOptions,
  functionName: string,
): { curve: YieldCurve; referenceDate: string } {
  try {
    const curve = yieldCurveFromRateCurve({
      curve: observed,
      interpolation: options.interpolation,
      extrapolation: options.extrapolation,
    });
    return { curve, referenceDate: curve.referenceDate };
  } catch (error) {
    if (isQuantError(error)) {
      throw new InputError(
        `${functionName}: ${error.message.replace(/^yieldCurveFromRateCurve: /, '')}`,
        {
          code: ErrorCode.PricerObservationInvalid,
          context: {
            function: functionName,
            curveId: options.curveId,
            field: 'discountCurve',
            ...(error.context ?? {}),
          },
          cause: error,
        },
      );
    }
    throw error;
  }
}

function storedBondKind(instrument: unknown): string | undefined {
  if (
    instrument === null ||
    typeof instrument !== 'object' ||
    Array.isArray(instrument) ||
    !isPlainRecord(instrument)
  ) {
    return undefined;
  }

  let kind: unknown;
  let hasKind = false;
  for (const key of Reflect.ownKeys(instrument)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(instrument, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return undefined;
    }
    if (key === 'kind') {
      hasKind = true;
      kind = descriptor.value;
    }
  }
  return hasKind && typeof kind === 'string' ? kind : undefined;
}

function isSupportedBond(instrument: Bond): boolean {
  const kind = storedBondKind(instrument);
  return kind !== undefined && (SUPPORTED_KINDS as readonly string[]).includes(kind);
}

/**
 * Adapt the existing fixed-income discount-curve bond pricing path to Gate C.
 */
export function bondDiscountCurvePricer(
  options: BondDiscountCurvePricerOptions,
): Pricer<Bond, BondDiscountCurvePriceResult> {
  const checked = requireFactoryOptions(options);
  const requirements = requirementsFor(checked);
  const functionName = 'bondDiscountCurvePricer.price';

  return definePricer<Bond, BondDiscountCurvePriceResult>({
    name: BOND_DISCOUNT_CURVE_PRICER_NAME,
    version: PRICER_VERSION,
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: isSupportedBond,
    requirements: () => requirements,
    price: (rawInput: PricerPriceInput<Bond>): BondDiscountCurvePriceResult => {
      const input = snapshotStoredRecord(rawInput, {
        functionName,
        label: 'input',
        allowedKeys: PRICE_KEYS,
        requiredKeys: ['instrument', 'observations'],
      });
      const instrument = input['instrument'] as Bond;
      const rawRequest = input['request'];
      if (rawRequest !== undefined) {
        const request = snapshotStoredRecord(rawRequest, {
          functionName,
          label: 'input.request',
          allowedKeys: REQUEST_KEYS,
        });
        if (request['greeks'] !== undefined && typeof request['greeks'] !== 'boolean') {
          throw new InputError(`${functionName}: input.request.greeks must be a boolean.`, {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: 'input.request.greeks' },
          });
        }
        const seed = request['seed'];
        if (seed !== undefined && typeof seed !== 'number') {
          throw new InputError(
            `${functionName}: input.request.seed must be a number when supplied.`,
            {
              code: ErrorCode.InputWrongType,
              context: { function: functionName, field: 'input.request.seed' },
            },
          );
        }
        if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
          throw new InputError(
            `${functionName}: input.request.seed must be a non-negative safe integer when supplied.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: functionName, field: 'input.request.seed' },
            },
          );
        }
      }
      const bondKind = storedBondKind(instrument);
      if (bondKind === undefined || !(SUPPORTED_KINDS as readonly string[]).includes(bondKind)) {
        const receivedKind =
          bondKind === undefined ? 'an invalid stored kind' : JSON.stringify(bondKind);
        throw new UnsupportedError(
          `${functionName}: bond kind ${receivedKind} is not supported; use a fixed-rate, zero-coupon, or fixed-amortizing bond. Floating-rate and inflation-linked bonds require market observations this adapter does not declare.`,
          {
            code: ErrorCode.EngineUnsupportedContract,
            context: { function: functionName, bondKind: bondKind ?? 'invalid' },
          },
        );
      }

      const observations = snapshotObservations(input['observations'], functionName);

      const valuationInstant = resolveAsOf(
        requireObservationValue(functionName, observations, { kind: 'valuationInstant' }),
        functionName,
      );
      const observedCurve = requireObservationValue(functionName, observations, {
        kind: 'discountCurve',
        curveId: checked.curveId,
        currency: checked.currency,
      });
      const { curve, referenceDate } = buildDiscountCurve(observedCurve, checked, functionName);
      const settlementDate = new Date(valuationInstant).toISOString().slice(0, 10);
      const direct = priceMultiCurve(instrument, { settlementDate, discountCurve: curve });
      const result: BondDiscountCurvePriceResult = {
        value: checked.priceType === 'clean' ? direct.cleanPrice : direct.dirtyPrice,
        dirtyPrice: direct.dirtyPrice,
        cleanPrice: direct.cleanPrice,
        accruedInterest: direct.accruedInterest,
        assumptions: {
          ...direct.assumptions,
          priceType: checked.priceType,
          curveId: checked.curveId,
          currency: checked.currency,
          interpolation: checked.interpolation,
          extrapolation: checked.extrapolation,
          valuationInstant,
          curveReferenceDate: referenceDate,
          settlementDateProjection: BOND_SETTLEMENT_DATE_PROJECTION,
        },
        diagnostics: direct.diagnostics,
      };
      return result;
    },
  });
}
