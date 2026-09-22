# MCP Server

`@insiderfinance/totalfinance-mcp` exposes TotalFinance computations to AI agents through the Model Context Protocol. The server is read-only by default and wraps the same public TotalFinance APIs used by application code.

## Quickstart

The checked-in package version is `0.1.0`, an **unpublished preview**. From a built checkout
(Node ≥22.13), run the local binary; this does not require a registry release:

```sh
pnpm build
node distribution/mcp/dist/bin.js doctor --profile options
node distribution/mcp/dist/bin.js --profile options
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "@insiderfinance/totalfinance": {
      "command": "node",
      "args": [
        "/absolute/path/to/totalfinance/distribution/mcp/dist/bin.js",
        "--profile",
        "options"
      ]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add totalfinance -- node /absolute/path/to/totalfinance/distribution/mcp/dist/bin.js --profile options
```

**Cursor** — add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "@insiderfinance/totalfinance": {
      "command": "node",
      "args": [
        "/absolute/path/to/totalfinance/distribution/mcp/dist/bin.js",
        "--profile",
        "options"
      ]
    }
  }
}
```

## Install

After a package version has actually been published, pin that exact version to embed
`createTotalFinanceMcpServer` in your own server. For the planned first release, verify that
version `0.1.0` is available; no publication is implied here:

```sh
pnpm add @insiderfinance/totalfinance-mcp@0.1.0
```

## Run

```sh
pnpm exec totalfinance-mcp
```

Omitting `--profile` keeps the 23-tool default. The examples above deliberately select only the
options task. The server supplies no quotes or other live data: ask it to list tools, inspect
`totalfinance://capabilities`, then provide inputs matching the chosen tool's schema.

## Task profiles and permissions

Profiles are shared with the local CLI/worker registry. Read `totalfinance://profiles` for names,
pack selections, and descriptions derived from operation titles.

| Profile       | Selected packs                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `default`     | `options`, `technical_analysis`, `strategy`, `volatility`, `structure`, `risk`, `performance`, `calendar`, `crypto`, `fixed_income` |
| `options`     | `options`, `volatility`                                                                                                             |
| `research`    | `research`                                                                                                                          |
| `strategies`  | `options`, `strategy`, `volatility`                                                                                                 |
| `portfolio`   | `portfolio`, `risk`, `performance`, `artifact`                                                                                      |
| `valuation`   | `valuation`                                                                                                                         |
| `backtesting` | `backtest`, `performance`, `artifact`                                                                                               |
| `scenarios`   | `scenario`, `artifact`                                                                                                              |
| `full`        | All default packs plus `portfolio`, `scenario`, `research`, `artifact`, `valuation`, `backtest`, `trade`                            |

`--packs options,volatility` narrows the chosen profile exactly; an unknown or repeated pack is a
configuration error. Embedders can pass `profile`, or explicit `tools`/`packs`:
explicit selections suppress implicit profile tools, and `packs: []` or `tools: []` is empty.
If both explicit arrays are provided their union is used. No profile grants capabilities.

Default capabilities are `portfolio:read`, `analytics:run`, and `trade:propose`. A supplied
`capabilities` array (or repeated binary `--capability`) is an **exact replacement**, not an addition
to the defaults. Tools lacking required grants are excluded from listing, schemas, prompts, and calls.
Financial `readOnly: true` also excludes writes and approval, including `trade:approve` even though
authorization has `sideEffect: 'none'`. The binary lifts this filter only when explicitly given a
write/approval capability (`trade:approve`, `trade:paper`, or `portfolio:write`).

An enabled operation can still need its authorization or journal store and a valid plan-bound human
grant. Attaching a store or selecting `full` supplies neither that grant nor live-order permission.
The capability ceiling is server configuration; callers cannot enlarge it in tool arguments.

## Tools

A tool's name is its operation id with every dot replaced by an underscore: the operation
`totalfinance.option.price` is the tool `totalfinance_option_price` (`toolNameFor(id)` in `@insiderfinance/totalfinance-mcp`
is the one rule). The dotted id stays the operation's identity everywhere else — in
`_meta['totalfinance/operation'].id`, `totalfinance://operations/<id>`, the HTTP paths and the CLI — and
job submission takes the dotted id in its `id` argument.

The default server exposes 23 read-only tools, grouped into ten domain packs (`options`, `technical_analysis`,
`strategy`, `volatility`, `structure`, `risk`, `performance`, `calendar`, `crypto`, `fixed_income`):

**Options** — `totalfinance_option_price`, `totalfinance_option_greeks`, `totalfinance_option_implied_volatility`

