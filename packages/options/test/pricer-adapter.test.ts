/**
 * Gate C reference adapter — `optionContractPricer` (`@totalfinance/options/pricer`).
 *
 * The load-bearing acceptance laws (`docs/specs/gate-c-extension-contracts.md`):
 *   1. ADAPTER PARITY: for the same contract and an equivalent market, the adapter and the direct
 *      `option.price` agree BIT-FOR-BIT — value, every Greek, assumptions — because the adapter IS
 *      the direct call (zero pricing code). Diagnostics differ only by the additive
 *      explicit-selection disclosure when the caller pinned an engine.
 *   2. SELECTION COMPLETENESS: automatic selection (engines.auto) reports mode, selected engine,
 *      reason, and every candidate considered with a verdict; explicit selection reports the
 *      caller's choice and fabricates no considered-list. `diagnostics.engine`, `autoReason`, and
 *      the report always tell one story.
 *   3. REQUIREMENT HONESTY: the declared requirements are exactly what pricing consumes — proved
 *      here by the conformance kit itself (`validatePricer` with real fixtures).
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError, type OptionContract } from '@totalfinance/core';
import {
  requirementKey,
  validatePricer,
  type MarketObservation,
  type PricerProbe,
} from '@totalfinance/core/pricing';
import { engines, market, option } from '@totalfinance/options';
import { optionContractPricer, OPTION_CONTRACT_PRICER_NAME } from '@totalfinance/options/pricer';

// 16:00 ET (21:00 UTC, EST) close: a date-only expiry one EST year later resolves to exactly T = 1.
const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01';

const americanPut = option.put({
  convention: 'us-equity-close',
  underlying: 'AAPL',
  strike: 100,
  expiry,
  style: 'american',
});
const americanCall = option.call({
  convention: 'us-equity-close',
  underlying: 'AAPL',
  strike: 100,
  expiry,
  style: 'american',
});
const europeanCall = option.call({
  convention: 'us-equity-close',
  underlying: 'AAPL',
  strike: 100,
  expiry,
  style: 'european',
});

function observations(
  contract: OptionContract,
  extra: MarketObservation[] = [],
): MarketObservation[] {
  return [
    { requirement: { kind: 'valuationInstant' }, value: asOf },
    { requirement: { kind: 'spot', symbol: 'AAPL' }, value: 100 },
    {
      requirement: {
        kind: 'impliedVolatility',
        symbol: 'AAPL',
        strike: contract.strike,
        expiresAt: contract.expiresAt,
      },
      value: 0.2,
    },
    { requirement: { kind: 'riskFreeRate', currency: 'USD' }, value: 0.05 },
    ...extra,
  ];
}

const directMarket = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

describe('optionContractPricer — requirements protocol', () => {
  it('declares exactly what option.price consumes, as typed descriptors', () => {
    const pricer = optionContractPricer();
    const declared = pricer.requirements(americanPut).map((r) => requirementKey(r));
    expect(declared).toEqual([
      'valuationInstant',
      'spot(symbol=AAPL)',
      `impliedVolatility(symbol=AAPL, strike=100, expiresAt=${americanPut.expiresAt})`,
      'riskFreeRate(currency=USD)',
      'dividendYield(symbol=AAPL)',
    ]);
    const dividendYield = pricer.requirements(americanPut)[4]!;
    expect(dividendYield.optional).toBe(true);
  });

  it('a missing required observation throws the protocol teaching error naming the descriptor', () => {
    const pricer = optionContractPricer();
    const withoutVol = observations(americanPut).filter(
      (o) => o.requirement.kind !== 'impliedVolatility',
    );
    try {
      pricer.price({ instrument: americanPut, observations: withoutVol });
      expect.unreachable('price must throw without the implied volatility observation');
    } catch (error) {
      expect(isQuantError(error, ErrorCode.PricerRequirementUnsatisfied)).toBe(true);
      expect((error as Error).message).toContain('impliedVolatility(symbol=AAPL');
    }
  });

  it('consumes the OPTIONAL dividendYield when observed and ignores undeclared observations', () => {
    const pricer = optionContractPricer();
    const base = pricer.price({ instrument: americanPut, observations: observations(americanPut) });
    const withDividend = pricer.price({
      instrument: americanPut,
      observations: observations(americanPut, [
        { requirement: { kind: 'dividendYield', symbol: 'AAPL' }, value: 0.03 },
      ]),
    });
    const withForeign = pricer.price({
      instrument: americanPut,
      observations: observations(americanPut, [
        { requirement: { kind: 'spot', symbol: 'MSFT' }, value: 500 },
      ]),
    });
    expect(withDividend.value).not.toBe(base.value); // the optional observation genuinely prices
    expect(Object.is(withForeign.value, base.value)).toBe(true); // the undeclared one cannot
  });
});

describe('optionContractPricer — adapter parity (bit-exact, the no-second-engine proof)', () => {
  it('automatic mode: identical result object content to the direct option.price call', () => {
    const adapter = optionContractPricer().price({
      instrument: americanPut,
      observations: observations(americanPut),
    });
    const direct = option.price({ contract: americanPut, market: directMarket });
    expect(Object.is(adapter.value, direct.value)).toBe(true);
    expect(adapter.greeks).toBeDefined();
    for (const [name, leaf] of Object.entries(direct.greeks!)) {
      expect(
        Object.is((adapter.greeks as unknown as Record<string, number>)[name], leaf),
        `greek ${name} must be bit-identical`,
      ).toBe(true);
    }
    expect(adapter.assumptions).toEqual(direct.assumptions);
    // engines.auto() emits the selection report itself, so BOTH results carry it identically.
    expect(adapter.diagnostics).toEqual(direct.diagnostics);
  });

  it('explicit mode: bit-identical to the direct call with the same engine, plus ONLY the explicit report', () => {
    const engine = engines.binomial({ variant: 'leisen-reimer', steps: 101 });
    const adapter = optionContractPricer({
      engine: engines.binomial({ variant: 'leisen-reimer', steps: 101 }),
    }).price({ instrument: americanPut, observations: observations(americanPut) });
    const direct = option.price({ contract: americanPut, market: directMarket, engine });
    expect(Object.is(adapter.value, direct.value)).toBe(true);
    expect(adapter.assumptions).toEqual(direct.assumptions);
    const { selection, ...rest } = adapter.diagnostics;
    expect(rest).toEqual(direct.diagnostics);
    expect(selection).toEqual({
      mode: 'explicit',
      selected: { name: 'binomial-leisen-reimer', version: engine.version },
      reason: expect.stringContaining('caller-selected'),
    });
  });

  it('request.greeks=false is passed through: no greeks on either path', () => {
    const adapter = optionContractPricer().price({
      instrument: europeanCall,
      observations: observations(europeanCall),
      request: { greeks: false },
    });
    const direct = option.price({ contract: europeanCall, market: directMarket, greeks: false });
    expect(adapter.greeks).toBeUndefined();
    expect(Object.is(adapter.value, direct.value)).toBe(true);
  });

  it('validates the complete Gate-C request grammar before pricing', () => {
    const pricer = optionContractPricer();
    expect(() =>
      pricer.price({
        instrument: americanCall,
        observations: observations(americanCall),
        request: { greeks: 'yes' as never },
      }),
    ).toThrow(/request\.greeks must be a boolean/);
    expect(() =>
      pricer.price({
        instrument: americanCall,
        observations: observations(americanCall),
        request: { seed: -1 },
      }),
    ).toThrow(/non-negative safe integer/);
  });
});

describe('optionContractPricer — inspectable automatic selection', () => {
  it('an American put (objective accuracy) discloses the full considered set and the choice', () => {
    const result = optionContractPricer().price({
      instrument: americanPut,
      observations: observations(americanPut),
    });
    const selection = result.diagnostics.selection!;
    expect(selection.mode).toBe('automatic');
    expect(selection.selected.name).toBe('binomial-leisen-reimer');
    // One story across the three disclosures.
    expect(result.diagnostics.engine).toBe(selection.selected.name);
    expect(result.diagnostics.autoReason).toBe(selection.reason);
    expect(selection.candidates!.map((c) => c.name)).toEqual([
      'black-scholes-merton',
      'bjerksund-stensland-2002',
      'binomial-leisen-reimer',
    ]);
    const shortcut = selection.candidates!.find((c) => c.name === 'black-scholes-merton')!;
    expect(shortcut.eligible).toBe(false); // a put can exercise early; the European shortcut cannot price it
    expect(shortcut.reason).toMatch(/early exercise/i);
    const chosen = selection.candidates!.find((c) => c.name === selection.selected.name)!;
    expect(chosen.eligible).toBe(true);
    expect(chosen.reason).toBe(selection.reason);
  });

  it('objective "speed" (auto passed explicitly) is still reported as the AUTOMATIC choice it is', () => {
    const result = optionContractPricer({ engine: engines.auto({ objective: 'speed' }) }).price({
      instrument: americanPut,
      observations: observations(americanPut),
    });
    const selection = result.diagnostics.selection!;
    expect(selection.mode).toBe('automatic');
    expect(selection.selected.name).toBe('bjerksund-stensland-2002');
    expect(selection.candidates!.find((c) => c.name === 'binomial-leisen-reimer')!.reason).toMatch(
      /objective "speed"/,
    );
  });

  it('the no-dividend American call shortcut names its theorem in the report', () => {
    const result = optionContractPricer().price({
      instrument: americanCall,
      observations: observations(americanCall),
    });
    const selection = result.diagnostics.selection!;
    expect(selection.selected.name).toBe('black-scholes-merton');
    expect(selection.reason).toMatch(/early exercise is never optimal/i);
    const lattice = selection.candidates!.find((c) => c.name === 'binomial-leisen-reimer')!;
    expect(lattice.reason).toMatch(/shortcut/);
  });

  it('a European contract reports why the forward route was not taken', () => {
    const result = optionContractPricer().price({
      instrument: europeanCall,
      observations: observations(europeanCall),
    });
    const selection = result.diagnostics.selection!;
    expect(selection.selected.name).toBe('black-scholes-merton');
    const black76 = selection.candidates!.find((c) => c.name === 'black-76')!;
    expect(black76.eligible).toBe(false);
    expect(black76.reason).toMatch(/requires market\.forward/);
  });
});

describe('optionContractPricer — conformance (the kit passes against real fixtures)', () => {
  it('the automatic adapter passes validatePricer with caller-supplied fixtures', () => {
    const probes: PricerProbe<OptionContract>[] = [
      {
        instrument: americanPut,
        observations: observations(americanPut, [
          { requirement: { kind: 'dividendYield', symbol: 'AAPL' }, value: 0.01 },
        ]),
        expectSelection: 'automatic',
      },
      { instrument: europeanCall, observations: observations(europeanCall) },
    ];
    const validated = validatePricer(optionContractPricer(), probes);
    expect(validated.name).toBe(OPTION_CONTRACT_PRICER_NAME);
    expect(validated.capabilities).toEqual({
      greeks: 'delegated',
      randomness: 'none',
      batch: false,
    });
  });

  it('the explicit adapter passes validatePricer and reports explicit selection', () => {
    const probes: PricerProbe<OptionContract>[] = [
      {
        instrument: europeanCall,
        observations: observations(europeanCall),
        expectSelection: 'explicit',
      },
    ];
    const validated = validatePricer(
      optionContractPricer({ engine: engines.blackScholesMerton() }),
      probes,
    );
    expect(validated.capabilities.greeks).toBe('analytic');
  });

  it('an unrepresentable style teaches at supports(); an unsupported style teaches at price()', () => {
    // Bermudan is UNREPRESENTABLE (P3.4) — the closed style union rejects it with the same
    // teaching error every engine's supports() head uses, through the adapter unchanged.
    const bermudanish = { ...americanPut, style: 'bermudan' } as unknown as OptionContract;
    const pricer = optionContractPricer();
    expect(() => pricer.supports(bermudanish)).toThrow(/style/);
    // A REPRESENTABLE-but-unsupported pairing (European-only engine, American contract) refuses
    // with the engine taxonomy — the adapter delegates the gate to option.price, adding nothing.
    const european = optionContractPricer({ engine: engines.blackScholesMerton() });
    expect(european.supports(americanPut)).toBe(false);
    try {
      european.price({ instrument: americanPut, observations: observations(americanPut) });
      expect.unreachable('price must refuse a contract the pinned engine does not support');
    } catch (error) {
      expect(isQuantError(error, ErrorCode.EngineUnsupportedContract)).toBe(true);
    }
  });

  it('the factory teaches on a misspelled option and a non-engine engine', () => {
    expect(() => optionContractPricer({ engin: engines.auto() } as never)).toThrow(/engin/);
    expect(() => optionContractPricer({ engine: 42 } as never)).toThrow(/OptionPricingEngine/);
  });
});
