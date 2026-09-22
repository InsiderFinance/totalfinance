/**
 * @insiderfinance/totalfinance/research — point-in-time research primitives (FC3): universe screening over declared
 * fields, cross-sectional style factors, and event studies. Everything here computes over
 * caller-supplied observations; nothing fetches, imputes, or invents data.
 */

// Selective on purpose (2026-08-20 review): `requireBoundaryName`/`requirePathLabel` are the
// package's INTERNAL guard-label plumbing, not vendor-adapter API — they never belonged on the
// public surface. The declared-field contracts and the vendor-adapter guards stay public.
export {
  requireDefinitionsMap,
  requireFieldDefinitions,
  requireMarketEvent,
  requireReturnObservations,
  requireUniverseObservation,
  requireUniverseObservations,
} from './observations.js';
export type {
  FieldDefinition,
  FieldKind,
  MarketEvent,
  ObservedValue,
  ReturnObservation,
  UniverseObservation,
} from './observations.js';
export * from './screening.js';
export * from './factors.js';
export * from './events.js';
