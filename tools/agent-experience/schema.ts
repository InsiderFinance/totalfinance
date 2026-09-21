import { schema, type Infer } from '@totalfinance/core/schema';
import { REGISTRY_PROFILES, registryForProfile } from '@totalfinance/workflows/local';

const text = schema.string().nonempty().regex(/\S/);
const id = schema.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const count = schema.number().integer().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strings = schema.array(text);
const profile = schema.enum(REGISTRY_PROFILES);

export const CaseSchema = schema.object({
  id,
  category: schema.enum([
    'options',
    'strategies',
    'technical-analysis',
    'portfolio-pnl',
    'dcf',
    'research',
    'backtest',
    'handles',
    'live-data',
    'units',
    'permissions',
  ] as const),
  prompt: text,
  profile,
  attachments: strings,
  expected: schema.union([
    schema.object({ kind: schema.literal('tool'), acceptableToolIds: schema.array(text).min(1) }),
    schema.object({
      kind: schema.enum(['ask-for-input', 'refuse-live-data', 'refuse-permission'] as const),
    }),
  ]),
  successCriteria: schema.array(text).min(1),
});

export const CorpusSchema = schema.object({
  schemaVersion: schema.literal(1),
  version: text,
  description: text,
  // These are user-visible synthetic inputs, never hidden answers or transcript results.
  fixtures: schema.record(schema.unknown()),
  cases: schema.array(CaseSchema).min(1),
});

const judgment = schema.object({
  verdict: schema.enum(['pass', 'fail'] as const),
  evidence: schema.array(count).min(1),
  rationale: text,
});
const result = schema.object({
  status: schema.enum(['success', 'error', 'not-recorded'] as const),
  content: schema.unknown(),
});
const event = schema.union([
  schema.object({ type: schema.enum(['assistant', 'user'] as const), text }),
  schema.object({
    type: schema.literal('tool-call'),
    callId: text,
    toolId: text,
    // Preserve bad arguments. A raw, unparseable JSON argument string is recorded as a string.
    arguments: schema.unknown(),
    result,
  }),
  schema.object({
    type: schema.literal('protocol-call'),
    callId: text,
    method: schema.enum([
      'tools/list',
      'resources/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
    ] as const),
    arguments: schema.unknown(),
    result,
  }),
]);
const RunSchema = schema.object({
  caseId: id,
  profile,
  transcript: schema.array(event).min(1),
  annotator: text,
  outcome: schema.object({
    kind: schema.enum([
      'completed',
      'ask-for-input',
      'refuse-live-data',
      'refuse-permission',
      'failed',
    ] as const),
    evidence: schema.array(count).min(1),
    rationale: text,
  }),
  review: schema
    .object({
      completion: judgment.optional(),
      inventedData: judgment.optional(),
      safety: judgment.optional(),
    })
    .optional(),
  usage: schema.object({ calls: count.optional(), contextBytes: count.optional() }).optional(),
});

export const RecordedRunsSchema = schema.object({
  schemaVersion: schema.literal(1),
  corpusVersion: text,
  provenance: schema.object({
    kind: schema.enum(['external-agent', 'illustrative'] as const),
    agent: text,
    model: text,
    recordedAt: text,
    packageVersion: text,
    revision: text,
    source: text,
  }),
  runs: schema.array(RunSchema),
});

export type EvaluationCase = Infer<typeof CaseSchema>;
export type Corpus = Infer<typeof CorpusSchema>;
export type RecordedRuns = Infer<typeof RecordedRunsSchema>;
export type RecordedRun = Infer<typeof RunSchema>;
export type TranscriptEvent = RecordedRun['transcript'][number];

function fail(message: string): never {
  throw new Error(`agent-experience: ${message}`);
}

