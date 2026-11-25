# MCP client verification, 2026-11-25

Real-client checks of `@insiderfinance/totalfinance-mcp` 0.1.7 before its first npm publication. The
server was built from the `totalfinance/mcp-npm-ready` working tree on main `c6a62d6`
(`pnpm build`, Node 22.23.2, macOS arm64), including this change's text-block warnings. Nothing was
added to any user-level client configuration: each run passed the server for that run only.

## Ran

| Client                          | How it was run                                                                                                   | Result                                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.332             | `claude -p --strict-mcp-config --mcp-config <file>` with `node distribution/mcp/dist/bin.js`, tools allow-listed | Connected; 23 tools listed (loaded on demand through tool search). Called `totalfinance_option_price` and `totalfinance_technical_analysis_calculate`: call price 5.039787 (spot 100, strike 105, 0.5 years, volatility 0.22, rate 0.045) and RSI(14) last value 57.91502067008556. |
| Claude Code 2.1.332, second run | Same, told to pass `volatility: 22` unchanged                                                                    | The tool returned `call price = 100.000000` with the `input.suspicious_volatility` warning. Claude Code gives the model the `structuredContent` JSON, so the warning reached it through `diagnostics.warnings`.                                                                     |
| Codex CLI 0.171.0               | `codex exec -s read-only --json -c mcp_servers.totalfinance.command=… -c mcp_servers.totalfinance.args=[…]`      | Connected; called both tools. The text block carried `Warning (input.suspicious_volatility): volatility=22 implies 2200% …`, and Codex quoted it. RSI(14) last value 57.91502067008556.                                                                                             |

In the first Claude Code run the model converted `volatility 22` to 0.22 by itself before calling
the tool, so that run shows no warning. The `codex mcp add` and `claude mcp add` commands in the
setups were not run, because they write user configuration; the configuration they write is the
one each run passed directly.

## Configuration checked against current documentation, not run

| Client         | Setup                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Desktop | `mcpServers` entry in `claude_desktop_config.json`, then restart          | Standard stdio entry (`command`, `args`).                                                                                                                                                                                                                                                                                                                         |
| Cursor         | `mcpServers` entry in `~/.cursor/mcp.json`                                | Community reports describe a limit of about 40 MCP tools across all servers, and 60 characters for server name plus tool name. The `full` profile lists 42 tools, so the setup recommends a focused profile. The longest pair here, `totalfinance` plus `totalfinance_volatility_probability_in_the_money`, is exactly 60 characters: at that limit, not over it. |
| VS Code        | `mcpServers` entry with `type: "stdio"` and `tools: ["*"]` in `.mcp.json` | VS Code's MCP configuration reference now marks `.vscode/mcp.json` (`servers`) and `code --add-mcp` as the deprecated editor-managed format. The generated setup moved to the portable format.                                                                                                                                                                    |

Sources: [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[Cursor forum: tools limited to 40 total](https://forum.cursor.com/t/tools-limited-to-40-total/67976).

## Not verified

Claude Desktop, Cursor and VS Code were not run. ChatGPT needs a remote HTTP server, which this
package does not provide. No run used a published npm package: `npx` setups are verified only as
generated text until the first publication.