**Strategy** — `totalfinance_strategy_analyze` (raw signed-quantity legs, or a named builder via
`strategy` + `input`; model-priced premiums from strikes alone; PoP; structural `classification`),
`totalfinance_strategy_list` (the ~58-builder catalog with a canonical example input per builder)

**Volatility** — `totalfinance_volatility_expected_move`, `totalfinance_volatility_probability_in_the_money`,
`totalfinance_volatility_probability_of_touch`, `totalfinance_volatility_surface` (fit + arbitrage report),
`totalfinance_volatility_metrics` (IV rank/percentile/stats), `totalfinance_volatility_event` (earnings-move
decomposition + variance risk premium)

**Structure** — `totalfinance_structure_exposures` (GEX/DEX, walls, zero-gamma, max pain),
`totalfinance_structure_flow` (sweeps/blocks/spreads with honest NBBO-estimation caveats)

**TA** — `totalfinance_technical_analysis_calculate` (any of the ~300 registered indicators; the structured output is
the explain envelope — `assumptions.params` echoes the parameters actually used),
`totalfinance_technical_analysis_list`,
`totalfinance_technical_analysis_describe` (one indicator's full metadata card: category, inputs,
parameters, defaults, warmup)

**Performance & risk** — `totalfinance_performance_analyze` (the full summary as a `Computed`
envelope), `totalfinance_risk_value_at_risk` (stochastic: the Monte-Carlo method is governed by the
seed policy), `totalfinance_risk_optimize` (minVariance / maxSharpe / meanVariance / riskParity /
hrp / kelly)

**Calendars** — `totalfinance_calendar_sessions` (trading days, holidays, half days, and
holiday-shifted weekly/OPEX/quarterly option expirations)

**Crypto** — `totalfinance_crypto_perpetual_funding` (funding-rate → annualized implied carry with the
mark/index premium and extreme-funding flag), `totalfinance_crypto_futures_basis` (dated-futures
cash-and-carry: annualized basis, contango/backwardation, arbitrage flag)

**Fixed income** — `totalfinance_fixed_income_bond_analytics` (fixed-rate bond price↔yield with
clean/dirty price, accrued interest, Macaulay/modified duration, convexity, and DV01)

**Enabling a subset.** The ten domain packs above are exported (`optionsPack()`, `technicalAnalysisPack()`, …,
`defaultPacks()`); pass a subset to expose only those domains — `createTotalFinanceMcpServer({ packs:
[optionsPack(), technicalAnalysisPack()] })` hands an agent only the option and TA tools instead of all 23.

**Opt-in packs:** `packs` is an exact selection, so expanding the defaults is explicit —
`createTotalFinanceMcpServer({ packs: [...defaultPacks(), backtestPack()] })` adds
`totalfinance_backtest_vectorized_run`, `totalfinance_backtest_options_run`,
`totalfinance_backtest_cross_sectional_run`, `totalfinance_backtest_portfolio_run`, and
`totalfinance_backtest_environment_episode` (payload/runtime
heavy, deliberately not defaults) on top of the standard 23.

**Journey packs:** five
opt-in packs compose whole workflows from the same public functions — `portfolioPack()`
(`totalfinance_portfolio_snapshot`, `totalfinance_portfolio_explain_pnl`, `totalfinance_portfolio_analyze`,
`totalfinance_portfolio_rebalance_proposal`), `scenarioPack()` (`totalfinance_scenario_run`),
`researchPack()` (`totalfinance_research_screen`, `totalfinance_research_rank`, `totalfinance_research_score`,
`totalfinance_research_event_study`), `artifactPack()` (`totalfinance_artifact_read`,
`totalfinance_artifact_compare`), and `valuationPack()` (`totalfinance_valuation_company`); `journeyPacks()`
returns all five. Their inputs are the serialized
versioned envelopes (a portfolio ledger, a market snapshot, a scenario set, an analysis artifact) and
each result is the direct function's result verbatim — nothing is aggregated by the tool.
Wire-only restrictions are narrower schemas, never different meanings: a caller predicate, a custom
expected-return function, a callback entry/exit rule, or a custom pricer target is SDK-only.

**Trade lifecycle:** the opt-in `trade` pack (from `@insiderfinance/totalfinance/workflows`, also in `full`) contains
`totalfinance_trade_preflight`, `totalfinance_trade_authorize`, `totalfinance_trade_submit`,
`totalfinance_trade_cancel`, `totalfinance_trade_reconcile`, and `totalfinance_portfolio_record_events`.
These support preflight, explicit grants, paper execution, reconciliation, and ledger writes—not
live brokerage routing. Use the effective capability report to see required grants and exclusions.

