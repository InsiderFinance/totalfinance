import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playgrounds } from '../src/playgrounds/index.js';
import { loadPlayground, PLAYGROUND_IDS, validateInputs } from '../src/playgrounds/load.js';
import { defaultInput, inputSchema } from '../src/playgrounds/inputs.js';
import { editedInput } from '../src/playgrounds/edits.js';
import { restoreSamples, stripSamples } from '../src/playgrounds/transport.js';
import { firstCallCode } from '../src/examples.js';
import { formatValue } from '../src/format.js';
import { siteExampleCases } from '../../tools/site-examples-smoke.js';
import { portfolio } from '../src/playgrounds/portfolio.js';
import { executeReadme } from '../../tools/readme-exec.js';
import { blackScholes } from '@insiderfinance/totalfinance/options';
import { sma } from '@insiderfinance/totalfinance/technical-analysis';
import { isNumberControl, type Chart, type PlaygroundInput } from '../src/types.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function chartValues(chart: Chart): number[] {
  switch (chart.kind) {
    case 'candles':
      return chart.bars.flatMap((bar) => [bar.open, bar.high, bar.low, bar.close]);
    case 'heatmap':
      return chart.values.flat();
    case 'histogram':
      return chart.values;
    case 'waterfall':
      return chart.steps.map((step) => step.value);
    case 'bars':
      return chart.bars.map((bar) => bar.value);
    default:
      return chart.series.flatMap((series) => series.points.map((point) => point.y));
  }
}

