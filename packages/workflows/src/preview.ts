/**
 * A bounded preview of a stored or spilled result: top-level keys, scalars inline, containers by
 * size, long strings clipped — enough for an agent to decide what to fetch, never a silent
 * truncation dressed as the result.
 */

export const PREVIEW_LIMITS = Object.freeze({ maximumKeys: 64, maximumStringLength: 256 });

export interface BoundedPreview {
  keys: string[];
  fields: Record<string, unknown>;
  truncated: boolean;
}

export function boundedPreview(result: Record<string, unknown>): BoundedPreview {
  const keys = Object.keys(result);
  const fields: Record<string, unknown> = {};
  for (const key of keys.slice(0, PREVIEW_LIMITS.maximumKeys)) {
    const value = result[key];
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = value;
    } else if (typeof value === 'string') {
      fields[key] =
        value.length > PREVIEW_LIMITS.maximumStringLength
          ? `${value.slice(0, PREVIEW_LIMITS.maximumStringLength)}…`
          : value;
    } else if (Array.isArray(value)) {
      fields[key] = { array: true, length: value.length };
    } else if (typeof value === 'object') {
      fields[key] = { object: true, keys: Object.keys(value as object).length };
    }
  }
  return { keys, fields, truncated: keys.length > PREVIEW_LIMITS.maximumKeys };
}
