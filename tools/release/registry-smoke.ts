/**
 * `pnpm release:smoke -- --version <v> [--registry <url>] [--tarballs <dir>] [--write-expected] [--receipt <path>]`
 * — the registry smoke (Stage 5A, Decision 9).
 *
 * In a fresh temp directory it installs the whole fixed group at the EXACT version from a registry
 * (or from the dry-run's tarballs, which is how the expectations are written and how the tool is
 * rehearsed without a network), checks every installed package is that version and ships
 * `STABILITY.md`, then runs the packed-consumer journeys as a consumer would — the SDK five-minute
 * journey, the `totalfinance` CLI listing and running an operation, `totalfinance-http --openapi`, the MCP
 * tool list — and compares their canonical outputs to `tools/release/smoke-expected.json`.
 *
 * The expectations are written from the workspace's own tarballs (`--tarballs release
 * --write-expected`) and committed, so the question the smoke answers after a publish is exactly
 * "did the registry hand consumers what we approved?" — never "does the library still work?", which
 * `pnpm run ci` answered before the publish.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readFixedGroup, type ReleaseManifest } from './dry-run.js';
import {
  runSiteExamplesAgainstInstalled,
  type SiteExamplesSmokeResult,
} from '../site-examples-smoke.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED_PATH = join(ROOT, 'tools', 'release', 'smoke-expected.json');

/** What a consumer observes; `version` is reported, everything else is compared. */
export interface SmokeObservation {
  version: string;
  packages: number;
  operations: number;
  priceStructured: string;
  journey: string;
  openapi: { version: string; paths: number };
  mcp: { tools: number; namesSha256: string };
}

export interface SmokeEvidence {
  observation: SmokeObservation;
  siteExamples: SiteExamplesSmokeResult;
}

export interface SmokeSource {
  /** HEAD of the checkout whose examples are being exercised, not an asserted CLI label. */
  sourceCommit: string;
  /** Dirty-checkout receipts are rehearsal evidence, never commit-attested release proof. */
  sourceDirty: boolean;
}

export type SmokeOrigin =
  | { kind: 'tarball-rehearsal'; manifestCommit: string; manifestSha256: string }
  | { kind: 'registry-verification'; registry: string };

/**
 * Separate from the stable SmokeObservation/expected-output contract. The release/site owner
 * must additionally require a clean source, registry-verification origin and matched expectations
 * before using this as release attestation. A local tarball run is never publication evidence.
 */
export interface SmokeReceipt extends SmokeSource {
  schemaVersion: 1;
  version: string;
  verifiedAt: string;
  examplesSha256: string;
  examplesCount: number;
  /** Null is deliberate: tarball rehearsals do not attest to any registry. */
  registry: string | null;
  origin: SmokeOrigin;
  expectations: { matched: boolean; sha256: string };
  observation: SmokeObservation;
  siteExamples: SiteExamplesSmokeResult;
}

/** Capture the actual checkout identity without exposing status filenames or machine paths. */
export function captureSmokeSource(): SmokeSource {
  const sourceCommit = sh('git', ['rev-parse', 'HEAD'], ROOT).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit))
    throw new Error('Cannot identify the smoke source commit.');
  return {
    sourceCommit,
    sourceDirty:
      sh('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], ROOT).trim().length >
      0,
  };
}

export function createSmokeReceipt(input: {
  evidence: SmokeEvidence;
  source: SmokeSource;
  origin: SmokeOrigin;
  expectations: SmokeReceipt['expectations'];
  verifiedAt?: string;
}): SmokeReceipt {
  const { observation, siteExamples } = input.evidence;
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.source.sourceCommit) ||
    typeof input.source.sourceDirty !== 'boolean' ||
    typeof input.expectations.matched !== 'boolean' ||
    !Number.isFinite(Date.parse(verifiedAt)) ||
    !/^[a-f0-9]{64}$/.test(siteExamples.sha256) ||
    !/^[a-f0-9]{64}$/.test(input.expectations.sha256) ||
    observation.version !== siteExamples.version ||
    siteExamples.cases !== siteExamples.caseIds.length ||
    siteExamples.cases === 0 ||
    new Set(siteExamples.caseIds).size !== siteExamples.cases ||
    Object.keys(siteExamples.packages).length === 0 ||
    Object.values(siteExamples.packages).some((version) => version !== observation.version) ||
    siteExamples.typecheck.strict !== true ||
    siteExamples.typecheck.skipLibCheck !== false ||
    siteExamples.typecheck.modes.join(',') !== 'nodenext,bundler'
  ) {
    throw new Error('Inconsistent release smoke evidence; no receipt can be issued.');
  }
  if (input.origin.kind === 'tarball-rehearsal') {
    if (
      input.origin.manifestCommit !== input.source.sourceCommit ||
      !/^[a-f0-9]{64}$/.test(input.origin.manifestSha256)
    ) {
      throw new Error('Tarball manifest does not match the smoke source commit.');
    }
  } else {
    normalizeRegistry(input.origin.registry);
  }
  return {
    schemaVersion: 1,
    version: observation.version,
    ...input.source,
    verifiedAt,
    examplesSha256: siteExamples.sha256,
    examplesCount: siteExamples.cases,
    registry:
      input.origin.kind === 'registry-verification'
        ? normalizeRegistry(input.origin.registry)
        : null,
    origin: input.origin,
    expectations: input.expectations,
    observation,
    siteExamples,
  };
}

