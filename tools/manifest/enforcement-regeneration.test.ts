/**
 * Phase 3B.0 gates for the enforcement record, the two that regenerate it:
 *
 *   - DRIFT: the committed record must equal a fresh generation, by id set and by verdict.
 *   - DETERMINISM: two independent generations must be byte-identical, evidence and summary included.
 *
 * Split out of `contract-conformance.test.ts` (2026-10-06). A test file runs on one worker, and these
 * two tests were most of that file's 331 seconds in hosted CI, so together they set a floor under the
 * shard that ran them. Apart, the rest of the inventory gates and these run on different workers.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { type buildEnforcementRecord } from './contract-enforcement.js';
import { GLOBAL_STATE_BOUNDARIES } from './contract-policy.js';

/**
 * Budget for a test that regenerates the enforcement record IN PROCESS.
 *
 * One full generation was roughly 190 seconds with callback synthesis on when this bound was set, and
 * the tests below run one or two. The point is that the bound covers a KNOWN number of generations
 * rather than an accumulating one, which is what let a 600-second bound quietly become too small.
 * Re-measured 2026-09-16 (5,318 candidates): one generation is ~360 seconds in isolation and ran past
 * 2,200 seconds inside `pnpm run ci` (coverage instrumentation plus the rest of the suite in parallel),
 * so 1,200 seconds no longer covered the same one-to-two generations. 2,400 seconds does; the CI job
 * timeout remains the real backstop. Re-measured 2026-10-06, after `unionSites` was remembered per
 * declaration: one generation is ~75 seconds in isolation and the record is byte-identical. The bound
 * stays where it is, because it is a hang backstop rather than a target.
 */
const ENFORCEMENT_BUDGET_MS = 2_400_000;

/**
 * Generate the enforcement record in a FRESH PROCESS and read it back.
 *
 * Nothing here generates in-process any more. A hosted run took 44–52 minutes and needed an 8 GB heap
 * because the coverage-instrumented worker ran the generator two and three times; now it reads a file
 * and compares a hash. `enforcement-run.ts` explains the other two reasons this shape is right —
 * isolation between generations, and a digest over the whole record rather than verdicts alone.
 *
 * ASYNCHRONOUS, and the first attempt was not — which starved the very thing the generator's own
 * `setImmediate` yield exists to protect. `execFileSync` blocks the calling worker's event loop for
 * the whole three minutes the child runs, so the reporter's heartbeat never fires and vitest ends the
 * run on `Timeout calling "onTaskUpdate"` with every test passing. Moving work to another process does
 * not help if you then block waiting for it.
 *
 * The file needs two generations, and they START TOGETHER. The drift gate needs one, and the
 * determinism check needs a second, independent one to compare against. Each runs in its own process,
 * so started together the pair costs one generation of wall time rather than two: this file was the
 * longest single file in hosted CI, and a test file runs on one worker, so its length was the floor
 * under the whole suite's. One generation peaked near 900 MB resident on Node 22.23.2 / Apple M4
 * (measured 2026-10-06), suggesting room for the pair on the 16 GB hosted runner. That is not a
 * bound for other Node versions or machines; the full hosted matrix remains the memory gate.
 * Sharing the results is safe here — unlike the in-process version this once replaced — because
 * what is retained is a parsed record and a hash, not a live module graph.
 */
type EnforcementRun = {
  record: Awaited<ReturnType<typeof buildEnforcementRecord>>;
  digest: string;
};
/**
 * The pull-request check runs ONE generation (Trey, 2026-10-06: fast checks on pull requests while
 * the maintainers are the only contributors). CI sets TOTALFINANCE_PR_CHECKS=1 on pull requests
 * only: the drift gate still compares a fresh generation with the committed record, and the clean-
 * checkout `regen:check` job still diffs it byte for byte, but the second, independent generation the
 * determinism check needs waits for `main` and the daily run. Every local run does both.
 */
const PR_CHECKS = process.env['TOTALFINANCE_PR_CHECKS'] === '1';
let bothRuns: Promise<[EnforcementRun, EnforcementRun]> | null = null;
let firstOnly: Promise<EnforcementRun> | null = null;
function enforcementRuns(): Promise<[EnforcementRun, EnforcementRun]> {
  bothRuns ??= Promise.all([generateEnforcement(), generateEnforcement()]);
  return bothRuns;
}
function enforcementOnce(): Promise<EnforcementRun> {
  if (PR_CHECKS) return (firstOnly ??= generateEnforcement());
  return enforcementRuns().then(([first]) => first);
}

