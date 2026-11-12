import { isNumberControl, type Control, type PlaygroundInput } from './types';

/**
 * Shareable input state in the query string. Numbers, options and tables round-trip; datasets are
 * shared only as a sample id (a reader's own data never leaves their browser through a link).
 */
const encode = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const decode = (text: string) => {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

export function inputToQuery(
  controls: readonly Control[],
  input: PlaygroundInput,
): { query: string; omitted: string[] } {
  const params = new URLSearchParams();
  const omitted: string[] = [];
  for (const control of controls) {
    const value = input[control.name];
    if (value === undefined) continue;
    if (isNumberControl(control) || control.kind === 'select')
      params.set(control.name, String(value));
    else if (control.kind === 'table') params.set(control.name, encode(JSON.stringify(value)));
    else {
      const sample = control.samples.find(
        (candidate) => JSON.stringify(candidate.value) === JSON.stringify(value),
      );
      if (sample) params.set(control.name, `sample:${sample.id}`);
      else omitted.push(control.label);
    }
  }
  return { query: params.toString(), omitted };
}

/** Partial input from a query string; unknown or malformed parameters are ignored. */
export function queryToInput(controls: readonly Control[], query: string): PlaygroundInput {
  const params = new URLSearchParams(query);
  const input: PlaygroundInput = {};
  for (const control of controls) {
    const raw = params.get(control.name);
    if (raw === null) continue;
    try {
      if (isNumberControl(control)) {
        const value = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(value)) input[control.name] = value;
      } else if (control.kind === 'select') input[control.name] = raw;
      else if (control.kind === 'table') input[control.name] = JSON.parse(decode(raw));
      else if (raw.startsWith('sample:')) {
        const sample = control.samples.find((candidate) => candidate.id === raw.slice(7));
        if (sample) input[control.name] = JSON.parse(JSON.stringify(sample.value));
      }
    } catch {
      // A damaged link falls back to the default for that control.
    }
  }
  return input;
}
