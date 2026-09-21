/**
 * Stage 4.5 slice 3 — `@totalfinance/volatility/artifacts` over the twelve families (Decisions 2, 3,
 * 5–9): describe → save → canonical round trip → restore → evaluate equals the direct call → replay
 * parity byte-identical → compare against a shifted fit; referenced row sets with hash-verified
 * replay; report-level migration through the one Gate B registry; warm starts, seeded stability,
 * deterministic holdout; the descriptor; and every refusal with its stable code.
 */

import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  isQuantError,
  optionExpiryToMs,
  resolvedExpiry,
  yearFraction,
  type OptionQuote,
  resolveAsOf,
} from '@totalfinance/core';
import {
  canonicalJsonOf,
  contentHash,
  createAnalysisArtifact,
  createArtifactMigrationRegistry,
  fromCanonicalJson,
  isTableHandle,
  requireFittedModelSummary,
  type AnalysisArtifact,
} from '@totalfinance/core/artifacts';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import { sabrVolatility } from '@totalfinance/options/sabr';
import * as volatility from '@totalfinance/volatility';
import {
  calibrateEssvi,
  calibrateEventMove,
  calibrateEventVolatility,
  calibrateHestonSurface,
  calibrateSabrSmile,
  calibrateSsvi,
  calibrateSvi,
  calibrateVannaVolga,
  calibrateVannaVolga5,
  eventVolatilityAtExpiry,
  fitGarch,
  fitHarRv,
  garchForecast,
  harRvForecast,
  volatilitySurface,
  type AtmVolatilityPoint,
  type SSVICalibrationInput,
} from '@totalfinance/volatility';
import { sviTotalVariance, sviVolatility, type SVIParameters } from '@totalfinance/volatility/svi';
import { ssviVolatility } from '@totalfinance/volatility/ssvi';
import { essviVolatility } from '@totalfinance/volatility/essvi';
import {
  FITTED_MODEL_FAMILIES,
  FITTED_MODEL_LIMITS,
  VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE,
  VOLATILITY_MODEL_FAMILIES,
  compareFittedModels,
  evaluateFittedModel,
  fittedModelArtifact,
  fittedModelHoldout,
  fittedModelStability,
  readFittedModel,
  replayFittedModel,
  warmStartFrom,
  type VolatilityFittedModelReport,
  type VolatilityModelFamily,
} from '@totalfinance/volatility/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

const persisted = <T>(value: T): T => fromCanonicalJson(canonicalJsonOf(value)) as T;

// ── fixtures per family ─────────────────────────────────────────────────────────────────────────
const SVI_TRUE: SVIParameters = { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 };
const SVI_KS = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];
const sviSmile = (scale = 1) => ({
  k: [...SVI_KS],
  w: SVI_KS.map((k) => sviTotalVariance(SVI_TRUE, k) * scale),
});

function ssviW(k: number, theta: number, rho: number, psi: number): number {
  return (theta / 2) * (1 + rho * psi * k + Math.sqrt((psi * k + rho) ** 2 + (1 - rho * rho)));
}
const SKS = [-0.5, -0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3, 0.5];
function ssviSurface(rho: number, eta: number, gamma: number): SSVICalibrationInput {
  const mats = [0.05, 0.15, 0.35, 0.7, 1.5];
  const atm = [0.32, 0.29, 0.27, 0.255, 0.24];
  return {
    slices: mats.map((t, i) => {
      const theta = atm[i]! * atm[i]! * t;
      const psi = eta * Math.pow(theta, -gamma);
      return {
        timeToExpiryYears: t,
        k: SKS,
        impliedVolatility: SKS.map((k) => Math.sqrt(ssviW(k, theta, rho, psi) / t)),
      };
    }),
  };
}

const SABR_STRIKES = [80, 88, 94, 98, 100, 103, 108, 115, 125];
const sabrSmile = (shift = 0) => ({
  forward: 100,
  strikes: [...SABR_STRIKES],
  impliedVolatilities: SABR_STRIKES.map(
    (strike) =>
      sabrVolatility({
        input: { forward: 100, strike, timeToExpiryYears: 0.5 },
        parameters: { alpha: 2, beta: 0.5, rho: -0.3, nu: 0.4 },
      }) + shift,
  ),
  timeToExpiryYears: 0.5,
});

const HESTON_TRUE = { v0: 0.04, kappa: 1.5, theta: 0.05, sigma: 0.4, rho: -0.6 };
const hestonCalibration = (shift = 0) => ({
  targets: [0.25, 0.5].flatMap((t) =>
    [90, 100, 110].map((strike) => ({
      strike,
      timeToExpiryYears: t,
      forward: 100 * Math.exp(0.03 * t),
      impliedVolatility:
        hestonImpliedVolatility({
          type: 'call' as const,
          input: { spot: 100, strike, timeToExpiryYears: t, riskFreeRate: 0.03, dividendYield: 0 },
          parameters: HESTON_TRUE,
          options: { terms: 64, greeks: false },
        }).value + shift,
    })),
  ),
  market: { spot: 100, riskFreeRate: 0.03, dividendYield: 0 },
  options: { initialParameters: HESTON_TRUE, terms: 64, maximumIterations: 20 },
});

