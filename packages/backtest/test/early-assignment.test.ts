import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import { SimulatedBroker } from '@totalfinance/backtest';

const EXPIRY = Date.UTC(2026, 5, 19);
const t = (d: number): number => Date.UTC(2026, 0, d);
const bar = (symbol: string, ts: number, price: number): Bar => ({
  symbol,
  timestampMs: ts,
  open: price,
  high: price,
  low: price,
  close: price,
});

/** Enter a covered call: long 100 XYZ + short 1 XYZ call at `strike`, filled on the first bar. */
function enterCoveredCall(
  broker: SimulatedBroker,
  callSym: string,
  strike: number,
  callMark: number,
): void {
  broker.registerOption(callSym, {
    underlying: 'XYZ',
    type: 'call',
    strike,
    expiresAt: EXPIRY,
    style: 'american',
  });
  broker.submit({ symbol: 'XYZ', side: 'buy', quantity: 100, type: 'market' });
  broker.submit({ symbol: callSym, side: 'sell', quantity: 1, type: 'market' });
  broker.processBar(bar('XYZ', t(1), 100));
  broker.processBar(bar(callSym, t(1), callMark));
}

describe('WS7.4 ex-dividend short-call early assignment', () => {
  it('a covered call is assigned the day the ex-div is known (loses the dividend)', () => {
    const broker = new SimulatedBroker({ cash: 100_000, assignment: 'model' });
    enterCoveredCall(broker, 'C90', 90, 10.05); // deep ITM, tiny extrinsic (0.05)
    expect(broker.position('XYZ').quantity).toBe(100);
    expect(broker.position('C90').quantity).toBe(-1);

    // Ex-dividend of 0.50 > remaining extrinsic 0.05 ⇒ the short call is assigned.
    broker.processBar(bar('XYZ', t(2), 100), { dividend: 0.5 });

    expect(broker.settlements).toHaveLength(1);
    const s = broker.settlements[0]!;
    expect(s).toMatchObject({
      symbol: 'C90',
      action: 'assigned',
      early: true,
      reason: 'dividend',
      contracts: -1,
    });
    expect(broker.position('XYZ').quantity).toBe(0); // stock called away at strike
    expect(broker.warnings.some((w) => w.code === 'backtest.assignment')).toBe(true);
    // Cash: entry 91005, then +100·90 from the assignment; the dividend is NOT collected (flat stock).
    expect(broker.cash).toBeCloseTo(100_005, 6);
  });

  it("assignment: 'none' (default) never assigns early and collects the dividend — goldens preserved", () => {
    const broker = new SimulatedBroker({ cash: 100_000 }); // default assignment: 'none'
    enterCoveredCall(broker, 'C90', 90, 10.05);
    broker.processBar(bar('XYZ', t(2), 100), { dividend: 0.5 });
    expect(broker.settlements).toHaveLength(0);
    expect(broker.position('XYZ').quantity).toBe(100); // still held
    // Entry 91005 + dividend 100·0.50 = 91055.
    expect(broker.cash).toBeCloseTo(91_055, 6);
  });

  it('a European call is never assigned early, even under the model', () => {
    const broker = new SimulatedBroker({ cash: 100_000, assignment: 'model' });
    broker.registerOption('C90E', {
      underlying: 'XYZ',
      type: 'call',
      strike: 90,
      expiresAt: EXPIRY,
      style: 'european',
    });
    broker.submit({ symbol: 'XYZ', side: 'buy', quantity: 100, type: 'market' });
    broker.submit({ symbol: 'C90E', side: 'sell', quantity: 1, type: 'market' });
    broker.processBar(bar('XYZ', t(1), 100));
    broker.processBar(bar('C90E', t(1), 10.05));
    broker.processBar(bar('XYZ', t(2), 100), { dividend: 0.5 });
    expect(broker.settlements).toHaveLength(0);
    expect(broker.position('XYZ').quantity).toBe(100);
  });
});