describe('the public-site calculation contract', () => {
  it('the public start guide executes and its displayed scalar/array outputs are accurate', async () => {
    const path = fileURLToPath(new URL('../content/start.md', import.meta.url));
    await executeReadme(path);
    const content = readFileSync(path, 'utf8');
    const price = blackScholes.price({
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      volatility: 0.2,
      riskFreeRate: 0.04,
    });
    expect(content).toContain(`About ${price.toFixed(4)} USD per share`);
    const averages = sma([100, 102, 104, 106, 108], { period: 3 });
    expect(averages).toEqual([NaN, NaN, 102, 104, 106]);
    expect(content).toContain(`[${averages.join(', ')}]`);
  });

  it('registers ten calculators, each lazily loadable by id, in reading order', async () => {
    expect(playgrounds.map((playground) => playground.id)).toEqual([
      'price-an-option',
      'analyze-a-strategy',
      'track-portfolio-pnl',
      'value-a-company',
      'backtest-a-strategy',
      'explore-scenarios',
      'chart-technical-indicators',
      'measure-risk',
      'price-a-bond',
      'fit-a-volatility-smile',
    ]);
    expect([...PLAYGROUND_IDS].sort()).toEqual(
      playgrounds.map((playground) => playground.id).sort(),
    );
    for (const playground of playgrounds)
      expect(await loadPlayground(playground.id)).toBe(playground);
    await expect(loadPlayground('missing')).rejects.toThrow(/not available/);
  });

  it.each(playgrounds.map((playground) => [playground.id, playground] as const))(
    '%s: defaults validate, run, and every display surface is finite and honest',
    (_id, playground) => {
      const input = defaultInput(playground);
      expect(validateInputs(playground, input)).toEqual(input);
      const result = playground.run(input);
      const charts = [result.chart, ...(result.additionalCharts ?? [])];
      for (const chart of charts) {
        expect(chart.title.length).toBeGreaterThan(3);
        expect(chartValues(chart).some(Number.isFinite)).toBe(true);
      }
      expect(result.assumptions).toBeTruthy();
      expect(result.diagnostics).toBeTruthy();
      for (const metric of result.metrics)
        expect(formatValue(metric.value, metric.format)).not.toMatch(/\bNaN\b|undefined|Infinity/);
      expect(firstCallCode(result)).not.toContain('Array.from');
      expect(result.example.code.split('\n').length).toBeLessThan(60);
      expect(result.code).toContain('console.log(result);');
    },
  );

  it.each(playgrounds.map((playground) => [playground.id, playground] as const))(
    '%s: the boundary refuses malformed, unknown, missing and out-of-range inputs',
    (_id, playground) => {
      const input = defaultInput(playground);
      const first = playground.controls[0]!;
      const invalid: unknown[] = [null, [], 'input', { ...input, typo: 1 }];
      const missing = { ...input };
      delete missing[first.name];
      invalid.push(missing);
      for (const control of playground.controls) {
        if (isNumberControl(control))
          invalid.push(
            { ...input, [control.name]: Infinity },
            { ...input, [control.name]: control.max + Math.abs(control.max) + 1 },
            { ...input, [control.name]: '1' },
          );
        else if (control.kind === 'select')
          invalid.push({ ...input, [control.name]: 'not-an-option' });
        else if (control.kind === 'table')
          invalid.push(
            { ...input, [control.name]: [] },
            { ...input, [control.name]: [{ ...control.value[0], extra: 1 }] },
            {
              ...input,
              [control.name]: Array.from({ length: control.maxRows + 1 }, () => control.newRow),
            },
          );
        else
          invalid.push(
            {
              ...input,
              [control.name]: {
                ...control.value,
                format: control.format === 'ohlcv' ? 'series' : 'ohlcv',
              },
            },
            { ...input, [control.name]: { ...control.value, label: '' } },
            { ...input, [control.name]: { ...control.value, origin: 'feed' } },
          );
      }
      for (const candidate of invalid)
        expect(
          () => validateInputs(playground, candidate),
          JSON.stringify(candidate)?.slice(0, 120),
        ).toThrow();
    },
  );

  it('data controls refuse impossible bars and out-of-order dates with the bar named', () => {
    const backtest = playgrounds.find((playground) => playground.id === 'backtest-a-strategy')!;
    const input = defaultInput(backtest);
    const data = input['data'] as {
      bars: { date: string; open: number; high: number; low: number; close: number }[];
    };
    const broken = (mutate: (bars: typeof data.bars) => void) => {
      const copy = structuredClone(input) as PlaygroundInput & { data: typeof data };
      mutate(copy.data.bars);
      return copy;
    };
    expect(() =>
      validateInputs(
        backtest,
        broken((bars) => (bars[3]!.high = bars[3]!.low / 2)),
      ),
    ).toThrow(/bar 4: high must be the highest/);
    expect(() =>
      validateInputs(
        backtest,
        broken((bars) => (bars[5]!.date = bars[4]!.date)),
      ),
    ).toThrow(/bar 6: dates must be strictly increasing/);
    expect(() =>
      validateInputs(
        backtest,
        broken((bars) => (bars[0]!.date = '01/02/2025')),
      ),
    ).toThrow(/bar 1: date must be an ISO calendar date/);
    expect(() =>
      validateInputs(
        backtest,
        broken((bars) => (bars[7]!.close = -1)),
      ),
    ).toThrow(/bar 8: close must be a positive/);
  });

  it('calculation-level rules explain themselves', () => {
    const run = (id: string, patch: PlaygroundInput) => {
      const playground = playgrounds.find((candidate) => candidate.id === id)!;
      return () =>
        playground.run(validateInputs(playground, { ...defaultInput(playground), ...patch }));
    };
    expect(run('value-a-company', { annualDiscountRate: 0.03, perpetualGrowthRate: 0.03 })).toThrow(
      /must exceed terminal growth/,
    );
    expect(
      run('backtest-a-strategy', { rule: 'average-crossover', fastPeriod: 50, slowPeriod: 20 }),
    ).toThrow(/fast period must be shorter/);
    expect(run('backtest-a-strategy', { fastPeriod: 20.5 })).toThrow(/whole numbers/);
    expect(
      run('analyze-a-strategy', {
        legs: [{ type: 'stock', quantity: 100, strike: 100, premium: 1 }],
      }),
    ).toThrow(/stock leg has no premium/);
    expect(
      run('analyze-a-strategy', {
        legs: [{ type: 'call', quantity: 0.5, strike: 100, premium: 1 }],
      }),
    ).toThrow(/nonzero whole number/);
    expect(
      run('fit-a-volatility-smile', {
        quotes: [
          { strike: 90, impliedVolatility: 0.2 },
          { strike: 100, impliedVolatility: 0.2 },
          { strike: 110, impliedVolatility: 0.2 },
        ],
      }),
    ).toThrow(/at least five strikes/);
    expect(run('price-a-bond', { years: 7.5 })).toThrow(/whole number/);
  });

  it('every edited example changes the first control to a different valid value', () => {
    for (const playground of playgrounds) {
      const edited = editedInput(playground);
      expect(validateInputs(playground, edited)).toEqual(edited);
      expect(JSON.stringify(edited)).not.toBe(JSON.stringify(defaultInput(playground)));
    }
  });

  it('changing a deposit changes account value, not investment profit', () => {
    const input = { quantity: 100, openingPrice: 150, closingPrice: 165, deposit: 0 };
    const without = portfolio.run(input).result as {
      pnl: { investmentReturn: number; to: { netAssetValue: number } };
    };
    const withDeposit = portfolio.run({ ...input, deposit: 5000 }).result as typeof without;
    expect(without.pnl.investmentReturn).toBeCloseTo(1500, 10);
    expect(withDeposit.pnl.investmentReturn).toBe(without.pnl.investmentReturn);
    expect(withDeposit.pnl.to.netAssetValue - without.pnl.to.netAssetValue).toBe(5000);
  });

  it('pages ship sample ids instead of sample data, and the browser restores the same controls', () => {
    for (const playground of playgrounds) {
      const stripped = stripSamples(playground.controls);
      expect(JSON.stringify(stripped).length).toBeLessThan(40_000);
      expect(restoreSamples(stripped)).toEqual(playground.controls);
    }
  });

  it('browser agent-tool schemas mirror every control', () => {
    for (const playground of playgrounds) {
      const schema = inputSchema(playground) as {
        required: string[];
        properties: Record<string, { type?: string }>;
      };
      expect(schema.required).toEqual(playground.controls.map((control) => control.name));
      for (const control of playground.controls)
        expect(schema.properties[control.name]).toBeTruthy();
    }
  });

  it.each(siteExampleCases().map((sample) => [sample.id, sample] as const))(
    '%s: the exact copied TypeScript reproduces the displayed result',
    async (_id, sample) => {
      const source = sample.code.replace(
        /console\.log\(result\);$/,
        'console.log(JSON.stringify(result));',
      );
      const bundled = await build({
        stdin: { contents: source, loader: 'ts', resolveDir: ROOT },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        target: 'es2022',
        logLevel: 'silent',
      });
      const temporary = mkdtempSync(join(tmpdir(), 'totalfinance-site-example-'));
      try {
        const path = join(temporary, 'example.mjs');
        writeFileSync(path, bundled.outputFiles[0]!.text);
        const output = execFileSync(process.execPath, [path], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(sample.expected)));
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});
