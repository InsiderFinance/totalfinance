/**
 * `@totalfinance/mcp` tools are ADAPTERS over the protocol-neutral operation registry
 * (`@totalfinance/workflows`, Stage 7A): every shipped tool's id, schema, output schema, stochastic
 * predicate, and body live in the registry; this module renders them as MCP tools and keeps the
 * pack functions that select them. `defineTool` remains for a caller's own custom tools.
 */

import {
  analysisOperations,
  artifactPack as artifactOperations,
  backtestPack as backtestOperations,
  calendarPack as calendarOperations,
  cryptoPack as cryptoOperations,
  defaultPacks as defaultOperationPacks,
  fixedIncomePack as fixedIncomeOperations,
  journeyPacks as journeyOperationPacks,
  optionsPack as optionsOperations,
  portfolioPack as portfolioOperations,
  valuationPack as valuationOperations,
  researchPack as researchOperations,
  scenarioPack as scenarioOperations,
  performancePack as performanceOperations,
  riskPack as riskOperations,
  strategyPack as strategyOperations,
  structurePack as structureOperations,
  technicalAnalysisPack as technicalAnalysisOperations,
  volatilityPack as volatilityOperations,
  type OperationPack,
  type TotalFinanceOperation,
} from '@totalfinance/workflows';
import { toolFromOperation, type TotalFinanceTool, type ToolPack } from './tool-kit.js';

export { defineTool, toolFromOperation } from './tool-kit.js';
export type { TotalFinanceTool, ToolPack, ToolResult } from './tool-kit.js';

function toolPack(pack: OperationPack): ToolPack {
  return { name: pack.name, tools: pack.operations.map(toolFromOperation) };
}

export function optionsPack(): ToolPack {
  return toolPack(optionsOperations());
}
export function technicalAnalysisPack(): ToolPack {
  return toolPack(technicalAnalysisOperations());
}
export function strategyPack(): ToolPack {
  return toolPack(strategyOperations());
}
export function volatilityPack(): ToolPack {
  return toolPack(volatilityOperations());
}
export function structurePack(): ToolPack {
  return toolPack(structureOperations());
}
export function riskPack(): ToolPack {
  return toolPack(riskOperations());
}
export function performancePack(): ToolPack {
  return toolPack(performanceOperations());
}
export function calendarPack(): ToolPack {
  return toolPack(calendarOperations());
}
export function cryptoPack(): ToolPack {
  return toolPack(cryptoOperations());
}

// ── the journey packs (opt-in beside the ten domain packs; Stage 7A slice 2) ───────────────────
export function portfolioPack(): ToolPack {
  return toolPack(portfolioOperations());
}

/** The company-valuation journey pack (Stage 4.7 slice 2): `totalfinance.valuation.company`. */
export function valuationPack(): ToolPack {
  return toolPack(valuationOperations());
}
export function scenarioPack(): ToolPack {
  return toolPack(scenarioOperations());
}
export function researchPack(): ToolPack {
  return toolPack(researchOperations());
}
export function artifactPack(): ToolPack {
  return toolPack(artifactOperations());
}
/** The five journey packs as tool packs (the valuation pack joined in Stage 4.7): `createTotalFinanceMcpServer({ packs: [...defaultPacks(), ...journeyPacks()] })`. */
export function journeyPacks(): ToolPack[] {
  return journeyOperationPacks().map(toolPack);
}
export function fixedIncomePack(): ToolPack {
  return toolPack(fixedIncomeOperations());
}
/** The opt-in backtest pack (payload/runtime heavy — deliberately not a default). */
export function backtestPack(): ToolPack {
  return toolPack(backtestOperations());
}
/** The analysis-role tools beyond the compute defaults, as MCP tools. */
export function analysisTools(): TotalFinanceTool[] {
  return analysisOperations().map((operation: TotalFinanceOperation) =>
    toolFromOperation(operation),
  );
}

/** The ten domain packs that make up the default read-only server, in tool-list order. */
export function defaultPacks(): ToolPack[] {
  return defaultOperationPacks().map(toolPack);
}

/** The default read-only tool set — every domain pack flattened (dx §WS-5). */
export function defaultTools(): TotalFinanceTool[] {
  return defaultPacks().flatMap((pack) => pack.tools);
}
