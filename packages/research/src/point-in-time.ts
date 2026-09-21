/**
 * The ONE point-in-time resolution law (Stage 4.6): the latest available observation per instrument
 * at or before a cutoff, `instrumentId` ascending, with every excluded row's reason reported.
 * Shared by the three screening verbs and by `eligibleObservationsAt`; internal to the package so
 * the simulators and the verbs cannot drift apart on availability or version resolution.
 */

import type { EpochMs } from '@totalfinance/core';
import type { UniverseObservation } from './observations.js';

export type PointInTimeExclusion = 'not-yet-available-at-asOf' | 'superseded-by-later-version';

// ---------------------------------------------------------------------------------------------------

/**
 * The latest available observation per instrument at or before `cutoff`, instrumentId ascending.
 * `addExclusion` receives the reason for every row that did not survive — the same two reasons
 * `screenUniverse`, `rankUniverse`, and `scoreUniverse` report — so eligibility has one
 * implementation and one vocabulary across research and the simulators that call it.
 */
export function resolveLatestAvailableObservations(
  observations: readonly UniverseObservation[],
  cutoff: EpochMs,
  addExclusion: (reason: PointInTimeExclusion) => void,
): UniverseObservation[] {
  const byInstrument = new Map<string, UniverseObservation>();
  for (const observation of observations) {
    if (observation.availableTimestampMs > cutoff) {
      addExclusion('not-yet-available-at-asOf');
      continue;
    }
    const existing = byInstrument.get(observation.instrumentId);
    if (
      existing === undefined ||
      observation.availableTimestampMs > existing.availableTimestampMs
    ) {
      if (existing !== undefined) addExclusion('superseded-by-later-version');
      byInstrument.set(observation.instrumentId, observation);
    } else {
      addExclusion('superseded-by-later-version');
    }
  }
  return [...byInstrument.values()].sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : 1));
}
