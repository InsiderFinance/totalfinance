import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { executeReadme } from '../../tools/readme-exec.js';

/**
 * DX7.1 (guides) — a guide's headline example must run, not merely read well. Each guide named below
 * has its ```ts blocks extracted, bundled against the `@insiderfinance/totalfinance/*` SOURCES, and executed; a retired
 * key or renamed field (the exact drift that shipped `premiums:` / `underlyingPrice:` in the strategy
 * guide) fails CI here instead of failing the reader who copies it.
 *
 * Only fully self-contained guides belong in this list. `errors.md` deliberately shows throwing calls,
 * and `envelope.md` / `ta-live-charts.md` document streaming or in-flux surfaces — those are verified
 * by their own targeted tests rather than a run-clean pass.
 */
const guide = (name: string): string =>
  fileURLToPath(new URL(`../guides/${name}`, import.meta.url));

describe('DX7.1 runnable guides execute against source', () => {
  it('sector-performance.md — simple returns and audited snapshot examples run', async () => {
    await executeReadme(guide('sector-performance.md'));
  });
  it('calculation-adoption.md — saved calculation, exact replay and metric comparison agree', async () => {
    await executeReadme(guide('calculation-adoption.md'));
  });
  it('strategies.md — the iron-condor headline compiles and runs', async () => {
    await executeReadme(guide('strategies.md'));
  });
  it('backtesting.md — the cross-sectional first call compiles and runs', async () => {
    await executeReadme(guide('backtesting.md'));
  });
  it('levels.md — the six levels price the same contract and agree', async () => {
    await executeReadme(guide('levels.md'));
  });
  it('selective-greeks-and-exposure.md — selected outputs and exposures equal the full calculation', async () => {
    await executeReadme(guide('selective-greeks-and-exposure.md'));
  });
  it('end-to-end.md — fundamentals to performance, reconciled at every step', async () => {
    await executeReadme(guide('end-to-end.md'));
  });
  it('trading-environment.md — reset/step, a retry, the mask, an artifact, the bench', async () => {
    await executeReadme(guide('trading-environment.md'));
  });
});
