# Spec — Stage 7A local operations, CLI, OpenAPI, and MCP

> **Status:** `COMPLETE @ c7bdb260d` (2026-09-03; all seven original Stage 7A slices landed).
> The [September review-repair gate](./review-september-2026-repairs.md) is locally verified complete
> on `dccfce53` plus the repair changes. Under [`../implementation-order.md`](../implementation-order.md),
> Stage 5A/5B remain maintainer-held; do not restart Stage 7A or infer publication authority.
> This file records the API, semantics, package placement, implementation slices, and exit
> evidence for the original Stage 7A baseline: the protocol-neutral operation
> registry (AT2), the local/read-only part of AT3 (artifacts, handles, jobs, CLI, OpenAPI/local
> HTTP), and the local-MCP preview gate.
>
> **Contract authority:** [`../agent-native-portfolio-and-trading-platform.md`](../agent-native-portfolio-and-trading-platform.md)
> (the operation, store/handle/job, and transport contracts; AT2 and AT3), the MCP-specific
> decisions in [`../mcp-acceleration-data-growth-strategy.md`](../mcp-acceleration-data-growth-strategy.md)
> ("What prevents a 10/10 local MCP" and the Preview Gate), and the ratified package rows in
> `tools/package-graph.test.ts` (`@totalfinance/workflows` L5; `@totalfinance/http` and `@totalfinance/cli` L6
> beside `@totalfinance/mcp`).
>
> **Permanent API authority:** [`../library-alignment-spec.md`](../library-alignment-spec.md),
> Decisions D1–D20 and laws C10/C13/C16 in
> [`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md)
> and [`phase-3b-decision-ledger.md`](./phase-3b-decision-ledger.md), and the naming vocabulary of
> [`phase-3b-public-naming-normalization.md`](./phase-3b-public-naming-normalization.md). Every new
> public identity enters the naming, manifest, package-graph, layer, sweep, packed-consumer, and
> bundle ratchets in its first implementation commit.

**Current amendments:** [Stage 7B.2](./trade-lifecycle-and-paper-execution.md) supersedes the original
registry's read-only/effect restrictions with explicit capabilities and trusted trade stores.
September R11/R12 supersedes the original unauthenticated HTTP boundary: enabled writes and job
mutations require a server-owned bearer credential; Host/Origin/content-type and malformed-target
checks apply independently. Decision 7 below and the [HTTP guide](../guides/http.md) describe that
current contract. Other slice records and their counts remain historical evidence, not new work
instructions. The local repair closeout is separate evidence and does not claim hosted-matrix success.

## Outcome

A coding agent, a shell script, a service in another language, and an MCP client can each list,
describe, run, and (for heavy work) submit, poll, cancel, and retrieve the same read-only TotalFinance
operations, and receive **the same normalized result and the same teaching error** for the same
input — from one operation definition, with no transport owning a second calculation, schema,
budget, or effect classification. Every direct calculation remains direct.

Concretely, at the closing commit:

- `@totalfinance/workflows` exports the operation contract, the registry, the runtime that every
  transport calls, the curated operation set (the twenty-three local compute tools and the opt-in
  backtest tool that `@totalfinance/mcp` ships today, re-homed as operations, plus the journey
  operations below), the memory stores, the handle grammar, and the parity fixtures;
- `@totalfinance/cli` ships the `totalfinance` binary: machine-first JSON/NDJSON, stable exit codes,
  help/doctor/profiles, local file stores, and a worker-terminated job runner;
- `@totalfinance/http` generates the OpenAPI 3.1 document from the registry and serves a loopback-only,
  read-only local HTTP API over it;
- `@totalfinance/mcp` adapts the registry (its tool schemas, budgets, seed policy, and effect metadata
  are the registry's), publishes protocol annotations and server instructions, returns protocol
  errors for unknown tools/resources/prompts, emits schema-conformant error results, and gains the
  configuration surface its binary lacked;
- `tools/transport-parity.test.ts` proves SDK ↔ registry ↔ CLI ↔ HTTP ↔ MCP parity on the
  flagship set, and the packed-consumer gate exercises the CLI, the HTTP server, and the MCP server
  from the published tarballs.

## Original Stage 7A non-goals

- No provider credential, network fetch, hosting, tenancy, entitlement, or remote handle
  (Stage 6 / hosted Stage 7B). Local HTTP mutation authentication is now required by September
  R11/R12; public read-only analytics remain the default.
- The original stage excluded portfolio writes, proposals, orders, and brokers. That registry
  restriction was superseded by Stage 7B.2's explicit effect/capability gates; it is not a reason
  to reject the now-supported opt-in trade pack at registration.
- No Agent2Agent, MCP Apps, hosted MCP, WASM, or workers-for-speed (Stage 7B / 8).
- No new quantitative semantics: an operation composes public functions and forwards their
  `assumptions` / `diagnostics` verbatim. A composed field is a report of a direct result, never a
  recomputation (law C13, C16; agent-platform law 10).
- No SQLite store in this stage: `node:sqlite` is still experimental on the ratified Node
  ≥ 22.13 floor; the file store is the durable local reference and the store interface is the seam.

## Decision 1 — package placement (the ratified rows, one widening)

| Package                   | Layer / tier                   | Owns                                                                                                                                             | Depends on                                                                                                                                                    |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@totalfinance/workflows` | L5 · `facade` (browser-safe)   | the operation contract, registry, runtime, curated operations and packs, memory stores, handle grammar, JSON-safe normalization, parity fixtures | its pre-declared Gate A row **plus `@totalfinance/portfolio`** (FC7 landed after the matrix was written — a reviewed widening, recorded in the row's comment) |
| `@totalfinance/cli`       | L6 · `integration` (Node-only) | the `totalfinance` binary, file stores, the worker-terminated job runner, human/machine output modes                                             | its pre-declared row (compute + workflows); never `@totalfinance/http` or `@totalfinance/mcp`                                                                 |
| `@totalfinance/http`      | L6 · `integration` (Node-only) | OpenAPI generation, the local HTTP server, the HTTP error mapping                                                                                | its pre-declared row (compute + workflows); never `@totalfinance/cli` or `@totalfinance/mcp`                                                                  |
| `@totalfinance/mcp`       | L6 · `integration` (unchanged) | the MCP adapter over the registry, packs, resources, prompts, the `totalfinance-mcp` binary                                                      | its row gains `@totalfinance/workflows` (already pre-declared in `MCP_ALLOWED`)                                                                               |

The umbrella `totalfinance` does not re-export any of the three (a transport is not compute; the
umbrella budget does not move). Enrolment for a new package is the ratified list: package
scaffold (copy `@totalfinance/mcp` for the Node-only two, `@totalfinance/calendars` for workflows), root
`tsconfig.json` paths, root `tsconfig.build.json` references, `tools/api-report/generate.ts`
(`API_PACKAGES` + `SOURCE_PATHS`), `vitest.config.ts` aliases, `tools/manifest/inventory.ts`
`MANIFEST_TIERS`, `tools/layer-model.test.ts` `LAYERS` rows, `tools/first-touch/garbage-sweep.test.ts`
roster (workflows is `facade` ⇒ swept; the two `integration` packages are not, like `mcp`), a
`tools/manifest/packages/<pkg>.json` manifest with every export hand-classified, and — for
workflows only — a `tools/bundle-size/budgets.ts` entry from evidence.

**Wire identity.** Operation ids are the MCP tool ids the naming normalization already fixed
(`totalfinance.<domain>.<verb>`, snake_case verbs): the registry does not mint a second naming. The
agent-platform sketch's `portfolio.analyze` style is the SAME grammar minus the prefix; this stage
keeps the prefix because the ids are already public on the wire. Journey operations take new ids
in the same grammar (Decision 4).

## Decision 2 — the operation contract

```ts
// @totalfinance/workflows
interface TotalFinanceOperation<Input = unknown, Output = Record<string, unknown>> {
  id: string; // 'totalfinance.option.price'
  version: string; // '1' — an integer string; a breaking output change bumps it (pre-1.0: no aliases)
  title: string;
  description: string;
  inputSchema: Schema<Input>; // @totalfinance/core/schema — the ONE validation grammar (strict parse; JSON Schema via toJSONSchema())
  outputSchema: JSONSchema; // the advertised structured output, validated in the parity fixtures
  /** 'none' is the only value this stage's registry accepts; the others exist so later stages fit the type. */
  sideEffect: 'none' | 'portfolio-state' | 'external-order';
  authorization: 'none' | 'policy' | 'human'; // 'none' only in 7A
  idempotency: 'not-applicable' | 'optional' | 'required'; // 'not-applicable' for pure compute
  deterministic: boolean; // false exactly when `stochastic` can be true
  /** A call that draws random samples — the seed policy applies (the MCP per-call predicate, unchanged). */
  stochastic?: boolean | ((input: Input) => boolean);
  costClass: 'small' | 'medium' | 'large' | 'job';
  requiredCapabilities: readonly string[]; // [] in 7A (capabilities are a Stage 7B concept)
  /** True only when the runtime can actually stop the work — the worker-terminated job runner (Decision 5). */
  supportsCancellation: boolean;
  /** The row sets whose rows may arrive by resource handle instead of inline (Decision 5). */
  handleFields: readonly string[];
  /** SYNCHRONOUS. Compute never awaits; the runtime and the job runner own asynchrony. */
  run(input: Input, context: OperationContext): OperationOutput<Output>;
}

interface OperationContext {
  /** The resolved seed for a stochastic call (injected by the seed policy when absent) — echoed. */
  seed: number | null;
  budgets: { maxInputBytes: number; deadlineMs: number | null };
  /** Cooperative cancellation: a job-class operation checks it at its own stage boundaries. */
  signal: AbortSignal | null;
  /** Read access to handles the input references; null when no store was supplied. */
  artifacts: ArtifactStoreReader | null;
}

/** What an operation returns — the runtime completes it into an OperationResult. */
interface OperationOutput<Output> {
  summary: string;
  structured: Output;
  /** Handles the operation minted for large outputs (through `context.artifacts`, when writable). */
  artifacts?: ResourceHandle[];
  status?: 'complete' | 'partial';
  incomplete?: string[];
}

interface OperationResult<Output = Record<string, unknown>> {
  operation: { id: string; version: string };
  library: { version: string }; // the workflows package version
  summary: string;
  /** JSON-safe (non-finite → null) structured output that validates against `outputSchema`. */
  structured: Output;
  /** Forwarded verbatim from the composed direct results; `seed` echoed here for stochastic calls. */
  assumptions: Record<string, unknown>;
  diagnostics: { warnings: QuantWarning[]; status: 'complete' | 'partial'; incomplete: string[] };
  identity: { inputsHash: string; artifactIds: string[]; snapshotHash: string | null };
  artifacts: ResourceHandle[];
  usage: { inputBytes: number; elapsedMs: number | null };
  trace: { requestId: string | null };
}

interface OperationError {
  code: string; // the QuantError code, or 'operation.unknown' | 'operation.input_too_large' | 'operation.deadline_exceeded' | 'operation.cancelled' | 'operation.internal'
  message: string;
  context: Record<string, unknown>;
  issues?: SchemaIssue[];
  operation: { id: string; version: string } | null;
}
```

Why synchronous `run`: every current tool and every direct calculation is synchronous, and a
`Promise` in the compute contract would license hidden I/O inside an operation (agent-platform law
11). The registry's `runOperation` is synchronous too; the job runner (Decision 5) and the
transports add asynchrony outside compute. This is the one deliberate deviation from the
agent-platform sketch's `Promise<OperationResult>`, and the `run` signature is where a Stage 7B
hosted runtime would wrap it.

**The runtime, extracted from MCP once.** `runOperation({ registry, id, input, options })`:

1. resolves the operation (`operation.unknown` teaches with the closest id);
2. measures the raw input in UTF-8 bytes against `maxInputBytes` when the caller passes one
   (`operation.input_too_large`) — a WIRE budget every transport passes (the MCP server's default
   is 64 KiB); an in-process run that omits it is bounded by the operation's own row caps (slice 1
   amendment: a direct `tool.run` / `runOperation` must not refuse a large in-memory input a
   direct SDK call would accept);
3. strict-parses the input through `inputSchema` (the schema's own teaching error, with `issues`);
4. applies the seed policy exactly as MCP does today (parse first, then decide; inject the default
   seed only for a stochastic call; re-parse so the tool's own seed schema stays authoritative);
5. runs with a context; a QuantError from the composed function PROPAGATES as the typed teaching
   error it is (an embedding caller sees exactly what the direct SDK call raises), and
   `toOperationError(error, operation)` maps any thrown value to the one `OperationError` shape at a
   transport's edge — `operation.internal` for anything that is not a QuantError (never a raw crash
   out of a transport); the runtime's own refusals (`operation.unknown`, `operation.input_too_large`,
   `operation.deadline_exceeded`) are QuantErrors with registered codes;
6. JSON-normalizes the structured output (`jsonSafe`, moved from MCP), echoes the seed under
   `assumptions.seed`, forwards `assumptions` / `diagnostics.warnings`, stamps identity
   (`inputsHash = contentHash(parsed input)`), usage, and the post-hoc deadline verdict
   (`operation.deadline_exceeded` — honest: a synchronous operation reports it; only the job runner
   can pre-empt).

`describeOperation(op)` returns the transport-neutral description every adapter renders:
`{ id, version, title, description, inputSchema: JSONSchema, outputSchema, sideEffect,
authorization, idempotency, deterministic, stochastic: boolean | 'per-call', costClass,
requiredCapabilities, supportsCancellation, handleFields, annotations }` where `annotations` is
derived — `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`
for every operation this stage registers — never authored per tool.

## Decision 3 — the registry and the curated set

`createOperationRegistry({ operations, packs? })` refuses a duplicate id, an id outside the
`totalfinance.<domain>.<verb>` grammar, a `sideEffect` other than `'none'`, an `authorization` other
than `'none'`, a `deterministic: true` operation that declares `stochastic`, and unknown keys —
each with a registered code (`operation.registration_refused` + a teaching). It exposes
`list()`, `get(id)`, `describe(id)`, `run(id, input, options)`, and `packs()`.

**Packs move to workflows.** The ten domain packs and the opt-in backtest pack become
`OperationPack { name, operations }` in `@totalfinance/workflows` (`optionsPack()`, …,
`defaultPacks()`, `backtestPack()`, `defaultOperations()`), and `@totalfinance/mcp` keeps its
identically named exports as thin adapters that return `ToolPack`s built from them (no rename, no
alias — the MCP exports are the transport's, the workflows exports are the registry's).

**Migration is the extraction.** The twenty-four `defineTool` definitions in `@totalfinance/mcp`
become `defineOperation` definitions in `@totalfinance/workflows` with the same ids, schemas, output
schemas, stochastic predicates, and bodies; `@totalfinance/mcp` stops owning any schema. The
`mcpTools` declarations on the compute manifests stay exactly as they are (the runtime tool set
still equals the declared set — the conformance law is unchanged), and `tools/manifest/mcp-contracts.ts`
keeps measuring tools through the MCP adapter so the MCP ledger keeps its history.

## Decision 4 — the journey operations (green compute only, thin composition)

| Operation id                           | Composes (verbatim results)                                                                                                     | Cost   | Notes                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `totalfinance.portfolio.snapshot`      | `readPortfolioLedgerSnapshot` → `portfolioSnapshot({ portfolio: ledger.state, asOf, market, currencyConversions })`             | small  | input is the serialized ledger envelope (the FC7 JSON form) or a `PortfolioState`; the market is a Gate B `MarketSnapshot`              |
| `totalfinance.portfolio.explain_pnl`   | `readPortfolioLedgerSnapshot` → `portfolioPnl({ ledger, from, to, instrumentClassification })`                                  | small  | two valuation marks (`{ valuationDate, market, currencyConversions? }`)                                                                 |
| `totalfinance.portfolio.analyze`       | snapshot + `portfolioTimeline` (when `marks[]` supplied) + `monitorPortfolio` (when a model portfolio and policy are supplied)  | medium | a report of three direct results under one `assumptions`; nothing aggregated by the operation                                           |
| `totalfinance.scenario.run`            | `readScenarioSet` + `readMarketSnapshot` + `scenarioTarget.spot(...)` / `scenarioTargetsFromPortfolio(ledger)` → `runScenarios` | large  | wire targets are the serializable kinds only (`spot`, `portfolio`); a custom pricer target is SDK-only (a callback is not a wire value) |
| `totalfinance.research.screen`         | `screenUniverse` (no `customPredicate` — the schema has no such field; a wire run is replayable by construction)                | medium | `rank` and `score` are the same shape over `rankUniverse` / `scoreUniverse`                                                             |
| `totalfinance.research.event_study`    | `eventStudy` with the serializable expected-return models (`'custom'` is SDK-only)                                              | medium | pairs with `totalfinance.artifact.*` for saving through `@totalfinance/research/artifacts` later (not this stage)                       |
| `totalfinance.backtest.options_run`    | `optionsBacktest` with the declarative entry/exit/roll/hedge (callback escape hatches are SDK-only) and the P1 `marking` policy | job    | `supportsCancellation: true` through the worker-terminated runner                                                                       |
| `totalfinance.backtest.vectorized_run` | (existing opt-in tool, re-homed)                                                                                                | job    | as above                                                                                                                                |
| `totalfinance.artifact.read`           | `readAnalysisArtifact` → the validated envelope's identity, type, producer, warnings, and a bounded `structured` preview        | small  | the one read door for any Gate B artifact over the wire                                                                                 |
| `totalfinance.artifact.compare`        | `compareAnalysisArtifacts({ baseline, candidate, tolerance?, limits? })`                                                        | medium | baseline/candidate as artifacts or as handles                                                                                           |

`totalfinance.strategy.analyze` (existing) is the agent-platform sketch's `strategy.evaluate`;
`totalfinance.risk.value_at_risk` and the rest keep their ids. `portfolio.propose_rebalance`,
`portfolio.monitor` as a standalone alerting workflow, `trade.preflight`, `portfolio.record_events`,
and `trade.submit` are NOT registered: the first three wait for the preview's compute maturity and
the last two are writes/orders (Stage 7B and later). Every journey operation's schema is authored
in `@totalfinance/core/schema` over the direct function's own input shape (same field names, same
defaults, same nulls — law C16); a wire-only restriction (no callbacks) is a narrower schema, never
a different meaning.

