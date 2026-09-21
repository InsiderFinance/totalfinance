/**
 * FC6 — commodity carry and term structure. The acceptance laws, each visible below:
 * cost-of-carry parity and inverse implied-input recovery at 1e-12; scale/unit transformations
 * preserve economics under an explicit conversion; contango/backwardation classification is
 * stable under tolerance and reports indeterminate for contradictory curves; roll decomposition
 * reconciles to the observed total return within the declared 1e-12 residual.
 */

import { describe, expect, it } from 'vitest';
import {
  calendarSpread,
  commodityBasis,
  commodityCarry,
  commodityForwardPrice,
  commodityForwardValue,
  convertCommodityQuantity,
  curveSpreadAnalytics,
  futuresHedgeRatio,
  impliedConvenienceYield,
  impliedStorageCost,
  rollReturnDecomposition,
  rollYield,
  seasonalityProfile,
  termStructureState,
} from '../src/index.js';
import type { CommodityCurvePoint } from '../src/index.js';
import { commodityForwardPrice as forwardPriceViaSubpath } from '@totalfinance/commodities/forwards';
import { termStructureState as termStructureStateViaSubpath } from '@totalfinance/commodities/term-structure';
import { commodityBasis as basisViaScopedRoot } from '@totalfinance/commodities';

const close = (actual: number, expected: number, tolerance = 1e-12): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe('commodityForwardPrice', () => {
  it('prices the FROZEN first-touch call exactly as spot × e^((f + s − c) × t)', () => {
    const forward = commodityForwardPrice({
      spotPrice: 72,
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
      compounding: 'continuous',
    });
    // Bit-for-bit against the definition: 72 · e^((0.05 + 0.02 − 0.01) · 0.5).
    expect(forward).toBe(72 * Math.exp((0.05 + 0.02 - 0.01) * 0.5));
    close(forward, 74.192726444653, 1e-9); // hand: 72 · e^0.03 = 72 × 1.0304545339535168…
  });

  it('prices an annual-compounding forward: 100 × 1.05² = 110.25', () => {
    const forward = commodityForwardPrice({
      spotPrice: 100,
      timeToDeliveryYears: 2,
      annualFinancingRate: 0.06,
      annualStorageCostRate: 0.01,
      annualConvenienceYield: 0.02,
      compounding: 'annual',
    });
    expect(forward).toBe(100 * Math.pow(1 + (0.06 + 0.01 - 0.02), 2));
    close(forward, 110.25, 1e-9); // net carry 0.05, (1.05)² = 1.1025
  });

  it('scale law: doubling the spot doubles the forward EXACTLY', () => {
    const base = {
      timeToDeliveryYears: 0.5,
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
      compounding: 'continuous',
    } as const;
    const atSpot = commodityForwardPrice({ spotPrice: 72, ...base });
    const atDoubleSpot = commodityForwardPrice({ spotPrice: 144, ...base });
    expect(atDoubleSpot).toBe(2 * atSpot);
  });

  it('at zero time to delivery the forward IS the spot', () => {
    expect(
      commodityForwardPrice({
        spotPrice: 72,
        timeToDeliveryYears: 0,
        annualFinancingRate: 0.05,
        annualStorageCostRate: 0.02,
        annualConvenienceYield: 0.01,
        compounding: 'annual',
      }),
    ).toBe(72);
  });

  it('teaches: a negative spot is refused', () => {
    expect(() =>
      commodityForwardPrice({
        spotPrice: -72,
        timeToDeliveryYears: 0.5,
        annualFinancingRate: 0.05,
        annualStorageCostRate: 0.02,
        annualConvenienceYield: 0.01,
        compounding: 'continuous',
      }),
    ).toThrow(/spotPrice must be > 0/);
  });

  it('teaches: compounding is REQUIRED — a market instrument never defaults its convention', () => {
    expect(() =>
      commodityForwardPrice({
        spotPrice: 72,
        timeToDeliveryYears: 0.5,
        annualFinancingRate: 0.05,
        annualStorageCostRate: 0.02,
        annualConvenienceYield: 0.01,
      } as never),
    ).toThrow(/compounding is required/);
  });

  it('teaches: an unknown key is refused, with a suggestion', () => {
    expect(() =>
      commodityForwardPrice({
        spotPrice: 72,
        timeToDeliveryYears: 0.5,
        annualFinancingRate: 0.05,
        annualStorageCostRate: 0.02,
        annualConvienceYield: 0.01,
        compounding: 'continuous',
      } as never),
    ).toThrow(/unknown field "annualConvienceYield"/);
  });
});

