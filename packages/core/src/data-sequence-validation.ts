import { equalData, pinOf, sessionInterval } from './data-protocol.js';
import { responseIssue } from './data-response-issue.js';
/** Sequence laws shared by bounded acquisition, stored windows and the conformance kit. */
import type { DataPage, PriceBarRecord, OptionChainResearchRecord } from './data-types.js';
import { compareKeys, rowKey } from './data-validation.js';
import { ErrorCode } from './errors.js';
function sequenceFault(
  path: string,
  reason: 'inconsistent' | 'out_of_order' | 'duplicate_identity' = 'inconsistent',
  rowIndex?: number,
  pageIndex?: number,
): never {
  responseIssue({
    phase: 'sequence',
    path,
    reason,
    validationCode: ErrorCode.DataInvalidResponse,
    ...(rowIndex === undefined ? {} : { rowIndex }),
    ...(pageIndex === undefined ? {} : { pageIndex }),
  });
}
export function dataSequence() {
  let first: DataPage<PriceBarRecord | OptionChainResearchRecord> | undefined;
  let previous: readonly (string | number)[] | undefined;
  let basis: boolean | undefined,
    basisSeen = false;
  const cursors = new Set<string>(),
    ids = new Set<string>();
  let previousSession: string | undefined;
  let pageIndex = -1;
  return (page: DataPage<PriceBarRecord | OptionChainResearchRecord>): void => {
    pageIndex++;
    if (first) {
      if (
        page.contractVersion === 2 &&
        (!equalData(page.binding, first.binding) || !equalData(pinOf(page), pinOf(first)))
      )
        sequenceFault('binding', 'inconsistent', undefined, pageIndex);
      for (const field of ['kind', 'symbol'] as const)
        if (page[field] !== first[field])
          sequenceFault('page.' + field, 'inconsistent', undefined, pageIndex);
      for (const field of ['provider', 'dataset', 'sourceVersion'] as const)
        if (page.provenance[field] !== first.provenance[field])
          sequenceFault('provenance.' + field, 'inconsistent', undefined, pageIndex);
      for (const field of [
        'datasetId',
        'datasetVersion',
        'snapshotId',
        'sessionDate',
        'consistency',
        'adjustment',
      ] as const)
        if (page.metadata[field] !== first.metadata[field])
          sequenceFault('metadata.' + field, 'inconsistent', undefined, pageIndex);
    } else first = page;
    for (let rowIndex = 0; rowIndex < page.data.length; rowIndex++) {
      const row = page.data[rowIndex]!;
      if (
        page.binding?.query.kind === 'price-bars' &&
        sessionInterval(page.binding.query.interval)
      ) {
        const label = (row as PriceBarRecord).sessionDate!;
        if (previousSession !== undefined && label <= previousSession)
          sequenceFault('data[].sessionDate', 'out_of_order', rowIndex, pageIndex);
        previousSession = label;
      }
      const key = rowKey(page.kind, row);
      if (previous && compareKeys(previous, key) >= 0)
        sequenceFault('data.order', 'out_of_order', rowIndex, pageIndex);
      previous = key;
      const id =
        page.kind === 'price-bars'
          ? String(key[0])
          : (row as OptionChainResearchRecord).sourceContractId;
      if (ids.has(id))
        sequenceFault('data[].sourceContractId', 'duplicate_identity', rowIndex, pageIndex);
      ids.add(id);
      if (page.kind === 'price-bars') {
        const adjusted = (row as PriceBarRecord).bar.adjusted;
        if (basisSeen && adjusted !== basis)
          sequenceFault('data[].bar.adjusted', 'inconsistent', rowIndex, pageIndex);
        basisSeen = true;
        basis = adjusted;
      }
    }
    if (page.nextCursor !== null) {
      if (cursors.has(page.nextCursor))
        sequenceFault('nextCursor', 'inconsistent', undefined, pageIndex);
      cursors.add(page.nextCursor);
    }
  };
}
