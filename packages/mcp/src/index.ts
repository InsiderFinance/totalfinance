/**
 * `@totalfinance/mcp` — a Model Context Protocol server exposing the TotalFinance engine to AI agents.
 *
 * Read-only by default. It calls the public TotalFinance compute APIs and never re-implements pricing
 * math (spec §18). Run the bundled `totalfinance-mcp` binary for a stdio server, or embed
 * `createTotalFinanceMcpServer()` in your own transport.
 */

export { createTotalFinanceMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';
export { defaultTools, defineTool, toolFromOperation } from './tools.js';
export { toolNameFor } from './tool-kit.js';
// The domain packs of the default server — enable a subset with
// `createTotalFinanceMcpServer({ packs: [optionsPack(), technicalAnalysisPack()] })` (dx §5.3).
export {
  defaultPacks,
  optionsPack,
  technicalAnalysisPack,
  strategyPack,
  volatilityPack,
  structurePack,
  riskPack,
  performancePack,
  calendarPack,
} from './tools.js';
export { analysisTools, backtestPack, cryptoPack, fixedIncomePack } from './tools.js';
export {
  artifactPack,
  journeyPacks,
  portfolioPack,
  valuationPack,
  researchPack,
  scenarioPack,
} from './tools.js';
export type { TotalFinanceTool, ToolPack, ToolResult } from './tools.js';