Input schemas are generated from the TotalFinance schema facade with `toJSONSchema()`. The same schemas validate tool calls before computation runs, and every numeric field's description states its unit convention (`decimal, e.g. 0.22`; `years, e.g. 30/365`).

## Resources, prompts, and bounded discovery

Tools carry their complete input/output schemas and operation-derived annotations and metadata.
The `_meta` entries `totalfinance/operation`, `totalfinance/execution`,
`totalfinance/supportsCancellation`, and `totalfinance/descriptionUri` describe the financial contract
and the effective execution path. Schemas are not replaced by prose summaries.

| Resource                                                                                                   | Contents                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalfinance://capabilities`                                                                              | Effective profile/explicit selection, packs, tool ids, exclusion reasons, held/required grants, read/write stores, budgets, seed policy, and optional job configuration |
| `totalfinance://profiles`                                                                                  | All task profile names, descriptions, and selected packs; this is discovery, not permission to call excluded tools                                                      |
| `totalfinance://operations/<operation-id>`                                                                 | Full description and schemas for an enabled operation                                                                                                                   |
| `totalfinance://schema/tool/<name>/input`                                                                  | Complete strict input schema                                                                                                                                            |
| `totalfinance://schema/tool/<name>/output`                                                                 | Structured output schema, when declared                                                                                                                                 |
| `totalfinance://schema/bar`, `totalfinance://schema/option-contract`, `totalfinance://schema/option-quote` | Canonical payload schemas                                                                                                                                               |
| `totalfinance://policy/seed`                                                                               | Deterministic seed policy                                                                                                                                               |
| `totalfinance://reports/<hash>`                                                                            | Permitted report in the attached artifact store                                                                                                                         |
| `totalfinance://jobs/<jobId>`                                                                              | Job status and progress, only with a runner attached                                                                                                                    |
| `totalfinance://jobs/<jobId>/result`                                                                       | Completed job's unchanged OperationResult, only with a runner attached                                                                                                  |

Both `tools/list` and `resources/list` return at most `pageSize` entries (default 100, allowed 1–100).
Send the returned `nextCursor` as the next request's `cursor`; stop when `nextCursor` is absent.
An empty catalog returns an empty array without a cursor. Cursors are opaque, signed, and bound to
this server instance, catalog, and catalog snapshot. Empty, malformed, modified, cross-server,
cross-catalog, and stale cursors are JSON-RPC `InvalidParams` (`-32602`), not an empty page.
Restart without a cursor after a catalog changes (for example, a new stored report).

Prompts are listed and callable only when their required tools are available:

| Prompt                  | Required tool(s)                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `analyze-option-trade`  | Option price and Greeks; implied volatility is mentioned only when that tool is also enabled |
| `analyze-strategy`      | Strategy analysis                                                                            |
| `explain-portfolio-pnl` | Portfolio P&L explanation                                                                    |
| `value-company`         | Company valuation                                                                            |
| `run-backtest`          | Options backtest                                                                             |
| `explore-scenarios`     | Scenario run                                                                                 |
| `screen-research`       | Research screen                                                                              |

Supply the listed non-empty required prompt arguments and no unknown keys. Prompts ask for missing
inputs instead of inventing prices, rates, or market data, and direct the client to report returned
`assumptions` and `diagnostics.warnings`. A reduced profile never advertises an unavailable prompt.

## Local jobs without experimental MCP tasks

Enable the existing local worker runner explicitly:

```sh
totalfinance-mcp --profile backtesting --store /absolute/path/to/totalfinance-store --jobs
```

`--store` alone does not enable jobs. Without a runner the job controls are absent.
With a runner attached, the existing `costClass: 'job'` tools await worker completion asynchronously
and keep their original financial input/output schemas. Other cost classes remain inline:
the current registry classifies `totalfinance.backtest.vectorized_run` as inline. There is no inferred
offloading from a tool's name and no silent inline fallback on a configured job path.

For fetch-later work, use the four opt-in tools:

| Tool                      | Arguments       | Result                                                                 |
| ------------------------- | --------------- | ---------------------------------------------------------------------- |
| `totalfinance_job_submit` | `{ id, input }` | Job record, progress, `statusUri`, `resultUri`, and next-step guidance |
| `totalfinance_job_status` | `{ jobId }`     | Current job record and progress                                        |
| `totalfinance_job_result` | `{ jobId }`     | `{ result: OperationResult }` when completed                           |
| `totalfinance_job_cancel` | `{ jobId }`     | Cancelled or already-terminal job record                               |