describe('cost-of-carry parity — inverse implied-input recovery (the acceptance law, 1e-12)', () => {
  const spotPrice = 72;
  const timeToDeliveryYears = 0.5;
  const annualFinancingRate = 0.05;
  const annualStorageCostRate = 0.02;
  const annualConvenienceYield = 0.01;

  it('impliedConvenienceYield recovers the c that priced the forward (continuous)', () => {
    const forwardPrice = commodityForwardPrice({
      spotPrice,
      timeToDeliveryYears,
      annualFinancingRate,
      annualStorageCostRate,
      annualConvenienceYield,
      compounding: 'continuous',
    });
    const result = impliedConvenienceYield({
      spotPrice,
      forwardPrice,
      timeToDeliveryYears,
      annualFinancingRate,
      annualStorageCostRate,
      compounding: 'continuous',
    });
    close(result.impliedAnnualConvenienceYield, annualConvenienceYield);
    expect(result.diagnostics.warnings).toEqual([]);
  });

  it('impliedStorageCost recovers the s that priced the forward (continuous)', () => {
    const forwardPrice = commodityForwardPrice({
      spotPrice,
      timeToDeliveryYears,
      annualFinancingRate,
      annualStorageCostRate,
      annualConvenienceYield,
      compounding: 'continuous',
    });
    const result = impliedStorageCost({
      spotPrice,
      forwardPrice,
      timeToDeliveryYears,
      annualFinancingRate,
      annualConvenienceYield,
      compounding: 'continuous',
    });
    close(result.impliedAnnualStorageCostRate, annualStorageCostRate);
  });

  it('the round trip also holds under annual compounding (the inversion matches the convention)', () => {
    const forwardPrice = commodityForwardPrice({
      spotPrice,
      timeToDeliveryYears,
      annualFinancingRate,
      annualStorageCostRate,
      annualConvenienceYield,
      compounding: 'annual',
    });
    close(
      impliedConvenienceYield({
        spotPrice,
        forwardPrice,
        timeToDeliveryYears,
        annualFinancingRate,
        annualStorageCostRate,
        compounding: 'annual',
      }).impliedAnnualConvenienceYield,
      annualConvenienceYield,
    );
    close(
      impliedStorageCost({
        spotPrice,
        forwardPrice,
        timeToDeliveryYears,
        annualFinancingRate,
        annualConvenienceYield,
        compounding: 'annual',
      }).impliedAnnualStorageCostRate,
      annualStorageCostRate,
    );
  });
});

