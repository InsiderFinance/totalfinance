/**
 * Public naming policy (Phase 3B.N — `docs/specs/phase-3b-public-naming-normalization.md`).
 *
 * The generator discovers names; it may not invent financial meaning. Everything a human had to
 * decide lives here: which short terms survive, which are forbidden and what they become, which
 * mathematical symbols are legal inside which owning type, and which envelopes are deliberately
 * opaque.
 *
 * Classification order for one public identity (see `naming-inventory.ts`):
 *
 * 1. an exact `CANONICAL_NAMES` hit                  → `canonical-term`
 * 2. an approved symbol for its owning scope         → `scoped-symbol`
 * 3. a member of an explicitly opaque payload        → `opaque-state`
 * 4. no forbidden token                              → `explicit`
 * 5. otherwise                                       → `unresolved` (the migration queue)
 *
 * Law N7: a shortened public term is retained only when it is the dominant term users search for,
 * has one meaning in the owning API, loses recognition when expanded, is cased consistently, and
 * appears HERE with a rationale. "Quant developers know it," "it is shorter," and "the code already
 * uses it" are not rationales — so every entry below carries the reason it survives.
 *
 * ⚠ EXCLUDE THIS FILE FROM EVERY BULK RENAME SWEEP. Its keys ARE the forbidden tokens, so a
 * repo-wide `spec` → `specification` pass rewrites the rule that forbids `spec` and the migration
 * silently "completes". This has happened four times during 3B.N; each time the "the policy protects
 * itself" gate in `naming-conformance.test.ts` caught it, which is why that gate is not optional.
 */

/** A forbidden public token: why it fails, and the canonical direction that replaces it. */
export interface ForbiddenToken {
  /** The canonical replacement direction. Semantic expansion, never string expansion (Law N3). */
  direction: string;
  /** Why the short form fails at a public boundary. */
  why: string;
}

/**
 * Tokens that may not appear in a public name.
 *
 * Matching is per TOKEN, not substring: `volatility` tokenizes to `['volatility']` and is never
 * caught by `vol`, while `atmVol` tokenizes to `['atm', 'vol']` and is. A name that must keep a
 * forbidden token earns an entry in {@link CANONICAL_NAMES} or a scoped-symbol approval — never a
 * silent exemption.
 */
export const FORBIDDEN_TOKENS: Readonly<Record<string, ForbiddenToken>> = {
  acc: {
    direction: 'accumulated or accumulator',
    why: 'Truncation also ambiguous with "accuracy" and "account".',
  },
  adv: {
    direction: 'averageDailyVolume',
    why: 'Truncation that also reads as "advance" and "advertisement".',
  },
  agg: {
    direction: 'aggregate or aggregation',
    why: 'Truncation with an unambiguous expansion.',
  },
  def: {
    direction: 'definition',
    why: 'Truncation that also reads as "default" and as the Python keyword.',
  },
  dk: {
    direction: 'logMoneynessStep',
    why: 'Two letters standing for a grid increment in log-moneyness.',
  },
  lw: {
    direction: 'ledoitWolf',
    why: 'Two letters standing for the authors of the shrinkage estimator.',
  },
  ma: {
    direction: 'movingAverage',
    // The retired form is spelled by concatenation. A sweep already rewrote this sentence once,
    // into "`movingAverageType` reads as a two-letter riddle where `movingAverageType` reads as
    // itself" — a rule whose stated reason contradicts itself, shipped green because the result is
    // still a grammatical sentence and nothing reads prose.
    why:
      'Truncation. `' +
      'ma' +
      'Type` reads as a two-letter riddle where `movingAverageType` reads as itself.',
  },
  mul: {
    direction: 'multiply',
    why: 'Truncation with an unambiguous expansion.',
  },
  oi: {
    direction: 'openInterest',
    why: 'Two letters standing for a core options quantity.',
  },
  piv: {
    direction: 'pivotIndices',
    why: 'Truncation of "pivot" that reads as an unrelated word.',
  },
  src: {
    direction: 'source',
    why: 'Truncation with an unambiguous expansion.',
  },
  val: {
    direction: 'value',
    why: 'Truncation with an unambiguous expansion.',
  },
  vec: {
    direction: 'vector',
    why: 'Truncation with an unambiguous expansion.',
  },
  vrp: {
    direction: 'varianceRiskPremium',
    why: 'Three-letter initialism a general caller cannot expand.',
  },
  zcb: {
    direction: 'zeroCouponBond',
    why: 'Three-letter initialism a general caller cannot expand.',
  },

  bc: {
    direction: 'name the quantity - the docstring already does',
    why: 'Two letters whose expansion exists only in the comment beside them.',
  },
  br: {
    direction: 'name the quantity - the docstring already does',
    why: 'Two letters whose expansion exists only in the comment beside them.',
  },
  ivs: {
    direction: 'impliedVolatilities',
    why: 'Truncation of a plural with an unambiguous expansion.',
  },
  op: {
    direction: 'operator',
    why: 'Truncation that also reads as "operation" and "option".',
  },
  scn: {
    direction: 'scenario',
    why: 'Truncation with an unambiguous expansion.',
  },

  // ---- RV8: truncations the denylist never contained, so nothing ever flagged them ----
  // RV7 fixed the TOKENIZER; these are the other half of the same defect — a name is only reviewed
  // if some rule recognizes it, and "no rule matched" was being reported as "explicit". None of
  // these appeared in any queue because none was ever on a list.
  adj: {
    direction: 'adjusted — the spelled-out sibling already exists',
    why: 'Truncation. It rode into the allowlist on the R² exemption, which says nothing about it.',
  },
  na: {
    direction: 'name the coefficient — the docstring already does',
    why: 'Two letters with no meaning outside the paper the parameter came from.',
  },
  nb: {
    direction: 'name the coefficient — the docstring already does',
    why: 'Two letters with no meaning outside the paper the parameter came from.',
  },
  nc: {
    direction: 'name the coefficient — the docstring already does',
    why: 'Two letters with no meaning outside the paper the parameter came from.',
  },
  zg: {
    direction: 'name the band — the docstring already does',
    why: 'Two letters whose expansion exists only in the comment beside them.',
  },
  sg: {
    direction: 'name the band — the docstring already does',
    why: 'Two letters whose expansion exists only in the comment beside them.',
  },
  xg: {
    direction: 'name the band — the docstring already does',
    why: 'Two letters whose expansion exists only in the comment beside them.',
  },

  // ---- Short truncations that read as words but are not (RV7) ----
  // Each of these passed as `explicit` for the whole of 3B.N, because "not on the denylist" was
  // being reported as "reviewed". They are truncations of a concept, and a caller cannot expand any
  // of them without package lore.
  lo: {
    direction: 'lower — as in `lowerVolatilityBound`',
    why: 'A truncation of "lower" that also reads as a musical note and as a greeting.',
  },
  hi: {
    direction: 'upper — as in `upperVolatilityBound`, `bodyHigh`',
    why: 'A truncation indistinguishable from a greeting; `hiBody` reads as neither.',
  },
  mult: {
    direction: 'multiplier',
    why: 'A truncation whose expansion is unambiguous, so there is no reason to keep it.',
  },
  bb: {
    direction: 'bollingerBand — as in `bollingerBandPeriod`',
    why: 'Two letters standing for an indicator family; the period field requires knowing the library.',
  },
  kc: {
    direction: 'keltnerChannel — as in `keltnerChannelPeriod`',
    why: 'Two letters standing for an indicator family, and its multiplier field compounds two truncations.',
  },
  rr: {
    direction: 'riskReversal — as in `riskReversal25Delta`',
    why: 'An options-desk initialism that a general caller cannot expand.',
  },
  bf: {
    direction: 'butterfly — as in `butterfly25Delta`',
    why: 'An options-desk initialism that a general caller cannot expand.',
  },
  // ---- The volatility family (Law N2's headline case) ----
  vol: {
    direction: 'volatility — or volume, when the quantity really is traded volume',
    why: 'Two plausible meanings in one library: the volatility package meant volatility while the technical-analysis VFI `volCutoff` means VOLUME. A caller should never need package lore to tell them apart.',
  },
  iv: {
    direction: 'impliedVolatility',
    why: 'Two-letter contraction of a crossing-model quantity.',
  },
  rv: {
    direction: 'realizedVolatility',
    why: 'Two-letter contraction of a crossing-model quantity.',
  },
  ta: {
    direction: 'technicalAnalysis / technical-analysis / technical_analysis',
    why: 'A CATEGORY abbreviation, unlike the exact indicator identities (RSI, MACD, ATR) it contains. Package names, dependency lists, stack traces, and MCP identities are read outside an established trading context, where the full phrase is immediately interpretable. `TA` survives as docs, compatibility, and search vocabulary — never as an executable identity.',
  },

  // ---- Time, and its hidden units (Law N4) ----
  t: {
    direction: 'timeToExpiryYears, timeToMaturityYears, or tenorYears — chosen by domain meaning',
    why: 'Hides both meaning and unit: expiry, maturity, tenor, a curve coordinate, or an observation index, usually but not always in years.',
  },
  ts: { direction: 'timestampMs', why: 'Hides that the number is epoch milliseconds.' },
  dt: { direction: 'timeStepYears, or the exact step basis', why: 'Hides the step unit.' },
  dte: { direction: 'daysToExpiry', why: 'Domain contraction; the full phrase is already short.' },

  // ---- Rates ----
  rate: {
    direction:
      'riskFreeRate — or the exact role: discount, funding, borrow, coupon, forward, hazard, dividend, zero',
    why: 'A request may plausibly carry several different rates; a generic `rate` is only legal when the owning object itself supplies the role (e.g. `DepositInstrument`). `RateCurvePoint` renamed its pillar to `zeroRate` (2026-08-23): its semantics are explicitly zero-rate-quoted, so the generic name was no longer justified.',
  },

  // ---- Models and methods ----
  bs: {
    direction: 'blackScholes',
    why: 'Initialism for the library flagship; the full name is what users search.',
  },
  bsm: {
    direction: 'blackScholes',
    why: 'The public common name is Black-Scholes; docs still state Black-Scholes-Merton.',
  },
  mc: { direction: 'monteCarlo', why: 'Two-letter contraction of a method name.' },
  qmc: { direction: 'quasiMonteCarlo', why: 'Contraction of a method name in an executable API.' },
  fdm: { direction: 'finiteDifference', why: 'Contraction of a method name.' },
  cos: { direction: 'cosineExpansion', why: 'Collides with the trigonometric function.' },
  mtm: { direction: 'markToMarket', why: 'Initialism of a valuation basis.' },
  sim: {
    direction: 'simulation — or MonteCarlo* when that is the exact method',
    why: 'Contraction that also hides which simulation method is meant.',
  },
  approx: { direction: 'approximation, or the verb approximate*', why: 'Truncation.' },
  arb: { direction: 'arbitrage', why: 'Truncation.' },
  perp: { direction: 'perpetual', why: 'Truncation.' },
  evt: { direction: 'extremeValue', why: 'Initialism that also reads as "event".' },
  gpd: { direction: 'generalizedParetoDistribution', why: 'Initialism.' },
  pbo: { direction: 'backtestOverfittingProbability', why: 'Initialism.' },
  adf: { direction: 'augmentedDickeyFuller', why: 'Initialism.' },

  // ---- Risk results ----
  var: {
    direction: 'valueAtRisk',
    why: 'Bare `var` is never the canonical field name; VaR survives only inside operation/type names such as `bookVaR`.',
  },
  cvar: { direction: 'conditionalValueAtRisk', why: 'Same rule as `var`.' },
  ev: { direction: 'expectedValue', why: 'Two-letter contraction.' },
  pop: { direction: 'probabilityOfProfit', why: 'Initialism that reads as the stack operation.' },

  // ---- Argument and structure vocabulary ----
  opts: {
    direction: 'options',
    why: 'Truncation with no benefit; the full word is two characters longer.',
  },
  opt: {
    direction: 'option or options',
    why: 'Truncation that also collides with the derivative.',
  },
  params: { direction: 'parameters', why: 'Truncation.' },
  param: { direction: 'parameter', why: 'Truncation.' },
  ctx: { direction: 'context, or a more exact domain noun', why: 'Truncation.' },
  spec: {
    direction: 'specification — or a stronger noun such as contract or definition',
    why: 'Truncation.',
  },
  fn: {
    direction: 'a role name: objective, predicate, evaluator, ScalarFunction, …',
    why: 'Names the type, not the role it plays.',
  },
  req: { direction: 'request', why: 'Truncation.' },
  res: {
    direction: 'result, response, or a stronger role noun',
    why: 'Truncation that is also ambiguous between result and response.',
  },
  args: { direction: 'arguments', why: 'Truncation.' },
  arg: { direction: 'argument', why: 'Truncation.' },
  cfg: { direction: 'config or configuration', why: 'Truncation.' },

  // ---- Statistics ----
  // `avg` has been forbidden since N0 and `rangeAverage5` still passed: the digit hid it. See
  // `numericSuffixPrefix` in naming-inventory.ts — a denylist entry is only as good as the
  // tokenizer that reaches it.
  avg: { direction: 'average', why: 'Truncation.' },
  std: {
    direction: 'standardDeviation',
    why: 'Truncation that is also ambiguous with standard error.',
  },
  stddev: { direction: 'standardDeviation', why: 'Truncation.' },
  stderr: {
    direction: 'standardError, or the exact rolling/estimate role',
    why: 'Truncation that also collides with the stream name.',
  },
  stats: { direction: 'statistics, or the exact statistic name', why: 'Truncation.' },
  stat: { direction: 'statistic, or the exact statistic name', why: 'Truncation.' },
  tol: {
    direction: 'tolerance — semantically: stepTolerance, residualTolerance',
    why: 'Truncation that also hides WHICH tolerance.',
  },
  iter: { direction: 'iterations', why: 'Truncation.' },
  cov: { direction: 'covariance', why: 'Truncation.' },
  corr: { direction: 'correlation', why: 'Truncation.' },
  coef: { direction: 'coefficient', why: 'Truncation.' },
  mad: {
    direction: 'medianAbsoluteDeviation (math) or rollingMeanAbsoluteDeviation (TA)',
    why: 'Mean-versus-median ambiguity that changes the number.',
  },
  df: {
    direction: 'degreesOfFreedom or discountFactor, selected by meaning',
    why: 'Two unrelated meanings across statistics and fixed income.',
  },
  ci: { direction: 'confidenceInterval', why: 'Initialism.' },
  ci95: { direction: 'confidenceInterval95', why: 'Initialism.' },
  r2: { direction: 'rSquared', why: 'Formula shorthand, not an API name.' },
  zscore: { direction: 'zScore', why: 'Inconsistent casing for a compound term.' },
  ppy: { direction: 'periodsPerYear', why: 'Initialism.' },
  pct: {
    direction: 'fraction, percentage, or percent — after verifying the numeric basis',
    why: 'Hides whether 0.22 or 22 is meant.',
  },
  sq: { direction: 'squared', why: 'Truncation.' },
  inv: { direction: 'inverseCdf', why: 'Truncation that hides which inverse.' },
  sf: { direction: 'survivalFunction', why: 'Initialism.' },

  // ---- General shorthand ----
  meta: { direction: 'metadata', why: 'Truncation.' },
  info: {
    direction: 'information, or a stronger semantic noun',
    why: 'Generic; rarely names the actual role.',
  },
  desc: { direction: 'description', why: 'Truncation that also reads as "descending".' },
  ref: { direction: 'reference', why: 'Truncation.' },
  dim: { direction: 'dimension', why: 'Truncation.' },
  len: { direction: 'length', why: 'Truncation.' },
  prev: { direction: 'previous', why: 'Truncation.' },
  num: {
    direction: 'number or count',
    why: 'Truncation that is also ambiguous between a count and a numeric value.',
  },
  idx: { direction: 'index', why: 'Truncation.' },
  qty: { direction: 'quantity', why: 'Truncation.' },
  px: { direction: 'price', why: 'Trader shorthand, not API vocabulary.' },
  rng: { direction: 'randomNumberGenerator', why: 'Collides with "range".' },
  cum: { direction: 'cumulativeSum', why: 'Library-authored truncation.' },
  diff: { direction: 'difference', why: 'Library-authored truncation.' },
  hist: {
    direction: 'historical or histogram — they are different things',
    why: 'Two meanings in one library.',
  },
  pv: { direction: 'presentValue', why: 'Initialism; canonical PV01 is unaffected.' },
  n: {
    direction: 'count, observations, sampleSize, numberOfPaths, or the exact role',
    why: 'Single letter; legal only as an approved scoped mathematical symbol.',
  },
};

