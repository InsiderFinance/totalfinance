/** Source isolation complements the installed-tarball catalog tests in tools/bundle-size. */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ErrorCode, type Computed } from '@totalfinance/core';
import { listIndicators } from '../src/registry.js';
import { indicatorWarmups } from '../src/warmup.js';
import type { Indicator } from '../src/framework.js';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const entries = listIndicators();
const canonical = new Map(indicatorWarmups(280).map((entry) => [entry.name, entry.parameters]));
const catalog = new Map(entries.map((entry) => [entry.indicator, entry]));
const families = readdirSync(source).filter((file) => {
  if (!file.endsWith('.ts') || file === 'registry.ts') return false;
  const ast = ts.createSourceFile(
    file,
    readFileSync(`${source}${file}`, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let constructs = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'makeIndicator'
    )
      constructs = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return constructs;
});
// Public family aggregators also need to work without the registry import.
const paths = [
  ...new Set([
    ...families,
    'features.ts',
    'momentum.ts',
    'overlap.ts',
    'price-action.ts',
    'volume.ts',
  ]),
].sort();

type ProbeIndicator = Indicator<Record<string, unknown>, unknown, unknown>;
interface Isolated {
  code: string;
  exports: Record<string, unknown>;
  retained: string[];
}
async function isolate(contents: string): Promise<Isolated> {
  const built = await build({
    stdin: { contents, resolveDir: source },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    globalName: 'leaf',
    minify: true,
    metafile: true,
  });
  const code = built.outputFiles[0]!.text;
  const retained = Object.entries(Object.values(built.metafile!.outputs)[0]!.inputs)
    .filter(([, value]) => value.bytesInOutput > 0)
    .map(([path]) => path);
  return {
    code,
    retained,
    exports: runInNewContext(`${code}; leaf`, {}, { timeout: 5000 }) as Record<string, unknown>,
  };
}

const series = Array.from(
  { length: 260 },
  (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1),
);
const bars = series.map((close, i) => {
  const open = i === 0 ? close : series[i - 1]!;
  return {
    open,
    high: Math.max(open, close) + 1 + (i % 3) * 0.5,
    low: Math.min(open, close) - 1 - (i % 4) * 0.3,
    close,
    volume: 1000 + ((i * 53) % 400),
  };
});
const pairs = series.map((x, i) => ({ x, y: x + Math.cos(i / 4) * 3 }));
const inputFor = (kind: string): unknown[] =>
  kind === 'bars' ? bars : kind === 'pair' ? pairs : series;

function errorCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toHaveProperty('code');
    return (error as { code: unknown }).code;
  }
  throw new Error('Expected a typed refusal');
}