const vannaVolgaInput = (shift = 0) => ({
  forward: 100,
  timeToExpiryYears: 0.25,
  atmVolatility: 0.2 + shift,
  riskReversal: -0.02,
  butterfly: 0.005,
  delta: 0.25,
  strikes: [92, 96, 100, 104, 108],
});
const vannaVolga5Input = (shift = 0) => ({
  forward: 100,
  timeToExpiryYears: 0.25,
  atmVolatility: 0.2 + shift,
  riskReversal25: -0.015,
  butterfly25: 0.004,
  riskReversal10: -0.025,
  butterfly10: 0.012,
  innerDelta: 0.25,
  outerDelta: 0.1,
  strikes: [90, 95, 100, 105, 110],
});

const EV_ASOF = '2026-05-01T00:00:00Z'; // a valuation instant names its time of day
const EV_EVENT = '2026-05-11';
function eventTerm(baseVolatility: number, eventMove: number): AtmVolatilityPoint[] {
  const asOfMs = resolveAsOf(EV_ASOF);
  return ['2026-05-08', '2026-05-15', '2026-05-31', '2026-06-30'].map((expiry) => {
    const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
    const spans = optionExpiryToMs(expiry) >= optionExpiryToMs(EV_EVENT);
    return {
      expiry,
      atmVolatility: Math.sqrt((baseVolatility ** 2 * t + (spans ? eventMove ** 2 : 0)) / t),
    };
  });
}
const eventCalibration = (baseVolatility = 0.3) => ({
  termStructure: eventTerm(baseVolatility, 0.05),
  eventDate: EV_EVENT,
  asOf: EV_ASOF,
});
const eventMoveObservations = (bias = 0) => ({
  observations: [
    { impliedMove: 0.05, realizedMove: 0.04 + bias, date: '2026-01-28' },
    { impliedMove: 0.06, realizedMove: 0.07 + bias, date: '2026-04-29' },
    { impliedMove: 0.055, realizedMove: 0.03 + bias, date: '2026-07-29' },
  ],
});

function garchReturns(seed: number, count = 400): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let h = 1e-4;
  let previous = 0;
  const out: number[] = [];
  for (let i = 0; i < count + 200; i++) {
    h = 2e-6 + 0.08 * previous * previous + 0.9 * h;
    const u = Math.max(1e-9, next());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    previous = Math.sqrt(h) * z;
    if (i >= 200) out.push(previous);
  }
  return out;
}
const garchCalibration = (seed = 3) => ({
  returns: garchReturns(seed),
  options: { seed: 7, mean: 'zero' as const },
});
const harRvCalibration = (scale = 1) => ({
  realizedVariances: Array.from(
    { length: 80 },
    (_, i) => (1e-4 + 5e-5 * Math.sin(i / 5) + 2e-5 * Math.cos(i / 3)) * scale,
  ),
  options: { weekly: 5, monthly: 22 },
});

const SURF_ASOF = Date.UTC(2026, 0, 2);
const SURF_EXPIRIES = ['2026-04-02', '2026-07-02'];
const SURF_SVI: Record<string, SVIParameters> = {
  '2026-04-02': { a: 0.008, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 },
  '2026-07-02': { a: 0.018, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
};
function surfaceQuotes(scale = 1): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of SURF_EXPIRIES) {
    const t = yearFraction(SURF_ASOF, optionExpiryToMs(expiry), 'ACT/365F');
    const forward = 100 * Math.exp(0.03 * t);
    for (const strike of [80, 90, 95, 100, 105, 110, 120]) {
      const k = Math.log(strike / forward);
      const impliedVolatility = Math.sqrt(sviTotalVariance(SURF_SVI[expiry]!, k) / t) * scale;
      rows.push({
        contract: {
          underlying: 'X',
          type: 'call',
          style: 'european',
          strike,
          expiry,
          ...resolvedExpiry(expiry),
        },
        timestampMs: SURF_ASOF,
        impliedVolatility,
        underlyingPrice: 100,
      });
    }
  }
  return rows;
}
const surfaceCalibration = (scale = 1) => ({
  quotes: surfaceQuotes(scale),
  market: { spot: 100, riskFreeRate: 0.03, asOf: SURF_ASOF },
  config: { model: 'svi' as const },
});

