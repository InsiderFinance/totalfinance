/**
 * `@totalfinance/fixed-income` — bonds, yield curves, rates derivatives, short-rate models, and credit
 * (spec §14). Browser-safe and clock-free: every function takes explicit dates/market data and an
 * injected valuation date, never the system clock.
 *
 * Built on `@totalfinance/core` (dates, calendars, day counts, errors) and `@totalfinance/math` (solvers,
 * interpolation, the normal distribution). Pricing follows the library's correctness-first law —
 * inputs are validated and bad data throws rather than silently degrading.
 */

// §14 conventions — day counts, business-day adjustment, coupon schedules.
export {
  isLeapYear,
  daysInYear,
  daysInMonth,
  isEndOfMonth,
  addMonths,
  compareDates,
  yearFraction,
  adjustDate,
  paymentsPerYear,
  generateSchedule,
} from './conventions.js';
// FC0: the ONE compounding grammar is core's — re-exported here so zeroRate's parameter is
// nameable from this package without installing core beside it.
export type { InterestCompounding } from '@totalfinance/core';
export type {
  FixedIncomeDayCount,
  BusinessDayConvention,
  Frequency,
  ScheduleOptions,
  SchedulePeriod,
} from './conventions.js';

// §14.2 yield curves — discount/zero/forward, interpolation/extrapolation, shocks, curve risk.
export { curves, discountFromZero, zeroFromDiscount } from './curves.js';
// Stage 4.5 — the live-curve ↔ core RateCurve data mappers (the bond pricer's curve builder made public).
export { rateCurveFromYieldCurve, yieldCurveFromRateCurve } from './curve-mappers.js';
export type {
  YieldCurve,
  CurveOptions,
  CurvePillar,
  CurveInterpolation,
  CurveExtrapolation,
  BootstrapInstrument,
  BootstrapOptions,
  ProjectionBootstrapOptions,
  MultiCurveBootstrapOptions,
  MultiCurve,
  DepositInstrument,
  FraInstrument,
  FutureInstrument,
  SwapInstrument,
} from './curves.js';

// §14.1 bonds — fixed/zero/FRN/amortizing/inflation, with the full analytics suite.
export {
  bonds,
  priceFromYield,
  yieldToMaturity,
  yieldMetrics,
  curveMetrics,
  priceMultiCurve,
  yieldToCall,
} from './bonds.js';
export type {
  YieldToCallAssumptions,
  YieldToCallFacade,
  BaseSpecification,
  Bond,
  BondKind,
  BondAssumptions,
  BondComputed,
  BondFacade,
  BondPrice,
  CashFlow,
  ProjectionContext,
  Amortization,
  FixedRateBondSpecification,
  ZeroCouponBondSpecification,
  FloatingRateNoteSpecification,
  AmortizingBondSpecification,
  InflationLinkedBondSpecification,
  PriceFromYieldOptions,
  YieldFromPriceOptions,
  YieldMetrics,
  YieldMetricsOptions,
  CurvePricingOptions,
  CurveMetrics,
  CallFeature,
} from './bonds.js';

// §14.3 rates derivatives — FRA, swaps/OIS, swaptions, caps/floors, CMS via Black & Bachelier.
export {
  fraValue,
  swapValue,
  swapRate,
  forwardSwap,
  swaptionPrice,
  capFloorPrice,
  cmsConvexityAdjustment,
  forwardCmsRate,
} from './rates.js';
export type {
  ParSwapSpecification,
  SwapRateAssumptions,
  SwapRateFacade,
  RatesVolatilityModel,
  OptionRight,
  FraSpecification,
  FraResult,
  SwapSpecification,
  SwapCurves,
  SwapValuation,
  ForwardSwapSpecification,
  ForwardSwapResult,
  SwaptionSpecification,
  SwaptionResult,
  CapFloorSpecification,
  CapletResult,
  CapFloorResult,
  CmsSpecification,
  CmsResult,
  CmsConvexityInput,
  CmsConvexityResult,
} from './rates.js';

