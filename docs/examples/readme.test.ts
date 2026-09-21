import { describe, expect, it } from 'vitest';
import { ROOT_README, executeReadme, executeSnippet } from '../../tools/readme-exec.js';

/**
 * DX7.1 — the front page cannot lie. Every ```ts block in the root README is concatenated and run
 * against the package sources; if the flagship example stops compiling or throws, CI fails.
 * (Package READMEs are covered transitively — their examples are the CI-run
 * `docs/examples/readme-snippets.test.ts`, and `tools/readme-gen.test.ts` pins each README to them.)
 */
describe('DX7.1 the front-page README executes', () => {
  it('every ```ts block in the root README.md compiles and runs', async () => {
    await executeReadme(ROOT_README);
  });

  it('a snippet that throws at runtime fails the executor (the guard has teeth)', async () => {
    await expect(
      executeSnippet(
        "import { blackScholes } from '@totalfinance/options';\nbs.call({ spot: -100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0, volatility: 0.2 });",
      ),
    ).rejects.toThrow();
  });

  it('a snippet that imports a non-existent binding fails to compile', async () => {
    await expect(
      executeSnippet("import { doesNotExist } from '@totalfinance/options';\ndoesNotExist();"),
    ).rejects.toThrow();
  });
});
