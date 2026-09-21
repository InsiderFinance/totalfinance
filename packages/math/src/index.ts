/**
 * `@totalfinance/math` — the numerical foundation for TotalFinance. No third-party runtime dependencies,
 * browser-safe.
 *
 * Covers the standard normal distribution, robust 1-D root solvers, descriptive/rolling statistics,
 * linear interpolation, and a seedable PRNG with resampling.
 */

export {
  normalPdf,
  normalCdf,
  normalInverseCdf,
  normalSurvivalFunction,
  normalLogPdf,
  normalLogCdf,
  normalLogSurvivalFunction,
  normal,
} from './normal.js';

export { bivariateNormalCdf } from './bivariate.js';

export {
  bisection,
  brent,
  ridder,
  secant,
  newton,
  halley,
  householder,
  bracketExpand,
  findRoot,
  solveAll,
} from './solvers.js';
export type {
  SolverResult,
  SolverOptions,
  SolverFailureReason,
  ScalarFunction,
  Derivatives,
  FunctionWithDerivatives,
  Bracket,
  BracketExpandOptions,
  RootProblem,
} from './solvers.js';

export {
  goldenSectionMin,
  brentMin,
  nelderMead,
  bfgs,
  levenbergMarquardt,
  differentialEvolution,
} from './optimize.js';
export type {
  MinResult,
  MultiMinResult,
  MinOptions,
  MultiMinOptions,
  MultivariateFunction,
  LMOptions,
  LevenbergMarquardtResult,
  DifferentialEvolutionOptions,
} from './optimize.js';

export {
  sum,
  mean,
  min,
  max,
  variance,
  welfordVariance,
  standardDeviation,
  median,
  quantile,
  skewness,
  kurtosis,
  medianAbsoluteDeviation,
  winsorize,
  trimmedMean,
  rollingMean,
  rollingStandardDeviation,
  covariance,
  correlation,
  rollingCovariance,
  rollingCorrelation,
} from './statistics.js';
export type {
  NanPolicy,
  StatisticsOptions,
  PopulationOptions,
  VarianceOptions,
  KurtosisOptions,
  MedianAbsoluteDeviationOptions,
  WinsorizeOptions,
} from './statistics.js';

export {
  linearInterp,
  makeLinearInterpolator,
  makePchipInterpolator,
  makeNaturalCubicSpline,
  bilinearInterp,
  bicubicInterp,
  makeBicubicInterpolator,
  validateInterpolationData,
} from './interpolation.js';
export type { ExtrapolationPolicy, InterpolateOptions, AxisOptions } from './interpolation.js';

export {
  cholesky,
  choleskySolve,
  covarianceMatrix,
  ledoitWolfShrinkage,
  estimateCovariance,
  jacobiEigen,
  nearestPsd,
  nearestCorrelation,
  identity,
  transpose,
  matrixMultiply,
  matrixVectorProduct,
  luDecompose,
  luSolve,
  determinant,
  qrDecompose,
  qrSolve,
  svd,
  pseudoInverse,
  eigenvalues,
  eigen,
} from './linalg.js';
export type {
  Matrix,
  EigenResult,
  LedoitWolfOptions,
  LedoitWolfResult,
  CovarianceMethod,
  EstimateCovarianceOptions,
  CovarianceEstimate,
  LuResult,
  QrResult,
  SvdResult,
  Complex,
  GeneralEigenResult,
} from './linalg.js';

export {
  adaptiveSimpson,
  adaptiveSimpsonSafe,
  gaussLegendre,
  gaussLegendreNodes,
} from './integration.js';
export type { AdaptiveSimpsonOptions, AdaptiveSimpsonResult } from './integration.js';

export {
  mulberry32,
  xoshiro128ss,
  restoreRandomNumberGenerator,
  normalSample,
  uniformSamples,
  bootstrap,
} from './random.js';
export type {
  RandomNumberGenerator,
  RandomNumberGeneratorState,
  BootstrapOptions,
  BootstrapResult,
} from './random.js';

export {
  haltonPoint,
  haltonSequence,
  sobolSequence,
  SOBOL_MAX_DIMENSIONS,
} from './lowdiscrepancy.js';

export {
  monteCarlo,
  antitheticSampler,
  controlVariateEstimate,
  stratifiedUniforms,
  brownianBridge,
  correlatedNormalSampler,
} from './montecarlo.js';
export type { MonteCarloResult, MonteCarloOptions } from './montecarlo.js';

export { ols } from './regression.js';
export type { OlsResult, OlsOptions, OlsHacOptions } from './regression.js';

export {
  acf,
  pacf,
  ljungBox,
  augmentedDickeyFullerTest,
  kpssTest,
  engleGranger,
  hurstExponent,
  ouHalfLife,
} from './timeseries.js';
export type {
  TestResult,
  AugmentedDickeyFullerOptions,
  KpssOptions,
  LjungBoxOptions,
  EngleGrangerResult,
} from './timeseries.js';

export {
  studentT,
  chiSquare,
  gamma,
  lgamma,
  regularizedGammaP,
  regularizedBeta,
} from './distributions.js';

export { kalmanFilter, kalmanSmooth, kalmanLogLikelihood } from './filters.js';
export type {
  KalmanModel,
  KalmanObservation,
  KalmanFilterResult,
  KalmanSmoothResult,
} from './filters.js';