/** Retain evidence outside the disposable consumer; neither this writer nor receipts publish anything. */
export function writeSmokeReceipt(path: string, receipt: SmokeReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Reject credential-bearing URLs rather than writing registry secrets into a public receipt. */
function normalizeRegistry(value: string): string {
  const url = new URL(value);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'A smoke registry must be an HTTP(S) URL without credentials, query or fragment.',
    );
  }
  return url.href.replace(/\/$/, '');
}

const PRICE = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
};

const SDK_MJS = `
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { createOperationRegistry, defaultPacks, jsonSafe } from '@totalfinance/workflows';
import { blackScholes } from '@totalfinance/options';
import * as ta from '@totalfinance/technical-analysis';
import { legs, strategy } from '@totalfinance/strategy';
import * as backtest from '@totalfinance/backtest';
const registry = createOperationRegistry({ packs: defaultPacks() });
const result = registry.run({ id: 'totalfinance.option.price', input: ${JSON.stringify(PRICE)} });
// the five-minute journey (docs/examples/five-minute-journey.test.ts), verbatim
const price = blackScholes.call({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22 });
const rsi = ta.rsi.explain([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64], { period: 14 });
const market = { spot: 570, volatility: 0.18, riskFreeRate: 0.045, asOf: '2026-07-06T00:00:00Z', expiry: '2026-08-21' };
const condor = strategy([legs.put({ strike: 540, quantity: 1 }), legs.put({ strike: 550, quantity: -1 }), legs.call({ strike: 590, quantity: -1 }), legs.call({ strike: 600, quantity: 1 })], { premiums: 'model', market });
const pop = condor.probability().probabilityOfProfit;
const bars = Array.from({ length: 30 }, (_, i) => ({ symbol: 'SPY', timestampMs: i * 86_400_000, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i }));
const bt = backtest.vectorized({ data: bars, signal: bars.map((_, i) => i >= 5) });
console.log('OPERATIONS ' + registry.size);
console.log('PRICE_STRUCTURED ' + canonicalJsonOf(jsonSafe(result.structured)));
console.log('JOURNEY ' + canonicalJsonOf({ price, rsiLast: rsi.value.at(-1), pop, finalValue: bt.finalValue }));
`;

const CANON_MJS = `
import { readFileSync } from 'node:fs';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { jsonSafe } from '@totalfinance/workflows';
console.log('CANON ' + canonicalJsonOf(jsonSafe(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
`;

const MCP_MJS = `
import { createTotalFinanceMcpServer, defaultPacks } from '@totalfinance/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const server = createTotalFinanceMcpServer({ packs: defaultPacks() });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'registry-smoke', version: '0' });
await client.connect(clientTransport);
const { tools } = await client.listTools();
console.log('MCP_TOOLS ' + JSON.stringify(tools.map((t) => t.name).sort()));
await client.close();
`;

function sh(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as { stderr?: unknown; stdout?: unknown };
    throw new Error(
      `${cmd} ${args.join(' ')} failed in ${cwd}:\n${String(e.stderr ?? '')}\n${String(e.stdout ?? '')}`,
    );
  }
}

function marker(output: string, name: string): string {
  const line = output.split('\n').find((l) => l.startsWith(`${name} `));
  if (!line) throw new Error(`${name} missing from:\n${output}`);
  return line.slice(name.length + 1);
}

class SmokeFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function fail(message: string, code = 1): never {
  // Throw through main's finally so a failed comparison cleans the consumer too. Exiting here
  // would bypass cleanup, and made the programmatic observe API terminate its caller.
  throw new SmokeFailure(message, code);
}