describe('commodityCarry', () => {
  it('a parity-priced forward has residual zero and no warning', () => {
    const forwardPrice = 72 * Math.exp((0.05 + 0.02 - 0.01) * 0.5);
    const result = commodityCarry({
      spotPrice: 72,
      forwardPrice,
      timeToDeliveryYears: 0.5,
      compounding: 'continuous',
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
    });
    // annualizedCarryRate = ln(F/S)/t = ln(e^0.03)/0.5 = 0.06.
    close(result.annualizedCarryRate, 0.06);
    expect(result.impliedResidual).toBeDefined();
    close(result.impliedResidual!, 0);
    expect(result.diagnostics.warnings).toEqual([]);
    expect(result.components).toEqual({
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
    });
  });

  it('a mispriced forward reports a nonzero residual AND warns — the parity law made visible', () => {
    const parityForward = 72 * Math.exp((0.05 + 0.02 - 0.01) * 0.5);
    const result = commodityCarry({
      spotPrice: 72,
      forwardPrice: parityForward * 1.01,
      timeToDeliveryYears: 0.5,
      compounding: 'continuous',
      annualFinancingRate: 0.05,
      annualStorageCostRate: 0.02,
      annualConvenienceYield: 0.01,
    });
    // Extra carry from the 1% bump: ln(1.01)/0.5 ≈ 0.0199007 — far beyond the 1e-9 gate.
    close(result.impliedResidual!, Math.log(1.01) / 0.5);
    expect(result.diagnostics.warnings.some((w) => w.includes('parity'))).toBe(true);
  });

  it('with a partial component set the residual is absent, with the reason warned', () => {
    const result = commodityCarry({
      spotPrice: 72,
      forwardPrice: 74,
      timeToDeliveryYears: 0.5,
      compounding: 'continuous',
      annualFinancingRate: 0.05,
    });
    expect(result.impliedResidual).toBeUndefined();
    expect(result.components).toEqual({ annualFinancingRate: 0.05 });
    expect(result.diagnostics.warnings.some((w) => w.includes('all three'))).toBe(true);
  });
});

describe('commodityForwardValue', () => {
  it('values the long side: (74 − 70) × 1000 × 0.98 = 3920', () => {
    const result = commodityForwardValue({
      contractForwardPrice: 70,
      currentForwardPrice: 74,
      quantity: 1000,
      discountFactorToDelivery: 0.98,
      perspective: 'long',
    });
    close(result.contractValue, 3920, 1e-9);
    expect(result.assumptions.perspective).toBe('long');
  });

  it('the short side is the exact negation, and a fairly-struck contract is worth zero', () => {
    const short = commodityForwardValue({
      contractForwardPrice: 70,
      currentForwardPrice: 74,
      quantity: 1000,
      discountFactorToDelivery: 0.98,
      perspective: 'short',
    });
    close(short.contractValue, -3920, 1e-9);
    const fair = commodityForwardValue({
      contractForwardPrice: 74,
      currentForwardPrice: 74,
      quantity: 1000,
      discountFactorToDelivery: 0.98,
      perspective: 'long',
    });
    expect(fair.contractValue).toBe(0);
  });
});

describe('futuresHedgeRatio', () => {
  it('is one-to-one by default and does NOT round', () => {
    const result = futuresHedgeRatio({ exposureQuantity: 2500, futuresContractSize: 1000 });
    expect(result.contractsRequired).toBe(2.5);
    expect(result.assumptions.hedgeRatioBasis).toBe('one-to-one');
    expect(result.assumptions.betaOrHedgeEffectiveness).toBe(1);
  });

  it('applies a caller-supplied beta and says where it came from', () => {
    const result = futuresHedgeRatio({
      exposureQuantity: 25_000,
      futuresContractSize: 1000,
      betaOrHedgeEffectiveness: 0.92,
    });
    close(result.contractsRequired, 23, 1e-9);
    expect(result.assumptions.hedgeRatioBasis).toBe('caller-supplied beta or hedge effectiveness');
  });
});

describe('commodityBasis', () => {
  it('names basis and basisFraction as the DIFFERENT quantities they are', () => {
    const result = commodityBasis({ spotPrice: 72, futuresPrice: 73.5 });
    expect(result.basis).toBe(72 - 73.5);
    expect(result.basisFraction).toBe(72 / 73.5 - 1);
  });
});

