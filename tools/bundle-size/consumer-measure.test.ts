import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSUMER_BUNDLERS, CONSUMER_FIXTURES } from './consumer-fixtures.js';
import { callConsumer, consumerBrowser, measureConsumer } from './consumer-measure.js';
import { assertConsumerConventions } from './consumer-metadata.js';

/** Harness unit tests use a tiny synthetic install; release claims use the real packed suite. */
describe('consumer measurement machinery', () => {
  let consumer: string;
  let main: string;
  let math: string;
  const feature = CONSUMER_FIXTURES.find(({ id }) => id === 'normal-feature')!;
  const unused = CONSUMER_FIXTURES.find(({ id }) => id === 'unused-library')!;
  beforeEach(() => {
    consumer = mkdtempSync(join(tmpdir(), 'consumer-measure-unit-'));
    main = join(consumer, 'node_modules', '@insiderfinance', 'totalfinance');
    math = join(main, 'modules', 'math');
    mkdirSync(join(math, 'dist'), { recursive: true });
    writeFileSync(
      join(main, 'package.json'),
      JSON.stringify({
        name: '@insiderfinance/totalfinance',
        type: 'module',
        sideEffects: false,
        exports: {
          './math': './modules/math/dist/index.js',
          './math/normal': './modules/math/dist/normal.js',
        },
      }),
    );
    writeFileSync(
      join(math, 'dist/index.js'),
      "export { normalCdf } from './normal.js'; export { unused } from './unused.js';",
    );
    writeFileSync(join(math, 'dist/normal.js'), 'export const normalCdf = (x) => x / 2;');
    writeFileSync(
      join(math, 'dist/unused.js'),
      'globalThis.unwantedSideEffect = true; export const unused = 999;',
    );
  });
  afterEach(() => rmSync(consumer, { recursive: true, force: true }));

  for (const bundler of CONSUMER_BUNDLERS) {
    it(`${bundler}: VM results preserve IEEE numbers, strings and nested value types`, async () => {
      writeFileSync(join(math, 'dist/normal.js'), 'export const normalCdf = (x) => x;');
      const context = consumerBrowser(await measureConsumer(consumer, feature, bundler));
      expect(
        callConsumer(
          context,
          `({
        values: [NaN, Infinity, -Infinity, -0, undefined, 'NaN', 'Infinity', '-Infinity', null],
        nested: { missing: undefined, warmup: NaN, text: 'NaN' }
      })`,
        ),
      ).toStrictEqual({
        values: [NaN, Infinity, -Infinity, -0, undefined, 'NaN', 'Infinity', '-Infinity', null],
        nested: { missing: undefined, warmup: NaN, text: 'NaN' },
      });
      for (const number of ['NaN', 'Infinity', '-Infinity']) {
        const numeric = callConsumer(context, number);
        const text = callConsumer(context, JSON.stringify(number));
        expect(typeof numeric).toBe('number');
        expect(typeof text).toBe('string');
        expect(text).not.toEqual(numeric);
        expect(() => expect(text).toEqual(numeric)).toThrow();
      }
    });

    it(`${bundler}: literal string warmups cannot satisfy the RSI numeric assertion`, async () => {
      writeFileSync(
        join(math, 'dist/normal.js'),
        "export const normalCdf = () => ['NaN', 'NaN', 'NaN', 100];",
      );
      const context = consumerBrowser(await measureConsumer(consumer, feature, bundler));
      const impostor = callConsumer(context, '1');
      expect(impostor).toStrictEqual(['NaN', 'NaN', 'NaN', 100]);
      expect(() => expect(impostor).toEqual([NaN, NaN, NaN, 100])).toThrow();
    });

    it(`${bundler}: reports rendered contributions, not parsed barrel/dead modules`, async () => {
      const measured = await measureConsumer(
        consumer,
        {
          ...feature,
          source: feature.source.replace(
            '@insiderfinance/totalfinance/math/normal',
            '@insiderfinance/totalfinance/math',
          ),
        },
        bundler,
      );
      expect(measured.retainedModules.map(({ id }) => id)).toEqual([
        '@insiderfinance/totalfinance/modules/math/dist/normal.js',
      ]);
      expect(measured.retainedModules[0]!.bytes).toBeGreaterThan(0);
      expect(measured.code).not.toContain('unwantedSideEffect');
      const context = consumerBrowser(measured);
      expect(callConsumer(context, '4')).toBe(2);
      expect(context['process']).toBeUndefined();
      expect(context['require']).toBeUndefined();
      expect(context['Buffer']).toBeUndefined();
    });

    it(`${bundler}: installed sideEffects metadata controls unused imports`, async () => {
      const fixture = {
        ...unused,
        source: "import '@insiderfinance/totalfinance/math'; globalThis.consumerCall = () => 42;",
      };
      expect((await measureConsumer(consumer, fixture, bundler)).retainedModules).toEqual([]);
      // A global moduleSideEffects:false override would make this positive control fail.
      writeFileSync(
        join(main, 'package.json'),
        JSON.stringify({
          name: '@insiderfinance/totalfinance',
          type: 'module',
          sideEffects: true,
          exports: { './math': './modules/math/dist/index.js' },
        }),
      );
      const retained = await measureConsumer(consumer, fixture, bundler);
      expect(retained.retainedModules.map(({ id }) => id)).toContain(
        '@insiderfinance/totalfinance/modules/math/dist/unused.js',
      );
      expect(consumerBrowser(retained)['unwantedSideEffect']).toBe(true);
    });

    it(`${bundler}: refuses metadata that redirects public exports to source`, async () => {
      mkdirSync(join(math, 'src'));
      writeFileSync(join(math, 'src/normal.js'), 'export const normalCdf = () => 1;');
      writeFileSync(
        join(main, 'package.json'),
        JSON.stringify({
          name: '@insiderfinance/totalfinance',
          type: 'module',
          sideEffects: false,
          exports: { './math/normal': './modules/math/src/normal.js' },
        }),
      );
      await expect(measureConsumer(consumer, feature, bundler)).rejects.toThrow(
        'Not an installed TotalFinance dist module',
      );
    });

    it(`${bundler}: rejects Node-only dependencies instead of externalizing them`, async () => {
      writeFileSync(
        join(math, 'dist/normal.js'),
        "import { readFileSync } from 'node:fs'; export const normalCdf = () => readFileSync('secret');",
      );
      await expect(measureConsumer(consumer, feature, bundler)).rejects.toThrow();
    });

    it(`${bundler}: rejects transport modules even when they happen not to import a Node builtin`, async () => {
      const cli = join(main, 'modules', 'cli', 'dist');
      mkdirSync(cli, { recursive: true });
      writeFileSync(join(cli, 'marker.js'), 'export const normalCdf = (x) => x / 2;');
      writeFileSync(
        join(math, 'dist/normal.js'),
        "export { normalCdf } from '../../cli/dist/marker.js';",
      );
      await expect(measureConsumer(consumer, feature, bundler)).rejects.toThrow(
        'Node-only module reached a browser consumer',
      );
    });
  }

  it('Rollup defers parsed cycle warnings but rejects cycles in retained output', async () => {
    writeFileSync(
      join(math, 'dist/unused.js'),
      "import { other } from './cycle.js'; export const unused = (x) => other(x); export const divisor = 2;",
    );
    writeFileSync(
      join(math, 'dist/cycle.js'),
      "import { divisor } from './unused.js'; export const other = (x) => x / divisor;",
    );
    const measured = await measureConsumer(
      consumer,
      {
        ...feature,
        source: feature.source.replace(
          '@insiderfinance/totalfinance/math/normal',
          '@insiderfinance/totalfinance/math',
        ),
      },
      'rollup',
    );
    expect(measured.retainedModules.map(({ id }) => id)).toEqual([
      '@insiderfinance/totalfinance/modules/math/dist/normal.js',
    ]);
    await expect(
      measureConsumer(
        consumer,
        {
          ...feature,
          source:
            "import { unused } from '@insiderfinance/totalfinance/math'; globalThis.consumerCall = (input) => unused(input);",
        },
        'rollup',
      ),
    ).rejects.toThrow('Rollup retained a circular dependency');
  });
});

