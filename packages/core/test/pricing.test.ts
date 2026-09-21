/**
 * Gate C — the Pricer/requirements protocol and its conformance kit
 * (`docs/specs/gate-c-extension-contracts.md`, `@totalfinance/core/pricing`).
 *
 * Two halves. The grammar half proves the requirement descriptors, observation lookup, and
 * selection-report validation teach on every malformed input. The refutation half is the
 * acceptance law "a deliberately broken Pricer must FAIL the kit": a conformant toy pricer passes
 * `validatePricer`, and single-defect mutants — non-determinism, NaN success, undeclared
 * consumption, silent defaults, wrong error taxonomy, capability lies, batch lies, selection lies,
 * unstable requirements, a foreign result grammar, seed-law violations (a 'none' pricer reading a
 * seed; a 'seeded' pricer varying under a fixed seed, skipping the seed echo, defaulting a
 * missing seed, or ignoring the batch derivation law), and batch-path seed-law violations
 * (2026-08-23, fourth external review: a 'seeded' batch that silently defaults a missing seed, a
 * 'none' batch that reads a seed its scalar path ignores, a batch that lies only past item 0, a
 * batch that reads undeclared observations) — are each caught with a teaching
 * `pricer.nonconformant` error. A kit that cannot refute proves nothing.
 */

import { describe, expect, it } from 'vitest';
import { CONVENTIONS_VERSION, ErrorCode, InputError, isQuantError } from '@totalfinance/core';
import {
  definePricer,
  missingRequirements,
  observationFor,
  optionalObservationValue,
  requireObservationValue,
  requirementKey,
  sameRequirement,
  validateMarketObservation,
  validateMarketRequirement,
  validatePricer,
  validateSelectionReport,
  type MarketObservation,
  type Pricer,
  type PricerProbe,
} from '@totalfinance/core/pricing';
import type { Computed } from '@totalfinance/core';

/** Run `fn`, return the QuantError code it threw (or `'<none>'`). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '<none>';
  } catch (error) {
    return isQuantError(error) ? error.code : `<not a QuantError: ${String(error)}>`;
  }
}

// ── A toy instrument + conformant pricer (cash equity line: value = spot × quantity) ────────────

interface CashLine {
  symbol: string;
  quantity: number;
}

const AAPL: CashLine = { symbol: 'AAPL', quantity: 3 };

function cashObservations(): MarketObservation[] {
  return [
    { requirement: { kind: 'valuationInstant' }, value: '2026-08-20T16:00:00-04:00' },
    { requirement: { kind: 'spot', symbol: 'AAPL' }, value: 100 },
    { requirement: { kind: 'dividendYield', symbol: 'AAPL' }, value: 0.02 },
    // Deliberately undeclared — the kit must prove the pricer ignores it.
    { requirement: { kind: 'spot', symbol: 'MSFT' }, value: 50 },
  ];
}

function cashProbes(): PricerProbe<CashLine>[] {
  return [{ instrument: AAPL, observations: cashObservations() }];
}

/** A fully conformant pricer, with each behavior overridable to build single-defect mutants. */
function cashLinePricer(overrides: Partial<Pricer<CashLine>> = {}): Pricer<CashLine> {
  const base: Pricer<CashLine> = {
    name: 'test.cash-line',
    version: '0.0.1',
    capabilities: { greeks: 'none', randomness: 'none', batch: true },
    supports: (instrument) => typeof instrument.symbol === 'string',
    requirements: (instrument) => [
      { kind: 'valuationInstant' },
      { kind: 'spot', symbol: instrument.symbol },
      { kind: 'dividendYield', symbol: instrument.symbol, optional: true },
    ],
    price: ({ instrument, observations }) => {
      const functionName = 'test.cash-line.price';
      requireObservationValue(functionName, observations, { kind: 'valuationInstant' });
      const spot = requireObservationValue(functionName, observations, {
        kind: 'spot',
        symbol: instrument.symbol,
      });
      const dividendYield =
        optionalObservationValue(functionName, observations, {
          kind: 'dividendYield',
          symbol: instrument.symbol,
        }) ?? 0;
      return {
        value: spot * instrument.quantity * (1 + dividendYield),
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
        diagnostics: { warnings: [] },
      };
    },
    priceBatch: ({ instruments, observations, request }) =>
      instruments.map((instrument) =>
        cashLinePricer().price({
          instrument,
          observations,
          ...(request !== undefined ? { request } : {}),
        }),
      ),
  };
  return { ...base, ...overrides };
}

// ── Requirement / observation grammar ───────────────────────────────────────────────────────────

