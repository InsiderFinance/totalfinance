import { spawnSync } from 'node:child_process';
import { deserialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  allowedConsumerModule,
  CONSUMER_BUNDLERS,
  CONSUMER_FIXTURES,
  CONSUMER_EXPECTED_PRICES,
  CONSUMER_IMPORT_TOLERANCE_BYTES,
  CONSUMER_VALID_INPUTS,
  type ConsumerBundler,
  type ConsumerFixture,
} from './consumer-fixtures.js';
import {
  callConsumer,
  consumerBrowser,
  consumerError,
  measureConsumer,
  type ConsumerMeasurement,
} from './consumer-measure.js';
import { assertConsumerConventions } from './consumer-metadata.js';

const metadataValues = Array.from({ length: 80 }, (_, i) => 100 + (i % 7) - (i % 3) + i / 10);
const metadataBars = metadataValues.map((close) => ({ high: close + 2, low: close - 2, close }));

/** Bounded representatives of literal/derived defaults, conventions and series/bar/pair inputs. */
const TA_METADATA_CASES = [
  {
    name: 'rsi',
    subpath: 'rsi',
    parameters: {},
    values: metadataValues,
    disclosed: { period: 14 },
  },
  {
    name: 'macd',
    subpath: 'macd',
    parameters: {},
    values: metadataValues,
    disclosed: { fast: 12, slow: 26, signal: 9 },
  },
  {
    name: 'bbands',
    subpath: 'bands',
    parameters: {},
    values: metadataValues,
    disclosed: { period: 20, standardDeviation: 2 },
  },
  {
    name: 't3',
    subpath: 'moving-averages',
    parameters: { period: 5 },
    values: metadataValues,
    disclosed: { period: 5, volumeFactor: 0.7 },
  },
  {
    name: 'vidya',
    subpath: 'moving-averages',
    parameters: { period: 5 },
    values: metadataValues,
    disclosed: { period: 5, cmoPeriod: 5 },
  },
  { name: 'atr', subpath: 'bars', parameters: {}, values: metadataBars, disclosed: { period: 14 } },
  {
    name: 'beta',
    subpath: 'statistics',
    parameters: { period: 5 },
    values: metadataValues.map((x, i) => ({ x, y: 90 + i / 5 + (i % 4) })),
    disclosed: { period: 5 },
  },
];

interface RegistryReference {
  explanations: Record<string, unknown>;
  conventions: Record<string, string[]>;
}

/** Run registry initialization ONLY in a child, never in the lean browser consumer's module graph. */
function installedRegistryReference(consumer: string): RegistryReference {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { getIndicator, listIndicators } from '@insiderfinance/totalfinance/technical-analysis/registry';
import { serialize } from 'node:v8';
const cases = ${JSON.stringify(TA_METADATA_CASES)};
const explanations = Object.fromEntries(cases.map(({name, values, parameters}) => {
  const entry = getIndicator(name);
  if (!entry) throw new Error('Missing registered indicator: ' + name);
  return [name, entry.indicator.explain(values, parameters)];
}));
const strings = value => typeof value === 'string' ? [value] :
  value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const conventions = Object.fromEntries(listIndicators().map(entry =>
  [entry.name, strings(entry.conventions)]));
// Preserve numeric warmup slots and literal strings as different values across the process boundary.
process.stdout.write(serialize({ explanations, conventions }).toString('base64'));
`,
    ],
    { cwd: consumer, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Installed registry reference failed: ${String(result.error)}\n${result.stderr}`,
    );
  }
  return deserialize(Buffer.from(result.stdout, 'base64')) as RegistryReference;
}

/** Extra methods belong to a separate validation bundle, never the primary size canary. */
function rsiLifecycleFixture(fixture: ConsumerFixture): ConsumerFixture {
  const member = /=> ([\w.]+)\(input.values, input.parameters\);/.exec(fixture.source)?.[1];
  if (!member) throw new Error(`Not an RSI calculation fixture: ${fixture.id}`);
  return {
    ...fixture,
    id: `${fixture.id}-lifecycle`,
    source: `${fixture.source.split('\n')[0]}
globalThis.consumerCall = (input) => {
  const indicator = ${member};
  if (input.method === 'explain') return indicator.explain(input.values, input.parameters);
  const stream = indicator.stream(input.parameters);
  const initial = stream.toJSON();
  const split = Math.floor(input.values.length / 2);
  const first = input.values.slice(0, split).map(value => stream.next(value));
  const restored = indicator.fromJSON(JSON.parse(JSON.stringify(stream.toJSON())));
  const rest = input.values.slice(split);
  const resumed = rest.map(value => restored.next(value));
  return { initial, values: [...first, ...rest.map(value => stream.next(value))], resumed,
    snapshot: stream.toJSON(), restoredSnapshot: restored.toJSON() };
};
`,
  };
}