interface Case {
  family: VolatilityModelFamily;
  calibration: () => unknown;
  shifted: () => unknown;
  fit: (calibration: unknown) => unknown;
  at?: unknown;
  direct?: (fit: unknown, calibration: unknown) => number[];
  evaluation?: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    family: 'svi',
    calibration: () => ({ smile: sviSmile(), options: { timeToExpiryYears: 0.5 } }),
    shifted: () => ({ smile: sviSmile(1.05), options: { timeToExpiryYears: 0.5 } }),
    fit: (c) => calibrateSvi((c as { smile: never }).smile, (c as { options: never }).options),
    at: { logMoneyness: [-0.2, 0, 0.2] },
    direct: (fit) =>
      [-0.2, 0, 0.2].map((k) =>
        sviVolatility((fit as { parameters: SVIParameters }).parameters, k, 0.5),
      ),
  },
  {
    family: 'ssvi',
    calibration: () => ({
      surface: ssviSurface(-0.3, 1.2, 0.4),
      options: { maximumIterations: 400 },
    }),
    shifted: () => ({ surface: ssviSurface(-0.2, 1.1, 0.45), options: { maximumIterations: 400 } }),
    fit: (c) => calibrateSsvi((c as { surface: never }).surface, (c as { options: never }).options),
    at: { logMoneyness: [-0.1, 0.1], timeToExpiryYears: [0.15, 0.7] },
    direct: (fit) =>
      [0.15, 0.7].flatMap((t) =>
        [-0.1, 0.1].map((k) => ssviVolatility((fit as { parameters: never }).parameters, k, t)),
      ),
  },
  {
    family: 'essvi',
    calibration: () => ({
      surface: ssviSurface(-0.3, 1.2, 0.4),
      options: { maximumIterations: 400 },
    }),
    shifted: () => ({ surface: ssviSurface(-0.2, 1.1, 0.45), options: { maximumIterations: 400 } }),
    fit: (c) =>
      calibrateEssvi((c as { surface: never }).surface, (c as { options: never }).options),
    at: { logMoneyness: [-0.1, 0.1], timeToExpiryYears: [0.15, 0.7] },
    direct: (fit) =>
      [0.15, 0.7].flatMap((t) =>
        [-0.1, 0.1].map((k) => essviVolatility((fit as { parameters: never }).parameters, k, t)),
      ),
  },
  {
    family: 'sabr-smile',
    calibration: () => ({ smile: sabrSmile(), options: { beta: 0.5 } }),
    shifted: () => ({ smile: sabrSmile(0.01), options: { beta: 0.5 } }),
    fit: (c) =>
      calibrateSabrSmile((c as { smile: never }).smile, (c as { options: never }).options),
    at: { strikes: [90, 100, 110] },
    direct: (fit) =>
      [90, 100, 110].map((strike) =>
        sabrVolatility({
          input: { forward: 100, strike, timeToExpiryYears: 0.5 },
          parameters: (fit as { parameters: never }).parameters,
          options: { volatilityType: 'lognormal' },
        }),
      ),
  },
  {
    family: 'heston-surface',
    calibration: () => hestonCalibration(),
    shifted: () => hestonCalibration(0.01),
    fit: (c) => calibrateHestonSurface(c as never),
    at: { type: 'call', strikes: [95, 105], timeToExpiryYears: [0.25] },
    direct: (fit) =>
      [95, 105].map(
        (strike) =>
          hestonImpliedVolatility({
            type: 'call',
            input: {
              spot: 100,
              strike,
              timeToExpiryYears: 0.25,
              riskFreeRate: 0.03,
              dividendYield: 0,
            },
            parameters: (fit as { parameters: never }).parameters,
            options: { terms: 64, greeks: false },
          }).value,
      ),
  },
  {
    family: 'vanna-volga',
    calibration: () => vannaVolgaInput(),
    shifted: () => vannaVolgaInput(0.01),
    fit: (c) => calibrateVannaVolga(c as never),
    at: { strikes: [95, 105] },
    direct: (_fit, calibration) => [
      ...calibrateVannaVolga({ ...(calibration as object), strikes: [95, 105] } as never)
        .volatilities,
    ],
  },
  {
    family: 'vanna-volga-5',
    calibration: () => vannaVolga5Input(),
    shifted: () => vannaVolga5Input(0.01),
    fit: (c) => calibrateVannaVolga5(c as never),
    at: { strikes: [95, 105] },
    direct: (_fit, calibration) => [
      ...calibrateVannaVolga5({ ...(calibration as object), strikes: [95, 105] } as never)
        .volatilities,
    ],
  },
  {
    family: 'event-volatility',
    calibration: () => eventCalibration(),
    shifted: () => eventCalibration(0.32),
    fit: (c) => calibrateEventVolatility(c as never),
    at: { expiries: ['2026-05-05', '2026-06-19'] },
    direct: (fit) => [
      ...eventVolatilityAtExpiry({ fit: fit as never, expiries: ['2026-05-05', '2026-06-19'] })
        .values,
    ],
  },
  {
    family: 'event-move',
    calibration: () => eventMoveObservations(),
    shifted: () => eventMoveObservations(0.01),
    fit: (c) => calibrateEventMove((c as { observations: never }).observations),
  },
  {
    family: 'garch',
    calibration: () => garchCalibration(),
    shifted: () => garchCalibration(11),
    fit: (c) => fitGarch((c as { returns: number[] }).returns, (c as { options: never }).options),
    at: { lastVariance: 1.2e-4, horizonPeriods: 3 },
    direct: (fit) => [
      ...garchForecast({ fit: fit as never, lastVariance: 1.2e-4, horizonPeriods: 3 }).variancePath,
    ],
    evaluation: { lastVariance: 1.2e-4, horizonPeriods: [1, 5] },
  },
  {
    family: 'har-rv',
    calibration: () => harRvCalibration(),
    shifted: () => harRvCalibration(1.2),
    fit: (c) =>
      fitHarRv(
        (c as { realizedVariances: number[] }).realizedVariances,
        (c as { options: never }).options,
      ),
    at: { history: harRvCalibration().realizedVariances.slice(0, 40) },
    direct: (fit) => [
      harRvForecast(fit as never, harRvCalibration().realizedVariances.slice(0, 40)),
    ],
    evaluation: { history: harRvCalibration().realizedVariances.slice(0, 40) },
  },
  {
    family: 'volatility-surface',
    calibration: () => surfaceCalibration(),
    shifted: () => surfaceCalibration(1.05),
    fit: (c) => volatilitySurface(c as never),
    at: { strikes: [95, 100, 105], expiry: '2026-04-02' },
    direct: (fit) => {
      const surface = volatility.VolatilitySurface.fromJSON(fit as never);
      return [95, 100, 105].map((strike) => surface.lookup(strike, '2026-04-02').value);
    },
  },
];

