/**
 * `@totalfinance/core/artifacts` — the shared artifact spine (platform Gate B).
 *
 * One grammar for the things every layer above compute wants to SAVE, SHARE, and REPLAY:
 *
 * - {@link createMarketSnapshot} / {@link readMarketSnapshot} — "market state at an instant" as a
 *   versioned, immutable, JSON-safe envelope with explicit conventions and caller-supplied
 *   provenance;
 * - {@link createAnalysisArtifact} / {@link readAnalysisArtifact} — a computed Law-2 result as a
 *   durable record with a content-hash identity, an inputs hash, a `createdFrom` lineage chain,
 *   and {@link TableHandle} references instead of inlined large tables;
 * - {@link createScenarioSet} / {@link readScenarioSet} — named shock/override definitions as pure
 *   data, in the same shock vocabulary `@totalfinance/risk` already prices;
 * - {@link canonicalJsonOf} / {@link contentHash} — the canonical serialization and SHA-256
 *   identity everything above hashes with;
 * - {@link createArtifactMigrationRegistry} — the explicit, never-silent schema-migration policy
 *   every reader shares.
 *
 * This is a SEPARATE entrypoint on purpose, exactly like `@totalfinance/core/schema` (spec §6 hot-path
 * rule): compute entrypoints import `@totalfinance/core` and never this module, so serialization and
 * hashing stay out of pricing bundles. Nothing here fetches, reads the clock, or touches storage —
 * the spine defines CONTAINERS; runners (Gate D) and stores (data plane) come later and consume it.
 *
 * JSON-safe first; Arrow reserved: every envelope here has one canonical JSON form. A lossless
 * Arrow mapping for large tables is a reserved contract on {@link TableHandle} (same content hash
 * over the canonical row projection), to be implemented only when a measured large-table consumer
 * exists — performance work is deliberately deferred in this repo.
 */

// Canonical JSON lives at the core root (a generic serialization utility, shared with the Gate C
// conformance kit — moved out of `artifacts/` 2026-08-23); this barrel keeps re-exporting it so
// the public `@totalfinance/core/artifacts` surface is unchanged by the move.
export {
  CANONICAL_JSON_VERSION,
  canonicalJsonOf,
  fromCanonicalJson,
  isNonFiniteNumber,
} from '../canonical-json.js';
export type { NonFiniteNumber } from '../canonical-json.js';

export {
  CONTENT_HASH_PREFIX,
  contentHash,
  isContentHashString,
  sha256Hex,
} from './content-hash.js';

export { createArtifactMigrationRegistry } from './migration.js';
export type {
  AppliedMigration,
  ArtifactMigration,
  ArtifactMigrationRegistry,
} from './migration.js';

export {
  TABLE_HANDLE_KIND,
  TABLE_MEDIA_TYPE_ARROW_RESERVED,
  createTableHandle,
  isTableHandle,
  tableHandleForRows,
} from './table-handle.js';

// Stage 4.5 — the bounded stored-data scanner (promoted from the scenario runner), the structural
// comparison / replay-parity laws, and the fitted-model summary grammar every calibration adapter
// projects into.
export {
  CANONICAL_DATA_MAX_DEPTH,
  canonicalStringWorkUnits,
  scanCanonicalData,
} from './canonical-scan.js';
export type { CanonicalDataScanOptions } from './canonical-scan.js';
export { COMPARISON_LIMITS, artifactReplayParity, compareAnalysisArtifacts } from './comparison.js';
export { compareCalculationArtifacts } from './calculation-comparison.js';
export type {
  CalculationArtifactComparison,
  CalculationComparisonReason,
  CalculationMetric,
  CalculationMetricComparison,
  CalculationMetricObservation,
  CalculationMetricSelector,
  CalculationMetricUnavailableReason,
  CalculationOperationPolicy,
  CalculationSourceDiagnostics,
  CompareCalculationArtifactsInput,
} from './calculation-comparison.js';
export type {
  ArtifactComparison,
  ArtifactReplayParity,
  ComparisonLimits,
  ComparisonTolerance,
  ValueDifference,
} from './comparison.js';
export { isFittedModelSummary, requireFittedModelSummary } from './fitted-model-summary.js';
export {
  ARTIFACT_WORK_LIMITS,
  applyReportMigrations,
  flattenSummaryParameters,
  requireComparisonTolerance,
  requireWorkLimit,
  residualStatistics,
  verifyReferencedRows,
} from './fitted-model-kit.js';
export type { WorkLimitLaw } from './fitted-model-kit.js';
export type {
  FittedModelObjectiveKind,
  FittedModelResidualSource,
  FittedModelSummary,
} from './fitted-model-summary.js';
export type { TableHandle } from './table-handle.js';

export {
  MARKET_SNAPSHOT_KIND,
  MARKET_SNAPSHOT_SCHEMA_VERSION,
  createMarketSnapshot,
  requireInstantMarketSnapshot,
  isMarketSnapshot,
  marketSnapshotContentHash,
  readMarketSnapshot,
} from './market-snapshot.js';
export type {
  CreateMarketSnapshotInput,
  CreateMarketSnapshotInputConventions,
  MarketSnapshot,
  MarketSnapshotAsOfConvention,
  MarketSnapshotConventions,
  MarketSnapshotObservations,
  OptionChainObservation,
  SpotObservation,
  VolatilitySurfaceObservation,
} from './market-snapshot.js';

export {
  ANALYSIS_ARTIFACT_KIND,
  ANALYSIS_ARTIFACT_SCHEMA_VERSION,
  createAnalysisArtifact,
  isAnalysisArtifact,
  readAnalysisArtifact,
} from './analysis-artifact.js';
export type { AnalysisArtifact, ArtifactInputs, ArtifactProducedBy } from './analysis-artifact.js';

export {
  SCENARIO_SET_KIND,
  SCENARIO_SET_SCHEMA_VERSION,
  createScenarioSet,
  isScenarioSet,
  readScenarioSet,
  scenarioSetContentHash,
} from './scenario-set.js';
export type {
  ScenarioDefinition,
  ScenarioFactor,
  ScenarioOverride,
  ScenarioSet,
  ScenarioShock,
} from './scenario-set.js';