describe('market requirement descriptors', () => {
  it('requirementKey is canonical: kind plus subject fields in declaration order', () => {
    expect(requirementKey({ kind: 'valuationInstant' })).toBe('valuationInstant');
    expect(requirementKey({ kind: 'spot', symbol: 'AAPL' })).toBe('spot(symbol=AAPL)');
    expect(
      requirementKey({ kind: 'impliedVolatility', symbol: 'AAPL', strike: 200, expiresAt: 1000 }),
    ).toBe('impliedVolatility(symbol=AAPL, strike=200, expiresAt=1000)');
  });

  it('the optional marker is not part of requirement identity', () => {
    expect(
      sameRequirement(
        { kind: 'dividendYield', symbol: 'AAPL', optional: true },
        { kind: 'dividendYield', symbol: 'AAPL' },
      ),
    ).toBe(true);
  });

  it('an unknown kind teaches with the closed kind list', () => {
    expect(codeOf(() => validateMarketRequirement('t', 'requirement', { kind: 'vibes' }))).toBe(
      ErrorCode.PricerRequirementInvalid,
    );
    expect(() => validateMarketRequirement('t', 'requirement', { kind: 'vibes' })).toThrow(
      /valuationInstant \| spot \| forward/,
    );
  });

  it('a misspelled subject field is an unknown-key teaching error', () => {
    expect(
      codeOf(() => validateMarketRequirement('t', 'requirement', { kind: 'spot', symbl: 'AAPL' })),
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('subject fields are typed: a non-positive strike is rejected', () => {
    expect(
      codeOf(() =>
        validateMarketRequirement('t', 'requirement', {
          kind: 'impliedVolatility',
          symbol: 'AAPL',
          strike: -1,
          expiresAt: 1000,
        }),
      ),
    ).toBe(ErrorCode.PricerRequirementInvalid);
  });

  it('observation values are typed per kind', () => {
    expect(
      codeOf(() =>
        validateMarketObservation('t', 'observation', {
          requirement: { kind: 'spot', symbol: 'AAPL' },
          value: 'a hundred',
        }),
      ),
    ).toBe(ErrorCode.PricerObservationInvalid);
  });

  it('a discountCurve observation is core RateCurve PLAIN DATA — serializable, snapshot-compatible', () => {
    const curve = {
      currency: 'USD',
      asOf: Date.UTC(2026, 6, 20),
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      points: [
        { date: '2026-10-20', zeroRate: 0.045 },
        { date: '2027-07-20', zeroRate: 0.043 },
      ],
      interpolation: 'linearZero',
    };
    expect(
      codeOf(() =>
        validateMarketObservation('t', 'observation', {
          requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
          value: curve,
        }),
      ),
    ).toBe('<none>');
    // The observation list is documented serializable/replayable — a method bag is not data.
    expect(
      codeOf(() =>
        validateMarketObservation('t', 'observation', {
          requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
          value: { discountFactorAt: (timeYears: number) => Math.exp(-0.05 * timeYears) },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    // The SHARED core curve validator refuses the confirmed malformations with exact teaching.
    const withPoints = (points: unknown) =>
      validateMarketObservation('t', 'observation', {
        requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
        value: { ...curve, points },
      });
    expect(() => withPoints([{ date: '2025-02-30', zeroRate: 0.04 }])).toThrow(
      /not a real calendar date/,
    );
    expect(() =>
      withPoints([
        { date: '2027-07-20', zeroRate: 0.043 },
        { date: '2026-10-20', zeroRate: 0.045 },
      ]),
    ).toThrow(/strictly ascending/);
    expect(
      codeOf(() =>
        validateMarketObservation('t', 'observation', {
          requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
          value: { ...curve, interpolation: 42 },
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
  });

  it('a discountCurve requirement names its curve: curveId is the snapshot label, and identity is checked', () => {
    const curve = {
      currency: 'USD',
      asOf: Date.UTC(2026, 6, 20),
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      points: [{ date: '2027-07-20', zeroRate: 0.043 }],
    };
    // curveId is a REQUIRED subject field: a snapshot stores multiple same-currency curves under
    // caller labels, so a currency alone cannot name one.
    expect(
      codeOf(() =>
        validateMarketRequirement('t', 'requirement', { kind: 'discountCurve', currency: 'USD' }),
      ),
    ).toBe(ErrorCode.PricerRequirementInvalid);
    expect(requirementKey({ kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' })).toBe(
      'discountCurve(curveId=USD.sofr, currency=USD)',
    );
    // Currency identity: a USD requirement is NOT satisfied by an EUR curve, whatever label it
    // sat under — the curve declares its own currency and the observation door cross-checks it.
    expect(() =>
      validateMarketObservation('t', 'observation', {
        requirement: { kind: 'discountCurve', curveId: 'EUR.ois', currency: 'USD' },
        value: { ...curve, currency: 'EUR' },
      }),
    ).toThrow(
      /"EUR" curve but the requirement discountCurve\(curveId=EUR\.ois, currency=USD\) names currency "USD"/,
    );
    // An empty curve discounts nothing — zero pillars refuse at the shared curve validator.
    expect(() =>
      validateMarketObservation('t', 'observation', {
        requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
        value: { ...curve, points: [] },
      }),
    ).toThrow(/at least one pillar — an empty curve discounts nothing/);
    // Pillar economics: a zero rate whose discount factor cannot exist under the curve's own
    // compounding is refused — zeroRate -2 under annual compounding has growth factor 1 + r/m ≤ 0.
    expect(() =>
      validateMarketObservation('t', 'observation', {
        requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
        value: {
          ...curve,
          compounding: 'annual',
          points: [{ date: '2027-07-20', zeroRate: -2 }],
        },
      }),
    ).toThrow(/no real discount factor under compounding "annual"/);
    // A pillar strictly before the curve's asOf discounts into the past and is refused; a
    // negative-rate curve with a real (above-1) discount factor still passes.
    expect(() =>
      validateMarketObservation('t', 'observation', {
        requirement: { kind: 'discountCurve', curveId: 'USD.sofr', currency: 'USD' },
        value: { ...curve, points: [{ date: '2026-07-19', zeroRate: 0.043 }] },
      }),
    ).toThrow(/before the curve's asOf/);
    expect(
      codeOf(() =>
        validateMarketObservation('t', 'observation', {
          requirement: { kind: 'discountCurve', curveId: 'CHF.saron', currency: 'CHF' },
          value: {
            ...curve,
            currency: 'CHF',
            points: [{ date: '2027-07-20', zeroRate: -0.0075 }],
          },
        }),
      ),
    ).toBe('<none>');
  });

  it('an impliedVolatility observation must be ≥ 0; spot and forward stay sign-free', () => {
    const observed = (kind: 'impliedVolatility' | 'spot' | 'forward', value: number) =>
      validateMarketObservation('t', 'observation', {
        requirement:
          kind === 'impliedVolatility'
            ? { kind, symbol: 'AAPL', strike: 200, expiresAt: 1000 }
            : kind === 'forward'
              ? { kind, symbol: 'CL', expiresAt: 1000 }
              : { kind, symbol: 'CL' },
        value,
      });
    expect(codeOf(() => observed('impliedVolatility', 0.24))).toBe('<none>');
    expect(codeOf(() => observed('impliedVolatility', -0.24))).toBe(
      ErrorCode.InputNegativeVolatility,
    );
    expect(() => observed('impliedVolatility', -0.24)).toThrow(/magnitude .*annualized decimal/);
    // Negative commodity prints are real — the sign law is volatility's, not the price scalars'.
    expect(codeOf(() => observed('spot', -37.63))).toBe('<none>');
    expect(codeOf(() => observed('forward', -5.2))).toBe('<none>');
  });

  it('a valuationInstant observation resolves through the ONE workspace asOf grammar', () => {
    const observed = (value: unknown) =>
      validateMarketObservation('t', 'observation', {
        requirement: { kind: 'valuationInstant' },
        value,
      });
    // A bare date is not a valuation instant (the time of day is the answer for a 0DTE): refused
    // with the typed code and the fix, exactly as every pricing boundary refuses it.
    expect(codeOf(() => observed('2026-08-20'))).toBe(ErrorCode.TimeValuationInstantRequired);
    expect(codeOf(() => observed(Date.UTC(2026, 7, 20, 21)))).toBe('<none>');
    expect(codeOf(() => observed('2026-08-20T16:00:00-05:00'))).toBe('<none>');
    // Loose prose is not an instant; an impossible date is not a date; a zone-less datetime would
    // silently parse in the machine's zone — all three teach through core's shared grammar.
    expect(() => observed('yesterday-ish')).toThrow(/cannot parse asOf/);
    expect(() => observed('2025-02-30')).toThrow(/not a valid calendar date/);
    expect(() => observed('2026-08-20T16:00:00')).toThrow(/no timezone/);
    expect(codeOf(() => observed(Number.NaN))).toBe(ErrorCode.InputNotFinite);
  });

  it('a missing required observation throws the protocol teaching error naming the descriptor', () => {
    const observations: MarketObservation[] = [
      { requirement: { kind: 'spot', symbol: 'MSFT' }, value: 50 },
    ];
    expect(
      codeOf(() => requireObservationValue('t', observations, { kind: 'spot', symbol: 'AAPL' })),
    ).toBe(ErrorCode.PricerRequirementUnsatisfied);
    expect(() =>
      requireObservationValue('t', observations, { kind: 'spot', symbol: 'AAPL' }),
    ).toThrow(/spot\(symbol=AAPL\).*Received observations for: spot\(symbol=MSFT\)/s);
  });

  it('missingRequirements pre-flights only the REQUIRED gaps', () => {
    const gaps = missingRequirements({
      requirements: [
        { kind: 'spot', symbol: 'AAPL' },
        { kind: 'riskFreeRate', currency: 'USD' },
        { kind: 'dividendYield', symbol: 'AAPL', optional: true },
      ],
      observations: [{ requirement: { kind: 'spot', symbol: 'AAPL' }, value: 100 }],
    });
    expect(gaps.map((requirement) => requirementKey(requirement))).toEqual([
      'riskFreeRate(currency=USD)',
    ]);
  });

  it('observationFor matches by identity, ignoring the optional marker', () => {
    const observations = cashObservations();
    const match = observationFor(observations, {
      kind: 'dividendYield',
      symbol: 'AAPL',
      optional: true,
    });
    expect(match?.value).toBe(0.02);
  });
});

// ── Selection-report grammar ────────────────────────────────────────────────────────────────────

describe('selection report grammar', () => {
  const automatic = {
    mode: 'automatic',
    selected: { name: 'lattice' },
    reason: 'accuracy objective prefers the lattice.',
    candidates: [
      { name: 'closed-form', eligible: false, reason: 'cannot price early exercise.' },
      { name: 'lattice', eligible: true, reason: 'accuracy objective prefers the lattice.' },
    ],
  };

  it('accepts a complete automatic report and a candidate-free explicit report', () => {
    expect(() => validateSelectionReport('t', automatic)).not.toThrow();
    expect(() =>
      validateSelectionReport('t', {
        mode: 'explicit',
        selected: { name: 'lattice' },
        reason: 'caller-selected.',
      }),
    ).not.toThrow();
  });

  it('an automatic report must show candidates and must have chosen an eligible one of them', () => {
    expect(codeOf(() => validateSelectionReport('t', { ...automatic, candidates: [] }))).toBe(
      ErrorCode.PricerNonconformant,
    );
    expect(
      codeOf(() =>
        validateSelectionReport('t', { ...automatic, selected: { name: 'not-considered' } }),
      ),
    ).toBe(ErrorCode.PricerNonconformant);
    expect(
      codeOf(() =>
        validateSelectionReport('t', { ...automatic, selected: { name: 'closed-form' } }),
      ),
    ).toBe(ErrorCode.PricerNonconformant);
  });

  it('an explicit report must NOT fabricate a considered-list', () => {
    expect(
      codeOf(() =>
        validateSelectionReport('t', {
          mode: 'explicit',
          selected: { name: 'lattice' },
          reason: 'caller-selected.',
          candidates: automatic.candidates,
        }),
      ),
    ).toBe(ErrorCode.PricerNonconformant);
  });
});

// ── definePricer: structural validation ─────────────────────────────────────────────────────────

describe('definePricer', () => {
  it('returns a frozen pricer with bound methods', () => {
    const defined = definePricer(cashLinePricer());
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.capabilities)).toBe(true);
    const { price } = defined; // detached call must still work (bound)
    expect(price({ instrument: AAPL, observations: cashObservations() }).value).toBe(
      100 * 3 * 1.02,
    );
  });

  it('teaches on a misspelled capability key, a wrong greeks mode, and a wrong randomness mode', () => {
    expect(
      codeOf(() =>
        definePricer(
          cashLinePricer({
            capabilities: { greeks: 'none', randomness: 'none', batches: true } as never,
          }),
        ),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        definePricer(
          cashLinePricer({
            capabilities: { greeks: 'sometimes', randomness: 'none', batch: true } as never,
          }),
        ),
      ),
    ).toBe(ErrorCode.InputMissingField);
    // The retired boolean grammar and any free-running claim both teach the law by name.
    expect(() =>
      definePricer(
        cashLinePricer({
          capabilities: { greeks: 'none', randomness: 'free-running', batch: true } as never,
        }),
      ),
    ).toThrow(/free-running randomness is non-conformant/);
    expect(
      codeOf(() =>
        definePricer(
          cashLinePricer({
            capabilities: { greeks: 'none', deterministic: true, batch: true } as never,
          }),
        ),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('batch capability and priceBatch presence must agree in both directions', () => {
    const { priceBatch: _dropped, ...withoutBatchMethod } = cashLinePricer();
    expect(codeOf(() => definePricer(withoutBatchMethod as Pricer<CashLine>))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() =>
        definePricer(
          cashLinePricer({
            capabilities: { greeks: 'none', randomness: 'none', batch: false },
          }),
        ),
      ),
    ).toBe(ErrorCode.InputMissingField);
  });
});

// ── validatePricer: the conformant control, then the refutation battery ─────────────────────────

describe('validatePricer — conformant control', () => {
  it('a conformant pricer passes against caller-supplied fixtures and is returned validated', () => {
    const validated = validatePricer(cashLinePricer(), cashProbes());
    expect(validated.name).toBe('test.cash-line');
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it('rejects an empty probe list — no fixtures, no proof', () => {
    expect(codeOf(() => validatePricer(cashLinePricer(), []))).toBe(ErrorCode.InputOutOfRange);
  });

  it('a probe missing a REQUIRED observation is a fixture error, not a pricer verdict', () => {
    const probes: PricerProbe<CashLine>[] = [
      {
        instrument: AAPL,
        observations: cashObservations().filter(
          (observation) => requirementKey(observation.requirement) !== 'spot(symbol=AAPL)',
        ),
      },
    ];
    expect(codeOf(() => validatePricer(cashLinePricer(), probes))).toBe(ErrorCode.InputWrongShape);
    expect(() => validatePricer(cashLinePricer(), probes)).toThrow(/spot\(symbol=AAPL\)/);
  });
});

describe('validatePricer — the refutation battery (a broken Pricer must FAIL)', () => {
  const expectNonconformant = (
    pricer: Pricer<CashLine>,
    pattern: RegExp,
    probes = cashProbes(),
  ) => {
    expect(codeOf(() => validatePricer(pricer, probes))).toBe(ErrorCode.PricerNonconformant);
    expect(() => validatePricer(pricer, probes)).toThrow(pattern);
  };

  it("refutes a determinism liar (jittered value under randomness: 'none')", () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        price: (input) => {
          const result = conformant.price(input);
          return { ...result, value: result.value + Math.random() * 1e-6 };
        },
      }),
      /randomness: 'none' but two identical calls/,
    );
  });

  it('refutes a NaN success (Law 7: success is finite)', () => {
    expectNonconformant(
      cashLinePricer({
        price: () => ({
          value: Number.NaN,
          assumptions: { conventionsVersion: CONVENTIONS_VERSION },
          diagnostics: { warnings: [] },
        }),
      }),
      /finite/,
    );
  });

  it('refutes a result that abandons the Law-2 envelope', () => {
    expectNonconformant(
      cashLinePricer({
        price: () => ({ value: 42 }) as unknown as Computed<number>,
      }),
      /Law-2 result envelope/,
    );
  });

  it('refutes an under-declarer that consumes an observation it never declared', () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        price: (input) => {
          const result = conformant.price(input);
          const msft =
            optionalObservationValue('test.under-declarer', input.observations, {
              kind: 'spot',
              symbol: 'MSFT',
            }) ?? 0;
          return { ...result, value: result.value + msft };
        },
      }),
      /does not declare/,
    );
  });

  it('refutes a silent default for a REQUIRED observation (prices instead of teaching)', () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        price: ({ instrument, observations }) => {
          const spot =
            optionalObservationValue('test.silent-default', observations, {
              kind: 'spot',
              symbol: instrument.symbol,
            }) ?? 100; // the guess the protocol exists to forbid
          const result = conformant.price({
            instrument,
            observations: [
              ...observations.filter(
                (observation) =>
                  requirementKey(observation.requirement) !==
                  requirementKey({ kind: 'spot', symbol: instrument.symbol }),
              ),
              { requirement: { kind: 'spot', symbol: instrument.symbol }, value: spot },
            ],
          });
          return result;
        },
      }),
      /SUCCEEDED without the required observation/,
    );
  });

  it('refutes the wrong error taxonomy for a missing requirement (a bare Error is not teaching)', () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        price: (input) => {
          if (
            observationFor(input.observations, {
              kind: 'spot',
              symbol: input.instrument.symbol,
            }) === undefined
          ) {
            throw new Error('missing spot');
          }
          return conformant.price(input);
        },
      }),
      /wrong error/,
    );
  });

  it('refutes a greeks capability lie (claims analytic, returns none)', () => {
    expectNonconformant(
      cashLinePricer({
        capabilities: { greeks: 'analytic', randomness: 'none', batch: true },
      }),
      /returned no greeks/,
    );
  });

  it('refutes a batch path that disagrees with the scalar path', () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        priceBatch: ({ instruments, observations }) =>
          instruments.map((instrument) => {
            const result = conformant.price({ instrument, observations });
            return { ...result, value: result.value + 1e-9 };
          }),
      }),
      /batch .*must be provably the same pricing|disagrees with price\(\)/,
    );
  });

  it('refutes a missing selection report when the probe expects one', () => {
    const probes: PricerProbe<CashLine>[] = [{ ...cashProbes()[0]!, expectSelection: 'automatic' }];
    expectNonconformant(cashLinePricer(), /selection report/, probes);
  });

  it('refutes a malformed selection report (automatic without candidates)', () => {
    const conformant = cashLinePricer();
    // The mutation must be COHERENT across scalar and batch, or the complete-result batch-parity
    // probe convicts first and the selection grammar is never reached.
    const priceWithBadSelection: Pricer<CashLine>['price'] = (input) => {
      const result = conformant.price(input);
      return {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          selection: {
            mode: 'automatic',
            selected: { name: 'test.cash-line' },
            reason: 'only one model exists.',
          },
        },
      } as Computed<number>;
    };
    expectNonconformant(
      cashLinePricer({
        price: priceWithBadSelection,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) =>
            priceWithBadSelection({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            }),
          ),
      }),
      /candidates/,
    );
  });

  it('refutes a determinism liar whose VALUE holds still while assumptions drift (Finding 3)', () => {
    const conformant = cashLinePricer();
    const drifting: Pricer<CashLine>['price'] = (input) => {
      const result = conformant.price(input);
      return {
        ...result,
        assumptions: { ...result.assumptions, seed: Math.random() },
      } as Computed<number>;
    };
    expectNonconformant(
      cashLinePricer({
        price: drifting,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) =>
            drifting({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            }),
          ),
      }),
      /randomness: 'none' but two identical calls returned different COMPLETE results/,
    );
  });

  it('refutes a batch path whose VALUE agrees while its assumptions differ from scalar (Finding 3)', () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) => {
            const result = conformant.price({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            });
            return {
              ...result,
              assumptions: { ...result.assumptions, calendar: 'batch-only-calendar' },
            } as Computed<number>;
          }),
      }),
      /agreement covers the COMPLETE result/,
    );
  });

  it('refutes an EMPTY greeks object under a claimed analytic capability (Finding 3)', () => {
    const conformant = cashLinePricer();
    const emptyGreeks: Pricer<CashLine>['price'] = (input) => {
      const result = conformant.price(input);
      return { ...result, greeks: {} } as Computed<number>;
    };
    expectNonconformant(
      cashLinePricer({
        capabilities: { greeks: 'analytic', randomness: 'none', batch: true },
        price: emptyGreeks,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) =>
            emptyGreeks({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            }),
          ),
      }),
      /claims greeks="analytic" but returned an EMPTY greeks object/,
    );
  });

  it('refutes duplicate candidate names in a selection report (Finding 3)', () => {
    expect(
      codeOf(() =>
        validateSelectionReport('t', {
          mode: 'automatic',
          selected: { name: 'lattice' },
          reason: 'accuracy objective prefers the lattice.',
          candidates: [
            { name: 'lattice', eligible: false, reason: 'first verdict.' },
            { name: 'lattice', eligible: true, reason: 'second verdict.' },
          ],
        }),
      ),
    ).toBe(ErrorCode.PricerNonconformant);
    expect(() =>
      validateSelectionReport('t', {
        mode: 'automatic',
        selected: { name: 'lattice' },
        reason: 'accuracy objective prefers the lattice.',
        candidates: [
          { name: 'lattice', eligible: false, reason: 'first verdict.' },
          { name: 'lattice', eligible: true, reason: 'second verdict.' },
        ],
      }),
    ).toThrow(/appears twice in the considered-set/);
  });

  it('refutes unstable requirements (a runner cannot gather-then-price)', () => {
    let flip = false;
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        requirements: (instrument) => {
          flip = !flip;
          return flip
            ? conformant.requirements(instrument)
            : [{ kind: 'spot', symbol: instrument.symbol }];
        },
      }),
      /unstable/,
    );
  });

  it("refutes a 'none' pricer that changes its result when a seed is supplied (the seed-ignoring law)", () => {
    const conformant = cashLinePricer();
    const seedReader: Pricer<CashLine>['price'] = (input) => {
      const result = conformant.price(input);
      const seed = input.request?.seed;
      return seed === undefined ? result : { ...result, value: result.value * (1 + seed * 1e-12) };
    };
    expectNonconformant(
      cashLinePricer({
        price: seedReader,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) =>
            seedReader({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            }),
          ),
      }),
      /randomness: 'none' but supplying request\.seed .* changed the COMPLETE result/,
    );
  });

  // ── Batch-path seed laws (2026-08-23, fourth external review) ─────────────────────────────────
  // The reviewer PASSED a 'none' pricer whose scalar path obeyed every law while its priceBatch()
  // read a seed — the laws were proved only against price(). Each mutant below has a fully
  // conformant scalar path; only the batch path lies, so only a batch-path probe can convict it.

  it("refutes the reviewer's 'none' pricer whose priceBatch changes under a seed its scalar path ignores", () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) => {
            const result = conformant.price({ instrument, observations });
            const seed = request?.seed;
            return seed === undefined
              ? result
              : { ...result, value: result.value * (1 + seed * 1e-12) };
          }),
      }),
      /randomness: 'none' but supplying request\.seed .* changed priceBatch\(\) item \d+'s COMPLETE result/,
    );
  });

  it("refutes a 'none' batch that agrees at item 0 but lies at item 1 — the batch probe must carry at least two instruments", () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument, i) => {
            const result = conformant.price({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            });
            return i === 0 ? result : { ...result, value: result.value + 1e-9 };
          }),
      }),
      /disagrees with price\(\) at item 1/,
    );
  });

  it("refutes a 'none' batch that reads an undeclared observation its scalar path ignores", () => {
    const conformant = cashLinePricer();
    expectNonconformant(
      cashLinePricer({
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) => {
            const result = conformant.price({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            });
            const msft =
              optionalObservationValue('test.batch-under-declarer', observations, {
                kind: 'spot',
                symbol: 'MSFT',
              }) ?? 0;
            return { ...result, value: result.value + msft };
          }),
      }),
      /priceBatch\(\) result changed at item \d+ when undeclared observations were supplied/,
    );
  });
});