/**
 * Full public names retained verbatim (Law N7). Keyed by the exact identifier, so an approved name
 * short-circuits tokenization entirely — this is how acronym casing such as `VaR` survives without
 * weakening the token rules that protect ordinary fields.
 */
/**
 * Which forbidden tokens each allowlisted NAME actually excuses.
 *
 * An entry in {@link CANONICAL_NAMES} is a claim about a specific published identity — "R² is called
 * R-squared" — and it used to pardon every token in the identifier, so the retired `adj`+`RSquared`
 * rode in on the R² exemption while `adjustedRSquared` already existed as the spelled-out sibling.
 * (Written as a concatenation: a rename sweep rewrote this sentence into the replacement and
 * inverted it, which is the second time that has happened in this file.)
 *
 * RV9 CLOSED THE FAIL-OPEN HALF, and this paragraph described it for one commit longer than it was
 * true. A name ABSENT from this map used to excuse all of its own tokens; it now excuses NOTHING,
 * because `classify` reads `CANONICAL_NAME_TOKENS[name] ?? []`. Forgetting the companion entry is a
 * name that flags, not a name that is silently forgiven. `naming-conformance.test.ts` holds the two
 * key sets in exact correspondence and requires each excuse list to EQUAL the tokens its name is
 * flagged for, so an entry can be neither absent, nor empty, nor padded with tokens that pardon
 * nothing.
 */
export const CANONICAL_NAME_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // ---- RV10: published literal values (see CANONICAL_NAMES) — each excuses only its own token ----
  'ACT/365F': ['f'],
  '30E/360': ['e'],
  'reg-t-naked': ['t'],
  'reg-t-naked-put': ['t'],
  '1m': ['m'],
  '5m': ['m'],
  '15m': ['m'],
  '30m': ['m'],
  '1h': ['h'],
  '4h': ['h'],
  '1d': ['d'],
  CHoCH: ['c'],

  /**
   * EVERY pardoning entry declares its tokens, so a pardon cannot grow.
   *
   * An entry with no declaration excused whatever its name happened to contain — which meant adding
   * a token to the denylist tomorrow would be silently absorbed by all 58 of them, and the new rule
   * would appear to find nothing. The list below freezes each pardon to what was actually reviewed:
   * add `na` to the denylist and `InputNaN` keeps its exemption because it says so, while any name
   * that merely happens to contain it does not.
   *
   * These 58 were generated from what each entry pardoned at the time of declaration, then read: all
   * are single-identity pardons (`sviG` excuses `g`, `williamsR` excuses `r`) except `GannHiLoPoint`
   * and `InputNaN`, whose two tokens are both part of the published name.
   */
  altmanZScore: ['z'],
  NaN: ['n', 'na'],
  rSquaredAbsentReason: ['r'],
  // Stage 4.5 (2026-09-02): the fitted-model objective kind literal `'r-squared'` — R² is the
  // statistic's canonical name (same pardon shape as `'z-score'` and `rSquaredAbsentReason`).
  'r-squared': ['r'],
  // Stage 4.5 slice 3: the fitted-model family literal `'har-rv'` names the HAR-RV model exactly as
  // `fitHarRv` / `HarRvFit` do (Corsi 2009) — same canonical-term pardon, same single token.
  'har-rv': ['rv'],
  tStatisticAbsentReason: ['t'],
  'winsorize-then-z-score': ['z'],
  'z-score': ['z'],
  beneishMScore: ['m'],
  piotroskiFScore: ['f'],
  fScore: ['f'],
  mScore: ['m'],
  CandleZParameters: ['z'],
  CandleZPoint: ['z'],
  CandleZStream: ['z'],
  G2ppDiscountBondInput: ['g'],
  G2ppModel: ['g'],
  G2ppParameters: ['g'],
  GannHiLoPoint: ['hi', 'lo'],
  GannHiLoStream: ['hi', 'lo'],
  HarRvCoefficients: ['rv'],
  HarRvFit: ['rv'],
  // The H24 facade types carry the same model identity (Corsi 2009) as the family above.
  HarRvForecastAssumptions: ['rv'],
  HarRvForecastFacade: ['rv'],
  HarRvOptions: ['rv'],
  InputNaN: ['n', 'na'],
  McGinleyStream: ['mc'],
  PurgedKFoldOptions: ['k'],
  WilliamsRStream: ['r'],
  adjustPValues: ['p'],
  argMin: ['arg'],
  bb: ['bb'],
  bollingerPercentB: ['b'],
  cdlZ: ['z'],
  cos: ['cos'],
  d2f: ['f'],
  d3f: ['f'],
  dDividendYield: ['d'],
  dPeriod: ['d'],
  dRate: ['d'],
  dSpot: ['d'],
  dTimeYears: ['d'],
  dVolatility: ['d'],
  fitHarRv: ['rv'],
  harRvForecast: ['rv'],
  kPeriod: ['k'],
  minButterflyG: ['g'],
  mult: ['mult'],
  pMax: ['p'],
  pValue: ['p'],
  pValues: ['p'],
  percentB: ['b'],
  purgedKFold: ['k'],
  regularizedGammaP: ['p'],
  regulationTRate: ['t'],
  senkouA: ['a'],
  senkouB: ['b'],
  slopeTStatistic: ['t'],
  smoothK: ['k'],
  spanB: ['b'],
  spanBPeriod: ['b'],
  ssviSliceW: ['w'],
  studentT: ['t'],
  sviG: ['g'],
  sviMinG: ['g'],
  tStatistic: ['t'],
  tStatistics: ['t'],
  topK: ['k'],
  topKShare: ['k'],
  williamsR: ['r'],
  zScore: ['z'],
  zSpread: ['z'],

  // The R² identity excuses `r`. It says nothing about `adj`, which has a spelled-out sibling.
  rSquared: ['r'],
  adjustedRSquared: ['r'],
  /**
   * The VaR identity excuses `r`; CVaR additionally excuses `c`. The surrounding role words stand
   * on their own.
   *
   * These two lists were ONE list mapped uniformly to `['r', 'c']`, so nineteen names that contain
   * no `c` at all declared an excuse for one — the comment above said "and `c` in CVaR" while the
   * code said "and `c` in all of them". Inert today, because excusing a token the name does not
   * have pardons nothing; wrong the moment a name in this list acquires a `c` token, at which point
   * it would be pardoned by an entry no one wrote for it. The gate
   * "every excused token actually occurs in the name that excuses it" now holds the split.
   */
  ...Object.fromEntries(
    [
      'BookVaRComponent',
      'BookVaRMethodResult',
      'BookVaROptions',
      'BookVaRPosition',
      'BookVaRResult',
      'HistoricalPortfolioVaRInput',
      'HistoricalPortfolioVaROptions',
      'HistoricalPortfolioVaRResult',
      'MonteCarloPortfolioVaRInput',
      'MonteCarloPortfolioVaRResult',
      'ParametricPortfolioVaRInput',
      'ParametricPortfolioVaROptions',
      'PortfolioVaRInput',
      'PortfolioVaROutput',
      'PortfolioVaRResult',
      'VaRMethod',
      'VaROptions',
      'VaRResult',
      'bookVaR',
      'componentVaR',
      'marginalVaR',
      'portfolioVaR',
      'standaloneVaR',
    ].map((n) => [n, ['r']]),
  ),
  ...Object.fromEntries(['CVaROptimizeOptions', 'CVaROptimizeResult'].map((n) => [n, ['r', 'c']])),
};

