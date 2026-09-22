/**
 * Exhaustive installed TA metadata gate. Call assertInstalledIndicatorMetadata(consumer) from the
 * packed-consumer suite after its shared install. No source aliases, shared module cache, registry
 * import in a browser bundle, additional installation, or change to the size canaries.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runInContext } from 'node:vm';
import { consumerBrowser, measureConsumer } from './consumer-measure.js';

interface Probe {
  label: string;
  method: 'call' | 'explain' | 'stream';
  inputs: 'series' | 'bars' | 'pair';
  parameters?: Record<string, unknown>;
  undefinedKeys?: string[];
  wrongKind?: boolean;
}

interface CatalogRow {
  name: string;
  identity: number;
  probes: Probe[];
  expected: unknown[];
}

interface Leaf {
  specifier: string;
  bindings: { path: string[]; names: string[]; identity: number }[];
}

interface Baseline {
  catalog: CatalogRow[];
  leaves: Leaf[];
  dependentDefaults: string[];
  nullableDefaults: string[];
}

export interface IndicatorMetadataCoverage {
  names: number;
  identities: number;
  leafEntrypoints: number;
  comparisons: number;
  dependentDefaults: string[];
  nullableDefaults: string[];
}

// The exact same probe runs as ordinary JS in the registry-loaded child and each fresh browser
// realm. Tagged values distinguish numeric NaN/Infinity/-0/undefined from strings and null. Do not
// pass registry defaults/conventions to this function: that would repair the leaf under test.
const PROBE_RUNTIME = String.raw`
function encode(value) {
  if (value === null) return ['null'];
  if (typeof value === 'number') return ['number',
    Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' :
    Number.isFinite(value) ? value : String(value)];
  if (typeof value === 'undefined') return ['undefined'];
  if (Array.isArray(value)) return ['array', value.map(encode)];
  if (typeof value === 'object') return ['object', Object.keys(value).sort().map(key => [key, encode(value[key])])];
  return [typeof value, value];
}
function probeInputs() {
  const series = Array.from({ length: 64 }, (_, i) =>
    100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1));
  const bars = series.map((close, i) => {
    const open = i === 0 ? close : series[i - 1];
    return { open, high: Math.max(open, close) + 1 + (i % 3) * 0.5,
      low: Math.min(open, close) - 1 - (i % 4) * 0.3,
      close, volume: 1000 + ((i * 53) % 400) };
  });
  return { series, bars, pair: series.map((x, i) => ({ x, y: x + Math.cos(i / 4) * 3 })) };
}
function runProbe(indicator, probe) {
  const data = probeInputs();
  const input = data[probe.wrongKind ? (probe.inputs === 'series' ? 'bars' : 'series') : probe.inputs];
  const parameters = probe.parameters === undefined ? undefined : JSON.parse(JSON.stringify(probe.parameters));
  for (const key of probe.undefinedKeys ?? []) parameters[key] = undefined;
  try {
    const value = probe.method === 'stream' ? indicator.stream(parameters).toJSON() :
      probe.method === 'explain' ? indicator.explain(input, parameters) : indicator(input, parameters);
    return { ok: true, value: encode(value) };
  } catch (error) {
    // Class names are minified; compare actual class identity, code, teaching message and context.
    return { ok: false, error: {
      nativeError: error instanceof Error,
      inputError: error instanceof InputError,
      quantError: error instanceof QuantError,
      code: error?.code, message: error?.message, context: encode(error?.context),
    } };
  }
}
`;

// Discovery and expected results exist ONLY in an isolated test-host process. Public imports are
// resolved from the installed consumer, including warmup's canonical REQUIRED input choices. The
// warmup helpers/registry are never emitted into the leaf entry source, nor shared with its realm.
const DISCOVER_BASELINE = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, QuantError } from '@insiderfinance/totalfinance/core';
import { listIndicators } from '@insiderfinance/totalfinance/technical-analysis/registry';
import { indicatorWarmups } from '@insiderfinance/totalfinance/technical-analysis/warmup';
${PROBE_RUNTIME}
const modules = realpathSync('node_modules') + sep;
function installedPath(specifier) {
  const path = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
  assert.ok(path.startsWith(modules), 'Host discovery escaped installed node_modules: ' + path);
  const id = relative(modules, path).split(sep).join('/');
  assert.match(id, /^@insiderfinance\/totalfinance\/(?:modules\/[^/]+\/dist\/.+\.js|package\.json)$/);
  return path;
}
for (const specifier of ['@insiderfinance/totalfinance/core', '@insiderfinance/totalfinance/technical-analysis/registry',
  '@insiderfinance/totalfinance/technical-analysis/warmup']) installedPath(specifier);
const manifest = JSON.parse(readFileSync(installedPath('@insiderfinance/totalfinance/package.json'), 'utf8'));
const registered = listIndicators();
const entries = [...registered].sort((a, b) => a.name.localeCompare(b.name));
const effectiveConventions = new Map();
for (const entry of registered)
  if (entry.conventions !== undefined) effectiveConventions.set(entry.indicator, entry.conventions);
assert.equal(entries.length, 335, 'Update the explicit catalog census for an intentional API change');
const identities = [...new Set(entries.map(entry => entry.indicator))];
assert.equal(identities.length, 321, 'An alias identity disappeared or changed');
const canonical = new Map(indicatorWarmups(280).map(row => [row.name, row.parameters]));
const data = probeInputs();
const dependentDefaults = [], nullableDefaults = [];
function resolvedParameters(defaults, supplied) {
  const resolved = {};
  for (const [key, value] of Object.entries(defaults))
    if (typeof value !== 'function') resolved[key] = structuredClone(value);
  Object.assign(resolved, supplied);
  for (const [key, value] of Object.entries(defaults))
    if (resolved[key] === undefined && typeof value === 'function') resolved[key] = value(resolved);
  return resolved;
}
const catalog = entries.map(entry => {
  const defaults = entry.defaults ?? {};
  const required = entry.parameters.filter(key => !(key in defaults));
  const minimal = Object.fromEntries(required.map(key => {
    assert.notEqual(canonical.get(entry.name)?.[key], undefined, entry.name + ': missing canonical ' + key);
    return [key, canonical.get(entry.name)[key]];
  }));
  function assertDisclosure(parameters) {
    const explained = entry.indicator.explain(data[entry.inputs], parameters);
    assert.deepEqual(explained.assumptions.parameters, resolvedParameters(defaults, parameters),
      entry.name + ': registry baseline disagrees with its declared defaults');
    // True aliases share one callable. The last declared convention in registration order owns
    // its historical disclosure, even when an alias's discovery row says something different.
    assert.deepEqual(explained.assumptions.conventions, effectiveConventions.get(entry.indicator),
      entry.name + ': registry baseline disagrees with its declared conventions');
    assert.deepEqual(Object.keys(explained.assumptions.parameters).sort(), [...entry.parameters].sort());
  }
  assertDisclosure(minimal);
  const probe = (label, method, parameters, extra = {}) =>
    ({ label, method, inputs: entry.inputs, ...(parameters === undefined ? {} : { parameters }), ...extra });
  const probes = [
    probe('omitted-parameters', 'explain', undefined),
    probe('minimal-defaults', 'explain', minimal),
    probe('explicit-defaults', 'explain', resolvedParameters(defaults, minimal)),
    probe('undefined-defaults', 'explain', minimal, { undefinedKeys: Object.keys(defaults) }),
    probe('stream-defaults', 'stream', minimal),
  ];
  for (const method of ['call', 'explain', 'stream'])
    probes.push(probe('unknown-key-' + method, method, { ...minimal, __unknown_indicator_parameter__: 1 }));
  for (const method of ['call', 'explain'])
    probes.push(probe('wrong-input-kind-' + method, method, minimal, { wrongKind: true }));
  for (const key of entry.parameters) {
    probes.push(probe('null-' + key, 'explain', { ...minimal, [key]: null }));
    if (defaults[key] === null) nullableDefaults.push(entry.name + '.' + key);
    if (typeof defaults[key] === 'function') {
      dependentDefaults.push(entry.name + '.' + key);
      // All current dependent resolvers read period. Assert the registry itself computes the
      // override, rather than accepting unchanged defaults on both sides of this equivalence.
      assert.ok(entry.parameters.includes('period'), entry.name + ': add a dependency probe');
      const changed = { ...minimal, period: 17 };
      assertDisclosure(changed);
      probes.push(probe('dependent-default-' + key, 'explain', changed));
      const explicit = { ...changed, [key]: 11 };
      assertDisclosure(explicit);
      probes.push(probe('explicit-dependent-' + key, 'explain', explicit));
    }
  }
  // Fixtures cross into the web-only realm as JSON. Refuse any lossy fixture (NaN, -0,
  // undefined, etc.); intentional undefined parameters are added by undefinedKeys afterwards.
  for (const test of probes)
    if (test.parameters !== undefined)
      assert.deepEqual(JSON.parse(JSON.stringify(test.parameters)), test.parameters,
        entry.name + ': non-JSON parameter fixture for ' + test.label);
  const expected = probes.map(test => runProbe(entry.indicator, test));
  for (const [index, test] of probes.entries()) {
    const outcome = expected[index];
    const refuses = test.label.startsWith('unknown-key-') || test.wrongKind ||
      (test.label === 'omitted-parameters' && required.length > 0) ||
      (test.label.startsWith('null-') && defaults[test.label.slice(5)] !== null);
    assert.equal(outcome.ok, !refuses, entry.name + ': invalid registry oracle for ' + test.label);
    if (refuses) {
      assert.equal(outcome.error.inputError, true, entry.name + ': untyped baseline refusal');
      assert.equal(outcome.error.quantError, true);
      if (test.label.startsWith('unknown-key-')) assert.equal(outcome.error.code, 'input.unknown_field');
      if (test.wrongKind || test.label.startsWith('null-')) assert.equal(outcome.error.code, 'input.wrong_type');
    }
  }
  return { name: entry.name, identity: identities.indexOf(entry.indicator), probes, expected };
});
const leaves = [];
for (const key of Object.keys(manifest.exports).sort()) {
  if (!key.startsWith('./technical-analysis/') || key === './technical-analysis/registry') continue;
  const specifier = manifest.name + key.slice(1);
  installedPath(specifier);
  const namespace = await import(specifier);
  const bindings = [];
  const seen = new Set();
  function visit(value, path) {
    const identity = identities.indexOf(value);
    if (identity >= 0) {
      bindings.push({ path, identity, names: entries.filter(entry => entry.indicator === value).map(entry => entry.name) });
      return;
    }
    // Public namespace objects (notably candlesticks) expose registered identities too. Never
    // invoke getters or descend into a function's implementation/metadata slot to discover them.
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
      if ('value' in descriptor) visit(descriptor.value, [...path, name]);
  }
  visit(namespace, []);
  if (bindings.length) leaves.push({ specifier, bindings });
}
assert.deepEqual([...new Set(leaves.flatMap(leaf => leaf.bindings.flatMap(binding => binding.names)))].sort(),
  entries.map(entry => entry.name).sort(), 'Every registered name must be reachable from a public leaf export');
assert.ok(dependentDefaults.length > 0, 'Dependent defaults must be exercised');
assert.ok(nullableDefaults.includes('tosStdevAll.period'), 'The nullable expanding window must be exercised');
process.stdout.write(JSON.stringify({ catalog, leaves, dependentDefaults, nullableDefaults }));
`;

/** No IO beyond the packed consumer's scratch entries; returns a non-vacuous coverage receipt. */
export async function assertInstalledIndicatorMetadata(
  consumer: string,
): Promise<IndicatorMetadataCoverage> {
  const directory = realpathSync(consumer);
  // Resolve first, so a missing installation cannot fall back to the workspace through cwd.
  realpathSync(
    join(
      directory,
      'node_modules',
      '@insiderfinance',
      'totalfinance',
      'modules',
      'technical-analysis',
    ),
  );
  const baseline = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', DISCOVER_BASELINE], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      maxBuffer: 128 * 1024 * 1024,
      timeout: 60_000,
    }),
  ) as Baseline;
  const byName = new Map(baseline.catalog.map((row) => [row.name, row]));
  const testedNames = new Set<string>();
  const testedIdentities = new Set<number>();
  const failures: string[] = [];
  let comparisons = 0;

  for (const leaf of baseline.leaves) {
    const source = `import * as leaf from ${JSON.stringify(leaf.specifier)};
import { InputError, QuantError } from '@insiderfinance/totalfinance/core';
${PROBE_RUNTIME}
globalThis.consumerCall = (path, probes) => {
  const indicator = path.reduce((value, key) => value[key], leaf);
  return probes.map(probe => runProbe(indicator, probe));
};`;
    const measurement = await measureConsumer(
      directory,
      {
        id: `indicator-metadata-${leaf.specifier.split('/').at(-1)}`,
        canary: 'rsi',
        specifier: leaf.specifier,
        style: 'metadata-namespace',
        source,
        // This audit intentionally retains a leaf's exports, not just one indicator. Size
        // budgets remain exclusively in the used-function canaries; no ceiling is asserted here.
        budgetKiB: { esbuild: Infinity, rollup: Infinity },
        reason:
          'Exhaustive registry-independent metadata and validation equivalence, not a size canary.',
      },
      'esbuild',
    );
    assert.deepEqual(
      measurement.retainedModules.filter(({ id }) =>
        /@insiderfinance\/totalfinance\/modules\/technical-analysis\/dist\/(?:registry|aliases|warmup|index)\.js$/.test(
          id,
        ),
      ),
      [],
      `${leaf.specifier}: registry/discovery machinery leaked into the browser bundle`,
    );
    const context = consumerBrowser(measurement);
    for (const binding of leaf.bindings) {
      for (const name of binding.names) {
        const row = byName.get(name)!;
        assert.equal(row.identity, binding.identity);
        const serialized: unknown = runInContext(
          `JSON.stringify(consumerCall(${JSON.stringify(binding.path)}, ${JSON.stringify(row.probes)}))`,
          context,
          { timeout: 5000 },
        );
        assert.equal(typeof serialized, 'string');
        const actual = JSON.parse(serialized as string) as unknown[];
        assert.equal(actual.length, row.probes.length);
        for (const [index, probe] of row.probes.entries()) {
          comparisons++;
          try {
            assert.deepEqual(actual[index], row.expected[index]);
          } catch {
            failures.push(
              `${name} via ${leaf.specifier}#${binding.path.join('.')}: ${probe.label}`,
            );
          }
        }
        testedNames.add(name);
        testedIdentities.add(binding.identity);
      }
    }
  }
  assert.equal(testedNames.size, 335);
  assert.equal(testedIdentities.size, 321);
  assert.deepEqual([...testedNames].sort(), [...byName.keys()].sort());
  assert.equal(
    failures.length,
    0,
    `Registry-dependent installed TA behavior (${failures.length}/${comparisons} probes):\n${failures.slice(0, 60).join('\n')}`,
  );
  return {
    names: testedNames.size,
    identities: testedIdentities.size,
    leafEntrypoints: baseline.leaves.length,
    comparisons,
    dependentDefaults: baseline.dependentDefaults,
    nullableDefaults: baseline.nullableDefaults,
  };
}
