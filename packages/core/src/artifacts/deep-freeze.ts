/**
 * Recursive freeze for spine envelopes. `Object.freeze` is shallow — a "frozen" snapshot whose
 * nested observation could still be mutated would break hash stability the moment a caller edited
 * a row after hashing. Internal to `@totalfinance/core/artifacts`; envelopes are frozen on the
 * canonical COPY the constructors build, never on caller input.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }
  return value;
}