Submission is a discriminated union of the **effective eligible operations**, each with its original
input schema. It is not an arbitrary execution tool. There is no capability, store, seed-policy, or
budget override in this control request. The outer request also counts toward the input byte budget.
Use the returned job id verbatim: job controls accept 1–200 characters from `[A-Za-z0-9:._-]`.

Status preserves the runner's actual `progress` when provided. Otherwise it reports lifecycle state
(`accepted`, `queued`, `running`, `completed`, `failed`, `cancelled`) with an unknown fraction;
completion has fraction 1. This is not an invented calculation percentage. Awaited heavy calls also
send ordinary MCP `notifications/progress` when the client requests progress. Standard MCP request
cancellation stops an awaited worker; explicit job cancellation stops fetch-later work through the
same runner. Cancelling a terminal job is idempotent.

Results retain `structured`, `assumptions`, `diagnostics`, `identity`, and artifact handles.
The result resource returns the OperationResult directly; the result tool wraps it under `result`.
A failed job returns the original operation error. Accepted, queued, or running result reads return
`input.wrong_shape` with the actual state: poll status and fetch again when completed. A genuinely
cancelled job returns `operation.cancelled`; polling early never claims cancellation.

With jobs attached, report **resources** are visible only when attributed to an enabled operation,
an allowed job (its result handle or matching `handle.provenance.requestId === job.id`), or a report
descendant reached through their `OperationResult.artifacts` handles. The shared runner stamps
spill ownership before the outer result exists; it applies to unfinished, failed and cancelled
jobs too. Disallowed job/operation roots and their report descendants stay hidden from both listing
and direct URI reads; denial wins if a child has allowed and disallowed parents. Traversal is
transitive and cycle-safe. Unattributed/orphan reports are hidden, including spills whose outer
result is missing and no matching owner is recorded. Input datasets, arbitrary payload URI strings, and non-report handles do not
establish report ownership. The explicitly attached reader still resolves operation input handles
(including report-backed datasets); without jobs attached its reports retain the existing resource
behavior. This is a resource-discovery filter, **not a multi-tenant ACL**: hosts needing isolation
must provide appropriately isolated/filtered stores and runners.

Embedders attach the shared runner and its artifact reader explicitly:

```ts
import { createTotalFinanceMcpServer } from '@insiderfinance/totalfinance-mcp';
import {
  createFileArtifactStore,
  createLocalJobRunner,
  registryForProfile,
} from '@insiderfinance/totalfinance/workflows/local';

const profile = 'backtesting';
const directory = '/absolute/path/to/totalfinance-store';
const registry = registryForProfile({ profile });
const jobs = createLocalJobRunner({
  registry,
  directory,
  profile,
  clock: () => new Date().toISOString(),
});
const server = createTotalFinanceMcpServer({
  profile,
  jobs,
  artifacts: createFileArtifactStore({ directory }),
  pageSize: 25,
});
// Connect server to the host's MCP transport.
```

If using an explicit pack subset, the server and worker must reconstruct that same set and operation
versions. The current JobRunner submission contract carries no grant/store authorization context:
only job-class operations with no financial effects, no authorization requirement, and no required
capabilities are eligible. Unsupported privileged job operations are filtered out. Job reads,
cancellation, and result resources obey the same effective eligibility ceiling even when the attached
runner is broader. Use separate store directories when hosts need result isolation; this is not a
multi-tenant hosted service. No experimental protocol tasks or process-wide job registry are used.

## Errors, budgets, and reproducibility

Financial tool annotations are derived from operation effects. The default compute set advertises
`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and
`openWorldHint: false`; these are not blanket claims about opt-in writes or job controls.
Initialization `instructions` explain decimal units, years to expiry, assumptions, diagnostics,
seeds, handles, and the configured execution path.

A successful call returns the `OperationResult` envelope as `structuredContent` — `operation`,
`library`, `summary`, `structured` (or `{ spilled: true, handle, preview }` when the result was
stored as a report), `assumptions`, `diagnostics` (warnings, `status`, `incomplete`), `identity`,
`artifacts`, `usage`, `trace` — byte-for-byte the document the JSON HTTP route sends and the CLI
prints, with the one-line `summary` as the only text content block. Every tool's `outputSchema`
describes that envelope around its own structured schema.

Unknown tools/resources/prompts, invalid prompt arguments, and invalid cursors return JSON-RPC
`McpError` with `InvalidParams` (`-32602`). A call to a tool this server filtered out (read-only
mode, a missing grant, or an unsupported job class) is an `isError: true` result whose
`OperationError` names the reason (`operation.capability_missing` or `operation.tool_filtered`)
and points at `totalfinance://capabilities`. A known tool's input/computation failure is
an `isError: true` result with the `OperationError` JSON in text content and **no**
`structuredContent`:

