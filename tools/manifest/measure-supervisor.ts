/**
 * Run the enforcement generator under a PER-BOUNDARY budget, and survive a call that does not return.
 *
 * The generator executes real library code with synthesized inputs, and some of that code does not
 * terminate on some inputs. Both known cases were found by this supervisor and are now fixed at the
 * source rather than worked around here, which is the outcome to aim for:
 *
 *     normalSample     `while (u1 === 0) u1 = rng.next()` — a CONSTANT stub never exits. Fixed by
 *                      giving nullary numeric callbacks a varying sequence, which is what an RNG is.
 *     adaptiveSimpson  a NaN bound makes the error estimate NaN, every comparison with NaN is false,
 *                      so the tolerance exit is unreachable and only depth exhaustion remains — 2^50
 *                      evaluations. Fixed IN THE LIBRARY: bounds are now guarded, and the work is
 *                      bounded by evaluations rather than by tree height.
 *
 * Why this needs a separate PROCESS. Synchronous JavaScript cannot be interrupted from inside itself:
 * a `setTimeout` watchdog never fires while the call it is watching is still on the stack. The
 * hanging process cannot skip the call and carry on. Something outside it has to kill it.
 *
 * So the supervisor kills, notes which boundary was in flight, and RESTARTS with that boundary on a
 * skip list. The artifact still gets produced, with the offending boundary recorded as
 * `probe-timeout` rather than silently absent — before this, one non-terminating call took the whole
 * pass down and produced no artifact at all, hiding 4,341 good measurements behind one bad one.
 *
 * The budget is per BOUNDARY (see `BOUNDARY_BUDGET_MS`), because a per-RUN budget has to be re-tuned
 * every time the harness gets better and silently corrupts the artifact when it is not.
 *
 * What it still does NOT do: give each boundary a fresh module realm. Successive probes against one
 * stateful target can still influence each other, and fixing that needs isolation per boundary rather
 * than per run. The way it used to SHOW — `stoch`/`stochastic` and `bb`/`bbands` landing on different
 * verdicts — is gone, because measurement is now canonical per (function object, contract) and those
 * names are probed once. That removed the symptom, not the cause; do not read the quiet as isolation.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NON_TERMINATING_BOUNDARIES } from './contract-policy.js';

const GENERATOR = fileURLToPath(new URL('./contract-enforcement.ts', import.meta.url));

/**
 * PER BOUNDARY, not per run — the timer resets on every `__QK_MEASURING` trace.
 *
 * It was a whole-run budget, and that is unstable by construction: the bound has to exceed a healthy
 * full pass, and a healthy full pass gets slower every time the harness learns to measure more. It
 * broke exactly that way. Enabling callback synthesis took the pass from 76s to 106s, sailed past the
 * 90s bound, and the supervisor killed five arbitrary boundaries mid-flight and recorded them
 * `probe-timeout` — so two runs of a deterministic generator disagreed, which is worse than either
 * answer, because the artifact stopped being reproducible for a reason unrelated to any hang.
 *
 * "No single boundary may take longer than this" is a property of the library, not of the workload,
 * so it does not drift as coverage grows the way a whole-run budget did.
 *
 * 300 seconds, and BOTH earlier values were wrong the same way: this bounds a whole PROBE BATCH, not
 * a call. 20s convicted `swapXva`, which terminates. 90s convicted `maxSharpe`, which also
 * terminates — and that one is measured rather than argued:
 *
 *     boundary                        wall clock
 *     @totalfinance/risk:maxSharpe            158.2s
 *     @totalfinance/risk:kelly                  1.0s
 *     @totalfinance/risk:meanVariance           1.0s
 *     …every other boundary                <1.0s
 *     whole pass                            167s
 *
 * One boundary is 95% of the pass, and legitimately so: `maxSharpe` declares
 * `transactionCosts.perUnitTurnover`, and until the union arms were recorded the harness could only
 * hand it an ARRAY of the wrong length, which the boundary rejected in a millisecond. Now that the
 * scalar arm exists, every probe reaches a 5,000-iteration projected-gradient solve over the
 * synthesized 60-asset covariance. Roughly a hundred probes at ~1.5s each is where 158s comes from.
 *
 * So the cost is the price of measuring something that was never measured, not a regression to undo.
 * The bound sits at ~1.9x the measured maximum. It is a HANG detector: a real hang is unbounded, so
 * any finite budget catches it, and the only thing a larger budget costs is the wait on a genuine
 * hang — once. A budget tight enough to catch a hang quickly is also tight enough to manufacture
 * one, and a manufactured one is far more expensive: it makes the artifact depend on machine speed,
 * because the in-process drift gate has no supervisor and therefore never skips.
 *
 * If this needs raising again, re-measure first — the table above is the number this guards, and a
 * bound that has drifted away from its measurement is the failure this repository keeps finding.
 */
