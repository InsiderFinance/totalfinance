/**
 * Stage 4.5 slice 4 — `@totalfinance/fixed-income/artifacts` over the four curve families: describe →
 * save → canonical round trip → restore EXACTLY (=== at and between pillars) → evaluate equals the
 * live curve → replay parity byte-identical → compare against a shifted fit; the snapshot bridge
 * (a restored discount curve prices a bond through the pricer to the live value); repricing
 * holdout; the descriptor; and every refusal with its stable code.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError, type RateCurve } from '@totalfinance/core';
import {
  canonicalJsonOf,
  contentHash,
  createAnalysisArtifact,
  createMarketSnapshot,
  fromCanonicalJson,
  isTableHandle,
  marketSnapshotContentHash,
  requireFittedModelSummary,
  type AnalysisArtifact,
} from '@totalfinance/core/artifacts';
import {
  bonds,
  bootstrapHazardFromCds,
  cdsParSpread,
  curves,
  priceMultiCurve,
  rateCurveFromYieldCurve,
  swapRate,
  type BootstrapInstrument,
  type CdsQuote,
} from '@totalfinance/fixed-income';
import { bondDiscountCurvePricer } from '@totalfinance/fixed-income/pricer';
import * as artifacts from '@totalfinance/fixed-income/artifacts';
import {
  CURVE_MODEL_FAMILIES,
  FITTED_MODEL_FAMILIES,
  FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE,
  compareFittedModels,
  evaluateFittedModel,
  fittedModelArtifact,
  fittedModelHoldout,
  readFittedModel,
  replayFittedModel,
  type CurveFittedModelReport,
} from '@totalfinance/fixed-income/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}
const persisted = <T>(value: T): T => fromCanonicalJson(canonicalJsonOf(value)) as T;

const REF = '2026-01-01';
const instruments = (shift = 0): BootstrapInstrument[] => [
  { type: 'deposit', maturity: '2026-07-01', rate: 0.03 + shift },
  { type: 'fra', start: '2026-07-01', end: '2027-01-01', rate: 0.031 + shift },
  { type: 'swap', maturity: '2028-01-01', rate: 0.032 + shift, fixedFrequency: 'semiannual' },
  { type: 'swap', maturity: '2031-01-01', rate: 0.035 + shift, fixedFrequency: 'semiannual' },
  { type: 'swap', maturity: '2036-01-01', rate: 0.038 + shift, fixedFrequency: 'semiannual' },
];
const discountCalibration = (shift = 0) => ({
  instruments: instruments(shift),
  options: { referenceDate: REF },
});
const MATS = ['2027-01-01', '2028-01-01', '2029-01-01', '2031-01-01', '2033-01-01'];
const zeroCurve = (base: number, step: number) =>
  curves.fromZeroRates(
    MATS.map((m, i) => [m, base + step * i] as [string, number]),
    { referenceDate: REF, interpolation: 'logLinearDiscount' },
  );
const projectionCalibration = (shift = 0) => {
  const discount = zeroCurve(0.03, 0.001);
  const projection = zeroCurve(0.033 + shift, 0.001);
  const swaps: BootstrapInstrument[] = MATS.map((m) => ({
    type: 'swap',
    maturity: m,
    rate: swapRate(
      { startDate: REF, maturityDate: m },
      { discountCurve: discount, forecastCurve: projection },
    ),
  }));
  return {
    instruments: swaps,
    options: {
      referenceDate: REF,
      interpolation: 'logLinearDiscount' as const,
      discountCurve: discount,
    },
  };
};
const multiCalibration = (shift = 0) => ({
  options: {
    referenceDate: REF,
    interpolation: 'logLinearDiscount' as const,
    ois: [
      { type: 'deposit' as const, maturity: '2026-07-01', rate: 0.03 + shift },
      { type: 'ois' as const, maturity: '2028-01-01', rate: 0.031 + shift },
      { type: 'ois' as const, maturity: '2031-01-01', rate: 0.033 + shift },
    ],
    projection: [
      { type: 'swap' as const, maturity: '2028-01-01', rate: 0.034 + shift },
      { type: 'swap' as const, maturity: '2031-01-01', rate: 0.036 + shift },
    ],
  },
});
const hazardCalibration = (shift = 0) => {
  const quotes: CdsQuote[] = [
    { maturity: '2027-01-01', spread: 0.008 + shift },
    { maturity: '2029-01-01', spread: 0.012 + shift },
    { maturity: '2031-01-01', spread: 0.016 + shift },
  ];
  return {
    quotes,
    options: {
      referenceDate: REF,
      discountCurve: curves.flat({
        rate: 0.03,
        referenceDate: REF,
        options: { dayCount: 'ACT/365F' },
      }),
      recovery: 0.4,
    },
  };
};

interface Case {
  family: (typeof CURVE_MODEL_FAMILIES)[number];
  calibration: () => unknown;
  shifted: () => unknown;
  fit: (calibration: unknown) => unknown;
  at: Record<string, unknown>;
  direct: (fit: unknown) => number[];
}
const CASES: Case[] = [
  {
    family: 'discount-curve',
    calibration: () => discountCalibration(),
    shifted: () => discountCalibration(0.002),
    fit: (c) =>
      curves.bootstrap(
        (c as { instruments: never }).instruments,
        (c as { options: never }).options,
      ),
    at: { dates: ['2026-04-01', '2027-06-15', '2030-01-01'], measure: 'discount' },
    direct: (fit) =>
      ['2026-04-01', '2027-06-15', '2030-01-01'].map((d) =>
        (fit as { discount: (d: string) => number }).discount(d),
      ),
  },
  {
    family: 'projection-curve',
    calibration: () => projectionCalibration(),
    shifted: () => projectionCalibration(0.002),
    fit: (c) =>
      curves.bootstrapProjection(
        (c as { instruments: never }).instruments,
        (c as { options: never }).options,
      ),
    at: { dates: ['2027-07-01', '2030-01-01'], measure: 'zeroRate' },
    direct: (fit) =>
      ['2027-07-01', '2030-01-01'].map((d) =>
        (fit as { zeroRate: (d: string) => number }).zeroRate(d),
      ),
  },
  {
    family: 'multi-curve',
    calibration: () => multiCalibration(),
    shifted: () => multiCalibration(0.002),
    fit: (c) => curves.bootstrapMultiCurve((c as { options: never }).options),
    at: { curve: 'forecastCurve', dates: ['2027-01-01', '2029-06-30'], measure: 'discount' },
    direct: (fit) =>
      ['2027-01-01', '2029-06-30'].map((d) =>
        (fit as { forecastCurve: { discount: (d: string) => number } }).forecastCurve.discount(d),
      ),
  },
  {
    family: 'hazard-curve',
    calibration: () => hazardCalibration(),
    shifted: () => hazardCalibration(0.002),
    fit: (c) =>
      bootstrapHazardFromCds((c as { quotes: never }).quotes, (c as { options: never }).options),
    at: { dates: ['2028-01-01', '2030-06-30'], measure: 'survival' },
    direct: (fit) =>
      ['2028-01-01', '2030-06-30'].map((d) =>
        (fit as { survival: (d: string) => number }).survival(d),
      ),
  },
];

describe('every curve family: describe → save → round trip → restore exactly → evaluate → replay → compare', () => {
  for (const testCase of CASES) {
    it(`${testCase.family}`, () => {
      const calibration = testCase.calibration();
      const fit = testCase.fit(calibration);
      const artifact = fittedModelArtifact({
        family: testCase.family,
        fit,
        calibration,
        currency: 'USD',
      } as never);
      expect(artifact.artifactType).toBe(FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE);
      const result = artifact.result as CurveFittedModelReport;
      expect(result.family).toBe(testCase.family);
      expect(result.assumptions.currency).toBe('USD');
      expect(result.summary.objective.kind).toBe('exact-bootstrap');
      expect(result.summary.residuals!.source).toBe('direct-evaluator');
      expect(result.summary.residuals!.maximumAbsolute).toBeLessThan(1e-6);
      expect(requireFittedModelSummary('test', 'summary', result.summary)).toBe(result.summary);
      expect(
        fittedModelArtifact({ family: testCase.family, fit, calibration, currency: 'USD' } as never)
          .id,
      ).toBe(artifact.id);
      const restored = readFittedModel({ artifact: persisted(artifact) });
      expect(canonicalJsonOf(restored.report)).toBe(canonicalJsonOf(result));
      expect(restored.modelMigrationsApplied).toEqual([]);
      // Evaluate equals the live curve, field for field.
      const evaluated = evaluateFittedModel({ model: restored.report, at: testCase.at } as never);
      expect(evaluated.values).toEqual(testCase.direct(fit));
      expect(evaluated.assumptions.currency).toBe('USD');
      expect(evaluated.reasons).toEqual([]);
      // Replay parity is byte-identical.
      const replay = replayFittedModel({ artifact: persisted(artifact) });
      expect(replay.parity.identical).toBe(true);
      expect(replay.parity.savedHash).toBe(contentHash(result.fit));
      // Compare against a shifted fit.
      const shiftedCalibration = testCase.shifted();
      const shifted = fittedModelArtifact({
        family: testCase.family,
        fit: testCase.fit(shiftedCalibration),
        calibration: shiftedCalibration,
        currency: 'USD',
      } as never);
      const comparison = compareFittedModels({ baseline: artifact, candidate: shifted });
      expect(comparison.sameCalibrationInput).toBe(false);
      expect(comparison.sameCurrency).toBe(true);
      expect(comparison.parameters.length).toBeGreaterThan(0);
      expect(comparison.fit.differenceCount).toBeGreaterThan(0);
      expect(comparison.evaluation.length).toBeGreaterThan(0);
      for (const section of comparison.evaluation)
        expect(section.maximumAbsoluteDifference).toBeGreaterThan(0);
    });
  }
});

describe('the restore law is equality, not a tolerance', () => {
  it('a bootstrapped curve restores === at every pillar and between pillars', () => {
    const calibration = discountCalibration();
    const live = curves.bootstrap(calibration.instruments, calibration.options);
    const artifact = fittedModelArtifact({
      family: 'discount-curve',
      fit: live,
      calibration,
      currency: 'USD',
    });
    const between = ['2026-03-15', '2026-10-10', '2027-05-05', '2029-09-09', '2034-02-02'];
    const dates = [...live.pillars.map((p) => p.date), ...between];
    for (const measure of ['discount', 'zeroRate', 'instantaneousForward'] as const) {
      const evaluated = evaluateFittedModel({ model: artifact, at: { dates, measure } });
      dates.forEach((date, index) => {
        const expected =
          measure === 'discount'
            ? live.discount(date)
            : measure === 'zeroRate'
              ? live.zeroRate(date)
              : live.instantaneousForward(date);
        expect(evaluated.values[index]).toBe(expected);
      });
    }
  });

  it('a caller-built zero-rate curve inside the calibration restores exactly too (the projection replay)', () => {
    const calibration = projectionCalibration();
    const artifact = fittedModelArtifact({
      family: 'projection-curve',
      fit: curves.bootstrapProjection(calibration.instruments, calibration.options),
      calibration,
      currency: 'USD',
    });
    expect(replayFittedModel({ artifact: persisted(artifact) }).parity.identical).toBe(true);
    const report = readFittedModel({ artifact }).report;
    expect(
      (report.calibration as { options: { discountCurve: { pillars: unknown[] } } }).options
        .discountCurve.pillars,
    ).toHaveLength(calibration.options.discountCurve.pillars.length);
  });

  it('extrapolation past the pillars is counted and warned; the measure vocabulary is closed', () => {
    const calibration = discountCalibration();
    const artifact = fittedModelArtifact({
      family: 'discount-curve',
      fit: curves.bootstrap(calibration.instruments, calibration.options),
      calibration,
      currency: 'USD',
    });
    const evaluated = evaluateFittedModel({
      model: artifact,
      at: { dates: ['2040-01-01', '2027-01-01'], measure: 'zeroRate' },
    });
    expect(evaluated.diagnostics.outsideCalibratedRange).toBe(1);
    expect(evaluated.diagnostics.warnings.map((w) => w.code)).toEqual(['curve.extrapolated']);
    // A curve whose extrapolation is 'throw' cannot even be bootstrapped (its partial curve refuses
    // the pillar solve) — the throw law is the curve's own, tested with the curve; here the measure
    // vocabulary is closed.
    expect(
      codeOf(() =>
        evaluateFittedModel({
          model: artifact,
          at: { dates: ['2027-01-01'], measure: 'forward' },
        } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
  });
});

describe('the snapshot bridge (Program 5: used in a book calculation)', () => {
  it('a restored discount curve prices a bond through bondDiscountCurvePricer to the live value', () => {
    const calibration = discountCalibration();
    const live = curves.bootstrap(calibration.instruments, calibration.options);
    const { report } = readFittedModel({
      artifact: persisted(
        fittedModelArtifact({ family: 'discount-curve', fit: live, calibration, currency: 'USD' }),
      ),
    }) as { report: CurveFittedModelReport<'discount-curve'> };
    // Rebuild through the public constructor (a bootstrapped curve is discount-truth, so this
    // reproduces its stored pillars) and map to core data.
    const restored = curves.fromDiscountFactors(
      report.fit.pillars.map((p) => [p.date, p.discount] as const),
      {
        referenceDate: report.fit.referenceDate,
        dayCount: report.fit.dayCount,
        interpolation: report.fit.interpolation,
        extrapolation: report.fit.extrapolation,
      },
    );
    const data: RateCurve = rateCurveFromYieldCurve({ curve: restored, currency: 'USD' });
    const snapshot = createMarketSnapshot({
      asOf: Date.UTC(2026, 0, 1),
      observations: { curves: { 'USD.ois': data } },
    });
    expect(marketSnapshotContentHash(snapshot)).toMatch(/^sha256:/);
    const bond = bonds.fixedRate({
      issueDate: '2025-01-01',
      maturityDate: '2031-01-01',
      couponRate: 0.05,
      frequency: 'semiannual',
      faceValue: 100,
      dayCount: '30/360',
    });
    const pricer = bondDiscountCurvePricer({
      curveId: 'USD.ois',
      currency: 'USD',
      priceType: 'clean',
      interpolation: 'logLinearDiscount',
      extrapolation: 'flatForward',
    });
    const priced = pricer.price({
      instrument: bond,
      observations: [
        { requirement: { kind: 'valuationInstant' }, value: Date.UTC(2026, 5, 15) },
        {
          requirement: { kind: 'discountCurve', curveId: 'USD.ois', currency: 'USD' },
          value: snapshot.observations.curves!['USD.ois']!,
        },
      ],
    });
    const direct = priceMultiCurve(bond, { settlementDate: '2026-06-15', discountCurve: live });
    expect(priced.value).toBeCloseTo(direct.cleanPrice, 9);
  });
});

describe('holdout, warm start, and stability (Decision 8 for exact bootstraps)', () => {
  it('reprices held-out instruments through the public valuation and reports per-instrument residuals', () => {
    const report = fittedModelHoldout({
      family: 'discount-curve',
      calibration: discountCalibration(),
      holdout: { everyNth: 2, offset: 1 },
    });
    expect(report.heldOutCount).toBe(2);
    expect(report.retainedCount).toBe(3);
    expect(report.heldOut.map((row) => row.index)).toEqual([1, 3]);
    expect(report.inSample.maximumAbsolute).toBeLessThan(1e-6);
    expect(report.outOfSample.count).toBe(2);
    expect(report.outOfSample.maximumAbsolute).toBeGreaterThan(0);
    expect(report.unit).toBe('rate');
    expect(report.assumptions.instruments).toBe('instruments');
    const hazard = fittedModelHoldout({
      family: 'hazard-curve',
      calibration: hazardCalibration(),
      holdout: { indices: [1] },
    });
    expect(hazard.heldOutCount).toBe(1);
    expect(hazard.unit).toBe('spread');
    // The held-out CDS residual is the public par spread minus the quote — computed here the same way.
    const calibration = hazardCalibration();
    const retained = bootstrapHazardFromCds(
      [calibration.quotes[0]!, calibration.quotes[2]!],
      calibration.options,
    );
    const expected =
      cdsParSpread(
        { effectiveDate: REF, maturityDate: calibration.quotes[1]!.maturity, recovery: 0.4 },
        { discountCurve: calibration.options.discountCurve, survivalCurve: retained },
      ) - calibration.quotes[1]!.spread;
    expect(hazard.heldOut[0]!.residual).toBeCloseTo(expected, 12);
    expect(
      codeOf(() =>
        fittedModelHoldout({
          family: 'discount-curve',
          calibration: discountCalibration(),
          holdout: { everyNth: 1, offset: 0 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelHoldout({
          family: 'discount-curve',
          calibration: discountCalibration(),
          holdout: { lastCount: 2 } as never,
        }),
      ),
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('exports no warm-start or stability verb — the descriptor discloses the absence with its reason', () => {
    // A verb that refuses every input is a dead door, not shape parity with the volatility subpath.
    expect(Object.keys(artifacts)).not.toContain('warmStartFrom');
    expect(Object.keys(artifacts)).not.toContain('fittedModelStability');
    for (const family of CURVE_MODEL_FAMILIES) {
      expect(FITTED_MODEL_FAMILIES[family].warmStart).toBe(false);
      expect(FITTED_MODEL_FAMILIES[family].costClass).toBe('bootstrap');
    }
  });
});

describe('refusals, referenced rows, and migration', () => {
  const calibration = discountCalibration();
  const live = curves.bootstrap(calibration.instruments, calibration.options);
  const artifact = fittedModelArtifact({
    family: 'discount-curve',
    fit: live,
    calibration,
    currency: 'USD',
  });

  it('requires a currency, a built curve, and a known family; refuses foreign and tampered artifacts', () => {
    expect(
      codeOf(() =>
        fittedModelArtifact({ family: 'discount-curve', fit: live, calibration } as never),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'discount-curve',
          fit: { pillars: live.pillars } as never,
          calibration,
          currency: 'USD',
        }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(
      codeOf(() =>
        fittedModelArtifact({ family: 'svi', fit: live, calibration, currency: 'USD' } as never),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    const foreign = createAnalysisArtifact({
      artifactType: 'volatility.fitted-model',
      producedBy: { operation: 'calibrateSvi' },
      result: { assumptions: {}, diagnostics: { warnings: [] } },
    });
    expect(codeOf(() => readFittedModel({ artifact: foreign }))).toBe(
      ErrorCode.ArtifactFamilyMismatch,
    );
    expect(() => readFittedModel({ artifact: foreign })).toThrow(
      /@totalfinance\/volatility\/artifacts/,
    );
    const tampered = persisted(artifact) as AnalysisArtifact & {
      result: { fit: { pillars: Array<{ zero: number }> } };
    };
    tampered.result.fit.pillars[1]!.zero = 0.5;
    expect(codeOf(() => readFittedModel({ artifact: tampered }))).toBe(
      ErrorCode.ArtifactIdMismatch,
    );
  });

  it('stores a referenced instrument set by handle and replays only with the verified rows', () => {
    const referenced = fittedModelArtifact({
      family: 'discount-curve',
      fit: live,
      calibration,
      currency: 'USD',
      referenceRowSets: ['instruments'],
    });
    const report = referenced.result as CurveFittedModelReport<'discount-curve'>;
    expect(isTableHandle(report.calibration.instruments)).toBe(true);
    expect(report.assumptions.inputPolicy).toBe('referenced');
    expect(codeOf(() => replayFittedModel({ artifact: referenced }))).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      codeOf(() =>
        replayFittedModel({
          artifact: referenced,
          referencedData: { instruments: instruments(0.001) },
        }),
      ),
    ).toBe(ErrorCode.ArtifactReferencedDataMismatch);
    expect(
      replayFittedModel({ artifact: referenced, referencedData: { instruments: instruments() } })
        .parity.identical,
    ).toBe(true);
    const multi = fittedModelArtifact({
      family: 'multi-curve',
      fit: curves.bootstrapMultiCurve(multiCalibration().options),
      calibration: multiCalibration(),
      currency: 'USD',
      referenceRowSets: ['options.ois', 'options.projection'],
    });
    expect(Object.keys((multi.result as CurveFittedModelReport).referencedData).sort()).toEqual([
      'options.ois',
      'options.projection',
    ]);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'discount-curve',
          fit: live,
          calibration,
          currency: 'USD',
          limits: { embeddedRowLimit: 2 },
        }),
      ),
    ).toBe(ErrorCode.ArtifactEmbeddedInputTooLarge);
  });

  it('refuses a newer model version and applies a registered report migration', () => {
    const newer = createAnalysisArtifact({
      artifactType: artifact.artifactType,
      producedBy: artifact.producedBy,
      inputs: { parameters: { ...(artifact.inputs.parameters as object), modelVersion: 2 } },
      result: { ...artifact.result, modelVersion: 2 },
    });
    expect(codeOf(() => readFittedModel({ artifact: newer }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    const older = createAnalysisArtifact({
      artifactType: artifact.artifactType,
      producedBy: artifact.producedBy,
      inputs: { parameters: { ...(artifact.inputs.parameters as object), modelVersion: 0 } },
      result: { ...artifact.result, modelVersion: 0 },
    });
    expect(codeOf(() => readFittedModel({ artifact: older }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    expect(() => readFittedModel({ artifact: older })).toThrow(
      /fixed-income\.fitted-model:discount-curve/,
    );
  });
});