## Decision 5 — artifacts, handles, and jobs (local, explicit, no hidden state)

```ts
interface ResourceHandle {
  uri: string; // totalfinance://reports/<contentHash> | totalfinance://jobs/<jobId> | totalfinance://portfolios/<contentHash> | totalfinance://scenarios/<contentHash> | totalfinance://markets/<contentHash>
  kind: 'report' | 'job' | 'portfolio' | 'scenario' | 'market';
  schema: string; // e.g. 'totalfinance.analysis-artifact' — the stored envelope's kind
  version: string; // the envelope's schemaVersion as a string
  contentHash: string | null; // sha256:… for content-addressed kinds; null for a job
  createdAt: string; // ISO — supplied by the caller's clock, never read by the library
  expiresAt: string | null;
  provenance: Provenance;
}

interface ArtifactStore extends ArtifactStoreReader {
  put(input: {
    value: Record<string, unknown>;
    kind: ResourceHandle['kind'];
    createdAt: string;
    expiresAt?: string;
    provenance?: Provenance;
  }): ResourceHandle; // idempotent by content
}
interface ArtifactStoreReader {
  get(uri: string): { handle: ResourceHandle; value: Record<string, unknown> } | null;
  list(filter?: { kind?: ResourceHandle['kind'] }): ResourceHandle[];
}

interface JobRecord {
  id: string;
  operation: { id: string; version: string };
  state: 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: { stage: string; fraction: number | null } | null;
  inputsHash: string;
  seed: number | null;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: ResourceHandle | null;
  error: OperationError | null;
  usage: { elapsedMs: number | null };
}
interface JobStore {
  create(record): JobRecord;
  update(id, patch): JobRecord;
  get(id): JobRecord | null;
  list(): JobRecord[];
}
```