```json
{
  "code": "operation.handle_unknown",
  "message": "The requested handle is unavailable.",
  "context": {},
  "operation": null
}
```

This illustrates the error shape, not fixed error prose. Financial operations identify their id/version
when known and validation errors may also include `issues`. Job-result resource failures use
`McpError` with the OperationError in its data. Clients should branch on codes:

| Code                                                                                           | Meaning                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `input.*`                                                                                      | Strict schema/configuration validation failed; use the supplied field issues          |
| `operation.input_too_large`                                                                    | Raw UTF-8 request exceeds the server budget                                           |
| `operation.capability_missing`                                                                 | Required runtime grant is absent; filtered MCP tools normally fail earlier as unknown |
| `operation.handle_store_missing`, `operation.handle_unknown`, `operation.handle_kind_mismatch` | Missing store, unavailable handle/job, or wrong result/handle identity                |
| `operation.unknown`                                                                            | Unsupported operation requested through the typed job control                         |
| `input.wrong_shape`                                                                            | Job result not ready; inspect state and poll status before fetching again             |
| `operation.cancelled`                                                                          | Genuinely cancelled work; inspect state                                               |
| `operation.deadline_exceeded`                                                                  | Work exceeded the runtime deadline                                                    |
| `operation.internal`                                                                           | Unexpected runtime/worker failure                                                     |

| Setting                               | Default and bounds                                                      |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `maxInputBytes` / `--max-input-bytes` | 65,536 UTF-8 bytes; positive safe integer, maximum 16,777,216           |
| `pageSize` / `--page-size`            | 100 entries; integer 1–100, applies to tools/resources catalogs         |
| `defaultSeed` / `--seed`              | 0; safe integer; the operation's seed schema remains authoritative      |
| `deadlineMs` / `--deadline-ms`        | Omitted: no deadline; otherwise a positive safe integer in milliseconds |

Operation-owned row/path/iteration caps remain in the input schemas and runtime. A deadline is not a
promise of hard real-time preemption: inline deadlines are post-hoc; explicit cancellation terminates
a worker. Writable artifact stores use the shared runtime's 256 KiB inline-result threshold and return
handles with bounded previews instead of silently truncating. The full stored report remains readable.

`totalfinance_risk_value_at_risk` is stochastic only for `method: 'monteCarlo'`. Stochasticity is
decided on the **parsed** input, so defaults count. A stochastic call without a seed receives
`defaultSeed` and echoes it under `assumptions.seed`; deterministic calls receive no meaningless
seed. Neither transport nor prompt adds new quantitative semantics.

## Binary configuration and doctor

```sh
totalfinance-mcp --help
totalfinance-mcp --version
totalfinance-mcp doctor --profile full --page-size 25
totalfinance-mcp --profile options --packs options --max-input-bytes 65536 --seed 7
totalfinance-mcp --profile portfolio --store /absolute/path/to/store --store-read-only
totalfinance-mcp --profile full --store /absolute/path/to/store --capability trade:approve
```

`--profile` accepts the profile names above; `--packs` is exact narrowing; `--capability` is
repeatable. `--store` attaches writable artifacts plus authorization and execution-journal stores.
`--store-read-only` requires `--store`, attaches only the artifact reader, and cannot be combined
with `--jobs`. `--jobs` requires a writable `--store` and adds exactly the four job controls.
`--deadline-ms`, `--seed`, `--max-input-bytes`, and `--page-size` follow the bounds above.

`doctor` validates the same configuration as the real server before reporting the Node floor,
effective tool count, filters, grants, read/write stores, budgets, and job attachment. Invalid
configuration or an unmet Node floor exits 2. Help is written to stderr; version and doctor are JSON
on stdout, then exit. Once protocol mode starts, stdout is JSON-RPC only and logs go to stderr.

## Safety and coverage limits

- Financial read-only mode does not prohibit explicitly configured local artifact/job persistence.
- No compute tool fetches data or sends a live brokerage order. Paper operations require explicit
  capabilities, trusted stores, and applicable authorization grants.
- Only listed operations are MCP-supported. Callback-based APIs and unlisted model families remain
  SDK-only; a broad underlying package export surface does not imply universal wire coverage.
- Validation errors and quantitative non-convergence remain distinct: diagnostics disclose the latter,
  never replace it with a guessed result.
