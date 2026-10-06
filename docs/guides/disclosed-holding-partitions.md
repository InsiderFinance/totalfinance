# Compare reported holding partitions

Use `compareDisclosedHoldingPartitions` for caller-supplied, authenticated common-stock reporting
lines separated by discretion or report-local manager references. Supply an explicit complete
universe and policy. This is a reported disclosure calculation; it does not establish ownership,
trades, assets under management or security-level concentration.

```ts
import { portfolio } from '@insiderfinance/totalfinance';
import { compareDisclosedHoldingPartitions as domain } from '@insiderfinance/totalfinance/portfolio';
import {
  compareDisclosedHoldingPartitions,
  type DisclosedHoldingPartition,
  type DisclosedHoldingPartitionsSnapshot,
} from '@insiderfinance/totalfinance/portfolio/disclosed-holding-partitions';
import {
  canonicalJsonOf,
  createAnalysisArtifact,
} from '@insiderfinance/totalfinance/core/artifacts';

const row: DisclosedHoldingPartition = {
  holdingId: 'sole',
  issuerId: 'issuer-A',
  securityId: 'security-A',
  classId: 'common-A',
  mappingStatus: 'mapped',
  instrumentType: 'common_stock',
  quantity: '9007199254740993',
  quantityUnit: 'SH',
  reportedValue: '100',
  valueCurrency: 'USD',
  valueScale: '1',
  putCall: 'none',
  investmentDiscretion: 'SOLE',
  sourceReportId: 'original',
  otherManagerReferences: [],
  evidenceIds: ['mapped-source-row'],
  reviewReasons: [],
};
const baseline: DisclosedHoldingPartitionsSnapshot = {
  managerId: 'manager-A',
  periodEnd: '2026-03-31',
  reportIds: ['original'],
  evidenceIds: ['authenticated-report'],
  reportComplete: true,
  mappingComplete: true,
  comparisonEligible: true,
  reviewReasons: [],
  holdings: [
    row,
    { ...row, holdingId: 'shared', investmentDiscretion: 'OTR', reportedValue: '50' },
  ],
};
const current: DisclosedHoldingPartitionsSnapshot = {
  ...baseline,
  periodEnd: '2026-06-30',
  reportIds: ['later'],
  holdings: baseline.holdings.map((holding) => ({
    ...holding,
    sourceReportId: 'later',
    quantity: '9007199254740995',
  })),
};
const input = {
  baseline,
  current,
  comparisonMode: 'reported-period-change' as const,
  policy: {
    supportedProfile: 'common-stock-reported-partitions-v1' as const,
    discretionPolicy: 'reported-partitions-without-cross-manager-netting' as const,
    ratioDecimalPlaces: 12,
  },
};
const result = compareDisclosedHoldingPartitions(input);
if (result.changes.some((change) => change.quantityDifference !== '2'))
  throw new Error('exact quantity');
if (result.baseline.concentration.denominatorReportedValue !== '150')
  throw new Error('all-row denominator');
if (result.baseline.concentration.partitionHerfindahlIndex !== '0.555555555556')
  throw new Error('partition concentration');
if (
  canonicalJsonOf(domain(input)) !== canonicalJsonOf(result) ||
  canonicalJsonOf(portfolio.compareDisclosedHoldingPartitions(input)) !== canonicalJsonOf(result)
)
  throw new Error('import parity');
const artifact = createAnalysisArtifact({
  artifactType: 'portfolio.disclosed-holding-partitions',
  producedBy: { operation: 'compareDisclosedHoldingPartitions' },
  inputs: { parameters: input },
  result,
});
console.log(artifact.id, result.baseline.partitions);
```

`SOLE`, `DFND` and `OTR` are supported discretion labels. The library consumes exact opaque
`otherManagerReferences`; the SEC consumer checks positive sequence grammar and membership in the
specific source report's included-manager evidence. References are never global manager identities.
A reference-bearing key includes its sourceReportId. A no-reference key omits it, so repeated lines
from separately selected amendments still receive duplicate review instead of being summed.

`partitionWeight`, `largestPartitionWeight` and `partitionHerfindahlIndex` describe reported lines
in the full supplied universe. All rows must be supported, review-free and in one currency, and
all three independent gates must pass. A missing mapping or reviewed row withholds the denominator;
there is no mapped-subset fallback. Empty and zero-value universes have exact total zero and null
ratios. Rounding happens once, half away from zero, at the explicit 0–18 places; amounts and signed
differences stay exact base-ten strings. Herfindahl uses unrounded operands.

References or changed no-reference discretion sets on either side withhold the entire security/class
group, including an otherwise matched SOLE row. These facts appear in side-specific
`uncomparedPartitions` with unknown classification and explicit reasons. Every keyed partition is
accounted for exactly once per present side through a change or an uncompared record; unkeyed rows
remain visible among holding outcomes. Already-reviewed duplicated reference tokens are retained
only as unkeyed outcomes and cannot supply a partition or denominator; unreviewed duplicates refuse.

Use `same-period-revision` only for the same report date with distinct selected report sets.
New/removed classifications describe source presence, and require complete supported evidence on
both sides. No quantity difference is a purchase/sale assertion. Broader instruments, aggregation,
manager overlap and ownership percentages need separate methodology. The existing
[`compareDisclosedHoldings`](./disclosed-holdings.md) API retains its v1 policy and output.