- `@totalfinance/workflows` ships `createMemoryArtifactStore()` and `createMemoryJobStore()` (pure,
  browser-safe). `@totalfinance/cli` ships `createFileArtifactStore({ directory })` (one JSON file per
  content hash, an index file, idempotent re-puts) and `createFileJobStore({ directory })`.
- **Handles in inputs.** An operation's `handleFields` name the input paths that accept a
  `ResourceHandle` (or its `uri`) in place of inline data; the runtime resolves them through
  `context.artifacts` before validation, refuses a missing store (`operation.handle_store_missing`),
  an unknown uri (`operation.handle_unknown`), and a kind mismatch (`operation.handle_kind_mismatch`).
  Large outputs: when the runtime is given a writable store and a result's canonical bytes exceed
  `inlineResultBytes` (default 256 KiB), the structured output is stored and the result carries the
  handle with a bounded preview — never silently truncated.
- **Jobs are real.** `submitJob({ registry, jobs, artifacts, id, input })` runs a `costClass: 'job'`
  operation in a `worker_threads` Worker (`@totalfinance/cli`'s runner; the HTTP server uses the same
  runner): `cancelJob` terminates the worker — a cancellation that actually stops work — and the
  record moves to `cancelled` with usage. Non-job operations run inline. A `signal` reaches the
  operation for cooperative stage checks where the compute exposes a boundary; this stage adds no
  loop-level checks inside compute packages (a Stage 4.6/7B item, recorded).
- No connection state: every transport receives its stores explicitly; the MCP server's optional
  store is a constructor argument; nothing is looked up by "current session".

## Decision 6 — the CLI (`@totalfinance/cli`, binary `totalfinance`)

```text
totalfinance operations list [--json]            totalfinance schema <id> [--output]
totalfinance run <id> --input <file|->           totalfinance job submit <id> --input <file|->
totalfinance job status <jobId>                  totalfinance job result <jobId>
totalfinance job cancel <jobId>                  totalfinance artifacts get <uri>
totalfinance serve --http [--port 8787] [--host 127.0.0.1] [--openapi]
totalfinance doctor                              totalfinance --help | --version
global: --profile default|options|research|full  --packs a,b  --seed <int>  --max-input-bytes <n>  --deadline-ms <n>  --store <dir>  --pretty
```

- Machine mode is the default: JSON on stdin (or a file), one JSON document on stdout (NDJSON for
  `job status --follow`), logs and prompts on stderr only. `--pretty` is the explicit human mode.
- Exit codes are a contract: `0` success · `2` usage · `3` input refused (an `OperationError`
  with an `input.*` code) · `4` operation failed (any other `OperationError`) · `5` job cancelled ·
  `70` internal. The error document is the `OperationError` JSON.
- `doctor` prints the Node version against the floor, the registry summary (operations, packs,
  stochastic set), the store directory state, and the resolved budgets — and exits non-zero when
  the floor is not met.
- The CLI owns no schema and no compute: `operations list` and `schema` render
  `describeOperation`; `run` calls `runOperation`; `serve` starts `@totalfinance/http`'s server? — No:
  L6 packages never depend on each other (the ratified rows). `totalfinance serve` therefore lives in
  `@totalfinance/http` as its own binary `totalfinance-http`, and the CLI's `serve` command prints the
  exact `totalfinance-http` invocation and exits `2` (a teaching, not a hidden dependency).

## Decision 7 — OpenAPI and the local HTTP server (`@totalfinance/http`, binary `totalfinance-http`)

This decision includes the September R11/R12 boundary corrections.

- `openApiDocument({ registry })` generates OpenAPI 3.1: `GET /operations`, `GET /operations/{id}`,
  `POST /operations/{id}/run`, `POST /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`,
  `GET /jobs/{id}/result`, `GET /artifacts/{uri}`, `GET /capabilities`, `GET /openapi.json`. Request
  and response schemas are the operations' JSON Schemas verbatim (components keyed by id);
  `OperationError` is the one error schema; the `x-totalfinance` vendor extension carries
  `sideEffect`, `authorization`, `idempotency`, `deterministic`, `stochastic`, `costClass`,
  `supportsCancellation`, and `annotations`.
- `createLocalHttpServer({ registry, artifacts?, jobs?, capabilities?, stores?, authenticationToken?, host?, port?, budgets? })`
  binds `127.0.0.1` by default. Non-loopback binding requires `allowNonLoopback: true` and the
  operator's own network/TLS boundary; reads remain unauthenticated, so the bearer credential
  does not make this a hosted/private-data service. The server sets `X-Request-Id`.
- Enabled writes, including `trade:approve` despite `sideEffect: 'none'`, require an explicit
  `authenticationToken` with at least 32 cryptographically random bearer-token characters.
  Job creation/cancellation also requires it; without a configured token those job mutations
  are disabled, while inline read-only analytics remain public. CLI configuration uses
  `--token-file` (overrides `TOTALFINANCE_HTTP_TOKEN`), never secret CLI arguments. Clients send
  `Authorization: Bearer <token>`; timing-safe comparison authenticates the caller but does not
  enlarge the server's capability ceiling or replace trusted grant approval.
- Host must name a trusted bound host/loopback alias and the actual bound port, including correct
  IPv6 brackets. Origin may be absent; if present it must be a trusted `http://` origin at that
  port, never foreign or `null`. JSON POSTs require `Content-Type: application/json`. URL parsing
  and decoding are protected, and the outer handler catches rejections so malformed targets get
  structured 4xx responses without terminating the server.