describe('termStructureState', () => {
  const rising: CommodityCurvePoint[] = [
    { timeToDeliveryYears: 0.25, forwardPrice: 100 },
    { timeToDeliveryYears: 0.5, forwardPrice: 101 },
    { timeToDeliveryYears: 1, forwardPrice: 103 },
  ];
  const falling: CommodityCurvePoint[] = [
    { timeToDeliveryYears: 0.25, forwardPrice: 100 },
    { timeToDeliveryYears: 0.5, forwardPrice: 99 },
    { timeToDeliveryYears: 1, forwardPrice: 97 },
  ];
  // Pairwise fractional slopes: +0.0002, −0.0003, +0.0002 — all inside ±0.001, not inside ±0.00001.
  const wiggle: CommodityCurvePoint[] = [
    { timeToDeliveryYears: 0.25, forwardPrice: 100 },
    { timeToDeliveryYears: 0.5, forwardPrice: 100.02 },
    { timeToDeliveryYears: 0.75, forwardPrice: 99.99 },
    { timeToDeliveryYears: 1, forwardPrice: 100.01 },
  ];

  it('a monotone rising curve is contango', () => {
    const result = termStructureState({ curve: rising, flatToleranceFraction: 0.001 });
    expect(result.state).toBe('contango');
    expect(result.diagnostics).toMatchObject({
      risingSegmentCount: 2,
      fallingSegmentCount: 0,
      flatSegmentCount: 0,
    });
  });

  it('a monotone falling curve is backwardation', () => {
    expect(termStructureState({ curve: falling, flatToleranceFraction: 0.001 }).state).toBe(
      'backwardation',
    );
  });

  it('a within-tolerance wiggle is flat', () => {
    const result = termStructureState({ curve: wiggle, flatToleranceFraction: 0.001 });
    expect(result.state).toBe('flat');
    expect(result.diagnostics.flatSegmentCount).toBe(3);
    expect(result.diagnostics.warnings).toEqual([]);
  });

  it('the SAME wiggly curve flips flat → indeterminate as the tolerance tightens (stability under tolerance)', () => {
    const loose = termStructureState({ curve: wiggle, flatToleranceFraction: 0.001 });
    const tight = termStructureState({ curve: wiggle, flatToleranceFraction: 0.00001 });
    expect(loose.state).toBe('flat');
    expect(tight.state).toBe('indeterminate');
    expect(tight.diagnostics).toMatchObject({
      risingSegmentCount: 2,
      fallingSegmentCount: 1,
      flatSegmentCount: 0,
    });
    // The contradictory segments are NAMED, not averaged away.
    expect(tight.diagnostics.warnings[0]).toMatch(/rising \[0\.25y→0\.5y, 0\.75y→1y\]/);
    expect(tight.diagnostics.warnings[0]).toMatch(/falling \[0\.5y→0\.75y\]/);
  });

  it('rising mixed with flat is indeterminate under the strict all-segments definition', () => {
    const risingThenFlat: CommodityCurvePoint[] = [
      { timeToDeliveryYears: 0.25, forwardPrice: 100 },
      { timeToDeliveryYears: 0.5, forwardPrice: 101 },
      { timeToDeliveryYears: 0.75, forwardPrice: 101.0001 },
    ];
    const result = termStructureState({ curve: risingThenFlat, flatToleranceFraction: 0.001 });
    expect(result.state).toBe('indeterminate');
    expect(result.diagnostics).toMatchObject({ risingSegmentCount: 1, flatSegmentCount: 1 });
  });

  it('teaches: a single-point curve has no slope to classify', () => {
    expect(() =>
      termStructureState({
        curve: [{ timeToDeliveryYears: 0.25, forwardPrice: 100 }],
        flatToleranceFraction: 0.001,
      }),
    ).toThrow(/at least 2/);
  });

  it('teaches: a non-ascending curve is refused with the failing index named', () => {
    expect(() =>
      termStructureState({
        curve: [
          { timeToDeliveryYears: 0.5, forwardPrice: 100 },
          { timeToDeliveryYears: 0.25, forwardPrice: 99 },
        ],
        flatToleranceFraction: 0.001,
      }),
    ).toThrow(/curve\[1\]\.timeToDeliveryYears \(0\.25\) must be strictly greater/);
  });
});

