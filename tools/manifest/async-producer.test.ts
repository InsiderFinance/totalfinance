import { setImmediate } from 'node:timers/promises';
import { it, expect } from 'vitest';
import { isSynchronousProducerSample } from './contract-enforcement.js';
it('never treats a Promise as a synchronous artifact producer and observes its rejection', async () => {
  const artifact = { cashflows: () => [] };
  expect(isSynchronousProducerSample(artifact)).toBe(true);
  for (const value of [null, undefined, 1, 'artifact'])
    expect(isSynchronousProducerSample(value)).toBe(false);
  expect(isSynchronousProducerSample(Promise.resolve(artifact))).toBe(false);
  expect(isSynchronousProducerSample(Promise.reject(new Error('synthetic rejected factory')))).toBe(
    false,
  );
  await setImmediate(); // An unobserved rejection would fail Vitest at this actual event-loop turn.
});

import { probeContractAsync } from './contract-probe.js';
import { InputError, ErrorCode } from '@insiderfinance/totalfinance/core';
it('awaits explicit async mutation fixtures and detects a single unknown-key liar', async () => {
  const fresh = () => [{ value: 1 }];
  const valid = async (input: unknown) => {
    await Promise.resolve();
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((k) => k !== 'value') ||
      typeof (input as { value?: unknown }).value !== 'number' ||
      !Number.isFinite((input as { value: number }).value)
    )
      throw new InputError('fixture: invalid control.', { code: ErrorCode.InputWrongShape });
    return 1;
  };
  const results = await probeContractAsync(valid, fresh);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every((r) => r.verdict === 'rejected')).toBe(true);
  const liar = async (input: unknown) => {
    const copy = { ...(input as object) };
    delete (copy as Record<string, unknown>)['qzxBogusKey'];
    return valid(copy);
  };
  const broken = await probeContractAsync(liar, fresh);
  expect(broken.find((r) => r.mutation === 'unknown-key')?.verdict).toBe('accepted');
});
