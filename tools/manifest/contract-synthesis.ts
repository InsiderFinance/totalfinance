/**
 * Synthesized inputs, so a contract without a hand-written fixture can still be MEASURED.
 *
 * 1,396 must-enforce contracts had no fixture, and "unmeasured" is honest but useless — it is the gap,
 * not the answer. Writing 1,396 fixtures by hand is the wrong shape of work when the inventory now
 * knows every parameter's name, declared type, kind, and optionality (3B.0-R1). So: build a plausible
 * input from the declaration, and let the library itself referee.
 *
 * ## The safety property that makes this trustworthy
 *
 * A synthesized input is only used if the BASELINE call succeeds. If `f(synthesized)` throws, the
 * synthesis was wrong about the contract and the path stays `unmeasured` — because a probe cannot tell
 * "rejected my bad baseline" from "rejected the mutation," and guessing between them is how a
 * measurement harness starts inventing findings. Synthesis can therefore only ever ADD coverage; it can
 * never produce a false verdict.
 *
 * That is also why the value table below is allowed to encode domain knowledge (`spot` → 100,
 * `volatility` → 0.2) even though the spec forbids generated artifacts from inventing financial
 * meaning. These values are not recorded as a contract, a unit, or a default — nothing downstream reads
 * them. They are a key that either opens the door or does not, and the door decides.
 */

import type { CallableSignatureNode, LiteralValue } from './contract-fields.js';

/**
 * THE dimension. Every sequence and every matrix axis is this long, so that arguments built
 * independently are nonetheless mutually consistent — see the note on `matrix`.
 *
 * 60 because it clears the warmup of every indicator in this library; the value matters less than the
 * fact that there is only one of it.
 */
const SERIES_LENGTH = 60;

/**
 * Optional fields that size a SIMULATION rather than shape a request.
 *
 * Named individually rather than pattern-matched: "any optional numeric that looks like a count" is
 * the kind of rule that silently starts supplying something meaningful. Each of these has a library
 * default in the thousands and no bearing on what the boundary accepts.
 */
const SIMULATION_BUDGET_FIELDS = new Set(['paths', 'stepsPerYear', 'simulations', 'iterations']);

/** What the harness supplies for one, small enough to probe with and large enough to be legal. */
const SIMULATION_BUDGET_VALUE = 32;

/**
 * THE settlement date, and the anchor of the one timeline every dated value is built against.
 *
 * Named rather than repeated because the relationship is the point: a curve's earliest pillar is its
 * reference date, so a settlement date before it is a query before the curve exists — which is what
 * `curveMetrics` reported when the two were chosen independently. Split into parts because
 * `datedPoints` builds its first pillar from them.
 */
const SETTLEMENT_YEAR = 2024;
const SETTLEMENT_DAY = '05';
const SETTLEMENT_DATE = `${SETTLEMENT_YEAR}-06-${SETTLEMENT_DAY}`;

/**
 * Field values by NAME, for object requests.
 *
 * Curated, not inferred: these are the values that make a call succeed in this domain. A wrong guess
 * costs coverage (the baseline throws, the path stays unmeasured), never correctness.
 */
const FIELD_VALUES: Readonly<Record<string, unknown>> = {
  // ---- option / underlying state ----
  spot: 100,
  strike: 100,
  forward: 100,
  price: 10,
  premium: 10,
  underlying: 'SPY',
  type: 'call',
  style: 'european',
  // ---- rates and yields (decimals) ----
  riskFreeRate: 0.05,
  dividendYield: 0,
  financingRate: 0.05,
  fundingRate: 0.0001,
  couponRate: 0.05,
  yield: 0.04,
  // ---- corporate valuation and typed fundamentals (FC2) ----
  //
  // Deep containers the declaration walker cannot assemble whole: the statement guards demand
  // identity agreement across three nested periods, the LBO demands sources = uses across five
  // independent fields, and a perpetuity demands growth strictly below the rate. Each value here
  // satisfies the law its consumers state.
  perpetualGrowthRate: 0.02,
  // A margin is a FRACTION of revenue in [0, 1); the generic 1 is a 100% margin the guards refuse.
  operatingMargin: 0.2,
  // A projected flow date must sit AFTER the valuation date (the curated settlement); FC1's dated
  // heads accept any date relative to their asOf, so one future date serves both families.
  cashFlowDate: '2027-06-15',
  // Tax rates are DECIMALS IN [0, 1); the generic numeric default of 1 is the classic
  // percent-vs-fraction unit trap, and both fields' guards say so.
  taxRate: 0.25,
  marginalTaxRate: 0.21,
  current: fundamentalStatementSet(2025),
  prior: fundamentalStatementSet(2024),
  priorPrior: fundamentalStatementSet(2023),
  baseStatements: fundamentalStatementSet(2025),
  marketObservation: {
    observedTimestampMs: Date.UTC(2026, 2, 2),
    sharePrice: 20,
    sharesOutstanding: 100,
  },
  searchRange: { from: 0.02, to: 0.5 },
  projectedDividendsPerShare: [{ amount: 2, timeYears: 1 }],
  projections: [
    { earningsPerShare: 3, dividendsPerShare: 1 },
    { earningsPerShare: 3.3, dividendsPerShare: 1.1 },
  ],
  observations: [
    { periodEndDate: '2024-12-31', amount: 100 },
    { periodEndDate: '2025-12-31', amount: 120 },
  ],
  peers: [
    { peerName: 'Peer A', multiple: 8 },
    { peerName: 'Peer B', multiple: 9 },
    { peerName: 'Peer C', multiple: 10 },
  ],
  components: [
    { label: 'equity', marketValue: 700, annualCostOfCapital: 0.1 },
    { label: 'debt', marketValue: 300, annualCostOfCapital: 0.045 },
  ],
  financingSideEffects: [
    {
      label: 'interest tax shield',
      cashFlows: [{ amount: 8, timeYears: 1 }],
      annualDiscountRate: 0.05,
    },
  ],
  unleveredCashFlows: [
    { amount: 100, timeYears: 1 },
    { amount: 110, timeYears: 2 },
  ],
  // The LBO entry: sources 430 + 600 EQUAL uses 1,000 + 20 + 10, and the exit year matches the
  // one-year forecast — the two laws the analysis refuses to see broken.
  purchaseEnterpriseValue: 1_000,
  transactionFees: 20,
  cashToBalanceSheet: 10,
  sponsorEquity: 430,
  tranches: [
    {
      trancheName: 'Term Loan A',
      principal: 600,
      annualInterestRate: 0.07,
      mandatoryAmortizationFraction: 0.05,
      cashSweepPriority: 1,
    },
  ],
  cashSweepFraction: 0.5,
  operatingForecast: [
    { year: 1, ebitda: 150, capitalExpenditure: 30, increaseInNetWorkingCapital: 5, taxRate: 0.25 },
  ],
  exit: { year: 1, exitEbitdaMultiple: 8, exitFees: 15 },
  // ---- loans and depreciation ----
  //
  // Both are FLOORS of a range whose ceiling is another field the harness fills independently:
  // `0 ≤ salvageValue < cost` and `0 ≤ balloon < principal`. The generic numeric default of 1
  // collides with a cost/principal of 1, and eight depreciation and loan boundaries answered
  // exactly that ("salvageValue must satisfy 0 ≤ salvageValue < cost. Received 1."). Zero is the
  // one value inside BOTH ranges for every positive cost/principal, whatever the other field gets.
  salvageValue: 0,
  balloon: 0,
  // ---- volatility (annualized decimals) ----
  volatility: 0.2,
  impliedVolatility: 0.2,
  atmVolatility: 0.2,
  standardDeviation: 2,
  // ---- time ----
  timeToExpiryYears: 0.25,
  timeToMaturityYears: 1,
  tenorYears: 1,
  timestampMs: 1_700_000_000_000,
  intervalHours: 8,
  // ---- windows and counts ----
  // `period` lives in FIELD_ALTERNATIVES: an indicator lookback nearly everywhere, and WHICH period
  // of a loan/depreciation schedule in valuation — bounded by a sibling the harness fills with 1.
  // Canonical oscillator windows. `fast` and `slow` are ordered by meaning, so the generic numeric
  // default of 1 for both would build a degenerate indicator the contract is right to reject.
  fast: 12,
  slow: 26,
  signal: 9,
  shortRoc: 11,
  longRoc: 14,
  lookback: 20,
  // A rolling window is a window over a series, so the generic numeric default of 1 is not a small
  // window — it is not a window. `rollingSharpe` says so: "window must be an integer ≥ 2, got 1".
  window: 20,
  bins: 10,
  paths: 256,
  seed: 1,
  steps: 16,
  quantity: 1,
  size: 1,
  multiplier: 100,
  // ---- probabilities and fractions ----
  confidence: 0.95,
  probability: 0.5,
  minSizeFraction: 0,
  // ---- market microstructure ----
  benchmark: series(),
  bid: 99.5,
  ask: 100.5,
  high: 101,
  low: 99,
  open: 100,
  close: 100,
  volume: 1_000,
  indexPrice: 100,
  markPrice: 100,
  // ---- identity and calendar strings ----
  //
  // These were the single largest remaining blocker. `valueForField` refused to guess at an
  // unconstrained string, which is right in general and wrong for a field called `issueDate` — the
  // NAME states the format as clearly as a literal union would. `createRuleCalendar`, `defineCalendar`
  // and `bonds.zeroCoupon` were all unmeasurable for want of a date and a timezone.
  // `name` and `label` are IDENTITIES, so they are minted per call — see `uniqueName`.
  label: 'test',
  version: '1.0.0',
  timezone: 'America/New_York',
  currency: 'USD',
  symbol: 'SPY',
  ticker: 'SPY',
  code: 'test.code',
  message: 'test message',
  functionName: 'testFunction',
  field: 'testField',
  //
  // ONE TIMELINE. Issue < settlement/reference < the first curve pillar < maturity, so a bond, a
  // curve and a settlement date built independently are nonetheless mutually consistent. See
  // `datedPoints`, whose pillars start after the settlement date for exactly this reason.
  issueDate: '2024-01-01',
  maturityDate: '2034-01-01',
  settlementDate: SETTLEMENT_DATE,
  startDate: '2024-01-01',
  endDate: '2024-12-31',
  // `expiry`, `date` and `asOf` live in FIELD_ALTERNATIVES: each means more than one thing here, and a
  // single entry would be shadowed by the alternatives anyway — two sources of truth, one unreachable.
};

/**
 * Names that mean genuinely different things in different contracts, with the alternatives in order.
 *
 * One table keyed by name assumes each name has one meaning, and `expiry` has three in this library —
 * all of them correct, none of them interchangeable:
 *
 *     callContract           a zoned datetime; refuses a date, and names the format it wants
 *     usEquityCall           an ISO date; refuses a zoned datetime, because the convention
 *                            "us-equity-close" already fixes the time and would contradict it
 *     SimulatedBroker        epoch milliseconds — "expiry must be a finite number"
 *
 * Every one of those messages is the library being precise about a contract the harness had flattened.
 * So the table stops pretending there is a single answer: `attempt` walks the alternatives, and
 * `contract-enforcement.ts` retries a REJECTED baseline with the next one.
 *
 * This is safe for the same reason synthesis is safe at all — a baseline that fails measures nothing,
 * so trying another can only add coverage. It is bounded by `ATTEMPTS`, and only a failing baseline
 * pays the cost.
 */
const FIELD_ALTERNATIVES: Readonly<Record<string, readonly unknown[]>> = {
  // Three shapes: ONE statement set for the single-period heads, a multi-year history for the
  // point-in-time selectors, and a four-quarter chain for the trailing-twelve-month composition.
  statements: [
    fundamentalStatementSet(2025),
    [fundamentalStatementSet(2023), fundamentalStatementSet(2024), fundamentalStatementSet(2025)],
    fundamentalQuarterChain(),
  ],
  // Two shapes AND a sign law. `cashFlows` is `TimedCashFlow[]` on the discounting/solver heads and
  // `DatedCashFlow[]` on the dated ones, so the alternatives walk the shapes like `expiry` walks its
  // formats. Mixed signs in both, because an internal rate is only defined between an outflow and an
  // inflow — "needs at least one negative AND one positive cash flow" is the contract stating its
  // domain, not being difficult — and a mixed-sign schedule is equally valid for every plain-NPV head.
  cashFlows: [
    [
      { amount: -1_000, timeYears: 0 },
      { amount: 600, timeYears: 1 },
      { amount: 600, timeYears: 2 },
    ],
    [
      { amount: -1_000, cashFlowDate: '2024-01-01' },
      { amount: 600, cashFlowDate: '2025-01-01' },
      { amount: 600, cashFlowDate: '2026-01-01' },
    ],
  ],
  expiry: ['2026-12-18T16:00:00-04:00', '2026-12-18', 1_797_264_000_000],
  // An indicator lookback window first — the meaning it has across technical analysis, where 1 would
  // build a degenerate indicator. Then a schedule INDEX: valuation's loan and depreciation heads ask
  // "which period", bounded by `usefulLifePeriods`/`numberOfPeriods` at their generic value of 1, and
  // answered "period must be an integer in [1, usefulLifePeriods]. Received 14." 1 is inside that
  // range whatever the sibling gets.
  period: [14, 1],
  // Curve pillars must fall AFTER the reference date, and a curve's reference date defaults to today.
  // "Pillar 2027-01-15 must be after the reference date" is only a complaint about the date used to
  // build one, so the alternatives walk outward rather than guessing a single horizon.
  date: ['2024-06-03', '2030-06-03', '2099-06-03'],
  // A NUMBER joined the walk: `asOf` is also an epoch-ms instant on the point-in-time heads,
  // whose scalar judge rightly refuses every date string. The instant sits after the curated
  // fundamental filings (late February 2026). '2099-06-03' leaves the reachable window (three
  // attempts); nothing in the artifact measured through it at the time of this edit.
  asOf: ['2024-06-03', Date.UTC(2026, 5, 1), '2030-06-03'],
};

/** How many baselines to try before recording the boundary as rejected. */
export const ATTEMPTS = 3;

/**
 * A curated value, COPIED when it is a container.
 *
 * Every entry in the table was a primitive until `benchmark` needed a series. A shared array would
 * hand the same instance to every probe, and probes mutate what they are given — one probe's
 * `empty-series` mutation would silently become the next one's baseline. `freshArguments()` exists to
 * prevent exactly that, and a shared reference inside the table would have defeated it from below.
 */
/**
 * A fresh identity per call, for fields that NAME something rather than describe it.
 *
 * `register(entry)` writes into a global indicator registry, and registering the same name twice is
 * correctly refused. With a constant `name: 'Test'`, the baseline succeeded and then EVERY probe was
 * refused as a duplicate — so the boundary was scored `enforced` on the strength of rejections that
 * had nothing to do with the mutations. A false positive of exactly the kind this phase exists to
 * remove, and it was invisible until callback synthesis let `register` run at all.
 *
 * It also showed up as the generator disagreeing with itself: two passes in one process, three
 * records apart, because pass two inherited pass one's registrations.
 *
 * A counter rather than randomness, and RESET PER BOUNDARY rather than left to run for the process:
 * a name does reach the artifact when a boundary echoes its input back in `returned`, so a
 * process-wide counter made measuring the same boundary twice produce two different records. Reset
 * per boundary, every measurement of X mints the same sequence for X while every call within X still
 * gets its own identity.
 */
let mintedNames = 0;
function uniqueName(): string {
  mintedNames += 1;
  return `Test${mintedNames}`;
}

/**
 * Start a boundary's measurement from a clean identity counter. Called by the harness before each
 * boundary so that measuring it twice yields the same record.
 */
export function resetSynthesisIdentities(): void {
  mintedNames = 0;
}

function copyCurated(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyCurated);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        copyCurated(entry),
      ]),
    );
  }
  return value;
}

function curatedValue(name: string, attempt = 0): unknown {
  if (name === 'name') return uniqueName();
  const alternatives = FIELD_ALTERNATIVES[name];
  // Copied for the same reason the FIELD_VALUES branch copies: probes mutate what they are given,
  // and a shared container inside the table would leak one probe's mutation into the next baseline.
  if (alternatives) return copyCurated(alternatives[Math.min(attempt, alternatives.length - 1)]);
  const value = FIELD_VALUES[name];
  if (value !== undefined) return copyCurated(value);
  /**
   * ANY field whose NAME ends in `Date` is a date. The table listed six and the library has more.
   *
   * The entries above already made this argument — "the NAME states the format as clearly as a
   * literal union would" — and then enumerated instead of generalizing, so `paymentDate`,
   * `referenceDate` and `valuationDate` each got the generic `'x'` and each answered `Invalid ISO
   * date "x" (expected YYYY-MM-DD)`. A suffix is a weaker signal than a declared type and a much
   * stronger one than nothing, and a wrong guess still only ever costs coverage.
   */
  if (/[a-z]Date$/.test(name)) return SETTLEMENT_DATE;
  return undefined;
}

/**
 * Names that mean a CALENDAR DATE even though they do not end in `Date`.
 *
 * Deliberately a short, closed list rather than a clever pattern. Every entry is a word that names a
 * point in time on its own — `range: { from, to }`, `tradingDaysToExpiry(calendar, from, expiry)` —
 * and each was answering `Invalid ISO date "x" (expected YYYY-MM-DD)`. Words that only SOMETIMES mean
 * a date are left out on purpose: `period` and `term` are lookbacks far more often than dates, and a
 * guess that is wrong more than half the time costs coverage it was meant to buy.
 */
const DATE_NAMES = new Set([
  'asOf',
  'effective',
  'end',
  'expiration',
  'expiry',
  'from',
  'maturity',
  'settlement',
  'start',
  'to',
  'valuation',
]);

/**
 * The last-resort STRING, which is `'x'` unless the name says it is a date.
 *
 * This is the only place the generic fallback is produced, and it is deliberately the narrowest
 * possible intervention: it changes a value that was ALREADY guaranteed to fail for a date-typed
 * field, so it cannot turn a passing baseline into a failing one. Widening the default for all
 * strings would — a free-form string field accepts `'x'` today, and a date would be no better.
 */
function genericString(name: string): string {
  return DATE_NAMES.has(name) || /[a-z]Date$/.test(name) ? SETTLEMENT_DATE : 'x';
}

/**
 * A strictly INCREASING series.
 *
 * The default series is `100 + sin(i/4)·5 + i·0.05`, which is realistic price data and emphatically
 * not monotonic — so every interpolation axis refused it: "xs must be strictly increasing (breaks at
 * index 7)". An axis is not a price path, and the contract says so.
 */
function increasing(length = SERIES_LENGTH): number[] {
  return Array.from({ length }, (_, index) => index);
}

/** `[date, value]` tuples, the shape curve builders ask for by example in their own error text. */
function datedPoints(count = 8): [string, number][] {
  /**
   * Pillars AFTER the settlement date and before maturity — one timeline, like `SERIES_LENGTH` is one
   * dimension.
   *
   * They used to sit in 2027 while the curated settlement date sat in 2024-01, and a curve built from
   * them answered `curveMetrics` with "Curve query before reference date (t=-3.03)". Neither value was
   * wrong on its own; they were chosen independently, which is the same failure as handing a 4x4
   * matrix to a function expecting a 60-length vector. Six-month steps from the settlement date keep
   * every curve query inside the curve.
   */
  return Array.from({ length: count }, (_, index) => {
    // The FIRST pillar IS the settlement date: a curve's reference date is its earliest pillar, so
    // anything earlier is a query before the curve begins. Then every six months out.
    const month = 6 + index * 6;
    const year = SETTLEMENT_YEAR + Math.floor((month - 1) / 12);
    const day = index === 0 ? SETTLEMENT_DAY : '15';
    return [
      `${year}-${String(((month - 1) % 12) + 1).padStart(2, '0')}-${day}`,
      0.02 + index * 0.005,
    ];
  });
}

/** `{ x, y }` pairs — what `technicalAnalysis.pairs(xs, ys)` builds, per the error that names it. */
function pairs(count = SERIES_LENGTH): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    x: 100 + Math.sin(index / 4) * 5,
    y: 100 + Math.cos(index / 5) * 4,
  }));
}

/**
 * A small symmetric POSITIVE-DEFINITE matrix.
 *
 * `Matrix` and `Array<Array<number>>` classify as `series`, so synthesis handed them a flat number
 * array and 21 boundaries died inside the library on `row.slice` — a 1-D array has no rows. The
 * reviewer's `determinant` example was this: declared a matrix, given a vector, and the resulting
 * verdict was about a call that never made sense.
 *
 * Positive-definite rather than arbitrary, because the linear-algebra boundaries that want a matrix
 * mostly want THAT matrix: `cholesky`, `nearestPsd`, `nearestCorrelation` and
 * `correlatedNormalSampler` all reject an indefinite one, and rightly. Equicorrelation — unit diagonal,
 * a constant ρ off it — has eigenvalues 1 + (n−1)ρ once and 1 − ρ with multiplicity n−1, so it is
 * positive-definite at EVERY size for 0 ≤ ρ < 1, and is simultaneously a valid correlation matrix.
 * (The earlier note here claimed diagonal dominance, which is a different property and stops holding
 * at n > 6; the conclusion survives, the reason given for it did not.)
 *
 * ONE DIMENSION PER CALL. The default is the series length, not a small constant, because a contract
 * taking both a matrix and a vector requires them to AGREE — and the harness, building each argument
 * independently, had no way to say so. Every one of these was the same 4-versus-60 mismatch, and each
 * function named it exactly:
 *
 *     bilinearInterp: z must be 60×60.
 *     matVec: the matrix has 4 columns but the vector has length 60.
 *     luSolve: b has 60 entries but the system is 4×4.
 *     kalman: F has the wrong shape (expected 60×60).
 *
 * Nine such messages named a dimension the harness had itself supplied. Sizing the matrix from the
 * series is the whole fix; a 60×60 decomposition is microseconds.
 */
/**
 * A COVARIANCE-SHAPED MATRIX, sized for PROBING rather than for realism.
 *
 * It was `SERIES_LENGTH` — a 60x60 dense matrix — because a series is 60 long and the two numbers
 * looked like the same number. They are not. A series length is about having enough observations for
 * an estimator to accept; a matrix DIMENSION is a problem size, and every iterative solver in the
 * library pays it quadratically per iteration. `maxSharpe` runs a 5,000-iteration projected gradient
 * over whatever it is handed, so 60 assets cost ~1.5s PER PROBE and the whole enforcement pass was
 * 167s, of which one boundary was 158s.
 *
 * Recording arms for every union multiplied the variants those probes run against, and five
 * boundaries then blew a FIVE MINUTE per-boundary budget and were recorded `probe-timeout` — a cost
 * regression turning into a measurement loss.
 *
 * 12 is chosen against what the probes actually ask. They ask whether a boundary rejects an unknown
 * key, a wrong type, a missing field, a non-finite value: none of that is a function of portfolio
 * size, and 12 clears the minimum-dimension checks in this library with room to spare. `series()` is
 * deliberately UNCHANGED at 60, because the estimators that demand "at least 8 observations" are
 * asking about series length and would fail on a shorter one.
 */
const MATRIX_SIZE = 12;

function matrix(size = MATRIX_SIZE): number[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0.2)),
  );
}

/** Does this declared type want a matrix rather than a flat series? */
function wantsMatrix(type: string): boolean {
  return (
    /\bMatrix\b/.test(type) ||
    /Array\s*<\s*Array\s*</.test(type) ||
    /ArrayLike\s*<\s*ArrayLike\s*</.test(type) ||
    /number\s*\[\]\s*\[\]/.test(type)
  );
}

/**
 * A COMPLETE fundamental statement set (FC2). One synthetic company, three consecutive fiscal
 * years, every accounting identity tying exactly — because the statement guards check identity
 * agreement, magnitudes, and the strict period grammar, and a set failing any of them measures
 * nothing. Availability instants follow the ONE TIMELINE (filings land late February following
 * each fiscal year), so the curated market observation below can sit AFTER the latest filing.
 */
