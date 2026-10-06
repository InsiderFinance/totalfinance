import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * CI shards balanced by measured duration, not by file count.
 *
 * Vitest's default `--shard` hashes each file path and cuts the sorted list into equal COUNTS. Our
 * time is concentrated: 34 of 579 files carry 1,323 of 1,559 test-seconds, and one of them
 * (`tools/manifest/contract-conformance.test.ts`) carries 331. Equal counts put 14.2 minutes of test
 * time in one shard and 4.4 in another (hosted run of c4fac6b, Node 22.13.0, 2026-10-06), so the
 * slowest shard set the wall time.
 *
 * This assigns files longest first, each to the shard with the least work so far (the classic
 * longest-processing-time rule). The weights come from `test-durations.json`; a file not listed
 * there counts as the default. A stale weight costs balance, never coverage: every file is assigned
 * to exactly one shard whatever the weights say, and every shard job computes the same assignment
 * from the same file list.
 *
 * Within a shard, the longest files start first, so the one long file is not left until the end.
 * Without `--shard` (every local run) this changes nothing: `sort` falls back to Vitest's own.
 */
interface Durations {
  defaultSeconds: number;
  /** Per-file cost of importing and transforming, paid even by a file with fast tests. */
  collectSeconds: number;
  files: Record<string, number>;
}

const durations = JSON.parse(
  readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'),
) as Durations;

/** The estimated cost of one test file, by its path relative to the repository root. */
export function fileWeight(path: string, table: Durations = durations): number {
  return (table.files[path] ?? table.defaultSeconds) + table.collectSeconds;
}

/**
 * Split `paths` into `count` groups of roughly equal total weight. Deterministic: ties break by
 * path, then by the lower group index.
 */
export function partitionByDuration(
  paths: readonly string[],
  count: number,
  weight: (path: string) => number = fileWeight,
): string[][] {
  const groups = Array.from({ length: count }, () => ({ load: 0, paths: [] as string[] }));
  const ordered = [...paths].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of ordered) {
    let lightest = groups[0]!;
    for (const group of groups) if (group.load < lightest.load) lightest = group;
    lightest.paths.push(path);
    lightest.load += weight(path);
  }
  return groups.map((group) => group.paths);
}

export default class DurationSequencer extends BaseSequencer {
  private pathOf(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).split('\\').join('/');
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const mine = new Set(
      partitionByDuration(
        files.map((spec) => this.pathOf(spec)),
        count,
      )[index - 1],
    );
    return files.filter((spec) => mine.has(this.pathOf(spec)));
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (!this.ctx.config.shard) return super.sort(files);
    return [...files].sort((a, b) => fileWeight(this.pathOf(b)) - fileWeight(this.pathOf(a)));
  }
}
