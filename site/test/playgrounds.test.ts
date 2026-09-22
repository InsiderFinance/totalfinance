import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playgrounds } from '../src/playgrounds/index.js';
import { loadPlayground, validateInputs } from '../src/playgrounds/load.js';
import { escapeHtml, renderCalculation, renderChart, renderExamples } from '../src/render.js';
import { firstCallCode } from '../src/examples.js';
import { siteExampleCases } from '../../tools/site-examples-smoke.js';
import { portfolio } from '../src/playgrounds/portfolio.js';
import { search } from '../src/search.js';
import { executeReadme } from '../../tools/readme-exec.js';
import { blackScholes } from '@insiderfinance/totalfinance/options';
import { sma } from '@insiderfinance/totalfinance/technical-analysis';

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

  it('separates useful first calls, their actual outputs and complete reproduction without hidden setup', () => {
    for (const playground of playgrounds) {
      const calculation = playground.run(
        Object.fromEntries(playground.controls.map((control) => [control.name, control.value])),
      );
      const html = renderExamples(calculation);
      expect(html).toContain(escapeHtml(calculation.example.code));
      expect(html).toContain(escapeHtml(JSON.stringify(calculation.example.result, null, 2)));
      expect(html).toContain('<details><summary>Reproduce this entire playground</summary>');
      expect(html).toContain(escapeHtml(calculation.code));
      expect(firstCallCode(calculation)).not.toContain('Array.from');
      expect(calculation.example.code.split('\n').length).toBeLessThan(60);
      if (calculation.example.setup) {
        expect(html).toContain('data-copy-prefix="sample-setup"');
        expect(firstCallCode(calculation)).toBe(
          `${calculation.example.setup.code}\n\n${calculation.example.code}`,
        );
        expect(html).toContain(escapeHtml(calculation.example.setup.preview));
      }
    }
  });

  it('covers every real calculator and refuses malformed/unknown/over-budget inputs', async () => {
    expect(playgrounds.map((playground) => playground.id)).toEqual([
      'price-an-option',
      'analyze-a-strategy',
      'track-portfolio-pnl',
      'value-a-company',
      'backtest-a-strategy',
      'explore-scenarios',
    ]);
    for (const playground of playgrounds) {
      expect(await loadPlayground(playground.id)).toBe(playground);
      const input = Object.fromEntries(
        playground.controls.map((control) => [control.name, control.value]),
      );
      expect(validateInputs(playground, input)).toEqual(input);
      for (const invalid of [
        null,
        [],
        {},
        { ...input, typo: 1 },
        { ...input, [playground.controls[0]!.name]: Infinity },
        { ...input, [playground.controls[0]!.name]: playground.controls[0]!.max + 1 },
      ])
        expect(() => validateInputs(playground, invalid)).toThrow();
      const result = playground.run(input);
      expect(result.chart.series.length).toBeGreaterThan(0);
      expect(result.assumptions).toBeTruthy();
      expect(result.diagnostics).toBeTruthy();
      expect(renderCalculation(result)).not.toMatch(/\bNaN\b|\bundefined\b/);
    }
    await expect(loadPlayground('missing')).rejects.toThrow();
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

  it.each(siteExampleCases())(
    '$id: the exact copied TypeScript reproduces the displayed result',
    async (sample) => {
      const source = sample.code.replace(
        /console\.log\(result\);$/,
        'console.log(JSON.stringify(result));',
      );
      const bundled = await build({
        stdin: {
          contents: source,
          loader: 'ts',
          resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
        },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        target: 'es2022',
      });
      const temporary = mkdtempSync(join(tmpdir(), 'totalfinance-site-example-'));
      try {
        const path = join(temporary, 'example.mjs');
        writeFileSync(path, bundled.outputFiles[0]!.text);
        const output = execFileSync(process.execPath, [path], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(sample.expected)));
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it('escapes source text and handles flat or unavailable chart ranges', () => {
    expect(escapeHtml('<script>"&')).toBe('&lt;script&gt;&quot;&amp;');
    expect(
      renderChart({
        title: '<unsafe>',
        xLabel: 'x',
        yLabel: 'y',
        series: [
          {
            name: 'flat',
            points: [
              { x: 1, y: 0 },
              { x: 1, y: 0 },
            ],
          },
        ],
      }),
    ).not.toContain('NaN');
    expect(renderChart({ title: 'empty', xLabel: 'x', yLabel: 'y', series: [] })).toContain(
      'No finite chart values',
    );
  });

  it('search is deterministic, bounded, case-insensitive, and all-term matched', () => {
    const records = [
      {
        title: 'blackScholesPrice',
        url: '/price/',
        description: 'European option',
        category: 'options',
        keywords: 'volatility',
      },
      {
        title: 'portfolioPnl',
        url: '/pnl/',
        description: 'Investment profit',
        category: 'portfolio',
        keywords: 'ledger',
      },
    ];
    expect(search(records, 'BLACKSCHOLES european').map((row) => row.url)).toEqual(['/price/']);
    expect(search(records, 'portfolio european')).toEqual([]);
    expect(search(records, '')).toEqual([]);
    expect(search(records, 'p', 1)).toHaveLength(1);
  });
});
