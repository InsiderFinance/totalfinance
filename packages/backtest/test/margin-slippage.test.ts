/**
 * WS1.10: the event-driven broker must (A) disclose unconstrained leverage — a warning when a fill
 * drives cash negative, and a `margin` policy label — and (B) pass the REAL intended order size to
 * the slippage model (two-pass sizing), not a hardcoded quantity of 1.
 */

import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import { brokers, type SlippageModel } from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
function bars(closes: number[], symbol = 'AAPL'): Bar[] {
  return closes.map((c, i) => ({
    symbol,
    timestampMs: t0 + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

describe('unconstrained leverage disclosure (WS1.10 A)', () => {
  it('a fill that overspends cash emits backtest.negative_cash and labels margin unconstrained', () => {
    const res = backtest.eventDriven({
      data: bars([100, 100, 100, 100]),
      broker: brokers.simulated({ cash: 1000 }), // default maxLeverage = Infinity
      strategy(context) {
        let bought = false;
        context.onBar('AAPL', () => {
          if (!bought) {
            context.buy('AAPL', { quantity: 100 }); // 100 × $100 = $10k ≫ $1k cash
            bought = true;
          }
        });
      },
    });
    expect(res.assumptions.margin).toBe('unconstrained');
    const w = res.diagnostics.warnings.find((x) => x.code === 'backtest.negative_cash');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('warn');
    expect(w!.context!['lowWaterCash'] as number).toBeLessThan(0);
  });

  it('a leverage-capped run labels margin as maxLeverage', () => {
    const res = backtest.eventDriven({
      data: bars([100, 100, 100]),
      broker: brokers.simulated({ cash: 100_000, maxLeverage: 2 }),
      strategy(context) {
        context.onBar('AAPL', () => {});
      },
    });
    expect(res.assumptions.margin).toBe('maxLeverage');
    expect(res.diagnostics.warnings.some((w) => w.code === 'backtest.negative_cash')).toBe(false);
  });
});

describe('slippage sees the real order size (WS1.10 B)', () => {
  function spyBroker(): { spy: SlippageModel; seen: number[] } {
    const seen: number[] = [];
    const spy: SlippageModel = {
      label: 'spy',
      fill({ referencePrice, quantity }) {
        seen.push(quantity);
        return referencePrice;
      },
    };
    return { spy, seen };
  }

  it('a share-sized order is passed to the slippage model at its real quantity', () => {
    const { spy, seen } = spyBroker();
    backtest.eventDriven({
      data: bars([100, 100, 100]),
      broker: brokers.simulated({ cash: 1_000_000, slippage: spy }),
      strategy(context) {
        let done = false;
        context.onBar('AAPL', () => {
          if (!done) {
            context.buy('AAPL', { quantity: 37 });
            done = true;
          }
        });
      },
    });
    expect(seen.some((q) => Math.abs(q - 37) < 1e-9)).toBe(true); // was always 1 before the fix
  });

  it('a notional order estimates size at the reference price (not qty=1)', () => {
    const { spy, seen } = spyBroker();
    backtest.eventDriven({
      data: bars([100, 100, 100]),
      broker: brokers.simulated({ cash: 1_000_000, slippage: spy }),
      strategy(context) {
        let done = false;
        context.onBar('AAPL', () => {
          if (!done) {
            context.buy('AAPL', { value: 3700 }); // $3,700 / $100 ≈ 37 shares
            done = true;
          }
        });
      },
    });
    expect(seen.some((q) => Math.abs(q - 37) < 1e-6)).toBe(true);
  });
});
