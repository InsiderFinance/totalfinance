import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';

/**
 * Cooperative yielding for long synchronous test work.
 *
 * A Vitest worker reports progress to the main process over RPC and gives each call 60 s to be
 * answered. A test that holds the worker's event loop longer than that fails the run even though
 * every assertion passed: the reply does arrive, but Node runs the overdue timeout before it reads
 * the reply, and the run ends on `[vitest-worker]: Timeout calling "onTaskUpdate"`. Whether a call
 * is in flight when the block starts is luck, which is why it shows up as an intermittent failure.
 *
 * Several suites are CPU-heavy by design (whole-library sweeps, lattice references, overflow
 * sweeps), and coverage instrumentation makes them about twice as slow on a hosted runner as on a
 * developer machine. Yielding every N items stops working as soon as the items get more expensive:
 * a batch of 25 records took 43 s locally and about twice that hosted. This yields on TIME. Call the
 * returned function in the loop and await it; it lets the event loop turn once the loop has held it
 * for `budgetMs`.
 *
 *     const relax = cooperativeYield();
 *     for (const item of items) {
 *       await relax();
 *       heavy(item);
 *     }
 *
 * The FIRST call settles instead: it waits `SETTLE_MS` so the reply to the progress RPC sent when the
 * test started is read before any heavy work begins. During a synchronous block nothing new is sent
 * (the runner's throttled sender is itself a timer), so with that reply in, even a single call that
 * cannot be split — one 25 s Crank–Nicolson pricing under coverage — has no RPC left to time out.
 *
 * The real timer and clock are imported, not read from globals, so a test that installs fake timers
 * cannot freeze the yield. `setImmediate` runs in the check phase, after pending I/O: the cheapest
 * turn that actually lets an RPC reply through.
 */
export function cooperativeYield(budgetMs = 500): () => Promise<void> {
  let since: number | undefined;
  return async () => {
    if (since === undefined) {
      await sleep(SETTLE_MS);
      since = performance.now();
      return;
    }
    if (performance.now() - since < budgetMs) return;
    await nextTurn();
    since = performance.now();
  };
}

/** Long enough for an idle main process to answer one RPC; short enough to be free per test. */
const SETTLE_MS = 25;