- HTTP boundary refusals add `401` for missing/invalid bearer credentials, `403` for rejected
  Host/Origin or disabled capabilities/job mutations, and `415` for unsupported JSON content type.
  Ordinary mappings remain `404 operation.unknown` / `operation.handle_unknown`,
  `413 operation.input_too_large`, `400 input.*`, `422` other operation errors,
  `409 operation.cancelled`, and `500 operation.internal`. Refusal bodies are `OperationError`
  JSON; operation-run success bodies are `OperationResult` JSON. No streaming this stage
  (progress by polling `GET /jobs/{id}`). See the [HTTP status table](../guides/http.md#status-codes).
- `/capabilities.readOnly` reflects enabled operation effects/capabilities and authenticated job
  mutation availability. OpenAPI declares bearer security on mutation routes and public security
  on read-only routes. Neither discovery, OpenAPI nor startup logs publish the credential.
- The document is a generated artifact committed under `packages/http/etc/openapi.json` and
  gated (`tools/openapi-doc.test.ts`: regenerate and diff).

## Decision 8 — the MCP refactor (the preview gate, item by item)

- `createTotalFinanceMcpServer` builds every tool from the registry through one adapter
  (`toolFromOperation`); `tools` / `packs` options keep their meaning (`packs` accepts operation
  packs and tool packs); read-only filtering becomes structural at registration (no `mutates`).
- **Annotations**: each tool advertises the operation's derived annotations. **Instructions**: the
  server sends initialization `instructions` (units are decimals, years-to-expiry, assumptions and
  diagnostics travel with every result, deterministic seeds, pure compute versus live data, use
  handles/resources for large data) once — never repeated per tool.
- **Protocol errors**: unknown tool / resource / prompt → `McpError` with the SDK's `ErrorCode`
  (JSON-RPC errors), not an `isError` result.
- **Error results conform**: an `isError` result carries the `OperationError` JSON in its text
  content and omits `structuredContent` (policy B of the strategy doc — success schemas stay
  success schemas); a fixture validates every golden success and failure against the advertised
  schema.
- **Resources**: schemas come from `describeOperation`; `totalfinance://capabilities` (packs,
  budgets, seed policy, negotiated features) joins the seed-policy and payload-schema resources;
  handles minted by an optional store are listed as `totalfinance://reports/{id}` resources.
- **Prompts**: `screen-options-chain` is removed (it invites invented data until a chain handle
  exists); `analyze-option-trade` is checked field-for-field against the tools it names.
- **Binary**: `totalfinance-mcp --help | --version | --packs a,b | --profile default|options|research|full |
--max-input-bytes n | --seed n | --deadline-ms n | --store dir | doctor`; help and doctor write to
  the terminal, and once stdio protocol mode starts stdout is JSON-RPC only.
- **Guide drift**: the MCP guide's counts are computed claims (the doc gate already checks them),
  `technical_analysis.describe` is named, the per-call stochastic predicate is described.

## Decision 9 — parity is generated, then proven

`tools/transport-parity.test.ts` runs one canonical fixture per operation of the flagship set (the
twenty-three defaults, the two backtests, the journey operations) through: the direct SDK call the
operation composes (where the composition is a single call), `registry.run`, the CLI (`totalfinance run`
spawned against the workspace build), the HTTP server (in-process), and the MCP server (in-memory
client) — and asserts equality of the canonical JSON of `structured`, `assumptions` (seed included),
`diagnostics.warnings`, identity, and the derived annotations; and, on a malformed fixture, equality
of the error code and message across all five. `tools/packed-consumer.test.ts` gains a Stage 7A case:
from the packed tarballs, `totalfinance operations list`, `totalfinance run totalfinance.option.price`,
`totalfinance-http` serving `/openapi.json` and one run, and the MCP server listing tools with
annotations — all three bytes-identical to the SDK result.

## Decision 10 — determinism, safety, and evidence

- No clock, no randomness without a seed, no network: the runtime never reads `Date.now()` for a
  result (elapsed time is usage, not identity); every timestamp in a handle or job comes from the
  caller (`createdAt` is an argument; the CLI supplies its own clock at the edge).
- Budgets before compute: bytes, rows (the existing `capRows`), then the post-hoc deadline for
  inline runs and the terminating cancel for jobs.
- Every result is JSON-safe and validates against its output schema; every error has a code.
- Evidence at the closing commit: manifests for the three packages with every export classified;
  `MANIFEST_TIERS`, `LAYERS`, the widened workflows row, the sweep roster; api reports; the naming
  ledger (0 unresolved); enforcement `defective 0`; bundle budget for workflows from evidence;
  `docs/guides/cli.md`, `docs/guides/http.md`, the MCP guide; `packages/http/etc/openapi.json`;
  the parity and packed fixtures; full CI, `api:check`, and a second all-green run at one commit;
  the MCP strategy Preview Gate rows and the agent-platform AT2/AT3 exits ticked in the closeout.

## Ordered implementation slices

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `@totalfinance/workflows`: the operation contract, `defineOperation`, the registry with its refusals, the runtime (bytes, strict parse, seed policy, deadline, `jsonSafe`, identity, error mapping), `describeOperation`, the twenty-four existing tools re-homed with their packs; the MCP server consumes the registry for tools (schemas/budgets/seed/effect no longer MCP-owned). | registry and runtime unit tests; every re-homed tool's MCP test unchanged; `mcpTools` conformance unchanged; SDK ↔ registry parity on the twenty-four.        |
| 2     | Journey operations (Decision 4) with schemas authored over the direct inputs; wire-only restrictions as narrower schemas; first-touch fixtures.                                                                                                                                                                                                                                       | one fixture per journey operation equal to the direct call; refusal fixtures (callback fields absent from the schema, unknown keys); count-safety on budgets. |
| 3     | Handles, stores, jobs: `ResourceHandle`, memory stores (workflows), file stores and the worker-terminated job runner (cli), handle resolution in the runtime, large-output spill.                                                                                                                                                                                                     | put/get/list idempotency; handle refusals; a job that is cancelled mid-run (a deliberately long options backtest) actually stops; spill and preview fixtures. |
| 4     | `@totalfinance/cli`: commands, machine/human modes, exit codes, profiles/packs/budgets/seed flags, doctor.                                                                                                                                                                                                                                                                            | spawned-process tests for every command and exit code; stdout purity; `--help`/`--version`.                                                                   |
| 5     | `@totalfinance/http`: OpenAPI generation (committed, gated), the loopback server, error mapping, jobs and artifacts endpoints.                                                                                                                                                                                                                                                        | in-process server tests; the OpenAPI document validates structurally; every route's success and error bodies conform.                                         |
| 6     | MCP refactor completion (Decision 8): annotations, instructions, protocol errors, conformant error results, capabilities resource, prompt removal, binary flags, guide.                                                                                                                                                                                                               | MCP protocol tests for each item; the doc gate; the strategy doc's Preview Gate rows that this slice owns.                                                    |
| 7     | Transport parity and packed consumers (Decision 9); guides; closeout — trackers to `COMPLETE @ <commit>`, AT2/AT3 exits and the Preview Gate ticked, the next row (Stage 5A) made obvious.                                                                                                                                                                                            | `tools/transport-parity.test.ts`; the packed Stage 7A case; full CI, `api:check`, second run.                                                                 |

Each slice lands as one commit with tests, generated evidence, and a slice record in this file.

## Acceptance and exit gate

- [x] One operation definition drives the SDK-facing registry, the CLI, the OpenAPI document, the
      local HTTP server, and the MCP tools; no transport declares a schema, a budget, a seed rule,
      or an effect of its own (AT2 exit; law C16).
- [x] Every registered operation has `sideEffect: 'none'` and `authorization: 'none'`; the
      registry refuses anything else at registration; the default MCP pack, the CLI, and the HTTP
      server cannot propose or place an order or mutate a portfolio (Preview Gate; global stop
      conditions).
- [x] The parity fixtures pass for every flagship operation across SDK, registry, CLI, HTTP, and
      MCP — same normalized output, same teaching error, same annotations, same seed echo.
- [x] Another process (the CLI spawn and the HTTP client in the tests) can run, submit, poll,
      cancel, and retrieve every job-class operation, and a cancelled job stops (AT3 local exit).
- [x] Unknown tools/resources/prompts are protocol errors; every MCP success and error result
      validates against the advertised schema; annotations and instructions are published; the
      chain-screen prompt is gone; the binary has help/version/packs/profile/budget/seed/doctor.
- [x] Handles are explicit and store-scoped; no transport keeps session state; large outputs spill
      to a handle with a preview, never a silent truncation.
- [x] Every direct calculation remains direct and unchanged; the umbrella budget does not move;
      the three new packages sit in their ratified rows and tiers.
- [x] Manifest, api-report, naming, enforcement (`defective 0`), bundle, packed-consumer, and full CI
      evidence at one commit; the MCP guide, a CLI guide, and an HTTP guide describe exactly what
      ships; the trackers name the same commit.

Every row closed by the slices recorded below; the commit that carries all of them is `c7bdb260d`.

## Review record (self-review against the laws, 2026-09-03)

| Finding                                                                                        | Resolution                                                                                                |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A `Promise` in the operation contract licenses hidden I/O in compute                           | `run` is synchronous; asynchrony belongs to the runtime, the job runner, and the transports (Decision 2)  |
| `readOnly: false` on a server could flip an operation live                                     | effects other than `'none'` are refused at registration — structural, not a flag (Decision 3)             |
| The pre-declared workflows row lacks `@totalfinance/portfolio` (FC7 landed later)              | a reviewed widening of one row with a dated comment (Decision 1)                                          |
| Callbacks (`customPredicate`, `entry.when`, custom expected-return models) cannot cross a wire | wire schemas are narrower, never re-interpreted; the SDK keeps every escape hatch (Decision 4)            |
| A post-hoc deadline is not cancellation                                                        | job-class operations run in a terminated worker; inline runs report, never pretend (Decision 5)           |
| An L6 package must not depend on another L6 package                                            | `serve` lives in `@totalfinance/http` as `totalfinance-http`; the CLI teaches the invocation (Decision 6) |
| MCP error payloads violated success schemas                                                    | policy B: `isError` results carry the typed error in text and omit `structuredContent` (Decision 8)       |
| A second naming for operation ids                                                              | the MCP wire ids are the operation ids; journeys join the same grammar (Decision 1)                       |
| SQLite on the Node floor                                                                       | deferred; the file store is the durable local reference; the interface is the seam (Non-goals)            |
| Clock reads inside results                                                                     | `createdAt` and job timestamps are caller-supplied; elapsed time is usage only (Decision 10)              |

## Slice records

### Slice 1 (landed 2026-09-03) — `@totalfinance/workflows` core; MCP consumes the registry

**What landed.**

- **`packages/workflows`** (L5 · `facade` · browser-safe — its build config declares no platform
  lib, so the contract names a structural `OperationSignal`, the runtime measures UTF-8 bytes
  itself, the usage clock is `Date.now`, and the package version is a constant pinned to
  `package.json` by a test): `operation.ts` (the contract, `defineOperation` with read-only
  defaults and registration-time validation, `describeOperation`, derived
  `operationAnnotations`), `runtime.ts` (`runOperation({ operation, input, …options })` — one
  closed request: the optional wire byte budget, the strict parse whose own teaching error
  propagates, the seed policy extracted verbatim from MCP (parse first, inject only for a
  stochastic call, re-parse so the operation's seed schema stays authoritative, echo under
  `assumptions.seed`), the post-hoc deadline verdict, `jsonSafe` output, identity and usage; and
  `toOperationError` for a transport's edge), `registry.ts` (`createOperationRegistry` — refuses a
  side effect, an authorization, a duplicate, a malformed id or pack at registration; `list` /
  `get` / `require` with a closest-id teaching / `describe` / `run` / `packs`), `operation-kit.ts`
  (`capRows`, `extendObjectSchema`, moved), `json-safe.ts` (moved), and the twenty-four operations
  re-homed mechanically from MCP's two tool modules (`defineTool` → `defineOperation`, `name` →
  `id`, `schema` → `inputSchema`; bodies, schemas, output schemas, and stochastic predicates
  byte-for-byte) with their ten packs, `defaultPacks`, `defaultOperations`, `backtestPack`, and
  `analysisOperations`.