async function generateEnforcement(): Promise<EnforcementRun> {
  const output = resolve(tmpdir(), `totalfinance-enforcement-${randomUUID()}.json`);
  try {
    const { stdout } = await execFile(
      'npx',
      ['tsx', resolve(ROOT, 'tools/manifest/enforcement-run.ts'), output],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        /**
         * THE HEAP BELONGS TO THE CHILD, which is where the generation now happens.
         *
         * `vitest.config.ts` raises it for the pooled worker, and that stopped reaching the memory
         * once the work moved out of process — Node 26 promptly ran out inside `enforcement-run.ts`
         * instead. A generation imports the whole library, resolves ~4,000 callables and constructs
         * receivers; the default 4 GB is genuinely not enough for it on Node 26.
         */
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
      },
    );
    return {
      record: JSON.parse(readFileSync(output, 'utf8')) as Awaited<
        ReturnType<typeof buildEnforcementRecord>
      >,
      digest: stdout.trim(),
    };
  } finally {
    rmSync(output, { force: true });
  }
}

/**
 * PEAK retention is what matters, not total work — and a memo made it worse.
 *
 * Each `buildEnforcementRecord()` retains a 4,342-record graph plus every module it resolved, with
 * istanbul instrumenting all of it. Two ALIVE AT ONCE exhausts Node's default 4 GB heap:
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`, reported by a reviewer on Node 26 and
 * reproduced here.
 *
 * A shared lazy generation was the obvious fix and the wrong one: memoizing keeps the first record
 * reachable for the lifetime of the file, so the determinism check still had two alive. What works is
 * the opposite — hold NOTHING across a generation. The determinism check reduces its first record to
 * the comparable string it actually needs and drops the reference before generating the second, so
 * peak retention is one record however many are produced.
 *
 * `pnpm run ci` under coverage on Node 26 with the stock heap is the test of record for this.
 */

