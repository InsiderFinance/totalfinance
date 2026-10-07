import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolvedExpiry } from '@totalfinance/core';
import { optionFlowDrift } from '@totalfinance/structure';
import { optionFlowDriftCases, optionFlowDriftOutcome } from './golden/option-flow-drift-cases.mjs';

/**
 * RELEASED-BEHAVIOR PARITY for `optionFlowDrift`.
 *
 * The digests were captured from the PUBLISHED `@insiderfinance/totalfinance@0.1.2` by
 * `tools/golden/capture-option-flow-drift-baseline.mjs`, not from this repository, so the premium
 * path drift now runs (flow's validation and classification without its analytics) is held to what
 * released consumers received: every value, key, assumption and diagnostic of the full result, and
 * every error's name, code and message, including which of two bad prints is reported.
 */
const golden = JSON.parse(
  readFileSync(new URL('./golden/option-flow-drift-0.1.2.json', import.meta.url), 'utf8'),
) as { meta: { package: string; cases: number }; digests: Record<string, string> };

describe('optionFlowDrift reproduces the released 0.1.2 exactly', () => {
  const cases = optionFlowDriftCases(resolvedExpiry);

  it('covers every captured case, and only those', () => {
    expect(cases.map((c) => c.name).sort()).toEqual(Object.keys(golden.digests).sort());
    expect(cases.length).toBe(golden.meta.cases);
  });

  it.each(cases.map((c) => [c.name, c.input] as const))('%s', (name, input) => {
    const outcome = optionFlowDriftOutcome(optionFlowDrift as (input: never) => unknown, input);
    expect(createHash('sha256').update(outcome).digest('hex'), name).toBe(golden.digests[name]);
  });
});