describe('calendarSpread', () => {
  it('golden: spread 2, annualized rate ln(102/100) / 0.5 — against Math.log', () => {
    const result = calendarSpread({
      nearPoint: { timeToDeliveryYears: 0.25, forwardPrice: 100 },
      farPoint: { timeToDeliveryYears: 0.75, forwardPrice: 102 },
    });
    expect(result.spread).toBe(2);
    expect(result.annualizedSpreadRate).toBe(Math.log(102 / 100) / (0.75 - 0.25));
    close(result.annualizedSpreadRate, 0.039605254592359, 1e-12); // hand: ln(1.02) = 0.0198026272961797…, ÷ 0.5
  });

  it('teaches: near must be strictly nearer than far — no silent sign flip', () => {
    expect(() =>
      calendarSpread({
        nearPoint: { timeToDeliveryYears: 0.75, forwardPrice: 102 },
        farPoint: { timeToDeliveryYears: 0.25, forwardPrice: 100 },
      }),
    ).toThrow(/strictly less than/);
  });
});

describe('curveSpreadAnalytics', () => {
  it('reports every adjacent pair plus the front-to-back figures', () => {
    const result = curveSpreadAnalytics({
      curve: [
        { timeToDeliveryYears: 0.25, forwardPrice: 100 },
        { timeToDeliveryYears: 0.5, forwardPrice: 101 },
        { timeToDeliveryYears: 1, forwardPrice: 103 },
      ],
    });
    expect(result.adjacentSpreads).toHaveLength(2);
    expect(result.adjacentSpreads[0]).toEqual({
      fromTimeYears: 0.25,
      toTimeYears: 0.5,
      spread: 1,
      annualizedSpreadRate: Math.log(101 / 100) / 0.25,
    });
    expect(result.adjacentSpreads[1]).toEqual({
      fromTimeYears: 0.5,
      toTimeYears: 1,
      spread: 2,
      annualizedSpreadRate: Math.log(103 / 101) / 0.5,
    });
    expect(result.frontToBack).toEqual({
      fromTimeYears: 0.25,
      toTimeYears: 1,
      spread: 3,
      annualizedSpreadRate: Math.log(103 / 100) / 0.75,
    });
  });
});

describe('rollYield — the sign law', () => {
  it('a backwardated pair rolls POSITIVE for a long', () => {
    const result = rollYield({ expiringContractPrice: 100, nextContractPrice: 95 });
    expect(result.rollYieldFraction).toBe((100 - 95) / 95);
    expect(result.rollYieldFraction).toBeGreaterThan(0);
  });

  it('a contango pair rolls NEGATIVE for a long', () => {
    const result = rollYield({ expiringContractPrice: 100, nextContractPrice: 105 });
    expect(result.rollYieldFraction).toBeLessThan(0);
  });

  it('with spot supplied, the spot-relative components compound EXACTLY back to the roll yield', () => {
    const result = rollYield({
      expiringContractPrice: 100,
      nextContractPrice: 95,
      spotPriceAtRoll: 100,
    });
    const { expiringVersusSpotFraction, nextVersusSpotFraction } = result.decomposition!;
    expect(expiringVersusSpotFraction).toBe(0); // rolled at expiry: contract sits on spot
    expect(nextVersusSpotFraction).toBe((95 - 100) / 100); // the backwardated slope, −0.05
    // The identity: (1 + rollYield) = (1 + e) / (1 + n), since (E/S)/(N/S) = E/N.
    close(
      1 + result.rollYieldFraction,
      (1 + expiringVersusSpotFraction) / (1 + nextVersusSpotFraction),
    );
  });

  it('without spot the decomposition is ABSENT with its reason — never guessed', () => {
    const result = rollYield({ expiringContractPrice: 100, nextContractPrice: 95 });
    expect(result.decomposition).toBeUndefined();
    expect(result.decompositionAbsentReason).toMatch(/never guessed/);
  });
});

