/**
 * `@insiderfinance/totalfinance/research/artifacts` — Stage 4.5's research-run artifacts over the eleven FC3
 * operations (spec `docs/specs/calibration-research-artifacts.md`, Decisions 1, 4–7, 9): a run is
 * the direct operation's result verbatim plus the input that reproduces it, an optional
 * statistical-hygiene block attached verbatim from `@insiderfinance/totalfinance/risk`, and the versioned factor recipe.
 *
 * A subpath on purpose (never the package root, never the umbrella): these verbs ride the Gate B
 * spine, and a bundle that only screens must not pay for serialization.
 *
 * ```ts
 * import { screenUniverse } from '@insiderfinance/totalfinance/research';
 * import { researchRunArtifact, readResearchRun, replayResearchRun } from '@insiderfinance/totalfinance/research/artifacts';
 *
 * const run = screenUniverse(input);
 * const artifact = researchRunArtifact({ kind: 'screen', run, input, referenceRowSets: ['observations'] });
 * const { report } = readResearchRun({ artifact });
 * replayResearchRun({ artifact, referencedData: { observations: input.observations } });
 * ```
 */

export {
  RESEARCH_RUN_ARTIFACT_TYPE,
  RESEARCH_RUN_LIMITS,
  compareResearchRuns,
  readResearchRun,
  replayResearchRun,
  researchRunArtifact,
} from './research-run-artifacts.js';
export type {
  AbnormalReturnDelta,
  CountDelta,
  HygieneVerdictSection,
  IdListSection,
  KeyedDelta,
  MembershipSection,
  NamedDelta,
  PortfolioMembership,
  RankMove,
  RankMovesSection,
  ReadResearchRunResult,
  Referenced,
  ResearchRunArtifactInput,
  ResearchRunArtifactLimits,
  ResearchRunComparison,
  ResearchRunReplay,
  ResearchRunReport,
  ScoreDeltasSection,
  ValueDelta,
} from './research-run-artifacts.js';
export { RESEARCH_RUN_KINDS } from './research-run-kinds.js';
export type {
  InputOf,
  ResearchRunCostClass,
  ResearchRunInputs,
  ResearchRunKind,
  ResearchRunKindDescriptor,
  ResearchRunResults,
  RunOf,
} from './research-run-kinds.js';
export type {
  HygieneBacktestOverfitting,
  HygieneDeflatedSharpe,
  HygieneLeakageReport,
  HygieneMultipleTest,
  HygieneParameterSweep,
  HygieneResearchVerdict,
  ResearchHygieneBlock,
} from './research-hygiene.js';
