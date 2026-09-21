# Connect an agent

TotalFinance gives an agent financial calculations, not permission to invent market observations or place live orders. The same operation definition drives the SDK runtime, CLI, local HTTP/OpenAPI, and MCP. Begin with a narrow, read-only profile.

## 1. Build the local server

Until a public release is verified on the Versions page, use a source checkout. In the `totalfinance` directory, install with the pinned pnpm version and build:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/mcp/dist/bin.js --help
node packages/mcp/dist/bin.js doctor
```

Node 22.13.0 or newer is required. Help and doctor exit normally. Once protocol mode begins, stdout is reserved for JSON-RPC; application logging belongs on stderr.

## 2. Add the server to your MCP client

Use your client's local/stdio MCP configuration. Replace the two absolute paths below with your checkout and a directory you control. This example exposes portfolio analysis and artifact tools, not the full catalog:

```json
{
  "mcpServers": {
    "totalfinance": {
      "command": "node",
      "args": [
        "/absolute/path/to/totalfinance/packages/mcp/dist/bin.js",
        "--profile",
        "full",
        "--packs",
        "portfolio,artifact",
        "--store",
        "/absolute/path/to/totalfinance-data"
      ]
    }
  }
}
```

Run the same command with `doctor` appended to diagnose the selected packs, effective tool count, budgets, and store configuration. Restart the client connection after changing configuration.

After publication, use the exact versioned package command displayed on the Versions page. Pin that version in shared agent configuration; an unpinned `npx -y` invocation can change behavior on the next launch.

## 3. Choose the smallest useful tool set

The profile table below is generated from the actual registry. `--packs` narrows a profile to exactly the named packs. It does not append implicit defaults. An omitted profile uses the established read-only compute default.

For embedding, `packs` is also exact selection. Select public operation packs and pass them to `createTotalFinanceMcpServer`. Use `--help` for the current executable flags; use the capability resource to discover the server you actually connected to, rather than assuming another installation has the same packs.

## 4. Supply evidence, not guesses

Good instruction: “Use this supplied ledger and these timestamped market observations to explain the P&L between these two dates. Separate deposits from profit and disclose stale or missing observations.”

Bad instruction: “Tell me my current portfolio profit” without a portfolio, prices, currency conventions, or valuation dates. The correct agent response is to request the missing inputs. Compute tools do not fetch quotes, chains, statements, account history, or economic events.

Rates and ordinary implied volatility are decimal fractions: 0.20 means 20%. Time-to-expiry fields ending in `Years` are year fractions. The date-aware option tools also accept `expiry` plus `asOf`; do not supply both the dates and a year fraction. Date-only US-equity expiry resolution is disclosed in assumptions.

## Datasets, artifacts, and handles

Small inputs can be supplied inline. A `totalfinance://` handle is a store-scoped reference, not a URL to arbitrary remote data. Only operation fields declared in `handleFields` accept handles. The attached store must contain the immutable resource with its declared schema, version, provenance, and content identity.

Create/import reusable data through the local SDK or CLI artifact workflow, then pass the resulting handle to an eligible operation. Do not fabricate a handle from a symbol or file name. Missing, incompatible, or unresolved handles must be corrected before computation. A large result may be stored with a bounded preview and a handle instead of returning the entire table through model context.

Reports are available as MCP resources when a store is attached. Keep ledger, market, and scenario identities with any saved conclusion so another run can reproduce it. Stores are local filesystem capabilities, not a hosted multi-tenant workspace or a broker account connection.

## Errors are part of the workflow

- Unknown tools/resources/prompts are protocol errors: refresh discovery and use a real identifier.
- Invalid arguments and computation failures return `isError: true` with machine-readable error JSON in a text block. Success-shaped `structuredContent` is not used for errors.
- Inspect the error code, field/path context, and teaching message. Correct the named problem; do not keep changing unrelated inputs until a call happens to succeed.
- A valid numerical problem may not converge. Check diagnostics and convergence, and never replace an absent answer with an invented value.
- Read assumptions and warnings before presenting a number. A deterministic default seed is injected only for stochastic operations and is echoed in the result.

## Permissions and paper trading

Read-only is the default. Selecting the full catalog does not grant a write capability or prove that a request was approved. Runtime capabilities, policy checks, and trusted authorization/journal stores remain the authority; MCP annotations are descriptive hints, not a security boundary.

The optional paper workflow is proposal → preflight → trusted authorization → paper submission → reconciliation. An inline authorization object or hash is not trusted approval. Idempotent retries use the authoritative local journal, and callers must retain the original request identity.

Paper execution is simulated execution. No live broker adapter is included. Approval for a paper operation is not approval for a future live order. Local file-store guarantees apply to one coherent filesystem host, not distributed account-wide authorization.

The local HTTP interface is a separate transport. A local HTTP API with an OpenAPI document is not automatically a hosted remote MCP server, and a bearer token for local writes is not a complete multi-user identity system.

The [HTTP setup guide](/guides/http/) and [downloadable OpenAPI document](/openapi.json) describe
that local API. This documentation website does not host those endpoints. Use the local server's
own capabilities and OpenAPI response for its actual selected profile and permissions.

## Long-running work

Use the explicitly configured worker-backed job path for large backtests. Retain job identities, read status/result, and cancel work that is no longer useful. Inline deadlines are elapsed-time verdicts unless a worker path is active; a deadline label alone does not imply interruptible computation. The generated server help and capabilities distinguish these modes.

The [MCP transport guide](/guides/mcp/) gives the exact worker flags, typed job submission, status,
result, cancellation, and paging contracts. Read `totalfinance://capabilities` before choosing a path:
only eligible job-class operations use workers. Lifecycle states are not measured progress percentages.
An explicitly attached store/runner may write local reports and job records even when financial
operations remain read-only. Profiles do not grant financial write authority.

## What remains SDK-only?

The operation catalog is a curated task surface, not the complete TypeScript API. The basic `totalfinance.option.price` tool is European Black–Scholes–Merton pricing; American, exotic, and additional pricing-engine families are available through the SDK rather than silently selected by this tool. Fixed-income operations likewise cover less than the full curves/rates/credit package.

Custom callbacks, custom pricers, user-defined expected-return functions, and other executable extensions stay SDK-only. Use their documented APIs in your own trusted program. There is deliberately no MCP tool for executing arbitrary supplied code.

## Assessing agent quality

Deterministic protocol, parity, and trading-environment tests are necessary but do not measure natural-language tool selection. The maintained evaluation corpus records task selection, first-call arguments, recovery, missing-data handling, and authorization behavior separately. Model-dependent scores require real recorded runs; no score is implied by the unit-test count.

Keep operational correctness separate from profitability. A profitable agent that ignores permissions, invents market data, or breaks ledger reconciliation fails operational evaluation.

The source checkout includes 110 maintained cases and an offline scorer. To score a real recording,
run `pnpm agents:score /absolute/path/to/recorded-runs.json` in the TotalFinance directory. Recording schema,
provenance requirements, and reviewer criteria are in `tools/agent-experience/README.md`. The scorer
does not run a model, replay calls, or place trades. Missing executions stay in the denominator.
