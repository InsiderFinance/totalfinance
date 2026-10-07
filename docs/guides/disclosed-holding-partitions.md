# Compare reported holding partitions

Use `compareDisclosedHoldingPartitions` to compare common-stock disclosure lines while keeping
their investment-discretion categories and report-local manager references separate. You supply
the selected reports and authenticated mappings; the library calculates reported changes, weights
and concentration. It does not establish trades, ownership or assets under management.

## Compare two complete reports

This hypothetical example has two reporting partitions for one stock: sole (`SOLE`) and other
(`OTR`) discretion. Both reports have already passed the [caller checklist](#caller-checklist).
Amounts and quantities are exact decimal strings; `'0.7'` as a weight means 70%.

```ts
import {
  compareDisclosedHoldingPartitions,
  type CompareDisclosedHoldingPartitionsInput,
  type DisclosedHoldingPartition,
  type DisclosedHoldingPartitionsSnapshot,
} from '@insiderfinance/totalfinance/portfolio/disclosed-holding-partitions';

const row: DisclosedHoldingPartition = {
  holdingId: 'sole',
  issuerId: 'issuer-A',
  securityId: 'security-A',
  classId: 'common-A',
  mappingStatus: 'mapped',
  instrumentType: 'common_stock',
  quantity: '10',
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
    {
      ...row,
      holdingId: 'shared',
      investmentDiscretion: 'OTR',
      quantity: '5',
      reportedValue: '50',
      evidenceIds: ['original-shared-row'],
    },
  ],
};
const current: DisclosedHoldingPartitionsSnapshot = {
  ...baseline,
  periodEnd: '2026-06-30',
  reportIds: ['later'],
  evidenceIds: ['authenticated-later-report'],
  holdings: [
    {
      ...row,
      sourceReportId: 'later',
      quantity: '14',
      reportedValue: '140',
      evidenceIds: ['later-sole-row'],
    },
    {
      ...row,
      holdingId: 'shared',
      investmentDiscretion: 'OTR',
      sourceReportId: 'later',
      quantity: '6',
      reportedValue: '60',
      evidenceIds: ['later-shared-row'],
    },
  ],
};
const input: CompareDisclosedHoldingPartitionsInput = {
  baseline,
  current,
  comparisonMode: 'reported-period-change',
  policy: {
    supportedProfile: 'common-stock-reported-partitions-v1',
    discretionPolicy: 'reported-partitions-without-cross-manager-netting',
    ratioDecimalPlaces: 12,
  },
};
const result = compareDisclosedHoldingPartitions(input);
console.log(result.current.concentration.denominatorReportedValue); // '200'
console.log(result.current.concentration.largestPartitionWeight); // '0.7'
console.log(result.current.concentration.partitionHerfindahlIndex); // '0.58'
console.log(
  result.changes.map((change) => ({
    discretion: change.partitionKey.investmentDiscretion,
    quantityDifference: change.quantityDifference,
    valueDifference: change.valueDifference,
  })),
);
// [
//   { discretion: 'OTR', quantityDifference: '1', valueDifference: '10' },
//   { discretion: 'SOLE', quantityDifference: '4', valueDifference: '40' },
// ]
```

Those are differences in the disclosures, not assertions that the manager bought those shares.
The same function is also available from the portfolio domain and root `portfolio` namespace;
you only need one import. The dedicated subpath above keeps this task easy to locate.

## Caller checklist

The three flags are independent **caller attestations**, not requests for the SDK to fetch or
verify source evidence. Set a flag to `true` only when your upstream process has established it.
Use `false` when unknown and record known issues in snapshot or row `reviewReasons`.

| Flag                 | What you must establish before setting it to `true`                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reportComplete`     | All holdings in the selected reported universe are supplied: no remaining pages, filtering, or known withheld/missing rows. This does **not** mean the disclosure covers all of the manager's economic assets. |
| `mappingComplete`    | Every supplied row has an authenticated issuer/security/class mapping. Retain unresolved rows; never remove them to produce a complete-looking mapped subset.                                                  |
| `comparisonEligible` | Source and report-selection review permits using this snapshot in the requested comparison, including amendment selection and known disclosure limitations. This is separate from having all rows or mappings. |

The SDK validates the consumed fields and detects supported-profile, duplicate and identity
conflicts, but it cannot authenticate your evidence IDs or discover omitted source rows. Setting
all flags to `true` never overrides a row review, unsupported instrument, mixed currencies,
report-local reference ambiguity or changed partition basis.

If any flag is `false`, that snapshot's denominator and weights are unavailable. If either
snapshot fails these gates, comparisons do not infer absence, substitute zero for missing
holdings, or calculate deltas. Supplied facts stay visible with typed reasons. Complete empty or
zero-value reports are different: their total is exactly zero and they can establish absence,
but ratios remain unavailable because their denominator is zero.

## Read the reporting basis and unavailable results

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

## Optional: save the analysis

If you need a reproducible analysis artifact, store the same input and result from the example:

```ts
import { createAnalysisArtifact } from '@insiderfinance/totalfinance/core/artifacts';

const artifact = createAnalysisArtifact({
  artifactType: 'portfolio.disclosed-holding-partitions',
  producedBy: { operation: 'compareDisclosedHoldingPartitions' },
  inputs: { parameters: input },
  result,
});
console.log(artifact.id);
```

Artifact storage is optional; it does not change the calculation or verify source authenticity.
