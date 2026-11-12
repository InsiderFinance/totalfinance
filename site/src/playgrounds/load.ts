import type { Playground } from '../types';

export { validateInputs } from './inputs';

/** Lazy loaders, so a page downloads only the calculator it shows. */
const LOADERS: Record<string, () => Promise<Playground>> = {
  'price-an-option': async () => (await import('./options')).options,
  'analyze-a-strategy': async () => (await import('./strategy')).strategies,
  'track-portfolio-pnl': async () => (await import('./portfolio')).portfolio,
  'value-a-company': async () => (await import('./valuation')).valuation,
  'backtest-a-strategy': async () => (await import('./backtest')).backtesting,
  'explore-scenarios': async () => (await import('./scenario')).scenarios,
  'chart-technical-indicators': async () => (await import('./indicators')).indicators,
  'measure-risk': async () => (await import('./risk')).risk,
  'price-a-bond': async () => (await import('./bond')).bond,
  'fit-a-volatility-smile': async () => (await import('./smile')).smile,
};

export const PLAYGROUND_IDS = Object.keys(LOADERS);

export async function loadPlayground(id: string): Promise<Playground> {
  const load = LOADERS[id];
  if (!load)
    throw new Error('This playground is not available. Choose a task from the navigation.');
  return load();
}