- **`@totalfinance/mcp` adapts the registry.** `tools.ts` is adapters (`toolFromOperation`, the pack
  functions over the workflows packs, `defaultTools`); `tools-analysis.ts` and `json-safe.ts` are
  gone; `defineTool` remains for a caller's own custom tools; the server routes every
  registry-backed tool call through `runOperation` with its own `maxInputBytes` / `defaultSeed` /
  `deadlineMs` and maps errors with `toOperationError` — MCP owns no schema, budget, seed rule, or
  effect classification of a shipped tool. Its 98 tests pass unchanged.
- **Core:** nine `operation.*` error codes registered (`unknown`, `registration_refused`,
  `input_too_large`, `deadline_exceeded`, `cancelled`, `internal`, `handle_store_missing`,
  `handle_unknown`, `handle_kind_mismatch`).
- **Decisions at landing.** (1) The byte budget is a wire budget: `runOperation` applies it only
  when a transport passes one, so an in-process `tool.run` / `runOperation` accepts what the direct
  SDK call accepts (Decision 2 amended). (2) The runtime throws the typed QuantError a direct call
  raises; `toOperationError` is the transport-edge mapping (Decision 2 amended). (3)
  `registry.run({ id, input, …options })` — one closed request, like every door. (4)
  `createOperationRegistry({})` is the curated default set; `{ operations: [] }` / `{ packs: [] }` is
  empty. (5) `requireJSONSchema` lives in `@totalfinance/core/schema` (the owner of `JSONSchema`), a
  positional core-order guard with a signature-policy row.

**Enrolment.** The seven wires plus `MANIFEST_TIERS` (`facade`), the `LAYERS` L5 row, the
package-graph row widened with `@totalfinance/portfolio` (dated), the sweep roster by tier, a
26-row manifest, a first-touch shard (`workflows.ts`), signature-policy rows for the three
positional helpers, and budgets from evidence: `@totalfinance/workflows` 208 KB (measured 206,220 B —
it bundles the compute the twenty-four operations compose, like the MCP server whose schemas it
replaces), and the nine registered codes moved four thin-headroom entrypoint budgets
(`core/pricing` 14 KB, `calendars/crypto` 4.5 KB, `performance/sharpe` 8.25 KB,
`fixed-income/xva` 11.25 KB), each with its measured bytes. The bundle table pins 24 rows.
Regeneration chain green; enforcement **defective 0** (enforced 2,382 · partial 2,610 · unmeasured 182 —
the measurement ratchet moved DOWN from 183 because `@totalfinance/mcp` gained its first hand baselines and
the registry's synthesized receiver is populated, instead of the new package raising the ceiling);
fixture/contract join 1,127 → 1,142.

**Gate findings at landing (each fixed at its source, none ledgered).**

- **Enforcement (three passes).** The six workflows doors accepted unknown keys or nulls →
  `requireOperation` (a closed-key structural guard over the sixteen operation members, exported so
  MCP's adapter uses the same one), null ≠ omission in `defineOperation`, argument validation in
  `capRows` / `extendObjectSchema`, option validation in `runOperation`, `toOperationError` refusing
  an undefined error. Then the nested `outputSchema` document accepted `null` / wrong types under
  `$id`, `allOf`, `additionalProperties`, … and `const` / `default: null` → a document walker,
  landed in **core** as `requireJSONSchema` (`@totalfinance/core/schema` owns the `JSONSchema` type, so
  it owns the guard; workflows and MCP both import it). Then MCP's own builders: `defineTool` accepted
  an unknown key and `toolFromOperation` accepted a malformed operation → both closed.
- **A gate that went silent.** The naming walker scanned `packages/mcp/src` for tool ids and
  `schema.object` fields; the definitions moved to `packages/workflows/src`, so `mcp-tool` and
  `mcp-field` dropped from 24 / 290 to **absent** while the ledger still reported zero unresolved.
  The walker now scans both trees and attributes each identity to the package that declares it (and
  accepts `id:` as the owner name, not only `name:`). Counts restored to 24 / 290; one new ordinary
  token (`job`) classified.
- **Coverage arms.** `TotalFinanceTool.operation?` (the adapter's back-reference) added 115 declared
  arms under `createTotalFinanceMcpServer.tools[]` → the binding is a private `WeakMap`
  (`operationOf(tool)`), so a caller cannot forge one onto a custom tool and the public tool shape
  is exactly what a client sees. `defineOperation(definition)` and `createOperationRegistry({ operations })` name 82 + 14 arms the
  builder cannot realize (a definition carries a live `Schema` instance and a `run` function, so no
  synthesized item exists) → ledgered in `ALLOWED_RESIDUAL` with the reason, derived from the gate's
  own output — the same standing as the MCP server's `tools[]` rows. `createOperationRegistry({})`
  is the curated default set (the same default the MCP server ships), an explicit empty list is
  empty — so the synthesized receiver is populated and `OperationRegistry#run` is measurable.
- **Union parity.** `ResourceHandle['kind']` printed in two member orders at two sites → one named
  `ResourceHandleKind` alias used at both.
- **Fixture validation.** `operationAnnotations`' fixture handed a whole operation to a `Pick<…>`
  contract → the fixture is exactly the three declared members (now `enforced`); the `jsonSafe`
  argument is declared an open artifact (it walks ANY value).
- **Rosters and pins.** Garbage/deep sweep rosters (`workflows`), generated-docs pins 51 → 53 and
  22 → 23, the README snippet test (`@totalfinance/workflows`), the naming closeout's package count
  22 → 23, the runtime-semantic closeout header (alternatives 390 → 418; reason counts), the
  alignment spec's per-package cell (`workflows`), and the join pin.

**Acceptance laws this slice closes.** One operation definition drives the SDK-facing registry and
the MCP tools with no MCP-owned schema/budget/seed/effect — **closed for MCP**; every registered
operation is `sideEffect: 'none'` and the registry refuses anything else — **closed**; the
remaining transports (CLI, HTTP) and the parity fixtures are slices 4–7.

**Deferred by this slice.** Journey operations (slice 2); handles, stores, jobs (slice 3); the CLI
(slice 4); OpenAPI/HTTP (slice 5); the MCP preview-gate items beyond registry adoption (slice 6);
parity, packed consumers, closeout (slice 7).

### Slice 2 (landed 2026-09-03) — the journey operations

**What landed.** `packages/workflows/src/operations-journey.ts`: the ten operations of Decision 4
in four opt-in journey packs — `portfolioPack()` (`totalfinance.portfolio.snapshot`,
`totalfinance.portfolio.explain_pnl`, `totalfinance.portfolio.analyze`), `scenarioPack()`
(`totalfinance.scenario.run`), `researchPack()` (`totalfinance.research.screen` / `rank` / `score` /
`event_study`), `artifactPack()` (`totalfinance.artifact.read`, `totalfinance.artifact.compare`) —
`journeyPacks()` / `journeyOperations()` beside them, and `totalfinance.backtest.options_run` joining
the opt-in `backtestPack()`. Every schema is authored in `@totalfinance/core/schema` over the direct
function's own input shape (same field names, same defaults, same nulls); the Gate B envelopes
(market snapshot, portfolio ledger, scenario set, analysis artifact) are closed at the top level
and re-validated in full by the read door the operation composes. Every `structured` output is the
direct result verbatim (canonical-JSON equality in the tests); `portfolio.analyze` is a report of
three direct results side by side under one `assumptions`. `@totalfinance/mcp` exports the same five
pack adapters; the MCP guide documents them as opt-in; the `mcpTools` law now covers the journey
packs (each tool declared on the compute export it composes: `portfolioSnapshot`, `portfolioPnl`,
`portfolioTimeline`, `runScenarios`, the four research heads, `readAnalysisArtifact`,
`compareAnalysisArtifacts`, `optionsBacktest`).

**Decisions at landing.**

1. **Wire targets for `scenario.run` are `spot`, `taylor`, and `portfolio`** (Decision 4 named
   `spot` and `portfolio`): a Taylor target is serializable (greeks and factor levels), so it is a
   wire kind; a full-revaluation target carries a pricer and stays SDK-only. The `portfolio` kind
   binds through Taylor bindings for the same reason (`scenarioTargetsFromPortfolio` needs one
   binding per open position, and only the Taylor binding is a wire value).
2. **`portfolio.analyze` takes the ledger envelope**, not a `PortfolioState`: the timeline needs
   the events. `portfolio.snapshot` accepts either (Decision 4 verbatim).
3. **`options_run` declares `supportsCancellation: false` until slice 3 lands the runner** — the
   flag is true only when the runtime can actually stop the work (Decision 2).
4. **`artifact.compare` takes inline artifacts in this slice**; the handle forms arrive with
   `handleFields` in slice 3 (Decision 5).
5. **The screen `filter` is an open record on the wire**, described as the grammar and validated
   node by node by `screenUniverse` (the schema builder has no recursive combinator; a depth-unrolled
   union would be an arbitrary depth limit — a different meaning, which law C16 forbids).
6. **Declarative cost models on the wire:** `commission` / `slippage` / `hedge.*` are
   `{ model: 'none' | 'bps' | 'perShare' | 'fixed' | … }` descriptors mapped onto `fees.*` and
   `slippage.*` — the library's own factories, one label each, echoed in `assumptions` as before.
7. **Journey packs are opt-in** (Decision 9 counts them apart from the twenty-three defaults); the
   default MCP set stays 23, the backtest pack is 2.

**Evidence.** `packages/workflows/test/journey.test.ts` (19 tests): for every journey operation and
`options_run`, canonical-JSON equality between `runOperation(...).structured` and the direct call —
`screenUniverse` / `rankUniverse` / `scoreUniverse` / `eventStudy`, `runScenarios` over spot + Taylor
targets and over a portfolio bound through Taylor bindings, `portfolioSnapshot` from the envelope and
from a state, `portfolioPnl`, `portfolioTimeline` + `monitorPortfolio` inside `analyze`,
`readAnalysisArtifact` / `compareAnalysisArtifacts`, `optionsBacktest` with `fees.bps` /
`slippage.spread` from their wire descriptors; refusal fixtures for every SDK-only field (a caller
predicate, the custom expected-return model, a `build` entry, an exit predicate, a chain generator, a
pricer target, a market resolver, an unknown cost model); null-is-not-omission on the wire (`policy:
null`, a monitor without `previousState`); a tampered ledger and a tampered artifact refused by the
read doors with the direct call's own code; count safety (`MAX_ROWS` + 1 observations refused, the
field named). Naming walks the journey schemas: identities 32,501 → 32,936 (`mcp-field` 290 → 703,
`mcp-tool` 24 → 35), 0 unresolved. Enforcement unchanged (defective 0; 2,382 · 2,610 · 182 of
5,174). `@totalfinance/workflows` budget 208 → 330 KB (measured 335,951 B — the four composed surfaces
ride along by design). Tools gates 48 files / 2,886 tests green on the first pass.

**Gate findings at landing.** One, found by the parity test rather than a gate: `extendObjectSchema`
(the operation kit's composed schema) could not sit inside `schema.array(...)` — core's containers
speak a nested `_check` protocol the composed schema did not implement, so a chain quote schema
extended with `delta` threw a raw `TypeError` from the array walker. The composed schema now
implements the protocol (exact issue paths through arrays and objects), with a test. The MCP
server test's "defaults + backtest" count moved 24 → 25 (`options_run` joined the pack).

### Slice 3 (landed 2026-09-03) — handles, stores, jobs

**What landed.** In `@totalfinance/workflows` (`stores.ts`): the handle grammar (`HANDLE_KINDS`,
`handleUriOf`, `parseHandleUri`, `requireResourceHandle` — `totalfinance://<reports|jobs|portfolios|scenarios|markets>/<id>`),
`ArtifactStore` (`put` idempotent by content) over `ArtifactStoreReader`, `createMemoryArtifactStore()`,
`JobRecord` / `JobState` / `JobStore` with the state machine (`requireJobRecord`, `applyJobPatch`,
`JOB_STATES`), `createMemoryJobStore()`, and the shared validators every store implementation uses
(`requireArtifactPut`, `requireArtifactListFilter`). In the runtime: **handle resolution** before
validation over `operation.handleFields` (a `totalfinance://` uri or a handle object in place of inline
data; a missing store, an unknown uri, a job handle, and a store whose kind disagrees with the uri
refuse with `operation.handle_store_missing` / `handle_unknown` / `handle_kind_mismatch`; the resolved
value is a fresh copy, so the identity hash is the RESOLVED input), and the **large-output spill**: with
a writable store and the caller's `createdAt`, a structured result above `inlineResultBytes` (default
256 KiB, `OPERATION_BUDGETS.inlineResultBytes`) is stored as a report and the response carries
`{ spilled: true, handle, preview }` with the handle in `artifacts` — never a silent truncation. The
journey operations declare their `handleFields` (`portfolio`, `market`, `ledger`, `from.market`,
`to.market`, `scenarioSet`, `artifact`, `baseline`, `candidate`). **`@totalfinance/cli`** (new, L6,
`integration` tier, node): `createFileArtifactStore({ directory })` (one JSON per content hash under
`artifacts/` plus `index.json`, atomic writes), `createFileJobStore({ directory })` (one JSON per record
under `jobs/`, re-read on every call), registry profiles (`REGISTRY_PROFILES`, `packsForProfile`,
`registryForProfile` — `default | options | research | full`, optionally narrowed to named packs), and
the **worker-terminated job runner**: `submitJob(...)` runs a `costClass: 'job'` operation in a
`worker_threads` Worker that rebuilds the submitter's registry by profile and stores the whole
`OperationResult` as a report handle; `cancel()` terminates the worker and the record moves to
`cancelled` with usage; a non-job operation runs inline and is terminal on return; `cancelJob` works
from ANY process by writing `cancelled` to the shared store, which the running runner honours on its
next poll.

**Decisions at landing.**

1. **A job's result is the whole `OperationResult` stored as a report handle** (identity, usage, and
   diagnostics travel with the structured output), so `job result` and `artifacts get` read one thing.
2. **Cross-process cancellation is store-mediated**: the runner polls the job store (`pollMs`,
   default 250 ms) and terminates its worker when another process has written `cancelled`; the
   in-process `cancel()` terminates immediately. Both are real stops — the worker never posts a result.
3. **The worker rebuilds the registry by profile** (`profile` + optional `packs` travel in
   `workerData`), so a job runs against exactly the set its submitter saw; no registry object crosses
   the thread boundary.
4. **`createdAt` is the caller's clock everywhere** (`put`, the runtime's spill, every job
   transition via `clock`); a writable store handed to `runOperation` without `createdAt` is refused.
