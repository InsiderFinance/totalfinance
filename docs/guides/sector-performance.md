# Calculate sector performance

Use `sectorPerformance` when you already have comparable returns for each security. Use
`sectorPerformanceSnapshot` when you need to select historical closes and classifications under
explicit information cutoffs. Both are pure calculations: no API keys, network, cache or clock.

## Start with same-period returns

```ts
import { sectorPerformance } from '@totalfinance/performance/sector-performance';

const report = sectorPerformance({
  members: [
    {
      securityId: 'security-a',
      sectorId: 'technology',
      sectorName: 'Technology',
      periodReturn: 0.04,
    },
    {
      securityId: 'security-b',
      sectorId: 'technology',
      sectorName: 'Technology',
      periodReturn: -0.02,
    },
    { securityId: 'security-c', sectorId: 'energy', sectorName: 'Energy', periodReturn: 0.005 },
  ],
});
if (report.sectors[0]?.periodReturn !== 0.01)
  throw new Error('Technology should return +1%, equally weighting both securities.');
```

Returns are decimals: `0.01` means +1%. All rows must cover the **same period and comparable return
basis**, which the caller owns. The calculator cannot infer whether your inputs are daily, monthly,
price-only, total-return or currency-converted. Security IDs are stable identities, not ticker
aliases. Duplicate security IDs and inconsistent names for one sector ID are errors.

The report orders sectors by descending return, with stable identity tie-breaking and competition
ranks (`1, 1, 3`). It rounds the sector mean once to eight decimal-return places. Members retain
their original unrounded returns. Empty input produces an explicitly empty report with a warning,
not a successful zero return. No classification, price or provider lineage is fabricated.

## Audit a completed-session snapshot

The following hypothetical data demonstrates the required provenance. Supply real observations,
session-completion records and effective-dated classifications in production. A completed-session
table is input data, not a built-in exchange calendar.

```ts
import { sectorPerformanceSnapshot } from '@totalfinance/performance/sector-performance';

const cutoff = Date.parse('2026-08-25T22:00:00Z');
const previousCloseTime = Date.parse('2026-08-24T20:00:00Z');
const targetCloseTime = Date.parse('2026-08-25T20:00:00Z');
const snapshot = sectorPerformanceSnapshot({
  targetSessionDate: '2026-08-25',
  marketCalendarId: 'XNYS',
  classificationTaxonomy: { taxonomyId: 'example-sectors', taxonomyVersion: '2026' },
  cutoffs: {
    sourceCutoffTimestampMs: cutoff,
    knowledgeCutoffTimestampMs: cutoff,
    sessionCompletedCutoffTimestampMs: cutoff,
  },
  eligibleUniverse: [
    {
      universeMembershipId: 'membership-a',
      securityId: 'security-a',
      listingId: 'listing-a',
    },
  ],
  completedSessions: [
    { sessionId: 'previous', sessionDate: '2026-08-24', completedAtTimestampMs: previousCloseTime },
    { sessionId: 'target', sessionDate: '2026-08-25', completedAtTimestampMs: targetCloseTime },
  ],
  classifications: [
    {
      classificationObservationId: 'classification-a',
      securityId: 'security-a',
      taxonomyId: 'example-sectors',
      taxonomyVersion: '2026',
      effectiveFromSessionDate: '2026-01-01',
      effectiveToSessionDate: null,
      sectorId: 'technology',
      sectorName: 'Technology',
      sourceId: 'example-classifications',
      sourceTimestampMs: previousCloseTime,
      knownAtTimestampMs: previousCloseTime,
    },
  ],
  splitAdjustedCloses: [
    { sessionId: 'previous', price: 100, timestampMs: previousCloseTime },
    { sessionId: 'target', price: 110, timestampMs: targetCloseTime },
  ].map(({ sessionId, price, timestampMs }) => ({
    closeObservationId: `close-a-${sessionId}`,
    securityId: 'security-a',
    listingId: 'listing-a',
    sessionId,
    splitAdjustedClose: price,
    currency: 'USD',
    adjustmentVersion: 'example-adjustment-1',
    quality: 'final' as const,
    sourceId: 'example-closes',
    sourceTimestampMs: timestampMs,
    knownAtTimestampMs: timestampMs,
  })),
});
if (snapshot.diagnostics.status !== 'complete' || snapshot.sectors[0]?.dailyReturn !== 0.1)
  throw new Error('The fully covered hypothetical sector should return +10%.');
```

The snapshot path uses equal-security **split-adjusted price returns**, not dividend-reinvested
total returns, market-cap weighting, FX conversion or intraday estimates. It selects observations
available by both source and knowledge cutoffs. Effective classification intervals include their
start date and exclude their end date. The previous session is the latest supplied completed
session before the target, not “the prior calendar day.”

Read `diagnostics.status`, `diagnostics.warnings`, `diagnostics.blockers` and `exclusions` before
using the headline values. Missing, late, stale, unclassified, currency-mismatched and
adjustment-version-mismatched inputs are disclosed rather than silently filled. Selected member
lineage retains the exact classification and both closes. A partial sector result is calculated
from the included members, not from an implied fully covered universe.

## Contract and integration boundaries

Both functions accept named request objects and return assumptions plus `diagnostics.warnings`.
Their reports can be saved directly with `createAnalysisArtifact` from `@totalfinance/core/artifacts`.
The neutral `sector-performance-v1` calculation policy is stamped in results; callers do not pass
a magic vendor policy string. This is a calculation-policy revision, not a second package version.

Request/control objects reject unknown keys. Observation rows accept extra metadata but only
consumed fields are copied into results. Arrays must be dense. The simple path accepts at most
1,000,000 member rows; the snapshot path caps the combined rows across its four input arrays at
1,000,000 before walking them. Malformed requests throw typed TotalFinance errors with field paths.

The caller remains responsible for universe eligibility, security/listing identity, classification
and calendar accuracy, provider acquisition and licensing, caching, endpoint field projection and
production rollout. These exports do not replace an application endpoint or claim equality with a
vendor's undocumented universe and methodology. They are SDK exports, not additional MCP tools.
