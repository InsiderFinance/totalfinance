import {
  compareDisclosedHoldingPartitions,
  type CompareDisclosedHoldingPartitionsInput,
  type DisclosedHoldingPartitionsPolicy,
  type DisclosedHoldingPartitionChangeReason,
} from '@totalfinance/portfolio/disclosed-holding-partitions';
import type { DisclosedHoldingsPolicy } from '@totalfinance/portfolio/disclosed-holdings';
import { createAnalysisArtifact } from '@totalfinance/core/artifacts';

declare const input: CompareDisclosedHoldingPartitionsInput;
const report = compareDisclosedHoldingPartitions(input);
createAnalysisArtifact({
  artifactType: 'portfolio.disclosed-holding-partitions',
  producedBy: { operation: 'compareDisclosedHoldingPartitions' },
  inputs: { parameters: input },
  result: report,
});
const policy: DisclosedHoldingPartitionsPolicy = {
  supportedProfile: 'common-stock-reported-partitions-v1',
  discretionPolicy: 'reported-partitions-without-cross-manager-netting',
  ratioDecimalPlaces: 12,
};
const reason: DisclosedHoldingPartitionChangeReason = 'report_scoped_reference_basis';
void policy;
void reason;
// @ts-expect-error New profile must not widen the preserved v1 policy.
const oldPolicy: DisclosedHoldingsPolicy = policy;
const badPolicy: DisclosedHoldingPartitionsPolicy = {
  ...policy,
  // @ts-expect-error Explicit supported profile has no legacy alternate literal.
  supportedProfile: 'common-stock-shares-v1',
};
// @ts-expect-error Generated reasons are finite; source text belongs in reviewReasons.
const badReason: DisclosedHoldingPartitionChangeReason = 'random_source_reason';
// @ts-expect-error Scale is exact string, never number.
const badScale: CompareDisclosedHoldingPartitionsInput['baseline']['holdings'][number]['valueScale'] = 1000;
void oldPolicy;
void badPolicy;
void badReason;
void badScale;
