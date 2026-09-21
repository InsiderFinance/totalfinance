import type { Calculation } from './types.js';

/** The exact complete source copied by the first-call button, including any sample setup. */
export function firstCallCode(calculation: Calculation): string {
  const { setup, code } = calculation.example;
  return setup ? `${setup.code}\n\n${code}` : code;
}
