import { it } from 'vitest';
import { assertNumericalRepairs } from '../numerical-regression-consumer.js';
it('first-touch public calls repair numerical issues 16–24, LIB-04 and #37 and preserve ordinary calls', () =>
  assertNumericalRepairs());