const BOUNDARY_BUDGET_MS = Number(process.env['TOTALFINANCE_MEASURE_BUDGET_MS'] ?? 300_000);

/**
 * How long to wait for the FIRST trace. Module loading and resolution happen before any boundary is
 * measured, and that is legitimately slower than any single boundary.
 */
const STARTUP_BUDGET_MS = Number(process.env['TOTALFINANCE_MEASURE_STARTUP_MS'] ?? 120_000);

/**
 * How many hanging boundaries to skip before giving up.
 *
 * A bound rather than a `while (true)`: if every restart finds a new hang, the right answer is to
 * stop and say so, not to grind through thousands of re-runs discovering that synthesis is broken.
 */
const MAX_SKIPS = Number(process.env['TOTALFINANCE_MAX_SKIPS'] ?? 12);

interface Attempt {
  timedOut: boolean;
  inFlight: string | null;
  code: number | null;
}

function runGenerator(skip: readonly string[]): Promise<Attempt> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', GENERATOR], {
      stdio: ['ignore', 'inherit', 'pipe'],
      env: {
        ...process.env,
        TOTALFINANCE_MEASURE_TRACE: '1',
        TOTALFINANCE_SKIP_BOUNDARIES: skip.join(','),
      },
      // Its own process GROUP. `npx` is a wrapper and the generator is its GRANDchild, so
      // `child.kill()` reaches only the wrapper — the run then continues, orphaned, and writes the
      // artifact anyway while the budget reports a kill it never performed.
      detached: true,
    });

    let inFlight: string | null = null;
    let buffered = '';
    let timer: NodeJS.Timeout;

    const expire = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolve({ timedOut: true, inFlight, code: null });
    };
    /** Restart the clock. Called on every trace, so the budget applies to ONE boundary at a time. */
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(expire, ms);
    };
    arm(STARTUP_BUDGET_MS);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const trace = /^__QK_MEASURING (.+)$/.exec(line);
        if (trace) {
          inFlight = trace[1]!;
          arm(BOUNDARY_BUDGET_MS);
        } else if (line.trim() !== '') process.stderr.write(`${line}\n`);
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // A signalled exit is never success, whatever the code says.
      resolve({ timedOut: false, inFlight, code: signal !== null ? 1 : (code ?? 0) });
    });
  });
}

/**
 * SEEDED from the curated list, so the artifact does not depend on how fast this machine is.
 *
 * Detection still runs, as a tripwire: a hang that is not named in the policy gets skipped so the
 * pass completes, and the conformance gate then FAILS on it. Discovery without a commitment is how an
 * artifact quietly starts varying by machine.
 */
const skip: string[] = Object.keys(NON_TERMINATING_BOUNDARIES).sort();
for (;;) {
  const attempt = await runGenerator(skip);

  if (!attempt.timedOut) {
    const discovered = skip.filter((id) => !(id in NON_TERMINATING_BOUNDARIES));
    if (discovered.length > 0) {
      process.stderr.write(
        `\nenforcement completed with ${discovered.length} UNDECLARED non-terminating boundary(ies):\n` +
          discovered.map((id) => `    ${id}`).join('\n') +
          `\nEach is recorded \`unmeasured\` with reason \`probe-timeout\`, and the conformance gate ` +
          `will FAIL until each is either fixed at the source or added to ` +
          `\`NON_TERMINATING_BOUNDARIES\` with what was measured.\n`,
      );
    }
    process.exitCode = attempt.code ?? 0;
    break;
  }

  if (attempt.inFlight === null) {
    process.stderr.write(
      `\nenforcement exceeded ${STARTUP_BUDGET_MS} ms before reaching its first boundary; nothing to skip.\n`,
    );
    process.exitCode = 1;
    break;
  }

  if (skip.length >= MAX_SKIPS) {
    process.stderr.write(
      `\ngave up after skipping ${MAX_SKIPS} boundaries — the last was ${attempt.inFlight}.\n` +
        `That many non-terminating calls means the synthesis is wrong, not that the library is.\n`,
    );
    process.exitCode = 1;
    break;
  }

  process.stderr.write(
    `\n${attempt.inFlight} did not return within ${BOUNDARY_BUDGET_MS} ms; skipping it and restarting.\n`,
  );
  skip.push(attempt.inFlight);
}