describe('every volatility family: describe → save → round trip → restore → evaluate → replay → compare', () => {
  for (const testCase of CASES) {
    it(`${testCase.family}`, () => {
      const calibration = testCase.calibration();
      const fit = testCase.fit(calibration);
      const artifact = fittedModelArtifact({ family: testCase.family, fit, calibration } as never);
      expect(artifact.artifactType).toBe(VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE);
      expect(artifact.producedBy.operation).toBe(FITTED_MODEL_FAMILIES[testCase.family].calibrator);
      const result = artifact.result as VolatilityFittedModelReport;
      expect(result.family).toBe(testCase.family);
      expect(result.modelVersion).toBe(1);
      expect(result.assumptions.inputPolicy).toBe('embedded');
      expect(result.summary.family).toBe(`volatility.${testCase.family}`);
      expect(requireFittedModelSummary('test', 'summary', result.summary)).toBe(result.summary);
      // The verbatim fit: the projection dropped nothing.
      const savedFit =
        testCase.family === 'volatility-surface'
          ? (fit as volatility.VolatilitySurface).toJSON()
          : fit;
      expect(canonicalJsonOf(result.fit)).toBe(canonicalJsonOf(savedFit));
      // Determinism: the same call mints the same id.
      expect(fittedModelArtifact({ family: testCase.family, fit, calibration } as never).id).toBe(
        artifact.id,
      );
      // Round trip through the caller's storage and back through the read door.
      const restored = readFittedModel({ artifact: persisted(artifact) });
      expect(restored.artifact.id).toBe(artifact.id);
      expect(restored.migrationsApplied).toEqual([]);
      expect(restored.modelMigrationsApplied).toEqual([]);
      expect(canonicalJsonOf(restored.report)).toBe(canonicalJsonOf(result));
      expect(Object.isFrozen(restored.report.fit)).toBe(true);
      // Evaluate equals the direct evaluator, field for field.
      if (testCase.at !== undefined && testCase.direct !== undefined) {
        const fromReport = evaluateFittedModel({
          model: restored.report,
          at: testCase.at,
        } as never);
        const fromArtifact = evaluateFittedModel({
          model: persisted(artifact),
          at: testCase.at,
        } as never);
        expect(fromReport.values).toEqual(testCase.direct(savedFit, calibration));
        expect(fromArtifact.values).toEqual(fromReport.values);
        expect(fromReport.assumptions.evaluator).toBe(
          FITTED_MODEL_FAMILIES[testCase.family].evaluator,
        );
        expect(fromReport.reasons).toEqual([]);
        expect(fromReport.coordinates).toHaveLength(fromReport.values.length);
      } else {
        expect(codeOf(() => evaluateFittedModel({ model: restored.report, at: {} } as never))).toBe(
          ErrorCode.ArtifactOperationUnsupported,
        );
      }
      // Replay parity is byte-identical.
      const replay = replayFittedModel({ artifact: persisted(artifact) });
      expect(replay.parity.identical).toBe(true);
      expect(replay.parity.savedHash).toBe(contentHash(result.fit));
      expect(replay.artifactId).toBe(artifact.id);
      expect(replay.diagnostics.warnings).toEqual([]);
      // Compare against a shifted fit of the same family.
      const shiftedCalibration = testCase.shifted();
      const shifted = fittedModelArtifact({
        family: testCase.family,
        fit: testCase.fit(shiftedCalibration),
        calibration: shiftedCalibration,
      } as never);
      const comparison = compareFittedModels({
        baseline: artifact,
        candidate: shifted,
        ...(testCase.evaluation !== undefined ? { evaluation: testCase.evaluation } : {}),
        limits: { gridPoints: 16 },
      } as never);
      expect(comparison.family).toBe(testCase.family);
      expect(comparison.sameCalibrationInput).toBe(false);
      expect(comparison.artifactIds).toEqual({ baseline: artifact.id, candidate: shifted.id });
      // A per-slice surface model has no global parameters in its summary; its change lives in the fit diff.
      if (testCase.family !== 'volatility-surface')
        expect(comparison.parameters.length).toBeGreaterThan(0);
      expect(comparison.fit.differenceCount).toBeGreaterThan(0);
      if (FITTED_MODEL_FAMILIES[testCase.family].evaluator === null) {
        expect(comparison.evaluation).toBeNull();
        expect(comparison.assumptions.evaluationReason).toMatch(/no evaluator/);
      } else {
        expect(comparison.evaluation).not.toBeNull();
        expect(comparison.evaluation!.comparedCount).toBeGreaterThan(0);
        expect(comparison.evaluation!.maximumAbsoluteDifference).toBeGreaterThan(0);
        expect(comparison.evaluation!.grid).toHaveLength(
          comparison.evaluation!.comparedCount + comparison.evaluation!.nullCount,
        );
      }
    });
  }
});