export const CANONICAL_NAMES: Readonly<Record<string, string>> = {
  // ---- RV10: PUBLISHED LITERAL VALUES, now that string-literal union members are inventoried ----
  //
  // These are values a caller TYPES, and every one is a name published by someone else — an ISDA
  // day-count convention, an SEC regulation, a charting notation, an interval code. Expanding them
  // would make the library disagree with the domain it models, which is the same argument that keeps
  // `GannHiLo` and `HAR-RV`. Each is keyed by the EXACT literal and excuses only its own flagged
  // token, so none of them widens a rule for anything else.
  'ACT/365F': 'ISDA day-count convention; the trailing `F` is part of the published name (fixed).',
  '30E/360': 'ISDA/ISMA day-count convention (Eurobond); the `E` is part of the published name.',
  'reg-t-naked': 'US SEC Regulation T margin basis; `reg-t` is the regulation, not a truncation.',
  'reg-t-naked-put': 'US SEC Regulation T margin basis for a naked put.',
  '1m': 'Bar-interval code (1 minute) — the vocabulary every market data API publishes.',
  '5m': 'Bar-interval code (5 minutes).',
  '15m': 'Bar-interval code (15 minutes).',
  '30m': 'Bar-interval code (30 minutes).',
  '1h': 'Bar-interval code (1 hour).',
  '4h': 'Bar-interval code (4 hours).',
  '1d': 'Bar-interval code (1 day).',
  CHoCH: 'Change of Character — Smart Money Concepts market-structure event, printed exactly so.',

  // ---- FC2: published fundamental-score model names (each excuses only its own letter) ----
  piotroskiFScore:
    "Piotroski F-Score (Piotroski 2000) — the published model name; F is the score's own letter.",
  fScore: "The F-Score field of the Piotroski result carries the model's published name.",
  altmanZScore: 'Altman Z-Score (Altman 1968) — the published model name.',
  beneishMScore: 'Beneish M-Score (Beneish 1999) — the published model name.',
  mScore: "The M-Score field of the Beneish result carries the model's published name.",
  rSquaredAbsentReason:
    'The reason twin of rSquared (already canonical) — the `r` is the same published statistic.',
  tStatisticAbsentReason:
    'The reason twin of tStatistic (already canonical) — the `t` is the same published statistic.',
  'z-score':
    'The universal name of the standardized score (the zScore identity is already canonical); a literal a caller types.',
  'r-squared':
    "The coefficient of determination's universal name (the rSquared identity is already canonical); a fitted-model objective-kind literal a caller reads and compares.",
  'har-rv':
    'HAR-RV is the model identity (Corsi 2009); the fitted-model family literal spells the model, as fitHarRv does.',
  NaN: "IEEE-754 not-a-number — the language's own spelling (Number.NaN, InputNaN is already pardoned); the Gate B non-finite wrapper must write exactly this literal to round-trip the TA encoding byte-identically.",
  'winsorize-then-z-score': 'A factor-recipe transform literal naming the z-score it applies.',

  // Distributions whose canonical name ends in a bare letter.
  studentT: "Student's t-distribution — the dominant name; expanding the `t` reduces recognition.",
  // IEEE-754 `NaN` is a retained canonical term, but the tokenizer splits the mixed-case acronym
  // into `['na','n']` and the trailing `n` trips the single-letter rule. Record the exemption on
  // the whole name rather than weakening the `n` rule that protects real count-like fields.
  InputNaN: 'IEEE-754 NaN is canonical; the mixed-case acronym does not tokenize cleanly.',
  // `mc` expands to `monteCarlo` (above), and the 3B.N sweep applied that to a SURNAME: John R.
  // McGinley's indicator shipped as `MonteCarloGinleyStream`, with the fictional
  // "MonteCarloGinley Dynamic" in the alias table — so the real name failed to resolve while the
  // invented one did. The exemption belongs on the whole identifier: `Mc` here is a Scottish
  // patronymic prefix, not the monte-carlo contraction, and no token rule can tell those apart.
  McGinleyStream:
    'McGinley Dynamic is named for John R. McGinley; `Mc` is a surname prefix, not the `mc` ' +
    'monte-carlo contraction that the forbidden-token rule targets.',

  // ---- HAR-RV: the model's NAME, not an abbreviation of one of its words (Law N7) ----
  // Corsi (2009) named the Heterogeneous AutoRegressive model of Realized Volatility "HAR-RV", and
  // that string is what a user searches, what the papers print, and what every other library calls
  // it. `HarRealizedVolatility` is not a longer way of writing it — it is a different, unfindable
  // name. `rv` remains forbidden everywhere else, including inside this model's own fields.
  // ---- TA-Lib / pandas-ta spellings, exported for import ergonomics beside `stoch` and `willr` ----
  // NAME entries, deliberately: allowlisting the TOKEN `bb` would exempt `bbPeriod`, `bbWidth` and
  // `lowerBB` along with it, which is the blanket exemption that let this whole family through. Same
  // rule the HAR-RV block below states — the identity is canonical, its parts are not.
  bb: 'TA-Lib/pandas-ta spelling of `bbands`, exported so the name a user reaches for first resolves.',
  // Gann High-Low Activator — the published indicator name. NAME entries, because the tokenizer
  // splits it to `['gann','hi','lo','point']`: a `gannhilo` TOKEN entry matches nothing, and a `hi`
  // or `lo` token entry would have exempted `hiBody`/`loBody` too. Exact, or it is not a rationale.
  GannHiLoPoint: 'Gann High-Low Activator is the published indicator name, searchable as written.',
  GannHiLoStream: 'Gann High-Low Activator is the published indicator name, searchable as written.',
  mult: 'TA-Lib `MULT` operator identity; the elementwise product, not a truncation of "multiplier".',

  // ---- RV7 batch 4: published mathematical and financial notation ----
  // Every entry is a NAME, never a token. A `r`/`k`/`d`/`z` token entry would exempt any compound
  // containing that letter — which is the blanket exemption that produced this queue. Each of these
  // is the name the literature prints; expanding it would make the identifier unfindable, which is
  // the carve-out Law N7 already states for HAR-RV.
  BookVaRComponent:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  BookVaRMethodResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  BookVaROptions:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  BookVaRPosition:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  BookVaRResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  CVaROptimizeOptions:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  CVaROptimizeResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  HistoricalPortfolioVaRInput:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  HistoricalPortfolioVaROptions:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  HistoricalPortfolioVaRResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  PortfolioVaRInput:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  PortfolioVaROutput:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  MonteCarloPortfolioVaRInput:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  MonteCarloPortfolioVaRResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  ParametricPortfolioVaRInput:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  ParametricPortfolioVaROptions:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  PortfolioVaRResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  VaRMethod:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  VaROptions:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  VaRResult:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  bookVaR:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  componentVaR:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  marginalVaR:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  portfolioVaR:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  standaloneVaR:
    "Value-at-Risk. `VaR` and `CVaR` are the regulatory and academic spelling \u2014 Basel, every risk text, every other library. Expanding to `valueAtRisk` makes the name unfindable, which is Law N7's own carve-out.",
  adjustedRSquared:
    'R-squared is the universal name of the coefficient of determination; `rSquared` IS the expansion of R\u00b2.',
  rSquared:
    'R-squared is the universal name of the coefficient of determination; `rSquared` IS the expansion of R\u00b2.',
  adjustPValues:
    "The p-value is the standard statistical term; `p` here is the quantity's name, not an abbreviation of one.",
  pMax: "The p-value is the standard statistical term; `p` here is the quantity's name, not an abbreviation of one.",
  pValue:
    "The p-value is the standard statistical term; `p` here is the quantity's name, not an abbreviation of one.",
  pValues:
    "The p-value is the standard statistical term; `p` here is the quantity's name, not an abbreviation of one.",
  WilliamsRStream: 'TA-Lib / pandas-ta indicator identity, searchable as written.',
  williamsR: 'TA-Lib / pandas-ta indicator identity, searchable as written.',
  regularizedGammaP:
    'The regularized incomplete gamma function P (its counterpart is Q) \u2014 standard mathematical notation.',
  dPeriod: 'Stochastic oscillator %K and %D: the published parameter names of the indicator.',
  kPeriod: 'Stochastic oscillator %K and %D: the published parameter names of the indicator.',
  smoothK: 'Stochastic oscillator %K and %D: the published parameter names of the indicator.',
  senkouA: 'Ichimoku Senkou Span A/B \u2014 the published component names of the cloud.',
  senkouB: 'Ichimoku Senkou Span A/B \u2014 the published component names of the cloud.',
  spanB: 'Ichimoku Senkou Span A/B \u2014 the published component names of the cloud.',
  spanBPeriod: 'Ichimoku Senkou Span A/B \u2014 the published component names of the cloud.',
  bollingerPercentB: 'Bollinger %B \u2014 the published indicator output name.',
  percentB: 'Bollinger %B \u2014 the published indicator output name.',
  dDividendYield:
    'A finite INCREMENT of the named coordinate — `d` + subject, the Taylor-expansion spelling for a realized change (dS, dSigma, dt). NOT a partial derivative: `PnlMove` documents itself as a realized market move t0 -> t1, and the first version of this rationale said "partial derivative", describing the wrong quantity while the names themselves were right. An allowlist entry whose stated reason misdescribes the field is backed by nothing.',
  dRate:
    'A finite INCREMENT of the named coordinate — `d` + subject, the Taylor-expansion spelling for a realized change (dS, dSigma, dt). NOT a partial derivative: `PnlMove` documents itself as a realized market move t0 -> t1, and the first version of this rationale said "partial derivative", describing the wrong quantity while the names themselves were right. An allowlist entry whose stated reason misdescribes the field is backed by nothing.',
  dSpot:
    'A finite INCREMENT of the named coordinate — `d` + subject, the Taylor-expansion spelling for a realized change (dS, dSigma, dt). NOT a partial derivative: `PnlMove` documents itself as a realized market move t0 -> t1, and the first version of this rationale said "partial derivative", describing the wrong quantity while the names themselves were right. An allowlist entry whose stated reason misdescribes the field is backed by nothing.',
  dTimeYears:
    'A finite INCREMENT of the named coordinate — `d` + subject, the Taylor-expansion spelling for a realized change (dS, dSigma, dt). NOT a partial derivative: `PnlMove` documents itself as a realized market move t0 -> t1, and the first version of this rationale said "partial derivative", describing the wrong quantity while the names themselves were right. An allowlist entry whose stated reason misdescribes the field is backed by nothing.',
  dVolatility:
    'A finite INCREMENT of the named coordinate — `d` + subject, the Taylor-expansion spelling for a realized change (dS, dSigma, dt). NOT a partial derivative: `PnlMove` documents itself as a realized market move t0 -> t1, and the first version of this rationale said "partial derivative", describing the wrong quantity while the names themselves were right. An allowlist entry whose stated reason misdescribes the field is backed by nothing.',
  d2f: 'The second and third derivatives of the solver objective `f`, in the notation the Halley/Householder literature prints.',
  d3f: 'The second and third derivatives of the solver objective `f`, in the notation the Halley/Householder literature prints.',
  minButterflyG:
    "Gatheral's `g` function \u2014 the butterfly-arbitrage density test names it, and the papers print `g`.",
  sviG: "Gatheral's `g` function \u2014 the butterfly-arbitrage density test names it, and the papers print `g`.",
  sviMinG:
    "Gatheral's `g` function \u2014 the butterfly-arbitrage density test names it, and the papers print `g`.",
  ssviSliceW: 'SSVI total variance `w` \u2014 the slice quantity SVI/SSVI papers name `w(k)`.',
  G2ppDiscountBondInput:
    'G2++ is the published name of the two-factor Gaussian short-rate model (Brigo-Mercurio).',
  G2ppModel:
    'G2++ is the published name of the two-factor Gaussian short-rate model (Brigo-Mercurio).',
  G2ppParameters:
    'G2++ is the published name of the two-factor Gaussian short-rate model (Brigo-Mercurio).',
  CandleZParameters:
    "The z-score and the Z-spread: `z` is the quantity's published name in statistics and fixed income.",
  CandleZPoint:
    "The z-score and the Z-spread: `z` is the quantity's published name in statistics and fixed income.",
  CandleZStream:
    "The z-score and the Z-spread: `z` is the quantity's published name in statistics and fixed income.",
  cdlZ: "The z-score and the Z-spread: `z` is the quantity's published name in statistics and fixed income.",
  zScore:
    "The z-score and the Z-spread: `z` is the quantity's published name in statistics and fixed income.",
  zSpread:
    "The z-score and the Z-spread: `z` is the quantity's published name in statistics and fixed income.",
  PurgedKFoldOptions:
    "k-fold cross-validation and top-K selection \u2014 `k` is the parameter's name in the literature, not a truncation.",
  purgedKFold:
    "k-fold cross-validation and top-K selection \u2014 `k` is the parameter's name in the literature, not a truncation.",
  topK: "k-fold cross-validation and top-K selection \u2014 `k` is the parameter's name in the literature, not a truncation.",
  topKShare:
    "k-fold cross-validation and top-K selection \u2014 `k` is the parameter's name in the literature, not a truncation.",

  fitHarRv: 'HAR-RV is the model identity (Corsi 2009); expanding `Rv` renames the model.',
  harRvForecast: 'HAR-RV is the model identity (Corsi 2009); expanding `Rv` renames the model.',
  HarRvForecastAssumptions:
    'HAR-RV is the model identity (Corsi 2009); the H24 facade types carry the family name.',
  HarRvForecastFacade:
    'HAR-RV is the model identity (Corsi 2009); the H24 facade types carry the family name.',
  HarRvFit: 'HAR-RV is the model identity (Corsi 2009); expanding `Rv` renames the model.',
  HarRvOptions: 'HAR-RV is the model identity (Corsi 2009); expanding `Rv` renames the model.',
  HarRvCoefficients: 'HAR-RV is the model identity (Corsi 2009); expanding `Rv` renames the model.',

  // ---- The TA-Lib trigonometric transforms ----
  // These ARE `Math.cos`/`Math.acos` exposed as indicators under TA-Lib's own function identities
  // (`COS`, `ACOS`). The `cos` rule exists because the Heston COS *pricing method* collides with the
  // trigonometric function — and this side of that collision is the trigonometric function. The
  // pricing method is the one that expands, to `cosineExpansion`.
  cos: 'TA-Lib indicator identity `COS` — the trigonometric function itself, not the COS pricing method.',

  // ---- `argmin`: one word in optimization, not `arg` + `min` ----
  // Every optimization text writes `argmin f(x)`; `minimizingArgument` is a paraphrase, not the
  // name. The `arg` rule still holds for `args`/`arg` as a stand-in for "arguments".
  argMin: 'The optimization term `argmin` — one word, universally written this way.',

  // ---- The t-statistic ----
  // Its `t` is Student's t, the same canonical distribution identity already retained as
  // `studentT`. Expanding it to `studentTStatistic` reads as a different quantity than the one
  // every regression table prints.
  tStatistic: "Student's t-statistic — the canonical name; the `t` names the distribution.",
  tStatistics: "Student's t-statistics — the canonical name; the `t` names the distribution.",
  slopeTStatistic: "The slope's Student's t-statistic — canonical regression vocabulary.",

  // ---- Regulation T ----
  // `regTRate` reads as a bare `t` to the tokenizer; the `T` is the NAME of the US margin rule
  // (Federal Reserve Regulation T), so there is nothing to expand.
  regulationTRate: 'Federal Reserve Regulation T — the `T` is the regulation’s name.',
};

