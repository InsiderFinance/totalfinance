/**
 * `@insiderfinance/totalfinance/core` — shared types, conventions, errors, diagnostics, assumptions, and small
 * numeric utilities. Zero runtime dependencies and browser-safe.
 *
 * The runtime schema facade is intentionally NOT re-exported here; import it from
 * `@insiderfinance/totalfinance/core/schema` so compute entrypoints never pull validator code (spec §6).
 */

export {
  PostconditionError,
  QuantError,
  InputError,
  ConvergenceError,
  ArbitrageError,
  DataError,
  UnsupportedError,
  ConfigurationError,
  isQuantError,
  missingFieldError,
  wrongShapeError,
  ErrorCode,
} from './errors.js';
export type { QuantErrorOptions } from './errors.js';

export {
  emptyDiagnostics,
  warning,
  plausibilityWarnings,
  suspiciousReturnsWarning,
  WarningCode,
} from './diagnostics.js';
export type { Diagnostics, QuantWarning, WarningSeverity } from './diagnostics.js';

export type {
  Assumptions,
  GreekUnits,
  ThetaUnit,
  VegaUnit,
  RhoUnit,
  DividendModel,
} from './assumptions.js';
export {
  CONVENTIONS_VERSION,
  DEFAULT_DAY_COUNT,
  DEFAULT_COMPOUNDING,
  DEFAULT_DIVIDEND_YIELD,
  DEFAULT_GREEK_UNITS,
} from './assumptions.js';

export type { Computed } from './computed.js';
export { isComputed, isTrustworthy } from './computed.js';
export type { Provenance } from './provenance.js';

export {
  assertFiniteResult,
  assertFiniteValue,
  requireRepresentableResult,
  stableSum,
  finalizeResult,
  facade,
  seriesFacade,
} from './facade.js';
export type { Facade, SeriesFacade } from './facade.js';

export type {
  OptionType,
  OptionStyle,
  Settlement,
  ExerciseTime,
  Deliverable,
  OptionContract,
} from './contracts.js';

export type { EpochMs, DayCount, InterestCompounding } from './time.js';
export {
  US_EQUITY_HALF_DAY_RULES,
  isUsEquityHalfDay,
  usEquityCloseUtcMs,
  usEquitySessionInstant,
  usEquityMarketDayIndex,
  usEquityMarketDateUtcMs,
  optionExpiryToMs,
  resolveAsOf,
  resolveValuationAsOf,
  validateResolvedExpiry,
  resolvedExpiry,
} from './time.js';

export {
  parseIsoDate,
  isoDateToEpochMs,
  yearFraction,
  discountFactor,
  compoundingPeriodsPerYear,
  compoundFactor,
} from './dates.js';
export type { CalendarDate } from './dates.js';

export type {
  SymbolId,
  Bar,
  Quote,
  Trade,
  OptionQuote,
  OptionQuoteGreeks,
  OptionQuoteGreeksProvenance,
  OptionTrade,
  Dividend,
  CorporateAction,
  RateCurvePoint,
  RateCurve,
  OrderBookLevel,
  OrderBook,
  RawFundamentalsRecord,
  MarketInputs,
  PriceSource,
} from './market-data.js';
export { requireRateCurveData, selectQuotePrice } from './market-data.js';

export { parseOccSymbol, formatOccSymbol, isOccOptionSymbol } from './symbology.js';
export type { OccOptionSymbol } from './symbology.js';

// B6 — one order vocabulary: side, type, time-in-force, and the sign↔side bridge.
export { ORDER_SIDES, ORDER_TYPES, TIME_IN_FORCE_VALUES, sideOf, signOf } from './orders.js';
export type { OrderSide, OrderType, TimeInForce } from './orders.js';

export {
  createRuleCalendar,
  defineCalendar,
  alwaysOpen,
  weekendsOnly,
  dayOfWeek,
  addDays,
  ymd,
  nthWeekdayOfMonth,
  lastWeekdayOfMonth,
  observedHoliday,
  easterSunday,
  goodFriday,
} from './calendar.js';
export type { Calendar, CalendarConfig, DaySession, Weekday, HolidayRule } from './calendar.js';

export {
  isFiniteNumber,
  isPositive,
  isNonNegative,
  between,
  clamp,
  round,
  toFixedSafe,
  formatMoney,
  formatPercent,
} from './numeric.js';
export type { BetweenOptions, FormatMoneyOptions, FormatPercentOptions } from './numeric.js';

export {
  ensureEnum,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensurePositive,
  ensureNonNegative,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
  ensureKnownKeys,
  finiteOrNull,
} from './invariants.js';

// Type-only re-exports (erased at runtime — safe for hot paths).
/**
 * RV9 — `requireFiniteFields` was exported while the type of its options argument was not. That was
 * survivable while the argument was optional; it is not now that `exampleCall` is required, because
 * a caller must supply an object of a type they cannot name. The nameability inventory caught it as
 * `unreachable` ("no package exports it") the moment the argument stopped being optional.
 */
export type { RequireFiniteFieldsOptions } from './invariants.js';
export { validateClosedRequest } from './validation.js';
export type {
  ClosedRequestSpecification,
  ClosedRequestTeaching,
  ValidationBranchSpecification,
  ValidationFieldKind,
  ValidationFieldSpecification,
} from './validation.js';
export type { JSONSchema } from './schema/json-schema.js';
