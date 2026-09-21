/**
 * Zero-dependency payoff SVG rendering (`payoffSvg`). Verifies the output is a well-formed,
 * self-contained SVG (no scripts / external refs), that it carries the payoff annotations (breakevens,
 * max P&L, spot, title), honors dimensions + custom range, draws the current-P&L curve when a market is
 * given, and the guards (no market → throw, multi-expiry → throw), and is deterministic.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { legs, payoffSvg, strategy } from '@totalfinance/strategy';

const EXPIRY = '2026-06-19';
const longCall = () =>
  strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })], { expiry: EXPIRY });
const bullCallSpread = () =>
  strategy(
    [
      legs.call({ strike: 100, premium: 5, quantity: 1 }),
      legs.call({ strike: 110, premium: 2, quantity: -1 }),
    ],
    { expiry: EXPIRY },
  );

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('payoffSvg — well-formed & self-contained', () => {
  it('emits a single <svg> with no scripts or external resource refs', () => {
    const svg = payoffSvg(bullCallSpread());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\shref=/i); // no external/link refs
    expect(svg).not.toMatch(/<image/i);
    expect(svg).not.toMatch(/url\(http/i);
    // profit + loss shading and the curve are all present.
    expect(svg).toContain('#16a34a'); // profit green
    expect(svg).toContain('#dc2626'); // loss red
    expect(svg).toContain('clip-path');
  });

  it('is deterministic (same input → identical string)', () => {
    expect(payoffSvg(bullCallSpread())).toBe(payoffSvg(bullCallSpread()));
  });
});

describe('payoffSvg — annotations', () => {
  it('a long call shows its breakeven (strike + premium) and unbounded max profit', () => {
    const svg = payoffSvg(longCall());
    expect(svg).toContain('105'); // breakeven = 100 + 5
    expect(svg).toContain('max unbounded'); // max profit is unbounded — the word, never ∞ (B3)
  });

  it('draws the spot marker and an XML-escaped title', () => {
    const svg = payoffSvg(bullCallSpread(), { spot: 103, title: 'P&L <A>' });
    expect(svg).toContain('spot 103');
    expect(svg).toContain('P&amp;L &lt;A&gt;'); // escaped
  });
});

describe('payoffSvg — dimensions & range', () => {
  it('honors width/height and a custom price range', () => {
    const svg = payoffSvg(bullCallSpread(), {
      width: 800,
      height: 400,
      prices: { from: 80, to: 130, steps: 60 },
    });
    expect(svg).toContain('viewBox="0 0 800 400"');
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="400"');
    expect(svg).toContain('80'); // x-axis min label
    expect(svg).toContain('130'); // x-axis max label
  });

  it('auto-ranges around the strikes when prices are omitted', () => {
    const svg = payoffSvg(bullCallSpread()); // strikes 100/110
    // Default 640×360 and a valid render.
    expect(svg).toContain('viewBox="0 0 640 360"');
    expect(svg.length).toBeGreaterThan(500);
  });
});

describe('payoffSvg — current-P&L curve', () => {
  it('draws the dashed current curve + legend when a market is supplied', () => {
    const svg = payoffSvg(longCall(), {
      includeCurrentPnl: true,
      market: { volatility: 0.2, riskFreeRate: 0.03, asOf: '2026-05-01T00:00:00Z' },
    });
    expect(svg).toContain('#2563eb'); // expiry curve
    expect(svg).toContain('#7c3aed'); // current curve
    expect(svg).toContain('current'); // legend
  });
});

describe('payoffSvg — envelope & guards', () => {
  it('throws on garbage, a market-less current curve, and a multi-expiry position', () => {
    expect(() => payoffSvg(undefined as never)).toThrowError();
    expect(() => payoffSvg({ legs: [] } as never)).toThrowError();
    // includeCurrentPnl with no market anywhere → teaching error.
    expect(() => payoffSvg(longCall(), { includeCurrentPnl: true })).toThrowError();
    // A calendar (two expiries) can't have a single expiration payoff.
    const calendar = strategy([
      { kind: 'call', strike: 100, quantity: 1, premium: 2, expiry: '2026-06-19' },
      { kind: 'call', strike: 100, quantity: -1, premium: 1, expiry: '2026-07-17' },
    ]);
    try {
      payoffSvg(calendar);
      expect.unreachable('a multi-expiry position should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
  });

  it('rejects dimensions too small for the axes (no negative-size rects)', () => {
    expect(() => payoffSvg(bullCallSpread(), { width: 70 })).toThrowError(/width|height/);
    expect(() => payoffSvg(bullCallSpread(), { height: 80 })).toThrowError(/width|height/);
    // A compact-but-viable size still renders.
    expect(payoffSvg(bullCallSpread(), { width: 200, height: 150 })).toContain('<svg');
  });

  it('closes and type-checks rendering options before applying defaults', () => {
    const position = bullCallSpread();
    const unknown = caught(() => payoffSvg(position, { widht: 640 } as never));
    expect(isQuantError(unknown, 'input.unknown_field')).toBe(true);

    for (const options of [
      { height: null },
      { includeCurrentPnl: 'yes' },
      { spot: '100' },
      { title: 42 },
      { theme: 'sepia' },
    ]) {
      expect(isQuantError(caught(() => payoffSvg(position, options as never)))).toBe(true);
    }

    const nestedUnknown = caught(() =>
      payoffSvg(position, { prices: { from: 80, to: 120, steps: 21, step: 1 } } as never),
    );
    expect(isQuantError(nestedUnknown, 'input.unknown_field')).toBe(true);
    const marketUnknown = caught(() =>
      payoffSvg(position, { market: { riskFreeRate: 0.04, rate: 0.04 } } as never),
    );
    expect(isQuantError(marketUnknown, 'input.unknown_field')).toBe(true);
  });

  it('validates supplied market dates even when current-P&L rendering is disabled', () => {
    for (const expiry of ['not-a-date', '2025-02-30', '2026-06-19T16:00:00']) {
      const error = caught(() => payoffSvg(bullCallSpread(), { market: { expiry } }));
      expect(isQuantError(error), expiry).toBe(true);
      expect(String((error as Error).message), expiry).toContain('market.expiry');
    }
    expect(payoffSvg(bullCallSpread(), { market: { expiry: '2026-06-19' } })).toContain('<svg');
  });

  it('rejects XML-forbidden title characters but preserves valid Unicode', () => {
    for (const title of ['bad\u0000title', 'bad\u000btitle', `bad${String.fromCharCode(0xd800)}`]) {
      const error = caught(() => payoffSvg(bullCallSpread(), { title }));
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect(String((error as Error).message)).toContain('XML 1.0');
    }
    expect(payoffSvg(bullCallSpread(), { title: 'Risk 📈 & reward' })).toContain('Risk 📈');
  });
});