/**
 * Tokens that survive anywhere because they are universal technology, market, finance, or model
 * vocabulary. These are NOT truncations a caller must decode — they are the dominant industry term.
 */
export const CANONICAL_TOKENS: Readonly<Record<string, string>> = {
  // Stage 4.6 slice 5 (2026-09-04): an instrument-kind literal of the portfolio engine.
  etf: "Exchange-traded fund — the market's own name for the instrument kind ('etf' beside 'equity', 'option', 'future'); never expanded in practice.",
  // ---- RV10: short tokens inside published literal VALUES ----
  act: 'ACT day-count family (ACT/360, ACT/365F, ACT/ACT) — the ISDA convention name.',
  aqi: "Beneish (1999) Asset Quality Index — the paper's own component acronym (component 'AQI').",
  gmi: "Beneish (1999) Gross Margin Index — the paper's own component acronym (component 'GMI').",
  sgi: "Beneish (1999) Sales Growth Index — the paper's own component acronym (component 'SGI').",
  gtc: 'Good-Til-Cancelled — FIX TimeInForce vocabulary (tag 59).',
  frn: 'Floating Rate Note — the standard bond-kind abbreviation.',
  pwm: 'Probability-Weighted Moments — the published GPD/EVT estimator, beside `mle`.',
  pip: "Percentage In Point — the FX market's own name for the minimum quote increment (pipValue, pipSize); 'point' alone names a DIFFERENT quantity (forward points).",
  hex: 'Hexadecimal — the universal name for base-16 text (sha256Hex); expanding it reduces recognition.',
  // Stage 7A slice 3 (2026-09-03): the local transport package and its domain name.
  cli: 'Command-Line Interface — the package name (@totalfinance/cli) and the universal initialism for the terminal front door; expanding it reduces recognition.',
  vnd: "IANA vendor-tree media-type element, verbatim in 'application/vnd.apache.arrow.file' — a registered identifier, not a coinage.",
  ct: "Augmented Dickey-Fuller regression specification (constant + trend), beside `'c'` and `'n'`.",
  bos: 'Break of Structure — Smart Money Concepts market-structure event.',
  hh: 'Higher High — market-structure swing label, beside `HL`/`LH`/`LL`.',
  hl: 'Higher Low — market-structure swing label.',
  lh: 'Lower High — market-structure swing label.',
  ll: 'Lower Low — market-structure swing label.',
  yin: 'Kagi chart line state (yin = thin/falling, yang = thick/rising) — the published charting term.',
  mom: 'TA-Lib MOM operator identity — the momentum difference.',

  // Technology / protocol
  api: 'Universal.',
  id: 'Universal.',
  url: 'Universal.',
  uri: 'Universal.',
  json: 'Universal.',
  html: 'Universal.',
  iso: 'Universal.',
  utc: 'Universal.',
  sdk: 'Universal.',
  mcp: 'Protocol name.',
  esm: 'Universal.',
  wasm: 'Universal.',
  ieee: 'Universal.',
  nan: 'IEEE-754 term.',
  ok: 'Universal.',
  // Market / security identifiers
  occ: 'Options Clearing Corporation symbology.',
  cboe: 'Exchange.',
  nyse: 'Exchange.',
  cusip: 'Security identifier.',
  isin: 'Security identifier.',
  // Finance
  pnl: 'Dominant readable finance term.',
  atm: 'Dominant moneyness term.',
  itm: 'Dominant moneyness term.',
  otm: 'Dominant moneyness term.',
  ohlc: 'Dominant bar term.',
  ohlcv: 'Dominant bar term.',
  vwap: 'Dominant execution/indicator term.',
  fx: 'Dominant market term.',
  cds: 'Dominant credit term.',
  fra: 'Dominant rates term.',
  ois: 'Dominant rates term.',
  cms: 'Dominant rates term.',
  oas: 'Dominant credit term.',
  xva: 'Dominant valuation-adjustment family.',
  cva: 'Valuation adjustment.',
  dva: 'Valuation adjustment.',
  fva: 'Valuation adjustment.',
  ctd: 'Cheapest-to-deliver.',
  gex: 'Dominant flow term.',
  dex: 'Dominant flow term.',
  tips: 'Inflation-linked security.',
  cagr: 'Dominant performance term.',
  npv: 'Dominant valuation term.',
  irr: 'Dominant valuation term.',
  nav: 'Dominant fund term.',
  eod: 'Dominant session term.',
  // Named models and methods
  sabr: 'Model.',
  svi: 'Model.',
  ssvi: 'Model.',
  essvi: 'Model.',
  garch: 'Model.',
  har: 'Model.',
  pca: 'Method.',
  ols: 'Method.',
  bfgs: 'Method.',
  svd: 'Method.',
  lu: 'Method.',
  qr: 'Method.',
  cdf: 'Distribution function.',
  pdf: 'Distribution function.',
  pde: 'Method.',
  rmse: 'Error metric.',
  mse: 'Error metric.',
  mae: 'Error metric.',
  kpss: 'Test.',
  hac: 'Estimator.',
  ewma: 'Estimator.',
  crr: 'Cox-Ross-Rubinstein lattice.',
  heston: 'Model.',
  bachelier: 'Model.',
  dupire: 'Model.',
  // Indicator identities backed by a dominant industry name or TA-Lib compatibility
  rsi: 'Dominant indicator identity.',
  macd: 'Dominant indicator identity.',
  atr: 'Dominant indicator identity.',
  adx: 'Dominant indicator identity.',
  obv: 'Dominant indicator identity.',
  cci: 'Dominant indicator identity.',
  mfi: 'Dominant indicator identity.',
  sma: 'Dominant indicator identity.',
  ema: 'Dominant indicator identity.',
  wma: 'Dominant indicator identity.',
  dema: 'Dominant indicator identity.',
  tema: 'Dominant indicator identity.',
  trix: 'Dominant indicator identity.',
  ppo: 'Dominant indicator identity.',
  apo: 'Dominant indicator identity.',
  kama: 'Dominant indicator identity.',
  mama: 'Dominant indicator identity.',
  sar: 'Dominant indicator identity.',
  aroon: 'Dominant indicator identity.',
  natr: 'Dominant indicator identity.',
  roc: 'Dominant indicator identity.',
  bbands: 'Dominant indicator identity.',
  stoch: 'Dominant indicator identity.',
  willr: 'Dominant indicator identity.',
  vfi: 'Dominant indicator identity.',
  adl: 'Dominant indicator identity.',
  cmf: 'Dominant indicator identity.',
  // ---- RV9: published identities among the previously unclassified short tokens ----
  div: 'TA-Lib DIV operator identity - the elementwise quotient.',
  sub: 'TA-Lib SUB operator identity - the elementwise difference, exported beside `div`/`mult`.',
  dm: 'Wilder Directional Movement (+DM/-DM) identity.',
  dsp: 'Detrended Synthetic Price (Ehlers) identity.',
  ene: 'Expected negative exposure - the counterparty-risk term paired with `epe`.',
  eta: 'The Greek letter eta, a G2++ volatility parameter as the model writes it.',
  exp: 'TA-Lib EXP operator identity - the elementwise exponential.',
  ext: 'The TA-Lib extended-variant suffix, as in MACDEXT.',
  ids: 'Plural of id, an ordinary public word.',
  im: 'The imaginary part of a complex number, as mathematics writes it.',
  po: 'Price Oscillator identity.',
  re: 'The real part of a complex number, as mathematics writes it.',
  xs: 'The sample abscissae of an interpolator - conventional x/y sample naming.',
  ys: 'The sample ordinates of an interpolator - conventional x/y sample naming.',
  acf: 'Autocorrelation function - standard time-series notation.',
  ad: 'TA-Lib Accumulation/Distribution line identity.',
  af: 'Parabolic SAR acceleration factor - the published parameter name.',
  bop: 'TA-Lib Balance of Power indicator identity.',
  bp: 'Basis point - universal fixed-income unit.',
  bps: 'Basis points - universal fixed-income unit.',
  cdl: 'TA-Lib candlestick-pattern prefix (CDL*), searchable as written.',
  cfo: 'Chande Forecast Oscillator identity.',
  chi: 'Chi-squared, as the distribution is written.',
  cir: 'Cox-Ingersoll-Ross short-rate model identity.',
  cmo: 'Chande Momentum Oscillator identity.',
  cpi: 'Consumer Price Index - the published series name.',
  cpr: 'Central Pivot Range indicator identity.',
  cti: 'Correlation Trend Indicator identity.',
  cvd: 'Cumulative Volume Delta identity.',
  dc: 'Donchian Channel / dominant cycle, per the indicator it names.',
  di: 'Directional Indicator (+DI/-DI), Wilder identity.',
  dmi: 'Directional Movement Index, Wilder identity.',
  dpo: 'Detrended Price Oscillator identity.',
  dx: 'Directional Movement Index DX, Wilder identity.',
  efi: 'Elder Force Index identity.',
  emv: 'Ease of Movement identity.',
  eom: 'End of month - standard date-roll convention.',
  epe: 'Expected positive exposure - standard counterparty-risk term.',
  fib: 'Fibonacci, as every charting package prints it.',
  fvg: 'Fair Value Gap - the published price-action term.',
  gbm: 'Geometric Brownian motion.',
  gt: 'Greater-than comparison operator.',
  gte: 'Greater-than-or-equal comparison operator.',
  hhi: 'Herfindahl-Hirschman Index - the published concentration measure.',
  hma: 'Hull Moving Average identity.',
  hrp: 'Hierarchical Risk Parity (Lopez de Prado) identity.',
  ht: 'Hilbert Transform - the TA-Lib HT_* family identity.',
  jma: 'Jurik Moving Average identity.',
  kdj: 'KDJ oscillator identity.',
  kst: 'Know Sure Thing (Pring) identity.',
  kvo: 'Klinger Volume Oscillator identity.',
  lm: 'Levenberg-Marquardt optimizer identity.',
  ln: 'Natural logarithm, as mathematics writes it.',
  lt: 'Less-than comparison operator.',
  lte: 'Less-than-or-equal comparison operator.',
  mle: 'Maximum likelihood estimation.',
  ms: 'Milliseconds - the unit suffix this library uses throughout.',
  msw: 'Mesa Sine Wave identity.',
  mu: 'The Greek letter mu, the drift parameter as every SDE writes it.',
  nvi: 'Negative Volume Index identity.',
  oco: 'One-cancels-other - the standard order type.',
  orb: 'Opening Range Breakout - the published strategy name.',
  osc: 'Oscillator, as indicator names print it.',
  ou: 'Ornstein-Uhlenbeck process identity.',
  pgo: 'Pretty Good Oscillator identity.',
  pnf: 'Point and Figure charting identity.',
  poc: 'Point of Control - the published market-profile term.',
  pp: 'Pivot Point identity.',
  psd: 'Power spectral density.',
  psi: 'Population Stability Index.',
  pvi: 'Positive Volume Index identity.',
  pvo: 'Percentage Volume Oscillator identity.',
  pvt: 'Price Volume Trend identity.',
  totalfinance: 'The library own namespace prefix.',
  qqe: 'Quantitative Qualitative Estimation identity.',
  rma: 'Wilder running moving average (RMA) identity.',
  rsx: 'Jurik RSX identity.',
  rvi: 'Relative Vigor / Volatility Index identity.',
  sin: 'Sine, as mathematics writes it.',
  smc: 'Smart Money Concepts - the published price-action family.',
  smi: 'Stochastic Momentum Index identity.',
  sr: 'Sharpe ratio / support-resistance, per the scope it names.',
  ss: 'xoshiro128** ("ss" = star-star) PRNG variant identity — the published algorithm name. NOT the\n    Super Smoother filter, which an earlier version of this rationale claimed: measured against the\n    surface, `ss` excused exactly one identity, `xoshiro128ss`, and no Ehlers filter anywhere.',
  stc: 'Schaff Trend Cycle identity.',
  svg: 'Scalable Vector Graphics - the output format.',
  tau: 'The Greek letter tau, time to maturity as the literature writes it.',
  td: 'Tom DeMark indicator-family identity.',
  tos: 'Thinkorswim - the external platform whose spelling is being matched.',
  tsf: 'Time Series Forecast identity.',
  tsi: 'True Strength Index identity.',
  ttm: 'TTM Squeeze - the published indicator name.',
  usd: 'The ISO 4217 currency code.',
  vi: 'Vortex Indicator identity.',
  vw: 'Volume-weighted, as VWAP/VWMA print it.',
  wcp: 'Weighted Close Price identity.',
  ymd: 'Year-month-day - the date-tuple convention.',
  zag: 'Zig Zag indicator identity.',
  zig: 'Zig Zag indicator identity.',
  t3: 'TA-Lib T3 indicator identity.',
  pv01: 'Universal fixed-income sensitivity name.',
  dv01: 'Universal fixed-income sensitivity name.',
};