describe('the family descriptor', () => {
  it('lists every family with its calibrator as a real export and no family the code lacks', () => {
    expect(Object.keys(FITTED_MODEL_FAMILIES).sort()).toEqual(
      [...VOLATILITY_MODEL_FAMILIES].sort(),
    );
    expect(Object.isFrozen(FITTED_MODEL_FAMILIES)).toBe(true);
    for (const family of VOLATILITY_MODEL_FAMILIES) {
      const descriptor = FITTED_MODEL_FAMILIES[family];
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.qualifiedFamily).toBe(`volatility.${family}`);
      expect(descriptor.modelVersion).toBe(1);
      expect(typeof (volatility as Record<string, unknown>)[descriptor.calibrator]).toBe(
        'function',
      );
    }
    expect(FITTED_MODEL_FAMILIES['volatility-surface'].referenceableRowSets).toEqual(['quotes']);
    expect(FITTED_MODEL_FAMILIES['event-move'].evaluator).toBeNull();
    expect(FITTED_MODEL_LIMITS.restarts.maximum).toBe(64);
  });
});

describe('read door refusals and report-level migration', () => {
  const calibration = { smile: sviSmile(), options: { timeToExpiryYears: 0.5 } };
  const artifact = fittedModelArtifact({
    family: 'svi',
    fit: calibrateSvi(calibration.smile, calibration.options),
    calibration,
  });

  it('refuses a foreign artifact type naming the owner, and a tampered artifact', () => {
    const foreign = createAnalysisArtifact({
      artifactType: 'research.run',
      producedBy: { operation: 'screenUniverse' },
      result: { assumptions: {}, diagnostics: { warnings: [] } },
    });
    expect(codeOf(() => readFittedModel({ artifact: foreign }))).toBe(
      ErrorCode.ArtifactFamilyMismatch,
    );
    expect(() => readFittedModel({ artifact: foreign })).toThrow(
      /@totalfinance\/research\/artifacts/,
    );
    const tampered = persisted(artifact) as AnalysisArtifact & { result: Record<string, unknown> };
    (tampered.result as { modelVersion: number }).modelVersion = 1;
    (tampered.result['fit'] as { rmse: number }).rmse = 0;
    expect(codeOf(() => readFittedModel({ artifact: tampered }))).toBe(
      ErrorCode.ArtifactIdMismatch,
    );
    expect(codeOf(() => readFittedModel({ artifact: { bogus: 1 } as never }))).toBe(
      ErrorCode.InputUnknownField,
    );
  });

  it('refuses a newer model version and an older one with no registered migration; applies a registered one', () => {
    const rebuilt = (modelVersion: number) =>
      createAnalysisArtifact({
        artifactType: artifact.artifactType,
        producedBy: artifact.producedBy,
        inputs: { parameters: { ...(artifact.inputs.parameters as object), modelVersion } },
        result: { ...artifact.result, modelVersion },
      });
    expect(codeOf(() => readFittedModel({ artifact: rebuilt(2) }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    // An older report (version 0) with no migration registered refuses with the same code and a teaching.
    const older = createAnalysisArtifact({
      artifactType: artifact.artifactType,
      producedBy: artifact.producedBy,
      inputs: {
        parameters: { family: 'svi', modelVersion: 0, calibrationHash: contentHash(calibration) },
      },
      result: {
        ...artifact.result,
        modelVersion: 0,
        summary: { ...(artifact.result as VolatilityFittedModelReport).summary, modelVersion: 1 },
      },
    });
    expect(codeOf(() => readFittedModel({ artifact: older }))).toBe(
      ErrorCode.ArtifactModelVersionUnsupported,
    );
    expect(() => readFittedModel({ artifact: older })).toThrow(/volatility\.fitted-model:svi/);
    const registry = createArtifactMigrationRegistry();
    registry.register({
      kind: 'volatility.fitted-model:svi',
      fromVersion: 0,
      toVersion: 1,
      description: 'fixture: the v0 report carried no assumptions.projection sentence',
      migrate: (envelope) => ({ ...envelope, schemaVersion: 1 }),
    });
    const migrated = readFittedModel({ artifact: older, migrations: registry });
    expect(migrated.modelMigrationsApplied).toEqual([
      {
        kind: 'volatility.fitted-model:svi',
        fromVersion: 0,
        toVersion: 1,
        description: 'fixture: the v0 report carried no assumptions.projection sentence',
      },
    ]);
    expect(migrated.report.modelVersion).toBe(1);
    expect(migrated.migrationsApplied).toEqual([]);
  });
});

describe('referenced row sets (Decision 9)', () => {
  const calibration = surfaceCalibration();
  const surface = volatilitySurface(calibration);

  it('stores the row set as a table handle, replays only with the verified rows, and refuses the rest', () => {
    const artifact = fittedModelArtifact({
      family: 'volatility-surface',
      fit: surface,
      calibration,
      referenceRowSets: ['quotes'],
      locators: { quotes: 'chains/x.json' },
    });
    const report = artifact.result as VolatilityFittedModelReport<'volatility-surface'>;
    expect(report.assumptions.inputPolicy).toBe('referenced');
    expect(isTableHandle(report.calibration.quotes)).toBe(true);
    expect(report.referencedData['quotes']!.rowCount).toBe(calibration.quotes.length);
    expect(report.referencedData['quotes']!.locator).toBe('chains/x.json');
    expect(artifact.tables?.['quotes']).toEqual(report.referencedData['quotes']);
    expect(report.diagnostics.referencedRowSets).toEqual(['quotes']);
    expect(report.diagnostics.embeddedCalibrationBytes).toBeLessThan(
      canonicalJsonOf(calibration).length,
    );
    // Evaluation needs no rows: the stored summary ranges disclose extrapolation.
    const evaluated = evaluateFittedModel({
      model: artifact,
      at: { strikes: [70, 100], expiry: '2026-04-02' },
    });
    expect(evaluated.diagnostics.outsideCalibratedRange).toBe(1);
    expect(evaluated.diagnostics.warnings.map((w) => w.code)).toEqual([
      'volatility.surface_extrapolated',
    ]);
    expect(codeOf(() => replayFittedModel({ artifact }))).toBe(ErrorCode.InputMissingField);
    expect(
      codeOf(() =>
        replayFittedModel({ artifact, referencedData: { quotes: calibration.quotes.slice(1) } }),
      ),
    ).toBe(ErrorCode.ArtifactReferencedDataMismatch);
    const replay = replayFittedModel({
      artifact,
      referencedData: { quotes: persisted(calibration.quotes) },
    });
    expect(replay.parity.identical).toBe(true);
    expect(replay.assumptions.referencedRowSets).toEqual(['quotes']);
  });

  it('refuses an over-limit embedded row set and an over-limit byte size with the teaching, and unknown row sets', () => {
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'volatility-surface',
          fit: surface,
          calibration,
          limits: { embeddedRowLimit: 5 },
        }),
      ),
    ).toBe(ErrorCode.ArtifactEmbeddedInputTooLarge);
    expect(() =>
      fittedModelArtifact({
        family: 'volatility-surface',
        fit: surface,
        calibration,
        limits: { embeddedRowLimit: 5 },
      }),
    ).toThrow(/referenceRowSets: \['quotes'\]/);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'volatility-surface',
          fit: surface,
          calibration,
          limits: { maximumEmbeddedBytes: 200 },
        }),
      ),
    ).toBe(ErrorCode.ArtifactEmbeddedInputTooLarge);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'volatility-surface',
          fit: surface,
          calibration,
          referenceRowSets: ['market'] as never,
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'svi',
          fit: calibrateSvi(sviSmile()),
          calibration: { smile: sviSmile() },
          referenceRowSets: ['smile'] as never,
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'volatility-surface',
          fit: surface,
          calibration,
          limits: { embeddedRowLimit: FITTED_MODEL_LIMITS.embeddedRowLimit.maximum + 1 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelArtifact({
          family: 'volatility-surface',
          fit: surface,
          calibration,
          limits: { embeddedRowLimit: 2.5 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });
});

