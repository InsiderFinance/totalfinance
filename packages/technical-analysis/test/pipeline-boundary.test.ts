/**
 * The fluent pipeline is a public boundary, and a review found it was not treated as one.
 *
 * Four separate ways to get a wrong answer quietly:
 *
 *   RAW TypeErrors      `features(bars).rsi('close')` threw `Cannot read properties of undefined
 *                       (reading 'period')` — from the pipeline, not from `rsi` — because the
 *                       auto-name was built before the indicator was called. For `rsi` and `atr`
 *                       that made the fluent form STRICTER than the direct one, which defaults to 14.
 *   AN IGNORED KEY      `{ az: 'fast' }` was dropped, so the column landed under its auto-name and
 *                       the caller's later lookup of `fast` found nothing.
 *   AN EMPTY ALIAS      `{ as: '' }` produced a column keyed by the empty string.
 *   `undefined`         `applySeries(..., { az: 'x' })` created a column literally named "undefined".
 *
 * Plus a naming leak: the generated column base for `rollingVolatility` was `vol_`, and `vol` is
 * forbidden across this library precisely because it reads as volatility here and VOLUME two modules
 * over. A generated column name is public text; the naming gate walks declared identities and cannot
 * see a runtime string, so it needs its own check — the last test here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { isQuantError } from '@totalfinance/core';
import { features } from '@totalfinance/technical-analysis/pipeline';
import { signal } from '@totalfinance/technical-analysis/signal';
import { rollingVolatility } from '@totalfinance/technical-analysis';
import type { BarInput } from '@totalfinance/technical-analysis';
import { FORBIDDEN_TOKENS } from '../../../tools/manifest/naming-policy.js';

const bars: BarInput[] = Array.from({ length: 60 }, (_, i) => {
  const close = 100 + Math.sin(i / 4) * 5 + i * 0.2;
  return { open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000 + i };
});

describe('default-bearing methods accept omission, exactly like the direct call', () => {
  it('rsi() with no parameters defaults to 14 and names the column so', () => {
    const columns = features(bars).rsi('close').toColumns();
    expect(Object.keys(columns)).toEqual(['rsi_close_14']);
  });

  it('atr() with no parameters defaults to 14', () => {
    const columns = features(bars).atr().toColumns();
    expect(Object.keys(columns)).toEqual(['atr_14']);
  });

  it('macd() with no parameters still works', () => {
    expect(Object.keys(features(bars).macd('close').toColumns())).toEqual(['macd_close']);
  });

  it('bbands() with no parameters defaults to 20', () => {
    expect(Object.keys(features(bars).bbands('close').toColumns())).toEqual(['bbands_close_20']);
  });
});

describe('non-defaulted methods delegate to the indicator that owns the parameter', () => {
  for (const call of [
    ['sma', () => features(bars).sma('close', undefined as never)],
    ['ema', () => features(bars).ema('close', undefined as never)],
    ['wma', () => features(bars).wma('close', undefined as never)],
    ['rollingVolatility', () => features(bars).rollingVolatility('close', undefined as never)],
  ] as const) {
    it(`${call[0]}: a missing parameter object throws the typed teaching error, not a TypeError`, () => {
      let caught: unknown;
      try {
        call[1]();
      } catch (error) {
        caught = error;
      }
      expect(caught, `${call[0]} threw nothing`).toBeDefined();
      expect(
        isQuantError(caught),
        `${call[0]} escaped a raw ${(caught as Error)?.constructor?.name}`,
      ).toBe(true);
    });
  }

  it('the message is the indicator’s own, naming the field the caller must supply', () => {
    try {
      features(bars).sma('close', undefined as never);
    } catch (error) {
      expect((error as Error).message).toMatch(/period/);
    }
  });
});

describe('the alias option is a closed request', () => {
  it('a near-miss key teaches instead of being ignored', () => {
    let caught: unknown;
    try {
      features(bars).rsi('close', { period: 14 }, { az: 'fast' } as never);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.unknown_field')).toBe(true);
    expect((caught as Error).message).toMatch(/did you mean "as"/);
  });

  it('an empty alias is refused rather than creating a column named ""', () => {
    let caught: unknown;
    try {
      features(bars).rsi('close', { period: 14 }, { as: '' });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
  });

  it('a valid alias still works', () => {
    const columns = features(bars).rsi('close', { period: 14 }, { as: 'fast' }).toColumns();
    expect(Object.keys(columns)).toEqual(['fast']);
  });

  it('applySeries: a misspelled alias key no longer yields a column called "undefined"', () => {
    let caught: unknown;
    try {
      features(bars).applySeries('close', rollingVolatility, { period: 5, annualization: 252 }, {
        az: 'v',
      } as never as { as: string });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
  });

  it('applySeries: omitting the alias entirely is refused (it has no name to generate)', () => {
    expect(() =>
      features(bars).applySeries(
        'close',
        rollingVolatility,
        { period: 5, annualization: 252 },
        {} as { as: string },
      ),
    ).toThrowError(/options\.as is required/);
  });

  it('column(): an empty alias is refused', () => {
    expect(() => features(bars).column('', [])).toThrowError(/non-empty/);
  });
});

/**
 * Every auto-generated column base, read out of the source.
 *
 * `public-naming.json` walks declared identities; a column name is a runtime string assembled from a
 * template, so nothing in that inventory could ever see it. Reading the templates means a convenience
 * method added later is covered without anyone remembering the rule.
 */