/**
 * Ordinary short words that are already public vocabulary. This policy does not expand a word
 * merely because it is short (Law N7's closing rule).
 */
export const ORDINARY_TOKENS: readonly string[] = [
  // Stage 7A (2026-09-03): a JOB is a long-running operation run under the worker-terminated
  // runner (`costClass: 'job'`, a `'job'` resource handle) — an ordinary English word.
  'job',
  // FC7 (2026-08-28): a tax LOT is the unit of cost-basis accounting (`portfolio.lot_unavailable`,
  // `lotRelief`) — an ordinary English word, not a truncation.
  'lot',
  // FC7 slice 2 (2026-08-28): the `tag` grouping dimension — caller-supplied instrument tags; an
  // ordinary English word, not a truncation.
  'tag',
  'am',
  'pm',
  'law',
  'off',
  'tax',
  'pre',
  // ---- RV9: short tokens that were classified by NOTHING ----
  // A name with no denylisted token was called `explicit`, so 203 one-to-three-character tokens had
  // never been reviewed — they were merely unrecognized. These are the ordinary English words among
  // them; the published identities went to CANONICAL_TOKENS and the truncations to FORBIDDEN_TOKENS.
  'add',
  'ago',
  'all',
  'and',
  'any',
  'at',
  'bar',
  'be',
  'bet',
  'bin',
  'box',
  'buy',
  'by',
  'can',
  'cap',
  'day',
  'end',
  'ex',
  'far',
  'fat',
  'fee',
  'few',
  'fit',
  'fix',
  'gap',
  'get',
  'has',
  'hit',
  'if',
  'ill',
  'for',
  'in',
  'is',
  'its',
  'key',
  'kit',
  'lag',
  'leg',
  'log',
  'low',
  'map',
  'mat',
  'net',
  'new',
  'no',
  'non',
  'not',
  'now',
  'nth',
  'odd',
  'on',
  'one',
  'or',
  'out',
  'own',
  'par',
  'pay',
  'per',
  'pin',
  'pro',
  'put',
  'raw',
  'ray',
  'row',
  'run',
  'set',
  'tan',
  'the',
  'tie',
  'to',
  'too',
  'top',
  'two',
  'up',
  'us',
  'use',
  'via',
  'win',
  'config',
  'min',
  'max',
  'bid',
  'ask',
  'mid',
  'spot',
  'type',
  'kind',
  'side',
  'as',
  'of',
  'value',
  'price',
  'strike',
  'size',
  'count',
  'sum',
  'mean',
  'median',
  'mode',
  'rank',
  'step',
];

/**
 * Mathematical and model symbols that may remain INSIDE a named scope (Law N8 / the
 * context-scoped-symbols section). The key is the owning public type or callable id; the same
 * symbol outside that scope expands.
 */
export interface ScopedSymbolRule {
  symbols: readonly string[];
  rationale: string;
}

/**
 * `x` on a dedicated CDF / density / survival function is the distribution COORDINATE — the one
 * place the bare letter is the clearest thing to write, because the method name already says what
 * is being evaluated. Listed by hand (never derived from the live surface) so adding a distribution
 * is a deliberate ruling, not an automatic pass.
 */
const DISTRIBUTION_COORDINATES = [
  '@totalfinance/math:normal.cdf',
  '@totalfinance/math:normal.pdf',
  '@totalfinance/math:normal.survivalFunction',
  '@totalfinance/math:normal.logCdf',
  '@totalfinance/math:normal.logPdf',
  '@totalfinance/math:normal.logSurvivalFunction',
  '@totalfinance/math:normalSurvivalFunction',
  '@totalfinance/math:normalLogCdf',
  '@totalfinance/math:normalLogPdf',
  '@totalfinance/math:normalLogSurvivalFunction',
  '@totalfinance/math:studentT.cdf',
  '@totalfinance/math:studentT.pdf',
  '@totalfinance/math:studentT.survivalFunction',
  '@totalfinance/math:chiSquare.cdf',
  '@totalfinance/math:gamma.cdf',
];

const distributionCoordinateScopes: Record<string, ScopedSymbolRule> = Object.fromEntries(
  DISTRIBUTION_COORDINATES.map((scope) => [
    scope,
    {
      symbols: ['x'],
      rationale: 'Distribution coordinate on a dedicated CDF / density / survival.',
    },
  ]),
);