export function observeWithEvidence(
  consumer: string,
  version: string,
  expectedPackages: string[],
): SmokeEvidence {
  for (const name of expectedPackages) {
    const installed = join(consumer, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
      version: string;
    };
    if (manifest.version !== version)
      fail(`${name} installed at ${manifest.version}, expected ${version}`);
    if (!existsSync(join(installed, 'STABILITY.md')))
      fail(`${name}@${version} does not ship STABILITY.md`);
    if (!existsSync(join(installed, 'LICENSE'))) fail(`${name}@${version} does not ship LICENSE`);
  }
  const work = join(consumer, 'smoke');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'sdk.mjs'), SDK_MJS);
  writeFileSync(join(work, 'canon.mjs'), CANON_MJS);
  writeFileSync(join(work, 'mcp.mjs'), MCP_MJS);
  writeFileSync(join(work, 'price.json'), JSON.stringify(PRICE));
  const sdk = sh('node', [join(work, 'sdk.mjs')], consumer);
  const operations = Number(marker(sdk, 'OPERATIONS'));
  const priceStructured = marker(sdk, 'PRICE_STRUCTURED');
  const journey = marker(sdk, 'JOURNEY');

  const cli = join(consumer, 'node_modules', '@totalfinance', 'cli', 'dist', 'bin.js');
  const store = join(work, 'store');
  const listed = JSON.parse(
    sh('node', [cli, 'operations', 'list', '--store', store], consumer),
  ) as unknown[];
  if (listed.length !== operations)
    fail(`the CLI lists ${listed.length} operations; the SDK registry has ${operations}`);
  const run = JSON.parse(
    sh(
      'node',
      [
        cli,
        'run',
        'totalfinance.option.price',
        '--input',
        join(work, 'price.json'),
        '--store',
        store,
      ],
      consumer,
    ),
  ) as { structured: unknown };
  writeFileSync(join(work, 'cli-structured.json'), JSON.stringify(run.structured));
  const cliStructured = marker(
    sh('node', [join(work, 'canon.mjs'), join(work, 'cli-structured.json')], consumer),
    'CANON',
  );
  if (cliStructured !== priceStructured)
    fail('the CLI result differs from the SDK result for the same input');

  const http = join(consumer, 'node_modules', '@totalfinance', 'http', 'dist', 'bin.js');
  const document = JSON.parse(sh('node', [http, '--openapi', '--profile', 'full'], consumer)) as {
    openapi: string;
    paths: Record<string, unknown>;
  };

  const mcp = sh('node', [join(work, 'mcp.mjs')], consumer);
  const names = JSON.parse(marker(mcp, 'MCP_TOOLS')) as string[];
  // Every public-site copy button is replayed against these exact installed artifacts. This gate
  // runs both in local tarball rehearsals and after a real public-registry publish.
  const siteExamples = runSiteExamplesAgainstInstalled(consumer, version);

  const observation: SmokeObservation = {
    version,
    packages: expectedPackages.length,
    operations,
    priceStructured,
    journey,
    openapi: { version: document.openapi, paths: Object.keys(document.paths).length },
    mcp: {
      tools: names.length,
      namesSha256: createHash('sha256').update(names.join('\n')).digest('hex'),
    },
  };
  return { observation, siteExamples };
}

/** Backwards-compatible observation API; site-example execution is still a mandatory gate. */
export function observe(
  consumer: string,
  version: string,
  expectedPackages: string[],
): SmokeObservation {
  return observeWithEvidence(consumer, version, expectedPackages).observation;
}

function compare(observed: SmokeObservation, expected: SmokeObservation): string[] {
  const differences: string[] = [];
  const check = (label: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      differences.push(`${label}: expected ${JSON.stringify(b)}, observed ${JSON.stringify(a)}`);
  };
  check('packages', observed.packages, expected.packages);
  check('operations', observed.operations, expected.operations);
  check('priceStructured', observed.priceStructured, expected.priceStructured);
  check('journey', observed.journey, expected.journey);
  check('openapi', observed.openapi, expected.openapi);
  check('mcp', observed.mcp, expected.mcp);
  return differences;
}

