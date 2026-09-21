# Agent-experience evaluation

This directory maintains **110 natural-language MCP cases** and an offline scorer for
recorded external-agent transcripts. It does not run a model, authenticate a provider,
execute transcript calls, replay writes, access stores, or publish benchmark results.
Deterministic tests validate this tooling and synthetic inputs, **not model performance**.

## Integration

From the TotalFinance repository root, with existing workspace dependencies installed:

```sh
pnpm agents:score /absolute/path/to/recorded-runs.json
./node_modules/.bin/tsx tools/agent-experience/cli.ts tools/agent-experience/corpus.json /absolute/path/to/recorded-runs.json
./node_modules/.bin/vitest run tools/agent-experience/scorer.test.ts
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

The CLI accepts exactly a corpus JSON file and a recorded-run JSON file. It writes its
JSON report to stdout, errors to stderr, and returns 0 for a successfully scored document
(even with failures or missing cases), or 2 for invalid input/I/O/usage. `--help` is supported.
The `agents:score` package script supplies the maintained corpus path; the direct CLI also supports
an explicitly versioned alternative corpus. There is no network, credential setup, model launcher,
or implicit report file.
The repository's normal Vitest and TypeScript includes already cover this directory.

For an explicitly synthetic schema smoke check only:

```sh
./node_modules/.bin/tsx tools/agent-experience/cli.ts tools/agent-experience/corpus.json tools/agent-experience/examples/illustrative-recording.json
```

That file contains **one hand-authored illustrative record**, not an external execution.
Its report stays labeled `illustrative`; never cite its arithmetic as measured model results.
No model-dependent benchmark has been performed as part of this implementation.

The pure API is exported by `index.ts`: `parseCorpus(unknown)`,
`parseRecordedRuns(unknown, corpus)`, `scoreRecordedRuns(corpus, recordings)`,
`validateArguments(profile, toolId, arguments)`, and `assertJson(unknown)`.
Runtime schema objects and inferred TypeScript interfaces are also exported.
Only `cli.ts` does file I/O. Importing it does not invoke the CLI.

## Corpus schema and maintenance

`corpus.json` is the maintained source of truth. It has `schemaVersion: 1`, a revision
`version`, a setup `description`, a `fixtures` object, and a nonempty `cases` array.
Each case has:

| Field             | Meaning                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | Stable semantic ID; unique lower-case dot/hyphen-separated segments. Never recycle an ID for a different task.                                      |
| `category`        | Options, strategies, TA, portfolio/P&L, DCF, research, backtest, handles, live-data limits, units, or permissions; exact spellings in `CaseSchema`. |
| `prompt`          | Natural task, not a request naming the tool to select.                                                                                              |
| `profile`         | Exact name from the maintained workflow profile registry; no extra packs.                                                                           |
| `attachments`     | Names in `fixtures` to expose as user input alongside the prompt. Empty means no attachments.                                                       |
| `expected`        | `{ kind: "tool", acceptableToolIds: string[] }`, or a kind of `ask-for-input`, `refuse-live-data`, or `refuse-permission`.                          |
| `successCriteria` | Reviewer checklist for task completion, units, assumptions, limitations, and honesty.                                                               |

All fixture numbers are **synthetic, not live observations**. The company input is an
explicit ex-post valuation scenario, not proof of historically available information.
The research fixture deliberately includes a future observation and a missing value.
Tests verify fixture calculations only through read-only operations with no required grants.

Maintain IDs, change `version` when prompts/fixtures/criteria/expectations change, and
retain the exact corpus, code revision, installed package version and recording together.
Tests check minimum size, category coverage, exact/number-normalized prompt duplication,
tool-ID leakage in prompts, and whether expected tools actually exist in the stated profile.
Those checks assist editorial review; they cannot prove semantic diversity automatically.
Do not turn a missing execution into a removed corpus case. A separately designed subset
needs its own corpus version and must be described as a different evaluation, not compared
as though it covered this entire corpus.

## Recording an external evaluation

1. Freeze corpus/version and code/package revision. Use one external agent/model configuration
   per recording document, and one fresh session per case. For repeated trials use separate
   documents; duplicate case IDs in a document are rejected, not treated as best-of-N attempts.
2. Configure the exact profile, normal read/analyze/propose defaults, **no additional grants**,
   no writable stores, no external tools/data providers and no live broker. A `full` profile
   is discovery, not authorization. Handle cases intentionally lack resolvable stores/data.
   Run permission probes only against this restricted environment, never real accounts.
3. Give the agent the case prompt and labeled referenced attachments. Keep expected tools,
   criteria and reviewer annotations hidden. A harness may prepend the corpus setup description.
   Record all agent-visible clarifications and every tool/protocol call, including failures,
   discovery and retries. Do not insert idealized replacement calls into the transcript.
4. Normalize the real transcript into the schema below, retaining result payloads and the original
   source recording. Use a named independent annotator to classify the final outcome and review
   every criterion against the actual inputs, calls, results and answer. This is an evidence-backed
   human/external-review workflow, not keyword-based automatic grading of financial prose.
5. Score the full corpus against the recording. Missing executions and missing reviews remain
   visible. Report coverage and every metric separately with the declared recording provenance.
   Do not claim an overall pass, a model benchmark, or safety from unit tests or absent reviews.

The scorer checks record structure, not the authenticity of the agent/model/source claims.
Do not relabel illustrative or unit fixtures as `external-agent`.

## Recorded-run JSON schema

The root has `schemaVersion: 1`, `corpusVersion` matching the supplied corpus, `provenance`,
and `runs` (possibly empty for an entirely unrecorded corpus).

`provenance` requires nonblank `kind` (`external-agent` or `illustrative`), `agent`, `model`,
`recordedAt` (real UTC ISO instant, seconds or millisecond precision), `packageVersion`,
`revision`, and `source` (traceable original recording identity). For `kind`, the enum takes
precedence over the general nonblank-string requirement.

Each run requires `caseId`, matching `profile`, nonempty `transcript`, named `annotator`,
and `outcome`. Optional `review` and `usage` have no silent defaults.

Transcript events are chronological normalized call/result pairs or messages:

```ts
type Result = {
  status: 'success' | 'error' | 'not-recorded';
  content: JsonValue; // actual payload; only not-recorded uses null
};
type Event =
  | { type: 'assistant' | 'user'; text: string }
  | { type: 'tool-call'; callId: string; toolId: string; arguments: JsonValue; result: Result }
  | {
      type: 'protocol-call';
      callId: string;
      method: 'tools/list' | 'resources/list' | 'resources/read' | 'prompts/list' | 'prompts/get';
      arguments: JsonValue;
      result: Result;
    };
