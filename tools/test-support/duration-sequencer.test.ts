import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileWeight, partitionByDuration } from './duration-sequencer.js';

describe.each([1, 3, 5])('CI shards balanced by duration (%i shards)', (count) => {
  const paths = Array.from(
    { length: 579 },
    (_, i) => `packages/p${i % 20}/test/t${i}.test.ts`,
  ).concat([
    'tools/manifest/contract-conformance.test.ts',
    'tools/packed-consumer.test.ts',
    'tools/transport-parity.test.ts',
  ]);

  it('assigns every file to exactly one shard, the same way every time', () => {
    const shards = partitionByDuration(paths, count);
    expect(shards.flat().sort()).toEqual([...paths].sort());
    expect(new Set(shards.flat()).size).toBe(paths.length);
    expect(partitionByDuration([...paths].reverse(), count)).toEqual(shards);
  });

  it('keeps the slowest shard within the largest single file of the average', () => {
    const shards = partitionByDuration(paths, count);
    const loads = shards.map((shard) => shard.reduce((sum, path) => sum + fileWeight(path), 0));
    const average = loads.reduce((sum, load) => sum + load, 0) / loads.length;
    const largest = Math.max(...paths.map((path) => fileWeight(path)));
    expect(Math.max(...loads) - average).toBeLessThanOrEqual(largest);
  });

  it('names only test files that exist', () => {
    const { files } = JSON.parse(
      readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'),
    ) as { files: Record<string, number> };
    expect(Object.keys(files).length).toBeGreaterThan(0);
    for (const path of Object.keys(files)) {
      expect(existsSync(new URL(`../../${path}`, import.meta.url)), path).toBe(true);
    }
  });
});