describe('every built-in family is self-contained without registry initialization', () => {
  it('finds every construction family rather than relying on a handwritten roster', () => {
    expect(families).toHaveLength(25);
    expect(paths).toHaveLength(30);
  });

  it.each(paths)(
    '%s keeps validation, defaults, conventions, values, and aliases',
    async (file) => {
      const moduleName = file.slice(0, -3);
      const reference = (await import(`../src/${moduleName}.ts`)) as Record<string, unknown>;
      const isolated = await isolate(`export * from './${file}';`);
      expect(isolated.retained.some((path) => path.endsWith('/registry.ts'))).toBe(false);
      expect(Object.keys(isolated.exports).sort()).toEqual(Object.keys(reference).sort());
      const candidates = Object.entries(reference).flatMap(([name, value]) =>
        name === 'candlesticks'
          ? Object.entries(value as Record<string, unknown>).map(([pattern, indicator]) => ({
              name: `candlesticks.${pattern}`,
              value: indicator,
              actual: (isolated.exports[name] as Record<string, unknown>)[pattern],
            }))
          : [{ name, value, actual: isolated.exports[name] }],
      );
      const seen = new Map<unknown, unknown>();
      let checked = 0;
      for (const candidate of candidates) {
        const entry = catalog.get(candidate.value as ProbeIndicator);
        if (!entry) continue;
        checked++;
        if (seen.has(candidate.value))
          expect(candidate.actual, candidate.name).toBe(seen.get(candidate.value));
        seen.set(candidate.value, candidate.actual);
        const indicator = candidate.actual as ProbeIndicator;
        const input = inputFor(entry.inputs);
        const required = Object.fromEntries(
          entry.parameters
            .filter((key) => !(key in (entry.defaults ?? {})))
            .map((key) => [key, canonical.get(entry.name)![key]]),
        );
        const expected = entry.indicator.explain(input, required);
        expect(indicator.explain(input, required), candidate.name).toEqual(expected);
        expect(indicator(input, required), candidate.name).toEqual(expected.value);
        const badParameters = { ...required, __unknownMetadataProbe: true };
        for (const run of [
          () => indicator(input, badParameters),
          () => indicator.explain(input, badParameters),
          () => indicator.stream(badParameters),
        ]) {
          expect(errorCode(run), candidate.name).toBe(ErrorCode.InputUnknownField);
        }
        const wrongInput = entry.inputs === 'series' ? [{}] : [1];
        expect(
          errorCode(() => indicator(wrongInput, required)),
          candidate.name,
        ).toBe(errorCode(() => entry.indicator(wrongInput, required)));
      }
      expect(checked, file).toBeGreaterThan(0);
    },
  );

  it('RSI retains only its own descriptor and refuses malformed input in a browser context', async () => {
    const isolated = await isolate("export { rsi } from './rsi.ts';");
    expect(isolated.retained).toContain('packages/technical-analysis/src/builtin-metadata.ts');
    for (const unrelated of ['registry.ts', 'output-meta.ts', 'moving-averages.ts', 'cycle.ts']) {
      expect(isolated.retained.some((path) => path.endsWith(`/${unrelated}`))).toBe(false);
    }
    for (const unrelated of [
      'bug-compatible with pandas-ta',
      'TA-Lib re-seeds',
      'cmoPeriod',
      'volumeCutoff',
      'minimumGapPercent',
      'stds',
    ]) {
      expect(isolated.code).not.toContain(unrelated);
    }
    const rsi = isolated.exports['rsi'] as ProbeIndicator;
    expect(rsi.explain([1, 2, 3]).assumptions).toMatchObject({
      parameters: { period: 14 },
      conventions: { smoothing: 'wilder' },
    });
    expect(errorCode(() => rsi([1, 2, 3], { perid: 2 }))).toBe(ErrorCode.InputUnknownField);
    expect(errorCode(() => rsi([{}]))).toBe(ErrorCode.InputWrongType);
  });

  it('unused metadata imports retain neither descriptors nor derived-default constructors', async () => {
    const isolated = await isolate(
      "import { vidyaMetadata, rsiMetadata } from './builtin-metadata.ts'; export const value = 1;",
    );
    expect(isolated.retained.filter((path) => path.includes('/technical-analysis/'))).toEqual([]);
    expect(isolated.exports['value']).toBe(1);
    expect(isolated.code).not.toContain('cmoPeriod');
  });

  it('loading discovery later preserves effective alias metadata and facade identity', async () => {
    const isolated = await isolate(`
      export { stochastic, stochFast } from './bars.ts';
      export { beta, rollingMinIndex, rollingMaxIndex } from './statistics.ts';
      export { rollingBeta, lowestBars, highestBars } from './features-ext.ts';
      export const loadRegistry = () => import('./registry.ts');
    `);
    const aliasPairs = [
      ['stochastic', 'stochFast'],
      ['beta', 'rollingBeta'],
      ['rollingMinIndex', 'lowestBars'],
      ['rollingMaxIndex', 'highestBars'],
    ];
    const before = new Map<string, Computed<unknown>>();
    for (const [name, alias] of aliasPairs) {
      const indicator = isolated.exports[name!] as ProbeIndicator;
      expect(indicator).toBe(isolated.exports[alias!]);
      const entry = entries.find((entry) => entry.name === name)!;
      before.set(name!, indicator.explain(inputFor(entry.inputs), canonical.get(name!)!));
    }
    const registry = await (
      isolated.exports['loadRegistry'] as () => Promise<{ listIndicators: typeof listIndicators }>
    )();
    expect(registry.listIndicators()).toHaveLength(335);
    for (const [name, expected] of before) {
      const entry = entries.find((entry) => entry.name === name)!;
      expect(
        (isolated.exports[name] as ProbeIndicator).explain(
          inputFor(entry.inputs),
          canonical.get(name)!,
        ),
      ).toEqual(expected);
    }
  });
});