function fundamentalStatementSet(fiscalYear: number): Record<string, unknown> {
  const availableTimestampMs = Date.UTC(fiscalYear + 1, 1, 23);
  const period = {
    periodStartDate: `${fiscalYear}-01-01`,
    periodEndDate: `${fiscalYear}-12-31`,
    fiscalYear,
    periodType: 'year',
    availableTimestampMs,
    currency: 'USD',
    monetaryScale: 1,
  };
  const growth = fiscalYear - 2022; // 1, 2, 3 for FY2023..FY2025 — strictly increasing statements
  return {
    income: {
      period,
      revenue: 800 + growth * 100,
      costOfRevenue: 480 + growth * 50,
      grossProfit: 320 + growth * 50,
      operatingExpenses: 200 + growth * 20,
      operatingIncome: 120 + growth * 30,
      interestExpense: 12,
      incomeTaxExpense: 22 + growth * 7,
      netIncome: 86 + growth * 23,
      sellingGeneralAdministrativeExpense: 120 + growth * 10,
      dilutedSharesOutstanding: 100,
    },
    balance: {
      period,
      cashAndCashEquivalents: 100 + growth * 25,
      shortTermInvestments: 20 + growth * 5,
      accountsReceivable: 80 + growth * 10,
      inventory: 60 + growth * 7,
      currentAssets: 300 + growth * 40,
      propertyPlantEquipmentNet: 400 + growth * 25,
      totalAssets: 1_000 + growth * 125,
      currentLiabilities: 150 + growth * 10,
      accountsPayable: 40 + growth * 5,
      shortTermDebt: 30,
      longTermDebt: 270 - growth * 10,
      totalLiabilities: 500 + growth * 30,
      totalEquity: 500 + growth * 95,
      retainedEarnings: 200 + growth * 75,
    },
    cashFlow: {
      period,
      operatingCashFlow: 120 + growth * 25,
      investingCashFlow: -80 - growth * 10,
      financingCashFlow: -25 - growth * 5,
      capitalExpenditure: 55 + growth * 7,
      depreciationAndAmortization: 36 + growth * 4,
      stockBasedCompensation: 9 + growth,
      dividendsPaid: 18 + growth * 3,
      shareRepurchases: growth * 5,
    },
  };
}

/** Four consecutive FY2025 fiscal quarters for the trailing-twelve-month composition. */
function fundamentalQuarterChain(): Record<string, unknown>[] {
  return [1, 2, 3, 4].map((fiscalQuarter) => {
    const endMonth = String(fiscalQuarter * 3).padStart(2, '0');
    const endDay = fiscalQuarter === 1 || fiscalQuarter === 4 ? '31' : '30';
    const period = {
      periodEndDate: `2025-${endMonth}-${endDay}`,
      fiscalYear: 2025,
      fiscalQuarter,
      periodType: 'quarter',
      availableTimestampMs: Date.UTC(2025, fiscalQuarter * 3, 15),
      currency: 'USD',
      monetaryScale: 1,
    };
    return {
      income: {
        period,
        revenue: 240 + fiscalQuarter * 5,
        operatingIncome: 40 + fiscalQuarter,
        netIncome: 30 + fiscalQuarter,
        dilutedSharesOutstanding: 100,
      },
      balance: {
        period,
        cashAndCashEquivalents: 120 + fiscalQuarter * 5,
        totalAssets: 1_200 + fiscalQuarter * 10,
        totalLiabilities: 560,
        totalEquity: 640 + fiscalQuarter * 10,
      },
      cashFlow: {
        period,
        operatingCashFlow: 38 + fiscalQuarter,
        investingCashFlow: -20,
        financingCashFlow: -8,
        capitalExpenditure: 15,
      },
    };
  });
}

/** A representative closing series — long enough to clear any indicator warmup in this library. */
function series(): number[] {
  return Array.from(
    { length: SERIES_LENGTH },
    (_, index) => 100 + Math.sin(index / 4) * 5 + index * 0.05,
  );
}

/** A representative OHLCV bar series. */
function bars(): Array<Record<string, number>> {
  return series().map((close, index) => ({
    open: close - 0.2,
    high: close + 0.6,
    low: close - 0.6,
    close,
    volume: 1_000 + index,
  }));
}

/** The first member of a string-literal union (`'call' | 'put'` → `'call'`), when the type is one. */
function firstLiteral(type: string): string | null {
  const literals = [...type.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  return literals.length > 0 ? literals[0]! : null;
}

/**
 * A DECLARED closed set outranks the curated name table. The table is a heuristic; a literal union is
 * a statement of fact.
 *
 * The precedence used to run the other way, on the reasoning that `period: 1` is technically a number
 * and financially useless — true, and it does not generalize. `field` was curated as `'testField'`
 * because nothing better suggested itself, and twelve `FeaturePipeline` boundaries answered with the
 * closed set they had declared all along: "field must be one of open | high | low | close. Received
 * "testField"." The library was not being difficult. It was reading its own declaration back to a
 * harness that had overridden it with a guess.
 *
 * So: literals win where they exist, curation fills where the declaration is open, and the kind
 * default is the last resort. That ordering is what a consumer reading the `.d.ts` would do.
 */
function preferredValue(
  name: string,
  literals: readonly LiteralValue[] | undefined,
  type?: string,
  attempt = 0,
): unknown | undefined {
  if (literals && literals.length > 0) return literals[0];
  if (type !== undefined) {
    const literal = literalUnion(type);
    if (literal !== null) return literal;
  }
  // A simulation budget the baseline volunteers is supplied here too, so the value is decided in one
  // place rather than at the site that decides to include the field.
  if (SIMULATION_BUDGET_FIELDS.has(name)) return SIMULATION_BUDGET_VALUE;
  return curatedValue(name, attempt);
}

/**
 * The first member, but only when the WHOLE type is a union of string literals.
 *
 * `firstLiteral` answers for any type containing a quote, which is right where the caller already
 * knows it holds a scalar and wrong everywhere else: `Array<'a' | 'b'>` and `{ side: 'buy' }` both
 * contain a literal and neither IS one. Since this now runs ahead of curation on every field, it has
 * to be the strict test rather than the permissive one.
 */
function literalUnion(type: string): string | null {
  return /^\s*'[^']*'(\s*\|\s*(?:'[^']*'|null|undefined))*\s*$/.test(type)
    ? firstLiteral(type)
    : null;
}

/**
 * One declared field of an object contract, as R7's `contract-fields.ts` recorded it.
 *
 * This is the structure synthesis was missing. Before it, an object argument could only be populated
 * from a curated name table, so a contract whose fields were not in that table produced `{}` and the
 * path went unmeasured — `cir` needs `{ a, b, r0, sigma }` and not one of those names is domain
 * vocabulary anyone would have thought to curate. The declaration knew the whole time.
 */
export interface SynthesisField {
  name: string;
  type: string;
  kind: string;
  optional: boolean;
  nullable: boolean;
  literals?: LiteralValue[];
  /** For a callable field: the resolved arity and return type, past any alias. */
  callSignature?: { parameters: number; returns: string };
  callSignatures?: CallableSignatureNode[];
  /** For a callable field returning a record: the return contract, so a stub can build one. */
  returns?: SynthesisField;
  element?: SynthesisField;
  fields?: SynthesisField[];
  /**
   * For a FIXED-ARITY TUPLE: one node per position, from the compiler.
   *
   * The durable replacement for parsing rendered type text. Each lesson the text parser had to be
   * taught — top-level commas, arrows, quoted literals, template literals — arrived as a defect, in
   * both directions: legal calls rejected and malformed ones accepted. The checker knew the answer
   * the whole time; this carries it instead of re-deriving it.
   */
  tuple?: SynthesisField[];
  /** Every arm as a COMPLETE node — the representation replacing the three arrays above. */
  branches?: SynthesisBranch[];
  truncated?: boolean;
}

export interface SynthesisParameter {
  name: string;
  type: string;
  /** Contract identity of this parameter's declared type, when it has one. */
  contract?: string | null;
  optional: boolean;
  kind: string;
  /** True for a rest parameter (`...args`) — part of the call grammar, so part of alias identity. */
  rest?: boolean;
  /** The declared closed set, when the type resolves to one — through an alias or written inline. */
  literals?: LiteralValue[];
  /** For a callable parameter: the resolved arity and return type, past any alias. */
  callSignature?: { parameters: number; returns: string };
  callSignatures?: CallableSignatureNode[];
  /** The first callable overload's return value, used to build a faithful stub. */
  returns?: SynthesisField;
  /** An inferred generic binder, not a type consumers need to import. */
  inferredGeneric?: true;
  /** Its generic arguments specialize the declaration tree. */
  instantiatedGeneric?: true;
  /** For a labelled TUPLE parameter: the contract identity of each element, in order. */
  tupleContracts?: (string | null)[];
  /** For a labelled TUPLE parameter: each element's declared field tree, in order. */
  tupleFieldTrees?: (SynthesisField[] | null)[];
  /**
   * The argument's KEY POLICY — `closed` (default), `open`, or `passthrough`.
   *
   * A closed request rejects undeclared keys; an OPEN one permits decoration and only promises that
   * the fields it declares are honoured; a passthrough carries foreign payload and owns only its own
   * envelope. Baseline validation has to read the same policy the probe does, or it calls a
   * legitimately decorated argument malformed — which is exactly what happened to the three
   * `calendars` boundaries, whose argument 0 is declared `open` and whose fixture passes a
   * `TradingCalendar` carrying `isTradingDay`.
   */
  policy?: string;
  /** The recursive declared shape, when the parameter names a contract the checker could expand. */
  fieldTree?: SynthesisField[];
  /** Every arm as a COMPLETE node — the representation replacing the arrays above. */
  branches?: SynthesisBranch[];
  /** The element's declared shape, when the parameter is a sequence of a named contract. */
  elementFieldTree?: SynthesisField[];
  /** For a FIXED-ARITY TUPLE parameter: one node per position, from the compiler. */
  tuple?: SynthesisField[];
}

/**
 * ONE ARM of a union, as a complete node.
 *
 * The three parallel arrays could describe an arm only insofar as it resembled an object
 * (`branchFields`) or a tuple (`branchTuples`), with its rendered text alongside (`branchTypes`).
 * An arm's own kind, literals, element contract, call signature and return had nowhere to live — so
 * `number | ArrayLike<number>` recorded no arms at all and one grammar stood in for two.
 */
export interface SynthesisBranch {
  type: string;
  kind: string;
  nullable?: boolean;
  literals?: LiteralValue[];
  fields?: SynthesisField[];
  element?: SynthesisField;
  tuple?: SynthesisField[];
  callSignature?: { parameters: number; returns: string };
  callSignatures?: CallableSignatureNode[];
  returns?: SynthesisField;
  branches?: SynthesisBranch[];
  /**
   * The generator stopped at its depth cap here — this arm describes SOME of its declaration.
   *
   * The producer has always emitted it (53 arms carry it today) and this interface did not declare
   * it, so every reader typed against `SynthesisBranch` was blind to it and `canonicalNode` could not
   * serialise a key the type said did not exist. That is the same shape as the `branchFields` gap: a
   * fact present in the artifact, absent from the model, and therefore absent from every identity
   * derived from the model.
   */
  truncated?: boolean;
}

/**
 * EVERY ARM OF A UNION, however the inventory spelled it — the single question every reader asks.
 *
 * `null` when the node is not a union. Prefers `branches`; falls back to translating the legacy
 * arrays, so a reader migrated to this helper works against both an artifact that carries arms and
 * one that does not. That is what lets the readers move in a commit whose artifact diff is empty:
 * the alternative is migrating producers and consumers together and then being unable to tell a
 * translation bug from an intended correction in the diff.
 */
export function armsOf(node: { branches?: SynthesisBranch[] }): SynthesisBranch[] | null {
  return node.branches && node.branches.length > 1 ? node.branches : null;
}

/** The legacy shape a reader still needs, derived from arms — one place, so the mapping is one line. */
export function armFields(arms: readonly SynthesisBranch[]): (SynthesisField[] | null)[] {
  return arms.map((arm) => arm.fields ?? arm.tuple ?? null);
}

/** The arm TYPES, derived from arms. */
export function armTypes(arms: readonly SynthesisBranch[]): string[] {
  return arms.map((arm) => arm.type);
}

/**
 * WHICH ALTERNATIVE of a union to build, keyed by the union node's PATH.
 *
 * Branch identity used to ride `attempt`, and `attempt` is a RETRY LADDER: it walks curated value
 * alternatives, admits choice-group optionals, AND picked the union branch. One counter selecting
 * three independent things cannot be read back as branch coverage — and because
 * `measureWithAlternatives` returns the moment a baseline is not rejected, a HEALTHY union was
 * measured on branch 0 and the verdict spoke for every other branch it never tried.
 *
 * A selection is keyed by path so a variant means the same thing on every walk, and so a nested union
 * inside a selected branch can be addressed without disturbing anything else.
 */
export interface VariantChoice {
  /** Index into the node's `branchFields`. */
  branch: number;
  /**
   * The discriminator FIELDS and literals that identify this alternative — a list, not one pair.
   *
   * `WhatIfProbabilityModel` needs `kind` AND `measure` together: three of its branches say
   * `kind: 'gbm'` and only `measure` tells them apart.
   */
  discriminator?: { field: string; value: LiteralValue }[];
  /**
   * True when another branch spells the same discriminator, so the text alone does not name it.
   *
   * Set by `alternativesFor`, read by `variantId`. Without it a union whose arms share a tag emitted
   * one alternative for two shapes.
   */
  ambiguous?: boolean;
  /**
   * For a PRESENCE GATE: the optional field this node stands for is absent from the call.
   *
   * Presence is a CHOICE, not a property of the site. Modelling it as a site flag — the first
   * attempt — left identity keyed on branch selection alone, so "field absent" and "field present,
   * branch #0" normalized to one key and collided: 30 declared outcomes across 17 exported paths
   * were never enumerated, 23 of them branch-`#0` calls. As a choice it flows through dedupe,
   * naming, materialization and realization by the same route as every other choice.
   */
  absent?: boolean;
  /** True for a presence gate, so rendering and handling never depend on inferring it. */
  gate?: boolean;
}

export type VariantSelection = ReadonlyMap<string, VariantChoice>;

/**
 * One step from the argument list toward a union's value.
 *
 * `element` is not "index 0" — it is "descend into what this sequence holds", and the first element
 * is simply the representative the harness builds. Naming the step for what it MEANS keeps the reader
 * honest when a sequence is empty: there is nothing to descend into, which is a different answer from
 * "the value is missing".
 *
 * `position` is the OPPOSITE of `element` and exists because the two were conflated. A sequence holds
 * one declared shape however many values it carries, so a union inside it is ONE node. A tuple's
 * positions are separate declarations that merely share a container: in `[number, A | B]` the union
 * lives at position 1 and position 0 has nothing to do with it. With only `element`, the walker had
 * no way to say "position 1", so it did not descend into tuple positions at all and `[number, A | B]`
 * declared ZERO union sites — a whole grammar the enumeration could not address, and therefore could
 * not measure, while reporting nothing missing.
 */
export type RouteStep =
  | { argument: number }
  | { property: string }
  | { element: true }
  | { position: number };

