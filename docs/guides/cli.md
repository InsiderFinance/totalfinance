# Command line

`@totalfinance/cli` ships the `totalfinance` binary: the local, machine-first front door to the same operation
registry every transport adapts (`@totalfinance/workflows`). It owns no schema and no compute — every
command renders `describeOperation`, calls `runOperation`, or drives the file-backed stores and the
worker-terminated job runner. JSON goes to stdout, logs and prompts to stderr, and the exit code is a
contract.

## Quickstart

```sh
npx -y @totalfinance/cli operations list --pretty
npx -y @totalfinance/cli schema totalfinance.option.price --pretty
echo '{"type":"call","spot":100,"strike":105,"timeToExpiryYears":0.25,"riskFreeRate":0.04,"volatility":0.2}' \
  | npx -y @totalfinance/cli run totalfinance.option.price --input -
```

## Commands

| Command                                                     | What it prints                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `totalfinance operations list`                              | every registered operation's description (id, version, schemas, effect metadata, annotations)      |
| `totalfinance schema <id> [--output]`                       | the operation's input JSON Schema (or its output schema with `--output`)                           |
| `totalfinance run <id> --input <file\|->`                   | the `OperationResult` of an inline run (`-` reads stdin)                                           |
| `totalfinance job submit <id> --input <file\|-> [--follow]` | the terminal job record; a job-class operation runs in a worker, anything else runs inline         |
| `totalfinance job status <jobId> [--follow]`                | the job record; with `--follow`, one NDJSON line per change until the record is terminal           |
| `totalfinance job result <jobId>`                           | the stored `OperationResult` of a completed job                                                    |
| `totalfinance job cancel <jobId>`                           | the cancelled record — from ANY process: the running runner terminates its worker on the next poll |
| `totalfinance artifacts get <uri>`                          | `{ handle, value }` for a `totalfinance://…` handle                                                |
| `totalfinance serve --http [--port] [--host] [--openapi]`   | the exact `totalfinance-http` invocation, then exit 2 — this binary never serves HTTP              |
| `totalfinance doctor`                                       | the Node floor, the registry summary, the store directory state, the resolved budgets              |
| `totalfinance --help` · `totalfinance --version`            | help on stderr · `{ totalfinance, workflows, node }` on stdout                                     |

## Global flags

| Flag                                         | Meaning                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--profile default\|options\|research\|full` | the registry profile (`default` = the ten domain packs; `full` adds the journey and backtest packs)          |
| `--packs a,b`                                | narrow the profile to named packs — an exact selection                                                       |
| `--seed <int>`                               | the default seed injected into a stochastic call that omits its own (echoed in `assumptions.seed`)           |
| `--max-input-bytes <n>`                      | the wire byte budget (default 65,536; maximum 16,777,216)                                                    |
| `--deadline-ms <n>`                          | the post-hoc deadline of an inline run                                                                       |
| `--store <dir>`                              | the artifact and job store directory (default `~/.totalfinance/store`; an absolute path is resolved for you) |
| `--pretty`                                   | human mode: indented JSON on stdout and a one-line summary on stderr                                         |

## Exit codes

| Code | Meaning                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| `0`  | success — stdout carries one JSON document                                                                  |
| `2`  | usage — an unknown command or flag, a missing argument, malformed `--input`, an environment below the floor |
| `3`  | the input was refused — an `OperationError` with an `input.*` code                                          |
| `4`  | the operation failed — any other `OperationError`                                                           |
| `5`  | the job was cancelled before it produced a result                                                           |
| `70` | an internal error — a bug or a missing worker build, never an input problem                                 |

The error document on stdout is the `OperationError` JSON (`{ code, message, context, operation }`),
the same document the HTTP server and the MCP server return for the same refusal.

## Jobs and handles

A `costClass: 'job'` operation (`totalfinance.backtest.options_run`, `totalfinance.backtest.vectorized_run`,
`totalfinance.backtest.cross_sectional_run`, `totalfinance.backtest.portfolio_run`) runs in a `worker_threads` Worker that rebuilds your profile's registry and writes the whole
`OperationResult` into the store as a `totalfinance://reports/<hash>` handle. `job submit` stays attached
until the record is terminal (`--follow` streams each transition); `job cancel` from another shell
marks the record `cancelled` and the running process terminates its worker — the work actually stops.
Every store is a directory two processes can share; nothing is kept in a session.

An input field that accepts a handle (`handleFields` in the operation's description) takes a
`totalfinance://…` uri or a handle object in place of inline data; the runtime resolves it through the
store before validation. A result whose canonical bytes exceed 256 KiB is stored and returned as
`{ spilled: true, handle, preview }` — never silently truncated.
