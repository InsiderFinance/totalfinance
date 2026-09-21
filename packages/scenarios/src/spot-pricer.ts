import { CONVENTIONS_VERSION, ErrorCode, InputError, type Computed } from '@totalfinance/core';
import {
  definePricer,
  requireObservationValue,
  type MarketRequirement,
  type MarketObservation,
  type Pricer,
  type PricerPriceInput,
} from '@totalfinance/core/pricing';
import { snapshotClosedRecord, snapshotDenseArray } from './internal/data.js';
import type { SpotAssetInstrument } from './types.js';

/** Package-internal stable identity used to recognize the first-party spot valuation contract. */
export const SPOT_ASSET_PRICER_NAME = 'scenarios.spot-asset';
/** Package-internal stable version paired with {@link SPOT_ASSET_PRICER_NAME}. */
export const SPOT_ASSET_PRICER_VERSION = '0.0.1';

interface SpotAssetPricingResult extends Computed<number> {
  assumptions: Computed<number>['assumptions'] & {
    model: 'observed-spot';
    symbol: string;
    valuationUnit: 'one spot asset unit';
  };
}

function readInstrument(value: unknown, functionName: string): SpotAssetInstrument {
  const instrument = snapshotClosedRecord(value, {
    functionName,
    label: 'instrument',
    allowedKeys: ['symbol'],
    requiredKeys: ['symbol'],
  });
  if (typeof instrument['symbol'] !== 'string' || instrument['symbol'].trim().length === 0) {
    throw new InputError(`${functionName}: instrument.symbol must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: 'instrument.symbol' },
    });
  }
  return { symbol: instrument['symbol'] };
}

function supportsSpotAsset(value: unknown): value is SpotAssetInstrument {
  try {
    readInstrument(value, `${SPOT_ASSET_PRICER_NAME}.supports`);
    return true;
  } catch {
    return false;
  }
}

/**
 * First-party Gate-C adapter for a directly observed spot asset. Its per-unit value is exactly the
 * matching spot observation; quantity and any contract multiplier remain target-owned.
 */
export function spotAssetPricer(): Pricer<SpotAssetInstrument, SpotAssetPricingResult> {
  const requirements = (instrument: SpotAssetInstrument): readonly MarketRequirement[] => {
    const checked = readInstrument(instrument, `${SPOT_ASSET_PRICER_NAME}.requirements`);
    return Object.freeze([{ kind: 'spot', symbol: checked.symbol }]);
  };

  return definePricer<SpotAssetInstrument, SpotAssetPricingResult>({
    name: SPOT_ASSET_PRICER_NAME,
    version: SPOT_ASSET_PRICER_VERSION,
    capabilities: { greeks: 'none', randomness: 'none', batch: false },
    supports: supportsSpotAsset,
    requirements,
    price: (rawInput: PricerPriceInput<SpotAssetInstrument>): SpotAssetPricingResult => {
      const functionName = `${SPOT_ASSET_PRICER_NAME}.price`;
      const input = snapshotClosedRecord(rawInput, {
        functionName,
        label: 'input',
        allowedKeys: ['instrument', 'observations', 'request'],
        requiredKeys: ['instrument', 'observations'],
      });
      const instrument = readInstrument(input['instrument'], functionName);
      const observations = snapshotDenseArray(
        input['observations'],
        functionName,
        'input.observations',
      );
      if (input['request'] !== undefined) {
        const request = snapshotClosedRecord(input['request'], {
          functionName,
          label: 'input.request',
          allowedKeys: ['greeks', 'seed'],
        });
        if (request['greeks'] !== undefined && typeof request['greeks'] !== 'boolean') {
          throw new InputError(`${functionName}: input.request.greeks must be a boolean.`, {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: 'input.request.greeks' },
          });
        }
        if (
          request['seed'] !== undefined &&
          (typeof request['seed'] !== 'number' ||
            !Number.isSafeInteger(request['seed']) ||
            request['seed'] < 0)
        ) {
          throw new InputError(
            `${functionName}: input.request.seed must be a non-negative safe integer when supplied.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: functionName, field: 'input.request.seed' },
            },
          );
        }
      }
      const value = requireObservationValue(
        functionName,
        observations as readonly MarketObservation[],
        { kind: 'spot', symbol: instrument.symbol },
      );
      return {
        value,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          model: 'observed-spot',
          symbol: instrument.symbol,
          valuationUnit: 'one spot asset unit',
        },
        diagnostics: {
          engine: SPOT_ASSET_PRICER_NAME,
          method: 'market-observation',
          warnings: [],
        },
      };
    },
  });
}
