/**
 * 2026-08-23 review P0 — count/resource safety, library-wide wave.
 *
 * `Number.isInteger(1e308)` is `true`, and above 2^53 a loop counter stops advancing — so a public
 * workload control validated with `Number.isInteger` and then looped over or allocated against was
 * a non-terminating loop or an absurd allocation. This file pins the fixed-income guards: XVA paths
 * (safe int, capped at 100,000, with the paths × steps PRODUCT bounded at 10,000,000), lattice
 * steps (capped at 10,000), the schedule's paymentLagDays business-day walk (capped at 260), and
 * the safe-integer discipline on seeds, pillar indices, frequencies, and rollback steps.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  cdsParSpread,
  cdsValue,
  credit,
  curves,
  generateSchedule,
  paymentsPerYear,
  shortRateTree,
  swapXva,
  type XvaParameters,
  type XvaSwapSpecification,
} from '@totalfinance/fixed-income';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const UNSAFE_COUNTS = [2 ** 53, 1e308] as const;

const ref = '2026-01-01';
const curve = curves.fromZeroRates(
  [
    ['2027-01-01', 0.03],
    ['2029-01-01', 0.035],
    ['2032-01-01', 0.04],
  ],
  { referenceDate: ref },
);

const survival = credit.flatHazard({ hazardRate: 0.02, referenceDate: ref });

describe('CDS protection integration — protectionSteps is bounded as an integer and as total work', () => {
  const specification = {
    effectiveDate: ref,
    maturityDate: '2031-01-01',
    spread: 0.01,
  };
  const parSpecification = {
    effectiveDate: specification.effectiveDate,
    maturityDate: specification.maturityDate,
  };
  const cdsCurves = { discountCurve: curve, survivalCurve: survival };

  it('refuses non-positive, fractional, unsafe, absurd, and above-cap protectionSteps on every entrypoint', () => {
    for (const bad of [0, -1, 2.5, 10_001, 2 ** 32, 2 ** 53, 1e308]) {
      const calls = [
        () => cdsValue({ ...specification, protectionSteps: bad }, cdsCurves),
        () => cdsParSpread({ ...parSpecification, protectionSteps: bad }, cdsCurves),
        () =>
          credit.bootstrapHazardFromCds([{ maturity: '2028-01-01', spread: 0.01 }], {
            referenceDate: ref,
            discountCurve: curve,
            protectionSteps: bad,
          }),
        // An empty tenor list proves options are validated before the map, not incidentally inside it.
        () =>
          credit.creditSpreadCurve([], {
            referenceDate: ref,
            discountCurve: curve,
            survivalCurve: survival,
            protectionSteps: bad,
          }),
      ];
      for (const call of calls) {
        const error = catching(call);
        expect(isQuantError(error, 'input.out_of_range'), `protectionSteps ${bad}`).toBe(true);
        expect(String((error as Error).message)).toContain('protectionSteps');
      }
    }

    expect(cdsValue({ ...specification, protectionSteps: 8 }, cdsCurves).value).toBeTypeOf(
      'number',
    );
    expect(cdsParSpread({ ...parSpecification, protectionSteps: 8 }, cdsCurves)).toBeGreaterThan(0);
  });

  it('refuses premium periods × protectionSteps above 1,000,000 before integrating', () => {
    const started = Date.now();
    const error = catching(() =>
      cdsValue(
        {
          ...specification,
          maturityDate: '2126-01-01',
          frequency: 'monthly',
          protectionSteps: 1_000,
        },
        cdsCurves,
      ),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('1,000,000');
    expect(String((error as Error).message)).toContain('×');
  });
});

describe('swapXva — paths are safe integers capped at 100,000, and the paths × steps product is bounded', () => {
  const swap: XvaSwapSpecification = {
    curve,
    startDate: ref,
    maturityDate: '2031-01-01',
    fixedRate: 0.037,
    optionType: 'payer',
    notional: 1_000_000,
    fixedFrequency: 'semiannual',
  };
  const baseParams: XvaParameters = {
    meanReversion: 0.05,
    sigma: 0.01,
    counterpartySurvival: credit.flatHazard({ hazardRate: 0.03, referenceDate: ref }),
    recovery: 0.4,
    seed: 11,
    paths: 200,
    stepsPerYear: 4,
  };

  it('refuses 2^53 / 1e308 / cap + 1 paths typed naming the bound, and accepts a realistic count', () => {
    for (const bad of [...UNSAFE_COUNTS, 100_001, 40.5]) {
      const caught = catching(() => swapXva(swap, { ...baseParams, paths: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `paths ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('paths');
    }
    const atCapPlusOne = catching(() => swapXva(swap, { ...baseParams, paths: 100_001 }));
    expect(String((atCapPlusOne as Error).message)).toContain('100,000');
    const accepted = swapXva(swap, baseParams);
    expect(accepted.cva).toBeGreaterThan(0);
  });

  it('refuses a paths × steps PRODUCT above 10,000,000 even when each factor alone is allowed — and refuses it fast', () => {
    // 100,000 paths (= the cap, allowed alone) × a 5y grid at 1,000 steps/year (5,000 steps,
    // allowed alone) = 5·10^8 path-steps. The refusal is arithmetic, before any simulation.
    const start = Date.now();
    const caught = catching(() =>
      swapXva(swap, { ...baseParams, paths: 100_000, stepsPerYear: 1_000 }),
    );
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('10,000,000');
  });

  it('refuses non-positive, fractional, unsafe, and above-cap stepsPerYear', () => {
    for (const bad of [0, -12, 2.5, 2 ** 53, 1_000_001]) {
      const caught = catching(() => swapXva(swap, { ...baseParams, stepsPerYear: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `stepsPerYear ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('stepsPerYear');
    }
    expect(
      String(
        (catching(() => swapXva(swap, { ...baseParams, stepsPerYear: 1_000_001 })) as Error)
          .message,
      ),
    ).toContain('1,000,000');
  });

  it('refuses a 2^53 seed — adjacent "different" seeds collide up there, so runs are not reproducible', () => {
    const caught = catching(() => swapXva(swap, { ...baseParams, seed: 2 ** 53 }));
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toMatch(/seed must be an integer/);
  });
});

describe('shortRateTree — lattice steps are safe integers capped at 10,000', () => {
  const treeOptions = {
    meanReversion: 0.1,
    sigma: 0.01,
    model: 'hull-white' as const,
    horizonYears: 5,
  };

  it('refuses 2^53 / 1e308 / cap + 1 steps typed naming the bound, and a realistic tree still reprices the curve', () => {
    for (const bad of [...UNSAFE_COUNTS, 10_001, 40.5]) {
      const caught = catching(() => shortRateTree(curve, { ...treeOptions, steps: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `steps ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('steps');
    }
    const atCapPlusOne = catching(() => shortRateTree(curve, { ...treeOptions, steps: 10_001 }));
    expect(String((atCapPlusOne as Error).message)).toContain('10,000');
    const tree = shortRateTree(curve, { ...treeOptions, steps: 20 });
    expect(tree.discountBond(10 * tree.timeStepYears)).toBeCloseTo(
      curve.discount(10 * tree.timeStepYears),
      6,
    );
  });

  it('rollback refuses a 2^53 or fractional terminalStep typed (the ≤ steps bound also rejects the magnitude)', () => {
    const tree = shortRateTree(curve, { ...treeOptions, steps: 20 });
    for (const bad of [2 ** 53, 5.5]) {
      const caught = catching(() => tree.rollback(bad, () => 1));
      expect(isQuantError(caught, 'input.out_of_range'), `terminalStep ${bad}`).toBe(true);
    }
    expect(Number.isFinite(tree.rollback(10, () => 1))).toBe(true);
  });
});

describe('generateSchedule — paymentLagDays is a safe integer capped at 260 (each lag day is a calendar walk per period)', () => {
  const scheduleOptions = {
    effectiveDate: '2026-01-15',
    maturityDate: '2028-01-15',
    frequency: 'semiannual' as const,
  };

  it('refuses 2^53 / 1e308 / cap + 1 typed naming the bound, and a realistic lag shifts payment dates', () => {
    for (const bad of [...UNSAFE_COUNTS, 261, 2.5]) {
      const caught = catching(() => generateSchedule({ ...scheduleOptions, paymentLagDays: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `paymentLagDays ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('paymentLagDays');
    }
    const atCapPlusOne = catching(() =>
      generateSchedule({ ...scheduleOptions, paymentLagDays: 261 }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('260');
    const lagged = generateSchedule({ ...scheduleOptions, paymentLagDays: 2 });
    const plain = generateSchedule(scheduleOptions);
    expect(lagged).toHaveLength(plain.length);
    expect(lagged[0]!.paymentDate > plain[0]!.paymentDate).toBe(true);
  });
});

describe('paymentsPerYear — the divisor-of-12 rule already pins the domain; the count must also be safe', () => {
  it('refuses 2^53 / 1e308 / fractional frequencies typed and resolves real ones', () => {
    for (const bad of [...UNSAFE_COUNTS, 4.5]) {
      const caught = catching(() => paymentsPerYear(bad));
      expect(isQuantError(caught, 'input.out_of_range'), `frequency ${bad}`).toBe(true);
    }
    expect(paymentsPerYear(4)).toBe(4);
    expect(paymentsPerYear('semiannual')).toBe(2);
  });
});

describe('curves.bumpPillar — the pillar index is a safe integer', () => {
  it('refuses 2^53 / fractional indices typed and bumps a real pillar', () => {
    for (const bad of [2 ** 53, 1e308, 0.5]) {
      const caught = catching(() => curve.bumpPillar(bad, 0.001));
      expect(isQuantError(caught, 'input.out_of_range'), `index ${bad}`).toBe(true);
    }
    const bumped = curve.bumpPillar(1, 0.001);
    expect(bumped.pillars[1]!.zero).toBeCloseTo(curve.pillars[1]!.zero + 0.001, 10);
  });
});