describe('rollReturnDecomposition — reconciles at 1e-12 (the acceptance law)', () => {
  it('spot move and carry convergence compound exactly to the observed holding total', () => {
    // Hand algebra, with S0=100, S1=104, F0=98, F1=103.5, N=101:
    //   totalHoldingReturn      = F1/F0 − 1 = 103.5/98 − 1        ≈ 0.05612244897959…
    //   spotMoveReturn          = S1/S0 − 1 = 104/100 − 1          = 0.04
    //   carryConvergenceReturn  = (F1/S1)/(F0/S0) − 1 = (103.5·100)/(104·98) − 1
    //                           = 10350/10192 − 1                  ≈ 0.01550235478806…
    //   (1 + spot) × (1 + carry) = (S1/S0) × (F1/S1) × (S0/F0) = F1/F0 = 1 + total. ∎
    const result = rollReturnDecomposition({
      initialSpotPrice: 100,
      finalSpotPrice: 104,
      initialContractPrice: 98,
      finalContractPriceBeforeRoll: 103.5,
      nextContractPriceAtRoll: 101,
    });
    expect(result.totalHoldingReturn).toBe(103.5 / 98 - 1);
    expect(result.spotMoveReturn).toBe(104 / 100 - 1);
    close(result.carryConvergenceReturn, 10350 / 10192 - 1);
    close(
      1 + result.totalHoldingReturn,
      (1 + result.spotMoveReturn) * (1 + result.carryConvergenceReturn),
    );
    expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-12);
    expect(result.diagnostics.warnings).toEqual([]);
    // The roll leg is stated SEPARATELY, never folded into the holding total.
    expect(result.rollLeg.rollYieldFraction).toBe((103.5 - 101) / 101);
    expect(result.assumptions.declaredResidualBound).toBe(1e-12);
  });
});

describe('seasonalityProfile', () => {
  // Two years of monthly observations with JUNE deliberately absent. Values: month for 2024 and
  // month + 2 for 2025 → per-month mean (and median of the pair) = month + 1.
  const observations = [2024, 2025].flatMap((year, yearIndex) =>
    [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12].map((month) => ({
      observationDate: `${year}-${String(month).padStart(2, '0')}-15`,
      value: month + 2 * yearIndex,
    })),
  );

  it('reports the per-month mean, with the empty month null WITH reason', () => {
    const result = seasonalityProfile({ observations, statistic: 'mean' });
    expect(result.months).toHaveLength(12);
    expect(result.months[0]).toMatchObject({ month: 1, observationCount: 2, statisticValue: 2 });
    expect(result.months[11]).toMatchObject({ month: 12, observationCount: 2, statisticValue: 13 });
    const june = result.months[5]!;
    expect(june.month).toBe(6);
    expect(june.observationCount).toBe(0);
    expect(june.statisticValue).toBeNull();
    expect(june.statisticValueAbsentReason).toMatch(/no observations/);
    // Overall mean: Σ(month) over the 11 present months = 78 − 6 = 72 for 2024, 72 + 11×2 = 94
    // for 2025 → (72 + 94) / 22.
    close(result.overallMean, (72 + 94) / 22);
    expect(result.assumptions.statistic).toBe('mean');
  });

  it('median of each two-observation month agrees with the pair midpoint', () => {
    const result = seasonalityProfile({ observations, statistic: 'median' });
    expect(result.months[2]).toMatchObject({ month: 3, statisticValue: 4 });
  });

  it('warns when any month rests on fewer than 3 observations', () => {
    const result = seasonalityProfile({ observations, statistic: 'mean' });
    expect(result.diagnostics.warnings.some((w) => w.includes('fewer than 3'))).toBe(true);
    expect(result.diagnostics.observationCountByMonth).toEqual([
      2, 2, 2, 2, 2, 0, 2, 2, 2, 2, 2, 2,
    ]);
  });

  it('teaches: a malformed observation date names the failing index', () => {
    expect(() =>
      seasonalityProfile({
        observations: [{ observationDate: '2024-13-01', value: 1 }],
        statistic: 'mean',
      }),
    ).toThrow(/observations\[0\]\.observationDate/);
  });
});

