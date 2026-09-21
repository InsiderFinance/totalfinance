/**
 * JSON-safe normalization of a structured result: every non-finite number (NaN, ±Infinity — a
 * non-converged inversion, an indicator warmup) becomes `null` at the source, so an in-process
 * result and its JSON mirror agree and both validate against the advertised output schema.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  // A typed array (a Float64Array of returns, an Int8Array of option types) serializes as an
  // object of index keys under JSON.stringify; the wire carries a plain array of its numbers.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView))
    return Array.from(value as unknown as ArrayLike<number>, jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}
