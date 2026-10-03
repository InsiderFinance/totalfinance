# Compare reported holdings

`compareDisclosedHoldings` compares two supplied disclosure snapshots. It reports what changed in
those disclosures; a quantity difference does not prove a purchase or sale. The library does not
retrieve filings, select amendments, resolve security mappings, or manufacture a trading ledger.

```ts
import {
  compareDisclosedHoldings,
  type DisclosedHoldingsSnapshot,
} from '@insiderfinance/totalfinance/portfolio/disclosed-holdings';

const baseline: DisclosedHoldingsSnapshot = {
  managerId: 'manager-1',
  periodEnd: '2026-03-31',
  reportIds: ['report-1'],
  evidenceIds: ['source-1'],
  reportComplete: true,
  mappingComplete: true,
  comparisonEligible: true,
  reviewReasons: [],
  holdings: [
    {
      holdingId: 'holding-1',
      issuerId: 'issuer-A',
      securityId: 'security-A',
      classId: 'class-A',
      mappingStatus: 'mapped',
      instrumentType: 'common_stock',
      quantity: '100',
      quantityUnit: 'SH',
      reportedValue: '25',
      valueCurrency: 'USD',
      valueScale: '1000',
      putCall: 'none',
      investmentDiscretion: 'SOLE',
      otherManagerIds: [],
      evidenceIds: ['row-1'],
      reviewReasons: [],
    },
  ],
};
const current: DisclosedHoldingsSnapshot = {
  ...baseline,
  periodEnd: '2026-06-30',
  reportIds: ['report-2'],
  evidenceIds: ['source-2'],
  holdings: [
    {
      ...baseline.holdings[0]!,
      quantity: '110',
      reportedValue: '28000',
      valueScale: '1',
      evidenceIds: ['row-2'],
    },
  ],
};
const report = compareDisclosedHoldings({
  baseline,
  current,
  comparisonMode: 'reported-period-change',
  policy: {
    supportedProfile: 'common-stock-shares-v1',
    discretionPolicy: 'sole-without-other-managers',
    ratioDecimalPlaces: 12,
  },
});
if (report.changes[0]!.quantityDifference !== '10')
  throw new Error('unexpected quantity difference');
if (report.changes[0]!.valueDifference !== '3000') throw new Error('unexpected value difference');
if (report.current.positions[0]!.weight !== '1') throw new Error('unexpected weight');
if (report.assumptions.policy.ratioDecimalPlaces !== 12)
  throw new Error('unexpected policy precision');
```

All financial amounts are exact decimal strings. The API multiplies reported values by their
explicit source scale (`1` or `1000`) before calculation. It preserves the original values beside
the normalized amounts. Ratios are decimal fractions, rounded once half away from zero at the
requested precision; `0.25` means 25%. Concentration includes the largest position weight and
Herfindahl index, calculated from unrounded values.

Read `report.assumptions.policy` for the exact selected profile, discretion rule and ratio
precision; the adjacent prose explains their meaning. `valueScale` accepts only the string literals
`'1'` and `'1000'` in TypeScript as well as at runtime.

Library-generated `reasons` are typed codes, so editors autocomplete values such as
`'unresolved_identity'`, `'zero_denominator'` or `'baseline_report_incomplete'`. A change's
snapshot-level reasons identify the affected side (`baseline_` / `current_`). Caller-provided
`reviewReasons` remain separate, free-form source explanations. Use the codes for application
logic; do not parse warning messages or assumptions prose.

The denominator is all supplied reported holdings in a complete supported universe. This version
supports mapped common stock with share quantities, no option side, and sole discretion without
other-manager references. Unresolved mappings, unsupported securities, shared discretion and
possible duplicated security/class rows stay visible with review reasons. They prevent a partial
subset from being presented as the complete portfolio. It is neither total manager assets nor
issuer ownership percentage.

`reportComplete`, `mappingComplete` and `comparisonEligible` have separate meanings. Incomplete or
confidential reporting cannot establish that an absent position was sold. New/no-longer disclosed
classifications and deltas require complete comparable evidence. A matched supported row can still
be described as disclosed in both periods while its total difference is withheld. Complete empty
or all-zero reports can establish absence, although their weights remain null because division by
zero is undefined. A zero-quantity reported row remains disclosed.

Use `same-period-revision` with the same report date and different selected report IDs when comparing
revised disclosures. No corporate-action adjustment or amendment ancestry is inferred. Distinct
classes never combine; identity conflicts, changed currency and missing evidence remain explicit.

The report carries assumptions and warnings and can be passed directly to
`createAnalysisArtifact({ artifactType, producedBy, inputs, result: report })`. Put independent
source/system cutoffs, selected receipt hashes and provider lineage in the caller's input envelope.
Root `portfolio.compareDisclosedHoldings`, the portfolio domain import and the dedicated subpath
call the same implementation. No provider credentials or Node process is needed for the pure SDK.