export const SCOPED_SYMBOLS: Readonly<Record<string, ScopedSymbolRule>> = {
  /**
   * RV11 — AMBIGUOUS LITERAL VALUES BELONG TO THEIR OWNER, NOT TO THE SPELLING.
   *
   * RV10 recorded these in the global CANONICAL_NAMES map, which `classify` consults BEFORE any
   * scope. That works today and rots tomorrow: a future literal — or an exact public identifier —
   * spelled `c` or `info` would silently inherit a rationale written about econometrics or logging.
   * A pardon attaching to a spelling rather than a meaning is the same defect as `ar` and `tc`,
   * caught here before it had a victim rather than after.
   *
   * Scoped to the union or parameter that owns the value, so the reason travels with the thing it
   * describes and cannot be borrowed by anything else.
   */
  'AugmentedDickeyFullerOptions.regression': {
    symbols: ['c'],
    rationale:
      "ADF regression specification: `'c'` is constant-only, beside `'ct'`, `'ctt'` and `'n'` — the econometrics vocabulary (statsmodels).",
  },
  'augmentedDickeyFullerTest(options).regression': {
    symbols: ['c'],
    rationale: "ADF regression specification; `'c'` is constant-only (statsmodels vocabulary).",
  },
  'KpssOptions.regression': {
    symbols: ['c'],
    rationale: "KPSS regression specification; `'c'` is constant-only (statsmodels vocabulary).",
  },
  'kpssTest(options).regression': {
    symbols: ['c'],
    rationale: "KPSS regression specification; `'c'` is constant-only (statsmodels vocabulary).",
  },
  'PnfColumn.kind': {
    symbols: ['O', 'X'],
    rationale:
      'Point & Figure column notation: an `X` column is rising, an `O` column falling (Cohen). The chart type is these two letters.',
  },
  // Stage 7A slice 5 (2026-09-03): the OpenAPI document reproduces the specification's own
  // top-level object names; `info` is mandated by OpenAPI 3.1 (`openapi`, `info`, `paths`, …).
  OpenApiDocument: {
    symbols: ['info'],
    rationale:
      "OpenAPI 3.1's mandatory top-level `info` object — the specification's field name, reproduced verbatim so the generated document validates against OpenAPI.",
  },
  WarningSeverity: {
    symbols: ['info'],
    rationale:
      'Log-severity vocabulary (`info`/`warn`/`error`) — the published term, not a truncation of "information".',
  },
  'warning(severity)': {
    symbols: ['info'],
    rationale: 'Log-severity vocabulary (`info`/`warn`/`error`).',
  },

  ...distributionCoordinateScopes,
  SabrParameters: {
    symbols: ['alpha', 'beta', 'rho', 'nu'],
    rationale:
      'SABR literature parameters; the owning type names the model and the docs define each symbol.',
  },
  HestonParameters: {
    symbols: ['kappa', 'theta', 'sigma', 'rho', 'v0'],
    rationale: 'Heston literature parameters; the owning type names the model.',
  },
  SVIParameters: {
    symbols: ['a', 'b', 'rho', 'm', 'sigma'],
    rationale: 'SVI raw parameterization; canonical in the literature.',
  },
  // Stage 4.5: the SVI warm start names the SAME canonical parameter (the outer search runs over
  // `(m, σ)`); a start called anything else would be a second name for one thing.
  SVIWarmStart: {
    symbols: ['m'],
    rationale:
      'The SVI warm start pins the canonical `m` (and `sigma`) the outer search runs over.',
  },
  SSVIParameters: {
    symbols: ['theta', 'rho', 'phi', 'a', 'b', 'm', 'sigma'],
    rationale: 'SSVI canonical parameters.',
  },
  ESSVIParameters: {
    symbols: ['theta', 'rho', 'phi', 'a', 'b', 'm', 'sigma'],
    rationale: 'eSSVI canonical parameters.',
  },
  // `RateCurvePoint` no longer needs the generic-`rate` exception: the pillar field is `zeroRate`
  // (renamed 2026-08-23, second external review — the semantics are explicitly zero-rate-quoted,
  // `curves.fromZeroRates` semantics, so the name now states the role itself).
  // The generic-`rate` exception, applied to the bootstrap instruments. A deposit's rate is its deposit rate,
  // an FRA's is its FRA rate, a swap's is its par swap rate — the instrument type IS the role, and
  // `DepositInstrument.depositRate` would only repeat what the type already said. These are par /
  // quoted rates, NOT risk-free rates: expanding them to `riskFreeRate` would be a lie, which is the
  // trap law N3 (semantic, never string, expansion) exists to catch.
  DepositInstrument: {
    symbols: ['rate'],
    rationale: 'A deposit instrument names the role of its own quoted rate.',
  },
  FraInstrument: {
    symbols: ['rate'],
    rationale: 'An FRA names the role of its own quoted rate.',
  },
  SwapInstrument: {
    symbols: ['rate'],
    rationale: 'A swap instrument names the role of its own par rate.',
  },
  BootstrapInstrument: {
    symbols: ['rate'],
    rationale: 'The bootstrap-instrument union; each member names the role of its quoted rate.',
  },
  FlatCurveInput: {
    symbols: ['rate'],
    rationale: 'A flat curve is defined BY one rate; the input type supplies the role.',
  },
  CirParameters: {
    symbols: ['a', 'b'],
    rationale:
      'CIR literature parameters (`dr = a(b − r)dt + σ√r dW`); the owning type names the model and the docs define each symbol.',
  },
  G2ppParameters: {
    symbols: ['a', 'b'],
    rationale: 'G2++ mean-reversion speeds of the two factors; canonical in the literature.',
  },
  G2ppDiscountBondInput: {
    symbols: ['x', 'y'],
    rationale: 'G2++ state variables `x` and `y`; canonical in the literature.',
  },
  VasicekParameters: {
    symbols: ['a', 'b'],
    rationale:
      'Vasicek literature parameters (`dr = a(b − r)dt + σ dW`); the owning type names the model.',
  },
  HullWhiteParameters: {
    symbols: ['a'],
    rationale:
      'Hull-White mean-reversion speed `a`; the owning type names the model. A specification object that merely CARRIES it names the role instead (`meanReversion`).',
  },
  // `A = Q·R` and the `f, df, d²f, d³f` derivative cluster: the sibling names make the notation
  // self-evident, and expanding one letter of a written formula reads worse than keeping all of it.
  QrResult: {
    symbols: ['q', 'r'],
    rationale: 'QR decomposition `A = Q·R`; the factor letters ARE the contract.',
  },
  Derivatives: {
    symbols: ['f', 'df'],
    rationale:
      'The `f, df, d²f, d³f` derivative cluster at a point; the siblings define the notation.',
  },
  KalmanModel: {
    symbols: ['F', 'H', 'Q', 'R'],
    rationale:
      'Kalman filter matrices (transition `F`, observation `H`, process noise `Q`, measurement noise `R`); universal in the literature and in every reference implementation.',
  },
  SvdResult: {
    symbols: ['u', 's', 'v'],
    rationale: 'Singular value decomposition `A = U·S·Vᵀ`; the factor letters ARE the contract.',
  },
  // The KDJ indicator IS its three lines: `%K`, `%D`, and the derived `J`. Expanding them would
  // rename the indicator out of its own vocabulary (Law N7, canonical-term allowlist). The same
  // holds for the stochastic oscillator's `%K`/`%D`.
  KdjPoint: {
    symbols: ['k', 'd', 'j'],
    rationale: 'The KDJ indicator names its own output lines `%K`, `%D`, `J`.',
  },
  'KdjStream.value': {
    symbols: ['k', 'd', 'j'],
    rationale: 'The KDJ indicator names its own output lines `%K`, `%D`, `J`.',
  },
  // A bivariate statistical sample: `x` (predictor) and `y` (response) are the canonical coordinate
  // names, and the owning `Pair`/`pairs` identity supplies the role — the same case as `normalCdf(x)`.
  StochasticPoint: {
    symbols: ['k', 'd'],
    rationale: 'The stochastic oscillator names its own output lines `%K` and `%D`.',
  },
  'StochasticStream.value': {
    symbols: ['k', 'd'],
    rationale: 'The stochastic oscillator names its own output lines `%K` and `%D`.',
  },
  StochRsiPoint: {
    symbols: ['k', 'd'],
    rationale: 'Stochastic RSI names its own output lines `%K` and `%D`.',
  },
  'StochRsiStream.value': {
    symbols: ['k', 'd'],
    rationale: 'Stochastic RSI names its own output lines `%K` and `%D`.',
  },
  Pair: {
    symbols: ['x', 'y'],
    rationale: 'Bivariate sample coordinates; the owning `Pair` type supplies the role.',
  },
  // The callbacks that CONSUME a `Pair` (and its unary sibling). Their parameters exist to line up
  // one-for-one with `Pair.x` / `Pair.y` above — `combine(x, y)` is applied as `combine(pair.x,
  // pair.y)` — so renaming them to `left`/`right` would leave the reader mapping two vocabularies
  // onto one pair of coordinates. These became visible only when the inventory began walking
  // constructor parameter TYPES (3B.N8 review); the callbacks themselves were renamed off `fn`, which
  // named the type rather than the role.
  '@totalfinance/technical-analysis:BinaryMathStream.constructor.combine': {
    symbols: ['x', 'y'],
    rationale: 'Applied to `Pair.x` / `Pair.y`; the coordinates it receives supply the role.',
  },
  '@totalfinance/technical-analysis:UnaryMathStream.constructor.transform': {
    symbols: ['x'],
    rationale: 'The unary sibling of `combine`, over the same coordinate vocabulary.',
  },
  // The MCP mirror of `Pair`. An agent-facing schema has no owning TYPE to supply the role, so the
  // field descriptions do it instead — which is why this exemption sits on the schema that carries
  // them, and why it would be wrong without them.
  TaCalculateInputSchema: {
    symbols: ['x', 'y'],
    rationale:
      'Bivariate sample coordinates on the MCP technical-analysis tool; the schema descriptions supply the role a `Pair` type would.',
  },
  '@totalfinance/technical-analysis:pairs': {
    symbols: ['x', 'y'],
    rationale: 'Bivariate sample series; `pairs(x, y)` zips a predictor and a response.',
  },
  // Distribution coordinates on a dedicated CDF / inverse-CDF / density method.
  '@totalfinance/math:normalCdf': {
    symbols: ['x'],
    rationale: 'Distribution coordinate on a dedicated CDF.',
  },
  '@totalfinance/math:regularizedBeta': {
    symbols: ['a', 'b', 'x'],
    rationale: 'The regularized incomplete beta `I_x(a, b)`; the symbols ARE the function.',
  },
  '@totalfinance/math:regularizedGammaP': {
    symbols: ['a', 'x'],
    rationale: 'The regularized lower incomplete gamma `P(a, x)`; the symbols ARE the function.',
  },
  '@totalfinance/math:lgamma': {
    symbols: ['x'],
    rationale: 'Distribution coordinate on the log-gamma function.',
  },
  '@totalfinance/math:bivariateNormalCdf': {
    symbols: ['a', 'b'],
    rationale: 'Upper integration limits of `Φ₂(a, b; ρ)`; canonical in the literature.',
  },
  // `A·x = b`: the right-hand side is `b` in every linear-algebra API and in these functions'
  // own teaching errors; `L` is the Cholesky factor of `A = L·Lᵀ`.
  '@totalfinance/math:luSolve': {
    symbols: ['b'],
    rationale: 'Right-hand side of `A·x = b`.',
  },
  '@totalfinance/math:qrSolve': {
    symbols: ['b'],
    rationale: 'Right-hand side of the least-squares system `A·x = b`.',
  },
  '@totalfinance/math:choleskySolve': {
    symbols: ['L', 'b'],
    rationale: 'Cholesky factor of `A = L·Lᵀ` and the right-hand side of `A·x = b`.',
  },
  // A scalar function of one variable, handed to a solver: `x` is its coordinate.
  '@totalfinance/math:RootProblem.objective': {
    symbols: ['x'],
    rationale: 'Coordinate of a scalar function handed to a root solver.',
  },
  // Interpolation grid coordinates: `x`/`y` are the axes and `z` the sampled surface.
  '@totalfinance/math:linearInterp': {
    symbols: ['x'],
    rationale: 'Interpolation abscissa on a dedicated interpolator.',
  },
  '@totalfinance/math:bilinearInterp': {
    symbols: ['x', 'y', 'z'],
    rationale: 'Interpolation grid axes (`x`, `y`) and the sampled surface (`z`).',
  },
  '@totalfinance/math:bicubicInterp': {
    symbols: ['x', 'y', 'z'],
    rationale: 'Interpolation grid axes (`x`, `y`) and the sampled surface (`z`).',
  },
  '@totalfinance/math:makeBicubicInterpolator': {
    symbols: ['x', 'y', 'z'],
    rationale: 'Interpolation grid axes (`x`, `y`) and the sampled surface (`z`).',
  },
  // A calibration slice is written `(k, w)` in every SVI/SSVI paper: log-moneyness and the total
  // implied variance at it. `w(k)` is literally the model's defining equation.
  SVISmileInput: {
    symbols: ['k', 'w'],
    rationale: 'SVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  SSVISliceInput: {
    symbols: ['k', 'w'],
    rationale: 'SSVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  ESSVISliceInput: {
    symbols: ['k', 'w'],
    rationale: 'eSSVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  SsviSliceInput: {
    symbols: ['k', 'w'],
    rationale: 'SSVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  PreparedSlice: {
    symbols: ['k', 'w'],
    rationale: 'SVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  '@totalfinance/volatility:atmTotalVariance': {
    symbols: ['k', 'w'],
    rationale: 'SVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  'calibrationWeights(slices)': {
    symbols: ['k', 'w'],
    rationale: 'SVI slice coordinates: log-moneyness `k` and total variance `w`.',
  },
  '@totalfinance/volatility:sviG': {
    symbols: ['k'],
    rationale: 'SVI log-moneyness coordinate.',
  },
  '@totalfinance/volatility:sviTotalVariance': {
    symbols: ['k'],
    rationale: 'SVI log-moneyness coordinate.',
  },
  '@totalfinance/volatility:ssviTotalVariance': {
    symbols: ['k'],
    rationale: 'SSVI log-moneyness coordinate.',
  },
  '@totalfinance/volatility:essviTotalVariance': {
    symbols: ['k'],
    rationale: 'eSSVI log-moneyness coordinate.',
  },
  // Log-moneyness `k` is the SVI family's own coordinate — `w(k)` is how the model is written.
  '@totalfinance/volatility:sviVolatility': {
    symbols: ['k'],
    rationale: 'SVI log-moneyness coordinate; `w(k)` is the model as written.',
  },
  '@totalfinance/volatility:ssviVolatility': {
    symbols: ['k'],
    rationale: 'SSVI log-moneyness coordinate; `w(k)` is the model as written.',
  },
  '@totalfinance/volatility:essviVolatility': {
    symbols: ['k'],
    rationale: 'eSSVI log-moneyness coordinate; `w(k)` is the model as written.',
  },
  '@totalfinance/math:normalPdf': {
    symbols: ['x'],
    rationale: 'Distribution coordinate on a dedicated density.',
  },
};

/**
 * Deliberately opaque serialized payloads. A consumer may persist and round-trip these but may not
 * branch on their private keys, so their interior earns brevity while the ENVELOPE stays explicit.
 */
export const OPAQUE_STATE_ENVELOPES: Readonly<Record<string, string>> = {
  // Keyed on the CURRENT type name so the gate stays honest. 3B.N7 renamed `Snapshot` to
  // `TechnicalAnalysisSnapshot` and moved this key with it, in the same commit that gave the type an
  // explicit `{ kind, schemaVersion, state }` envelope. Only `state` is opaque now — the envelope's
  // own fields are fully spelled out, which is what earns the interior its brevity.
  TechnicalAnalysisSnapshot:
    'Indicator-private stream state under `state`; consumers round-trip it without branching on keys.',
};

/** Settled package, subpath, umbrella, and MCP identity changes. */
export const PACKAGE_IDENTITIES: Readonly<Record<string, string>> = {
  // PENDING renames only — an entry leaves this map in the commit that performs it, which is what
  // the "settled renames whose source identity is gone" gate enforces. The package identities
  // `@totalfinance/vol` → `@totalfinance/volatility` and `@totalfinance/ta` → `@totalfinance/technical-analysis`
  // (with their umbrella subpaths and MCP domains) landed in 3B.N1; the three `local-vol` /
  // `vol-spot-beta` subpaths landed in 3B.N6. Their removed forms are kept as historical evidence in
  // COMPILE_FAIL_FIXTURES, not here — this map is EMPTY when every settled identity has been
  // performed, which is the 3B.N9 exit state for package identities.
};

/** Settled stable serialized-code namespace changes (`docs/specs/…#error-and-warning-codes`). */
export const CODE_NAMESPACES: Readonly<Record<string, string>> = {
  iv: 'implied_volatility',
  // Split so a repo-wide `vol` → `volatility` sweep cannot rewrite this KEY into its own
  // replacement. It did exactly that once, leaving `volatility: 'volatility'` — a dead rule that
  // reads like a live one.
  ['v' + 'ol']: 'volatility',
  mc: 'monte_carlo',
  ta: 'technical_analysis',
};

/** Settled stable serialized-code suffix changes. */
export const CODE_SUFFIXES: Readonly<Record<string, string>> = {
  data_duplicate_ts: 'data_duplicate_timestamp',
};

/**
 * Old public forms whose removal must be proved by compile-fail or runtime-rejection evidence.
 *
 * Phase 3B.N0 records these identities as DATA only. The executable tests land atomically with the
 * migration that removes each form (N1–N8) — never as a knowingly red gate here.
 */
export interface CompileFailFixture {
  /** Stable fixture identity, referenced by the migration commit that lands the executable test. */
  id: string;
  /** The removed public form. */
  before: string;
  /** The canonical replacement. */
  after: string;
  /** The phase that lands the executable evidence. */
  landsIn: string;
}