describe('warm starts, stability, and holdout (Decision 8)', () => {
  const sviCalibration = { smile: sviSmile(), options: { timeToExpiryYears: 0.5 } };
  const sviFit = calibrateSvi(sviCalibration.smile, sviCalibration.options);
  const sviArtifact = fittedModelArtifact({
    family: 'svi',
    fit: sviFit,
    calibration: sviCalibration,
  });

  it('warmStartFrom fills the family option and refuses families without a start', () => {
    const start = warmStartFrom<'svi'>({ model: sviArtifact });
    expect(start).toEqual({
      initialParameters: { m: sviFit.parameters.m, sigma: sviFit.parameters.sigma },
    });
    const warm = calibrateSvi(sviCalibration.smile, { ...sviCalibration.options, ...start });
    expect(warm.assumptions.initialParameters).toBe('supplied');
    const eventMove = fittedModelArtifact({
      family: 'event-move',
      fit: calibrateEventMove(eventMoveObservations().observations),
      calibration: eventMoveObservations(),
    });
    expect(codeOf(() => warmStartFrom({ model: eventMove }))).toBe(
      ErrorCode.ArtifactOperationUnsupported,
    );
    const surfaceArtifact = fittedModelArtifact({
      family: 'volatility-surface',
      fit: volatilitySurface(surfaceCalibration()),
      calibration: surfaceCalibration(),
    });
    expect(codeOf(() => warmStartFrom({ model: surfaceArtifact }))).toBe(
      ErrorCode.ArtifactOperationUnsupported,
    );
    const heston = hestonCalibration();
    const hestonArtifact = fittedModelArtifact({
      family: 'heston-surface',
      fit: calibrateHestonSurface(heston),
      calibration: heston,
    });
    expect(
      Object.keys(
        warmStartFrom<'heston-surface'>({ model: hestonArtifact }).initialParameters,
      ).sort(),
    ).toEqual(['kappa', 'rho', 'sigma', 'theta', 'v0']);
  });

  it('fittedModelStability is seeded, deterministic, bounded, and honest about convergence', () => {
    const report = fittedModelStability({
      family: 'svi',
      calibration: sviCalibration,
      restarts: 4,
      perturbation: { relative: 0.2 },
      seed: 11,
      tolerance: { absolute: 1e-3, relative: 1e-2 },
    });
    expect(report.restarts).toBe(4);
    expect(report.convergedCount).toBe(4);
    expect(report.stable).toBe(true);
    expect(Object.keys(report.parameters).sort()).toEqual(['a', 'b', 'm', 'rho', 'sigma']);
    expect(report.parameters['m']!.baseline).toBeCloseTo(sviFit.parameters.m, 8);
    expect(report.assumptions.members).toEqual(['m', 'sigma']);
    expect(
      fittedModelStability({
        family: 'svi',
        calibration: sviCalibration,
        restarts: 4,
        perturbation: { relative: 0.2 },
        seed: 11,
        tolerance: { absolute: 1e-3, relative: 1e-2 },
      }),
    ).toEqual(report);
    const untoleranced = fittedModelStability({
      family: 'svi',
      calibration: sviCalibration,
      restarts: 2,
      perturbation: { relative: 0.2 },
      seed: 11,
    });
    expect(untoleranced.stable).toBeNull();
    expect(
      codeOf(() =>
        fittedModelStability({
          family: 'svi',
          calibration: sviCalibration,
          restarts: 4,
          perturbation: { relative: 0.2 },
        } as never),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelStability({
          family: 'svi',
          calibration: sviCalibration,
          restarts: 65,
          perturbation: { relative: 0.2 },
          seed: 1,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelStability({
          family: 'svi',
          calibration: sviCalibration,
          restarts: 4,
          perturbation: { relative: 1.5 },
          seed: 1,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelStability({
          family: 'vanna-volga',
          calibration: vannaVolgaInput(),
          restarts: 4,
          perturbation: { relative: 0.2 },
          seed: 1,
        }),
      ),
    ).toBe(ErrorCode.ArtifactOperationUnsupported);
  });

  it('fittedModelHoldout splits deterministically and reports in- and out-of-sample residuals', () => {
    const everyThird = fittedModelHoldout({
      family: 'svi',
      calibration: sviCalibration,
      holdout: { everyNth: 3, offset: 0 },
    });
    expect(everyThird.heldOutCount).toBe(4);
    expect(everyThird.retainedCount).toBe(7);
    expect(everyThird.outOfSample.count).toBe(4);
    expect(everyThird.outOfSample.rootMeanSquare).toBeLessThan(1e-4);
    expect(everyThird.inSample.count).toBe(7);
    expect(everyThird.unit).toBe('total variance');
    expect(everyThird.assumptions.partition).toBe('cross-sectional points');
    const indices = fittedModelHoldout({
      family: 'sabr-smile',
      calibration: { smile: sabrSmile(), options: { beta: 0.5 } },
      holdout: { indices: [0, 8] },
    });
    expect(indices.heldOutCount).toBe(2);
    expect(indices.outOfSample.maximumAbsolute).toBeLessThan(1e-3);
    const series = fittedModelHoldout({
      family: 'har-rv',
      calibration: harRvCalibration(),
      holdout: { lastCount: 5 },
    });
    expect(series.assumptions.partition).toBe('time-series prefix');
    expect(series.outOfSample.count).toBe(5);
    expect(series.retainedCount).toBe(75);
    expect(
      codeOf(() =>
        fittedModelHoldout({
          family: 'garch',
          calibration: garchCalibration(),
          holdout: { lastCount: 5 },
        }),
      ),
    ).toBe(ErrorCode.ArtifactOperationUnsupported);
    expect(
      codeOf(() =>
        fittedModelHoldout({
          family: 'svi',
          calibration: sviCalibration,
          holdout: { everyNth: 3, offset: 3 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelHoldout({
          family: 'svi',
          calibration: sviCalibration,
          holdout: { indices: [11] },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        fittedModelHoldout({ family: 'svi', calibration: sviCalibration, holdout: {} as never }),
      ),
    ).toBe(ErrorCode.InputMissingField);
    expect(
      codeOf(() =>
        fittedModelHoldout({
          family: 'har-rv',
          calibration: harRvCalibration(),
          holdout: { lastCount: 80 },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });
});

describe('comparison honesty', () => {
  it('refuses two families, discloses a moved market, and answers withinTolerance only under a tolerance', () => {
    const calibration = { smile: sviSmile(), options: { timeToExpiryYears: 0.5 } };
    const svi = fittedModelArtifact({
      family: 'svi',
      fit: calibrateSvi(calibration.smile, calibration.options),
      calibration,
      snapshotHash: contentHash({ market: 'A' }),
    });
    const sabr = fittedModelArtifact({
      family: 'sabr-smile',
      fit: calibrateSabrSmile(sabrSmile()),
      calibration: { smile: sabrSmile() },
    });
    expect(codeOf(() => compareFittedModels({ baseline: svi, candidate: sabr } as never))).toBe(
      ErrorCode.ArtifactFamilyMismatch,
    );
    const moved = fittedModelArtifact({
      family: 'svi',
      fit: calibrateSvi(calibration.smile, calibration.options),
      calibration,
      snapshotHash: contentHash({ market: 'B' }),
    });
    const comparison = compareFittedModels({
      baseline: svi,
      candidate: moved,
      tolerance: { absolute: 1e-9, relative: 1e-9 },
    });
    expect(comparison.sameMarket).toBe(false);
    expect(comparison.sameCalibrationInput).toBe(true);
    expect(comparison.diagnostics.warnings.map((w) => w.code)).toEqual([
      'artifact.comparison_different_market',
    ]);
    expect(comparison.parameters).toEqual([]);
    expect(comparison.fit.differenceCount).toBe(0);
    expect(comparison.withinTolerance).toBe(true);
    expect(comparison.evaluation!.maximumAbsoluteDifference).toBe(0);
    expect(compareFittedModels({ baseline: svi, candidate: moved }).withinTolerance).toBeNull();
    expect(
      codeOf(() =>
        compareFittedModels({
          baseline: svi,
          candidate: moved,
          tolerance: { absolute: 1 } as never,
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        compareFittedModels({ baseline: svi, candidate: moved, limits: { gridPoints: 5000 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    const garchA = fittedModelArtifact({
      family: 'garch',
      fit: fitGarch(garchCalibration().returns, garchCalibration().options),
      calibration: garchCalibration(),
    });
    const noHorizons = compareFittedModels({ baseline: garchA, candidate: garchA });
    expect(noHorizons.evaluation).toBeNull();
    expect(noHorizons.assumptions.evaluationReason).toMatch(/horizonPeriods/);
  });
});