function columnBases(): { name: string; line: number }[] {
  const path = fileURLToPath(new URL('../src/pipeline.ts', import.meta.url));
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const bases: { name: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    // this.put(alias, <base>, values) — the second argument is the auto-generated name
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'put'
    ) {
      const base = node.arguments[1];
      if (base !== undefined) {
        const text = ts.isTemplateExpression(base)
          ? base.head.text
          : ts.isStringLiteralLike(base)
            ? base.text
            : '';
        if (text !== '')
          bases.push({
            name: text,
            line: source.getLineAndCharacterOfPosition(base.getStart(source)).line + 1,
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bases;
}

/**
 * `SignalBuilder` delegates every feature method to `FeaturePipeline`, so it inherits the column
 * names and the validation for free — but its SIGNATURES are its own, and they were left behind when
 * the pipeline's default-bearing methods were relaxed. The two fluent surfaces have to agree, or the
 * same call compiles through one and not the other.
 */
describe('the signal DSL is the same boundary as the pipeline', () => {
  it('inherits the snake_case column names', () => {
    const built = signal(bars).rsi('close', { period: 14 }).columns();
    expect(Object.keys(built)).toEqual(['rsi_close_14']);
  });

  it('accepts omission on the default-bearing methods, exactly as the pipeline does', () => {
    expect(Object.keys(signal(bars).rsi('close').columns())).toEqual(['rsi_close_14']);
    expect(Object.keys(signal(bars).atr().columns())).toEqual(['atr_14']);
  });

  it('inherits the closed alias option', () => {
    let caught: unknown;
    try {
      signal(bars).rsi('close', { period: 14 }, { az: 'fast' } as never);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught, 'input.unknown_field')).toBe(true);
  });

  it('inherits the delegated teaching error on a non-defaulted method', () => {
    let caught: unknown;
    try {
      signal(bars).sma('close', undefined as never);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
  });
});

describe('generated column names obey the naming policy', () => {
  it('rollingVolatility is snake_case, and not `vol`', () => {
    const columns = features(bars)
      .rollingVolatility('close', { period: 5, annualization: 1 })
      .toColumns();
    expect(Object.keys(columns)).toEqual(['rolling_volatility_close_5']);
  });

  it('the template scan finds the column bases at all', () => {
    // Without this, deleting the walk would make both gates below pass vacuously.
    expect(columnBases().length).toBeGreaterThan(8);
  });

  it('no auto-generated column base uses a forbidden token', () => {
    const offenders = columnBases()
      .flatMap(({ name, line }) =>
        name
          .split('_')
          .filter((segment) => segment !== '' && Object.hasOwn(FORBIDDEN_TOKENS, segment))
          .map(
            (segment) =>
              `pipeline.ts:${line} column base "${name}" uses forbidden token "${segment}"`,
          ),
      )
      .sort();
    expect(
      offenders,
      `a generated column name is public text a caller reads and types:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The durable half of the `vol_` fix.
   *
   * A column is DATA, not an identifier: it lands in a DataFrame, a parquet file, or a warehouse
   * table, where Postgres folds an unquoted identifier to lowercase and Snowflake folds it to
   * uppercase. One convention across the whole string is what keeps it portable, and snake_case is
   * where every peer library emitting feature columns settled.
   *
   * 229 of this package's function exports are camelCase, so it is not hypothetical: the moment
   * `stochRsi` or `bollingerPercentB` joins the fluent surface, writing the export name straight into the
   * template reintroduces `stochRsi_close_14`.
   */
  it('every auto-generated column base is snake_case', () => {
    const wrong = columnBases()
      .filter(({ name }) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*_?$/.test(name))
      .map(
        ({ name, line }) =>
          `pipeline.ts:${line} column base "${name}" is not snake_case — a column name is data, ` +
          `and warehouse identifier folding is not on our side`,
      );
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