const execFile = promisify(execFileCallback);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('enforcement record regeneration (Phase 3B.0)', () => {
  it(
    'the enforcement artifact regenerates identically and matches by ID SET, not by count',
    async () => {
      /**
       * The first version of this gate checked a COUNT, a verdict vocabulary, and an evidence shape. A
       * removed path replaced by a different one would have passed it. So: regenerate, and compare the
       * exact id sets and every verdict.
       */
      const committedRecord = JSON.parse(
        readFileSync(resolve(ROOT, 'tools/manifest/public-enforcement.json'), 'utf8'),
      ) as {
        summary: Record<string, unknown>;
        enforcement: {
          id: string;
          verdict: string;
          package?: string;
          implementation?: string;
          guardReachability?: string;
          unmeasuredReason?: string;
          rejection?: { code: string };
          undecided?: string[];
          inputPolicies?: Record<string, string>;
          failures?: {
            mutation: string;
            field?: string;
            verdict: string;
            argumentIndex?: number;
          }[];
          advisory?: {
            mutation: string;
            field?: string;
            verdict: string;
            argumentIndex?: number;
          }[];
        }[];
        mcpTools: { id: string; inputSchemaHash: string | null; outputSchemaHash: string | null }[];
      };
      const live = (await enforcementOnce()).record;

      const committedIds = committedRecord.enforcement.map((record) => record.id).sort();
      const liveIds = live.enforcement.map((record) => record.id).sort();
      const missing = committedIds.filter((id) => !liveIds.includes(id));
      const added = liveIds.filter((id) => !committedIds.includes(id));
      expect(
        { missing: missing.slice(0, 10), added: added.slice(0, 10) },
        'the enforcement record has drifted — run `pnpm enforcement:update`',
      ).toEqual({ missing: [], added: [] });

      const committedVerdicts = new Map(
        committedRecord.enforcement.map((record) => [record.id, record.verdict]),
      );
      /**
       * VERDICTS, exactly — and the history of this line is the reason it is now exact.
       *
       * It read `<= 4` for a cause that was real when written: enforcement generation ran INSIDE the
       * vitest process, where `@totalfinance/*` resolves through the alias map to SOURCE, while
       * `pnpm enforcement:update` resolved through `package.json` exports to the BUILT dist. A family of
       * TA transforms are thin wrappers over one stateful runtime function, and the two graphs disagreed
       * about which member of a pair carried the evidence. No gate could argue that away, so it ratcheted
       * the skew instead.
       *
       * 3B.0 then moved generation into a subprocess (`execFile` → `tsx tools/manifest/enforcement-run.ts`)
       * to fix heap exhaustion — and that subprocess resolves to dist, the same graph the committed
       * artifact is generated from. The premise dissolved; the tolerance outlived it. That is the shape
       * worth naming: not a stale comment, but a gate that went on permitting four verdict regressions
       * after the thing it was forgiving had ceased to exist. Zero here is not aspiration — fresh vs
       * committed was measured byte-identical before this bound was tightened.
       */
      const verdictDrift = live.enforcement
        .filter((record) => committedVerdicts.get(record.id) !== record.verdict)
        .map((record) => `${record.id}: ${committedVerdicts.get(record.id)} -> ${record.verdict}`);
      expect(
        verdictDrift,
        `the enforcement record has drifted — run \`pnpm enforcement:update\`:\n${verdictDrift.slice(0, 16).join('\n')}`,
      ).toEqual([]);

      /**
       * The SUMMARY, exactly — and this was the last hole in the chain.
       *
       * Three gates existed and none of them closed the loop. The header gate compares PROSE to the
       * COMMITTED artifact. The determinism gate compares a fresh run to another FRESH run. This gate
       * compared fresh ids and evidence to the committed record. Nothing compared the fresh SUMMARY to
       * the committed summary — so a stale artifact whose counts were internally consistent, paired
       * with prose stale in the same direction, passed all 39 conformance tests. Demonstrated before
       * fixing: setting the committed `enforced` to 956 and `partial` to 1,553 (sum preserved, ratchet
       * satisfied) and editing the header to match went green.
       *
       * The header being gated against the artifact is only worth something if the artifact is gated
       * against a fresh generation. Otherwise the two agree with each other about a fiction.
       */
      expect(
        live.summary,
        `the committed enforcement summary does not match a fresh generation — run ` +
          `\`pnpm enforcement:update\` and refresh any prose that quotes it`,
      ).toEqual(committedRecord.summary);

      /**
       * The full record, not just the verdict — R13.
       *
       * Comparing ids and verdicts alone let everything that EXPLAINS a verdict drift silently: which
       * mutation convicted a path, which dimension is undecided, why a path was not measured, which key
       * policy it was judged under. A record could keep its verdict and change its entire meaning, and
       * that meaning is exactly what an implementing agent reads to decide what to fix.
       *
       * `returned` is deliberately excluded: it captures a value the call produced, and the matrix runs
       * three Node majors, so last-bit floating-point differences are legitimate there. The CLAIM —
       * mutation, field, verdict — is what must not move.
       */
      const shape = (record: {
        id: string;
        package?: string;
        implementation?: string;
        guardReachability?: string;
        unmeasuredReason?: string;
        rejection?: { code: string };
        undecided?: string[];
        inputPolicies?: Record<string, string>;
        failures?: { mutation: string; field?: string; verdict: string; argumentIndex?: number }[];
        advisory?: { mutation: string; field?: string; verdict: string; argumentIndex?: number }[];
      }): string => {
        const claims = (results: typeof record.failures): string[] =>
          (results ?? [])
            .map((r) => `${r.mutation}/${r.argumentIndex ?? ''}/${r.field ?? ''}/${r.verdict}`)
            .sort();
        return JSON.stringify({
          package: record.package,
          implementation: record.implementation,
          guardReachability: record.guardReachability,
          unmeasuredReason: record.unmeasuredReason ?? null,
          // The rejection CODE, not its message: a code changing is a contract changing, while the
          // message may legitimately quote a value.
          rejectionCode: record.rejection?.code ?? null,
          undecided: [...(record.undecided ?? [])].sort(),
          inputPolicies: record.inputPolicies ?? null,
          failures: claims(record.failures),
          advisory: claims(record.advisory),
        });
      };
      const committedShapes = new Map(
        committedRecord.enforcement.map((record) => [record.id, shape(record)]),
      );
      const shapeDrift = live.enforcement
        .filter((record) => committedShapes.get(record.id) !== shape(record))
        .map((record) => record.id);
      /**
       * EVIDENCE, exactly — the permutation allowance is gone for the same reason as the verdict bound.
       *
       * It asserted only that the MULTISET of evidence over the drifting ids was unchanged: nothing new,
       * nothing vanished, the same claims landing on different ids. That was a genuinely better gate than
       * "at most N" while two module graphs were in play, because a stateful pair really did swap evidence
       * between them and a count could not tell a swap from a new disagreement.
       *
       * With one graph on both sides, no mechanism remains that moves a claim from one id to another. An
       * allowance whose mechanism is gone does not sit idle — it becomes the space an unknown defect fits
       * into undetected, which is precisely what it was built to prevent.
       */
      expect(
        shapeDrift,
        `enforcement evidence has drifted — a verdict can survive while everything that EXPLAINS it ` +
          `moves. Run \`pnpm enforcement:update\` and read the diff:\n${shapeDrift.slice(0, 12).join('\n')}`,
      ).toEqual([]);

      /**
       * The GLOBAL-STATE exemption must stay honest: every boundary it excuses must actually be measured
       * on the first pass. A name here that is unmeasured anyway is hiding behind the exemption.
       */
      const idle = Object.keys(GLOBAL_STATE_BOUNDARIES).filter(
        (id) => live.enforcement.find((record) => record.id === id)?.verdict === 'unmeasured',
      );
      expect(
        idle,
        `declared as global-state boundaries but unmeasured — the exemption is doing nothing:\n${idle.join('\n')}`,
      ).toEqual([]);

      // MCP parity: the live registry and the recorded contracts must name the same tools.
      expect(live.mcpTools.map((tool) => tool.id).sort()).toEqual(
        committedRecord.mcpTools.map((tool) => tool.id).sort(),
      );

      /**
       * And the same SCHEMAS — R13.
       *
       * Comparing tool ids alone meant an input schema could gain a required field, lose a property, or
       * flip `additionalProperties` while the gate stayed green. These are wire contracts an agent codes
       * against; the id is the least interesting part of them. The hashes are recorded for exactly this
       * comparison, so a schema change shows up as one line rather than a hundred.
       */
      const committedSchemas = new Map(
        committedRecord.mcpTools.map((tool) => [
          tool.id,
          `${tool.inputSchemaHash ?? '-'}/${tool.outputSchemaHash ?? '-'}`,
        ]),
      );
      const schemaDrift = live.mcpTools
        .filter(
          (tool) =>
            committedSchemas.get(tool.id) !==
            `${tool.inputSchemaHash ?? '-'}/${tool.outputSchemaHash ?? '-'}`,
        )
        .map((tool) => tool.id);
      expect(
        schemaDrift,
        `an MCP tool's published JSON Schema changed without the artifact being regenerated — run ` +
          `\`pnpm enforcement:update\`:\n${schemaDrift.join('\n')}`,
      ).toEqual([]);

      // Every tool must actually HAVE a canonical schema; a null hash is a tool whose contract is
      // unpublished, which is the state R8 existed to remove.
      expect(
        live.mcpTools.filter((tool) => tool.inputSchemaHash === null).map((t) => t.id),
      ).toEqual([]);
      /**
       * Five minutes, not two. This test generates the enforcement record TWICE — once against the
       * committed artifact and once to prove determinism — and R11's depth roughly doubled the probe
       * count per boundary. Under istanbul instrumentation that crossed 120s and timed out at 139,967ms:
       * a real cost increase, not a hang, so the budget follows the work rather than the work being
       * trimmed to fit the budget. `measure-supervisor.ts` is what catches an actual hang.
       *
       * Ten minutes now, not five. A full generation was 8s before R10 and R11; it is 46s after, because
       * the declaration join gave thousands more contracts their real shape and the probe stopped
       * stopping at the top level. This test runs two of them, and istanbul instrumentation multiplies
       * that again. Measured, not guessed: the direct generator path was timed at 46.0s to confirm the
       * cost is depth rather than a hang.
       */
    },
    ENFORCEMENT_BUDGET_MS,
  );

  it.skipIf(PR_CHECKS)(
    'the enforcement generator is deterministic within one process',
    async () => {
      /**
       * SPLIT OUT of the drift gate, and the reason is the same mistake twice.
       *
       * That gate ran two full in-process generations under ONE budget. Each is about 190 seconds now
       * that callback synthesis is on, so the pair sat just under a 600-second bound on the development
       * machine and blew straight through it on Node 22.13 — the MINIMUM version this package claims to
       * support, which nothing had ever run. The failure read `Test timed out`, which says nothing about
       * the library and everything about the harness.
       *
       * It is the identical error I had just fixed in `measure-supervisor.ts`: a fixed time budget over a
       * workload that grows every time the measurement improves. One generation per test is the shape
       * that does not rot — the budget then bounds a known quantity instead of an accumulating one, and
       * the CI job timeout is the real backstop.
       *
       * EXCEPT where the boundary writes global state. `register(entry)` adds to the process-global
       * indicator registry, so a second measurement replays identities into a registry that already
       * holds them and is correctly refused. A fact about the library, not a gap here — the committed
       * artifact comes from a single pass and reproduces byte-for-byte across processes, which the drift
       * gate above already proves. Excluded by NAME from a curated list so the exemption cannot quietly
       * grow to cover a real non-determinism.
       */
      const [first, second] = await enforcementRuns();
      expect(
        first.digest,
        `two independent generations of the enforcement record disagree. The digest covers the FULL ` +
          `record — verdicts, evidence and summary — so this is a real difference in what was ` +
          `measured, not a formatting one.`,
      ).toBe(second.digest);
    },
    ENFORCEMENT_BUDGET_MS,
  );
});