/** Follow a declaration route through a built argument list. `undefined` when it does not lead there. */
function followRoute(args: readonly unknown[], route: readonly RouteStep[]): unknown {
  let value: unknown = undefined;
  for (const step of route) {
    if ('argument' in step) {
      value = args[step.argument];
      continue;
    }
    if (value === null || value === undefined) return undefined;
    if ('property' in step) {
      if (typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[step.property];
      continue;
    }
    if ('position' in step) {
      // A tuple position is addressed exactly, and a shorter tuple does not lead there. `length` is
      // checked rather than trusting `undefined`, so a legitimately-undefined position stays
      // distinguishable from one the value never had.
      if (!Array.isArray(value) || step.position >= value.length) return undefined;
      value = value[step.position];
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) return undefined;
    value = value[0];
  }
  return value;
}

/** A union node reached on a walk, with every alternative it offers. */
export interface UnionSite {
  /**
   * Dotted path QUALIFIED BY THE ANCESTOR SELECTION that made this node reachable —
   * `arg0:outer=deep.inner`, not `arg0.inner`.
   *
   * A nested union lives INSIDE a branch, so "the union at `arg0.inner`" is not one node: it is a
   * different declaration under every outer alternative. Keying it by the dotted path alone conflated
   * them, and did so silently in both directions. Enumeration dropped alternatives — an outer
   * `left | right` whose `left.inner` is `p | q` and whose `right.inner` is `r | s` emitted `left/p`,
   * `right/r` and `left/q`, because `arg0.inner` was already in the reached set by the time `right`
   * was selected, so `right/s` was never built or measured. And labelling misread them: a hand fixture
   * selecting `right/s` was reported as `right/q`, attributing evidence from one declaration to
   * another that happens to sit at the same dotted position.
   */
  path: string;
  /** The plain dotted path, for reading the value out of a built argument list. */
  valuePath: string;
  /**
   * Identity for selection and dedupe: the qualified path AND a digest of the branch schema.
   *
   * The ancestor qualifier distinguishes same-path unions that sit under different branches; the
   * digest distinguishes same-path unions whose ancestors are indistinguishable but whose declared
   * branches are not. Two unions with the same qualified path and the same schema genuinely ARE the
   * same node, and share a selection.
   */
  key: string;
  /**
   * The qualified id of the ancestor alternative this node lives inside — `''` at the root.
   *
   * A nested site is only meaningful once its ancestor branch is the one in play. Without this, a
   * fixture selecting the OUTER `left` branch was also matched against the site recorded under
   * `right`, and picked up a second label for a union its own value never reaches.
   */
  scope: string;
  alternatives: VariantChoice[];
  /**
   * HOW TO REACH this union's value from the argument list — the declaration's own route.
   *
   * A boolean saying "somewhere under an array" was the first attempt and cannot express where the
   * union actually lives: the reader descended exactly once, so `Array<Array<A | B>>` read branch 1
   * back as branch 0, and `Array<{ choice: A | B }>` resolved `arg0.items.choice` against the ARRAY
   * and read nothing at all. A depth integer fails the same way as soon as properties and elements
   * interleave.
   *
   * The route is the fix: `argument 0 → element → property "choice"` navigates exactly what the
   * declaration describes, in order, however deeply the two alternate. It is kept SEPARATE from
   * `path`, which is a display identity and must stay readable.
   */
  route: RouteStep[];
  /**
   * Every arm as the complete declaration node the selection machinery reads.
   *
   * A site once retained only the projected field/type arrays below. That projection cannot
   * distinguish unions whose OUTER arm is the same container but whose element contract differs,
   * such as `ReadonlyArray<{ date: ... }> | ReadonlyArray<{ time: ... }>`. Keeping the declaration
   * nodes makes fixture labelling use the same complete grammar that synthesis used to build it.
   */
  branches?: SynthesisBranch[];
  /** Legacy projections used by presence gates and declarations without complete arm nodes. */
  branchFields: (SynthesisField[] | null)[];
  branchTypes?: string[];
  /**
   * True when this site is a PRESENCE GATE for an optional field rather than a union of shapes.
   *
   * A minimal baseline omits optional fields, so a union inside one is not reached at all — and the
   * first attempt at saying so marked the UNION "optionally gated", which put presence outside the
   * selection and therefore outside identity: "absent" and "present, branch #0" normalized to one
   * key and collided, losing 30 declared outcomes across 17 exported paths.
   *
   * A gate is a node with two outcomes, absent and present, sitting ABOVE the unions it guards.
   * Everything beneath it is discovered only when it is present — the same nesting rule branch
   * selection already uses — so two required unions under one optional object are materialized
   * together and named together, instead of one being labelled absent while the call carries it.
   */
  gate?: boolean;
}

/**
 * A stable digest of a union's declared branches — the second half of a site's identity.
 *
 * Deliberately covers the branch TYPES and each branch's field names, requiredness, types and
 * literals: two unions distinguished only by a field's declared type are two different contracts, and
 * a digest that reads only the field NAMES would call them one. Order-sensitive by branch index,
 * because a union's branch order is part of what `branch: n` means.
 */
/**
 * A UNION'S IDENTITY IS ITS ARMS, ALL THE WAY DOWN.
 *
 * `branchDigest` hashed rendered type text plus each arm's immediate field names and types. That is
 * a fingerprint of how a union PRINTS and of the shallowest thing each arm contains — so two
 * materially different declarations could share one site key whenever their text agreed:
 *
 *   - an alias-resolved element changing from numeric to string,
 *   - a callback arm's resolved arity changing,
 *   - anything nested below an arm's first level.
 *
 * A shared key is not cosmetic. It is the identity a variant selection is filed under and the
 * fingerprint that decides which paths POOL their evidence, so a difference the hash cannot see is a
 * difference that silently shares a measurement.
 *
 * This serializes the COMPLETE node, recursively. Object fields sort by name because an object is
 * unordered; arms and tuple positions keep their order because `branch: n` and `position: n` name
 * positions. Every key an arm can carry is written, so adding one to `SynthesisBranch` without
 * adding it here is a visible omission rather than a silent one.
 */
function canonicalNode(node: SynthesisBranch | SynthesisField, depth = 0): string {
  if (depth > 12) return '…';
  const parts: string[] = [`t=${node.type ?? ''}`, `k=${node.kind ?? ''}`];
  if ('optional' in node && node.optional) parts.push('opt');
  if (node.nullable) parts.push('null');
  if (node.literals && node.literals.length > 0) {
    /**
     * The admitted values are serialised WITH THEIR TYPES.
     *
     * `[...literals].sort().join('|')` coerces to text, so a numeric domain `1 | -1` and a stringly
     * one `'1' | '-1'` produced the same digest — two different contracts sharing one identity, which
     * is precisely what this digest exists to prevent. `JSON.stringify` keeps `1` and `'1'` apart,
     * and sorting the SERIALISED forms keeps the ordering total across a mixed domain.
     */
    parts.push(
      `lit=${[...node.literals]
        .map((literal) => JSON.stringify(literal))
        .sort()
        .join('|')}`,
    );
  }
  /**
   * TRUNCATION IS PART OF THE SHAPE (RV27 P1-5).
   *
   * `truncated` says the generator stopped short of the declaration — the node describes some of a
   * contract rather than all of it. Leaving it out meant a node walked to the end and one cut off at
   * the depth cap had the SAME identity, so an arm could gain or lose the flag and `armsDigest` would
   * not move. An identity that cannot tell "this is the contract" from "this is as much of it as we
   * read" is not an identity for the contract.
   *
   * It is recorded here rather than made to abstain in validation, and that is the deliberate half.
   * A truncated arm is still judged on what it does describe: its members were read, they are correct
   * as far as they go, and refusing to check them would convert a partial description into no
   * measurement at all. What the flag must do is stop two different states of knowledge from sharing
   * an identity — which is a fingerprint problem, not a validation one.
   */
  if (node.truncated) parts.push('trunc');
  if (node.callSignature) {
    parts.push(`call=${node.callSignature.parameters}->${node.callSignature.returns}`);
  }
  if (node.callSignatures && node.callSignatures.length > 0) {
    parts.push(`calls=${JSON.stringify(node.callSignatures)}`);
  }
  const fields = node.fields;
  if (fields && fields.length > 0) {
    parts.push(
      `f={${[...fields]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((field) => `${field.name}:${canonicalNode(field, depth + 1)}`)
        .join(',')}}`,
    );
  }
  if (node.element) parts.push(`e=${canonicalNode(node.element, depth + 1)}`);
  if (node.tuple && node.tuple.length > 0) {
    parts.push(`p=[${node.tuple.map((slot) => canonicalNode(slot, depth + 1)).join(',')}]`);
  }
  if (node.returns) parts.push(`r=${canonicalNode(node.returns, depth + 1)}`);
  if (node.branches && node.branches.length > 0) {
    parts.push(`a=[${node.branches.map((arm) => canonicalNode(arm, depth + 1)).join(',')}]`);
  }
  return `(${parts.join(';')})`;
}

/** FNV-1a over a canonical string, base36 — short enough to keep a path readable. */
function fnv(shape: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < shape.length; index += 1) {
    hash ^= shape.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The identity of a union, from its complete arms.
 *
 * ORDER-SENSITIVE by default, because a site key is what `branch: n` selects against: reordering the
 * arms of a declaration reorders which alternative each index names, so it is a different site.
 *
 * `{ ordered: false }` is the ALIAS-GROUPING reading, and the difference is deliberate rather than an
 * inconsistency. That fingerprint answers "are these two paths the same CONTRACT", and `A | B` and
 * `B | A` accept exactly the same calls — so they must pool their evidence. Two questions, two
 * orderings, one canonical serialization underneath; collapsing them is how a positional selector
 * and a contract comparison end up disagreeing about what a union is.
 */
export function armsDigest(
  arms: readonly SynthesisBranch[],
  { ordered = true }: { ordered?: boolean } = {},
): string {
  const shapes = arms.map((arm) => canonicalNode(arm));
  return fnv((ordered ? shapes : [...shapes].sort()).join(';'));
}

function branchDigest(
  branches: readonly (SynthesisField[] | null)[],
  branchTypes?: readonly string[],
): string {
  const shape = branches
    .map((branch, index) => {
      const fields = (branch ?? [])
        .map(
          (field) =>
            `${field.name}${field.optional ? '?' : ''}:${field.type}${
              field.literals && field.literals.length > 0
                ? `=${[...field.literals].sort().join('|')}`
                : ''
            }`,
        )
        .sort()
        .join(',');
      return `${branchTypes?.[index] ?? ''}{${fields}}`;
    })
    .join(';');
  // FNV-1a, rendered base36. Deterministic across runs and processes, which the artifact requires —
  // and short enough that a qualified path stays readable in the artifact and in a failure message.
  let hash = 0x811c9dc5;
  for (let index = 0; index < shape.length; index += 1) {
    hash ^= shape.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The choice a selection makes at a QUALIFIED path — the one place that knows a selection is not
 * keyed by the dotted path.
 *
 * It is keyed by contextual identity (qualified path plus schema digest, see `UnionSite.key`),
 * because the same dotted path is a different union under a different ancestor branch. Callers that
 * want "whatever this selection chose at `arg0`" ask here rather than rebuilding a key by hand and
 * silently missing when the digest changes.
 */
export function choiceFor(selection: VariantSelection, path: string): VariantChoice | undefined {
  for (const [key, choice] of selection) {
    if (key.slice(0, key.lastIndexOf('~')) === path) return choice;
  }
  return undefined;
}

/**
 * The ruling's identity for one alternative: full path AND semantic discriminator.
 *
 * `arg1.options:type=ironCondor`, not `branch 3`. A branch index is a fact about the order the
 * checker happened to expand a union in; the discriminator is a fact about the call a user writes.
 */
export function variantId(path: string, choice: VariantChoice): string {
  // A PRESENCE GATE has two outcomes and no branches of its own.
  if (choice.gate === true) return `${path}:${choice.absent === true ? 'absent' : 'present'}`;
  if (!choice.discriminator || choice.discriminator.length === 0) return `${path}#${choice.branch}`;
  const tags = choice.discriminator.map((tag) => `${tag.field}=${tag.value}`).join(',');
  /**
   * A discriminator that does NOT identify the branch keeps the index as well.
   *
   * `{ kind: 'same'; a: number } | { kind: 'same'; b: number }` is a legal union whose tag is not a
   * discriminator at all. Naming both arms `kind=same` collapsed them into one alternative — the
   * second was discarded as a duplicate and its shape never measured — so where the text is shared,
   * the branch is part of the name.
   */
  return choice.ambiguous ? `${path}:${tags}#${choice.branch}` : `${path}:${tags}`;
}

/**
 * The discriminator of a branch: the first REQUIRED field carrying a closed literal set.
 *
 * Required, because an optional field cannot be what selects a branch — omitting it would leave the
 * value ambiguous, and a discriminated union that can be satisfied without its tag is not one.
 */
function discriminatorsOf(
  branch: readonly SynthesisField[],
  branches: readonly SynthesisField[][],
): SynthesisField[] {
  const candidates = branch.filter((field) => !field.optional && (field.literals?.length ?? 0) > 0);
  if (candidates.length <= 1) return candidates;
  /**
   * A SINGLE tag is not always the discriminator. `WhatIfProbabilityModel` has three branches that
   * all say `kind: 'gbm'` and are told apart by `measure`; keying on the first literal field
   * collapsed them into one alternative — twice over, since two branches then produced the SAME id —
   * and `realWorld` and `explicit` were never built at all.
   *
   * So a tag earns its place only if it DISTINGUISHES: keep the fields whose literal sets differ
   * across branches, and identify the alternative by all of them together. A field every branch
   * declares identically carries no information and would only make the id longer.
   */
  const distinguishing = candidates.filter((field) => {
    const mine = [...(field.literals ?? [])].sort().join('|');
    return branches.some((other) => {
      if (other === branch) return false;
      const theirs = other.find((candidate) => candidate.name === field.name);
      return theirs === undefined || [...(theirs.literals ?? [])].sort().join('|') !== mine;
    });
  });
  return distinguishing.length > 0 ? distinguishing : candidates.slice(0, 1);
}

/**
 * Every alternative a union node offers — BRANCH times DISCRIMINATOR LITERAL, not branch alone.
 *
 * Structural branches that share a field shape still execute different runtime paths, so each literal
 * earns its own evidence. `strategyFromChain` is the worked example: seven structural branches, ten
 * `type` values, because the four spread variants share one shape and would otherwise be measured
 * once and reported as four.
 */
function alternativesFor(branches: readonly (SynthesisField[] | null)[]): VariantChoice[] {
  const alternatives: VariantChoice[] = [];
  const seen = new Set<string>();
  branches.forEach((branch, index) => {
    // A NON-OBJECT branch has no fields to discriminate on and is still an
    // alternative the contract offers — `ReadonlyArray<LegInput>` is a way to
    // call `classifyStrategy`, and omitting it let one branch's verdict speak
    // for three.
    if (branch === null || branch.length === 0) {
      alternatives.push({ branch: index });
      return;
    }
    const tags = discriminatorsOf(
      branch,
      branches.filter((entry): entry is SynthesisField[] => entry !== null && entry.length > 0),
    );
    if (tags.length === 0) {
      alternatives.push({ branch: index });
      return;
    }
    /**
     * The cross product of the DISTINGUISHING tags within one branch — usually one tag with several
     * literals, occasionally two that only identify a branch together.
     */
    let combinations: { field: string; value: LiteralValue }[][] = [[]];
    for (const tag of tags) {
      combinations = combinations.flatMap((prefix) =>
        (tag.literals ?? []).map((value) => [...prefix, { field: tag.name, value }]),
      );
    }
    for (const discriminator of combinations) {
      if (discriminator.length === 0) continue;
      /**
       * Two branches can spell the same alternative. When their SHAPES also agree they genuinely are
       * one alternative and the first to claim it owns it; when the shapes differ they are two, and
       * dropping the second measured one shape and reported two.
       */
      const tags = discriminator.map((tag) => `${tag.field}=${tag.value}`).join(',');
      const shape = branchDigest([branch]);
      const id = `${tags}|${shape}`;
      if (seen.has(id)) continue;
      seen.add(id);
      alternatives.push(
        [...seen].some((entry) => entry !== id && entry.startsWith(`${tags}|`))
          ? { branch: index, discriminator, ambiguous: true }
          : { branch: index, discriminator },
      );
    }
  });
  /**
   * Ambiguity is a property of the SET, so the first claimant learns it only after the second
   * appears. Marked in a second pass rather than in the loop, or the earlier arm keeps a name the
   * later one also answers to.
   */
  const spelling = new Map<string, number>();
  for (const alternative of alternatives) {
    if (!alternative.discriminator) continue;
    const tags = alternative.discriminator.map((tag) => `${tag.field}=${tag.value}`).join(',');
    spelling.set(tags, (spelling.get(tags) ?? 0) + 1);
  }
  for (const alternative of alternatives) {
    if (!alternative.discriminator) continue;
    const tags = alternative.discriminator.map((tag) => `${tag.field}=${tag.value}`).join(',');
    if ((spelling.get(tags) ?? 0) > 1) alternative.ambiguous = true;
  }
  return alternatives.length > 0 ? alternatives : branches.map((_, index) => ({ branch: index }));
}

/**
 * One synthesis walk's state: the retry rung, the branch selection, and what unions it reached.
 *
 * `discovered` is an OUTPUT — the walk reports the union nodes it passed so the caller can enumerate
 * variants without a second walker. Two walkers is how the same declaration gets two answers, which
 * this phase has now paid for in the field trees, the naming inventory and the call coordinates.
 */
interface BuildContext {
  attempt: number;
  selection: VariantSelection;
  discovered: Map<string, UnionSite>;
  /**
   * The PLAIN paths of optional fields this call materializes — one per gate chosen present.
   *
   * Plain paths on both sides, deliberately. The first version compared the selection's QUALIFIED
   * keys (`arg0.output.value:type=array.length~1a2b3c`) against ordinary child paths
   * (`arg0.output.value.length`), which can never match once a union sits anywhere above — so
   * `register`'s `length#1` request carried no `length` at all and was published `defective` about a
   * branch it never contained. The gate decides presence; this is the gate's answer, written in the
   * vocabulary the builder actually walks.
   *
   * The VALUE is the gate's qualified scope. Carrying only the path lost it: the enumerator keys a
   * union under a present gate as `arg0.choice:present.…` while the builder, having reduced the gate
   * to a bare path, looked it up as `arg0.choice.…` — so a variant naming branch `#1` built branch
   * `#0`. Honestly reported as `branch-not-realized`, and an avoidable generator failure rather than
   * a contract the harness cannot reach.
   */
  materialize: ReadonlyMap<string, string>;
  /**
   * The ANCESTOR SELECTION in force at the current point of the walk.
   *
   * `qualified` is the path as qualified by every branch chosen on the way down
   * (`arg0:outer=deep`); `plainAt` is the plain path it replaces, so a descendant's qualified path is
   * `qualified + plainPath.slice(plainAt.length)`. Carried on the context rather than threaded as a
   * parameter because every union node already sets it for the subtree it builds and restores it
   * after — one push and pop at three call sites, instead of a second path argument through nine.
   */
  scope: { qualified: string; plainAt: string };
}

/** The qualified path of a node, given the ancestor selection in force. */
const qualify = (context: BuildContext, path: string): string =>
  path.startsWith(context.scope.plainAt)
    ? context.scope.qualified + path.slice(context.scope.plainAt.length)
    : path;

/**
 * Run `build` with `site` recorded as the ancestor selection, then restore.
 *
 * `finally`, because a branch that cannot be built returns from the middle of the caller and a scope
 * left dangling would qualify the NEXT argument with this one's branch choice.
 */
function underScope<T>(
  context: BuildContext,
  scope: { qualified: string; plainAt: string },
  build: () => T,
): T {
  const outer = context.scope;
  context.scope = scope;
  try {
    return build();
  } finally {
    context.scope = outer;
  }
}

/** One synthesized call: the arguments, their coordinates, and the union nodes the walk reached. */
export interface SynthesizedCall {
  args: unknown[];
  coordinates: SynthesisParameter[];
  /** Union nodes reached on this walk, with every alternative each offers. */
  sites: UnionSite[];
}

/** A distinct call to measure: which alternatives it fixes, and what to call it. */
export interface Variant {
  /** `arg1.options:type=ironCondor`, or `baseline` for the all-defaults call. */
  id: string;
  selection: VariantSelection;
}

/** The all-defaults call. Every union node takes its first alternative. */
export const CANONICAL_VARIANT = 'baseline';

/**
 * A ceiling on variants per boundary, so one wide union cannot stall the pass.
 *
 * When it bites the caller RECORDS it (`alternativesTruncated`) rather than silently reporting the
 * subset as the whole: a bounded sweep that reads as exhaustive is the failure mode this phase keeps
 * finding, and it is not worth reintroducing for the sake of a tidy number.
 *
 * 24 -> 48 when presence became part of identity, and 48 -> 96 when a union's arms were recorded at
 * every node instead of only where the outer kind happened to be an object or an array.
 *
 *     measured ceiling   61   @totalfinance/backtest:optionsBacktest
 *                        57   curves.bootstrapMultiCurve (and its two aliases)
 *                       <=48  every other boundary
 *
 * A ceiling below the widest real contract does not bound cost, it bounds EVIDENCE — and it bounds
 * it silently, which is why the gate forbidding truncation exists and why this is set from a
 * measurement rather than rounded to a comfortable number. 96 was ~1.6x the widest real contract; the
 * previous 48 sat below two of them the moment nested unions became visible. FC7 slice 5
 * (2026-08-29) widened the portfolio event envelope to twenty-two families with nested settlement,
 * contract, and consideration unions, and the single-envelope heads
 * (`requirePortfolioEventEnvelope`, `duplicateBoundaryKey`, `portfolioEventContentHash`,
 * `PortfolioLedger#apply`) hit 96 — the gate fired as designed. Re-measured with the cap lifted:
 *
 *     measured ceiling  108   the four single-envelope portfolio heads (and their umbrella twins)
 *                        61   @totalfinance/backtest:optionsBacktest
 *                       <=57  every other boundary
 *
 * 176 was ~1.6x that widest real contract. Stage 4.6 slice 4 (2026-09-04) gave the options
 * backtester a rule book (`rules[]`, ten entry arms beside the single `entry`) and the gate fired
 * again. Re-measured with the cap lifted (enumerateVariants at 100,000):
 *
 *     measured ceiling  182   @totalfinance/backtest:optionsBacktest
 *                       108   the four single-envelope portfolio heads
 *                        31   @totalfinance/backtest:crossSectionalBacktest
 *
 * 288 is ~1.6x the new widest real contract, set from that measurement.
 */
export const VARIANT_LIMIT = 288;

/** A stable key for a selection, so the same combination is never queued twice. */
const selectionKey = (selection: VariantSelection): string =>
  [...selection.entries()]
    .map(([path, choice]) => variantId(path, choice))
    .sort()
    .join('|');

/**
 * ONE SEMANTIC IDENTITY FOR A CALL: the complete selection it makes, with implied defaults written out.
 *
 * Enumeration named a variant by the ONE site it fixed (`arg0.inner:mode=q`) while fixture labelling
 * named it by every site it selects (`arg0:outer=deep & arg0:outer=deep.inner:mode=q`). Those are the
 * same call under two names, so a hand fixture and its synthesized twin were both measured and
 * `planVariants` — which deduplicated on the display STRING — kept both: one reproduction produced
 * four measurements for three distinct calls.
 *
 * Normalizing is what makes the two comparable. An unfixed site is not "unspecified", it is fixed to
 * its default; writing that down turns a presentation string into an identity.
 */
export function normalizeSelection(
  parameters: readonly SynthesisParameter[],
  selection: VariantSelection,
): VariantSelection {
  const full = new Map(selection);
  // Filling a default can REVEAL a site nested under it, so this runs to a fixed point rather than
  // once. Bounded by the site count, which is finite because `declaredSites` guards its own cycles.
  for (let pass = 0; pass < 64; pass += 1) {
    let added = false;
    for (const site of declaredSites(parameters, full)) {
      if (full.has(site.key)) continue;
      full.set(site.key, site.alternatives[0]!);
      added = true;
    }
    if (!added) break;
  }
  return full;
}

/** The canonical NAME of a call: its normalized selection, rendered in declaration order. */
export function selectionId(
  parameters: readonly SynthesisParameter[],
  selection: VariantSelection,
): string {
  const full = normalizeSelection(parameters, selection);
  const sites = declaredSites(parameters, full);
  if (sites.length === 0) return CANONICAL_VARIANT;
  return sites
    .map((site) => variantId(site.path, full.get(site.key) ?? site.alternatives[0]!))
    .join(' & ');
}

/**
 * EVERY UNION NODE THE DECLARATION OFFERS — read from the declaration, never from a built call.
 *
 * Discovery used to be a side effect of synthesis: `enumerateVariants` walked the attempt-zero call
 * and collected whatever unions that walk happened to pass. A minimal baseline omits optional fields
 * on purpose, so any union inside one was INVISIBLE — not unmeasured, absent. A declaration-to-
 * generator audit found 18 public paths across eight scoped callables with fewer reached nodes than
 * declared, and six of them were published `enforced` with no alternatives at all while declaring a
 * nested union (`researchProtocol.trials` declares two shapes; its row claimed enforcement of a
 * contract whose alternatives had never been built).
 *
 * That is the worst failure available to this harness: not a wrong verdict but a confident one about
 * a surface it never touched, and nothing in the artifact to say so. Reading the declaration makes
 * every alternative either measured or explicitly `unmeasured` — an unbuildable one still gets a
 * variant, and a variant with no input is recorded, not dropped.
 *
 * Paths, scopes and keys are produced by exactly the rules the builder uses (`qualify`, `variantId`,
 * `branchDigest`), because a selection made here has to be honoured there.
 */
export function declaredSites(
  parameters: readonly SynthesisParameter[],
  selection: VariantSelection = new Map(),
): UnionSite[] {
  const found = new Map<string, UnionSite>();

  const record = (
    node: {
      name?: string;
      branchFields?: readonly (SynthesisField[] | null)[];
      branchTypes?: readonly string[];
      /** The complete arms — what the site key is computed from when they are available. */
      arms?: readonly SynthesisBranch[];
    },
    path: string,
    scope: { qualified: string; plainAt: string },
    route: RouteStep[],
  ): {
    fields: SynthesisField[] | null;
    /** WHICH arm was chosen — so the caller can descend into the arm rather than only its fields. */
    index: number;
    scope: { qualified: string; plainAt: string };
  } => {
    const branches = node.branchFields!;
    const qualified = path.startsWith(scope.plainAt)
      ? scope.qualified + path.slice(scope.plainAt.length)
      : path;
    // The COMPLETE arms decide identity and stay on the site so readers can distinguish container
    // unions by their element contracts, not merely by their identical outer shape.
    const key = `${qualified}~${node.arms ? armsDigest(node.arms) : branchDigest(branches, node.branchTypes)}`;
    const alternatives = alternativesFor(branches);
    if (!found.has(key)) {
      found.set(key, {
        path: qualified,
        valuePath: path,
        key,
        scope: scope.qualified,
        route: [...route],
        alternatives,
        ...(node.arms ? { branches: [...node.arms] } : {}),
        branchFields: [...branches],
        ...(node.branchTypes ? { branchTypes: [...node.branchTypes] } : {}),
      });
    }
    const choice = selection.get(key) ?? alternatives[0]!;
    const index = Math.min(choice.branch, branches.length - 1);
    return {
      fields: branches[index] ?? null,
      index,
      scope: { qualified: variantId(qualified, choice), plainAt: path },
    };
  };

  /**
   * The PRESENCE GATE of an optional field — recorded only when something below it is a union.
   *
   * An optional field with no union beneath it has nothing to choose: present or absent, the call
   * exercises the same contract, and a gate there would double the variant count for no evidence.
   */
  const gateFor = (
    path: string,
    scope: { qualified: string; plainAt: string },
    route: RouteStep[],
  ): { present: boolean; scope: { qualified: string; plainAt: string } } => {
    const qualified = path.startsWith(scope.plainAt)
      ? scope.qualified + path.slice(scope.plainAt.length)
      : path;
    const key = `${qualified}!gate`;
    const alternatives: VariantChoice[] = [
      { branch: 0, gate: true, absent: true },
      { branch: 1, gate: true },
    ];
    if (!found.has(key)) {
      found.set(key, {
        path: qualified,
        valuePath: path,
        key,
        scope: scope.qualified,
        gate: true,
        route: [...route],
        alternatives,
        branchFields: [null, null],
      });
    }
    const choice = selection.get(key) ?? alternatives[0]!;
    return {
      present: choice.absent !== true,
      scope: { qualified: variantId(qualified, choice), plainAt: path },
    };
  };

  /** Does anything at or below this field offer a union? Only then is presence a real choice. */
  const guardsAUnion = (field: SynthesisField, depth = 0): boolean => {
    if (depth > 6) return false;
    if ((armsOf(field)?.length ?? 0) > 1) return true;
    if (field.element && guardsAUnion(field.element, depth + 1)) return true;
    if (field.returns && guardsAUnion(field.returns, depth + 1)) return true;
    return (field.fields ?? []).some((child) => guardsAUnion(child, depth + 1));
  };

  /**
   * Cycle guard by (declared type, path), not by depth alone. A recursive contract — a node whose
   * field tree reaches its own type — would otherwise walk forever, and a plain depth cap would stop
   * at whatever the BUILDER can reach rather than at what the declaration says, which is the
   * confusion this function exists to end.
   */
  const walkFields = (
    fields: readonly SynthesisField[] | undefined,
    path: string,
    scope: { qualified: string; plainAt: string },
    seen: ReadonlySet<string>,
    route: RouteStep[],
  ): void => {
    for (const field of fields ?? []) {
      const childPath = `${path}.${field.name}`;
      if (field.optional && guardsAUnion(field)) {
        const gate = gateFor(childPath, scope, [...route, { property: field.name }]);
        // Absent: nothing below it is reachable, so nothing below it is discovered. That is what
        // keeps a sibling union from being named `absent` while the call actually carries it.
        const childRoute: RouteStep[] = [...route, { property: field.name }];
        if (gate.present) visit(field, childPath, gate.scope, seen, childRoute);
        continue;
      }
      visit(field, childPath, scope, seen, [...route, { property: field.name }]);
    }
  };

  const visit = (
    field: SynthesisField,
    path: string,
    scope: { qualified: string; plainAt: string },
    seen: ReadonlySet<string>,
    route: RouteStep[],
  ): void => {
    const mark = `${field.type}@${path}`;
    if (seen.has(mark)) return;
    const next = new Set([...seen, mark]);
    const arms = armsOf(field);
    if (arms) {
      const chosen = record(
        { branchFields: armFields(arms), branchTypes: armTypes(arms), arms },
        path,
        scope,
        route,
      );
      /**
       * DESCEND INTO THE ARM, not into its object fields.
       *
       * Walking `chosen.fields` sees a chosen arm only insofar as it is an object. Everything else
       * an arm can hold — an array element, tuple positions, a callback's return, a union nested
       * inside it — was unreachable, so `number | ReadonlyArray<{ a } | { b }>` discovered the outer
       * union and never the element union beneath the arm it selected. Visiting the arm as a NODE
       * routes it through the same element/tuple/returns/arms handling every other node gets, which
       * is also what gives a tuple arm `{ position: n }` steps instead of property steps.
       */
      const arm = arms[chosen.index];
      if (arm) {
        visit(
          { ...arm, name: field.name, optional: false, nullable: false },
          path,
          chosen.scope,
          next,
          route,
        );
      }
      return;
    }
    // An ARRAY ELEMENT shares its container's path — the same declared shape in every position, so a
    // union inside one is the same node in all of them. The builder says so too; a walk that stopped
    // at the container lost every union inside a sequence of records.
    // Descending into what the sequence HOLDS is a route step, not a flag.
    if (field.element) {
      visit({ ...field.element, name: field.name }, path, scope, next, [
        ...route,
        { element: true },
      ]);
    }
    /**
     * A TUPLE POSITION is its own declaration, so it gets its own path and its own route step.
     *
     * Deliberately NOT `element`: sharing the container's path is right for a sequence, whose every
     * value has one declared shape, and wrong for a tuple, whose positions do not. Keyed as
     * `path[i]`, position 1's union is a different node from position 0's — which is what makes them
     * separately selectable, and separately measurable.
     */
    field.tuple?.forEach((slot, index) => {
      if (!slot) return;
      visit({ ...slot, name: `${field.name}[${index}]` }, `${path}[${index}]`, scope, next, [
        ...route,
        { position: index },
      ]);
    });
    walkFields(field.fields, path, scope, next, route);
    if (field.returns) visit({ ...field.returns, name: field.name }, path, scope, next, route);
  };

  parameters
    .flatMap((parameter) => tupleElements(parameter.type, parameter) ?? [parameter])
    .forEach((parameter, index) => {
      const path = `arg${index}`;
      const seen = new Set<string>([`${parameter.type}@${path}`]);
      /**
       * AN OPTIONAL ARGUMENT IS GATED TOO. The rule was written for optional FIELDS and stopped at
       * the parameter list, so `spectralRisk(returns, options?)` published `arg1#0` and `arg1#1` and
       * never the call that omits `options` — the one shape every caller writes first. An optional
       * root argument guarding a union has the same two outcomes as an optional field, for the same
       * reason, and now by the same code.
       */
      const gated =
        parameter.optional &&
        (guardsAUnion(parameter as unknown as SynthesisField) ||
          (armsOf(parameter)?.length ?? 0) > 1 ||
          (parameter.fieldTree ?? []).some((field) => guardsAUnion(field)));
      const rootRoute: RouteStep[] = [{ argument: index }];
      const gate = gated ? gateFor(path, { qualified: '', plainAt: '' }, rootRoute) : null;
      if (gate && !gate.present) return;
      const root = gate ? gate.scope : { qualified: '', plainAt: '' };
      const parameterArms = armsOf(parameter);
      if (parameterArms) {
        const chosen = record(
          {
            branchFields: armFields(parameterArms),
            branchTypes: armTypes(parameterArms),
            arms: parameterArms,
          },
          path,
          root,
          rootRoute,
        );
        // The same descent at the root — see the field-level note.
        const arm = parameterArms[chosen.index];
        if (arm) {
          visit(
            { ...arm, name: parameter.name, optional: false, nullable: false },
            path,
            chosen.scope,
            seen,
            rootRoute,
          );
        }
        return;
      }
      walkFields(parameter.fieldTree, path, root, seen, rootRoute);
      if (parameter.elementFieldTree) {
        walkFields(parameter.elementFieldTree, path, root, seen, [...rootRoute, { element: true }]);
      }
      // The same descent at the ROOT. An unlabelled tuple parameter is one argument, not several —
      // `tupleElements` above only spreads a REST tuple, whose positions genuinely are arguments —
      // so a union inside one is reached by position, from here.
      parameter.tuple?.forEach((slot, slotIndex) => {
        if (!slot) return;
        visit(
          { ...slot, name: `${parameter.name}[${slotIndex}]` },
          `${path}[${slotIndex}]`,
          root,
          seen,
          [...rootRoute, { position: slotIndex }],
        );
      });
    });
  return [...found.values()];
}

/**
 * Every alternative of every union this callable declares — as distinct CALLS to measure.
 *
 * Deliberately NOT the Cartesian product of independent unions. The rule is: exercise each
 * alternative while holding the other coordinates at canonical valid values, and combine only where
 * coordinates genuinely interact — which here means a union NESTED INSIDE a branch, reachable only
 * once that branch is chosen. Two independent sibling unions are never crossed.
 *
 * `alternatives[0]` is skipped when extending, because the default for an unfixed node IS its first
 * alternative: choosing it reproduces the parent call exactly, and measuring the same call twice
 * would inflate the alternative counts with duplicates.
 */
export function enumerateVariants(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  producers?: Producers,
  limit: number = VARIANT_LIMIT,
): { variants: Variant[]; truncated: boolean } {
  /**
   * Sites come from the DECLARATION, not from a call that happened to build. See `declaredSites`:
   * discovery used to be a side effect of synthesis, so a union inside an optional field — omitted on
   * purpose, because a minimal baseline is what makes `omit-required` mean something — was absent
   * from measurement rather than unmeasured in it.
   */
  const rootSites = declaredSites(parameters, new Map());
  if (rootSites.length === 0) {
    return {
      variants: [{ id: CANONICAL_VARIANT, selection: new Map() }],
      truncated: false,
    };
  }
  const first = { sites: rootSites };
  /**
   * The all-defaults call, named by WHAT IT SELECTED rather than `baseline`.
   *
   * `baseline` is accurate and useless: reading `total: 10` with nine named alternatives leaves the
   * tenth anonymous, and the tenth is the one every other measurement is compared against. Its
   * selection is written out explicitly for the same reason — an implied default is a fact nobody
   * can check.
   */
  const canonicalSelection = normalizeSelection(parameters, new Map());
  const canonical: Variant = {
    id: selectionId(parameters, canonicalSelection),
    selection: canonicalSelection,
  };
  const variants: Variant[] = [canonical];
  const seen = new Set<string>([selectionKey(canonicalSelection)]);
  const queue: { selection: VariantSelection; sites: UnionSite[] }[] = [
    { selection: new Map(), sites: first.sites },
  ];
  /**
   * EVERY union path reached anywhere so far — global, not per queue entry.
   *
   * Scoping it to the current entry reintroduced the Cartesian product this function exists to
   * avoid. Descending into a nested union queued a selection whose `known` set held only the nested
   * path, so the independent SIBLINGS looked newly discovered, got crossed with it, and emitted a
   * duplicate id: a two-sibling plus one-nested case produced five variants where four are correct.
   */
  const reached = new Set(first.sites.map((site) => site.key));
  while (queue.length > 0) {
    const { selection, sites } = queue.shift()!;
    for (const site of sites) {
      // Already fixed by an ancestor selection: its alternatives were enumerated there.
      if (selection.has(site.key)) continue;
      for (const alternative of site.alternatives.slice(1)) {
        /**
         * The queue carries the EXPLICIT choices; the variant carries the normalized ones.
         *
         * Queuing the normalized selection looked equivalent and was not: normalizing fills every
         * reachable site with its default, so a nested union queued alongside it was already "fixed"
         * by the time its own alternatives came up, and `selection.has(site.key)` skipped every one
         * of them. The nested branch vanished from enumeration — the exact defect this identity work
         * exists to fix, reintroduced by the fix.
         */
        const explicit = new Map(selection).set(site.key, alternative);
        const next = normalizeSelection(parameters, explicit);
        const key = selectionKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        if (variants.length >= limit) return { variants, truncated: true };
        variants.push({
          id: selectionId(parameters, next),
          selection: next,
        });
        /**
         * Nodes reachable ONLY under this selection are nested inside the branch just chosen, so
         * their alternatives are queued with it held fixed. Nodes the parent already saw are
         * independent siblings and are deliberately left alone.
         */
        const nested = declaredSites(parameters, next).filter(
          (candidate) => !reached.has(candidate.key),
        );
        for (const candidate of nested) reached.add(candidate.key);
        if (nested.length > 0) queue.push({ selection: explicit, sites: nested });
      }
    }
  }
  return { variants, truncated: false };
}

/**
 * The arity of a fixed-length numeric tuple — `[number, number, number, number]` -> 4.
 *
 * `null` for anything else, including `number[]`, `ArrayLike<number>` and a tuple with a rest or an
 * optional element, because those genuinely are variable-length and a series is the right answer.
 */
function fixedNumericTupleArity(type: string): number | null {
  const inner = /^\[([^[\]]*)\]$/.exec(
    type
      .trim()
      .replace(/^readonly\s+/, '')
      .trim(),
  );
  if (!inner) return null;
  const elements = inner[1]!
    .split(',')
    .map((element) => element.trim())
    .filter((element) => element.length > 0);
  if (elements.length === 0) return null;
  return elements.every((element) => /^number$/.test(element)) ? elements.length : null;
}

/**
 * WHICH alternative does an already-built call select? — so a hand fixture can be labelled.
 *
 * A hand-written fixture is one call that already chose its branch, and it is the only KNOWN-VALID
 * call the harness has for that boundary. Treating it as "the" measurement left the contract's other
 * alternatives unmeasured; treating it as one alternative AMONG the declared set is the honest
 * reading, and that needs to know which one it is or the same alternative gets counted twice.
 */
export function alternativeOf(
  args: readonly unknown[],
  sites: readonly UnionSite[],
): VariantSelection | null {
  const chosen = new Map<string, VariantChoice>();
  /**
   * The ancestor alternatives this call has been shown to select, so a nested site recorded under a
   * branch it did NOT choose is skipped rather than matched. Ancestors first — a site's scope is a
   * strict prefix of its own path, so ordering by path length decides the scope before anything
   * inside it is considered.
   */
  const confirmed = new Set<string>(['']);

  /** Try ONE value against ONE site; `true` when it selected an alternative. */
  const readSite = (site: UnionSite, value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    const record = (typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const take = (alternative: VariantChoice): boolean => {
      chosen.set(site.key, alternative);
      confirmed.add(variantId(site.path, alternative));
      return true;
    };
    /**
     * A DISCRIMINATOR SELECTS DIRECTLY ONLY WHEN IT IS UNIQUE.
     *
     * Taking the first alternative whose tags matched labelled `{ kind: 'same', b: 1 }` as `#0`
     * against `{ kind: 'same'; a } | { kind: 'same'; b }`: a tag that identifies nothing still
     * matched something, and the typed matcher below was never reached. Where several alternatives
     * spell one tag it NARROWS the candidates and their declared shapes decide.
     */
    const tagged = site.alternatives.filter(
      (alternative) =>
        (alternative.discriminator?.length ?? 0) > 0 &&
        alternative.discriminator!.every((tag) => String(record[tag.field]) === tag.value),
    );
    if (tagged.length === 1) return take(tagged[0]!);
    if (tagged.length > 1) {
      const branch = selectBranch(
        {
          ...(site.path ? { name: site.path } : {}),
          branchFields: tagged.map(
            (alternative) => site.branchFields?.[alternative.branch] ?? null,
          ),
          ...(site.branchTypes
            ? {
                branchTypes: tagged.map(
                  (alternative) => site.branchTypes![alternative.branch] ?? '',
                ),
              }
            : {}),
        },
        value,
      );
      // No shape separates them either: they are indistinguishable, and the first is as honest an
      // answer as exists.
      return take(tagged[branch ?? 0]!);
    }
    /**
     * No discriminator matched, so the branch is decided by the ONE typed matcher — the same one the
     * probe and the validator use. Reading it structurally labelled an ARRAY fixture for
     * `Position | ReadonlyArray<number>` as `arg0#0`, the object arm, because `objectGap` returns
     * "valid" for anything that is not a plain object.
     */
    const index = selectBranch(site, value);
    if (index === null) return false;
    const alternative = site.alternatives.find((entry) => entry.branch === index);
    return alternative ? take(alternative) : false;
  };

  for (const site of [...sites].sort((a, b) => a.path.length - b.path.length)) {
    if (!confirmed.has(site.scope)) continue;
    const value = followRoute(args, site.route);
    /**
     * A PRESENCE GATE is answered by the value's existence, and answered either way. Reporting only
     * the present case would make absence unobservable, and an outcome nothing can observe is one
     * nothing can verify.
     */
    if (site.gate === true) {
      const alternative = site.alternatives.find((entry) =>
        value === undefined ? entry.absent === true : entry.absent !== true,
      );
      if (alternative) {
        chosen.set(site.key, alternative);
        confirmed.add(variantId(site.path, alternative));
      }
      continue;
    }
    /**
     * AN ELEMENT UNION IS READ FROM AN ELEMENT.
     *
     * Array elements share their container's path, so the value at a site like `arg0.ois` is the
     * ARRAY while the union's branches describe one instrument. Judging the array against object
     * branches matched no discriminator and fell through to a structural read answering "branch 0"
     * every time — so a call that correctly built `type=fra` was read back as `type=deposit`, and 51
     * correctly-built variants were reported as failing to realize themselves. The generator was
     * right and the reader was wrong, which is the harder direction to notice.
     *
     * The ROUTE decides where to look, so there is no container-versus-element ordering left to get
     * wrong — the declaration already said which one holds the union.
     */
    /**
     * The ROUTE already descended into whatever the declaration describes, so there is one value to
     * read and no candidate list to guess among.
     */
    const candidates: unknown[] = [value];
    for (const candidate of candidates) {
      if (readSite(site, candidate)) break;
    }
  }
  return chosen.size > 0 ? chosen : null;
}

/**
 * The fixture's alternative, NAMED — through the same identity enumeration uses.
 *
 * Kept as a separate function so the two callers cannot drift: one wants the selection (to compare),
 * the other wants the name (to publish), and both must come from one reading of the call.
 */
export function alternativeIdOf(
  args: readonly unknown[],
  sites: readonly UnionSite[],
  parameters: readonly SynthesisParameter[],
): string | null {
  const selection = alternativeOf(args, sites);
  return selection === null ? null : selectionId(parameters, selection);
}

/**
 * WHICH BRANCH OF A UNION DOES THIS VALUE SELECT? — the one answer, for every reader.
 *
 * There were three: the builder chose by index, the probe chose by structure (`satisfiedBranch`), and
 * fixture labelling chose by discriminator-then-structure. Three readers of one declaration is how
 * `{ at: 2 }` came to select the `{ at: string }` arm of `{ at: string } | { at: number }` — both
 * arms have the key `at`, structural matching asks only whether the key is present, and the first
 * arm won. The evidence was then filed against a contract the call never exercised.
 *
 * The ladder, most decisive first:
 *
 *   1. ELIMINATE any branch whose declared literals the value contradicts. A value that says
 *      `type: 'coveredCall'` is not a `strangle`, whatever keys it happens to carry.
 *   2. Prefer a branch the value's DISCRIMINATOR actually names. A union carrying a tag carries it
 *      precisely so this question has one answer.
 *   3. Prefer a branch that satisfies the TYPED walk — the step that separates `{ at: string }` from
 *      `{ at: number }`, and an array arm from an object one.
 *   4. Fall back to the STRUCTURAL walk. Deliberately kept: a value with one wrong field type still
 *      belongs to a branch, and attributing it to none would lose the probe entirely.
 *
 * Judges EVERY arm, including those with no field shape, by pairing `branchFields` with
 * `branchTypes`. Filtering to arms that have shapes was tried and breaks `classifyStrategy`
 * immediately: two of its three alternatives are arrays.
 */
export function selectBranch(
  node: {
    name?: string;
    branches?: SynthesisBranch[];
    /** The INTERNAL working shape — a `UnionSite`, which keeps the paired arrays. */
    branchFields?: readonly (SynthesisField[] | null)[];
    branchTypes?: readonly string[];
  },
  value: unknown,
): number | null {
  /**
   * READS THE ARMS, like every other union reader — and did not, which is how it hid.
   *
   * This function took `branchFields` as its own parameter type, so it kept type-checking against
   * nodes that still carried the legacy arrays long after `armsOf` became the one question. When the
   * arrays were deleted it silently answered `null` for every union: `satisfiedBranch` then fell
   * back to the merged tree, and a union parameter with no merged tree contributed NO fields to the
   * probe set. Ten boundaries quietly lost mutations — `deflatedSharpeRatio` 5 -> 4, `phiValue`
   * 7 -> 4 — with no verdict moving and nothing failing.
   *
   * A signature that names the representation it wants is a reader that cannot be migrated by
   * migrating the representation. That is the whole reason `armsOf` exists.
   */
  const arms = armsOf(node);
  const branches = arms ? armFields(arms) : (node.branchFields ?? null);
  const branchTypes = arms ? armTypes(arms) : node.branchTypes;
  if (!branches || branches.length === 0) return null;
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  const admitsLiterals = (branch: SynthesisField[] | null): boolean =>
    record === undefined ||
    (branch ?? []).every(
      (field) =>
        (field.literals?.length ?? 0) === 0 ||
        record[field.name] === undefined ||
        admits(field.literals, record[field.name]),
    );
  const discriminated = (branch: SynthesisField[] | null): boolean =>
    record !== undefined &&
    (branch ?? []).some(
      (field) =>
        (field.literals?.length ?? 0) > 0 &&
        record[field.name] !== undefined &&
        admits(field.literals, record[field.name]),
    );
  /**
   * The same rule as the validator: match against the ARM, falling back to a reconstruction only for
   * the internal `UnionSite`, which carries paired arrays and no arm nodes.
   */
  const fits = (index: number, structuralOnly: boolean): boolean =>
    nodeGap(
      arms
        ? { ...arms[index]!, ...(node.name !== undefined ? { name: node.name } : {}) }
        : branchNode(node.name, branchTypes?.[index], branches[index] ?? []),
      value,
      '',
      0,
      false,
      structuralOnly,
    ) === null;

  const eligible = branches
    .map((_, index) => index)
    .filter((index) => admitsLiterals(branches[index] ?? null));
  const tagged = eligible.filter((index) => discriminated(branches[index] ?? null));
  for (const pool of [tagged, eligible]) {
    const typed = pool.find((index) => fits(index, false));
    if (typed !== undefined) return typed;
  }
  for (const pool of [tagged, eligible]) {
    const structural = pool.find((index) => fits(index, true));
    if (structural !== undefined) return structural;
  }
  return null;
}

/**
 * The union nodes a callable's declaration offers, without committing to a call.
 *
 * Used to label a hand fixture: the sites come from the DECLARATION, the choice comes from the
 * fixture's own arguments.
 */
export function unionSites(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  producers?: Producers,
): UnionSite[] {
  /**
   * Every site reachable under ANY selection, not just the canonical walk's.
   *
   * A nested union lives inside a branch, so the all-defaults walk only reaches
   * the ones under the default branch. Identifying a hand fixture against that
   * list could never see a nested choice the fixture made — which is why a
   * fixture selecting `outer=deep, inner=q` was labelled `arg0:outer=deep` and
   * collided with the synthesized variant that takes the nested default.
   */
  const byKey = new Map<string, UnionSite>();
  for (const variant of enumerateVariants(parameters, fields, producers).variants) {
    for (const site of declaredSites(parameters, variant.selection)) {
      if (!byKey.has(site.key)) byKey.set(site.key, site);
    }
  }
  return [...byKey.values()];
}

/**
 * ONE READING OF "did this call do what it was asked to do", used by the generator and by the gate.
 *
 * There were two, and they disagreed in the same way: both compared a site's `scope` — a RENDERED
 * outcome id like `arg0:mode=deep` — against a map keyed by the internal digested key
 * (`arg0~7gkadw`). That comparison can never be true, so the reverse direction of the check silently
 * passed everything: a variant naming a child the call never built was accepted by the very test
 * written to catch it. Duplicating the oracle is what let one bug be two.
 *
 * Reachability is decided on CONFIRMED RENDERED OUTCOMES, which is the vocabulary `scope` is written
 * in. Returns one entry per discrepancy, so a caller can report as well as decide.
 */
export interface RealizationGap {
  /** The site's contextual key, for callers that need to line it up with a selection. */
  key: string;
  /** The site's qualified path, for a reader. */
  path: string;
  /** What the variant named, and what the call actually selects — `null` where it selects nothing. */
  named: string;
  built: string | null;
}

export function realizationGaps(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  producers: Producers | undefined,
  intended: VariantSelection,
  args: readonly unknown[],
): RealizationGap[] {
  const sites = unionSites(parameters, fields, producers);
  if (sites.length === 0) return [];
  const realized = alternativeOf(args, sites);
  if (realized === null) {
    return [...intended]
      .filter(([key]) => sites.some((site) => site.key === key))
      .map(([key, choice]) => ({
        key,
        path: sites.find((site) => site.key === key)?.path ?? key,
        named: variantId(key, choice),
        built: null,
      }));
  }
  const byKey = new Map(sites.map((site) => [site.key, site]));
  /** The outcomes the call is CONFIRMED to have taken, rendered the way `scope` is rendered. */
  const confirmed = new Set<string>(['']);
  for (const [key, choice] of realized) {
    const site = byKey.get(key);
    if (site) confirmed.add(variantId(site.path, choice));
  }
  const gaps: RealizationGap[] = [];
  // FORWARD: what the call selects must be what the variant named.
  for (const [key, choice] of realized) {
    const want = intended.get(key);
    if (want === undefined) continue;
    if (variantId(key, want) !== variantId(key, choice)) {
      gaps.push({
        key,
        path: byKey.get(key)?.path ?? key,
        named: variantId(key, want),
        built: variantId(key, choice),
      });
    }
  }
  // REVERSE: every outcome the variant named and the call could reach must have been observed.
  for (const [key, choice] of intended) {
    const site = byKey.get(key);
    if (!site || realized.has(key)) continue;
    // Nested under an outcome this call did not take — unreachable here, not unrealized.
    if (!confirmed.has(site.scope)) continue;
    gaps.push({ key, path: site.path, named: variantId(key, choice), built: null });
  }
  return gaps;
}

/**
 * A context for a walk that is NOT enumerating variants — a diagnostic probe, or a callback's return
 * value. Its `discovered` map is thrown away, which is correct: nothing about a stub's return shape
 * is a public union alternative the artifact should claim to have measured.
 */
const soloContext = (attempt = 0): BuildContext => ({
  attempt,
  selection: new Map(),
  materialize: new Map(),
  discovered: new Map(),
  scope: { qualified: '', plainAt: '' },
});

/**
 * Build a value for a union branch that is NOT an object shape.
 *
 * `classifyStrategy` accepts `Position | ReadonlyArray<LegInput> |
 * ReadonlyArray<ClassifiableLeg>`: two of its three alternatives are arrays and
 * expand to no fields, so a shape-only walk could not represent them and the
 * boundary was reported on the strength of the one branch it could build.
 *
 * Only the container is built here, from the branch's rendered type — the
 * inventory records no per-branch ELEMENT contract, so an array branch gets a
 * generic series. Where the boundary wants records that will be refused, and the
 * variant is recorded `unmeasured` rather than measured against a call that does
 * not typecheck. That is the honest outcome: an alternative we cannot build is a
 * gap, and a gap already denies the boundary `enforced`.
 */
function valueForBranchType(type: string): unknown | undefined {
  switch (kindOfType(type)) {
    case 'series':
      if (wantsMatrix(type)) return matrix();
      return /Bar|bar|ohlc/i.test(type) ? bars() : series();
    case 'numeric':
      return 1;
    case 'primitive': {
      const literal = firstLiteral(type);
      if (literal) return literal;
      if (/boolean/.test(type)) return false;
      if (/number/.test(type)) return 1;
      return /string/.test(type) ? 'x' : undefined;
    }
    default:
      return undefined;
  }
}

/** Record the node, then honour the selection for it — defaulting to its first alternative. */
function chooseBranch(
  context: BuildContext,
  path: string,
  branches: readonly (SynthesisField[] | null)[],
  branchTypes?: readonly string[],
  /** The complete arms, when the caller has them — the builder must key a site as discovery does. */
  arms?: readonly SynthesisBranch[],
): {
  fields: SynthesisField[] | null;
  branchType: string | undefined;
  choice: VariantChoice;
  /** True when a VARIANT named this branch, rather than it being the default. */
  selected: boolean;
  /** The scope a caller must install before building this branch's children. */
  scope: { qualified: string; plainAt: string };
} {
  const alternatives = alternativesFor(branches);
  const qualified = qualify(context, path);
  const key = `${qualified}~${arms ? armsDigest(arms) : branchDigest(branches, branchTypes)}`;
  if (!context.discovered.has(key)) {
    context.discovered.set(key, {
      path: qualified,
      valuePath: path,
      key,
      scope: context.scope.qualified,
      /**
       * The BUILDER's own sites carry no route: they are a by-product of construction and every
       * reader that needs to navigate uses `declaredSites`, which walks the declaration. Recording a
       * half-route here would be a second, weaker answer to a question that already has one.
       */
      route: [],
      alternatives,
      ...(arms ? { branches: [...arms] } : {}),
      branchFields: [...branches],
      ...(branchTypes ? { branchTypes: [...branchTypes] } : {}),
    });
  }
  const chosen = context.selection.get(key);
  const choice = chosen ?? alternatives[0]!;
  // INDEXED, never filtered. Dropping the null branches to "the ones with
  // shapes" renumbered the list, so `branch: 0` meant the first OBJECT branch
  // rather than the first declared one — an id that names the wrong alternative.
  const index = Math.min(choice.branch, branches.length - 1);
  return {
    fields: branches[index] ?? null,
    branchType: branchTypes?.[index],
    choice,
    selected: chosen !== undefined,
    scope: { qualified: variantId(qualified, choice), plainAt: path },
  };
}

/**
 * A deep copy that PRESERVES FUNCTIONS, unlike `structuredClone`.
 *
 * Each element of a synthesized sequence needs its own object, because probes mutate what they are
 * handed and a shared reference would let one probe decide the next one's baseline. `structuredClone`
 * did that correctly right up until callback synthesis started putting stubs inside element
 * contracts, at which point it threw `DataCloneError: (...args)=>{...} could not be cloned` and took
 * the whole generator with it.
 *
 * Functions pass through by REFERENCE on purpose. A stub is pure apart from its own counter, and
 * sharing that counter across the elements of one array is both harmless and deterministic — two
 * runs build the array in the same order and see the same sequence.
 */
function freshCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => freshCopy(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = freshCopy(entry);
    }
    return copy as T;
  }
  return value;
}

/** How deep to build nested objects. Matches the depth `contract-fields.ts` records. */
const MAX_BUILD_DEPTH = 4;

/**
 * A stub for a declared function type — read from the declaration, and shaped by ARITY.
 *
 * Callback synthesis was off for two years' worth of good reasons, all of which turned out to be
 * reasons against a CONSTANT stub rather than against stubs. The two documented hangs want opposite
 * things, and that is the whole design:
 *
 *     normalSample      let u1 = 0; while (u1 === 0) u1 = rng.next();
 *     adaptiveSimpson   bisects to depth 50 whenever a subinterval misses its tolerance
 *
 * `next()` takes NO arguments, so nothing but per-call variation can ever get it out of that loop —
 * a constant 0 never terminates, and any other constant terminates immediately but is not an RNG.
 * `integrand(x)` is the reverse: a value that varies per CALL is the worst possible integrand,
 * because adaptive quadrature reads the disagreement between coarse and fine panels as roughness and
 * subdivides, and 2^50 panels is indistinguishable from a hang. It wants a SMOOTH function.
 *
 * So arity decides. Zero arguments get a deterministic sequence in (0, 1) — which is what an RNG is.
 * One or more get a smooth bounded function of the first numeric argument, which is what an
 * integrand, an objective and a payoff all are. Both are pure and reproducible, so the artifact stays
 * deterministic; each stub owns its counter, so two runs with the same probes see the same values.
 *
 * The earlier note here said "no constant is safe for every numerical contract". That was true and
 * the conclusion drawn from it — that this needs per-boundary isolation first — was not: it needs a
 * stub that is not a constant.
 */
function callbackStub(
  type: string,
  /** The RETURN contract, when the declaration names a record rather than a scalar. */
  returnContract: SynthesisField | undefined,
  /** Depth of the surrounding build, so a stub's return value cannot recurse without bound. */
  depth: number,
  /** The walk's context and path, so a union in the RETURN contract is selected, not defaulted. */
  context: BuildContext,
  path: string,
  /**
   * The RESOLVED signature, when the inventory recorded one. Preferred over the text, because the
   * text is often just an alias: `adaptiveSimpson(integrand: ScalarFunction, …)` renders with no `=>`
   * in it at all, and 69 boundaries were unbuildable for exactly that reason while the checker had
   * known the answer all along.
   */
  declared?: { parameters: number; returns: string },
): ((...args: unknown[]) => unknown) | undefined {
  let returns: string;
  let nullary: boolean;
  if (declared) {
    returns = declared.returns.trim();
    nullary = declared.parameters === 0;
  } else {
    const arrow = type.indexOf('=>');
    if (arrow === -1) return undefined;
    returns = type.slice(arrow + 2).trim();
    nullary = /^\(\s*\)$/.test(type.slice(0, arrow).trim());
  }

  /**
   * A DECLARED record is built once and handed back on every call.
   *
   * Once, not per call, because these are identities as often as they are values: `defineIndicator`
   * calls `stream(parameters)` and then uses the result, and a stub that answered a different object
   * each time would be a stranger sort of lie than answering none. The probe mutates the ARGUMENT it
   * was given, never the stub's return value, so sharing it is safe.
   */
  if (returnContract !== undefined) {
    /**
     * Built in the CALLER'S context, not an isolated one.
     *
     * `soloContext()` carries an empty selection, so a union inside a callback's return contract was
     * enumerated as an alternative and then always built as branch zero — the variant named a branch
     * the stub never produced. The context is threaded now, which also records the return's union
     * nodes where the rest of the walk can see them.
     */
    const built = valueForField(returnContract, depth + 1, context, path);
    if (built !== undefined) return () => built;
    /**
     * An unconstrained array still has one universally valid structural value: the empty array.
     *
     * `AnyIndicator` returns `Array<any>`. Its element cannot be synthesized (correctly — `any`
     * promises no shape), but refusing the whole callback made `register` unbuildable even though
     * the callback itself is perfectly representable and `register` never calls it. Keep this
     * fallback local to callback RETURNS: an empty input series may violate a boundary's semantic
     * minimum length, while a synthesized callback result is still checked by the baseline call.
     */
    if (returnContract.kind === 'array' && !returnContract.tuple) return () => [];
  }
  if (/^(void|undefined)\b/.test(returns)) return () => undefined;
  if (/^boolean\b/.test(returns)) {
    // `true` rather than `false`: these are predicates like `Calendar.isBusinessDay` and
    // `OptionPricingEngine.supports`, where the permissive answer is the one that lets the call under
    // measurement proceed to the contract we are actually probing.
    return () => true;
  }
  if (/^string\b/.test(returns)) return () => 'x';
  if (/^number\b/.test(returns)) {
    if (nullary) {
      /**
       * A deterministic sequence in the OPEN interval (0, 1).
       *
       * Open at both ends on purpose: `normalSample` rejects 0 by looping, and `Math.log(1 - u)`
       * shows up in enough inverse-CDF code that 1 is worth avoiding too. A 16-bit LCG is plenty —
       * this has to look like an RNG to a consumer of one, not pass a randomness test.
       */
      let state = 12_345;
      return () => {
        state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
        return (state % 65_536) / 65_536 / 2 + 0.25;
      };
    }
    let calls = 0;
    return (...args: unknown[]) => {
      const first = args[0];
      const x = typeof first === 'number' && Number.isFinite(first) ? first : calls++;
      return 0.5 + 0.25 * Math.sin(x);
    };
  }
  return undefined;
}

/**
 * Build a value for one declared field, or `undefined` when the declaration gives nothing to go on.
 *
 * Order matters: the curated name table wins, because `period: 1` is technically a number and
 * financially useless, and several contracts reject it. Then the declaration's own literals, then the
 * kind. A wrong answer here costs coverage and never correctness — the baseline must still succeed.
 */
/**
 * Callback synthesis is enabled through `callbackStub` above. Its shape comes from the compiler,
 * nullary numeric callbacks vary deterministically like an RNG, and callbacks with arguments are
 * smooth functions suitable for numerical routines. The supervisor remains the final isolation
 * boundary for a callable whose semantics cannot be inferred safely from its signature.
 */
function valueForField(
  field: SynthesisField,
  depth: number,
  context: BuildContext,
  /** This field's own dotted path — the identity of a union node rooted here. */
  path: string,
): unknown | undefined {
  const attempt = context.attempt;
  // The type text is sniffed for literals only on SCALAR kinds. An object or array type contains its
  // children's literals too, and `{ type: 'call' | 'put'; spot: number }` is not the string `'call'`.
  const scalar = field.kind === 'string' || field.kind === 'enum' || field.kind === 'primitive';
  const preferred = preferredValue(
    field.name,
    field.literals,
    scalar ? field.type : undefined,
    attempt,
  );
  /**
   * The curated value must be TYPE-COMPATIBLE with what the field declares.
   *
   * The table is keyed by name across the whole workspace, and one name can mean a scalar in one
   * contract and a column in another: `spot` is a number nearly everywhere and
   * `Float64Array<ArrayBufferLike>` in the batch API. Handing the batch API the scalar produced the
   * clearest possible complaint — "cols.spot must be an array, got number" — from a value the harness
   * had chosen over the declaration sitting right next to it.
   *
   * Only the container mismatch is checked, because that is the one a name cannot disambiguate and the
   * one that produces a nonsense call rather than a merely unlucky one.
   */
  /**
   * A CURATED VALUE MUST NOT CONTRADICT THE DECLARATION IT IS FILLING.
   *
   * The table is keyed by NAME across the whole workspace, and a name means different things in
   * different contracts: `price` is a number nearly everywhere and a `(input) => PriceResult` on an
   * engine; `close` is an OHLC number and a `"16:00"` session string; `impliedVolatility` is a number
   * and a `(strike) => number` surface. The old guard caught only the container case, so five
   * boundaries were measured against calls whose type the declaration flatly contradicts — and
   * because nothing validated below the top level, they read as ordinary measurements.
   *
   * `scalarGap` is the same judgement the baseline validator uses, so synthesis and validation cannot
   * disagree about what the declaration allows: it abstains on a named type and convicts only where
   * every alternative is judgeable and none matches.
   */
  /**
   * AN ARM IS A NODE, SO IT IS BUILT AS ONE.
   *
   * Every kind below knows how to build the shape it names, and a union's arm is one of those
   * shapes — but nothing routed an arm back through this function, so a union of non-object arms was
   * built by whichever heuristic the CONTAINER's kind reached. `vectorized(signal: ArrayLike<number
   * | boolean> | SeriesSignal | EnvelopeSignal)` is `kind: 'array'`, so every variant got the array
   * heuristic: variants #1 and #2 named object arms and were handed the same numeric series as #0.
   * `perUnitTurnover: number | Array<number>` and `readSnapshot(kind: Kind | ReadonlyArray<Kind>)`
   * failed the same way, in both directions.
   *
   * OBJECT-kind unions keep their own path below, which reaches for a produced instance before its
   * declaration — a rule that exists for behavioural contracts and is not this generalization's to
   * revisit.
   *
   * Falling through when the arm cannot build is deliberate: the heuristics stay as the last resort
   * they were, so this can only add reachable shapes. Falling through when a variant NAMED the arm
   * is not — that is how an alternative gets published from a call that does not select it, so a
   * named-but-unbuildable arm returns `undefined` and is reported unrealized.
   *
   * ABOVE the curated-value shortcut, for the reason the parameter level already records: a variant
   * that NAMES an arm must get that arm, and the name table is keyed by field name across the whole
   * workspace, so it answers the same value whichever alternative was asked for. Leaving it first
   * published `selectQuotePrice / arg1#2` from a call passing `'bid'`; the field level had the same
   * hole one level down, waiting for any union field whose name appears in the table.
   */
  let selectedArm = false;
  if (field.kind !== 'object') {
    const fieldArms = armsOf(field);
    if (fieldArms && fieldArms.length > 1) {
      const chosen = chooseBranch(
        context,
        path,
        armFields(fieldArms),
        armTypes(fieldArms),
        fieldArms,
      );
      selectedArm = chosen.selected;
      const arm = fieldArms[Math.min(chosen.choice.branch, fieldArms.length - 1)];
      if (arm) {
        const built = underScope(context, chosen.scope, () =>
          valueForField(
            { ...arm, name: field.name, optional: false, nullable: false },
            depth,
            context,
            path,
          ),
        );
        if (built !== undefined) return built;
      }
      if (chosen.selected) return undefined;
    }
  }

  if (!selectedArm && preferred !== undefined && scalarGap(field, preferred, field.name) === null) {
    return preferred;
  }

  switch (field.kind) {
    case 'numeric':
      return 1;
    case 'boolean':
      return false;
    case 'enum':
      return field.literals?.[0];
    case 'string':
      /**
       * A generic string, once the name table and the declared literals have both declined.
       *
       * Returning `undefined` here was over-cautious. The baseline-must-succeed rule already makes a
       * wrong guess cost coverage and never correctness: if `'x'` is not a valid value the call throws
       * and the path stays unmeasured, exactly as it was. Refusing to try could only ever lose
       * coverage, and it was losing it on contracts whose other fields were fully determined.
       */
      return genericString(field.name);
    // `contract-fields.ts` classifies a callable FIELD as `function`; the parameter classifier calls
    // the same thing `callback`. Both are accepted here because the branch that only knew `callback`
    // was unreachable for every one of the 1,289 function-typed field nodes in the inventory — it read
    // as coverage and was dead code.
    case 'function':
      // A declared function member — `RandomNumberGenerator.next`, `Calendar.isBusinessDay`,
      // `IndicatorDefinition.stream`. Read the declared signature; see `callbackStub`.
      return callbackStub(field.type, field.returns, depth, context, path, field.callSignature);
    case 'array': {
      /**
       * A DECLARED TUPLE is built position by position, from the compiler's own reading.
       *
       * The text path below guesses arity from the rendered type and fills every slot with a number,
       * which is right for `[number, number, number]` and wrong for everything heterogeneous — and
       * the validator then had to accept whatever it produced. One reading, used by both.
       */
      const tupleUnion = armsOf(field);
      if (!field.tuple && tupleUnion && tupleUnion.some((arm) => arm.tuple)) {
        /**
         * THE SELECTED ARM, not the first one that happens to have positions.
         *
         * `branchTuples.find(...)` ignored the selection entirely, so for
         * `[number] | [string, number]` the `#1` variant still built `[1]` and realization correctly
         * reported it had selected `#0`. A union of tuples is a union: it is chosen the same way
         * every other union is, and `branchTuples` is aligned index-for-index with `branchTypes` so
         * the choice indexes it directly.
         */
        const { choice, scope } = chooseBranch(
          context,
          path,
          armFields(tupleUnion),
          armTypes(tupleUnion),
          tupleUnion,
        );
        const arm = tupleUnion[Math.min(choice.branch, tupleUnion.length - 1)]?.tuple ?? null;
        if (arm) {
          void scope;
          const built = arm
            .filter((position) => !position.optional)
            .map((position, index) =>
              valueForField(position, depth + 1, context, `${path}[${index}]`),
            );
          if (!built.some((value) => value === undefined)) return built;
        }
      }
      if (field.tuple) {
        const built = field.tuple
          .filter((position) => !position.optional)
          .map((position, index) =>
            valueForField(position, depth + 1, context, `${path}[${index}]`),
          );
        if (!built.some((value) => value === undefined)) return built;
      }
      /**
       * A MATRIX is an array of NUMBER arrays. `Array<Array<A | B>>` matches the same text shape and
       * is not one — it was built as sixty rows of 0.2, so the union inside the inner array was never
       * reached and every variant of it built the same numbers. The declared element decides.
       */
      const innermost = field.element?.element ?? field.element;
      if (wantsMatrix(field.type) && (innermost === undefined || innermost.kind === 'numeric')) {
        return matrix();
      }
      if (!field.element) return /Bar|bar|ohlc/i.test(field.type) ? bars() : series();
      /**
       * A TUPLE ELEMENT is built from ITS METADATA, and the metadata is consulted FIRST.
       *
       * This sat below the text reader, which made it unreachable for every tuple the parser happens
       * to recognize — so `Array<['a\\'b,c', boolean]>` still produced `[["x","x"], …]` despite
       * carrying an authoritative per-position contract. An ordering that only matters when the
       * fallback fails is not a fallback, it is dead code with a comment claiming otherwise.
       *
       * The 21 public array-of-tuple paths are all `[string, number]` or `[number, number]`, which
       * the parser reads correctly — so today's artifact is unaffected and the defect is entirely in
       * what happens NEXT time.
       */
      if (field.element.tuple || armsOf(field.element)?.some((arm) => arm.tuple)) {
        const one = valueForField(field.element, depth + 1, context, path);
        if (one !== undefined) return Array.from({ length: SERIES_LENGTH }, () => freshCopy(one));
      }
      /**
       * AN ELEMENT THAT IS A FIXED TUPLE is built position by position — the TEXT fallback, for a
       * declaration the inventory recorded no metadata for.
       *
       * `Array<[string, number]>` was producing an array of sixty-element arrays of `"x"`: the
       * element's own element type won, and the tuple's two positions were never expressed. Nothing
       * saw it, because the validator had no per-position contract to check against either — the two
       * halves of the harness were wrong in the same direction, which is how a baseline that no
       * caller could write survived every gate.
       */
      const elementMembers = tupleMemberTypes(field.element.type ?? '');
      if (elementMembers !== null) {
        const one = (): unknown[] => elementMembers.map((member) => valueForMemberType(member));
        return Array.from({ length: 4 }, one);
      }
      if (field.element.kind === 'numeric') {
        /**
         * A FIXED-ARITY numeric tuple is not a series, and handing it one loses the whole contract.
         *
         * `restoreRandomNumberGenerator` declares `state: [number]` for mulberry32 and
         * `[number, number, number, number]` for xoshiro128ss. Both matched the generic numeric-array
         * fallback, got sixty samples, and the boundary rightly refused them — so a contract whose
         * arity the checker had recorded exactly was filed `unmeasured / baseline-rejected`, twice,
         * once per algorithm.
         *
         * Values start at 1 rather than 0: a PRNG state word of all zeros is a degenerate state that
         * several algorithms reject outright, and a baseline the library refuses measures nothing.
         */
        const arity = fixedNumericTupleArity(field.type);
        if (arity !== null) return Array.from({ length: arity }, (_, index) => index + 1);
        return series();
      }
      if (field.element.kind === 'object') {
        /**
         * Elements share the container's path: they are the same declared shape, so a union inside
         * one is the same union node in all of them.
         *
         * Built through `valueForField` rather than straight from `element.fields`, because that
         * shortcut bypassed `element.branchFields` entirely — an ELEMENT union was enumerated as an
         * alternative and then never selected, so every variant of it built the first branch.
         */
        const element =
          (armsOf(field.element)?.length ?? 0) > 0
            ? valueForField(field.element, depth + 1, context, path)
            : buildObject(field.element.fields ?? [], depth + 1, context, path);
        return element === undefined || element === null || typeof element !== 'object'
          ? element === undefined
            ? undefined
            : Array.from({ length: SERIES_LENGTH }, () => element)
          : Array.from({ length: SERIES_LENGTH }, () => ({ ...(element as object) }));
      }
      const single = valueForField(field.element, depth + 1, context, path);
      return single === undefined ? undefined : Array.from({ length: SERIES_LENGTH }, () => single);
    }
    case 'object': {
      if (depth >= MAX_BUILD_DEPTH) return undefined;
      /**
       * A UNION NODE — recorded, then built from the SELECTED alternative.
       *
       * `{ gaussian: … } | { returns: … }` has two ways to be satisfied and synthesis only ever built
       * the first. The selection is keyed by path rather than by the retry counter, so every
       * alternative gets measured on its own rather than only when an earlier one was rejected.
       */
      const fieldArms = armsOf(field);
      const branches = fieldArms ? armFields(fieldArms) : null;
      if (branches && branches.length > 0) {
        const { fields, branchType, choice, scope } = chooseBranch(
          context,
          path,
          branches,
          fieldArms ? armTypes(fieldArms) : undefined,
          fieldArms ?? undefined,
        );
        if (fields === null || fields.length === 0) {
          return branchType === undefined ? undefined : valueForBranchType(branchType);
        }
        // Everything below this point is reachable ONLY because this branch was chosen, so the
        // unions inside it are recorded under it — see `UnionSite.path`.
        return underScope(context, scope, () =>
          buildObject(fields, depth + 1, context, path, choice.discriminator),
        );
      }
      return buildObject(field.fields ?? [], depth + 1, context, path);
    }
    default:
      return undefined;
  }
}

/**
 * Build an object from its declared fields — REQUIRED ones only.
 *
 * Optional fields are left out so the baseline is the minimal valid call, which is what makes a later
 * `omit-required` probe mean something. Returns `undefined` if any required field cannot be built,
 * because a partially-populated request is not a valid baseline and measuring against one would be
 * measuring the harness's own gap.
 */
function buildObject(
  fields: readonly SynthesisField[],
  depth: number,
  context: BuildContext,
  /** The dotted path of the OBJECT being built; children extend it by name. */
  path: string,
  /**
   * The literal that SELECTED this branch, when the object is one arm of a discriminated union.
   *
   * Without it, `valueForField` would answer the discriminator with `literals[0]` and every one of a
   * branch's literals would build the same call — which is how four spread variants sharing a field
   * shape came to be measured once and reported as four.
   */
  discriminator?: { field: string; value: LiteralValue }[],
): Record<string, unknown> | undefined {
  const attempt = context.attempt;
  /**
   * An EMPTY contract synthesizes to `{}` — the minimal valid call, not a failure.
   *
   * Returning `undefined` here cost 184 boundaries. A `.stream` factory declares
   * `parameters?: {}`: an options bag with no keys. Synthesis produced nothing, the argument list came
   * out empty, and the path was filed `no-input` — "we could not build an input" — when the input was
   * simply `{}` and the contract had told us so.
   *
   * It is also the more interesting case, not the less: an options bag that declares NO keys is
   * precisely where Law 12 has something to say. `acos.stream({ qzxBogus: 1 })` either rejects the
   * undeclared key or it does not, and nothing had ever asked.
   */
  if (fields.length === 0) return {};
  const object: Record<string, unknown> = {};
  /**
   * A CHOICE GROUP is not expressible as requiredness, so attempt 0 cannot satisfy one.
   *
   * `SimulatedBroker.submit` wants "exactly one of quantity or notional"; `barsFromColumns` wants "at
   * least one of open/high/low/close/volume"; `tipsIndexRatio` wants "exactly one of
   * baseReferenceCpi or datedDate". Every alternative in such a group is correctly declared OPTIONAL —
   * none of them is individually required — so the minimal required-only call supplies NONE of them
   * and is rejected. The declaration is right, the library is right, and the harness simply had no
   * way to say "one of these."
   *
   * So on RETRY, admit the first `attempt` optional fields. This is the same safety argument the date
   * fallback rests on, and it is worth stating because it is what makes a blunt rule acceptable: a
   * retry only ever happens after attempt 0 was REJECTED (`measureWithAlternatives` returns the moment
   * a result is anything other than `baseline-rejected`), so a wider call can never displace a
   * baseline that was working. Attempt 0 remains exactly the minimal call, which is what keeps the
   * later `omit-required` probe meaningful.
   *
   * An optional that cannot be built is skipped rather than failing the object — it was never
   * required, and refusing to build the whole request over it would lose the retry entirely.
   */
  let admitted = 0;
  for (const field of fields) {
    const childPath = path ? `${path}.${field.name}` : field.name;
    // The discriminator is not guessed — it is what the variant IS.
    const tag = discriminator?.find((entry) => entry.field === field.name);
    if (tag) {
      object[field.name] = tag.value;
      continue;
    }
    if (field.optional) {
      /**
       * AN OPTIONAL FIELD THE VARIANT NAMES IS NOT OPTIONAL FOR THAT VARIANT.
       *
       * A minimal baseline omits optional fields, which is what makes a later `omit-required` probe
       * mean anything — and a union inside one is then never built. Both `researchProtocol.trials`
       * variants synthesized the same request with no `trials` property, and both were published
       * `enforced`: evidence about a branch the call never contained.
       *
       * So the two rules coexist by scope rather than by compromise. A variant that explicitly fixes
       * a site at or under this field MATERIALIZES it; every other call still leaves it out.
       */
      const gateScope = context.materialize.get(childPath);
      const wanted =
        gateScope !== undefined ||
        [...context.materialize.keys()].some((entry) => entry.startsWith(`${childPath}.`)) ||
        /**
         * A SIMULATION BUDGET IS SUPPLIED, and it is the one optional the baseline volunteers.
         *
         * The omit-optionals rule is about CONTRACT: leaving optionals out is what makes a later
         * `omit-required` probe mean something. A field like `paths` or `stepsPerYear` decides how
         * much WORK the boundary does, not what it accepts — and its default is chosen for callers
         * who want a good answer, not for a harness making a hundred probe calls.
         *
         * `swapXva` is the case. Its baseline used to be rejected before reaching the simulation, so
         * the boundary cost nothing to measure. Once its arms were recorded the baseline built, the
         * call ran at the library's default 5,000 paths x 24 steps/year, and one boundary took 1,022
         * SECONDS — long enough that the supervisor recorded it `probe-timeout` and the artifact lost
         * a measurement it had.
         *
         * Supplying these does not weaken any probe: they are declared optionals with declared types,
         * `unknown-key` and `wrong-type` still apply to them, and `omit-required` never touches an
         * optional. The list is short, named, and about cost alone.
         */
        SIMULATION_BUDGET_FIELDS.has(field.name);
      if (!wanted && admitted >= attempt) continue;
      /**
       * Built UNDER THE GATE'S SCOPE, so a union inside this field is addressed by the same key the
       * enumerator used when it named the branch.
       */
      const extra =
        gateScope === undefined
          ? valueForField(field, depth, context, childPath)
          : underScope(context, { qualified: gateScope, plainAt: childPath }, () =>
              valueForField(field, depth, context, childPath),
            );
      if (extra === undefined) continue;
      if (!wanted) admitted++;
      object[field.name] = extra;
      continue;
    }
    const value = valueForField(field, depth, context, childPath);
    if (value === undefined) return undefined;
    object[field.name] = value;
  }
  // Every field optional: an empty object is a legitimate minimal call for such a contract.
  return object;
}

/**
 * Synthesize one argument list, or `null` when the declaration gives too little to guess from.
 *
 * `fields` are the recursive field paths the inventory joined for this callable, used to populate an
 * object request. Optional parameters are omitted: the baseline call should be the MINIMAL valid call,
 * so that a later `omit-required` probe is meaningful.
 */
/**
 * Split a labelled TUPLE type into its elements: `[a: X, b?: Y]` -> `[{name:'a',type:'X'}, …]`.
 *
 * A rest parameter declared as a labelled tuple is ONE parameter carrying several arguments, and
 * synthesis was treating it as one value. `treynorRatio` is declared
 * `[returns: ArrayLike<number>, benchmark: ArrayLike<number>, …]`, got a single flat series, and then
 * said so plainly: "benchmark must be an array of numbers (got undefined)". 190 contracts declare a
 * tuple parameter; 40 could not be measured at all, and the other 150 were being measured against a
 * call missing everything after the first element.
 *
 * Depth-aware splitting, because the elements themselves contain commas — `Record<string, number>`
 * and `ArrayLike<number>` both do, and a naive `split(',')` produces nonsense types that synthesize
 * to nothing.
 */
function tupleElements(type: string, owner?: SynthesisParameter): SynthesisParameter[] | null {
  const trimmed = type.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const parts = splitTopLevel(trimmed.slice(1, -1));

  const elements: SynthesisParameter[] = [];
  for (const part of parts) {
    const match = /^\s*(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(part);
    // An unlabelled element gives no name to key a curated value on; the whole tuple is then a guess
    // better left unmade.
    if (!match) return null;
    const elementType = match[4]!.trim();
    /**
     * A tuple element gets a CONTRACT IDENTITY, derived from the tuple's own.
     *
     * These parameters are parsed out of type TEXT, so they had no identity at all — which is fine for
     * a curated name lookup and fatal for anything keyed by contract. `curveMetrics.explain` declares
     * `[bond: Bond, curve: YieldCurve, options: CurvePricingOptions]`, and `Bond` is a class the
     * library produces and a declaration cannot describe; without an identity the producer lookup had
     * nothing to look up. The package qualifier comes from the tuple, because that is the package
     * whose declaration named these types.
     */
    const contract = owner?.tupleContracts?.[elements.length] ?? null;
    const fieldTree = owner?.tupleFieldTrees?.[elements.length] ?? null;
    elements.push({
      name: match[2]!,
      type: elementType,
      ...(contract ? { contract } : {}),
      ...(fieldTree ? { fieldTree } : {}),
      optional: match[3] === '?' || /\|\s*undefined/.test(elementType),
      kind: kindOfType(elementType),
    });
  }
  return elements.length > 0 ? elements : null;
}

/** Classify a rendered type the way the signature inventory would. */
function kindOfType(type: string): string {
  if (wantsMatrix(type)) return 'series';
  if (/^(number)\b/.test(type)) return 'numeric';
  if (/Array|ArrayLike|ReadonlyArray|\[\]/.test(type)) return 'series';
  if (/^(string|boolean)\b/.test(type) || /'[^']*'/.test(type)) return 'primitive';
  if (/=>/.test(type)) return 'callback';
  if (/^\{|^[A-Z]/.test(type)) return 'object';
  return 'other';
}

/**
 * Instances the harness can OBTAIN but not describe, keyed by contract identity.
 *
 * A `Bond` is a class with methods; `curveMetrics.explain([bond, curve, options])` needs a real one,
 * and no amount of reading its declaration produces something with a working `cashflows()`. But the
 * library makes them — `bonds.fixedRate(...)` — and the contract graph records which callables return
 * which contract, so this is a lookup. `contract-enforcement.ts` resolves the factories once and
 * passes the map in.
 *
 * A LAST RESORT, deliberately. A declared request must always be built from its declaration, because
 * probing a declared shape is the entire point: `unknown-key` against a synthesized request asks "does
 * this boundary reject a key its contract does not declare", which is Law 12. The same probe against a
 * factory-produced instance asks a weaker question about an opaque object. So producers run only where
 * nothing else could build a value at all — turning `no-input` into a measurement, never displacing
 * one.
 */
export type Producers = ReadonlyMap<string, () => unknown>;

/**
 * Is a synthesized argument list COMPLETE against the declaration it was built from?
 *
 * `baseline-rejected` conflates two different facts: the contract refused a well-formed request, and
 * the harness handed it a malformed one. Only the first says anything about the library, and mixing
 * them is what let a partial object be presented as evidence at all.
 *
 * So the baseline is checked against the declaration BEFORE it is called. Two things are checkable
 * statically and both are the harness's own responsibility: every REQUIRED field present, and no key
 * the contract does not declare. A failure here is a synthesis bug reported as one, and a rejection
 * that survives it is a fact about the contract.
 *
 * Deliberately shallow-per-parameter and recursive only through declared object fields; it validates
 * what synthesis CLAIMS to have built, not what the library will make of it.
 */
/**
 * WHY a baseline is malformed, as DATA rather than as a sentence.
 *
 * The residual allowlist has to be keyed by something machine-comparable — category, path, and the
 * actual gap — because keying it by id alone lets a DIFFERENT mismatch under a listed id stay green,
 * and keying it by prose means classifying a defect by parsing our own error text. This phase has
 * spent several rounds removing exactly that pattern; it should not be reintroduced by the gate that
 * polices it.
 */
export interface BaselineGap {
  category:
    | 'missing-required'
    | 'undeclared-key'
    | 'invalid-literal'
    | 'wrong-type'
    | 'no-branch'
    | 'extra-argument';
  /** Dotted path from the argument, e.g. `input.fit.assumptions`. */
  path: string;
  /** Human detail. Never parsed — the two fields above carry the meaning. */
  detail: string;
}

/** The stable identity of a mismatch: what kind, and where. Never the prose. */
export function baselineGapFingerprint(gap: BaselineGap): string {
  return `${gap.category}@${gap.path}`;
}

const say = (gap: BaselineGap): string => gap.detail;

export function incompleteBaseline(
  parameters: readonly SynthesisParameter[],
  args: readonly unknown[],
): string | null {
  const gap = baselineGap(parameters, args);
  return gap === null ? null : say(gap);
}

/** The same walk as `incompleteBaseline`, returning the gap as data. One walker, two views. */
export function baselineGap(
  parameters: readonly SynthesisParameter[],
  args: readonly unknown[],
): BaselineGap | null {
  /**
   * `parameters` here are ARGUMENT COORDINATES, already aligned to `args` — not a signature.
   *
   * Re-deriving them was the bug. `adjustDate(date, convention?, calendar?)` synthesizes to
   * `[date, calendar]` because the builder skips optional non-object coordinates; expanding the
   * SIGNATURE instead judged `calendar` against `convention` and reported an invalid enum the
   * harness never sent. The two lists align only when both use the same skip rule, so the caller
   * passes the coordinates `synthesizeCall` actually produced and this walks them straight.
   */
  const expanded = parameters;

  /**
   * VALIDATE THE ARGUMENT LIST THAT WAS PASSED, positionally.
   *
   * This walked the PARAMETERS and skipped every optional non-object one unconditionally — without
   * consuming an argument index. Two consequences, both silent: an optional a hand fixture actually
   * SUPPLIED was never validated at all, and skipping it without advancing the index misaligned
   * every argument after it, so the next parameter was judged against the wrong value.
   *
   * The subject is the call, not the signature. Walk the arguments; judge each against the
   * coordinate it actually occupies.
   */
  /**
   * AN EXTRA ARGUMENT IS A MALFORMED CALL, and nothing was checking for one.
   *
   * A rest coordinate legitimately absorbs any number, so the count is only binding without one.
   */
  if (!expanded.some((parameter) => parameter.rest) && args.length > expanded.length) {
    return {
      category: 'extra-argument',
      path: `arg${expanded.length}`,
      detail:
        `the call passes ${args.length} arguments and the declaration takes ${expanded.length}` +
        ` — ${JSON.stringify(args[expanded.length]) ?? 'undefined'} has no coordinate`,
    };
  }

  for (let index = 0; index < expanded.length; index += 1) {
    const parameter = expanded[index] as SynthesisParameter;
    const supplied = index < args.length;
    const value = args[index];

    if (!supplied || value === undefined) {
      if (parameter.optional) continue;
      return {
        category: 'missing-required',
        path: parameter.name,
        detail: `${parameter.name} is required and was not supplied`,
      };
    }

    /**
     * A REST coordinate's type describes the COLLECTION; each argument is one element.
     *
     * `scenario(name: string, ...shocks: Shock[])` passes shocks positionally, so judging argument 1
     * against `Array<Shock>` reported a perfectly good `Shock` as "declared an array, got object".
     * The element declaration is the right subject where the inventory records one; where it does
     * not, abstaining beats inventing a contract.
     */
    const gap = parameter.rest
      ? nodeGap(
          {
            name: parameter.name,
            kind: 'object',
            ...(parameter.elementFieldTree ? { fields: parameter.elementFieldTree } : {}),
          },
          value,
          parameter.name,
          0,
          parameter.policy === 'open' || parameter.policy === 'passthrough',
          false,
        )
      : nodeGap(
          parameter,
          value,
          parameter.name,
          0,
          parameter.policy === 'open' || parameter.policy === 'passthrough',
          false,
        );
    if (gap) return gap;
  }
  return null;
}

/**
 * Positive conformance evidence is stronger than the absence of a baseline gap. The baseline
 * walker deliberately abstains on opaque/truncated types; abstention must never waive a negative
 * probe. Reuse its decisions, but require a complete modeled declaration for every supplied value.
 * Unknown/callable/foreign shapes conservatively return false. This changes no baseline verdict.
 */
export function provesArgumentConformance(
  parameters: readonly SynthesisParameter[],
  args: readonly unknown[],
): boolean {
  if (parameters.some((parameter) => parameter.rest)) return false;
  type Node = Parameters<typeof nodeGap>[0] & { truncated?: boolean; tuple?: SynthesisField[] };
  type Proof = { value: unknown };
  // Exhaustion is lack of proof, never permission to omit. Shared across union candidates too.
  let remaining = 10_000;
  const modeled = (
    node: Node,
    value: unknown,
    depth: number,
    allowUndeclared: boolean,
  ): Proof | null => {
    if (--remaining < 0 || depth > MAX_VALIDATE_DEPTH || node.truncated) return null;
    const branches = armsOf(node);
    if (branches) {
      for (const branch of branches) {
        const proof = modeled(branch, value, depth + 1, allowUndeclared);
        if (proof) return proof;
      }
      return null;
    }
    let supplied: unknown;
    if (value === null) {
      if (node.nullable !== true) return null;
      supplied = null;
    } else if (value === undefined) {
      if (!/^(undefined|void)$/.test(node.type?.trim() ?? '')) return null;
      supplied = undefined;
    } else if (['number', 'string', 'boolean'].includes(typeof value)) {
      if (
        (node.literals?.length ?? 0) === 0 &&
        !/^(number|string|boolean)$/.test(node.type?.trim() ?? '')
      )
        return null;
      supplied = value;
    } else if (Array.isArray(value)) {
      const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number' || length > remaining || (!node.tuple && !node.element))
        return null;
      // Only length is non-enumerable. Every index must be an own, enumerable data property;
      // neither holes nor named/symbol decorations can disappear through Array#every.
      if (Reflect.ownKeys(value).length !== length + 1) return null;
      const list: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const member = node.tuple ? node.tuple[index] : node.element;
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !member) return null;
        const proof = modeled(member, descriptor.value, depth + 1, allowUndeclared);
        if (!proof) return null;
        list.push(proof.value);
      }
      supplied = list;
    } else if (typeof value === 'object') {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const fields = node.fields ?? node.fieldTree;
      if (!fields) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length > remaining) return null;
      remaining -= keys.length;
      const declared = new Map(fields.map((field) => [field.name, field]));
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        const field = typeof key === 'string' ? declared.get(key) : undefined;
        if (!field) {
          if (!allowUndeclared) return null;
          // Policy admits unconsumed metadata. Do not read or model its interior.
          continue;
        }
        const proof = modeled(field, descriptor.value, depth + 1, allowUndeclared);
        if (!proof) return null;
        record[field.name] = proof.value;
      }
      supplied = record;
    } else {
      return null;
    }
    // The existing walker decides validity, but only AFTER descriptor-safe snapshots exist.
    // Calling it on the original value (even as a baseline preflight) would execute getters.
    return nodeGap(node, supplied, 'omission', depth, allowUndeclared, false) === null
      ? { value: supplied }
      : null;
  };
  const length: unknown = Object.getOwnPropertyDescriptor(args, 'length')?.value;
  if (
    typeof length !== 'number' ||
    length > parameters.length ||
    length > remaining ||
    Reflect.ownKeys(args).length !== length + 1
  )
    return false;
  const supplied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const parameter = parameters[index];
    const descriptor = Object.getOwnPropertyDescriptor(args, String(index));
    if (!parameter || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    const proof = modeled(
      parameter,
      descriptor.value,
      0,
      parameter.policy === 'open' || parameter.policy === 'passthrough',
    );
    if (!proof) return false;
    supplied.push(proof.value);
  }
  return baselineGap(parameters, supplied) === null;
}

/** How a value reads in a message — its shape, not its contents. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (ArrayBuffer.isView(value)) return 'a typed array';
  return typeof value;
}

/** The deepest a validation walk descends. The field trees themselves are capped shallower. */
const MAX_VALIDATE_DEPTH = 6;

/** A value satisfying ONE rendered type member — the builder half of `memberSatisfied`. */
function valueForMemberType(member: string): unknown {
  const type = member.trim();
  if (/^'[^']*'$/.test(type)) return type.slice(1, -1);
  if (/^number$/.test(type)) return 1;
  if (/^boolean$/.test(type)) return false;
  if (/^string$/.test(type)) return 'x';
  if (/=>/.test(type)) return () => 0;
  if (/(\[\]$|^(Readonly)?Array<|^ArrayLike<)/.test(type)) return series();
  return 'x';
}

/**
 * The member types of a FIXED tuple — `[string, number]` -> ['string', 'number'].
 *
 * `null` for anything variable-length (`X[]`, `Array<X>`, a rest or optional element), where arity is
 * not a contract. Labels are stripped: `[a: string, b: number]` says the same thing.
 */
/** Split a type on a TOP-LEVEL operator — `A & { b: C | D }` splits into two on `&`, not three. */
function splitOn(type: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote = '';
  let previous = '';
  for (const character of type) {
    if (quote !== '') {
      // Inside a string literal nothing is structure: `['a,b', boolean]` is TWO positions, and a
      // splitter blind to quotes read it as three and rejected a legal value.
      if (character === quote) quote = '';
      current += character;
      previous = character;
      continue;
    }
    // Backticks too: a TEMPLATE LITERAL type is a string with structure in it, and a splitter
    // blind to it read `` `x,${string}` `` as two positions.
    if (character === "'" || character === '"' || character === '`') quote = character;
    if ('<([{'.includes(character)) depth++;
    // `=>` is an arrow, not a closing bracket — see `unionMembers`.
    else if (')]}'.includes(character) || (character === '>' && previous !== '=')) depth--;
    previous = character;
    if (character === operator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Split a type list on TOP-LEVEL commas — `A<x, y>, B` is two members, not three.
 *
 * Extracted because two readers needed it and only one had it. `tupleMemberTypes` replaced every
 * comma with a pipe and split on that, so `[string | number, boolean]` read as THREE positions and
 * the legal value `['ok', false]` was rejected as "declares exactly 3 elements, got 2" — a validator
 * refusing a call TypeScript accepts, which is the same class of error as accepting one it does not.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote = '';
  let previous = '';
  for (const character of inner) {
    if (quote !== '') {
      // Inside a string literal nothing is structure: `['a,b', boolean]` is TWO positions, and a
      // splitter blind to quotes read it as three and rejected a legal value.
      if (character === quote) quote = '';
      current += character;
      previous = character;
      continue;
    }
    // Backticks too: a TEMPLATE LITERAL type is a string with structure in it, and a splitter
    // blind to it read `` `x,${string}` `` as two positions.
    if (character === "'" || character === '"' || character === '`') quote = character;
    if ('<([{'.includes(character)) depth++;
    // `=>` is an arrow, not a closing bracket — see `unionMembers`.
    else if (')]}'.includes(character) || (character === '>' && previous !== '=')) depth--;
    previous = character;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function tupleMemberTypes(type: string): string[] | null {
  const trimmed = type
    .trim()
    .replace(/^readonly\s+/, '')
    .trim();
  /**
   * A UNION IS NOT A TUPLE, and it can look exactly like one.
   *
   * `[number] | [number, number, number, number]` starts with `[` and ends with `]`, so the bracket
   * test admitted it and the splitter — walking a string whose brackets close and reopen — produced
   * FOUR members. A legal `[1]` was then rejected as "declares exactly 4 elements, got 1": the
   * validator refusing a call the language accepts, from a shape it had misread as something else.
   */
  if (unionMembers(trimmed).length > 1) return null;
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const members = splitTopLevel(trimmed.slice(1, -1))
    .map((member) =>
      member
        .trim()
        .replace(/^(\.\.\.)?[A-Za-z_$][\w$]*\??\s*:\s*/, (match) =>
          match.trimStart().startsWith('...') ? '...' : '',
        ),
    )
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
  if (members.length === 0) return null;
  /**
   * A REST or OPTIONAL member makes the tuple variable-length, so arity is not the contract and this
   * reader has nothing to say. Detected on the ORIGINAL text as well as the stripped type, because a
   * labelled rest (`...rest: number[]`) hides its marker behind the label.
   */
  const raw = splitTopLevel(trimmed.slice(1, -1)).map((member) => member.trim());
  if (raw.some((member) => member.startsWith('...') || /\?\s*:/.test(member))) return null;
  if (members.some((member) => member.startsWith('...') || member.endsWith('?'))) return null;
  return members;
}

/**
 * One arm of a union, as a node the shared walk can judge.
 *
 * A branch with no fields is NOT skipped: its type text is what says whether the value belongs to it.
 */
function branchNode(
  name: string | undefined,
  type: string | undefined,
  fields: SynthesisField[],
): {
  name?: string;
  type?: string;
  kind: string;
  fields: SynthesisField[];
} {
  return {
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
    kind: fields.length > 0 ? 'object' : 'other',
    fields,
  };
}

/**
 * ONE RECURSIVE VALIDATOR for a value against the node that declares it.
 *
 * It replaced three partial ones that between them checked top-level scalars and object KEYS and
 * nothing else. Five malformed calls passed as valid baselines: an object coordinate given `42`, a
 * nested literal outside its domain, a scalar where an array is declared, an extra argument, and an
 * object where a series is declared. Each of those can carry a boundary to `enforced` on a call no
 * caller could make, which is the one failure this whole phase exists to prevent.
 *
 * `structuralOnly` is the SAME walk asking a weaker question — required fields present, no
 * undeclared key — which is what branch SELECTION needs: "which branch does this value fit" must not
 * depend on whether a field's type is right, or a value that is merely wrong would be attributed to
 * no branch at all. One walker, two named strictness levels, rather than two walkers that drift.
 */
function nodeGap(
  node: {
    name?: string;
    type?: string;
    kind?: string;
    optional?: boolean;
    nullable?: boolean;
    literals?: LiteralValue[];
    element?: SynthesisField;
    fields?: SynthesisField[];
    fieldTree?: SynthesisField[];
    branches?: SynthesisBranch[];
  },
  value: unknown,
  path: string,
  depth: number,
  allowUndeclared: boolean,
  structuralOnly: boolean,
): BaselineGap | null {
  if (depth > MAX_VALIDATE_DEPTH) return null;
  if (value === null) {
    if (structuralOnly || node.nullable === true) return null;
    return { category: 'wrong-type', path, detail: `${path} is not declared nullable, got null` };
  }

  /**
   * A UNION is satisfied by ONE branch, and every arm is judged as the node it is.
   *
   * A TUPLE-SPECIAL PATH used to stand here, and it shadowed the complete one below. It fired
   * whenever ANY arm carried positions, then rebuilt EVERY arm as `{ kind: 'array', tuple? }` — so a
   * non-tuple arm lost its element, its fields, its call signature, its return and its own nested
   * arms, and became "an array of anything". For `[number] | ReadonlyArray<'left' | 'right'>` that
   * accepted `[true]` and `['bogus']`: the second arm's element carries the literal domain and the
   * reconstruction did not carry the element.
   *
   * It existed because a union of tuples "has no branchFields", which was true when an arm could only
   * be described as a list of members. An arm is a complete node now and carries its own `tuple`, so
   * the walk below reaches the position handling by descending into the arm rather than by being told
   * about it. The special case is not merely redundant — it is the same lossy reconstruction this
   * migration removed everywhere else, surviving in the one place that pre-empted the fix.
   */
  const armed = armsOf(node);
  const allBranches = armed ? armFields(armed) : null;
  if (allBranches && allBranches.length > 0) {
    /**
     * A BRANCH MUST GENUINELY ACCEPT THE VALUE, and `objectGap` alone cannot say so.
     *
     * It returns `null` — "valid" — for anything that is not a plain object, so a scalar satisfied
     * every object branch vacuously and `baselineGap([parameter], [42])` certified `42` against
     * `restoreRandomNumberGenerator`, `deflatedSharpeRatio`, `spectralRisk`, `strategyFromChain` and
     * `phiValue`. Each branch is judged through the full walk now, against its own ALIGNED type, so
     * "satisfies a branch" means that branch would actually take it.
     *
     * EVERY branch, including the ones with no field shape. Filtering to object branches was the
     * first attempt and it broke `classifyStrategy` immediately: two of its three alternatives are
     * arrays, so a value built from an array branch had no branch left to satisfy and the harness
     * called its own correct baseline malformed.
     *
     * VALIDATED AGAINST THE ARM ITSELF, not against a `name + fields` reconstruction of it.
     *
     * `branchNode` rebuilt each arm as an object with a type and some fields, which threw away
     * everything an arm can be that is not an object: its element contract, its tuple positions, its
     * call signature, its return, its own nested arms. So `number | ReadonlyArray<'left' | 'right'>`
     * validated `['bogus']` as a legal baseline — the array arm's element carries the literal domain,
     * and the reconstruction did not carry the element.
     *
     * Recursion is now possible, where the reconstruction made it impossible by accident. `depth`
     * advances at each arm so a self-referential union terminates on the budget rather than on the
     * shape.
     */
    const gaps = (armed ?? []).map((arm) =>
      nodeGap(
        { ...arm, ...(node.name !== undefined ? { name: node.name } : {}) },
        value,
        // DEPTH ADVANCES. An arm may itself be a union or hold one, so this can now recurse; the
        // budget is what makes that terminate on a self-referential declaration rather than on the
        // arm shape happening to be flat.
        path,
        depth + 1,
        allowUndeclared,
        structuralOnly,
      ),
    );
    if (gaps.some((gap) => gap === null)) return null;
    return {
      category: 'no-branch',
      path,
      detail: `${path} satisfies no branch of its union — ${gaps
        .filter((gap): gap is BaselineGap => gap !== null)
        .map(say)
        .join('; ')}`,
    };
  }

  if (!structuralOnly) {
    const scalar = scalarGap(node, value, path);
    if (scalar) return scalar;
  }

  /**
   * `kind` ROUTES THE RECURSION and never convicts. The shape question is already answered above by
   * the declared type text, which is the only place a union can be read: `expected` is recorded
   * `kind: series` and declared `Kind | ReadonlyArray<Kind>`, so a bare `Kind` is correct and a
   * kind-driven "must be an array" was wrong about a call the library accepts.
   */
  void node.kind;
  if (typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
    return objectGap(
      node.fields ?? node.fieldTree,
      value,
      path,
      depth,
      allowUndeclared,
      structuralOnly,
    );
  }

  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (structuralOnly) return null;
    const list = value as unknown[];
    const arity = node.type ? fixedNumericTupleArity(node.type) : null;
    if (arity !== null && list.length !== arity) {
      return {
        category: 'wrong-type',
        path,
        detail: `${path} declares exactly ${arity} elements, got ${list.length}`,
      };
    }
    /**
     * A FIXED TUPLE is heterogeneous: arity and each POSITION are the contract.
     *
     * `element` records one node for the whole sequence, so it cannot describe `[string, number]` —
     * applying it to index 1 reported "declared string, got number" about a perfectly good pair, and
     * skipping it entirely (the previous fix) left `[42, "wrong"]`, `["ok"]` and `["ok", 1, 2]` all
     * certified against `[string, number]`. The member types come from the declaration itself, which
     * is where the per-position contract has been all along.
     */
    /**
     * COMPILER METADATA FIRST. Each position is judged by the same recursive walk everything else
     * uses, so a nested object, a union, a literal or another tuple is decided by the node that
     * declares it rather than by a regex that has to be taught the language one construct at a time.
     */
    const declared = (node as { tuple?: SynthesisField[] }).tuple;
    if (declared) {
      const required = declared.filter((position) => !position.optional).length;
      if (list.length < required || list.length > declared.length) {
        return {
          category: 'wrong-type',
          path,
          detail:
            `${path} declares ${required === declared.length ? `exactly ${declared.length}` : `${required} to ${declared.length}`}` +
            ` elements, got ${list.length}`,
        };
      }
      for (const [index, position] of declared.entries()) {
        if (index >= list.length) break;
        const gap = nodeGap(
          position,
          list[index],
          `${path}[${index}]`,
          depth + 1,
          allowUndeclared,
          structuralOnly,
        );
        if (gap) return gap;
      }
      return null;
    }
    const members = tupleMemberTypes(node.type ?? '');
    if (members !== null) {
      if (list.length !== members.length) {
        return {
          category: 'wrong-type',
          path,
          detail: `${path} is declared ${node.type} — ${members.length} elements, got ${list.length}`,
        };
      }
      for (const [index, member] of members.entries()) {
        // Same abstain-on-unjudgeable rule as everywhere else: a named element says nothing.
        if (memberSatisfied(member, list[index]) === false) {
          return {
            category: 'wrong-type',
            path: `${path}[${index}]`,
            detail: `${path}[${index}] is declared ${member} and got ${describe(list[index])}`,
          };
        }
      }
      return null;
    }
    const isTuple = /^(readonly\s+)?\[/.test(node.type ?? '');
    if (node.element && !isTuple) {
      // A SAMPLE, not the whole series: elements are synthesized identically, and validating sixty
      // of them costs the pass without asking a new question.
      for (let index = 0; index < Math.min(list.length, 3); index += 1) {
        const gap = nodeGap(
          node.element,
          list[index],
          `${path}[${index}]`,
          depth + 1,
          allowUndeclared,
          structuralOnly,
        );
        if (gap) return gap;
      }
    }
    return null;
  }

  return null;
}

/**
 * Split a rendered type on its TOP-LEVEL `|`, ignoring the ones inside generics, calls and literals.
 *
 * `Record<string, number> | undefined` is two members; `Record<string | number, boolean>` is one.
 */
export function unionMembers(type: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index]!;
    if (character === '<' || character === '(' || character === '{' || character === '[')
      depth += 1;
    else if (
      (character === '>' && type[index - 1] !== '=') ||
      character === ')' ||
      character === '}' ||
      character === ']'
    ) {
      // The `>` of an ARROW is not a closing bracket. Counting it as one drove the depth NEGATIVE
      // inside `{ build: (c: C) => P | null }`, so `P | null` looked top-level and split into two
      // bogus members — one of them unjudgeable, which abstained the whole check and let
      // `optionsBacktest.entry` accept a scalar as a valid baseline.
      depth -= 1;
    } else if (character === '|' && depth === 0) {
      members.push(type.slice(start, index).trim());
      start = index + 1;
    }
  }
  members.push(type.slice(start).trim());
  return members.filter((member) => member.length > 0);
}

/**
 * The MEMBERS of an inline object literal type — name, declared type and requiredness.
 *
 * Deliberately shallow and deliberately conservative: `null` whenever the text is not a flat literal
 * this can read with confidence, because a wrong list convicts correct calls and a missing one only
 * abstains. This is a stopgap. The durable answer is compiler-generated recursive tuple metadata —
 * the inventory knows these shapes exactly and rendering them to text and re-parsing them here loses
 * information that was never lost until we threw it away.
 */
function inlineMembers(type: string): { name: string; type: string; optional: boolean }[] | null {
  const trimmed = type.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const members: { name: string; type: string; optional: boolean }[] = [];
  for (const part of splitOn(trimmed.slice(1, -1), ';')) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:([\s\S]+)$/.exec(part);
    if (!match) return null;
    members.push({ name: match[1]!, type: match[3]!.trim(), optional: match[2] === '?' });
  }
  return members;
}

/** Does a value satisfy ONE rendered type member? `null` when the member cannot be judged. */
function memberSatisfied(member: string, value: unknown): boolean | null {
  const type = member.trim();
  /**
   * A POSITION MAY ITSELF BE A UNION. `[string | number, boolean]` is two positions, and position 0
   * admits either — so the question at each position is the union question, asked recursively.
   *
   * `unionMembers` splits at the top level only, so a member that is itself a union of objects or
   * of nested tuples still arrives whole. A position where NOTHING is judgeable stays `null`, which
   * is the abstention this walk is built on: guessing convicts correct calls.
   */
  const arms = unionMembers(type);
  if (arms.length > 1) {
    /**
     * ONE unjudgeable arm abstains the whole union, exactly as it does at the parameter level.
     *
     * `false + unknown` collapsed to `false`, so a legal `[Kind | ReadonlyArray<Kind>, boolean]`
     * value was REJECTED: the array arm judged a bare `Kind` false, the named arm could not judge it
     * at all, and the pair was reported as a wrong type. Convicting on a partial reading is the
     * mistake this walk is built to avoid, and it had crept back in at the position level.
     */
    const verdicts = arms.map((arm) => memberSatisfied(arm, value));
    if (verdicts.some((verdict) => verdict === true)) return true;
    return verdicts.every((verdict) => verdict === false) ? false : null;
  }
  /**
   * An INTERSECTION is satisfied only if EVERY judgeable part is.
   *
   * `EntryCommon & { structure: 'ironCondor'; … }` begins with a named type, so the whole thing read
   * as unjudgeable and `optionsBacktest.entry` accepted `42` — the last nested union in the library
   * to do so. The named half is genuinely unknowable here; the object literal beside it is not, and
   * one knowable part is enough to answer.
   */
  const parts = splitOn(type, '&');
  if (parts.length > 1) {
    const verdicts = parts.map((part) => memberSatisfied(part, value));
    if (verdicts.some((verdict) => verdict === false)) return false;
    return verdicts.some((verdict) => verdict === true) ? true : null;
  }
  if (/^(undefined|null|void|never|unknown|any)$/.test(type)) return null;
  if (/^'[^']*'$/.test(type)) return value === type.slice(1, -1);
  /**
   * A TEMPLATE LITERAL type constrains a string in a way nothing here can check, so the honest answer
   * is that it is a string and no more. Convicting on it rejected legal values; pretending to verify
   * the pattern would be worse.
   */
  if (/^`[\s\S]*`$/.test(type)) return typeof value === 'string';
  if (/^-?\d+(\.\d+)?$/.test(type)) return value === Number(type);
  if (/^(true|false)$/.test(type)) return value === (type === 'true');
  if (/^number$/.test(type)) return typeof value === 'number' && Number.isFinite(value);
  if (/^string$/.test(type)) return typeof value === 'string';
  if (/^boolean$/.test(type)) return typeof value === 'boolean';
  /**
   * ANCHORED, and object-literals first. Both of these were wrong unanchored: `{ windows: number[] }`
   * contains `[]` and was read as an array, and `{ combine: (x, y) => number }` contains `=>` and was
   * read as a function. Every destructured options bag in the technical-analysis package was
   * convicted for being an object.
   */
  if (/^(Record<|\{)/.test(type)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    /**
     * An inline object literal declares KEYS, and checking only "is an object" let `[{ b: 1 }, true]`
     * pass against `[{ a: number }, boolean]`. `Record<K, V>` is deliberately excluded — its keys are
     * open by construction, so there is nothing to require.
     */
    if (!type.startsWith('{')) return true;
    const members = inlineMembers(type);
    if (members === null) return true;
    const record = value as Record<string, unknown>;
    /**
     * KEYS AND THEIR TYPES. Checking presence alone accepted `[{ a: 'wrong' }, true]` against
     * `[{ a: number }, boolean]` — the key was there and its value was anything at all.
     */
    for (const member of members) {
      const held = record[member.name];
      if (held === undefined) {
        if (!member.optional) return false;
        continue;
      }
      if (memberSatisfied(member.type, held) === false) return false;
    }
    return true;
  }
  /**
   * A callback may TAKE or RETURN an array. Decide the top-level arrow before looking at array
   * suffixes: `(p: number[]) => number[]` ends in `[]`, but the value satisfying the parameter is
   * still the function, not its eventual return value. Object literals stay first because
   * `{ combine: (x, y) => number }` contains an arrow without itself being a callback.
   */
  if (/=>/.test(type)) return typeof value === 'function';
  if (/^(readonly\s+)?\[/.test(type)) {
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return false;
    /**
     * A NESTED tuple is a tuple. Answering "it is an array" let `[[42, 'wrong'], true]` pass against
     * `[[string, number], boolean]` — arity and per-position checking stopped at the outer level, so
     * the inner pair was never read at all.
     */
    const members = tupleMemberTypes(type);
    if (members === null) return true;
    const list = value as unknown[];
    if (list.length !== members.length) return false;
    const verdicts = members.map((member, index) => memberSatisfied(member, list[index]));
    if (verdicts.some((verdict) => verdict === false)) return false;
    return verdicts.every((verdict) => verdict === true) ? true : null;
  }
  if (
    /(\[\]$|^(Readonly)?Array<|^ArrayLike<|^Iterable<|^(Float64|Float32|Int32|Uint32|Int8|Uint8)Array)/.test(
      type,
    )
  ) {
    return Array.isArray(value) || ArrayBuffer.isView(value);
  }
  // A NAMED type — an interface, an alias, a class. Nothing here can judge it, and guessing would
  // convict correct calls; `unknownable` is the honest answer.
  return null;
}

/**
 * A value against its declared type TEXT — and only convicted where the declaration is unambiguous.
 *
 * The `kind` label is the checker's ONE-WORD summary of a type, and a one-word summary of a union is
 * lossy: `input.asOf` is recorded `kind: numeric` and declared `string | number`, so trusting the
 * label rejected the perfectly valid date string synthesis supplies. Measured across the library,
 * trusting `kind` would have filed 141 well-formed baselines as malformed — worse than the gap it
 * was closing, because an `incomplete-baseline` verdict discards a real measurement.
 *
 * So the TYPE TEXT is the contract. A value need satisfy only ONE member of a union, and a member
 * this cannot judge — a named interface, a generic — makes the whole check abstain. Convict only
 * when every alternative is judgeable and the value matches none, which is exactly the case where
 * the call could not have come from a caller: `slice.impliedVolatility` is declared
 * `(strike: number) => number` and the harness passed `0.2`.
 */
/**
 * IS THIS VALUE IN THE DECLARED DOMAIN — by value AND by type.
 *
 * `literals.includes(String(value))` was the test everywhere, which was correct while a domain could
 * only be strings and is a bug now that it can be numbers: `String(1)` is `'1'`, so a numeric domain
 * `1 | -1` would admit the string `'1'` and a string domain `'1'` would admit the number `1`. A
 * domain is a set of admitted VALUES, and `1` and `'1'` are different admissions — the whole reason
 * for recording the values with their own types rather than as text.
 */
function admits(literals: readonly LiteralValue[] | undefined, value: unknown): boolean {
  return (literals ?? []).some((literal) => literal === value);
}

function scalarGap(
  node: { name?: string; type?: string; kind?: string; literals?: LiteralValue[] },
  value: unknown,
  path: string,
): BaselineGap | null {
  if ((node.literals?.length ?? 0) > 0) {
    if (!admits(node.literals, value)) {
      return {
        category: 'invalid-literal',
        path,
        detail: `${path} must be one of ${node
          .literals!.map((literal) => JSON.stringify(literal))
          .join(', ')}, got ${JSON.stringify(value)}`,
      };
    }
    return null;
  }
  const declared = (node.type ?? '').trim();
  if (declared.length === 0) return null;
  if (declared === 'never' || (/^(undefined|void)$/.test(declared) && value !== undefined)) {
    return {
      category: 'wrong-type',
      path,
      detail: `${path} is declared ${declared} and got ${describe(value)}`,
    };
  }
  /**
   * NULLISH MEMBERS ARE ABOUT OPTIONALITY, and they were abstaining the whole check.
   *
   * `{ a: number } | undefined` split into two members, `undefined` was unjudgeable, and one
   * unjudgeable member abstains everything — so EVERY optional coordinate in the library was exempt
   * from type checking, including explicit `ArrayLike<number> | undefined`. A missing value never
   * reaches here (the caller skips `undefined`) and `null` is decided by the nullability check above,
   * so for a value that is actually present the nullish arms say nothing.
   */
  const members = unionMembers(declared).filter(
    (member) => !/^(undefined|null|void)$/.test(member.trim()),
  );
  if (members.length === 0) return null;
  const verdicts = members.map((member) => memberSatisfied(member, value));
  if (verdicts.some((verdict) => verdict === true)) return null;
  if (verdicts.every((verdict) => verdict === false)) {
    return {
      category: 'wrong-type',
      path,
      detail: `${path} is declared ${declared} and got ${describe(value)}`,
    };
  }
  /**
   * A NAMED type cannot be judged from its text — but `kind` still knows its CONTAINER.
   *
   * Abstaining here is what made the validator ~2% effective on the surface that matters: real
   * coordinates are named (`Matrix`, `CommissionInput`), not inline literals, so `determinant(42)`
   * and `CostModel#commission(42)` were both recorded as valid baselines. My own five-case demo used
   * inline shapes and passed, which is the failure mode this phase keeps finding — a check proved on
   * a shape the library does not contain.
   *
   * `kind` is consulted ONLY for the container question, and only once the type text has declined.
   * That keeps the reason it was distrusted intact: `kind` is a lossy one-word summary of a UNION
   * (`asOf` is `numeric` and declared `string | number`), and every such case is judgeable from the
   * text, so it never reaches this line. What remains is the coarse fact a summary CAN carry — object
   * versus array versus function — and a value contradicting that contradicts every alternative.
   */
  /**
   * ONLY when NOTHING in the union could be judged.
   *
   * If some member was judgeable and rejected the value while another is a named type, the named one
   * may well accept it — `readSnapshot(expected: Kind | ReadonlyArray<Kind>)` is exactly that shape,
   * and a bare `Kind` string is a legal call the array arm alone would refuse. Convicting on a
   * partial reading is how the previous attempt at this check produced 141 false gaps.
   */
  if (!verdicts.every((verdict) => verdict === null)) return null;
  const kind = node.kind ?? '';
  const isArray = Array.isArray(value) || ArrayBuffer.isView(value);
  const isPlainObject = typeof value === 'object' && value !== null && !isArray;
  if (
    (kind === 'object' && !isPlainObject) ||
    ((kind === 'series' || kind === 'array') && !isArray)
  ) {
    return {
      category: 'wrong-type',
      path,
      detail: `${path} is declared ${declared} (a ${kind}) and got ${describe(value)}`,
    };
  }
  if ((kind === 'callback' || kind === 'function') && typeof value !== 'function') {
    return {
      category: 'wrong-type',
      path,
      detail: `${path} is declared ${declared} (a ${kind}) and got ${describe(value)}`,
    };
  }
  return null;
}

/** The declared FIELDS of an object: every required one present, no undeclared key, each valid. */
function objectGap(
  fields: readonly SynthesisField[] | undefined,
  value: unknown,
  path: string,
  depth: number,
  allowUndeclared: boolean,
  structuralOnly: boolean,
): BaselineGap | null {
  if (!fields || fields.length === 0 || depth > MAX_VALIDATE_DEPTH) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  /**
   * A CLASS INSTANCE IS NOT A REQUEST BAG, so its field tree is not a checklist for its runtime state.
   *
   * `eventDriven` is handed a real `SimulatedBroker`, whose `lastTs` is legitimately `null` before the
   * first fill. Judging a live collaborator against the declaration of a request reports the object's
   * own working state as a malformed call. The same precedent already governs the Law 12 sweep, which
   * skips any argument whose prototype is not `Object.prototype`.
   */
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Record<string, unknown>;
  const declared = new Set(fields.map((field) => field.name));
  for (const field of fields) {
    if (field.optional) continue;
    if (!(field.name in record)) {
      return {
        category: 'missing-required',
        path: `${path}.${field.name}`,
        detail: `${path}.${field.name} is required and was not supplied`,
      };
    }
  }
  if (!allowUndeclared) {
    for (const key of Object.keys(record)) {
      if (!declared.has(key)) {
        return {
          category: 'undeclared-key',
          path: `${path}.${key}`,
          detail: `${path}.${key} is not declared by the contract`,
        };
      }
    }
  }
  for (const field of fields) {
    const supplied = record[field.name];
    if (supplied === undefined) continue;
    const gap = nodeGap(
      field,
      supplied,
      `${path}.${field.name}`,
      depth + 1,
      allowUndeclared,
      structuralOnly,
    );
    if (gap) return gap;
  }
  return null;
}

/**
 * The branch of a union parameter that a given VALUE satisfies — or the merged tree when none does.
 *
 * The third reader of a union. c1f435cb made the builder and the validator agree ("build one branch,
 * accept one branch") and missed that the PROBE reads the same parameter through a third path: it is
 * handed `parameter.fieldTree`, the merged tree, so a field that exists only on the chosen branch is
 * not in `declared`, is treated as an undeclared extra, and its mutations are emitted WITHOUT
 * `declared: true`. `isAuthoritative` then refuses to convict on them.
 *
 * `strategyFromChain` shows both halves of the cost: the library accepted deletion of `wingWidth` — a
 * field branch 0 declares REQUIRED — and the harness filed it `advisory` instead of a failure. Worse,
 * a branch-only field whose sample value is not a number loses its `wrong-type` probe ENTIRELY, since
 * `wrongTypeFor(node?.kind ?? …)` has no kind to work from and returns undefined. The record shows
 * nothing missing in either case.
 *
 * Selecting by the VALUE rather than by index is what makes this correct for both callers: synthesis
 * retries onto later branches via `attempt`, and a hand-written fixture picks whatever branch it
 * likes. Falling back to the merged tree keeps today's behaviour exactly when nothing matches.
 */
export function satisfiedBranch(
  parameter: {
    fieldTree?: SynthesisField[];
    branches?: SynthesisBranch[];
    name?: string;
  },
  value: unknown,
): SynthesisField[] | undefined {
  const arms = armsOf(parameter);
  const shapes = arms ? armFields(arms) : null;
  if (!shapes || shapes.length === 0) return parameter.fieldTree;
  const index = selectBranch(parameter, value);
  if (index === null) {
    // Nothing the value both admits and satisfies. Falling back to the merged tree keeps today's
    // behaviour rather than attributing the value to a branch it contradicts.
    return parameter.fieldTree;
  }
  const branch = shapes[index];
  // A branch with no field shape has no tree to probe against; the merged one is still the honest
  // answer for a reader that wants fields.
  return branch && branch.length > 0 ? branch : parameter.fieldTree;
}

/** Why an argument list could not be built: the first field synthesis could not fill. */
export interface SynthesisGap {
  /** Dotted path from the parameter, e.g. `options.objective`. */
  path: string;
  /** The declared kind that could not be built — `function` is the one the harness refuses on purpose. */
  kind: string;
  type: string;
}

/**
 * WHY `synthesizeArguments` returned null, for callers that must classify the gap rather than guess.
 *
 * Guessing was the bug. `callback-input-required` was applied to any rejected contract whose
 * declaration merely CONTAINED a required function, so `differentialEvolution` — which fails on
 * `.for is not iterable`, from tuple bounds synthesis builds wrongly — was filed under a callback gap
 * it does not have. That is the fourth appearance of one mistake in this codebase: a label describing
 * a static property of the code path instead of what actually went wrong.
 *
 * Re-walks rather than threading a result through every build function, because the walk is cheap and
 * only runs where a measurement already failed.
 */
export function synthesisGap(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  producers?: Producers,
): SynthesisGap | null {
  const expanded = parameters.flatMap(
    (parameter): SynthesisParameter[] => tupleElements(parameter.type, parameter) ?? [parameter],
  );
  for (const parameter of expanded) {
    if (parameter.optional && parameter.kind !== 'object') continue;
    if (synthesizeValue(parameter, fields, soloContext(), '', producers) !== undefined) continue;
    const nested = firstUnbuildableField(parameter.fieldTree, parameter.name);
    return nested ?? { path: parameter.name, kind: parameter.kind, type: parameter.type };
  }
  return null;
}

/** Depth-first search for the first REQUIRED field that `valueForField` cannot build. */
function firstUnbuildableField(
  fields: readonly SynthesisField[] | undefined,
  prefix: string,
  depth = 1,
): SynthesisGap | null {
  if (!fields || depth > MAX_BUILD_DEPTH) return null;
  for (const field of fields) {
    if (field.optional) continue;
    if (valueForField(field, depth, soloContext(), '') !== undefined) continue;
    return (
      firstUnbuildableField(field.fields, `${prefix}.${field.name}`, depth + 1) ?? {
        path: `${prefix}.${field.name}`,
        kind: field.kind,
        type: field.type,
      }
    );
  }
  return null;
}

export function synthesizeArguments(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  /** Which of the curated ALTERNATIVES to use — see `FIELD_ALTERNATIVES`. */
  attempt = 0,
  producers?: Producers,
  selection: VariantSelection = new Map(),
): unknown[] | null {
  return synthesizeCallInner(parameters, fields, attempt, producers, selection)?.args ?? null;
}

function synthesizeCallInner(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  attempt: number,
  producers?: Producers,
  selection: VariantSelection = new Map(),
): SynthesizedCall | null {
  /**
   * Which optional fields does this selection say are PRESENT? Read from the gates themselves, so
   * the builder and the enumerator cannot disagree about what the call is meant to contain.
   */
  const materialize = new Map<string, string>();
  /** Every path that HAS a gate, so "not present" can be told from "not gated". */
  const gated = new Set<string>();
  for (const site of declaredSites(parameters, selection)) {
    if (site.gate !== true) continue;
    gated.add(site.valuePath);
    const choice = selection.get(site.key);
    if (choice !== undefined && choice.absent !== true) {
      materialize.set(site.valuePath, variantId(site.path, choice));
    }
  }
  const context: BuildContext = {
    attempt,
    selection,
    materialize,
    discovered: new Map(),
    scope: { qualified: '', plainAt: '' },
  };
  const args: unknown[] = [];
  const coordinates: SynthesisParameter[] = [];
  /**
   * A labelled tuple parameter IS several arguments; expand it before anything else so each element
   * is synthesized on its own name and type.
   */
  const expanded = parameters.flatMap(
    (parameter): SynthesisParameter[] => tupleElements(parameter.type, parameter) ?? [parameter],
  );
  /**
   * A SKIPPED OPTIONAL LEAVES A HOLE. Compacting it moves every later argument left.
   *
   * `adjustDate(date, convention?, calendar?)` synthesized `[date, calendar]` and labelled the
   * coordinates `[date, calendar]` — but JavaScript binds by POSITION, so the calendar object arrived
   * as `convention` and `calendar` kept its default. The call happened to return early (the
   * synthesized date is a business day), so nothing threw, and every mutation of argument 1 was
   * recorded as Calendar enforcement evidence about an argument the function never received as a
   * calendar. Silent, and exactly the class of false evidence this phase exists to remove.
   *
   * So the index is the PARAMETER's position, holes are preserved as `undefined`, and paths, policies
   * and coordinates all speak the same real JavaScript argument space.
   */
  expanded.forEach((parameter, index) => {
    // Optional NON-object arguments are omitted, keeping the baseline the minimal valid call so a later
    // `omit-required` probe means something.
    //
    // An optional OBJECT is included anyway, because it is usually the only thing there is to probe:
    // `formatMoney(value, options?)` carries its whole key contract on the optional argument, and
    // stopping at the first optional produced a baseline of `[1]` with no object in it — zero probes,
    // which the harness then scored as "enforced". A contract with nothing probed is unmeasured, and
    // the fix belongs on both sides: include the object here, and refuse to grade zero probes there.
    /**
     * A GATED argument is present exactly when its gate says so.
     *
     * The rule above is kept for arguments with NO gate — it is why `formatMoney(value, options?)`
     * has anything to probe. Where a gate exists it decides, so the omitted call becomes a measured
     * outcome rather than a shape the harness never builds: `spectralRisk(returns, options?)`
     * published `arg1#0` and `arg1#1` and never the call every caller writes first.
     */
    const path = `arg${index}`;
    const gateScope = materialize.get(path);
    const omitted = gated.has(path)
      ? gateScope === undefined
      : parameter.optional && parameter.kind !== 'object';
    const build = (): unknown => synthesizeValue(parameter, fields, context, path, producers);
    const value = omitted
      ? undefined
      : gateScope === undefined
        ? build()
        : underScope(context, { qualified: gateScope, plainAt: path }, build);
    args[index] = value;
    coordinates[index] = parameter;
  });
  // A required parameter that could not be built is still fatal.
  const unbuildable = expanded.some(
    (parameter, index) => !parameter.optional && args[index] === undefined,
  );
  if (unbuildable) return null;
  /**
   * TRIM the trailing holes — but only the trailing ones. Passing `undefined` past the last real
   * argument would add coordinates describing arguments no caller would write.
   */
  while (args.length > 0 && args[args.length - 1] === undefined) {
    args.pop();
    coordinates.pop();
  }
  return args.some((value) => value !== undefined)
    ? { args, coordinates, sites: [...context.discovered.values()] }
    : null;
}

/**
 * The COORDINATES of a call: one entry per argument actually passed, in order.
 *
 * A callable's parameter list and its ARGUMENT list are not the same sequence, and treating them as
 * one is a defect that hides in plain sight. A labelled rest-tuple is ONE parameter carrying several
 * arguments; an optional non-object parameter is one parameter carrying NO argument. Synthesis has
 * always known this — it expands and skips — but everything downstream indexed the raw parameter
 * array against the produced arguments, so `fieldTrees[i]` described a different slot than `args[i]`
 * for every callable with a tuple. 190 public paths across 36 implementations declare one, 178 of
 * them measured against trees that were off by however many elements the tuple contributed.
 *
 * `synthesizeCall` returns both from ONE walk, so alignment is a property of construction rather than
 * something a second walker has to re-derive and keep in step. That is the same "two walkers is how
 * the same declaration gets two answers" failure this phase has now hit in the field trees, the
 * naming inventory, and here.
 */
export function synthesizeCall(
  parameters: readonly SynthesisParameter[],
  fields: readonly string[],
  attempt = 0,
  producers?: Producers,
  /** Which union alternative to build at each node; unnamed nodes take their first. */
  selection: VariantSelection = new Map(),
): SynthesizedCall | null {
  return synthesizeCallInner(parameters, fields, attempt, producers, selection);
}

/**
 * The declared coordinates of a callable, for a call the harness did NOT build.
 *
 * A hand-written fixture has no synthesis walk to borrow alignment from, so this performs the same
 * tuple expansion and nothing else. Optional parameters are NOT dropped here: a fixture may pass an
 * optional argument the synthesizer would have skipped, and optional parameters are trailing in
 * TypeScript, so aligning from the left and truncating to the argument count is exact.
 */
export function expandedCoordinates(
  parameters: readonly SynthesisParameter[],
): SynthesisParameter[] {
  return parameters.flatMap(
    (parameter): SynthesisParameter[] => tupleElements(parameter.type, parameter) ?? [parameter],
  );
}

function synthesizeValue(
  parameter: SynthesisParameter,
  fields: readonly string[],
  context: BuildContext,
  /** This argument's path — `arg0` — so a union rooted at the parameter has an identity. */
  path: string,
  producers?: Producers,
): unknown | undefined {
  const attempt = context.attempt;
  // Same precedence as `valueForField`, and the same restriction: only a scalar parameter may have its
  // type text sniffed for literals, because an object type carries its children's literals too.
  /**
   * A NAMED BRANCH OUTRANKS A CURATED VALUE — and it did not, which published false measurements.
   *
   * `PriceSource` is `'bid' | 'ask' | 'mid' | 'last' | 'mark'`. Its arms became visible when the
   * producers stopped gating unions on "does some arm expand to named members", so enumeration
   * correctly offered five alternatives. But this shortcut ran FIRST and answered `'bid'` from the
   * parameter's own literal list every time, so `selectQuotePrice / arg1#2` was published as a
   * MEASURED alternative from a call that passes `'bid'` — the harness reporting coverage of a value
   * it never sent. Six alternatives across two boundaries were wrong that way.
   *
   * The precedence only bites where a variant explicitly NAMES a branch. Unselected calls keep the
   * curated value, which is what the name table exists for.
   */
  const rootArms = armsOf(parameter);
  const scalarUnion = parameter.kind !== 'object' && (rootArms?.length ?? 0) > 1 ? rootArms! : null;
  const branch = scalarUnion
    ? chooseBranch(context, path, armFields(scalarUnion), armTypes(scalarUnion), scalarUnion)
    : null;

  const named = branch?.selected
    ? undefined
    : preferredValue(
        parameter.name,
        parameter.literals,
        parameter.kind === 'primitive' ? parameter.type : undefined,
        attempt,
      );
  // Same rule as the field-level table: a curated value may not contradict its declaration.
  if (named !== undefined && scalarGap(parameter, named, parameter.name) === null) return named;

  /**
   * A UNION recorded on a NON-OBJECT parameter — which synthesis never read.
   *
   * `kind` answers "what does a caller pass, and what can synthesis build?";
   * `branchFields` answers "what is the contract of each alternative?". The
   * inventory records the second for ANY multi-branch union (RV12 says so in as
   * many words), and this file consulted it only inside the `object` case. So
   * `classifyStrategy(legs: Position | ReadonlyArray<LegInput> |
   * ReadonlyArray<ClassifiableLeg>)` — which reads as a `series`, correctly —
   * never reached branch selection: it built one array, and one alternative's
   * result was published as the boundary's verdict. The scoped spelling said
   * `enforced` from the `Position` branch while the umbrella said `partial` from
   * an array, which is the same callable disagreeing with itself.
   *
   * Object-kind unions keep the existing path below, which reaches for a
   * PRODUCED instance first; only the kinds that had no branch handling at all
   * are routed here.
   */
  if (branch) {
    const { fields, branchType, choice, selected, scope } = branch;
    /**
     * THE ARM AS A NODE, then its fields, then its rendered text — same order as the field level.
     *
     * `valueForBranchType` reads the arm's TYPE TEXT and guesses, which is all it could do when an
     * arm was a string. It is why `readSnapshot(kind: Kind | ReadonlyArray<Kind>)` published `arg1#1`
     * from a call that does not select it: the text `ReadonlyArray<Kind>` reads as a sequence, the
     * sequence fallback answers sixty NUMBERS, and `Kind` is a set of string literals — so the value
     * satisfied neither arm. The arm node carries `element`, and the element carries the literals, so
     * building the arm as a node produces an array of legal values instead of a guess about a name.
     *
     * The text path stays as the last resort for an arm that carries nothing but its type, which is
     * every arm the legacy arrays could describe.
     */
    /**
     * ONLY AN ARM WITH STRUCTURE, and the restriction is a measured one.
     *
     * Routing every arm back through `valueForField` also routes it back through the curated NAME
     * table, which is keyed by the parameter's name and knows nothing about which alternative was
     * asked for. `nthWeekdayOfMonth(year, month, weekday: 0|1|2|3|4|5|6)` has seven literal arms and
     * one name: the table answered the same weekday for all seven, so six of them published from a
     * call that selects a different one — twelve rows across two boundaries, a REGRESSION traded for
     * the three this change was meant to fix.
     *
     * A structural arm — one with an element, positions or fields — has something to build FROM, and
     * that is the case the text fallback could not serve: `ReadonlyArray<Kind>` reads as a sequence
     * and gets sixty numbers, while `Kind` is a set of string literals. A bare literal arm is already
     * served correctly by its rendered type, which IS the value.
     */
    const armCandidate = scalarUnion?.[Math.min(choice.branch, scalarUnion.length - 1)];
    const armNode =
      armCandidate &&
      (armCandidate.element || armCandidate.tuple || (armCandidate.fields?.length ?? 0) > 0)
        ? armCandidate
        : undefined;
    const built =
      armNode && (armNode.kind !== 'object' || !fields || fields.length === 0)
        ? (underScope(context, scope, () =>
            valueForField(
              { ...armNode, name: parameter.name, optional: false, nullable: false },
              1,
              context,
              path,
            ),
          ) ??
          (fields && fields.length > 0
            ? underScope(context, scope, () =>
                buildObject(fields, 1, context, path, choice.discriminator),
              )
            : branchType === undefined
              ? undefined
              : valueForBranchType(branchType)))
        : fields && fields.length > 0
          ? underScope(context, scope, () =>
              buildObject(fields, 1, context, path, choice.discriminator),
            )
          : branchType === undefined
            ? undefined
            : valueForBranchType(branchType);
    if (built !== undefined) {
      // Building FROM an arm does not prove that the value SELECTS that arm.
      // Overlapping array declarations can produce the same minimal value:
      // ClassifiableLeg[] also satisfies the earlier LegInput[] arm. Keep the
      // reader's first-match semantics, but never return its earlier arm under
      // an explicitly selected later arm's name. A retry may add an optional
      // field that separates the arms; otherwise this alternative has no input.
      if (selected && selectBranch(parameter, built) !== choice.branch) return undefined;
      return built;
    }
    /**
     * A SELECTED branch that cannot be built is UNMEASURED, never a fall-through.
     *
     * Falling back to the generic kind below builds a different alternative and
     * files it under this variant's name: `classifyStrategy`'s two `Position`
     * variants both produced the 60-element array that its ARRAY branches
     * produce, so three distinct alternatives would have been measured as one
     * call wearing three labels. An unbuildable alternative is a gap, and a gap
     * already denies the boundary `enforced`.
     */
    if (selected) return undefined;
  }

  /**
   * A TUPLE PARAMETER IS BUILT FROM ITS METADATA, and the metadata is consulted FIRST — the same rule
   * the field level already follows, which the parameter level did not.
   *
   * Above the `kind` switch ON PURPOSE. `[number, Fixed | Floating]` classifies as `other`, not as a
   * series: the kind test looks for `Array`/`[]` and a bare tuple matches neither. Putting this in
   * the `series` case — where it went first — would have been dead code that a hand-written fixture
   * declaring `kind: 'series'` still made pass, which is a test asserting a shape the classifier
   * never emits. The declaration is authoritative whatever the kind, so the kind is not consulted.
   *
   * Without it the text heuristic answers: it sees `[…number…]` and returns FOUR two-element rows —
   * an array of tuples where the declaration says one tuple. Every position built as a number, so a
   * union at position 1 was unreachable whichever branch a variant selected. That is the builder's
   * half of the hole `{ position: n }` closes in the walker; discovery without construction would
   * only have converted silence into `no-input`.
   *
   * Trailing optionals are dropped, and only trailing ones exist — TypeScript rejects a required
   * element after an optional one — so the surviving indices still line up with the declaration,
   * which is what keeps these positions addressable as `arg0[i]`.
   */
  if (parameter.tuple && parameter.tuple.length > 0) {
    const built = parameter.tuple
      .filter((position) => !position.optional)
      .map((position, index) => valueForField(position, 1, context, `${path}[${index}]`));
    if (!built.some((value) => value === undefined)) return built;
  }

  switch (parameter.kind) {
    case 'numeric':
      return 1;
    case 'series': {
      if (wantsMatrix(parameter.type)) return matrix();
      /**
       * A sequence of a DECLARED contract gets built from that contract, not from numbers.
       *
       * Nothing before this looked below the container, so every sequence became a price series
       * whatever its elements were declared to be, and the libraries that wanted records said so
       * precisely: "expected trades[0] to be a trade print { contract: { underlying, expiry, strike,
       * type }, price, size }".
       */
      if (parameter.elementFieldTree && parameter.elementFieldTree.length > 0) {
        const element = buildObject(parameter.elementFieldTree, 1, context, path);
        if (element !== undefined) {
          return Array.from({ length: SERIES_LENGTH }, () => freshCopy(element));
        }
      }
      // Each of these is a shape the library asked for in its own rejection message.
      if (/readonly \[string, number\]|\[string, number\]/.test(parameter.type))
        return datedPoints();
      /**
       * An ARRAY OF NUMERIC TUPLES — `ReadonlyArray<readonly [number, number]>`, which is how this
       * library spells a list of intervals: optimiser bounds, histogram edges, a piecewise domain.
       *
       * It was matching the generic series fallback and getting sixty scalars, so
       * `differentialEvolution` destructured a number and answered `.for is not iterable`. The
       * element arity is read from the declaration rather than assumed to be 2, and the values are
       * ordered low-then-high because every consumer of a bound in this library requires it.
       */
      const numericTuple = /readonly \[([^\]]*number[^\]]*)\]|(?<!\w)\[([^\]]*number[^\]]*)\]/.exec(
        parameter.type,
      );
      if (numericTuple && /number/.test(numericTuple[0])) {
        const arity = numericTuple[0].split(',').length;
        return Array.from({ length: 4 }, (_, index) =>
          Array.from({ length: arity }, (_, slot) => index + slot),
        );
      }
      if (/\bPair\b/.test(parameter.type)) return pairs();
      // An interpolation AXIS must be monotonic; a price path is not.
      if (/^(xs|ys|x|knots|grid|breakpoints|abscissa)$/.test(parameter.name)) return increasing();
      /**
       * NO PRODUCER FALLBACK HERE, and that was tried.
       *
       * Letting a `series` parameter take factory-produced elements looked symmetrical with the object
       * branch and cost 30 boundaries: `acf(series: ArrayLike<number>)` matched a producer through its
       * element identity and got four records where it wanted sixty numbers, then said so — "series
       * contains a non-finite value at index 0", "series must have at least 8 observations, got 4".
       *
       * The asymmetry is real rather than an oversight. A `series` parameter always has a buildable
       * answer, so a producer could only ever DISPLACE a good input; the object branch reaches for one
       * only when nothing else could build anything. Last resort has to mean last.
       */
      return /Bar|bar|ohlc/i.test(parameter.type) ? bars() : series();
    }
    case 'primitive': {
      const literal = firstLiteral(parameter.type);
      if (literal) return literal;
      if (/boolean/.test(parameter.type)) return false;
      if (/number/.test(parameter.type)) return 1;
      // Same reasoning as the field-level string case: the baseline must still succeed, so trying
      // costs nothing but a path that was already unmeasured.
      if (/string/.test(parameter.type)) return genericString(parameter.name);
      return undefined;
    }
    case 'callback':
      return callbackStub(
        parameter.type,
        parameter.returns,
        0,
        context,
        path,
        parameter.callSignature,
      );
    case 'object': {
      /**
       * The DECLARED field tree first (3B.0-R7). It carries requiredness, types, string-literal
       * unions, array element contracts and nested objects — everything the two fallbacks below have
       * to guess at. 585 of the 705 unmeasured-for-lack-of-input paths take a single object argument,
       * and the tree was already recorded on 1,568 contracts, unused.
       */
      /**
       * A BEHAVIOURAL contract prefers a produced instance over its own declaration.
       *
       * This inverts the last-resort rule, deliberately and only here. A declaration describes DATA
       * well and BEHAVIOUR badly: `YieldCurve` declares thirteen members, ten of them functions with
       * invariants between them, and building it from the tree yields an object whose `discount` is a
       * stub answering 0.6 forever. It passes `typeof curve.discount === 'function'` and satisfies
       * nothing else a curve is for.
       *
       * So where the library can MAKE one, that is the better input — and the probe is no weaker for
       * it: adding an undeclared key to a real curve still asks whether the boundary rejects it, and
       * deleting a declared member still asks whether it notices. A fake instance answers a different
       * question badly.
       *
       * "Behavioural" is read off the declaration rather than curated: a majority of required members
       * being functions is what distinguishes a `YieldCurve` from an options bag.
       */
      const produce = produced(parameter, producers);
      if (produce !== undefined && behavioural(parameter.fieldTree)) return produce;
      /**
       * A ROOT UNION is built from ONE BRANCH, before the merged tree is considered.
       *
       * Same rule `valueForField` applies to nested unions, and the same path-keyed selection: the
       * node is recorded so it can be enumerated, and the chosen alternative is built. It has to come
       * first, because the merged `fieldTree` for a discriminated union describes an object no branch
       * accepts — building from it does not produce a worse baseline, it produces an invalid one.
       *
       * Falls through on failure rather than returning: a branch that cannot be built is not a reason
       * to abandon a parameter the merged tree might still satisfy.
       */
      const branches = rootArms ? armFields(rootArms) : null;
      if (branches && branches.length > 0) {
        const {
          fields: chosen,
          branchType,
          choice,
          selected,
          scope,
        } = chooseBranch(
          context,
          path,
          branches,
          rootArms ? armTypes(rootArms) : undefined,
          rootArms ?? undefined,
        );
        if (chosen === null || chosen.length === 0) {
          const built = branchType === undefined ? undefined : valueForBranchType(branchType);
          if (built !== undefined) return built;
        } else {
          const built = underScope(context, scope, () =>
            buildObject(chosen, 1, context, path, choice.discriminator),
          );
          if (built !== undefined) return built;
        }
        // Same rule as above: an explicitly selected branch does not fall back
        // onto the merged tree, which describes an object no branch accepts.
        if (selected) return undefined;
      }
      if (parameter.fieldTree && parameter.fieldTree.length > 0) {
        const built = buildObject(parameter.fieldTree, 1, context, path);
        if (built !== undefined) return built;
      }
      /**
       * A `Record<K, never>` IS the empty options bag — the same contract as `{}`, whichever way
       * TypeScript renders a parameters type with no keys. It renders BOTH `Record<never, never>`
       * and `Record<string, never>` depending on how the declaration was written, and matching only
       * the first left 14 more `.stream()` factories filed as "could not build an input". A value
       * type of `never` says no key may carry a value, which is the same contract either way.
       *
       * `buildObject` already knows an empty contract's minimal call is `{}` rather than a failure;
       * that rule just never ran here, because a type with no members joins to no field tree and the
       * inline parser only recognizes a literal brace. So 19 `.stream()` factories were filed "we
       * could not build an input" when the input was `{}` and the declaration said as much.
       *
       * These are the interesting ones, not the trivial ones: an options bag that declares NO keys is
       * exactly where Law 12 has something to say, and `adLine.stream({ qzxBogus: 1 })` either
       * rejects the undeclared key or does not.
       */
      if (/^Record<\s*[^,<>]+\s*,\s*never\s*>(\s*\|\s*undefined)?$/.test(parameter.type.trim())) {
        return {};
      }
      /**
       * An INLINE object type carries its own field names, so read them from the type text.
       *
       * `BollingerStream`'s constructor takes `{ period: number; standardDeviation: number }` — an
       * anonymous type with no entry in the naming baseline to join against, so the join-based path
       * returned nothing and all 78 public constructors stayed unmeasured even after the harness learned
       * to use `new`. The declaration already says what the fields are.
       */
      const inline = parameter.type.trim();
      if (inline.startsWith('{')) {
        /**
         * An inline object type states its field TYPES, not merely their names — use both.
         *
         * Reading names alone meant a field absent from the curated table was simply dropped, and a
         * destructured constructor parameter is exactly that case: TypeScript renders it `__0: { fast:
         * number; slow: number }`, neither name is domain vocabulary anyone would curate, so the
         * object came out empty and the stream could not be constructed. 30 `fromJSON` boundaries then
         * fell back to a generic snapshot whose `schemaVersion` was the numeric default of 1 — and the
         * envelope requires 2, so they refused it and said why.
         *
         * The declaration had the answer in the same string the whole time.
         */
        const object: Record<string, unknown> = {};
        let requiredFields = 0;
        for (const match of inline.matchAll(
          // The type may OPEN with a quote. Requiring an identifier first meant a field declared as a
          // literal union never matched at all — `{ field: 'open' | 'high' }` was not merely given the
          // wrong value, it was dropped so completely that it did not even count toward
          // `requiredFields`, and the object then read as a legitimate all-optional `{}`.
          /([A-Za-z_$][\w$]*)(\??)\s*:\s*((?:'[^']*'|[A-Za-z_$][\w$]*)[\w$<>|'\s.[\]]*)/g,
        )) {
          const [, name, optional, declaredType] = match;
          // Optional fields stay out: the baseline should be the MINIMAL valid call.
          if (optional === '?') continue;
          requiredFields++;
          const preferred = preferredValue(name!, undefined, declaredType!, attempt);
          if (preferred !== undefined) {
            object[name!] = preferred;
            continue;
          }
          const trimmedType = declaredType!.trim();
          /**
           * ARRAYS FIRST. `/^number\b/` matches `number[]` — the word boundary sits before the
           * bracket — so an array field was being handed a scalar and the library said so from
           * inside: "rocP.map is not a function", "weights is not iterable". Ordering the checks by
           * specificity is the whole fix, and the symptom was three constructors throwing an untyped
           * TypeError, which is the shape a synthesis bug takes when it reaches real code.
           */
          if (wantsMatrix(trimmedType)) object[name!] = matrix();
          else if (/\[\]|^(?:Readonly)?Array\b|^ArrayLike\b/.test(trimmedType))
            object[name!] = series();
          else if (/^number\b/.test(trimmedType)) object[name!] = 1;
          else if (/^boolean\b/.test(trimmedType)) object[name!] = false;
          // Third and last place a generic string is produced. An inline type is where the date names
          // cluster — `expirations(calendar, range: { from: string; to: string })` is declared nowhere
          // else, so it has no field tree to carry the answer and this parser IS the contract.
          else if (/^string\b/.test(trimmedType)) object[name!] = genericString(name!);
        }
        if (Object.keys(object).length > 0) return object;
        /**
         * `{}` is the minimal valid call whenever nothing is REQUIRED — whether the type declares no
         * keys at all or declares only optional ones. Carrying only the first half of that rule cost
         * 52 paths: skipping optional fields (correctly, for a minimal baseline) left an all-optional
         * type with an empty object, which then read as "could not build an input" rather than as the
         * input it is. The same reasoning `buildObject` already applied, applied one place later.
         */
        return requiredFields === 0 ? {} : undefined;
      }
      // Otherwise populate from the recursive fields recorded for the OWNING type only (top-level
      // names), so a nested field never becomes a stray top-level key the contract would rightly reject.
      const owner = /^([A-Za-z_$][\w$]*)/.exec(parameter.type)?.[1];
      if (!owner) return undefined;
      const own = fields
        .filter((path) => path.startsWith(`${owner}.`))
        .map((path) => path.slice(owner.length + 1))
        .filter((path) => !path.includes('.'));
      if (own.length === 0) return undefined;
      const object: Record<string, unknown> = {};
      for (const field of own) {
        const value = curatedValue(field, attempt);
        if (value !== undefined) object[field] = value;
      }
      /**
       * ALL the names or none — and the argument I made for returning a partial object was CIRCULAR.
       *
       * I claimed the baseline rule settles it: build a partial request, and if the contract accepts
       * it then it was valid by the only test that matters. That reasoning assumes the conclusion.
       * The thing being measured IS whether the implementation validates its required fields, so
       * "it accepted my incomplete request" is not evidence of validity — it is the defect, observed
       * and then used as proof that no defect occurred.
       *
       * Worse than circular, it is silently lossy: if the omitted field was required and unvalidated,
       * that is an `omit-required` finding the harness manufactured and then failed to record, while
       * every subsequent probe measured against a baseline already known to be wrong.
       *
       * This path has only NAMES — no types, no requiredness — so it cannot distinguish a field it
       * failed to fill from one that is optional, and therefore cannot make this judgement at all.
       * The honest answer is to build nothing. It costs `SignalBuilder#addRule`, which wants a hand
       * fixture rather than a weakened global invariant.
       */
      if (own.every((field) => field in object)) return object;
      return produced(parameter, producers);
    }
    default:
      // A `series` of a class, an `other` — anything the declaration could not build. Last resort.
      return produced(parameter, producers);
  }
}

/**
 * Is this contract mostly BEHAVIOUR? A majority of required members declared as functions.
 *
 * The threshold is a majority rather than "any", because plenty of honest request objects carry one
 * callback — `{ returns, onProgress? }` is a data contract with a hook, and synthesizing it from the
 * declaration is right. A type that is mostly methods is an object the library makes.
 */
function behavioural(fields: readonly SynthesisField[] | undefined): boolean {
  if (!fields || fields.length === 0) return false;
  const required = fields.filter((field) => !field.optional);
  if (required.length === 0) return false;
  return required.filter((field) => field.kind === 'function').length * 2 > required.length;
}

/** The factory-produced instance for this parameter's contract, if one was resolved. See `Producers`. */
function produced(parameter: SynthesisParameter, producers?: Producers): unknown | undefined {
  if (!producers || !parameter.contract) return undefined;
  return producers.get(parameter.contract)?.();
}