describe('convertCommodityQuantity — the scale/unit law', () => {
  it('an explicit factor preserves economics: price-per-unit × quantity is invariant', () => {
    // 1000 barrels at 55 $/barrel is a 55,000 $ notional. Converting the QUANTITY to gallons with
    // the explicit factor 42 (gallons per barrel) means the PRICE converts by the reciprocal:
    //   quantityGallons  = 1000 × 42        = 42,000
    //   pricePerGallon   = 55 / 42
    //   notionalAfter    = 42,000 × (55/42) = 55,000  — the same economics, written out.
    const result = convertCommodityQuantity({
      quantity: 1000,
      fromUnit: 'barrel',
      toUnit: 'gallon',
      conversionFactor: 42,
    });
    expect(result.convertedQuantity).toBe(42_000);
    const notionalBefore = 55 * 1000;
    const pricePerGallon = 55 / 42;
    close(result.convertedQuantity * pricePerGallon, notionalBefore, 1e-9);
    expect(result.assumptions).toMatchObject({
      fromUnit: 'barrel',
      toUnit: 'gallon',
      conversionFactor: 42,
    });
  });

  it('an identity conversion with factor 1 passes the quantity through', () => {
    expect(
      convertCommodityQuantity({
        quantity: 7,
        fromUnit: 'bushel',
        toUnit: 'bushel',
        conversionFactor: 1,
      }).convertedQuantity,
    ).toBe(7);
  });

  it('teaches: an identity conversion with a factor ≠ 1 is a contradiction', () => {
    expect(() =>
      convertCommodityQuantity({
        quantity: 7,
        fromUnit: 'bushel',
        toUnit: 'bushel',
        conversionFactor: 42,
      }),
    ).toThrow(/identity conversion has factor exactly 1/);
  });
});

describe('package wiring', () => {
  it('the ./forwards and ./term-structure subpaths and the scoped root all resolve', () => {
    expect(forwardPriceViaSubpath).toBe(commodityForwardPrice);
    expect(termStructureStateViaSubpath).toBe(termStructureState);
    expect(basisViaScopedRoot).toBe(commodityBasis);
  });
});

describe('overflow is refused, never a successful Infinity (Law 7, review finding)', () => {
  it('the reviewed repro — 5000 years at full carry — teaches instead of returning Infinity', () => {
    expect(() =>
      commodityForwardPrice({
        spotPrice: 72,
        timeToDeliveryYears: 5000,
        annualFinancingRate: 1,
        annualStorageCostRate: 0,
        annualConvenienceYield: 0,
        compounding: 'continuous',
      }),
    ).toThrowError(/not representable in IEEE-754/);
  });
});

describe('seasonality mean stays representable at near-MAX magnitudes (2026-08-23 review wave)', () => {
  it('mean of [1e308, -1e308] is 0 — the answer is representable, so it is computed, not refused', async () => {
    const { seasonalityProfile } = await import('../src/index.js');
    const profile = seasonalityProfile({
      observations: [
        { observationDate: '2025-01-15', value: 1e308 },
        { observationDate: '2025-01-16', value: -1e308 },
      ],
      statistic: 'mean',
    });
    expect(profile.months[0]!.statisticValue).toBe(0);
    expect(profile.overallMean).toBe(0);
  });

  it('mean of [1e308, 1e308] is 1e308', async () => {
    const { seasonalityProfile } = await import('../src/index.js');
    const profile = seasonalityProfile({
      observations: [
        { observationDate: '2025-01-15', value: 1e308 },
        { observationDate: '2025-01-16', value: 1e308 },
      ],
      statistic: 'mean',
    });
    expect(profile.months[0]!.statisticValue).toBe(1e308);
  });
});

describe('seasonality median stays representable at near-MAX magnitudes (2026-08-23, fourth review)', () => {
  it('median of [1e308, -1e308] is 0 — the median branch, not just the mean, is overflow-safe', async () => {
    const { seasonalityProfile } = await import('../src/index.js');
    const profile = seasonalityProfile({
      observations: [
        { observationDate: '2025-01-15', value: 1e308 },
        { observationDate: '2025-01-16', value: -1e308 },
      ],
      statistic: 'median',
    });
    expect(profile.months[0]!.statisticValue).toBe(0);
  });
});
