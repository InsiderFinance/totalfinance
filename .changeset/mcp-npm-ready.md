---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Prepare the optional MCP server for npm. A successful tool call's text block now repeats the result's
diagnostics warnings after the summary (at most five), so a host that shows the model only text still
sees cautions such as `volatility=22 implies 2200%`; `structuredContent` is unchanged. The MCP package
requires `@modelcontextprotocol/sdk` ^1.29.0, carries its MCP Registry name (`mcpName`), and its README
covers installation and per-client setup. VS Code setup uses the portable `mcpServers` format in
`.mcp.json`.