function main(): void {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values } = parseArgs({
    args,
    options: {
      version: { type: 'string' },
      registry: { type: 'string' },
      tarballs: { type: 'string' },
      'write-expected': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      receipt: { type: 'string' },
    },
    strict: true,
  });
  if (!values.version) fail('--version <v> is required (the exact fixed-group version)', 2);
  if (values.registry && values.tarballs) fail('pass --registry or --tarballs, not both', 2);
  const version = values.version;
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version))
    fail('--version must be an exact semantic version', 2);
  if (values['write-expected'] && !values.tarballs)
    fail('--write-expected requires a local --tarballs rehearsal', 2);
  const source = captureSmokeSource();
  const receiptPath = resolve(ROOT, values.receipt ?? `release/SMOKE_RECEIPT-${version}.json`);
  const group = readFixedGroup()
    .map((p) => p.name)
    .sort();

  const consumer = mkdtempSync(join(tmpdir(), 'totalfinance-registry-smoke-'));
  try {
    const dependencies: Record<string, string> = {};
    let origin: SmokeOrigin;
    if (values.tarballs) {
      const dir = resolve(ROOT, values.tarballs);
      const manifestBytes = readFileSync(join(dir, 'RELEASE_HASHES.json'));
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as ReleaseManifest;
      if (manifest.version !== version)
        fail(`the tarballs are ${manifest.version}, not ${version}`, 2);
      if (manifest.commit !== source.sourceCommit)
        fail('tarball source commit differs from the checkout running these examples', 2);
      if (
        JSON.stringify(manifest.packages.map((artifact) => artifact.package).sort()) !==
        JSON.stringify(group)
      ) {
        fail('tarball manifest must contain the exact fixed package group once each', 2);
      }
      for (const artifact of manifest.packages) {
        if (basename(artifact.tarball) !== artifact.tarball || artifact.version !== version)
          fail('invalid tarball manifest entry', 2);
        const path = join(dir, artifact.tarball);
        const bytes = readFileSync(path);
        if (
          bytes.length !== artifact.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
        ) {
          fail(`tarball hash/length mismatch: ${artifact.package}`, 2);
        }
        dependencies[artifact.package] = `file:${path}`;
      }
      origin = {
        kind: 'tarball-rehearsal',
        manifestCommit: manifest.commit,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      };
    } else {
      for (const name of group) dependencies[name] = version;
      origin = {
        kind: 'registry-verification',
        registry: normalizeRegistry(
          values.registry ?? sh('npm', ['config', 'get', 'registry'], consumer).trim(),
        ),
      };
    }
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify(
        { name: 'totalfinance-registry-smoke', private: true, type: 'module', dependencies },
        null,
        2,
      ),
    );
    const install = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'];
    if (origin.kind === 'registry-verification') {
      // Pin the scoped registry as well: an unrelated user-level @totalfinance:registry must not
      // silently change which registry this receipt claims was checked. Credentials stay in
      // the caller's normal npm configuration; none are copied into the consumer or receipt.
      writeFileSync(
        join(consumer, '.npmrc'),
        `registry=${origin.registry}/\n@totalfinance:registry=${origin.registry}/\n`,
      );
      install.push('--registry', `${origin.registry}/`);
    }
    process.stdout.write(
      `release:smoke: installing ${group.length} packages @ ${version} ${values.registry ? `from ${values.registry}` : values.tarballs ? `from ${values.tarballs}` : 'from the default registry'}\n`,
    );
    sh('npm', install, consumer);

    const evidence = observeWithEvidence(consumer, version, group);
    const observed = evidence.observation;
    let expectations: SmokeReceipt['expectations'];
    if (values['write-expected']) {
      const bytes = `${JSON.stringify(observed, null, 2)}\n`;
      writeFileSync(EXPECTED_PATH, bytes);
      expectations = { matched: false, sha256: createHash('sha256').update(bytes).digest('hex') };
      process.stdout.write(`release:smoke: wrote ${EXPECTED_PATH}\n`);
    } else {
      if (!existsSync(EXPECTED_PATH))
        fail(`${EXPECTED_PATH} is missing; write it with --tarballs release --write-expected`, 2);
      const bytes = readFileSync(EXPECTED_PATH);
      const expected = JSON.parse(bytes.toString('utf8')) as SmokeObservation;
      const differences = compare(observed, expected);
      if (differences.length > 0)
        fail(
          `the installed packages disagree with the committed expectations:\n  ${differences.join('\n  ')}`,
        );
      expectations = { matched: true, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const finalSource = captureSmokeSource();
    if (finalSource.sourceCommit !== source.sourceCommit)
      fail('source HEAD changed during the smoke; rerun from one checkout', 2);
    const receipt = createSmokeReceipt({
      evidence,
      source: { ...source, sourceDirty: source.sourceDirty || finalSource.sourceDirty },
      origin,
      expectations,
    });
    writeSmokeReceipt(receiptPath, receipt);
    process.stdout.write(
      `release:smoke: retained ${receiptPath} (${origin.kind}; sourceDirty=${receipt.sourceDirty}; ${receipt.examplesCount} typechecked site examples; examplesSha256=${receipt.examplesSha256})\n`,
    );
    if (values['write-expected']) return;
    process.stdout.write(
      `release:smoke: ${group.length} packages @ ${version} — ${observed.operations} operations, ${observed.openapi.paths} OpenAPI paths, ${observed.mcp.tools} MCP tools; every journey matches\n`,
    );
  } finally {
    if (!values.keep) rmSync(consumer, { recursive: true, force: true });
    else process.stdout.write(`release:smoke: kept ${consumer}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `release:smoke: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof SmokeFailure ? error.exitCode : 1;
  }
}
