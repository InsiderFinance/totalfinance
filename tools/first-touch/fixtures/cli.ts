/**
 * Stage 7A slice 3 — first-touch fixtures for `@totalfinance/cli`: the file stores over a fresh temp
 * directory, the profiles, and the job runner on an INLINE (non-job) operation so the probe never
 * spawns a worker. Thunks build FRESH inputs per call.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileArtifactStore,
  createFileJobStore,
  registryForProfile,
} from '@totalfinance/workflows/local';
import type { JobRecord } from '@totalfinance/workflows';
import { type FixtureThunk } from '../inputs.js';

const directory = () => mkdtempSync(join(tmpdir(), 'totalfinance-first-touch-'));
const clock = () => new Date().toISOString();

let jobSequence = 0;
/** A fresh id per call: a store mints an id once, and the probe repeats its valid call. */
const jobRecord = (): JobRecord => ({
  id: `job-fixture-${(jobSequence += 1)}`,
  operation: { id: 'totalfinance.option.price', version: '1' },
  state: 'accepted',
  progress: null,
  inputsHash: 'sha256:fixture',
  seed: null,
  submittedAt: '2026-09-03T14:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  usage: { elapsedMs: null },
});

const SHARED: Record<string, FixtureThunk> = {
  // The receivers the harness produces from the store factories are fresh stores; these are the
  // valid calls on them (an `update` of an unknown id is a typed refusal by design).
  'cli.ArtifactStore#put': () => [
    {
      value: { value: 1, assumptions: {}, diagnostics: { warnings: [] } },
      kind: 'report',
      createdTimestampMs: Date.parse('2026-09-03T14:00:00Z'),
    },
  ],
  'cli.JobStore#create': () => [jobRecord()],
  // The receiver harness synthesizes registryForProfile's first literal profile (backtesting).
  // Performance is available there as well as in the default registry; option pricing is not.
  'cli.OperationRegistry#run': () => [
    {
      id: 'totalfinance.performance.analyze',
      input: { returns: [0.01, -0.005, 0.02], periodsPerYear: 252 },
    },
  ],
  'cli.createFileArtifactStore': () => [{ directory: directory() }],
  'cli.createFileJobStore': () => [{ directory: directory() }],
  'cli.packsForProfile': () => ['default'],
  'cli.registryForProfile': () => [{ profile: 'options', packs: ['options'] }],
  'cli.submitJob': () => {
    const dir = directory();
    return [
      {
        registry: registryForProfile({ profile: 'default' }),
        jobs: createFileJobStore({ directory: dir }),
        artifacts: createFileArtifactStore({ directory: dir }),
        directory: dir,
        id: 'totalfinance.option.price',
        input: {
          type: 'call',
          spot: 100,
          strike: 105,
          timeToExpiryYears: 0.25,
          riskFreeRate: 0.04,
          volatility: 0.2,
        },
        profile: 'default',
        clock,
      },
    ];
  },
  'cli.cancelJob': () => {
    const dir = directory();
    const jobs = createFileJobStore({ directory: dir });
    const created = jobs.create(jobRecord());
    return [{ jobs, id: created.id, clock }];
  },
};

/**
 * The local runtime lives in `@totalfinance/workflows/local` (Stage 7A slice 5) and `@totalfinance/cli`
 * re-exports it: a fixture is a claim about the CALLABLE, so the shared heads are fixtured ONCE (the
 * harness pools a fixture across every public path of the same implementation) and only the
 * workflows-only heads — the runner binding and its contract — are added here.
 */
export const CLI_FIXTURES: Record<string, FixtureThunk> = {
  ...SHARED,
  'workflows.createLocalJobRunner': () => [
    {
      registry: registryForProfile({ profile: 'default' }),
      directory: directory(),
      profile: 'default',
      clock,
    },
  ],
  'workflows.JobRunner#submit': () => [
    {
      id: 'totalfinance.option.price',
      input: {
        type: 'call',
        spot: 100,
        strike: 105,
        timeToExpiryYears: 0.25,
        riskFreeRate: 0.04,
        volatility: 0.2,
      },
    },
  ],
  'workflows.JobRunner#get': () => ['job-missing'],
  'workflows.JobRunner#cancel': () => ['job-missing'],
};
