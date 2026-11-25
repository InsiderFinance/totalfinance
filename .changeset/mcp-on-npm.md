---
'@insiderfinance/totalfinance': patch
'@insiderfinance/totalfinance-mcp': patch
---

Publish the MCP server on npm. Each release now uploads `@insiderfinance/totalfinance-mcp` after the SDK
it depends on, from the same approved bytes, and checks both from the registry. Run it with
`npx -y @insiderfinance/totalfinance-mcp`; the docs, `llms.txt` and the package README use that command.
