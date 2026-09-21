/** Package-private metadata binding shared by built-in leaves and registry discovery. */
import {
  bindIndicatorMetadata,
  type Indicator,
  type IndicatorConventions,
  type IndicatorInputKind,
} from './framework.js';

/** The runtime contract a built-in carries even when discovery is not imported. */
export interface BuiltinIndicatorMetadata {
  readonly inputs: IndicatorInputKind;
  readonly parameters: readonly string[];
  readonly defaults?: Record<string, unknown>;
  readonly conventions?: IndicatorConventions;
}

/**
 * Copy and freeze containers without cloning callable values. Defaults may contain resolver
 * functions, and registered indicators must retain their callable identity.
 */
export function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((v) => frozenCopy(v))) as unknown as T;
  if (value !== null && typeof value === 'object')
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, frozenCopy(v)]),
      ),
    ) as T;
  return value;
}

/**
 * Bind before returning the newly constructed facade: callers never depend on registry import
 * order for validation or disclosure. The original function (and its stream/restore identity)
 * is returned unchanged. This does not calculate or invoke a stream factory/default resolver.
 */
export function withBuiltinMetadata<Params, In, Out>(
  indicator: Indicator<Params, In, Out>,
  metadata: BuiltinIndicatorMetadata,
): Indicator<Params, In, Out> {
  bindIndicatorMetadata(indicator, frozenCopy(metadata));
  return indicator;
}