/** Also protects callers of the pure API (JSON.parse alone cannot reject 1e400). */
export function assertJson(value: unknown, path = '$', ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path}: nonfinite number`);
    return;
  }
  if (typeof value !== 'object') fail(`${path}: expected a JSON value`);
  if (ancestors.has(value)) fail(`${path}: cyclic value`);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    fail(`${path}: expected a plain JSON object`);
  }
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) assertJson(child, `${path}.${key}`, ancestors);
  if (Array.isArray(value) && Object.keys(value).length !== value.length)
    fail(`${path}: sparse array`);
  ancestors.delete(value);
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(`${path}: duplicate IDs/values`);
}

export function parseCorpus(value: unknown): Corpus {
  assertJson(value);
  const corpus = CorpusSchema.parse(value, { mode: 'strict' });
  unique(
    corpus.cases.map((entry) => entry.id),
    'corpus.cases',
  );
  unique(
    corpus.cases.map((entry) => entry.prompt.trim().replace(/\s+/g, ' ').toLowerCase()),
    'corpus prompts',
  );
  for (const entry of corpus.cases) {
    if (!entry.prompt.trim()) fail(`${entry.id}: blank prompt`);
    unique(entry.attachments, `${entry.id}.attachments`);
    for (const fixture of entry.attachments) {
      if (!Object.hasOwn(corpus.fixtures, fixture)) fail(`${entry.id}: unknown fixture ${fixture}`);
    }
    if (entry.expected.kind === 'tool') {
      unique(entry.expected.acceptableToolIds, `${entry.id}.acceptableToolIds`);
      const registry = registryForProfile({ profile: entry.profile });
      for (const toolId of entry.expected.acceptableToolIds) {
        const operation = registry.get(toolId);
        if (!operation) fail(`${entry.id}: unknown/unavailable tool ${toolId} in ${entry.profile}`);
        if (operation.sideEffect !== 'none' || operation.requiredCapabilities.length > 0) {
          fail(`${entry.id}: evaluation cases cannot require writes or grants`);
        }
      }
    }
  }
  return corpus;
}

export function parseRecordedRuns(value: unknown, corpusInput: unknown): RecordedRuns {
  const corpus = parseCorpus(corpusInput);
  assertJson(value);
  const recording = RecordedRunsSchema.parse(value, { mode: 'strict' });
  if (recording.corpusVersion !== corpus.version) fail('corpusVersion does not match the corpus');
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(recording.provenance.recordedAt) ||
    !Number.isFinite(Date.parse(recording.provenance.recordedAt))
  )
    fail('recordedAt must be a UTC ISO timestamp');
  if (
    new Date(recording.provenance.recordedAt).toISOString() !==
    recording.provenance.recordedAt.replace(
      /Z$/,
      recording.provenance.recordedAt.includes('.') ? 'Z' : '.000Z',
    )
  )
    fail('recordedAt is not a real calendar instant');
  unique(
    recording.runs.map((run) => run.caseId),
    'recorded runs',
  );
  const cases = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  for (const run of recording.runs) {
    const entry = cases.get(run.caseId);
    if (!entry) fail(`unknown case ID ${run.caseId}`);
    if (run.profile !== entry.profile) fail(`${run.caseId}: recorded profile differs from corpus`);
    const calls = run.transcript.filter(
      (item) => item.type === 'tool-call' || item.type === 'protocol-call',
    );
    unique(
      calls.map((call) => call.callId),
      `${run.caseId}.callId`,
    );
    // Unknown tool IDs are valid model mistakes, not invalid case identifiers.
    // Do not drop them: the scorer fails their selection/schema checks.
    for (const call of calls) {
      if (!Object.hasOwn(call, 'arguments') || !Object.hasOwn(call.result, 'content'))
        fail(`${run.caseId}: call needs arguments and recorded result content`);
      if (call.result.status === 'not-recorded' && call.result.content !== null)
        fail(`${run.caseId}: not-recorded content must be null`);
      if (call.result.status !== 'not-recorded' && call.result.content === null)
        fail(`${run.caseId}: recorded result needs non-null content`);
    }
    if (run.usage?.calls !== undefined && run.usage.calls !== calls.length)
      fail(`${run.caseId}: usage.calls must equal all recorded tool + protocol calls`);
    const checkEvidence = (indices: number[], field: string, assistantRequired: boolean): void => {
      unique(indices.map(String), `${run.caseId}.${field}.evidence`);
      for (const index of indices)
        if (index >= run.transcript.length)
          fail(`${run.caseId}.${field}: evidence index out of range`);
      if (
        assistantRequired &&
        !indices.some((index) => run.transcript[index]?.type === 'assistant')
      )
        fail(`${run.caseId}.${field}: needs assistant evidence`);
    };
    checkEvidence(run.outcome.evidence, 'outcome', true);
    for (const [field, assessment] of Object.entries(run.review ?? {})) {
      checkEvidence(assessment.evidence, field, field === 'completion');
      if (!assessment.rationale.trim()) fail(`${run.caseId}.${field}: blank rationale`);
    }
  }
  return recording;
}
