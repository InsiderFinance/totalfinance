/** JavaScript-style display of a result: NaN and infinities stay visible instead of becoming null. */
export function displayValue(value: unknown): string {
  // JSON.stringify writes the NUL marker as the six characters `\u0000`; match that form.
  const marker = '\u0000';
  return JSON.stringify(
    value,
    (_key, entry: unknown) =>
      typeof entry === 'number' && !Number.isFinite(entry)
        ? `${marker}${String(entry)}${marker}`
        : entry,
    2,
  ).replace(/"\\u0000(NaN|Infinity|-Infinity)\\u0000"/g, '$1');
}
