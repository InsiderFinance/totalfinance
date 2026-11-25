# @insiderfinance/totalfinance-mcp

> TotalFinance MCP server: exposes the TotalFinance engine to AI agents via the Model Context Protocol. Read-only by default.

The [TotalFinance](https://github.com/InsiderFinance/totalfinance#readme) calculations as tools for AI agents: option pricing and Greeks, strategies, volatility, technical indicators, portfolio P&L, risk, bonds and backtests. The server runs on your machine over stdio and is read-only by default. Your agent supplies the market inputs; every result carries its `assumptions` and `diagnostics`, and any warning (such as a volatility of 22 that was probably meant as 0.22) is repeated in the text the model reads.

## Install

Requires Node 22.13 or later. There is nothing to install globally; check that it runs:

```sh
npx -y @insiderfinance/totalfinance-mcp@0.1.7 doctor
```

## Connect your agent

The [agents page](https://www.totalfinance.io/docs/totalfinance/agents) has the same setups, plus one-click installs where a client supports them.

### Claude Code

Run in your terminal:

```sh
claude mcp add totalfinance -- npx -y @insiderfinance/totalfinance-mcp@0.1.7
```

### Claude Desktop

Add to Settings → Developer → Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "totalfinance": {
      "command": "npx",
      "args": [
        "-y",
        "@insiderfinance/totalfinance-mcp@0.1.7"
      ]
    }
  }
}
```

Restart Claude Desktop to load the server.

### Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "totalfinance": {
      "command": "npx",
      "args": [
        "-y",
        "@insiderfinance/totalfinance-mcp@0.1.7"
      ]
    }
  }
}
```

### VS Code

Add to your workspace root (`.mcp.json`):

```json
{
  "mcpServers": {
    "totalfinance": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@insiderfinance/totalfinance-mcp@0.1.7"
      ],
      "tools": [
        "*"
      ]
    }
  }
}
```

To use it in every workspace, put the same entry in ~/.copilot/mcp-config.json.

### Codex

Run in your terminal:

```sh
codex mcp add totalfinance -- npx -y @insiderfinance/totalfinance-mcp@0.1.7
```

Or add to your Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.totalfinance]
command = "npx"
args = ["-y", "@insiderfinance/totalfinance-mcp@0.1.7"]
```

## Choose the tools

Without options the server lists the **23 default tools**. A profile picks a focused set; profiles never grant permissions:

| Profile | Tools |
| ------- | ----: |
| `default` | 23 |
| `options` | 9 |
| `research` | 4 |
| `strategies` | 11 |
| `portfolio` | 10 |
| `valuation` | 1 |
| `backtesting` | 8 |
| `scenarios` | 3 |
| `full` | 42 |

```sh
npx -y @insiderfinance/totalfinance-mcp@0.1.7 --profile options
npx -y @insiderfinance/totalfinance-mcp@0.1.7 doctor --profile full
```

Some clients limit how many tools they load at once, so prefer a focused profile to `full`. `doctor` reports the Node version check, the tools a configuration exposes and why any are excluded, the attached store and the input budgets. Tool lists and resource lists are paged: follow `nextCursor`.

## Saved reports, background jobs and paper trading

These are off unless you turn them on:

- `--store /absolute/path/to/folder` saves large results as reports the agent can read back as resources. `--store-read-only` only reads an existing folder.
- `--jobs` (with a writable `--store`) runs long calculations such as backtests in a background worker. The agent starts one with `totalfinance_job_submit`, then checks `totalfinance_job_status`, reads `totalfinance_job_result` or stops it with `totalfinance_job_cancel`.
- `--capability <name>` (repeatable) allows write tools. `--capability trade:paper` adds paper-trading tools, which simulate orders locally and never reach a broker. The capabilities you pass replace the defaults (`portfolio:read`, `analytics:run`, `trade:propose`), so list every one you need.

```sh
npx -y @insiderfinance/totalfinance-mcp@0.1.7 --profile backtesting --store /absolute/path/to/folder --jobs
npx -y @insiderfinance/totalfinance-mcp@0.1.7 --profile full --store /absolute/path/to/folder --capability portfolio:read --capability analytics:run --capability trade:propose --capability trade:paper
```

The [MCP guide](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guides/mcp.md) is the full reference: every tool, resource and prompt, the result envelope, errors, budgets and the job lifecycle.

## Use it as a library

Embed the server or its tool definitions in your own host:

```ts
import { defaultTools } from '@insiderfinance/totalfinance-mcp';
const toolNames = defaultTools().map((t) => t.name); // the read-only compute tools
```

_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._

## API

`@insiderfinance/totalfinance-mcp` exposes **24** runtime exports (**28** including types). See the generated [`etc/mcp.api.md`](https://github.com/InsiderFinance/totalfinance/blob/main/packages/mcp/etc/mcp.api.md) for the full surface.

## License

Apache-2.0. Part of the [TotalFinance](https://github.com/InsiderFinance/totalfinance#readme) monorepo. Analytics only — not investment advice.

<!-- Generated by tools/readme-gen.ts from package.json + etc/*.api.md + site/src/agents.ts + docs/examples/readme-snippets.test.ts. Do not edit by hand; run `pnpm tsx tools/readme-gen.ts`. -->