5. **`handle_kind_mismatch` has two triggers**: a job handle where data is expected (a job is not
   data — read its result handle), and a store answering a uri with a handle of another kind. A
   resolved envelope of the wrong type for its field is the schema's own refusal (`input.*`).
6. **A memory store's `put` refuses `kind: 'job'`** — jobs live in the job store.

**Evidence.** `packages/workflows/test/stores.test.ts` (5 tests: the uri grammar for every kind, the
closed handle guard, put idempotent by content and copies on the way out, the job state machine, the
guards' refusals) and `journey.test.ts` (+5: compare over report handles as uris and as objects equals
the inline call with the same identity hash; a nested `from.market` / `to.market` market handle; the
three handle refusals plus a malformed uri and a store answering a markets uri with a report; the
spill above `inlineResultBytes` with the preview, the handle in `artifacts`, and the stored value
equal to the inline result; the writable-store / `createdAt` / threshold pairings).
`packages/cli/test/file-stores.test.ts` (3: two instances over one directory, idempotent puts, the
index file, closed doors incl. the absolute-path rule) and `jobs.test.ts` (5: profiles; a job-class run
completing with a report handle another process reads; `cancel()` terminating the worker with no
result ever appearing; an external cancel through the shared store stopping the running job; inline
non-job runs, a refused input as a `failed` record, and the request's refusals). `luSolve` gained a
door test (12 refusals). Enforcement defective 0 (enforced 2,390 · partial 2,619 · unmeasured 180 of
5,189 — the ratchet held under 183 by burning down older `baseline-rejected` debt with four valid-call
fixtures); naming 33,489 identities / 0 unresolved; fixture/contract join 1,142 → 1,168; budgets
workflows 330 → 334 KB (339,416 B), math 39 → 40 KB (40,503 B), research 22 → 22.75 KB (22,908 B).

**Gate findings at landing (each fixed at its source).**

- **Enforcement.** `submitJob` accepted a null `input` and stores missing `list` / registries missing
  `packs` / `size` → every host object is checked member by member and the operation input must be an
  object; `applyJobPatch` trusted `current` and its label → validated whole; a hand baseline for
  `luSolve` (added to burn down debt) exposed that an EDITED `LuResult` was solved into nonsense →
  `requireLuResult` (square finite factors, a valid permutation, sign ±1), a math budget move.
- **The probe writes where it is pointed.** A file-store factory taking `{ directory: string }` was
  synthesized `'x'` and created `totalfinance/x/` inside the repository, and its persisted job id turned a
  later run's valid `create` into a phantom "already exists" defect → file stores REQUIRE an absolute
  path (the CLI resolves `--store` at its edge); fixtures mint a fresh job id per call.
- **Coverage arms.** `OperationRegistry#run`'s `artifacts` option is now a reader OR a writable store
  — two named arms of function-bearing objects the builder cannot instantiate → four rows ledgered
  with the reason (the runtime's own tests exercise both).
- **Parity, naming, docs.** `cancelJob`'s request carries the caller's clock (a function) →
  `UNDESCRIBED_ALLOWLIST` with the reason; `cli` classified as a canonical initialism; the CLI README
  snippet may not import node builtins (the packed consumer compiles the fence without node types) →
  an absolute literal directory; the closeout header now states an omitted rejection bucket as 0
  (the gate reads an absent bucket as zero rather than failing on `undefined`); the count-inventory
  ledger, the join pin (1,168), the generated-docs pins (55 / 24), the naming closeout's package
  count (24), the alignment spec's `cli` cell.

### Slice 4 (landed 2026-09-03) — `@totalfinance/cli`: the `totalfinance` binary

**What landed.** `packages/cli/src/bin.ts` (`bin: { totalfinance }`): `operations list`, `schema <id>
[--output]`, `run <id> --input <file|->`, `job submit|status|result|cancel`, `artifacts get <uri>`,
`serve --http …`, `doctor`, `--help`, `--version`; the global flags `--profile`, `--packs`, `--seed`,
`--max-input-bytes`, `--deadline-ms`, `--store`, `--pretty`. Machine mode is the default (one JSON
document on stdout; logs, help, and the `serve` teaching on stderr; `job status --follow` and `job
submit --follow` stream NDJSON); `--pretty` indents and adds a one-line summary on stderr. The exit codes
are published as `CLI_EXIT_CODES` (0 · 2 · 3 · 4 · 5 · 70) and the command surface as `CLI_COMMANDS`, and
`docs/guides/cli.md` is gated against both (`tools/cli-doc-conformance.test.ts`). The CLI owns no schema
and no compute: `operations list` / `schema` render `describeOperation`, `run` calls `runOperation` over
the file artifact store with the wire byte budget (default 64 KiB), `job *` drives the slice-3 runner and
stores, `doctor` reports the Node floor (22.13.0), the registry summary (operations, packs, the stochastic
and job-class sets), the store directory state, and the resolved budgets.

**Decisions at landing.**

1. **Argument parsing is `node:util`'s `parseArgs`** — no dependency; an unknown flag or a missing
   value is a usage error (exit 2), never an internal one.
2. **The store default is `~/.totalfinance/store`**; a relative `--store` is resolved at the CLI's edge
   (the stores themselves require an absolute path).
3. **`job submit` stays attached** until the record is terminal (a detached submit would orphan the
   worker); SIGINT cancels the job; `job cancel` from another shell reaches it through the shared store.
4. **`serve` exits 2 with the exact `totalfinance-http` invocation** on stderr — L6 packages never depend
   on each other (Decision 6 verbatim); `doctor` also exits 2 when the Node floor is not met (an
   environment problem is a usage problem, not an operation failure).
5. **An error outside an operation call** (an unknown id, a bad store, a malformed job id) is still the
   `OperationError` JSON on stdout with `operation: { id: 'totalfinance…', version: '0' }`, so a script parses
   one shape everywhere.

**Evidence.** `packages/cli/test/bin.test.ts` (8 spawned-process tests against `dist/bin.js`): `--version` /
`--help` / no command / an unknown command or flag (exit 0 · 0 · 2 · 2); `operations list` for the
default and full profiles, narrowed by `--packs`, `--pretty`; `schema` input and output, an unknown id
(exit 4 with `operation.unknown`); `run` from a file and from stdin with byte-identical results, a
refused input (exit 3, the `input.*` document), malformed JSON and a missing `--input` (exit 2), the byte
budget (`operation.input_too_large`), `--seed` echoed under `assumptions.seed`; `job submit` inline and in
a worker, `job result` / `job status` / `artifacts get` from a second process, a refused submission as a
`failed` record (exit 3); a job cancelled from ANOTHER process while `job submit --follow` streams NDJSON
(exit 5, the last line `cancelled` with `result: null`, `job result` exit 5); `serve` (exit 2, the
`totalfinance-http` line on stderr, empty stdout) and `doctor` (the floor, the registry, the store, the
budgets). `tools/cli-doc-conformance.test.ts` (3): the guide names every shipped command and no other,
its exit-code table equals `CLI_EXIT_CODES`, and it states the store default and the byte budgets.
Chain: enforcement unchanged (defective 0; 2,390 · 2,619 · 180 of 5,189), naming 33,489 → 33,519
identities / 0 unresolved, join 1,168 unchanged (the binary is not a public head). Tools gates 49 files /
2,907 tests.

**Gate findings at landing.** None at the sources. Two load findings in the harness, each bounded from a
measurement: the packed-consumer cleanup hook (24 tarballs plus an installed consumer) exceeded vitest's
10 s hook default and is now 60 s; the whole-library variant sweep (`WHOLE_LIBRARY_SWEEP_MS`) crossed
600 s under a coverage run after measuring 412–425 s idle and is now 900 s from the measurement; the
reporter's `onTaskUpdate` RPC timeout recurred (documented flake).

### Slice 5 (landed 2026-09-03) — `@totalfinance/http`: OpenAPI and the local server

**What landed.** **`@totalfinance/workflows/local`** (new node-only subpath; the package root stays
browser-safe): the file stores, the registry profiles, the worker-terminated runner, and the
`JobRunner` contract (`submit` / `cancel` / `get` / `list`) with `createLocalJobRunner` — moved from
`@totalfinance/cli`, which re-exports them, so both transports compose ONE local runtime and no L6 package
depends on another. **`@totalfinance/http`** (new, L6, `integration` tier): `openApiDocument({ registry })`
— OpenAPI 3.1 with one literal `POST /operations/<id>/run` path per operation (typed request bodies),
the template routes of Decision 7, components keyed by id (`<id>.input`, `<id>.output`, `<id>.result`),
one `OperationError` schema, and the `x-totalfinance` extension; `createLocalHttpServer({ registry,
artifacts?, jobs?, host, port, allowNonLoopback?, budgets, clock })` over `node:http` — loopback unless
told otherwise, `X-Request-Id` echoed or minted, the status mapping `statusForError` (404 unknown ·
413 too large · 400 `input.*` · 409 cancelled · 500 internal · 422 otherwise), an oversized body
DRAINED and answered 413 (never a dropped socket), jobs through the injected runner (202 with the
record; result 409 while cancelled or unfinished), artifacts by url-encoded uri, `/capabilities`;
the `totalfinance-http` binary (`--openapi` prints the document); the committed
`packages/http/etc/openapi.json` (`pnpm openapi:update`, gated byte-for-byte by
`tools/openapi-doc.test.ts`); `docs/guides/http.md` gated by `tools/http-doc-conformance.test.ts`.

**Decisions at landing.**

1. **Decision 5's "the HTTP server uses the same runner" and Decision 6's "L6 packages never depend
   on each other" are reconciled by placing the local runtime below L6**, in
   `@totalfinance/workflows/local`; a transport composes it, and a host may supply its own `JobRunner`.
   Decision 5's names (`@totalfinance/cli` ships `createFileArtifactStore`, …) still hold through
   re-exports.
2. **One literal run path per operation** (not only `/operations/{id}/run`): an OpenAPI client gets
   a typed body per operation; the server routes by id regardless.
3. **The wire budget applies to every body, jobs included**; a job that needs bulk data raises
   `--max-input-bytes` (maximum 16 MiB) or references handles.
4. **`GET /jobs/{id}/result` answers 409 (`operation.cancelled`) for a cancelled OR unfinished job**
   and the stored error document (its own status) for a failed one.
5. **No streaming this stage** — progress by polling `GET /jobs/{id}` (Decision 7 verbatim).

**Evidence.** `packages/http/test/server.test.ts` (5 tests, in process on a free port): the OpenAPI
document, capabilities, and descriptions; a run with `X-Request-Id` echoed and minted; refusals mapped
to 400 / 404 with the `OperationError` body; a malformed body; a dedicated tiny-budget server proving
413 (the body drained, the socket kept); the default seed echoed; jobs submitted (202), polled, their
result read, a job-class run cancelled through the API and its result route answering 409; artifacts
by uri; a server without stores teaching instead of pretending; loopback-only binding; the closed
doors of `createLocalHttpServer`, `openApiDocument`, `statusForError`; the document deterministic
across registries. `tools/openapi-doc.test.ts`: the committed document is byte-identical to a fresh
generation and structurally sound (one run path per operation, components keyed by id, every `$ref`
resolving, the vendor extension). `tools/http-doc-conformance.test.ts` (3): every served route named
and no other, the status table, the loopback and budget statements. The moved runtime keeps its cli
tests (14) and gains `createLocalJobRunner`'s door test. Chain: enforcement defective 0 (enforced
2,394 · partial 2,625 · unmeasured 182 of 5,201); naming 33,955 / 0; join 1,168 → 1,175; the workflows
root budget unchanged (the `./local` subpath is not on the browser-safe root). Tools gates 51 files /
2,915 tests.

**Gate findings at landing (each fixed at its source).**

- **Enforcement.** Four new doors measured for the first time accepted unknown keys or nulls —
  `createLocalJobRunner`'s request, the registry handed to `createLocalHttpServer` and
  `openApiDocument` (every member incl. `size`), and `statusForError`'s error document — each closed
  with its structural guard. A fixture is a claim about the CALLABLE: mirrored `workflows.*` copies of
  the `cli.*` thunks (fresh temp directories each) CONFLICTED on the shared implementation; one key per
  callable stands, pooled across both public paths.
- **Naming.** OpenAPI's mandatory `info` object → a scoped-symbol ruling on `OpenApiDocument` (the
  specification's field name, reproduced verbatim), not a global pardon.
- **Public shape.** `LocalHttpServer.server` (node's `http.Server`) leaked intersection parameters
  through the public surface → replaced by `address()`; the raw server stays internal.
- **Pins and ledgers.** The signature / naming / contract ledgers regenerated after a parameter
  rename; the count-inventory ledger (the port bound); one declared-coverage row (the error
  document's `issues[].path` element union, the screen-filter pattern); the join pin (1,175); the
  undescribed-parameter allowlist (`cancelJob|input` under its new home); the naming closeout's
  package count (25); the alignment spec's `http` cell; `packages/http/etc/openapi.json` kept in
  the generator's exact form (`.prettierignore`) so the byte-for-byte gate is honest.

### Slice 6 (landed 2026-09-03) — the MCP preview gate, item by item

**What landed** (`packages/mcp/src/server.ts`, `bin.ts`; Decision 8 verbatim): every listed tool
carries `annotations` DERIVED from its operation (`operationAnnotations`; a custom `defineTool` derives
them from `mutates`); the server sends initialization `instructions` once (pure compute versus live data,
decimal units and years to expiry, `assumptions` and `diagnostics` on every result, deterministic seeds,
the `OperationError` document, handles for bulk data); an unknown tool, resource, or prompt is a
JSON-RPC `McpError` (`InvalidParams`), never an `isError` result; an `isError` result carries the
`OperationError` JSON in its text content and omits `structuredContent` — policy B — on the registry path
AND the custom-tool path (byte budget and parse refusals speak the same document); resources gain
`totalfinance://capabilities` (packs, tool ids, budgets, the seed policy, whether a store is attached) and,
when the server is constructed with an `artifacts` store, every stored report as
`totalfinance://reports/<hash>` (handles in tool inputs resolve through the same store); `packs` accepts
operation packs and tool packs alike; the `screen-options-chain` prompt is removed and
`analyze-option-trade` is checked against the tools it names; `totalfinance-mcp --help | --version |
--profile | --packs | --max-input-bytes | --seed | --deadline-ms | --store | doctor` (help and doctor to
the terminal, then exit; otherwise stdout is JSON-RPC only); the guide describes each item and its gate
checks them (`tools/mcp-doc-conformance.test.ts`).

**Decisions at landing.**

1. **Annotations are derived, never authored** — a custom tool's `mutates` is the only authored bit,
   and it maps to `readOnlyHint` / `destructiveHint` structurally.
2. **The custom-tool path keeps its legacy validation but speaks the OperationError document** with
   `operation: null` (a caller's own tool is not a registry operation).
3. **The store is a constructor argument** (`McpServerOptions.artifacts`, a reader) — the server never
   looks anything up by session; the binary attaches a file store through `--store`.
4. **`doctor` exits 2 below the Node floor**, like the CLI's — an environment problem is a usage problem.

**Evidence.** `packages/mcp/test/preview-gate.test.ts` (8 protocol tests over an in-memory client): every
listed tool carries the derived annotations and the initialization instructions name the conventions; a
custom tool derives its annotations from `mutates`; an unknown tool, resource, and prompt each reject
with `McpError`; an error result is the `OperationError` JSON with no `structuredContent` on both the
registry and the custom-tool path while a success carries both; `totalfinance://capabilities` reports the
budgets and tool ids and a stored report appears as a resource only when a store is attached; the
chain-screen prompt is gone and `analyze-option-trade` names only tools that exist; the binary's `--help`,
`--version`, `doctor` (with `--profile`, `--packs`, `--store`, `--max-input-bytes`), and its usage exits;
operation packs and tool packs accepted alike with the backtest pack opt-in. The three pre-existing tests
that asserted the old shapes (a listed chain-screen prompt; `mcp.unknown_tool` and a filtered tool as
`isError` results) now assert the Decision 8 forms; the other 108 MCP tests pass unchanged. The MCP guide
gate (`tools/mcp-doc-conformance.test.ts`) checks the capabilities and report resources are named, the
removed prompt is not, each preview-gate item and the per-call stochastic predicate are described, and
every binary flag is documented. Chain: enforcement unchanged (defective 0; 2,394 · 2,625 · 182 of
5,201); naming 33,955 → 33,974 / 0 unresolved. Tools gates 51 files / 2,916 tests.

**Gate findings at landing.** One: widening `packs` to accept operation packs re-fingerprinted the
MCP server's sixteen declared-coverage residual rows (the same unbuildable live-`Schema` items, now
qualified by `packs:absent`) — the stale spellings were removed and the new ones derived from the
gate's own output, so the list stays exact.

### Slice 7 (landed 2026-09-03) — transport parity, packed consumers, closeout

**What landed.** `tools/transport-parity.test.ts` with `tools/transport-parity/fixtures.ts`: one canonical
fixture and one malformed fixture per flagship operation — all 35 (the 23 defaults, the 2 backtests, the
10 journey operations; the set is derived from the full-profile registry, so a new operation without a
fixture fails the gate). Each canonical fixture runs through `registry.run`, the `totalfinance` CLI spawned
against the workspace build, the HTTP server in process, and the MCP server over an in-memory client;
the canonical JSON of `structured`, `assumptions` (seed included), `diagnostics.warnings`, the operation
identity, and the input hash must agree, and the MCP tool's listed annotations must equal
`describeOperation`'s. Each malformed fixture must be refused with the same `input.*` code AND message
across all four transports (HTTP 400, MCP `isError` document, CLI exit 3). `tools/packed-consumer.test.ts`
gains two Stage 7A cases from the PACKED tarballs: the CLI listing and running an operation with its
`structured` output bytes-identical to the SDK's; `totalfinance-http --openapi` printing the document, an
in-process server run, and the MCP server listing tools with annotations and running one — all
bytes-identical to the SDK. Closeout: the exit gate ticked, the Completion record written, every
controlling tracker flipped to `COMPLETE @ <commit>` with Stage 5A made the next row.

**Decisions at landing.**

1. **Parity compares a projection, not the whole result**: `usage` (elapsed ms) and `trace.requestId`
   legitimately differ per transport; everything a caller reasons about does not.
2. **The direct SDK composition is proven through the journey tests** (canonical-JSON equality per
   operation in `packages/workflows/test/journey.test.ts`) rather than duplicated here — the parity gate
   starts from `registry.run`, which those tests already tie to the direct call.
3. **The stochastic fixtures carry an explicit seed** so the byte comparison is exact; the seed-injection
   path is proven separately (the runtime and MCP tests).

**Evidence.** `tools/transport-parity.test.ts`: 71 tests — the fixture set equals the registry's 35
ids, then per operation one parity test (registry / HTTP / MCP / CLI projections byte-identical; MCP
annotations equal `describeOperation`'s) and one refusal test (the same `input.*` code and message from
all four; HTTP 400, MCP `isError` document, CLI exit 3). `tools/packed-consumer.test.ts`: 41 tests, the
two Stage 7A cases among them — from the packed tarballs, the CLI's `operations list` count equals the
SDK registry's size and its `run` output canonicalizes to the SDK's bytes; `totalfinance-http --openapi`
prints a 3.1 document with the per-operation run path; an in-process HTTP run and an MCP tool call both
canonicalize to the SDK's bytes and the MCP tool list carries annotations. Every earlier slice's suites
pass unchanged; the full CI run and a second pass are recorded in the completion record.

**Gate findings at landing.** Two, both in the harness: `tools/` could not resolve
`@modelcontextprotocol/sdk` (a dependency of `@totalfinance/mcp` only) → a root devDependency for the gate;
the packed cases first reused the ledger-journey hash recorder, which expects a `sha256:` marker →
they assert their own markers instead.

## Historical completion record and current handoff

**Stage 7A is COMPLETE @ `c7bdb260d` (2026-09-03).** Seven slices, each landed as one commit with tests,
generated evidence, and its record above:

| Count                              | Value                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Operations in the registry         | 35 — 23 defaults, the 2 opt-in backtests, 10 journey operations (`totalfinance.<domain>.<verb>`)                                     |
| Packs                              | 10 domain packs (the default set), 4 journey packs, the opt-in backtest pack                                                         |
| Transports over the one definition | the SDK registry, the `totalfinance` CLI, `totalfinance-http` (OpenAPI 3.1), the MCP server                                          |
| Parity fixtures                    | 35 canonical + 35 malformed, proven across all five surfaces (`tools/transport-parity.test.ts`)                                      |
| Packed consumers                   | the CLI list/run, `totalfinance-http --openapi` + an in-process run, the MCP tool list with annotations — bytes-identical to the SDK |
| New packages                       | `@totalfinance/workflows` (L5, with `./local`), `@totalfinance/cli` (L6), `@totalfinance/http` (L6) — in their ratified rows         |
| Registered codes                   | nine `operation.*` error codes in core                                                                                               |
| Enforcement at closeout            | defective 0 across 5,201 candidates; every unmeasured row carries a reason; the ratchet never rose                                   |

**What a caller could do at the Stage 7A closeout** that they could not before this stage: run any of the 35 operations
through one definition from four front doors and get byte-identical `structured` output, the same
`assumptions` (seed echoed), the same warnings, and the same `OperationError` document for the same
refusal; submit a job-class backtest, poll it, cancel it from another shell or over HTTP and see the
worker actually stop; hand a `totalfinance://` handle instead of bulk data and get a spilled result back
as one; read the OpenAPI document or the MCP capabilities resource and find exactly what ships.

**Originally deferred, by decision, to later stages** (historical, not the current supported-operation list): `portfolio.propose_rebalance`,
standalone `portfolio.monitor`, `trade.preflight`, `portfolio.record_events`, `trade.submit` (Decision 4 —
writes and orders are Stage 7B and later); loop-level cancellation checks inside compute (Decision 5 —
Stage 4.6/7B); streaming job progress (Decision 7 — polling this stage); the cross-client natural-language
MCP evaluation (the strategy doc's Preview Gate row that needs a client harness, not this contract);
`@totalfinance/data` and every connected transport (Gate A rows pre-declared, untouched).

**Current handoff:** the [September review repairs](./review-september-2026-repairs.md) are locally
verified complete under [`implementation-order.md`](../implementation-order.md). Stages 4.6, 4.7,
7B.1, and 7B.2 also landed; do not restart those stages or the repairs. Stage 5A publication and
Stage 5B cutover remain maintainer-held and require their release gates. No publication, commit,
push, or hosted-matrix success is authorized or implied by local verification.
