import { afterEach } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';

/**
 * One event-loop turn after every test (a `setupFiles` entry in vitest.config.ts).
 *
 * Vitest can run a file's synchronous tests back to back without letting the event loop turn, so a
 * run of individually quick tests holds the worker as long as one long test would: 34 s locally in
 * hardening-engines, enough on a hosted runner to time out the worker's progress RPC
 * (`Timeout calling "onTaskUpdate"`, see cooperative-yield.ts). Yielding here bounds a block by the
 * longest single test; tests that are long on their own yield inside with `cooperativeYield`.
 *
 * The real `setImmediate` is imported, so fake timers in a test cannot freeze this hook.
 */
afterEach(async () => {
  await nextTurn();
});