describe('consumer fixture record', () => {
  it('checks retained conventions despite Unicode escaping, without counting comments', () => {
    const own = ['RS → ∞'];
    const foreign = ['another indicator’s convention'];
    const code = String.raw`globalThis.value = 'RS \u2192 \u221e'; /* another indicator’s convention */`;
    expect(() => assertConsumerConventions(code, own, foreign)).not.toThrow();
    expect(() => assertConsumerConventions('', own, foreign)).toThrow('Missing retained RSI');
    expect(() =>
      assertConsumerConventions(
        code + String.raw`globalThis.foreign = 'another indicator\u2019s convention';`,
        own,
        foreign,
      ),
    ).toThrow('Retained unrelated indicator convention');
  });

  it('every import-parity reference resolves to the same canary feature', () => {
    expect(new Set(CONSUMER_FIXTURES.map(({ id }) => id)).size).toBe(CONSUMER_FIXTURES.length);
    expect(new Set(CONSUMER_FIXTURES.map(({ source }) => source)).size).toBe(
      CONSUMER_FIXTURES.length,
    );
    for (const fixture of CONSUMER_FIXTURES) {
      expect(fixture.specifier).toMatch(/^@insiderfinance\/totalfinance(?:\/|$)/);
      expect(fixture.source).not.toMatch(/['"](?:@totalfinance\/|totalfinance(?:\/|['"]))/);
      expect(fixture.reason.length).toBeGreaterThan(30);
      if (fixture.parityWith) {
        expect(CONSUMER_FIXTURES.find(({ id }) => id === fixture.parityWith)).toMatchObject({
          canary: fixture.canary,
          style: 'feature',
        });
      }
      if (fixture.rootNamespace) {
        expect(fixture.reason).toContain('https://github.com/evanw/esbuild/issues/1420');
        expect(fixture.budgetKiB.esbuild).toBeGreaterThan(fixture.budgetKiB.rollup);
      }
    }
  });

  it('expert kernels are exercised only through supported model subpaths', () => {
    const experts = CONSUMER_FIXTURES.filter(({ canary }) => canary.startsWith('expert'));
    expect(new Set(experts.map(({ specifier }) => specifier))).toEqual(
      new Set([
        '@insiderfinance/totalfinance/options/black-scholes',
        '@insiderfinance/totalfinance/options/black76',
        '@insiderfinance/totalfinance/options/bachelier',
      ]),
    );
    for (const fixture of experts)
      expect(fixture.specifier).toMatch(/^@insiderfinance\/totalfinance\/options\/[^/]+$/);
  });
});
