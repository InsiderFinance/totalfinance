/**
 * Every missing-field example must CORRECT THE CALL THAT FAILED.
 *
 * `missingFieldError` promises a working example, and RV2 made those examples runnable calls. It did
 * not make them the RIGHT calls: examples were declared once per FILE, and several files host more
 * than one boundary. The result was authoritative-sounding misdirection —
 *
 *     touchProbability: barrier is required.
 *       e.g. terminalCdf({ spot, strike, drift, volatility, timeToExpiryYears })
 *
 * — a different function, without the field the caller was missing. An example that sends the reader
 * somewhere else is worse than no example: it reads as the answer.
 *
 * Two properties, checked at RUNTIME on the errors these boundaries actually throw:
 *
 *   1. the example invokes the API that threw — compared on the parsed callee, not by substring, and
 *   2. the example contains the field that was reported missing.
 *
 * SCOPE IS NOT THIS FILE'S JOB, and RV5 wrongly claimed it was: the closing assertion here compared
 * the pairs exercised against the length of the registry below, which is the same number counted
 * twice. A boundary added to the library and not to this list left both sides equal and the suite
 * green — while eleven boundaries were recommending a different API. Coverage now comes from
 * `tools/manifest/example-call-inventory.test.ts`, which reads every `requireFiniteFields` site out
 * of the source, so it cannot fall behind the code. What remains here is the runtime half: proof
 * that the messages these APIs really emit carry the right example.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { blackScholesPrice, blackScholes } from '@totalfinance/options/black-scholes';
import { black76Price, black76ImpliedVolatility } from '@totalfinance/options/black76';
import { bachelierPrice, bachelierImpliedVolatility } from '@totalfinance/options/bachelier';
import { blackScholesImpliedVolatility } from '@totalfinance/options/black-scholes';
import { sviTotalVariance, sviG } from '@totalfinance/volatility/svi';
import { ssviSliceW } from '@totalfinance/volatility/ssvi';
import {
  terminalCdf,
  expectedIntrinsic,
  touchProbability,
} from '@totalfinance/strategy/probability';
import { fees, slippage } from '@totalfinance/backtest';
import { bar } from '@totalfinance/technical-analysis';

/** The function expression an example invokes — the last callee at paren depth zero. */
function calleeOf(example: string): string | null {
  let depth = 0;
  let last: string | null = null;
  let token = '';
  for (const ch of example) {
    if (ch === '(') {
      if (depth === 0 && token.trim().length > 0) last = token.trim();
      depth += 1;
      token = '';
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      token = '';
      continue;
    }
    if (depth > 0) continue;
    if (/[\w$.]/.test(ch)) token += ch;
    else token = '';
  }
  return last;
}

const finalSegment = (name: string): string => name.split('.').pop() ?? name;

interface Boundary {
  /** The name the error reports. The example must invoke THIS, not a look-alike. */
  readonly names: readonly string[];
  /** Invoke the boundary with `field` removed. */
  readonly invoke: (field: string) => unknown;
  /** Required fields whose omission must produce a correcting example. */
  readonly fields: readonly string[];
}

const without = <T extends object>(base: T, field: string): T => {
  const copy = { ...(base as Record<string, unknown>) };
  delete copy[field];
  return copy as T;
};

const BSM = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  dividendYield: 0,
  volatility: 0.2,
} as const;
const B76 = {
  type: 'call',
  forward: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
} as const;
/** Bachelier takes `normalVolatility`, NOT `volatility` — spreading B76 would trip Law 12 first. */
const BACH = {
  type: 'call',
  forward: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  normalVolatility: 20,
} as const;

/** A solver SOLVES for volatility, so passing it is an unknown key, not a valid baseline. */
const BSM_IV = {
  type: 'call',
  price: 2.4,
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  dividendYield: 0,
} as const;
const SVI = { a: 0.04, b: 0.4, rho: -0.3, m: 0, sigma: 0.1 } as const;
const TERMINAL = {
  spot: 100,
  strike: 105,
  drift: 0.04,
  volatility: 0.2,
  timeToExpiryYears: 0.25,
} as const;
const TOUCH = {
  spot: 100,
  barrier: 110,
  drift: 0.04,
  volatility: 0.2,
  timeToExpiryYears: 0.25,
} as const;

