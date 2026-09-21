import type { Playground } from '../types.js';

export async function loadPlayground(id: string): Promise<Playground> {
  switch (id) {
    case 'price-an-option':
      return (await import('./options.js')).options;
    case 'analyze-a-strategy':
      return (await import('./strategy.js')).strategies;
    case 'track-portfolio-pnl':
      return (await import('./portfolio.js')).portfolio;
    case 'value-a-company':
      return (await import('./valuation.js')).valuation;
    case 'backtest-a-strategy':
      return (await import('./backtest.js')).backtesting;
    case 'explore-scenarios':
      return (await import('./scenario.js')).scenarios;
    default:
      throw new Error('This playground is not available. Choose a task from the navigation.');
  }
}

export function validateInputs(playground: Playground, input: unknown): Record<string, number> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Supply a named object of numeric playground inputs.');
  const value = input as Record<string, unknown>;
  const names = new Set(playground.controls.map((control) => control.name));
  for (const name of Object.keys(value))
    if (!names.has(name)) throw new Error(`Unknown input ${name}. Use: ${[...names].join(', ')}.`);
  const result: Record<string, number> = {};
  for (const control of playground.controls) {
    const field = value[control.name];
    if (
      typeof field !== 'number' ||
      !Number.isFinite(field) ||
      field < control.min ||
      field > control.max
    )
      throw new Error(
        `${control.label} must be a finite number from ${control.min} to ${control.max} (${control.unit}).`,
      );
    result[control.name] = field;
  }
  return result;
}