describe('WS7.4 deep-ITM short-put early assignment (carry economics)', () => {
  // Underlier 80, strike-100 put ⇒ intrinsic 20; the carry benefit is interest on the strike over the
  // ~0.46y to EXPIRY. Early exercise is worthwhile when that carry exceeds the remaining extrinsic.
  const registerShortPut = (broker: SimulatedBroker): void => {
    broker.registerOption('P100', {
      underlying: 'XYZ',
      type: 'put',
      strike: 100,
      expiresAt: EXPIRY,
      style: 'american',
    });
    broker.submit({ symbol: 'P100', side: 'sell', quantity: 1, type: 'market' });
    broker.processBar(bar('XYZ', t(1), 80)); // underlier mark ⇒ intrinsic 20
  };

  it('assigns a deep-ITM short put when the carry benefit exceeds the remaining extrinsic', () => {
    const broker = new SimulatedBroker({ cash: 100_000, assignment: 'model', riskFreeRate: 0.1 });
    registerShortPut(broker);
    broker.processBar(bar('P100', t(1), 20.3)); // fill; extrinsic ≈ 0.3 (marks ABOVE intrinsic)
    broker.processBar(bar('P100', t(2), 20.3)); // carry (~4.5) − extrinsic (0.3) > buffer (2) ⇒ assign
    const s = broker.settlements.find((x) => x.symbol === 'P100');
    expect(s).toMatchObject({ action: 'assigned', early: true, reason: 'deep-itm', contracts: -1 });
    expect(broker.position('XYZ').quantity).toBe(100); // assigned ⇒ buys 100 shares at the strike
  });

  it('does NOT assign a put that still carries real time value', () => {
    const broker = new SimulatedBroker({ cash: 100_000, assignment: 'model', riskFreeRate: 0.1 });
    registerShortPut(broker);
    broker.processBar(bar('P100', t(1), 24.0)); // extrinsic ≈ 4.0 ≫ carry benefit
    broker.processBar(bar('P100', t(2), 24.0));
    expect(broker.settlements).toHaveLength(0);
  });

  it('never assigns early at rate 0 (no carry incentive), even priced AT intrinsic', () => {
    const broker = new SimulatedBroker({ cash: 100_000, assignment: 'model', riskFreeRate: 0 });
    registerShortPut(broker);
    broker.processBar(bar('P100', t(1), 20.0)); // extrinsic 0, but no interest carry to capture
    broker.processBar(bar('P100', t(2), 20.0));
    expect(broker.settlements).toHaveLength(0);
  });
});

describe('WS7.4 manual long exercise', () => {
  it('exerciseOption settles a long American call at the underlier mark', () => {
    const broker = new SimulatedBroker({ cash: 100_000, assignment: 'model' });
    broker.registerOption('C90', {
      underlying: 'XYZ',
      type: 'call',
      strike: 90,
      expiresAt: EXPIRY,
      style: 'american',
    });
    broker.submit({ symbol: 'C90', side: 'buy', quantity: 2, type: 'market' });
    broker.processBar(bar('XYZ', t(1), 105));
    broker.processBar(bar('C90', t(1), 15.2));
    const settlement = broker.exerciseOption({ symbol: 'C90', quantity: 2, timestampMs: t(2) });
    expect(settlement).toMatchObject({
      action: 'exercised',
      early: true,
      reason: 'manual',
      contracts: 2,
    });
    expect(broker.position('XYZ').quantity).toBe(200); // long call exercised ⇒ buys 200 shares at strike
    expect(broker.position('C90').quantity).toBe(0);
  });

  it("exerciseOption requires the 'model' policy and a long American position", () => {
    const off = new SimulatedBroker({ cash: 100_000 });
    off.registerOption('C90', { underlying: 'XYZ', type: 'call', strike: 90, expiresAt: EXPIRY });
    expect(() => off.exerciseOption({ symbol: 'C90', quantity: 1, timestampMs: t(2) })).toThrow(
      /assignment: 'model'/,
    );
  });
});