const BOUNDARIES: readonly Boundary[] = [
  {
    names: ['blackScholesPrice'],
    invoke: (f) => blackScholesPrice(without(BSM, f) as never),
    fields: ['spot', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'dividendYield', 'volatility'],
  },
  {
    names: ['blackScholes.price'],
    invoke: (f) => blackScholes.price(without(BSM, f) as never),
    fields: ['spot', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'volatility'],
  },
  {
    names: ['blackScholesImpliedVolatility'],
    invoke: (f) => blackScholesImpliedVolatility(without(BSM_IV, f) as never),
    fields: ['price', 'spot', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'dividendYield'],
  },
  {
    names: ['black76Price'],
    invoke: (f) => black76Price(without(B76, f) as never),
    fields: ['forward', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'volatility'],
  },
  {
    names: ['black76ImpliedVolatility'],
    invoke: (f) =>
      black76ImpliedVolatility(
        without(
          {
            type: 'call',
            price: 2.4,
            forward: 100,
            strike: 105,
            timeToExpiryYears: 0.25,
            riskFreeRate: 0.04,
          },
          f,
        ) as never,
      ),
    fields: ['price', 'forward', 'strike', 'timeToExpiryYears', 'riskFreeRate'],
  },
  {
    names: ['bachelierPrice'],
    invoke: (f) => bachelierPrice(without(BACH, f) as never),
    fields: ['forward', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'normalVolatility'],
  },
  {
    names: ['bachelierImpliedVolatility'],
    invoke: (f) =>
      bachelierImpliedVolatility(
        without(
          {
            type: 'call',
            price: 8,
            forward: 100,
            strike: 105,
            timeToExpiryYears: 0.25,
            riskFreeRate: 0.04,
          },
          f,
        ) as never,
      ),
    fields: ['price', 'forward', 'strike', 'timeToExpiryYears', 'riskFreeRate'],
  },
  {
    names: ['sviTotalVariance'],
    invoke: (f) => sviTotalVariance(without(SVI, f) as never, 0),
    fields: ['a', 'b', 'rho', 'm', 'sigma'],
  },
  {
    names: ['sviG'],
    invoke: (f) => sviG(without(SVI, f) as never, 0),
    fields: ['a', 'b', 'rho', 'm', 'sigma'],
  },
  {
    names: ['ssviSliceW'],
    invoke: (f) => ssviSliceW(without({ k: 0, theta: 0.04, rho: -0.3, psi: 1 }, f) as never),
    fields: ['k', 'theta', 'rho', 'psi'],
  },
  {
    names: ['terminalCdf'],
    invoke: (f) => terminalCdf(without(TERMINAL, f) as never),
    fields: ['spot', 'strike', 'drift', 'volatility', 'timeToExpiryYears'],
  },
  {
    names: ['expectedIntrinsic'],
    invoke: (f) => expectedIntrinsic(without({ ...TERMINAL, type: 'call' }, f) as never),
    fields: ['spot', 'strike', 'drift', 'volatility', 'timeToExpiryYears'],
  },
  {
    names: ['touchProbability'],
    invoke: (f) => touchProbability(without(TOUCH, f) as never),
    fields: ['spot', 'barrier', 'drift', 'volatility', 'timeToExpiryYears'],
  },
  {
    names: ['fees.bps.commission'],
    invoke: (f) => fees.bps(1).commission(without({ quantity: 100, price: 42.15 }, f) as never),
    fields: ['quantity', 'price'],
  },
  {
    names: ['slippage.bps.fill'],
    invoke: (f) =>
      slippage
        .bps(1)
        .fill(without({ referencePrice: 42.15, side: 'buy', quantity: 100 }, f) as never),
    fields: ['referencePrice'],
  },
  {
    names: ['bar.typical'],
    invoke: (f) => bar.typical(without({ high: 101.5, low: 99.5, close: 100.8 }, f) as never),
    fields: ['high', 'low', 'close'],
  },
];

/** The `e.g.` line of a missing-field error, or `null` if the call did not throw one. */
function exampleFor(invoke: () => unknown): { example: string; reported: string } | null {
  try {
    invoke();
    return null;
  } catch (error) {
    if (!isQuantError(error) || error.code !== 'input.missing_field') return null;
    const message = (error as Error).message;
    const example = message.split('e.g. ')[1]?.split('\n')[0];
    const reported = message.split(':')[0] ?? '';
    return example === undefined ? null : { example, reported };
  }
}

describe('a missing-field example corrects the call that failed', () => {
  const offenders: string[] = [];
  const covered: string[] = [];

  for (const { names, invoke, fields } of BOUNDARIES) {
    for (const field of fields) {
      const found = exampleFor(() => invoke(field));
      if (found === null) {
        offenders.push(`${names[0]} omitting ${field}: no missing_field error`);
        continue;
      }
      covered.push(`${names[0]}.${field}`);
      /**
       * EXACT callee, not substring membership. The old rule accepted any listed name appearing
       * anywhere in the text, which is how `sviG` was allowed to recommend `sviTotalVariance` — the
       * string `sviG` does not even occur in that example, but a second "alias" entry did.
       */
      const callee = calleeOf(found.example);
      const wanted = names.map(finalSegment);
      if (callee === null || !wanted.includes(finalSegment(callee)))
        offenders.push(
          `${found.reported} omitting ${field}: example invokes ${callee ?? '(nothing)'}, ` +
            `expected one of [${wanted.join(', ')}] — ${found.example}`,
        );
      // The whole point: the example must show the field the caller is missing.
      if (!found.example.includes(`${field}:`))
        offenders.push(
          `${found.reported} omitting ${field}: example omits that very field — ${found.example}`,
        );
    }
  }

  it('every example names the API that threw and contains the omitted field', () => {
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * NOT a coverage claim — a liveness one. It only asserts every pair listed here still throws
   * `missing_field`, so a boundary that stops validating is noticed. Whether the LIST is complete is
   * settled by the source-derived inventory, because nothing self-referential can settle it.
   */
  it('every registered boundary still emits a missing-field error', () => {
    const expected = BOUNDARIES.reduce((sum, b) => sum + b.fields.length, 0);
    expect(covered.length, 'a boundary stopped producing missing_field errors').toBe(expected);
  });
});
