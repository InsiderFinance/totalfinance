/** Installed-artifact measurements for the public report; never aliases workspace sources. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packGroup } from '../release/dry-run.js';
import { publicPackageDirectories } from '../public-packages.js';
import { CONSUMER_FIXTURES, type ConsumerFixture } from './consumer-fixtures.js';
import { measureConsumer, type ConsumerMeasurement } from './consumer-measure.js';
import {
  assertPublicPackageDependencies,
  type PublicDependencyMetadata,
} from './public-artifacts.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Representative rows only; every portable spelling is separately enforced in packed CI. */
export function reportedConsumerFixtures(): readonly ConsumerFixture[] {
  return CONSUMER_FIXTURES.filter(
    (fixture) =>
      fixture.style === 'feature' || fixture.style === 'root-hoist' || fixture.rootNamespace,
  );
}

export interface ConsumerReportRow {
  fixture: ConsumerFixture;
  esbuild: ConsumerMeasurement;
  rollup: ConsumerMeasurement;
}

/** Called after pnpm build; the temporary installation is always removed, including on failure. */
export async function measurePackedReport(): Promise<ConsumerReportRow[]> {
  const work = mkdtempSync(join(tmpdir(), 'totalfinance-bundle-report-'));
  try {
    const tarballs = join(work, 'tarballs');
    const consumer = join(work, 'consumer');
    mkdirSync(consumer);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    // This is measurement, not a release receipt: the caller may deliberately be editing sources.
    const packed = packGroup(tarballs, commit);
    assert.deepEqual(
      packed.packages.map((artifact) => artifact.package),
      publicPackageDirectories(ROOT).map((artifact) => artifact.name),
      'Bundle evidence must install exactly main then MCP from distribution',
    );
    for (const artifact of packed.packages) {
      const manifest = JSON.parse(
        execFileSync('tar', ['-xOf', join(tarballs, artifact.tarball), 'package/package.json'], {
          encoding: 'utf8',
        }),
      ) as PublicDependencyMetadata;
      assertPublicPackageDependencies(manifest, artifact.package, packed.version);
    }
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'totalfinance-bundle-report',
        private: true,
        type: 'module',
        dependencies: Object.fromEntries(
          packed.packages.map((artifact) => [
            artifact.package,
            `file:${join(tarballs, artifact.tarball)}`,
          ]),
        ),
      }),
    );
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      {
        cwd: consumer,
        stdio: 'pipe',
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const rows: ConsumerReportRow[] = [];
    for (const fixture of reportedConsumerFixtures()) {
      rows.push({
        fixture,
        esbuild: await measureConsumer(consumer, fixture, 'esbuild'),
        rollup: await measureConsumer(consumer, fixture, 'rollup'),
      });
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function renderConsumerReport(rows: readonly ConsumerReportRow[]): string {
  const label = (measurement: ConsumerMeasurement, budget: number): string =>
    `${(measurement.bytesGzip / 1024).toFixed(1)} KiB / < ${budget} KiB`;
  return [
    '| Used-function fixture | Public import | esbuild gzip / budget | Rollup gzip / budget |',
    '| --- | --- | ---: | ---: |',
    ...rows.map(
      ({ fixture, esbuild, rollup }) =>
        `| \`${fixture.id}\` | \`${fixture.specifier}\` | ${label(esbuild, fixture.budgetKiB.esbuild)} | ${label(rollup, fixture.budgetKiB.rollup)} |`,
    ),
  ].join('\n');
}