// ── Seeded pricers (randomness: 'seeded') — the laws hold under a fixed seed ────────────────────

/** A tiny, dependency-free deterministic PRNG (mulberry32) seeded from the request seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A minimal GENUINELY stochastic conformant pricer: the value carries a mulberry32 draw derived
 * from `request.seed` alone, the seed is required (typed refusal) and echoed at
 * `assumptions.seed`, and the batch path implements the documented derivation law (item i under
 * seed + i). Each behavior is overridable to build single-defect mutants.
 */
function seededCashLinePricer(overrides: Partial<Pricer<CashLine>> = {}): Pricer<CashLine> {
  const priceSeeded: Pricer<CashLine>['price'] = ({ instrument, observations, request }) => {
    const functionName = 'test.seeded-cash-line.price';
    const seed = request?.seed;
    if (seed === undefined) {
      throw new InputError(
        `${functionName}: request.seed is required — this pricer declares randomness: 'seeded', so its randomness may only flow from the caller's seed.\n  e.g. price({ instrument, observations, request: { seed: 42 } })`,
        { code: ErrorCode.InputMissingField, context: { field: 'request.seed' } },
      );
    }
    requireObservationValue(functionName, observations, { kind: 'valuationInstant' });
    const spot = requireObservationValue(functionName, observations, {
      kind: 'spot',
      symbol: instrument.symbol,
    });
    const draw = mulberry32(seed)();
    return {
      value: spot * instrument.quantity * (1 + (draw - 0.5) * 1e-6),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, seed },
      diagnostics: { warnings: [] },
    };
  };
  const base: Pricer<CashLine> = {
    name: 'test.seeded-cash-line',
    version: '0.0.1',
    capabilities: { greeks: 'none', randomness: 'seeded', batch: true },
    supports: (instrument) => typeof instrument.symbol === 'string',
    requirements: (instrument) => [
      { kind: 'valuationInstant' },
      { kind: 'spot', symbol: instrument.symbol },
    ],
    price: priceSeeded,
    // The documented derivation law: item i prices under seed + i, through the scalar path. When
    // the caller supplies no seed the request flows through UNTOUCHED, so the scalar path teaches
    // the typed missing-seed refusal on the batch path too (2026-08-23, fourth external review:
    // the previous `(request?.seed ?? 0) + i` was itself the silent batch default the kit now
    // convicts — a seeded batch may never invent the seed its caller must own).
    priceBatch: ({ instruments, observations, request }) =>
      instruments.map((instrument, i) =>
        priceSeeded({
          instrument,
          observations,
          ...(request === undefined || request.seed === undefined
            ? request !== undefined
              ? { request }
              : {}
            : { request: { ...request, seed: request.seed + i } }),
        }),
      ),
  };
  return { ...base, ...overrides };
}

