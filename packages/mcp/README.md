# @insiderfinance/totalfinance-mcp

> TotalFinance MCP server: exposes the TotalFinance engine to AI agents via the Model Context Protocol. Read-only by default.

Part of **[TotalFinance](https://github.com/InsiderFinance/totalfinance#readme)** — a TypeScript quant toolkit with browser-safe calculation entry points. The main package has no runtime dependencies; optional MCP adds the MCP SDK. On the pro API every result carries its `assumptions` and `diagnostics` (model, conventions, seed, convergence) so nothing is hidden.

## Install

Source version 0.1.0: this command describes the planned published experience, not a verified npm installation. Until publication, use a [source checkout](https://github.com/InsiderFinance/totalfinance#develop).

```sh
pnpm add @insiderfinance/totalfinance-mcp@0.1.0
```

## Example

```ts
import { defaultTools } from '@insiderfinance/totalfinance-mcp';
const toolNames = defaultTools().map((t) => t.name); // the read-only compute tools
```

_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._

## Imports and bundles

For portable browser tree shaking, use named imports from `@insiderfinance/totalfinance/<domain>` or supported feature subpaths such as `@insiderfinance/totalfinance/math/normal`. Use public exports, never private `dist` paths.

Installation size is not final bundle size: one main package contains all domains; a bundler removes unused code. The main package has no runtime dependencies. MCP is a separate optional package. Plain Node ESM performs no automatic dead-code elimination. Facades include validation and `.explain()` services; indicators also carry streaming support, not just a bare formula. Type-only imports add no runtime code.

See [Imports and bundles](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guides/imports-and-bundles.md) for examples, namespace tradeoffs, and the generated measurement report.

## Local discovery and jobs

The default server still exposes exactly **23 compute tools**. Profiles select operations, not
permissions: `default`, `options`, `research`, `strategies`, `portfolio`, `valuation`, `backtesting`, `scenarios`, `full`. Names and descriptions are discoverable at `totalfinance://profiles`, derived
from the shared workflows registry. Explicit `tools`/`packs` replace implicit profile selection;
`packs: []` is empty. Binary `--packs` narrows the selected profile exactly.

`totalfinance://capabilities` and `totalfinance-mcp doctor` report the effective tool set, excluded tools and
filter reasons, held/required capabilities, actual read/write stores, budgets, and job attachment.
`readOnly` filters financial writes, including approval; an attached writable artifact store may
still store reports. Neither a profile nor a store mints authorization grants. A capability option
is a server-owned ceiling, never a tool argument. Paper trading is not live order routing.

Tools include operation-derived effect, cost, handle, cancellation, and schema metadata. Read
`totalfinance://operations/<operation-id>` for the full operation description. Both tools and resources
lists return at most `pageSize` entries (default/max 100; minimum 1). Follow `nextCursor` until absent.
Cursors are opaque and specific to this server, catalog, and snapshot. Malformed, modified,
cross-catalog, cross-server, and stale cursors return JSON-RPC `InvalidParams`; restart without a
cursor. Prompts are listed and callable only when their required tools exist; they ask for missing
inputs, never invent live data, and report only supported results.

```sh
totalfinance-mcp --profile backtesting --store /absolute/path/to/totalfinance-store --jobs
totalfinance-mcp doctor --profile full --page-size 25
totalfinance-mcp --profile portfolio --store /absolute/path/to/totalfinance-store --store-read-only
```

`--jobs` is explicit and requires a writable `--store`; `--store` alone does not enable jobs.
`--store-read-only` attaches only a reader and cannot be combined with `--jobs`. Embedders pass
`jobs: createLocalJobRunner({ registry, directory, profile, packs?, clock })` from
`@insiderfinance/totalfinance/workflows/local` plus the same directory's `artifacts` reader to
`createTotalFinanceMcpServer`. The runner must reconstruct the same registered operations and versions.
There is no process-wide job runner and no experimental MCP task dependency.

With jobs attached, existing **job-class** tools await worker completion asynchronously and retain
their original input/output financial schemas. Other cost classes remain inline (including the
currently inline `vectorized_run`); their deadlines remain post-hoc. For fetch-later work, use:

1. `totalfinance.job.submit` with `{ id, input }`. Its discriminated schema enumerates only enabled,
   unprivileged job-class operations and embeds each operation's input schema. No arbitrary code,
   capability, store, or per-call budget override is accepted.
2. `totalfinance.job.status` with `{ jobId }`, or read the returned `statusUri`. Progress is the actual
   runner stage when provided, otherwise lifecycle state with an unknown fraction—not invented
   calculation percentages. Awaited heavy calls also send standard MCP progress notifications.
3. `totalfinance.job.result` with `{ jobId }` returns `{ result: OperationResult }`; `resultUri` reads the
   unchanged result directly. Assumptions, diagnostics, identity, and report handles are preserved.
4. `totalfinance.job.cancel` with `{ jobId }` cancels unfinished work through the existing worker runner.
   Terminal cancellation is idempotent. Failed jobs return their original `OperationError`;
   early result reads return `input.wrong_shape` with the actual state; only cancelled work returns `operation.cancelled`.
   Cancellation stops outstanding work; it is not rollback or deletion of reports already persisted.
   Those reports retain their normal ownership/profile visibility, but are not a successful job result.

Job controls are absent without attachment. Reads/cancellation and job result resources are limited
to the effective eligible operation set even if the supplied runner has a broader registry. The
current runner submission contract has no grants context, so privileged job operations are excluded,
not silently run inline. Use a dedicated store directory when results must be isolated between hosts.
With jobs attached, report resources require attribution to an enabled operation/allowed job or
their transitive `OperationResult.artifacts` report descendants. A handle’s `provenance.requestId`
matches its owner’s job id even before the outer result exists (unfinished/failed/cancelled too).
Disallowed ownership/ancestry wins; unattributed spills with missing parents stay hidden.
Input datasets/URI strings are not
ownership edges. Explicit input readers remain usable; profiles are not multi-tenant ACLs.
Only listed operations are wire-supported; callback APIs and unlisted model families remain SDK-only.

## API

`@insiderfinance/totalfinance-mcp` exposes **24** runtime exports (**28** including types) across 1 entrypoint. See the generated [`etc/mcp.api.md`](https://github.com/InsiderFinance/totalfinance/blob/main/packages/mcp/etc/mcp.api.md) for the full surface.

## License

Apache-2.0. Part of the [TotalFinance](https://github.com/InsiderFinance/totalfinance#readme) monorepo. Analytics only — not investment advice.

<!-- Generated by tools/readme-gen.ts from package.json + etc/*.api.md + docs/examples/readme-snippets.test.ts. Do not edit by hand; run `pnpm tsx tools/readme-gen.ts`. -->
