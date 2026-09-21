/**
 * Tests for §14.4 credit: survival/hazard curves, CDS premium/protection legs and par spread, the
 * hazard bootstrap (reprices every quoted CDS to par), the par-spread term structure, and the
 * credit-triangle approximation.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  bootstrapHazardFromCds,
  cdsBasis,
  cdsParSpread,
  cdsValue,
  credit,
  creditSpreadCurve,
  creditTriangleHazard,
  curves,
  type CdsQuote,
} from '@totalfinance/fixed-income';

const ref = '2026-01-01';
const discountCurve = curves.flat({
  rate: 0.03,
  referenceDate: ref,
  options: { dayCount: 'ACT/365F' },
});

describe('survival / hazard curve', () => {
  it('flat hazard gives Q(t) = exp(−λt) and constant hazard', () => {
    const s = credit.flatHazard({ hazardRate: 0.02, referenceDate: ref });
    expect(s.survival(0)).toBe(1);
    expect(s.survival(5)).toBeCloseTo(Math.exp(-0.02 * 5), 8);
    expect(s.hazard(3)).toBeCloseTo(0.02, 10);
    expect(s.defaultProbability(0, 5)).toBeCloseTo(1 - Math.exp(-0.1), 8);
  });

  it('piecewise-constant hazard accumulates across segments', () => {
    const s = credit.survivalFromHazards(
      [
        ['2027-01-01', 0.01],
        ['2029-01-01', 0.03],
      ],
      { referenceDate: ref },
    );
    const t1 = s.timeTo('2027-01-01');
    const t2 = s.timeTo('2029-01-01');
    expect(s.survival('2027-01-01')).toBeCloseTo(Math.exp(-0.01 * t1), 8);
    expect(s.survival('2029-01-01')).toBeCloseTo(Math.exp(-(0.01 * t1 + 0.03 * (t2 - t1))), 8);
    expect(s.survival('2027-01-01')).toBeGreaterThan(s.survival('2029-01-01')); // monotone
  });

  it('round-trips survival probabilities → hazards → survival', () => {
    const s = credit.survivalFromProbabilities(
      [
        ['2027-01-01', 0.98],
        ['2030-01-01', 0.9],
      ],
      { referenceDate: ref },
    );
    expect(s.survival('2027-01-01')).toBeCloseTo(0.98, 8);
    expect(s.survival('2030-01-01')).toBeCloseTo(0.9, 8);
  });

  it('rejects increasing survival probabilities', () => {
    expect(() =>
      credit.survivalFromProbabilities(
        [
          ['2027-01-01', 0.9],
          ['2030-01-01', 0.95],
        ],
        { referenceDate: ref },
      ),
    ).toThrow(/non-increasing/);
  });
});

describe('CDS pricing', () => {
  const survivalCurve = credit.flatHazard({ hazardRate: 0.025, referenceDate: ref });

  it('a CDS struck at its par spread has ~zero value', () => {
    const specification = {
      effectiveDate: ref,
      maturityDate: '2031-01-01',
      spread: 0,
      recovery: 0.4,
    };
    const { spread: _unused, ...parSpecification } = specification;
    const par = cdsParSpread(parSpecification, { discountCurve, survivalCurve });
    const v = cdsValue({ ...specification, spread: par }, { discountCurve, survivalCurve });
    expect(v.value).toBeCloseTo(0, 9);
    expect(v.parSpread).toBeCloseTo(par, 12);
    expect(v.riskyAnnuity).toBeGreaterThan(0);
  });

  it('par spread ≈ λ·(1 − R) (credit triangle) for a flat curve', () => {
    const par = cdsParSpread(
      { effectiveDate: ref, maturityDate: '2031-01-01', recovery: 0.4 },
      { discountCurve, survivalCurve },
    );
    expect(par).toBeCloseTo(0.025 * (1 - 0.4), 3); // ≈ 150 bp
    expect(creditTriangleHazard({ spread: par, recovery: 0.4 }).value).toBeCloseTo(0.025, 3);
  });

  it('buying protection below par is a positive-value position', () => {
    const par = cdsParSpread(
      { effectiveDate: ref, maturityDate: '2031-01-01', recovery: 0.4 },
      { discountCurve, survivalCurve },
    );
    const v = cdsValue(
      { effectiveDate: ref, maturityDate: '2031-01-01', spread: par - 0.005, recovery: 0.4 },
      { discountCurve, survivalCurve },
    );
    expect(v.value).toBeGreaterThan(0); // paying less than fair ⇒ buyer gains
  });

  it('H03/H01: the spread curve explains its conventions; the basis documents its sign', () => {
    const tenors = ['2028-01-01', '2031-01-01'];
    const points = creditSpreadCurve(tenors, {
      referenceDate: ref,
      discountCurve,
      survivalCurve,
      recovery: 0.4,
      protectionSteps: 8,
    });
    const explained = creditSpreadCurve.explain(tenors, {
      referenceDate: ref,
      discountCurve,
      survivalCurve,
      recovery: 0.4,
      protectionSteps: 8,
    });
    // Same value; every knob the per-tenor CDS ran on echoed — including the two the propagation
    // fix proved MATERIAL (accrualOnDefault, protectionSteps).
    expect(explained.value).toEqual(points);
    expect(explained.assumptions.protectionSteps).toBe(8);
    expect(explained.assumptions.accrualOnDefault).toBe(true);
    expect(explained.assumptions.dayCount).toBe('ACT/360');
    // H01: positive basis = CDS rich relative to the bond.
    expect(cdsBasis({ cdsParSpread: 0.012, bondImpliedSpread: 0.009 })).toBeCloseTo(0.003, 12);
  });

  it('H02: a par-spread request REJECTS the irrelevant current spread, and explains its legs', () => {
    // Before H02 this call REQUIRED spread (input.missing_field without it) — the par spread is
    // the answer, so demanding a current spread demanded an input the calculation never reads.
    const parSpecification = { effectiveDate: ref, maturityDate: '2031-01-01', recovery: 0.4 };
    const par = cdsParSpread(parSpecification, { discountCurve, survivalCurve });
    expect(Number.isFinite(par)).toBe(true);
    // Law 12: passing the irrelevant field teaches rather than silently implying it mattered.
    let caught: unknown;
    try {
      cdsParSpread({ ...parSpecification, spread: 0.01 } as never, {
        discountCurve,
        survivalCurve,
      });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.unknown_field')).toBe(true);
    // The explain twin returns the SAME value and discloses the arithmetic it came from.
    const explained = cdsParSpread.explain(parSpecification, { discountCurve, survivalCurve });
    expect(explained.value).toBeCloseTo(par, 15);
    const legs = explained.diagnostics.decomposition!;
    expect(explained.value).toBeCloseTo(legs['protectionLeg']! / legs['riskyAnnuity']!, 12);
    expect(explained.assumptions.recovery).toBe(0.4);
    expect(explained.assumptions.dayCount).toBe('ACT/360');
  });

  it('a wider protection window (lower recovery) costs more', () => {
    const base = { effectiveDate: ref, maturityDate: '2031-01-01', spread: 0.015 };
    const lowR = cdsValue({ ...base, recovery: 0.2 }, { discountCurve, survivalCurve });
    const highR = cdsValue({ ...base, recovery: 0.6 }, { discountCurve, survivalCurve });
    expect(lowR.protectionLeg).toBeGreaterThan(highR.protectionLeg);
  });
});

describe('hazard bootstrap from CDS spreads', () => {
  const quotes: CdsQuote[] = [
    { maturity: '2027-01-01', spread: 0.008 },
    { maturity: '2029-01-01', spread: 0.012 },
    { maturity: '2031-01-01', spread: 0.016 },
    { maturity: '2036-01-01', spread: 0.02 },
  ];

  it('reprices every quoted CDS to par', () => {
    const survivalCurve = bootstrapHazardFromCds(quotes, {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
    });
    for (const q of quotes) {
      const par = cdsParSpread(
        { effectiveDate: ref, maturityDate: q.maturity, recovery: 0.4 },
        { discountCurve, survivalCurve },
      );
      expect(par).toBeCloseTo(q.spread, 8);
    }
  });

  it('an upward spread curve implies a rising hazard term structure', () => {
    const survivalCurve = bootstrapHazardFromCds(quotes, {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
    });
    const hazards = survivalCurve.pillars.map((p) => p.hazard);
    for (let i = 1; i < hazards.length; i++) {
      expect(hazards[i]!).toBeGreaterThan(hazards[i - 1]!);
    }
  });

  it('the recovered spread curve matches the input quotes', () => {
    const survivalCurve = bootstrapHazardFromCds(quotes, {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
    });
    const curve = creditSpreadCurve(
      quotes.map((q) => q.maturity),
      { referenceDate: ref, discountCurve, recovery: 0.4, survivalCurve },
    );
    curve.forEach((row, i) => expect(row.parSpread).toBeCloseTo(quotes[i]!.spread, 8));
  });

  it('forwards accrualOnDefault and protectionSteps to every tenor (round-trip on NON-default options)', () => {
    // `creditSpreadCurve` ACCEPTED these two conventions and then dropped them on the floor, so a
    // curve read back on the same options the bootstrap was calibrated with was priced on
    // DIFFERENT conventions than it was built on. The error is small and everywhere: no
    // accrual-on-default and a coarse protection integral shift every recovered spread by a
    // fraction of a basis point, with nothing in the result to say the request was ignored.
    const options = {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
      accrualOnDefault: false, // NOT the default (true)
      protectionSteps: 12, // NOT the default (4)
    } as const;
    const survivalCurve = bootstrapHazardFromCds(quotes, options);
    const curve = creditSpreadCurve(
      quotes.map((q) => q.maturity),
      { ...options, survivalCurve },
    );
    // Basis points of error, not decimals: the round trip must recover each quote to ≤ 0.01bp.
    curve.forEach((row, i) => {
      const errorBp = Math.abs(row.parSpread - quotes[i]!.spread) * 1e4;
      expect(errorBp).toBeLessThan(0.01);
    });
  });

  it('the dropped options were MATERIAL: honoring them moves the recovered spreads', () => {
    // Guards the fix against being quietly reverted: if the forwarding is removed, the two curves
    // below become identical and this fails.
    const options = {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
      accrualOnDefault: false,
      protectionSteps: 12,
    } as const;
    const survivalCurve = bootstrapHazardFromCds(quotes, options);
    const honored = creditSpreadCurve(
      quotes.map((q) => q.maturity),
      { ...options, survivalCurve },
    );
    const dropped = creditSpreadCurve(
      quotes.map((q) => q.maturity),
      { referenceDate: ref, discountCurve, recovery: 0.4, survivalCurve },
    );
    const worstDroppedErrorBp = Math.max(
      ...dropped.map((row, i) => Math.abs(row.parSpread - quotes[i]!.spread) * 1e4),
    );
    const worstHonoredErrorBp = Math.max(
      ...honored.map((row, i) => Math.abs(row.parSpread - quotes[i]!.spread) * 1e4),
    );
    expect(worstDroppedErrorBp).toBeGreaterThan(0.1); // the old behavior, ~0.24bp off
    expect(worstHonoredErrorBp).toBeLessThan(0.01);
  });
});

describe('credit input guards (codemod-litter cleanup)', () => {
  it('creditSpreadCurve validates options even when the tenor list is empty', () => {
    // The guard used to sit INSIDE tenors.map — an empty list skipped validation entirely.
    expect(() => creditSpreadCurve([], undefined as never)).toThrow(
      /creditSpreadCurve: options must be an object/,
    );
    expect(() => creditSpreadCurve([], 42 as never)).toThrow(
      /creditSpreadCurve: options must be an object/,
    );

    const survivalCurve = credit.flatHazard({ hazardRate: 0.02, referenceDate: ref });
    for (const referenceDate of [undefined, null, '', 'not-a-date', '2025-02-30', 20260101]) {
      const options = { referenceDate, discountCurve, survivalCurve } as never;
      const error = (() => {
        try {
          creditSpreadCurve([], options);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(isQuantError(error), `referenceDate = ${String(referenceDate)}`).toBe(true);
      expect(String((error as Error).message)).toMatch(/referenceDate|ISO date/);
    }
  });

  it('creditSpreadCurve with an empty tenor list and valid options returns an empty curve', () => {
    const survivalCurve = credit.flatHazard({ hazardRate: 0.02, referenceDate: ref });
    const rows = creditSpreadCurve([], {
      referenceDate: ref,
      discountCurve,
      recovery: 0.4,
      survivalCurve,
    });
    expect(rows).toEqual([]);
  });

  it('bootstrapHazardFromCds guards both arguments with the credit.-prefixed label', () => {
    expect(() => bootstrapHazardFromCds('quotes' as never, undefined as never)).toThrow(
      /credit\.bootstrapHazardFromCds: quotes must be an array/,
    );
    expect(() =>
      bootstrapHazardFromCds([{ maturity: '2027-01-01', spread: 0.01 }], undefined as never),
    ).toThrow(/credit\.bootstrapHazardFromCds: options must be an object/);
    let missingReferenceDate: unknown;
    try {
      bootstrapHazardFromCds([{ maturity: '2027-01-01', spread: 0.01 }], {
        discountCurve,
      } as never);
    } catch (error) {
      missingReferenceDate = error;
    }
    expect(isQuantError(missingReferenceDate, 'input.missing_field')).toBe(true);
    expect(String((missingReferenceDate as Error).message)).toContain('options.referenceDate');
    expect(String((missingReferenceDate as Error).message)).toContain('discountCurve');
    expect(String((missingReferenceDate as Error).message)).not.toContain('survivalCurve');
  });

  // Deep-sweep regression: a curves bundle that IS an object but is missing a member used to die on
  // the first `.discount()` / `.survival()` call inside the leg integration (raw TypeError).
  it('cdsValue / cdsParSpread name the missing curve in an incomplete curves bundle', () => {
    const specification = {
      effectiveDate: ref,
      maturityDate: '2029-01-01',
      spread: 0.015,
      recovery: 0.4,
    };
    const survivalCurve = credit.flatHazard({ hazardRate: 0.02, referenceDate: ref });
    expect(() => cdsValue(specification, {} as never)).toThrow(
      /cdsValue: curves\.discountCurve must be a yield curve/,
    );
    expect(() => cdsValue(specification, { discountCurve } as never)).toThrow(
      /cdsValue: curves\.survivalCurve must be a survival curve/,
    );
    expect(() => cdsParSpread(specification, { survivalCurve } as never)).toThrow(
      /cdsParSpread: curves\.discountCurve must be a yield curve/,
    );
    expect(() =>
      cdsParSpread(specification, { discountCurve, survivalCurve: {} } as never),
    ).toThrow(/cdsParSpread: curves\.survivalCurve must be a survival curve/);
  });

  it('bootstrapHazardFromCds and creditSpreadCurve name a missing/raw curve in options', () => {
    const survivalCurve = credit.flatHazard({ hazardRate: 0.02, referenceDate: ref });
    expect(() =>
      bootstrapHazardFromCds([{ maturity: '2027-01-01', spread: 0.01 }], {
        referenceDate: ref,
      } as never),
    ).toThrow(/credit\.bootstrapHazardFromCds: options\.discountCurve must be a yield curve/);
    expect(() =>
      creditSpreadCurve(['2027-01-01'], { referenceDate: ref, survivalCurve } as never),
    ).toThrow(/creditSpreadCurve: options\.discountCurve must be a yield curve/);
    expect(() =>
      creditSpreadCurve(['2027-01-01'], { referenceDate: ref, discountCurve } as never),
    ).toThrow(/creditSpreadCurve: options\.survivalCurve must be a survival curve/);
  });
});

describe('CDS basis', () => {
  it('is the CDS spread minus the bond-implied spread', () => {
    expect(cdsBasis({ cdsParSpread: 0.012, bondImpliedSpread: 0.01 })).toBeCloseTo(0.002, 12); // CDS rich (positive basis)
    expect(cdsBasis({ cdsParSpread: 0.009, bondImpliedSpread: 0.011 })).toBeCloseTo(-0.002, 12); // CDS cheap (negative basis)
  });
});