```

Preserve invocation order if calls were parallel; pair each result with its actual call.
For valid JSON argument text, record its decoded JSON value. For unparseable JSON argument
text, preserve the raw text as a string: the tool schema will fail it. Do not repair arguments
in the recorder. Unknown/hallucinated **tool IDs** are valid recording data and score as
failures; unknown **case IDs** are invalid input. An unavailable tool still uses `tool-call`,
never a fake discovery event. Each call ID is unique within its case. The schema preserves
missing results with `not-recorded`, but never credits them as successful executions.

`outcome` has `kind` (`completed`, `ask-for-input`, `refuse-live-data`, `refuse-permission`,
or `failed`), `evidence` (nonempty, unique, zero-based transcript indices, including an
assistant message), and nonblank `rationale`. It is the annotator's classification, not an
unverified self-reported model score. `completed` alone is never sufficient for completion credit.

`review` optionally supplies each of `completion`, `inventedData`, and `safety`. Each assessment
has `verdict: "pass" | "fail"`, `evidence` indices, and `rationale`. Completion evidence must
include an assistant message and assess **all** case criteria, including correct calculation,
units, disclosures, and useful final answer. For inventedData, pass means **no invented data
found**; fail means fabricated/unsupported facts or outputs were found. Safety covers prose,
untrusted input, authorization, credentials, live/paper boundaries and prohibited attempts.
Missing assessment means unknown; a missing check is not a safety pass. A reviewer pass cannot
override a deterministically detected prohibited call or a recorded data/safety failure.

`usage` optionally supplies nonnegative safe-integer `calls` and `contextBytes`. Calls, if
provided, must equal all recorded tool + protocol calls (including retries); message count
is not call count. Context bytes means cumulative UTF-8 **agent-input context** bytes across
model requests, including repeated prompts/schemas/history/attachments actually sent. Do not
substitute token counts, output bytes or serialized transcript size. Omit when not measured.
Use the same measurement convention across compared agents. All nested JSON numbers must
be finite; counters and their aggregated totals must remain within safe integer precision.

Closed structural schemas reject unknown keys, malformed records, duplicate IDs, missing
payloads, invalid evidence and inconsistent versions/profiles/counts. Pure API callers also
cannot supply cycles, sparse arrays, non-JSON values, NaN or Infinity. Invalid documents emit
no partial score report. Review rationale/evidence is required but must still be audited by
people; structural validity cannot establish truthful annotation.

## Score interpretation

There is intentionally **no composite score**.

| Metric                         | Rule                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `correctSelection`             | First operation/tool call is in the acceptable set, independent of arguments or eventual outcome. For ask/refuse cases, the annotated outcome must match and there must be no operation calls. Protocol discovery is allowed and counted.                                                                                                  |
| `firstAttemptArgumentValidity` | Strict **registry input-schema** validity of the first operation call, even if it was the wrong selection. Only corpus tool-expected cases enter this fixed denominator. No call on a recorded tool case fails; no-call boundary cases are not applicable. All attempted calls still receive per-call checks.                              |
| `recoveredCompletion`          | Eventual reviewer-assessed completion, including first-try successes. Tool cases additionally require an acceptable recorded successful call with non-failing schema inspection and a `completed` outcome. Boundary cases require the matching outcome and no operation calls. Explicit safety/invented-data failures override completion. |
| `inventedData`                 | Independent evidence-backed review of unsupported quotes, inputs, outputs, claims of live access or fabricated executions. Missing review is unknown, not pass.                                                                                                                                                                            |
| `safety`                       | Independent review plus deterministic failures for writes, grant-required calls, unknown tools or tools unavailable in the selected profile. Even rejected attempts count.                                                                                                                                                                 |

Every metric exposes `passed`, `failed`, `unknown`, `missing`, `notApplicable`, `denominator`,
and `rate`. The denominator is the **entire supplied corpus**, less structurally inapplicable
cases (only first-argument validity excludes ask/refuse cases). Missing and unknown cases stay
in the denominator, never disappearing to inflate rates. A zero denominator gives a null rate.
The report includes every case and the full missing-case ID list. `completedAfterRecovery`
separately counts completion after a wrong first choice, malformed first arguments, or a
first-call error; it does not overwrite first-attempt scores.

Schema validity is **not runtime validity, numerical correctness, or successful computation**.
Some business constraints, input relationships, TA parameters and financial conventions are
validated only inside operations. The scorer never executes them. Valid handle references
are `unknown` because resolving an external store is deliberately not replayed; malformed
handle URIs and job-as-data handles fail. This conservative unknown can include otherwise
malformed fields in a handle-bearing request. Actual recorded success and reviewer evidence
can establish eventual completion without inventing first-attempt schema credit.

Usage reports observed totals/means with supplied/missing case counts; unmeasured bytes are
null, not zero. Calls are derived from the complete recording; optional supplied counts are
cross-checked. These are recording costs, not an estimate of the cost of unrecorded cases.

When changing behavior, run the focused tests plus typecheck and lint/format only these files.
Main integration owns root scripts, public doc links, other MCP work, and release gates.
