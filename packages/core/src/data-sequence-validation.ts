/** Sequence laws shared by bounded acquisition, stored windows and the conformance kit. */
import type { DataPage, PriceBarRecord, OptionChainResearchRecord } from './data-types.js';
import { compareKeys, rowKey } from './data-validation.js';
import { invalidView } from './data-view-validation.js';
export function dataSequence() {
  let first: DataPage<PriceBarRecord | OptionChainResearchRecord> | undefined;
  let previous: readonly (string | number)[] | undefined;
  let basis: boolean | undefined,
    basisSeen = false;
  const cursors = new Set<string>(),
    ids = new Set<string>();
  return (page: DataPage<PriceBarRecord | OptionChainResearchRecord>): void => {
    if (first) {
      for (const field of ['kind', 'symbol'] as const)
        if (page[field] !== first[field]) invalidView();
      for (const field of ['provider', 'dataset', 'sourceVersion'] as const)
        if (page.provenance[field] !== first.provenance[field]) invalidView();
      for (const field of [
        'datasetId',
        'datasetVersion',
        'snapshotId',
        'sessionDate',
        'consistency',
        'adjustment',
      ] as const)
        if (page.metadata[field] !== first.metadata[field]) invalidView();
    } else first = page;
    for (const row of page.data) {
      const key = rowKey(page.kind, row);
      if (previous && compareKeys(previous, key) >= 0) invalidView();
      previous = key;
      const id =
        page.kind === 'price-bars'
          ? String(key[0])
          : (row as OptionChainResearchRecord).sourceContractId;
      if (ids.has(id)) invalidView();
      ids.add(id);
      if (page.kind === 'price-bars') {
        const adjusted = (row as PriceBarRecord).bar.adjusted;
        if (basisSeen && adjusted !== basis) invalidView();
        basisSeen = true;
        basis = adjusted;
      }
    }
    if (page.nextCursor !== null) {
      if (cursors.has(page.nextCursor)) invalidView();
      cursors.add(page.nextCursor);
    }
  };
}