describe("validatePricer — seeded pricers (randomness: 'seeded')", () => {
  const expectNonconformant = (
    pricer: Pricer<CashLine>,
    pattern: RegExp,
    probes = cashProbes(),
  ) => {
    expect(codeOf(() => validatePricer(pricer, probes))).toBe(ErrorCode.PricerNonconformant);
    expect(() => validatePricer(pricer, probes)).toThrow(pattern);
  };

  it('a genuinely stochastic pricer that declares itself correctly PASSES the kit', () => {
    const validated = validatePricer(seededCashLinePricer(), cashProbes());
    expect(validated.name).toBe('test.seeded-cash-line');
    expect(validated.capabilities.randomness).toBe('seeded');
  });

  it('passes with a probe-supplied seed too, and the result echoes THAT seed', () => {
    const probes: PricerProbe<CashLine>[] = [
      { instrument: AAPL, observations: cashObservations(), request: { seed: 7 } },
    ];
    const validated = validatePricer(seededCashLinePricer(), probes);
    const result = validated.price({
      instrument: AAPL,
      observations: cashObservations(),
      request: { seed: 7 },
    });
    expect((result.assumptions as { seed?: number }).seed).toBe(7);
  });

  it('refutes a seeded pricer whose results vary across same-seed calls', () => {
    const conformant = seededCashLinePricer();
    const jittered: Pricer<CashLine>['price'] = (input) => {
      const result = conformant.price(input);
      return { ...result, value: result.value + Math.random() * 1e-9 };
    };
    expectNonconformant(
      seededCashLinePricer({
        price: jittered,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument, i) =>
            jittered({
              instrument,
              observations,
              request: { ...request, seed: (request?.seed ?? 0) + i },
            }),
          ),
      }),
      /randomness: 'seeded' but two identical same-seed calls/,
    );
  });

  it('refutes a seeded pricer that fails to echo its seed in assumptions', () => {
    const conformant = seededCashLinePricer();
    const echoless: Pricer<CashLine>['price'] = (input) => {
      const result = conformant.price(input);
      const { seed: _dropped, ...assumptions } = result.assumptions as Record<string, unknown> & {
        conventionsVersion: string;
      };
      return { ...result, assumptions } as Computed<number>;
    };
    expectNonconformant(
      seededCashLinePricer({
        price: echoless,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument, i) =>
            echoless({
              instrument,
              observations,
              request: { ...request, seed: (request?.seed ?? 0) + i },
            }),
          ),
      }),
      /does not echo its seed .* expected assumptions\.seed/,
    );
  });

  it('refutes a seeded pricer that prices WITHOUT a seed instead of refusing', () => {
    const conformant = seededCashLinePricer();
    const lenient: Pricer<CashLine>['price'] = (input) =>
      conformant.price({
        ...input,
        request: { ...input.request, seed: input.request?.seed ?? 1 }, // the silent default
      });
    expectNonconformant(
      seededCashLinePricer({
        price: lenient,
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument, i) =>
            lenient({
              instrument,
              observations,
              request: { ...request, seed: (request?.seed ?? 0) + i },
            }),
          ),
      }),
      /SUCCEEDED without request\.seed/,
    );
  });

  it('refutes a seeded batch that ignores the derivation law (same seed for every item)', () => {
    const conformant = seededCashLinePricer();
    expectNonconformant(
      seededCashLinePricer({
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument) =>
            conformant.price({
              instrument,
              observations,
              ...(request !== undefined ? { request } : {}),
            }),
          ),
      }),
      /breaks the seeded batch derivation law at item 1/,
    );
  });

  // ── Batch-path seed laws (2026-08-23, fourth external review) ─────────────────────────────────
  // The reviewer PASSED a 'seeded' pricer whose scalar path refused a missing seed while its
  // priceBatch() silently defaulted one — the missing-seed law was proved only against price().

  it("refutes the reviewer's 'seeded' pricer whose priceBatch silently defaults a missing seed", () => {
    const conformant = seededCashLinePricer();
    expectNonconformant(
      seededCashLinePricer({
        // Scalar path stays fully conformant (typed refusal, echo, same-seed identity); the batch
        // path defaults `seed ?? 0` — exactly the unreproducible-batch defect under review.
        priceBatch: ({ instruments, observations, request }) =>
          instruments.map((instrument, i) =>
            conformant.price({
              instrument,
              observations,
              request: { ...request, seed: (request?.seed ?? 0) + i },
            }),
          ),
      }),
      /priceBatch\(\) SUCCEEDED without request\.seed .* defaulted seed is unreproducible/s,
    );
  });

  it('refutes a seeded batch whose missing-seed refusal is a bare Error (wrong taxonomy on the batch path)', () => {
    const conformant = seededCashLinePricer();
    expectNonconformant(
      seededCashLinePricer({
        priceBatch: (input) => {
          if (input.request?.seed === undefined) throw new Error('need a seed');
          return conformant.priceBatch!(input);
        },
      }),
      /priceBatch\(\) without request\.seed threw the wrong refusal/,
    );
  });

  it('refutes a seeded batch that reads an undeclared observation under the fixed seed', () => {
    const conformant = seededCashLinePricer();
    expectNonconformant(
      seededCashLinePricer({
        priceBatch: (input) => {
          const rows = conformant.priceBatch!(input);
          const msft = observationFor(input.observations, { kind: 'spot', symbol: 'MSFT' });
          return msft === undefined
            ? rows
            : rows.map((row) => ({ ...row, value: row.value + 1e-6 }));
        },
      }),
      /priceBatch\(\) result changed at item \d+ when undeclared observations were supplied/,
    );
  });

  it('refuses (typed) a probe seed that leaves no safe-integer room for the batch derivation', () => {
    const probes: PricerProbe<CashLine>[] = [
      {
        instrument: AAPL,
        observations: cashObservations(),
        request: { seed: Number.MAX_SAFE_INTEGER },
      },
    ];
    expect(codeOf(() => validatePricer(seededCashLinePricer(), probes))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(() => validatePricer(seededCashLinePricer(), probes)).toThrow(
      /seed \+ 1 exceeds Number\.MAX_SAFE_INTEGER/,
    );
  });

  it('a non-integer or negative probe seed is a fixture error before any pricer verdict', () => {
    const withSeed = (seed: number): PricerProbe<CashLine>[] => [
      { instrument: AAPL, observations: cashObservations(), request: { seed } },
    ];
    expect(codeOf(() => validatePricer(seededCashLinePricer(), withSeed(1.5)))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => validatePricer(seededCashLinePricer(), withSeed(-1)))).toBe(
      ErrorCode.InputWrongShape,
    );
  });
});
