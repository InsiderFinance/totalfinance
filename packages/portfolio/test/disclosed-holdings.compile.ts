/** Compile-only public contracts, also checked against the installed tarball. */
import { compareDisclosedHoldings } from '@totalfinance/portfolio/disclosed-holdings';
import type {
  CompareDisclosedHoldingsInput,
  DisclosedHolding,
  DisclosedHoldingReason,
  DisclosedHoldingChangeReason,
  DisclosedHoldingsSnapshotReason,
  DisclosedHoldingsConcentrationReason,
} from '@totalfinance/portfolio';
import { createAnalysisArtifact } from '@totalfinance/core/artifacts';

declare const input: CompareDisclosedHoldingsInput;
declare const holding: DisclosedHolding;
holding.valueScale = '1';
holding.valueScale = '1000';
// @ts-expect-error value scales are a closed domain, not an arbitrary decimal string
holding.valueScale = '100';
// @ts-expect-error numeric scales must not bypass exact decimal input semantics
holding.valueScale = 1000;

const report = compareDisclosedHoldings(input);
const profile: 'common-stock-shares-v1' = report.assumptions.policy.supportedProfile;
const discretion: 'sole-without-other-managers' = report.assumptions.policy.discretionPolicy;
const precision: number = report.assumptions.policy.ratioDecimalPlaces;
const rowReasons: DisclosedHoldingReason[] = report.current.holdings[0]!.reasons;
const positionReasons: DisclosedHoldingReason[] = report.current.positions[0]!.reasons;
const changeReasons: DisclosedHoldingChangeReason[] = report.changes[0]!.reasons;
const concentrationReasons: DisclosedHoldingsConcentrationReason[] =
  report.current.concentration.reasons;
declare const snapshotReason: DisclosedHoldingsSnapshotReason;
changeReasons.push(`baseline_${snapshotReason}`, `current_${snapshotReason}`, 'currency_mismatch');
concentrationReasons.push(snapshotReason, 'zero_denominator');
// @ts-expect-error caller review text belongs in reviewReasons, not library reason codes
rowReasons.push('arbitrary caller text');
// @ts-expect-error snapshot codes are side-qualified on changes
changeReasons.push('report_incomplete');
// @ts-expect-error zero totals withhold concentration ratios, not justified presence changes
changeReasons.push('baseline_zero_denominator');
// @ts-expect-error a currency mismatch belongs to a pair, not a holding
positionReasons.push('currency_mismatch');
holding.reviewReasons = ['free-form source/provider context'];
createAnalysisArtifact({
  artifactType: 'portfolio.disclosed-holdings',
  producedBy: { operation: 'compareDisclosedHoldings' },
  inputs: { parameters: { profile, discretion, precision } },
  result: report,
});