export const COMPILE_FAIL_FIXTURES: readonly CompileFailFixture[] = [
  // ---- RV7: forms the corrected tokenizer exposed (a digit had been ending scrutiny) ----
  {
    id: 'naming/options/iv-bracket-lower',
    before: 'lo' + 'Volatility',
    after: 'lowerVolatilityBound',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/options/iv-bracket-upper',
    before: 'hi' + 'Volatility',
    after: 'upperVolatilityBound',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/options/spread-volatility-1',
    before: 'vol' + '1',
    after: 'volatility1',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/options/spread-volatility-2',
    before: 'vol' + '2',
    after: 'volatility2',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/skew-wing-iv',
    before: 'iv' + '25Put',
    after: 'put25DeltaImpliedVolatility',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/skew-risk-reversal',
    before: 'rr' + '25',
    after: 'riskReversal25Delta',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/skew-butterfly',
    before: 'bf' + '25',
    after: 'butterfly25Delta',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/ta/candle-body-high',
    before: 'hi' + 'Body',
    after: 'bodyHigh',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/ta/candle-body-low',
    before: 'lo' + 'Body',
    after: 'bodyLow',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/ta/bollinger-period',
    before: 'bb' + 'Period',
    after: 'bollingerBandPeriod',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/ta/keltner-period',
    before: 'kc' + 'Period',
    after: 'keltnerChannelPeriod',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/ta/keltner-multiplier',
    before: 'kc' + 'Mult',
    after: 'keltnerChannelMultiplier',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/ta/band-multipliers',
    before: 'low' + 'Mult',
    after: 'wideKeltnerChannelMultiplier',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/package/vol',
    // Split so a repo-wide specifier rewrite cannot silently flatten this historical before→after
    // record into "after → after".
    before: "import '@totalfinance/" + "vol'",
    after: "import '@totalfinance/volatility'",
    landsIn: '3B.N1',
  },
  {
    id: 'naming/package/ta',
    // Split for the same reason as above.
    before: "import '@totalfinance/" + "ta'",
    after: "import '@totalfinance/technical-analysis'",
    landsIn: '3B.N1',
  },
  {
    id: 'naming/subpath/totalfinance-vol',
    // Split for the same reason as above.
    before: "import 'totalfinance/" + "vol'",
    after: "import 'totalfinance/volatility'",
    landsIn: '3B.N1',
  },
  {
    id: 'naming/subpath/totalfinance-ta',
    // Split for the same reason as above.
    before: "import 'totalfinance/" + "ta'",
    after: "import 'totalfinance/technical-analysis'",
    landsIn: '3B.N1',
  },
  {
    id: 'naming/umbrella/vol',
    before: 'umbrella namespace `vol`',
    after: 'umbrella namespace `volatility`',
    landsIn: '3B.N1',
  },
  {
    id: 'naming/umbrella/ta',
    before: 'umbrella namespace `ta`',
    after: 'umbrella namespace `technicalAnalysis`',
    landsIn: '3B.N1',
  },
  {
    id: 'naming/mcp/vol-tools',
    // Split for the same reason as above.
    before: 'totalfinance.' + 'vol.*',
    after: 'totalfinance.volatility.*',
    landsIn: '3B.N1',
  },
  {
    id: 'naming/mcp/ta-tools',
    // Split for the same reason as above.
    before: 'totalfinance.' + 'ta.*',
    after: 'totalfinance.technical_analysis.*',
    landsIn: '3B.N1',
  },
  {
    id: 'naming/core/market-rate',
    before: 'MarketInputs.rate',
    after: 'MarketInputs.riskFreeRate',
    landsIn: '3B.N2',
  },
  { id: 'naming/core/bar-ts', before: 'Bar.ts', after: 'Bar.timestampMs', landsIn: '3B.N2' },
  {
    id: 'naming/core/quote-implied-vol',
    // Split for the same reason as above.
    before: 'OptionQuote.implied' + 'Vol',
    after: 'OptionQuote.impliedVolatility',
    landsIn: '3B.N2',
  },
  {
    id: 'naming/flagship/bs',
    // Split for the same reason as above.
    before: 'b' + 's.price(...)',
    after: 'blackScholes.price(...)',
    landsIn: '3B.N4',
  },
  {
    id: 'naming/flagship/bsm-price',
    // Split for the same reason as above.
    before: 'bsm' + 'Price(...)',
    after: 'blackScholesPrice(...)',
    landsIn: '3B.N4',
  },
  {
    id: 'naming/flagship/bsm-implied-vol',
    // Split for the same reason as above.
    before: 'bsm' + 'ImpliedVol(...)',
    after: 'blackScholesImpliedVolatility(...)',
    landsIn: '3B.N4',
  },
  { id: 'naming/field/vol', before: '{ vol }', after: '{ volatility }', landsIn: '3B.N4' },
  { id: 'naming/field/t', before: '{ t }', after: '{ timeToExpiryYears }', landsIn: '3B.N4' },
  { id: 'naming/field/rate', before: '{ rate }', after: '{ riskFreeRate }', landsIn: '3B.N4' },
  {
    id: 'naming/ta/vol-cutoff',
    before: 'vfi({ volCutoff })',
    after: 'vfi({ volumeCutoff })',
    landsIn: '3B.N7',
  },
  {
    // The retired form is spelled with concatenation so the next `Snapshot` → `TechnicalAnalysisSnapshot`
    // sweep cannot rewrite this `before` into the shape it exists to prove is GONE. One sweep already
    // did, turning `Snapshot.v` into `TechnicalAnalysisSnapshot.v` — a form that never shipped.
    id: 'naming/ta/snapshot-v',
    before: 'Snap' + 'shot.v',
    after: 'TechnicalAnalysisSnapshot.schemaVersion',
    landsIn: '3B.N7',
  },
  {
    id: 'naming/ta/snapshot-type',
    before: 'Snap' + 'shot (@totalfinance/technical-analysis type)',
    after: 'TechnicalAnalysisSnapshot',
    landsIn: '3B.N7',
  },
  {
    // The flat shape itself, not just its version field: state used to sit at the SAME level as
    // `kind`, so nothing separated the contract from the payload. Restoring one now throws rather
    // than producing a stream whose every field reads `undefined`.
    id: 'naming/ta/snapshot-flat-state',
    before: 'Snap' + 'shot { kind, v, ...state }',
    after: 'TechnicalAnalysisSnapshot { kind, schemaVersion, state }',
    landsIn: '3B.N7',
  },

  // ── 3B.N8: names that were fully spelled out but still said the wrong thing ──────────────────
  // No abbreviation involved in most of these, which is the point: every one passed the mechanical
  // gates and had to be caught by reading. Concatenation is unnecessary where the retired form is
  // not also a live token, so it is used only where a sweep could collide.
  {
    id: 'naming/risk/spot-volatility',
    before: 'UnderlyingRiskFactor.spotVolatility',
    after: 'UnderlyingRiskFactor.spotReturnVolatility',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/risk/pnl-volatility',
    before: 'BookVaRMethodResult.pnlVolatility',
    after: 'BookVaRMethodResult.pnlStandardDeviation',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/core/fd-bumps',
    before: 'Diagnostics.fdBumps',
    after: 'Diagnostics.finiteDifferenceBumps',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/spot-beta-fn',
    before: 'volatilitySpot' + 'Beta(...)',
    after: 'estimateVolatilitySpotBeta(...)',
    landsIn: '3B.N8',
  },
  {
    // Law N5 in the same family: `minimumVarianceDelta()` returned `MinVarianceDeltaResult` whose
    // value field was `minVarianceDelta` — three spellings of one phrase across one export's
    // surface. The public function's spelling wins. @totalfinance/risk's `minVariance` is deliberately
    // untouched: it belongs to the minVariance/maxSharpe/meanVariance objective term-set, and
    // expanding one member of a coordinated set breaks the set.
    id: 'naming/volatility/min-variance-delta',
    before: 'Min' + 'VarianceDeltaResult.min' + 'VarianceDelta',
    after: 'MinimumVarianceDeltaResult.minimumVarianceDelta',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/spot-beta-field',
    before: 'betaVolatilitySpot',
    after: 'volatilitySpotBeta',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/probability-itm',
    before: 'probability' + 'Itm(...)',
    after: 'probabilityInTheMoney(...)',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/mcp/probability-itm',
    before: 'totalfinance.volatility.probability_' + 'itm',
    after: 'totalfinance.volatility.probability_in_the_money',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/volatility/de-earned',
    before: 'deEarned' + 'Volatility(...)',
    after: 'eventStrippedVolatility(...)',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/options/basket-price-approximation',
    before: 'basket.price' + 'Approximation(...)',
    after: 'basket.approximatePrice(...)',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/options/fair-volatility-approximation',
    before: 'volatilitySwap.fairVolatility' + 'Approximation(...)',
    after: 'volatilitySwap.approximateFairVolatility(...)',
    landsIn: '3B.N8',
  },
  {
    id: 'naming/options/simulation-options',
    before: 'Simulation' + 'Options',
    after: 'MonteCarloSamplingOptions',
    landsIn: '3B.N8',
  },
  {
    // Renamed in @totalfinance/options ONLY. @totalfinance/math keeps `MonteCarloOptions` for the generic
    // estimator, which is what makes the collision go away rather than move.
    id: 'naming/options/monte-carlo-options',
    before: '@totalfinance/options MonteCarlo' + 'Options',
    after: 'MonteCarloPriceOptions',
    landsIn: '3B.N8',
  },
  {
    // `minPercent: 0.5` (0.5%) filtered a set whose `size` came back as `0.005` — two units in one
    // call, neither named. `ensureKnownKeys` makes the retired spelling THROW rather than filter
    // 100x wrong, which is the only acceptable failure mode when a unit changes.
    id: 'naming/ta/gap-min-percent',
    before: 'gaps({ minPer' + 'cent }) / Gap.si' + 'ze',
    after: 'gaps({ minSizeFraction }) / Gap.sizeFraction',
    landsIn: '3B.N8',
  },

  // ---- RV9 / 3B.N9: `oi` — open interest, on two chart-facing result types and the rank knob ----
  //
  // `oi` was never on the denylist. It is two characters, so until the short-token sweep classified
  // every one-to-three character token it read as `explicit` — unrecognized, reported as reviewed.
  // Open interest is the second number on every options chain; a reader who does not already speak
  // the desk shorthand cannot recover it from `callOi`.
  {
    id: 'naming/structure/gex-call-oi',
    before: 'GexSplit.call' + 'Oi',
    after: 'GexSplit.callOpenInterest',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/structure/gex-put-oi',
    before: 'GexSplit.put' + 'Oi',
    after: 'GexSplit.putOpenInterest',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/structure/levels-largest-call-oi',
    before: 'Levels.largestCall' + 'Oi',
    after: 'Levels.largestCallOpenInterest',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/structure/levels-largest-put-oi',
    before: 'Levels.largestPut' + 'Oi',
    after: 'Levels.largestPutOpenInterest',
    landsIn: '3B.N9',
  },
  {
    // TWO public spellings, not one. `RankByKey` is a string union whose members must equal
    // `FlowGroup` keys (`rank` sorts with `b[by]`), so the retired FIELD name was also a serialized
    // VALUE a caller passes as data: `rank(groups, { by: 'volumeOiRatio' })`. The union member had
    // to move with the field — the compiler forces that — but the naming inventory does not walk
    // string-union members, so it never saw the value. See the gate-gap note in
    // naming-conformance.test.ts.
    id: 'naming/structure/flow-volume-oi-ratio',
    before: 'FlowGroup.volume' + "OiRatio / RankByKey 'volume" + "OiRatio'",
    after: "FlowGroup.volumeOpenInterestRatio / RankByKey 'volumeOpenInterestRatio'",
    landsIn: '3B.N9',
  },
  {
    // `rank` read its options by property and never rejected an unknown key, so the retired
    // spelling would have been SILENTLY IGNORED — the filter simply not applied, returning a longer
    // list than the caller asked for. Law 12 landed on this boundary in the same commit, which is
    // what lets this removal be proved by a runtime throw rather than only by the baseline.
    id: 'naming/structure/rank-min-volume-oi-ratio',
    before: 'RankOptions.minVolume' + 'OiRatio',
    after: 'RankOptions.minVolumeOpenInterestRatio',
    landsIn: '3B.N9',
  },

  // ---- RV9 / 3B.N9: `vrp` — a three-letter initialism a general caller cannot expand ----
  //
  // The variance risk premium is implied variance minus realized variance. `vrp` says that to a
  // reader who already knows and nothing to anyone else. The package ALREADY exported the quantity
  // spelled out (`varianceRiskPremium`, event.ts:381), so the term structure was the same concept
  // under a second spelling in the same package — the case Law N5 exists for.
  {
    id: 'naming/volatility/vrp-term-structure-fn',
    before: 'v' + 'rpTermStructure',
    after: 'varianceRiskPremiumTermStructure',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/volatility/vrp-term-structure-options',
    before: 'V' + 'rpTermStructureOptions',
    after: 'VarianceRiskPremiumTermStructureOptions',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/volatility/vrp-term-structure-result',
    before: 'V' + 'rpTermStructureResult',
    after: 'VarianceRiskPremiumTermStructureResult',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/volatility/vrp-point',
    before: 'V' + 'rpPoint',
    after: 'VarianceRiskPremiumPoint',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/volatility/vrp-point-field',
    before: 'VarianceRiskPremiumPoint.v' + 'rp',
    after: 'VarianceRiskPremiumPoint.varianceRiskPremium',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/volatility/vrp-index-field',
    before: 'VarianceRiskPremiumTermStructureResult.indexV' + 'rp',
    after: 'VarianceRiskPremiumTermStructureResult.indexVarianceRiskPremium',
    landsIn: '3B.N9',
  },
  {
    // A serialized VALUE, like the `oi` family's `RankByKey` member — and this one is invisible to
    // every gate in the repo. `Diagnostics.engine` is a free-form string, not a union, so nothing in
    // the type system or the naming inventory ties it to the function it names. A caller reads it
    // off every result, which makes it public text by the same rule that makes an error message
    // public. Only an executable assertion can testify that it moved.
    id: 'naming/volatility/vrp-engine-string',
    before: "diagnostics.engine 'v" + "rp-term-structure'",
    after: "diagnostics.engine 'variance-risk-premium-term-structure'",
    landsIn: '3B.N9',
  },

  // ---- RV9 / 3B.N9: `zcb` — the zero-coupon bond option on the three Gaussian short-rate models ----
  //
  // The input type was ALREADY spelled out (`ZeroCouponBondOptionInput`), so the method abbreviated
  // the exact noun its own parameter names in full, on the same line.
  {
    id: 'naming/fixed-income/zcb-option',
    before: 'z' + 'cbOption (GaussianShortRateModel, HullWhiteModel, G2ppModel)',
    after: 'zeroCouponBondOption',
    landsIn: '3B.N9',
  },
  {
    // Found by reading the guard while renaming it, not by any gate. The message said
    // "requires tBond > tOption" and the context payload published `{ tOption, tBond }` — but those
    // are LOCAL destructuring aliases. The public fields are `optionMaturity` and `bondMaturity`, so
    // the error named two fields a caller cannot write and echoed them back under those names.
    // `public-text-naming` walks these construction sites but only flags denylisted TOKENS, and `t`
    // is allowlisted notation, so the message passed every check while teaching nothing real.
    id: 'naming/fixed-income/zcb-option-error-text',
    before: "'z" + "cbOption requires tBond > tOption.' + context { tOption, tBond }",
    after:
      "'<model>.zeroCouponBondOption requires bondMaturity > optionMaturity.' + context { optionMaturity, bondMaturity }",
    landsIn: '3B.N9',
  },
  // ---- RV9 / 3B.N9: `lw` and `adv` — two initialisms on validated inputs ----
  {
    // `lw` is the AUTHORS (Ledoit-Wolf), which is unguessable from two letters. The sibling option
    // on `ledoitWolfShrinkage` was already `target`, spelled out, so this was the passthrough
    // abbreviating what it passes through to.
    id: 'naming/math/ledoit-wolf-target',
    before: 'l' + 'wTarget',
    after: 'ledoitWolfTarget',
    landsIn: '3B.N9',
  },
  {
    // The error CONTEXT already published `averageDailyVolume` while the FIELD said `adv` — the
    // payload taught one name and the type demanded another, in the same throw.
    id: 'naming/risk/average-daily-volume',
    before: 'ad' + 'v (LiquidityPosition, MarketImpactInput)',
    after: 'averageDailyVolume',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/risk/average-daily-volume-multiple',
    before: 'ad' + 'vMultiple',
    after: 'averageDailyVolumeMultiple',
    landsIn: '3B.N9',
  },
  // ---- RV9 / 3B.N9: `ma` (and `agg`) — the largest family, 38 identities ----
  //
  // `ma` is the moving average, the single most common object in technical analysis, and it was
  // abbreviated on the exported function, four type names, two const arrays, five parameter fields,
  // three stream classes, two output fields, and the REGISTRY KEY a caller passes as data.
  {
    id: 'naming/ta/ma-export',
    before: 'm' + 'a (exported indicator, and the registry name it is looked up by)',
    after: 'movingAverage',
    landsIn: '3B.N9',
  },
  {
    // The registry key is a serialized public name, not just an identifier: `getIndicator('ma')`,
    // `describeIndicator('ma')`, and the MCP `technical_analysis.calculate` indicator enum all take
    // it as DATA. It moved with the export, because one concept may not have two public spellings.
    id: 'naming/ta/ma-registry-name',
    before: "getIndicator('m" + "a')",
    after: "getIndicator('movingAverage')",
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-name-type',
    before: 'M' + 'aName',
    after: 'MovingAverageName',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-parameters-type',
    before: 'M' + 'aParameters',
    after: 'MovingAverageParameters',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-type-type',
    before: 'M' + 'aType',
    after: 'MovingAverageType',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-names-const',
    before: 'MA' + '_NAMES',
    after: 'MOVING_AVERAGE_NAMES',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-types-const',
    before: 'MA' + '_TYPES',
    after: 'MOVING_AVERAGE_TYPES',
    landsIn: '3B.N9',
  },
  {
    // The snapshot envelope `kind` moved with it. `kind` is the indicator's name by contract
    // (`snapshotOf` requires it) and is explicitly NOT part of the opaque interior.
    id: 'naming/ta/ma-ribbon',
    before: 'm' + 'aRibbon (export, and the snapshot envelope kind)',
    after: 'movingAverageRibbon',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-ribbon-parameters',
    before: 'M' + 'aRibbonParameters',
    after: 'MovingAverageRibbonParameters',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/ma-ribbon-stream',
    before: 'M' + 'aRibbonStream',
    after: 'MovingAverageRibbonStream',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/rainbow-ma',
    before: 'rainbowM' + 'a (export, and the snapshot envelope kind)',
    after: 'rainbowMovingAverage',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/rainbow-ma-stream',
    before: 'RainbowM' + 'aStream',
    after: 'RainbowMovingAverageStream',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/weighted-ma-stream',
    before: 'WeightedM' + 'aStream',
    after: 'WeightedMovingAverageStream',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/holt-winter-ma',
    before: 'holtWinterM' + 'a',
    after: 'holtWinterMovingAverage',
    landsIn: '3B.N9',
  },
  {
    // The registry `parameters` string arrays and `defaults` records are the RUNTIME unknown-field
    // gate (framework.ts hands them to ensureKnownKeys), and warmup.ts CANONICAL must carry the same
    // key or `indicatorWarmups` throws. Three string surfaces, none visible to the compiler.
    id: 'naming/ta/ma-type-parameter',
    before: 'm' + 'aType',
    after: 'movingAverageType',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/macd-ext-ma-types',
    before: 'fastM' + 'aType / slowM' + 'aType / signalM' + 'aType',
    after: 'fastMovingAverageType / slowMovingAverageType / signalMovingAverageType',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/macd-ext-signal-ma',
    before: 'MacdExtStream.signalM' + 'a',
    after: 'MacdExtStream.signalMovingAverage',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/qqe-rsi-ma',
    before: 'QqePoint.rsiM' + 'a',
    after: 'QqePoint.rsiMovingAverage',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/elder-thermometer-ma',
    before: 'ElderThermometerPoint.m' + 'a',
    after: 'ElderThermometerPoint.movingAverage',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/agg-stream',
    before: 'Ag' + 'gStream',
    after: 'AggregateStream',
    landsIn: '3B.N9',
  },
  // ---- RV9 / 3B.N9: the last thirteen — bare tokens on math, volatility and TA surfaces ----
  {
    id: 'naming/math/mat-mul',
    before: 'matM' + 'ul',
    after: 'matrixMultiply',
    landsIn: '3B.N9',
  },
  {
    // NOT `matrixVector`, which names an operand pair rather than an operation. The function's own
    // doc comment says "Matrix-vector product", and `matrixMultiply` beside `matrixVectorProduct`
    // reads as two operations; `matrixMultiply` beside `matrixVector` reads as an operation and a
    // noun. @totalfinance/risk keeps its own internal `matVec`, which is a different function.
    id: 'naming/math/mat-vec',
    before: 'matV' + 'ec',
    after: 'matrixVectorProduct',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/math/lu-pivot-indices',
    before: 'LuResult.p' + 'iv',
    after: 'LuResult.pivotIndices',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/options/dupire-log-moneyness-step',
    before: 'DupireOptions.d' + 'k',
    after: 'DupireOptions.logMoneynessStep',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/volatility/implied-volatilities',
    before: 'SABRSmileInput.i' + 'vs / SurfaceSlice.i' + 'vs',
    after: 'impliedVolatilities',
    landsIn: '3B.N9',
  },
  {
    // BRAR is a pair, and only half of it was in the queue. `br` was flagged; `ar` was PARDONED by a
    // token rule reading "Autoregressive, as in AR/ARMA model orders" — which is not what this field
    // is. Renaming one and pardoning the other would have left the type half-spelled under a reason
    // that describes a different quantity. The pardon covered nothing else and was deleted.
    id: 'naming/ta/brar-fields',
    before: 'BrarPoint.a' + 'r / BrarPoint.b' + 'r',
    after: 'BrarPoint.popularityIndex / BrarPoint.willingnessIndex',
    landsIn: '3B.N9',
  },
  {
    // Same shape as BRAR: `bc` was queued, `tc` was pardoned as "Trend/time constant, per the filter
    // it names" while its own docstring said "Top central = 2*pivot - bc". That pardon also covered
    // nothing else and was deleted.
    id: 'naming/ta/cpr-central-pivots',
    before: 'CprPoint.t' + 'c / CprPoint.b' + 'c',
    after: 'CprPoint.topCentral / CprPoint.bottomCentral',
    landsIn: '3B.N9',
  },
  {
    id: 'naming/ta/term-operator',
    before: 'Term.o' + 'p',
    after: 'Term.operator',
    landsIn: '3B.N9',
  },
  // ---- Stage 4.5 (calibration artifacts): `seed` names randomness only; a starting point is `initialParameters` ----
  {
    id: 'naming/volatility/heston-surface-start',
    before: 'HestonSurfaceCalibrationInput.options.' + 'seed',
    after: 'HestonSurfaceCalibrationInput.options.initialParameters',
    landsIn: '4.5',
  },
  {
    id: 'naming/volatility/surface-config-heston-start',
    before: 'SurfaceConfig.heston' + 'Seed',
    after: 'SurfaceConfig.hestonInitialParameters',
    landsIn: '4.5',
  },
  // ---- Pre-publish interface repairs B7: one chain row ----
  {
    id: 'naming/strategy/chain-quote-row',
    before: 'Chain' + 'Quote',
    after: 'OptionQuote (core; Greeks ride `greeks`)',
    landsIn: 'repairs.B7',
  },
  {
    id: 'naming/volatility/observed-skew-quote-row',
    before: 'ObservedSkew' + 'Quote',
    after: 'OptionQuote (core; Greeks ride `greeks`)',
    landsIn: 'repairs.B7',
  },
  // ---- Pre-publish interface repairs B6: one order vocabulary ----
  {
    id: 'naming/portfolio/trade-side-alias',
    before: 'Trade' + 'Side',
    after: 'OrderSide (core)',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/portfolio/trade-order-type-alias',
    before: 'Trade' + 'OrderType',
    after: 'OrderType (core, kebab-case)',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/portfolio/trade-time-in-force-alias',
    before: 'Trade' + 'TimeInForce',
    after: 'TimeInForce (core)',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/backtest/execution-order-type-alias',
    before: 'Execution' + 'OrderType',
    after: 'OrderType (core)',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/backtest/execution-time-in-force-alias',
    before: 'Execution' + 'TimeInForce',
    after: 'TimeInForce (core)',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/backtest/side-alias',
    before: 'Si' + 'de',
    after: 'OrderSide (core)',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/portfolio/intent-order-target-weight',
    before: 'TradeIntentOrder.target' + 'Weight',
    after: 'TradeIntentOrder.notionalWeight',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/portfolio/option-terms-right',
    before: 'OptionContractTerms.ri' + 'ght',
    after: 'OptionContractTerms.type',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/backtest/option-specification-expiry-instant',
    before: 'OptionContractSpecification.exp' + 'iry',
    after: 'OptionContractSpecification.expiresAt',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/workflows/handle-created-at',
    before: 'ResourceHandle.created' + 'At',
    after: 'ResourceHandle.createdTimestampMs',
    landsIn: 'repairs.B6',
  },
  {
    id: 'naming/workflows/handle-expires-at',
    before: 'ResourceHandle.expires' + 'At',
    after: 'ResourceHandle.expiresTimestampMs',
    landsIn: 'repairs.B6',
  },
  // ---- Pre-publish interface repairs C: one name per ratio, one VaR door ----
  {
    id: 'naming/performance/sharpe-ratio-alias',
    before: 'sharpe' + 'Ratio',
    after: 'sharpe',
    landsIn: 'repairs.C',
  },
  {
    id: 'naming/performance/sortino-ratio-alias',
    before: 'sortino' + 'Ratio',
    after: 'sortino',
    landsIn: 'repairs.C',
  },
  {
    id: 'naming/performance/calmar-ratio-alias',
    before: 'calmar' + 'Ratio',
    after: 'calmar',
    landsIn: 'repairs.C',
  },
  {
    id: 'naming/performance/treynor-ratio-alias',
    before: 'treynor' + 'Ratio',
    after: 'treynor',
    landsIn: 'repairs.C',
  },
  {
    id: 'naming/risk/parametric-portfolio-var-door',
    before: 'parametric' + 'PortfolioVaR',
    after: "portfolioVaR({ method: 'parametric' })",
    landsIn: 'repairs.C',
  },
  {
    id: 'naming/risk/monte-carlo-portfolio-var-door',
    before: 'monteCarlo' + 'PortfolioVaR',
    after: "portfolioVaR({ method: 'monteCarlo' })",
    landsIn: 'repairs.C',
  },
];

/**
 * Tokens forbidden only as a COMPLETE public name, not as part of a qualified compound.
 *
 * `rate` is a full English word, not a truncation. The policy's objection is that a bare `rate`
 * does not say WHICH rate — so `MarketInputs.rate` fails, while `riskFreeRate`, `hazardRate`,
 * `couponRate`, and `forwardRate` are exactly the fix and must not be flagged for containing the
 * token they were renamed TO. Without this distinction the migration can never reach zero: the
 * canonical replacement would flag itself.
 */
export const BARE_ONLY_TOKENS: readonly string[] = ['rate'];
