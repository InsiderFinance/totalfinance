import { it } from 'vitest';
import { assertNumericalRepairs } from '../numerical-regression-consumer.js';
it('first-touch public calls repair numerical issues 16–24 and preserve ordinary calls', () =>
  assertNumericalRepairs());
