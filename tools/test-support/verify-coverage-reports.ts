import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest merges whatever blobs it receives; it does not know how many CI shards were expected.
 * Require the exact report set before invoking it, so missing evidence cannot produce a green
 * partial coverage result. Vitest remains responsible for parsing the blobs and enforcing coverage.
 */
export function verifyCoverageReports({
  directory,
  shardCount,
}: {
  directory: string;
  shardCount: number;
}): void {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error('Coverage shard count must be a positive safe integer.');
  }
  const expected = new Set(
    Array.from({ length: shardCount }, (_, index) => `blob-${index + 1}-${shardCount}.json`),
  );
  const entries = readdirSync(directory, { withFileTypes: true });
  const actual = new Set(entries.map((entry) => entry.name));
  const missing = [...expected].filter((name) => !actual.has(name));
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length || unexpected.length) {
    throw new Error(
      `Incomplete coverage reports in ${directory}: missing [${missing.join(', ')}]; ` +
        `unexpected [${unexpected.join(', ')}]. Expected all ${shardCount} shard reports.`,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile() || statSync(resolve(directory, entry.name)).size === 0) {
      throw new Error(`Coverage report ${entry.name} must be a nonempty regular file.`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, count, ...extra] = process.argv.slice(2);
    if (!directory || !count || extra.length) {
      throw new Error('Usage: verify-coverage-reports.ts <directory> <shard-count>');
    }
    verifyCoverageReports({ directory, shardCount: Number(count) });
    process.stdout.write(`Verified all ${count} coverage shard reports.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