const UNKNOWN_RSI_PARAMETER = {
  typed: true,
  code: 'input.unknown_field',
  context: { field: 'parameters', key: 'perod', suggestion: 'period' },
};

/** No second install: register within packed-consumer.test.ts's shared beforeAll/afterAll. */
export function registerInstalledConsumerTests(consumer: () => string): void {
  describe('installed consumer tree shaking', () => {
    const measurements = new Map<string, Promise<ConsumerMeasurement>>();
    let registryReference: RegistryReference | undefined;
    const reference = () => (registryReference ??= installedRegistryReference(consumer()));
    const lifecycleMeasurements = new Map<string, Promise<ConsumerMeasurement>>();
    const lifecycle = (fixture: ConsumerFixture, bundler: ConsumerBundler) => {
      const key = `${bundler}:${fixture.id}`;
      let result = lifecycleMeasurements.get(key);
      if (!result) {
        result = measureConsumer(consumer(), rsiLifecycleFixture(fixture), bundler, true);
        lifecycleMeasurements.set(key, result);
      }
      return result;
    };
    const measure = (fixture: ConsumerFixture, bundler: ConsumerBundler) => {
      const key = `${bundler}:${fixture.id}`;
      let result = measurements.get(key);
      if (!result) {
        result = measureConsumer(consumer(), fixture, bundler);
        measurements.set(key, result);
      }
      return result;
    };

    for (const bundler of CONSUMER_BUNDLERS) {
      describe(bundler, () => {
        for (const fixture of CONSUMER_FIXTURES) {
          it(`${fixture.id}: bytes, retained boundaries and browser result`, async () => {
            const result = await measure(fixture, bundler);
            const evidence = `${bundler} ${fixture.id}: ${result.bytesGzip} B gzip, ${result.bytesMin} B minified; retained=${JSON.stringify(result.retainedModules)}; ${fixture.reason}`;
            expect(result.bytesGzip, evidence).toBeLessThan(fixture.budgetKiB[bundler] * 1024);
            expect(
              result.retainedModules.filter(
                ({ id }) => !allowedConsumerModule(fixture, bundler, id),
              ),
              evidence,
            ).toEqual([]);
            const context = consumerBrowser(result);
            const value = callConsumer(
              context,
              JSON.stringify(CONSUMER_VALID_INPUTS[fixture.canary]),
            );
            switch (fixture.canary) {
              case 'normal':
                expect(value).toBeCloseTo(0.8413447460685429, 14);
                expect(callConsumer(context, '0')).toBe(0.5);
                expect(callConsumer(context, '-Infinity')).toBe(0);
                expect(callConsumer(context, 'Infinity')).toBe(1);
                expect(callConsumer(context, 'NaN')).toBeNaN();
                break;
              case 'rsi': {
                // Wilder seed gains=5/3, losses=1/3, then (10/9,5/9), then (47/27,10/27).
                expect(value).toEqual([
                  NaN,
                  NaN,
                  NaN,
                  expect.closeTo((100 * 5) / 6, 12),
                  expect.closeTo((100 * 2) / 3, 12),
                  expect.closeTo((100 * 47) / 57, 12),
                ]);
                if (!(fixture.rootNamespace && bundler === 'esbuild')) {
                  // A shared private file is legitimate, a retained catalog inside it is not.
                  // Installed contributions are 281–282 minified esbuild / 537 rendered Rollup B.
                  const descriptor = result.retainedModules.find(
                    ({ id }) =>
                      id ===
                      '@insiderfinance/totalfinance/modules/technical-analysis/dist/builtin-metadata.js',
                  );
                  expect(descriptor, evidence).toBeDefined();
                  expect(descriptor!.bytes, evidence).toBeLessThan(
                    bundler === 'esbuild' ? 300 : 600,
                  );
                  const conventions = reference().conventions;
                  const own = conventions['rsi']!;
                  const foreign = [...new Set(Object.values(conventions).flat())].filter(
                    (value) => !own.includes(value),
                  );
                  assertConsumerConventions(result.code, own, foreign);
                }
                break;
              }
              case 'facade':
              case 'expert':
              case 'expert-black76':
              case 'expert-bachelier':
                expect(value).toBeCloseTo(CONSUMER_EXPECTED_PRICES[fixture.canary], 12);
                break;
              case 'unused':
                expect(value).toBe(42);
                expect(result.retainedModules, evidence).toEqual([]);
                break;
              case 'dynamic': {
                expect(value).toMatchObject({
                  value: expect.closeTo(0.8413447460685429, 14),
                  keys: expect.arrayContaining(['normalCdf', 'normalPdf', 'brent']),
                });
                expect(callConsumer(context, '{ key: "normalPdf", value: 0 }')).toMatchObject({
                  value: expect.closeTo(0.3989422804014327, 14),
                });
                const lean = await measure(
                  CONSUMER_FIXTURES.find((candidate) => candidate.id === 'normal-feature')!,
                  bundler,
                );
                expect(result.bytesGzip, evidence).toBeGreaterThan(lean.bytesGzip + 8 * 1024);
                expect(result.retainedModules.length, evidence).toBeGreaterThan(
                  lean.retainedModules.length + 8,
                );
                expect(result.retainedModules.map(({ id }) => id)).toEqual(
                  expect.arrayContaining([
                    '@insiderfinance/totalfinance/modules/math/dist/normal.js',
                    '@insiderfinance/totalfinance/modules/math/dist/solvers.js',
                    '@insiderfinance/totalfinance/modules/math/dist/random.js',
                  ]),
                );
                break;
              }
            }
            if (fixture.canary !== 'unused')
              expect(result.retainedModules.length, evidence).toBeGreaterThan(0);
            if (fixture.canary.startsWith('expert')) {
              if (fixture.canary === 'expert') {
                const residue = result.retainedModules.find(
                  ({ id }) =>
                    id === '@insiderfinance/totalfinance/modules/options/dist/black-scholes.js',
                );
                expect(residue?.bytes ?? 0, evidence).toBeLessThan(256);
              }
              expect(
                result.retainedModules
                  .map(({ id }) => id)
                  .filter((id) => /\/(?:facade|facade-util|diagnostics|solvers)\.js$/.test(id)),
                evidence,
              ).toEqual([]);
              for (const marker of [
                'blackScholes.call',
                'blackScholes.impliedVolatility',
                'black76.call',
                'black76.impliedVolatility',
                'bachelier.call',
                'bachelier.impliedVolatility',
                'closed-form',
              ]) {
                expect(result.code, evidence).not.toContain(marker);
              }
            }
            if (fixture.parityWith) {
              const baseline = await measure(
                CONSUMER_FIXTURES.find((candidate) => candidate.id === fixture.parityWith)!,
                bundler,
              );
              expect(value).toEqual(
                callConsumer(
                  consumerBrowser(baseline),
                  JSON.stringify(CONSUMER_VALID_INPUTS[fixture.canary]),
                ),
              );
              // Root re-exported namespaces are budgeted coarse esbuild consumers, not failures.
              if (!(fixture.rootNamespace && bundler === 'esbuild')) {
                expect(
                  Math.abs(result.bytesGzip - baseline.bytesGzip),
                  evidence,
                ).toBeLessThanOrEqual(CONSUMER_IMPORT_TOLERANCE_BYTES);
                expect(
                  result.retainedModules.map(({ id }) => id),
                  evidence,
                ).toEqual(baseline.retainedModules.map(({ id }) => id));
              }
            }
          }, 60_000);
        }

        for (const fixture of CONSUMER_FIXTURES.filter(({ canary }) =>
          ['facade', 'expert', 'expert-black76', 'expert-bachelier', 'rsi'].includes(canary),
        )) {
          it(`${fixture.id}: exact typed refusals survive browser minification`, async () => {
            // Separate from the size sample: imports of error constructors prove class identity
            // after minification, whose class names are NOT stable. No test harness byte discount.
            const result = await measureConsumer(consumer(), fixture, bundler, true);
            const context = consumerBrowser(result);
            if (fixture.canary === 'rsi') {
              expect(
                consumerError(
                  context,
                  '{ values: [100,102,101,104,103,106], parameters: { perod: 3 } }',
                ),
              ).toMatchObject(UNKNOWN_RSI_PARAMETER);
              expect(
                consumerError(context, '{ values: null, parameters: { period: 3 } }'),
              ).toMatchObject({ typed: true, code: 'input.wrong_type' });
              expect(consumerError(context, '{ values: [1,2,3], parameters: null }')).toMatchObject(
                { typed: true, code: 'input.wrong_type' },
              );
              expect(
                consumerError(context, '{ values: [1,2,3], parameters: { period: "3" } }'),
              ).toMatchObject({
                typed: true,
                code: 'input.not_finite',
                context: { field: 'period' },
              });
              return;
            }
            if (!(fixture.canary in CONSUMER_EXPECTED_PRICES))
              throw new Error('Not a price canary');
            const priceCanary = fixture.canary as keyof typeof CONSUMER_EXPECTED_PRICES;
            const valid = JSON.stringify(CONSUMER_VALID_INPUTS[fixture.canary]);
            const underlying =
              fixture.canary === 'expert-black76' || fixture.canary === 'expert-bachelier'
                ? 'forward'
                : 'spot';
            const volatility =
              fixture.canary === 'expert-bachelier' ? 'normalVolatility' : 'volatility';
            const numericFields = [
              underlying,
              'strike',
              'timeToExpiryYears',
              'riskFreeRate',
              volatility,
              ...(fixture.canary === 'expert' ? ['dividendYield'] : []),
            ];
            for (const field of numericFields) {
              const input = `(() => { const input = ${valid}; delete input.${field}; return input; })()`;
              const error = consumerError(context, input);
              expect(error).toMatchObject({
                typed: true,
                code: 'input.missing_field',
                context: { field },
              });
              expect(error.message).toContain(field);
              expect(error.message).toContain('e.g.');
            }
            const unknown = underlying === 'spot' ? 'dividendYeild' : 'foward';
            const suggestion = underlying === 'spot' ? 'dividendYield' : 'forward';
            expect(consumerError(context, `({ ...${valid}, ${unknown}: 0 })`)).toMatchObject({
              typed: true,
              code: 'input.unknown_field',
              context: { field: 'input', key: unknown, suggestion },
            });
            expect(consumerError(context, `({ ...${valid}, ${underlying}: '100' })`)).toMatchObject(
              {
                typed: true,
                code: 'input.wrong_type',
                context: { field: underlying },
              },
            );
            expect(consumerError(context, `({ ...${valid}, ${underlying}: null })`)).toMatchObject({
              typed: true,
              code: 'input.wrong_type',
              context: { field: underlying },
            });
            expect(consumerError(context, `({ ...${valid}, ${volatility}: NaN })`)).toMatchObject({
              typed: true,
              code: 'input.nan',
              context: { field: volatility },
            });
            expect(
              consumerError(context, `({ ...${valid}, ${volatility}: Infinity })`),
            ).toMatchObject({
              typed: true,
              code: 'input.not_finite',
              context: { field: volatility },
            });
            if (fixture.canary.startsWith('expert')) {
              for (const type of ['undefined', '"Call"', '0']) {
                expect(consumerError(context, `({ ...${valid}, type: ${type} })`)).toMatchObject({
                  typed: true,
                  code: 'input.invalid_enum',
                  context: { field: 'type' },
                });
              }
            }
            for (const input of ['undefined', 'null', '[]', '100', '"input"']) {
              expect(consumerError(context, input)).toMatchObject({
                typed: true,
                code: 'input.wrong_type',
                context:
                  fixture.canary === 'facade'
                    ? { function: 'blackScholes.call' }
                    : { field: 'input' },
              });
            }
            // The taught correction works immediately in the very same loaded bundle.
            expect(callConsumer(context, valid)).toBeCloseTo(
              CONSUMER_EXPECTED_PRICES[priceCanary],
              12,
            );
          }, 60_000);
        }

        for (const fixture of CONSUMER_FIXTURES.filter(({ canary }) => canary === 'rsi')) {
          for (const method of ['explain', 'stream']) {
            it(`${fixture.id}: ${method} refuses unknown RSI parameters`, async () => {
              const context = consumerBrowser(await lifecycle(fixture, bundler));
              expect(
                consumerError(
                  context,
                  JSON.stringify({ method, values: metadataValues, parameters: { perod: 3 } }),
                ),
              ).toMatchObject(UNKNOWN_RSI_PARAMETER);
            }, 60_000);
          }
          it(`${fixture.id}: explain disclosure and restored streaming match the installed registry`, async () => {
            const context = consumerBrowser(await lifecycle(fixture, bundler));
            const explained = callConsumer(
              context,
              JSON.stringify({ method: 'explain', values: metadataValues }),
            );
            expect(explained).toMatchObject({
              assumptions: {
                parameters: { period: 14 },
                conventions: { smoothing: 'wilder', flatSeries: expect.stringContaining('100') },
              },
            });
            expect(explained).toEqual(reference().explanations['rsi']);
            for (const parameters of [undefined, { period: 3 }]) {
              const input = { values: metadataValues, parameters };
              const explanation = callConsumer(
                context,
                JSON.stringify({ ...input, method: 'explain' }),
              ) as { value: unknown[] };
              const streamed = callConsumer(
                context,
                JSON.stringify({ ...input, method: 'stream' }),
              ) as {
                values: unknown[];
                resumed: unknown[];
                snapshot: unknown;
                restoredSnapshot: unknown;
              };
              expect(streamed).toMatchObject({
                initial: { kind: 'rsi', state: { period: parameters?.period ?? 14 } },
              });
              expect(streamed.values.map((value) => (value === null ? NaN : value))).toEqual(
                explanation.value,
              );
              expect(streamed.resumed).toEqual(
                streamed.values.slice(Math.floor(metadataValues.length / 2)),
              );
              expect(streamed.restoredSnapshot).toEqual(streamed.snapshot);
            }
          }, 60_000);
          it(`${fixture.id}: RSI rejects object rows instead of silently computing 100`, async () => {
            const context = consumerBrowser(
              await measureConsumer(consumer(), fixture, bundler, true),
            );
            expect(
              consumerError(
                context,
                '{ values: [{close:100},{close:102},{close:101},{close:104}], parameters: {period:3} }',
              ),
            ).toMatchObject({ typed: true, code: 'input.wrong_type', context: { index: 0 } });
          }, 60_000);
        }

        for (const entry of TA_METADATA_CASES) {
          it(`isolated TA metadata: ${entry.name} matches the installed registry without importing it`, async () => {
            const fixture: ConsumerFixture = {
              ...CONSUMER_FIXTURES.find(({ id }) => id === 'rsi-feature')!,
              id: `ta-metadata-${entry.name}`,
              specifier: `@insiderfinance/totalfinance/technical-analysis/${entry.subpath}`,
              source: `import { ${entry.name} as indicator } from '@insiderfinance/totalfinance/technical-analysis/${entry.subpath}';
globalThis.consumerCall = (input) => indicator.explain(input.values, input.parameters);`,
            };
            const result = await measureConsumer(consumer(), fixture, bundler, true);
            expect(result.retainedModules.map(({ id }) => id)).not.toContain(
              '@insiderfinance/totalfinance/modules/technical-analysis/dist/registry.js',
            );
            const context = consumerBrowser(result);
            expect(callConsumer(context, JSON.stringify(entry))).toMatchObject({
              assumptions: { parameters: entry.disclosed },
            });
            expect(callConsumer(context, JSON.stringify(entry))).toEqual(
              reference().explanations[entry.name],
            );
            expect(
              consumerError(
                context,
                JSON.stringify({
                  values: entry.values,
                  parameters: { ...entry.parameters, __unknownParameter: true },
                }),
              ),
            ).toMatchObject({
              typed: true,
              code: 'input.unknown_field',
              context: { field: 'parameters', key: '__unknownParameter' },
            });
            const wrongValues =
              entry.name === 'atr' || entry.name === 'beta'
                ? [1, 2, 3]
                : [{ close: 100 }, { close: 101 }];
            expect(
              consumerError(
                context,
                JSON.stringify({ values: wrongValues, parameters: entry.parameters }),
              ),
            ).toMatchObject({ typed: true, code: 'input.wrong_type' });
          }, 60_000);
        }

        it('BSM facade and expert agree with explicit dividends, rates and maturities', async () => {
          const facade = consumerBrowser(
            await measure(CONSUMER_FIXTURES.find(({ id }) => id === 'facade-feature')!, bundler),
          );
          const expert = consumerBrowser(
            await measure(CONSUMER_FIXTURES.find(({ id }) => id === 'expert-feature')!, bundler),
          );
          for (const overrides of [
            { dividendYield: 0 },
            { dividendYield: 0.03, riskFreeRate: -0.01 },
            { dividendYield: 0.015, strike: 80, timeToExpiryYears: 1 },
            { dividendYield: 0.02, strike: 125, timeToExpiryYears: 0.01 },
          ]) {
            const input = { ...CONSUMER_VALID_INPUTS.facade, ...overrides };
            const expected = callConsumer(expert, JSON.stringify({ ...input, type: 'call' }));
            expect(typeof expected).toBe('number');
            expect(Number.isFinite(expected)).toBe(true);
            expect(callConsumer(facade, JSON.stringify(input))).toBe(expected);
          }
        }, 60_000);
      });
    }

    it('both bundlers agree numerically on every import style', async () => {
      for (const fixture of CONSUMER_FIXTURES) {
        const input = JSON.stringify(CONSUMER_VALID_INPUTS[fixture.canary]);
        const esbuild = await measure(fixture, 'esbuild');
        const rollup = await measure(fixture, 'rollup');
        expect(callConsumer(consumerBrowser(esbuild), input), fixture.id).toEqual(
          callConsumer(consumerBrowser(rollup), input),
        );
      }
    }, 180_000);
  });
}