// §14.3 short-rate models — Vasicek, CIR, Hull-White (analytic) + HW/Black-Karasinski trinomial tree.
export { vasicek, cir, hullWhite, shortRateTree, g2pp } from './models.js';
export type {
  VasicekParameters,
  CirParameters,
  CirModel,
  HullWhiteParameters,
  HullWhiteModel,
  ShortRateModel,
  GaussianShortRateModel,
  ShortRateMoments,
  TreeModel,
  ShortRateTree,
  ShortRateTreeOptions,
  G2ppParameters,
  G2ppModel,
} from './models.js';

// §14.1/14.3 lattice instruments — callable/putable bonds + Bermudan swaptions on the short-rate tree.
export { callableBond, oasAnalytics, bermudanSwaption } from './lattice.js';
export type {
  BondOption,
  CallableBondSpecification,
  CallableBondResult,
  OasAnalyticsSpecification,
  OasAnalyticsResult,
  BermudanSwaptionSpecification,
  BermudanSwaptionResult,
} from './lattice.js';

// §14.1 convertible bonds — equity lattice + reduced-form credit.
export { convertibleBond } from './convertible.js';
export type {
  ConvertibleBondSpecification,
  ConvertibleBondResult,
  ConvertibleBondOption,
} from './convertible.js';

// §14.4 CVA/DVA/FVA — Hull-White exposure simulation for interest-rate swaps.
export { swapXva } from './xva.js';
export type { XvaSwapSpecification, XvaParameters, XvaResult, ExposurePoint } from './xva.js';

// Bond futures — CME conversion factor + basis/carry/implied-repo cheapest-to-deliver analytics,
// plus the DV01 hedge ratio and futures-implied forward yield.
export { conversionFactor, bondFuture, bondFutureHedge, bondFutureCtdFrontier } from './futures.js';
export type {
  ConversionFactorInput,
  ConversionFactorResult,
  DeliverableBond,
  BondFutureInput,
  DeliverableAnalysis,
  BondFutureResult,
  BondFutureHedgeInput,
  DeliverableRisk,
  BondFutureHedgeResult,
  YieldShiftGrid,
  BondFutureCtdFrontierInput,
  CtdFrontierScenario,
  CtdSwitch,
  BondFutureCtdFrontierResult,
} from './futures.js';

// Inflation analytics — TIPS index ratio, breakeven inflation, CPI seasonality, and the ZC inflation swap.
export {
  tipsIndexRatio,
  breakevenInflation,
  cpiSeasonality,
  zeroCouponInflationSwap,
} from './inflation.js';
export type {
  TipsIndexRatioInput,
  TipsIndexRatioResult,
  BreakevenInflationInput,
  BreakevenInflationResult,
  CpiSeasonalityInput,
  CpiSeasonalityResult,
  ZeroCouponInflationSwapInput,
  ZeroCouponInflationSwapResult,
} from './inflation.js';

// §14.4 credit — survival/hazard curves, CDS pricing, hazard bootstrap, spread curves, CDS basis.
export {
  credit,
  cdsValue,
  cdsParSpread,
  bootstrapHazardFromCds,
  creditSpreadCurve,
  creditTriangleHazard,
  cdsBasis,
} from './credit.js';
export type {
  CreditSpreadPoint,
  CreditSpreadCurveAssumptions,
  CreditSpreadCurveFacade,
  ParCdsSpecification,
  SurvivalCurve,
  SurvivalCurveOptions,
  SurvivalPillar,
  CdsSpecification,
  CdsCurves,
  CdsValuation,
  CdsQuote,
  HazardBootstrapOptions,
  CreditTriangleHazardResult,
} from './credit.js';

// §14.5 cross-currency basis — CIP FX forwards + the domestic-collateralized foreign discount curve.
export { crossCurrencyBasisCurve, impliedCrossCurrencyBasis } from './cross-currency.js';
export type {
  CrossCurrencyBasisInput,
  CrossCurrencyBasisResult,
  ImpliedCrossCurrencyBasisInput,
  ImpliedCrossCurrencyBasisResult,
} from './cross-currency.js';
