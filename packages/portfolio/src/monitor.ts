/**
 * `monitorPortfolio` (FC7 slice 4, Stage 4.4; agent-native "Monitoring and alerts"): evaluate ONE
 * explicit valuation — a portfolio state, a market snapshot, an instant — against the investment
 * policy and the PRIOR monitor state, and return typed alerts with evidence. It never sends a
 * notification and never reads a clock: the host schedules evaluations, and a recorded stream of
 * (market, portfolio, monitor-state) inputs reproduces the same alerts (the replay law, tested).
 *
 * Decisions this module executes:
 *
 * - **No secret defaults for goals.** A family evaluates only when the policy (or an explicit
 *   caller rule) declares its limit; otherwise the family is reported `skipped` with the reason.
 *   Rule MECHANICS (debounce 1, cooldown 0, per-family direction and severity) are defaults and
 *   are echoed in `assumptions.rulesApplied`.
 * - **A missing mark is an alert, not a crash.** When a held instrument has no usable spot the
 *   portfolio cannot be valued: `stale-market-data` is raised for every such instrument, the
 *   weight-based families are skipped as `unvalued`, and the cash-only families (cash reserve by
 *   absolute amount, margin pressure) still evaluate from a cash-only valuation.
 * - **The state machine is per (family, key)**: a breach enters at `enter` (or the threshold) and
 *   clears past `exit`; `debounceEvaluations` consecutive breaches are needed before raising;
 *   `cooldownMs` after the last raise suppresses a re-raise (reported as `suppressed`); an
 *   acknowledged active rule reports `acknowledged` until it clears, and clearing emits `cleared`
 *   exactly once. A subject that vanishes (a closed position, a removed target) clears.
 * - **Skipped families carry their prior state forward untouched** — unknown is not cleared.
 * - **Exposure is NOTIONAL; NAV is what is owned** (slice 5). The weight-based families
 *   (allocation drift, concentration, leverage) measure `baseCurrencyNotionalValue` — quantity ×
 *   mark × contract multiplier — over NAV. For a cash-on-trade position that is its market value;
 *   for a variation-margin position (futures, perpetuals) NAV carries only the UNSETTLED P&L, so a
 *   futures overlay's drift, concentration, and leverage are its notional, never its margin
 *   balance. Drawdown, daily loss, and the cash families stay on `netAssetValue`.
 *
 * Families (in `MONITOR_ALERT_FAMILIES` order): `allocation-drift` (|current − target| per
 * target, on notional weights), `concentration-limit` (|notional weight| per instrument and per
 * group limit), `leverage-limit` (Σ|notional| ÷ NAV), `drawdown` (1 − NAV ÷ peak), `daily-loss`,
 * `cash-reserve`, `margin-pressure` (settled base cash), `liquidity` (days to liquidate by
 * quantity), `option-expiration` (days to expiry of every option position, direction below,
 * against `optionExpirationWarningDays`), `assignment-risk` (moneyness of every SHORT option at
 * the underlying's mark, direction above, against `assignmentRiskMoneyness`), `stale-market-data`,
 * `reconciliation-difference`, `unexplained-residual`, `unusual-pnl`. Deferred (named in
 * `diagnostics.unsupportedFamilies`): dividend risk (no ex-dividend calendar in this build),
 * order status (the execution journal), scenario-loss change (Gate D).
 */

import type { EpochMs } from '@totalfinance/core';
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireRepresentableResult,
  resolveAsOf,
  stableSum,
} from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import { canonicalJsonOf, readMarketSnapshot } from '@totalfinance/core/artifacts';
import type { DerivativeContractTerms, OptionContractTerms, SettlementStyle } from './events.js';
import type { CurrencyPairQuote } from './internal.js';
import {
  convertWithQuotes,
  deepFreeze,
  epochMsToUtcDate,
  ownValue,
  requireCurrencyPairQuoteShape,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
  requirePositiveNumberField,
  setOwnValue,
} from './internal.js';
import type { InstrumentClassification, PortfolioPnlResult } from './pnl.js';
import { requireInstrumentClassification } from './pnl.js';
import type { InvestmentPolicy } from './policy-grammar.js';
import {
  expandTargets,
  isCashTargetGroup,
  requireInvestmentPolicy,
  resolvePolicyTargets,
  targetGroupKey,
} from './policy-grammar.js';
import type { ReconcilePortfolioResult } from './reconciliation.js';
import type { PortfolioSnapshotCashRow, PortfolioSnapshotResult } from './snapshot.js';
import { portfolioSnapshot } from './snapshot.js';
import type { AccountState, PortfolioState } from './state.js';
import { requirePortfolioStateShape } from './state.js';

// ---------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------

/** The alert families this build evaluates. */
export type MonitorAlertFamily =
  | 'allocation-drift'
  | 'concentration-limit'
  | 'leverage-limit'
  | 'drawdown'
  | 'daily-loss'
  | 'cash-reserve'
  | 'margin-pressure'
  | 'liquidity'
  | 'option-expiration'
  | 'assignment-risk'
  | 'stale-market-data'
  | 'reconciliation-difference'
  | 'unexplained-residual'
  | 'unusual-pnl';

/**
 * The doc's families this build declares unsupported: dividend risk needs an ex-dividend calendar
 * (none in this build), order status lives in the execution journal, scenario-loss change waits
 * for the Gate D scenario runner.
 */
export type MonitorDeferredFamily = 'dividend-risk' | 'order-status' | 'scenario-loss-change';

export type MonitorAlertDirection = 'above' | 'below';
export type MonitorAlertSeverity = 'informational' | 'warning' | 'critical';
export type MonitorAlertState = 'raised' | 'active' | 'acknowledged' | 'suppressed' | 'cleared';

/** Enter/exit bounds: a rule ENTERS past `enter` and only CLEARS past `exit`. */
export interface MonitorHysteresis {
  enter: number;
  exit: number;
}

/** A per-family rule override. Every field optional; the resolved rule is echoed in the result. */
export interface MonitorRule {
  /** `false` skips the family (its prior state is carried forward untouched). */
  enabled?: boolean;
  /** Replaces the policy's limit (an explicit goal — e.g. an "approach" level below the limit). */
  threshold?: number;
  direction?: MonitorAlertDirection;
  /** Mutually exclusive with `threshold`; `enter` is the threshold. */
  hysteresis?: MonitorHysteresis;
  /** Consecutive breaching evaluations required before raising. Safe integer ≥ 1 (default 1). */
  debounceEvaluations?: number;
  /** Milliseconds after the last raise during which a re-raise is suppressed. ≥ 0 (default 0). */
  cooldownMs?: number;
  severity?: MonitorAlertSeverity;
}

export type MonitorThresholdSource = 'policy' | 'input' | 'rule' | 'per-observation' | 'none';

/** The rule actually applied to a family — defaults, policy limits, and overrides resolved. */
export interface ResolvedMonitorRule {
  enabled: boolean;
  /** The family-level threshold; `null` when thresholds are per observation (drift bands, group limits) or undeclared. */
  threshold: number | null;
  thresholdSource: MonitorThresholdSource;
  direction: MonitorAlertDirection;
  hysteresis: MonitorHysteresis | null;
  debounceEvaluations: number;
  cooldownMs: number;
  severity: MonitorAlertSeverity;
}

/** One rule's carried state, keyed `'family:key'` in {@link PortfolioMonitorState.rules}. */
export interface MonitorRuleState {
  active: boolean;
  consecutiveBreaches: number;
  lastRaisedAtMs: EpochMs | null;
  acknowledged: boolean;
  lastValue: number | null;
}

export const PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION = 1;

/** The JSON-safe, frozen monitor state handed back as the next evaluation's `previousState`. */
export interface PortfolioMonitorState {
  schemaVersion: number;
  asOf: EpochMs;
  /** The evaluation's NAV; `null` when the portfolio could not be valued (a missing mark). */
  netAssetValue: number | null;
  /** The running NAV peak (drawdown base); `null` until an evaluation has valued the portfolio. */
  peakNetAssetValue: number | null;
  evaluationCount: number;
  rules: Record<string, MonitorRuleState>;
}

export interface MonitorAlert {
  /** `'family:key'` — the rule identity, stable across evaluations. */
  key: string;
  family: MonitorAlertFamily;
  /** Prose naming the subject (`'instrument AAPL'`, `'group tag:equity'`, `'portfolio'`). */
  subject: string;
  severity: MonitorAlertSeverity;
  state: MonitorAlertState;
  value: number | null;
  threshold: number | null;
  direction: MonitorAlertDirection;
  message: string;
  evidence: Record<string, number | string | null>;
}

export interface MonitorFamilyEvaluation {
  family: MonitorAlertFamily;
  status: 'evaluated' | 'skipped';
  observationCount: number;
  /** Present exactly when `status` is `'skipped'`. */
  reason?: string;
}

export interface MonitorPortfolioInput {
  portfolio: PortfolioState;
  market: MarketSnapshot;
  /** The evaluation instant: epoch ms, `'YYYY-MM-DD'`, or a zoned ISO datetime. */
  asOf: EpochMs | string;
  currencyConversions?: CurrencyPairQuote[];
  policy: InvestmentPolicy;
  instrumentClassification?: Record<string, InstrumentClassification>;
  /** REQUIRED: the prior evaluation's `state`, or `null` for the first evaluation. */
  previousState: PortfolioMonitorState | null;
  rules?: Partial<Record<MonitorAlertFamily, MonitorRule>>;
  /** Alert keys the host acknowledged since `previousState`. */
  acknowledgments?: string[];
  reconciliation?: ReconcilePortfolioResult;
  pnl?: PortfolioPnlResult;
  /** Units per day per instrument — the liquidity family's denominator. */
  averageDailyVolumes?: Record<string, number>;
  /** A mark observed before `asOf − marketStalenessLimitMs` is stale. */
  marketStalenessLimitMs?: number;
  /** Decimal of NAV above which `|pnl.components.totalPnl| ÷ NAV` is unusual. */
  unusualPnlThreshold?: number;
  /** Base-currency amount above which `|pnl.residual|` is unexplained. */
  residualTolerance?: number;
  /**
   * Days to expiry (≥ 0) at or below which an option position is near expiry — the
   * `option-expiration` family's bound (direction below). Skipped without one (or a rule threshold).
   */
  optionExpirationWarningDays?: number;
  /**
   * Moneyness (a decimal of the strike; positive = in the money) above which a SHORT option is at
   * risk of assignment — the `assignment-risk` family's bound. A negative value alerts while still
   * out of the money. Skipped without one (or a rule threshold).
   */
  assignmentRiskMoneyness?: number;
}

export interface MonitorPortfolioResult {
  asOf: EpochMs;
  baseCurrency: string;
  netAssetValue: number | null;
  /** Raised / active / acknowledged / suppressed / cleared entries only, sorted by key. */
  alerts: MonitorAlert[];
  /** One row per family, in the family order. */
  evaluated: MonitorFamilyEvaluation[];
  state: PortfolioMonitorState;
  assumptions: {
    conventionsVersion: string;
    liquidityParticipationRate: number;
    /** Prose statement of every convention. String-typed by design. */
    conventions: string;
    rulesApplied: Record<MonitorAlertFamily, ResolvedMonitorRule>;
  };
  diagnostics: {
    warnings: string[];
    unsupportedFamilies: { family: MonitorDeferredFamily; reason: string }[];
    raisedCount: number;
    /** Rules active AFTER this evaluation (raised, active, acknowledged, and carried-forward). */
    activeCount: number;
    clearedCount: number;
    suppressedCount: number;
    acknowledgedCount: number;
  };
}

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

export const MONITOR_ALERT_FAMILIES: readonly MonitorAlertFamily[] = [
  'allocation-drift',
  'concentration-limit',
  'leverage-limit',
  'drawdown',
  'daily-loss',
  'cash-reserve',
  'margin-pressure',
  'liquidity',
  'option-expiration',
  'assignment-risk',
  'stale-market-data',
  'reconciliation-difference',
  'unexplained-residual',
  'unusual-pnl',
];

const FAMILY_DIRECTION: Record<MonitorAlertFamily, MonitorAlertDirection> = {
  'allocation-drift': 'above',
  'concentration-limit': 'above',
  'leverage-limit': 'above',
  drawdown: 'above',
  'daily-loss': 'above',
  'cash-reserve': 'below',
  'margin-pressure': 'below',
  liquidity: 'above',
  'option-expiration': 'below',
  'assignment-risk': 'above',
  'stale-market-data': 'above',
  'reconciliation-difference': 'above',
  'unexplained-residual': 'above',
  'unusual-pnl': 'above',
};

const FAMILY_SEVERITY: Record<MonitorAlertFamily, MonitorAlertSeverity> = {
  'allocation-drift': 'warning',
  'concentration-limit': 'warning',
  'leverage-limit': 'critical',
  drawdown: 'critical',
  'daily-loss': 'critical',
  'cash-reserve': 'warning',
  'margin-pressure': 'critical',
  liquidity: 'warning',
  'option-expiration': 'warning',
  'assignment-risk': 'warning',
  'stale-market-data': 'warning',
  'reconciliation-difference': 'warning',
  'unexplained-residual': 'warning',
  'unusual-pnl': 'warning',
};

const DEFERRED_FAMILIES: readonly { family: MonitorDeferredFamily; reason: string }[] = [
  {
    family: 'dividend-risk',
    reason:
      'no ex-dividend calendar in this build — early-assignment risk around an ex-date needs one (expiry and moneyness ARE evaluated: see the option-expiration and assignment-risk families)',
  },
  {
    family: 'order-status',
    reason:
      'no order journal in this build — orders live in the execution journal, not the ledger (Permanent law 3)',
  },
  {
    family: 'scenario-loss-change',
    reason: 'no scenario runner in this build (Gate D)',
  },
];

/** Days to liquidate = |quantity| ÷ (averageDailyVolume × this rate). Stated in assumptions. */
export const MONITOR_LIQUIDITY_PARTICIPATION_RATE = 0.1;

/** Days to expiry = (expiryTimestampMs − asOf) ÷ this. */
const MS_PER_DAY = 86_400_000;

const INPUT_KEYS = [
  'portfolio',
  'market',
  'asOf',
  'currencyConversions',
  'policy',
  'instrumentClassification',
  'previousState',
  'rules',
  'acknowledgments',
  'reconciliation',
  'pnl',
  'averageDailyVolumes',
  'marketStalenessLimitMs',
  'unusualPnlThreshold',
  'residualTolerance',
  'optionExpirationWarningDays',
  'assignmentRiskMoneyness',
] as const;
const RULE_KEYS = [
  'enabled',
  'threshold',
  'direction',
  'hysteresis',
  'debounceEvaluations',
  'cooldownMs',
  'severity',
] as const;
const HYSTERESIS_KEYS = ['enter', 'exit'] as const;
const STATE_KEYS = [
  'schemaVersion',
  'asOf',
  'netAssetValue',
  'peakNetAssetValue',
  'evaluationCount',
  'rules',
] as const;
const RULE_STATE_KEYS = [
  'active',
  'consecutiveBreaches',
  'lastRaisedAtMs',
  'acknowledged',
  'lastValue',
] as const;
const RECONCILIATION_KEYS = [
  'asOf',
  'baseCurrency',
  'reconciled',
  'accounts',
  'differenceCount',
  'explainedCount',
  'suggestedCorrections',
  'undraftable',
  'assumptions',
  'diagnostics',
] as const;
const PNL_KEYS = [
  'baseCurrency',
  'from',
  'to',
  'netAssetValueChange',
  'externalFlows',
  'investmentReturn',
  'components',
  'residual',
  'byCurrency',
  'groupings',
  'assumptions',
  'diagnostics',
] as const;
const DIRECTIONS: readonly MonitorAlertDirection[] = ['above', 'below'];
const SEVERITIES: readonly MonitorAlertSeverity[] = ['informational', 'warning', 'critical'];

const CONVENTIONS =
  'One evaluation values the portfolio with portfolioSnapshot at asOf (positions at ' +
  'observations.spots, cash at face, base-currency conversion at the supplied quotes). Weights ' +
  'are base-currency NOTIONAL value ÷ NAV (signed), notional = quantity × mark × contract ' +
  'multiplier: for a cash-on-trade position that is its market value; for a variation-margin ' +
  'position (futures, perpetuals) NAV carries only the unsettled P&L, so a futures overlay’s ' +
  'drift, concentration, and leverage measure its notional, never its margin balance. An ' +
  'instrument’s concentration is its absolute weight; a group’s is the absolute sum of its ' +
  'members’ signed weights, members resolved by the policy grammar (instrumentId, sleeve tree, ' +
  'classification, currency). Drift is |current − target| per instrument target and per group ' +
  'target (the cash target compares the cash weight, cash ÷ NAV). Gross leverage is Σ|notional| ' +
  '÷ NAV. Drawdown is 1 − NAV ÷ peak, the peak carried in the monitor state and initialised at ' +
  'the first valued NAV (the current NAV joins the peak before the drawdown is measured). Daily ' +
  'loss is (previous NAV − NAV) ÷ previous NAV between consecutive evaluations. The cash reserve ' +
  'compares base-currency cash with the larger of minimumCash and minimumCashWeight × NAV; ' +
  'margin pressure compares settled cash across all currencies converted to base. Days to ' +
  'liquidate = |quantity| ÷ (averageDailyVolume × participation rate). Days to expiry = ' +
  '(contract.expiryTimestampMs − asOf) ÷ 86,400,000 for every option position (negative once ' +
  'past expiry), compared below optionExpirationWarningDays. Assignment risk is the moneyness of ' +
  'every SHORT option at its underlying’s mark S against its strike K — call (S − K) ÷ K, put ' +
  '(K − S) ÷ K, positive in the money — compared above assignmentRiskMoneyness; a short option ' +
  'whose underlying has no usable mark (missing, no currency, or another currency) is raised ' +
  'unconditionally with a null value. A mark’s age is asOf − (spot.timestampMs, else the ' +
  'snapshot asOf); a held instrument without a usable spot is raised unconditionally and leaves ' +
  'the portfolio unvalued (weight-based families skipped, cash-only and contract-term families ' +
  'still evaluated). A breach is value > threshold (direction above) or value < threshold ' +
  '(below); with hysteresis the rule enters past enter and clears past exit; debounce counts ' +
  'consecutive breaching evaluations before raising; cooldown suppresses a re-raise within the ' +
  'window after the last raise; acknowledgment holds until the rule clears. Families the policy ' +
  'declares no limit for are skipped, never defaulted; skipped families carry their prior state ' +
  'forward untouched.';

const EXAMPLE_CALL =
  "monitorPortfolio({ portfolio: ledger.state, market, asOf: '2026-08-20', policy: { limits: { maximumPositionWeight: 0.25, maximumDrawdown: 0.1 } }, previousState: null })";

// ---------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------

function outOfRange(functionName: string, field: string, message: string): never {
  throw new InputError(`${functionName}: ${message}`, {
    code: ErrorCode.InputOutOfRange,
    context: { function: functionName, field },
  });
}

function missingField(functionName: string, field: string, message: string): never {
  throw new InputError(`${functionName}: ${message}`, {
    code: ErrorCode.InputMissingField,
    context: { function: functionName, field },
  });
}

function wrongType(functionName: string, field: string, message: string): never {
  throw new InputError(`${functionName}: ${message}`, {
    code: ErrorCode.InputWrongType,
    context: { function: functionName, field },
  });
}

function received(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return Array.isArray(value) ? 'array' : typeof value;
}

function requireLiteral<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.map((v) => `'${v}'`).join(', ')}. Received ${received(value)}.`,
      {
        code: typeof value === 'string' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
  return value as T;
}

function requireBoolean(functionName: string, field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    wrongType(functionName, field, `${field} must be true or false. Received ${received(value)}.`);
  }
  return value;
}

function requireNonNegative(functionName: string, field: string, value: unknown): number {
  requireFiniteNumberField(functionName, field, value);
  if (value < 0) outOfRange(functionName, field, `${field} must be ≥ 0. Received ${value}.`);
  return value;
}

function requireSafeIntegerAtLeast(
  functionName: string,
  field: string,
  value: unknown,
  minimum: number,
): number {
  requireFiniteNumberField(functionName, field, value);
  if (!Number.isSafeInteger(value) || value < minimum) {
    outOfRange(
      functionName,
      field,
      `${field} must be a safe integer ≥ ${minimum}. Received ${value}.`,
    );
  }
  return value;
}

function requireFiniteOrNull(functionName: string, field: string, value: unknown): number | null {
  if (value === null) return null;
  requireFiniteNumberField(functionName, field, value);
  return value;
}

/** Six significant digits for prose; evidence keeps full precision. */
function pretty(value: number | null): string {
  if (value === null) return 'null';
  return String(Number(value.toPrecision(6)));
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The family of a `'family:key'` rule identity — the prefix up to the first colon. */
function familyOfKey(key: string): MonitorAlertFamily | null {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const family = key.slice(0, colon);
  return (MONITOR_ALERT_FAMILIES as readonly string[]).includes(family)
    ? (family as MonitorAlertFamily)
    : null;
}

// ---------------------------------------------------------------------------------------------------
// Validation — rules, prior state, companion results
// ---------------------------------------------------------------------------------------------------

function requireHysteresis(
  functionName: string,
  path: string,
  value: unknown,
  direction: MonitorAlertDirection,
): MonitorHysteresis {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, HYSTERESIS_KEYS);
  const raw = value as Record<string, unknown>;
  for (const field of HYSTERESIS_KEYS) {
    if (raw[field] === undefined) {
      missingField(
        functionName,
        `${path}.${field}`,
        `${path}.${field} is required — hysteresis is an enter/exit pair.\n  e.g. hysteresis: { enter: 0.05, exit: 0.02 }`,
      );
    }
    requireFiniteNumberField(functionName, `${path}.${field}`, raw[field]);
  }
  const enter = raw['enter'] as number;
  const exit = raw['exit'] as number;
  if (direction === 'above' && exit > enter) {
    outOfRange(
      functionName,
      `${path}.exit`,
      `${path}.exit (${exit}) must be ≤ enter (${enter}) for direction 'above' — the rule enters past enter and clears back past exit.`,
    );
  }
  if (direction === 'below' && exit < enter) {
    outOfRange(
      functionName,
      `${path}.exit`,
      `${path}.exit (${exit}) must be ≥ enter (${enter}) for direction 'below' — the rule enters past enter and clears back past exit.`,
    );
  }
  return { enter, exit };
}

function requireMonitorRules(
  functionName: string,
  value: unknown,
): Partial<Record<MonitorAlertFamily, MonitorRule>> {
  if (value === undefined) return {};
  requireArgumentObject(functionName, 'rules', value);
  ensureKnownKeys(functionName, 'rules', value as object, MONITOR_ALERT_FAMILIES);
  const raw = value as Record<string, unknown>;
  const out: Partial<Record<MonitorAlertFamily, MonitorRule>> = {};
  for (const family of MONITOR_ALERT_FAMILIES) {
    const entry = ownValue(raw, family);
    if (entry === undefined) continue;
    const path = `rules['${family}']`;
    requireArgumentObject(functionName, path, entry);
    ensureKnownKeys(functionName, path, entry as object, RULE_KEYS);
    const rule = entry as Record<string, unknown>;
    const cleaned: MonitorRule = {};
    if (rule['enabled'] !== undefined) {
      cleaned.enabled = requireBoolean(functionName, `${path}.enabled`, rule['enabled']);
    }
    if (rule['direction'] !== undefined) {
      cleaned.direction = requireLiteral(
        functionName,
        `${path}.direction`,
        rule['direction'],
        DIRECTIONS,
      );
    }
    const direction = cleaned.direction ?? FAMILY_DIRECTION[family];
    if (rule['threshold'] !== undefined && rule['hysteresis'] !== undefined) {
      outOfRange(
        functionName,
        `${path}.threshold`,
        `${path} declares both threshold and hysteresis — hysteresis.enter IS the threshold; give one or the other.`,
      );
    }
    if (rule['threshold'] !== undefined) {
      requireFiniteNumberField(functionName, `${path}.threshold`, rule['threshold']);
      cleaned.threshold = rule['threshold'];
    }
    if (rule['hysteresis'] !== undefined) {
      cleaned.hysteresis = requireHysteresis(
        functionName,
        `${path}.hysteresis`,
        rule['hysteresis'],
        direction,
      );
    }
    if (rule['debounceEvaluations'] !== undefined) {
      cleaned.debounceEvaluations = requireSafeIntegerAtLeast(
        functionName,
        `${path}.debounceEvaluations`,
        rule['debounceEvaluations'],
        1,
      );
    }
    if (rule['cooldownMs'] !== undefined) {
      cleaned.cooldownMs = requireNonNegative(
        functionName,
        `${path}.cooldownMs`,
        rule['cooldownMs'],
      );
    }
    if (rule['severity'] !== undefined) {
      cleaned.severity = requireLiteral(
        functionName,
        `${path}.severity`,
        rule['severity'],
        SEVERITIES,
      );
    }
    setOwnValue(out, family, cleaned);
  }
  return out;
}

function requirePreviousMonitorState(
  functionName: string,
  value: unknown,
  asOf: EpochMs,
): PortfolioMonitorState {
  requireArgumentObject(functionName, 'previousState', value);
  ensureKnownKeys(functionName, 'previousState', value as object, STATE_KEYS);
  const raw = value as Record<string, unknown>;
  if (raw['schemaVersion'] !== PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION) {
    throw new InputError(
      `${functionName}: previousState.schemaVersion must be ${PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION} — pass the state returned by the prior monitorPortfolio call of this build. Received ${received(raw['schemaVersion'])}.`,
      {
        code: ErrorCode.SnapshotUnsupportedVersion,
        context: { function: functionName, field: 'previousState.schemaVersion' },
      },
    );
  }
  requireEpochMsField(functionName, 'previousState.asOf', raw['asOf']);
  const previousAsOf = raw['asOf'] as EpochMs;
  if (previousAsOf >= asOf) {
    outOfRange(
      functionName,
      'previousState.asOf',
      `previousState.asOf (${previousAsOf}, ${epochMsToUtcDate(previousAsOf)}) must be before asOf (${asOf}, ${epochMsToUtcDate(asOf)}) — evaluations move forward in time; replaying an instant is a re-run from the state BEFORE it.`,
    );
  }
  const netAssetValue = requireFiniteOrNull(
    functionName,
    'previousState.netAssetValue',
    raw['netAssetValue'],
  );
  const peakNetAssetValue = requireFiniteOrNull(
    functionName,
    'previousState.peakNetAssetValue',
    raw['peakNetAssetValue'],
  );
  if (netAssetValue !== null && peakNetAssetValue === null) {
    outOfRange(
      functionName,
      'previousState.peakNetAssetValue',
      `previousState.peakNetAssetValue is null while netAssetValue is ${netAssetValue} — a valued evaluation always records its peak; this state was edited by hand.`,
    );
  }
  if (netAssetValue !== null && peakNetAssetValue !== null && peakNetAssetValue < netAssetValue) {
    outOfRange(
      functionName,
      'previousState.peakNetAssetValue',
      `previousState.peakNetAssetValue (${peakNetAssetValue}) must be ≥ netAssetValue (${netAssetValue}) — the peak includes the evaluation's own NAV.`,
    );
  }
  const evaluationCount = requireSafeIntegerAtLeast(
    functionName,
    'previousState.evaluationCount',
    raw['evaluationCount'],
    1,
  );
  requireArgumentObject(functionName, 'previousState.rules', raw['rules']);
  const rules: Record<string, MonitorRuleState> = {};
  for (const key of Object.keys(raw['rules'] as object).sort(compareKeys)) {
    const path = `previousState.rules['${key}']`;
    if (familyOfKey(key) === null) {
      outOfRange(
        functionName,
        path,
        `${path} is not a '<family>:<key>' rule identity of this build (families: ${MONITOR_ALERT_FAMILIES.join(', ')}).`,
      );
    }
    const entry = ownValue(raw['rules'] as Record<string, unknown>, key);
    requireArgumentObject(functionName, path, entry);
    ensureKnownKeys(functionName, path, entry as object, RULE_STATE_KEYS);
    const record = entry as Record<string, unknown>;
    const lastRaisedAtMs = record['lastRaisedAtMs'];
    if (lastRaisedAtMs !== null) {
      requireEpochMsField(functionName, `${path}.lastRaisedAtMs`, lastRaisedAtMs);
    }
    setOwnValue(rules, key, {
      active: requireBoolean(functionName, `${path}.active`, record['active']),
      consecutiveBreaches: requireSafeIntegerAtLeast(
        functionName,
        `${path}.consecutiveBreaches`,
        record['consecutiveBreaches'],
        0,
      ),
      lastRaisedAtMs: lastRaisedAtMs as EpochMs | null,
      acknowledged: requireBoolean(functionName, `${path}.acknowledged`, record['acknowledged']),
      lastValue: requireFiniteOrNull(functionName, `${path}.lastValue`, record['lastValue']),
    });
  }
  return {
    schemaVersion: PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION,
    asOf: previousAsOf,
    netAssetValue,
    peakNetAssetValue,
    evaluationCount,
    rules,
  };
}

function requireAcknowledgments(functionName: string, value: unknown): string[] {
  if (value === undefined) return [];
  requireArgumentArray(functionName, 'acknowledgments', value);
  const out = new Set<string>();
  (value as unknown[]).forEach((entry, index) => {
    requireIdentityString(functionName, `acknowledgments[${index}]`, entry);
    out.add(entry);
  });
  return [...out].sort(compareKeys);
}

function requireReconciliationResult(
  functionName: string,
  value: unknown,
  baseCurrency: string,
  asOf: EpochMs,
): ReconcilePortfolioResult {
  requireArgumentObject(functionName, 'reconciliation', value);
  ensureKnownKeys(functionName, 'reconciliation', value as object, RECONCILIATION_KEYS);
  const raw = value as Record<string, unknown>;
  requireEpochMsField(functionName, 'reconciliation.asOf', raw['asOf']);
  if ((raw['asOf'] as number) > asOf) {
    outOfRange(
      functionName,
      'reconciliation.asOf',
      `reconciliation.asOf (${epochMsToUtcDate(raw['asOf'] as number)}) is after asOf (${epochMsToUtcDate(asOf)}) — a monitor evaluates evidence at or before its instant.`,
    );
  }
  if (raw['baseCurrency'] !== baseCurrency) {
    outOfRange(
      functionName,
      'reconciliation.baseCurrency',
      `reconciliation.baseCurrency (${received(raw['baseCurrency'])}) must equal the portfolio's base currency (${baseCurrency}) — pass the reconcilePortfolio result for THIS portfolio.`,
    );
  }
  const reconciled = requireBoolean(functionName, 'reconciliation.reconciled', raw['reconciled']);
  const differenceCount = requireSafeIntegerAtLeast(
    functionName,
    'reconciliation.differenceCount',
    raw['differenceCount'],
    0,
  );
  const explainedCount = requireSafeIntegerAtLeast(
    functionName,
    'reconciliation.explainedCount',
    raw['explainedCount'],
    0,
  );
  if (explainedCount > differenceCount || reconciled !== (differenceCount === explainedCount)) {
    outOfRange(
      functionName,
      'reconciliation.reconciled',
      `reconciliation.reconciled (${reconciled}) disagrees with its counts (differenceCount ${differenceCount}, explainedCount ${explainedCount}) — reconcilePortfolio defines reconciled as differenceCount === explainedCount; this result was edited.`,
    );
  }
  requireArgumentArray(
    functionName,
    'reconciliation.suggestedCorrections',
    raw['suggestedCorrections'],
  );
  return value as ReconcilePortfolioResult;
}

function requirePnlResult(
  functionName: string,
  value: unknown,
  baseCurrency: string,
  asOf: EpochMs,
): PortfolioPnlResult {
  requireArgumentObject(functionName, 'pnl', value);
  ensureKnownKeys(functionName, 'pnl', value as object, PNL_KEYS);
  const raw = value as Record<string, unknown>;
  if (raw['baseCurrency'] !== baseCurrency) {
    outOfRange(
      functionName,
      'pnl.baseCurrency',
      `pnl.baseCurrency (${received(raw['baseCurrency'])}) must equal the portfolio's base currency (${baseCurrency}) — pass the portfolioPnl result for THIS portfolio.`,
    );
  }
  for (const end of ['from', 'to'] as const) {
    requireArgumentObject(functionName, `pnl.${end}`, raw[end]);
    const mark = raw[end] as Record<string, unknown>;
    requireEpochMsField(functionName, `pnl.${end}.asOf`, mark['asOf']);
    requireFiniteNumberField(functionName, `pnl.${end}.netAssetValue`, mark['netAssetValue']);
  }
  const fromAsOf = (raw['from'] as Record<string, unknown>)['asOf'] as number;
  const toAsOf = (raw['to'] as Record<string, unknown>)['asOf'] as number;
  if (toAsOf <= fromAsOf) {
    outOfRange(
      functionName,
      'pnl.to.asOf',
      `pnl.to.asOf (${epochMsToUtcDate(toAsOf)}) must be after pnl.from.asOf (${epochMsToUtcDate(fromAsOf)}).`,
    );
  }
  if (toAsOf > asOf) {
    outOfRange(
      functionName,
      'pnl.to.asOf',
      `pnl.to.asOf (${epochMsToUtcDate(toAsOf)}) is after asOf (${epochMsToUtcDate(asOf)}) — a monitor evaluates evidence at or before its instant.`,
    );
  }
  requireFiniteNumberField(functionName, 'pnl.residual', raw['residual']);
  requireFiniteNumberField(functionName, 'pnl.investmentReturn', raw['investmentReturn']);
  requireArgumentObject(functionName, 'pnl.components', raw['components']);
  requireFiniteNumberField(
    functionName,
    'pnl.components.totalPnl',
    (raw['components'] as Record<string, unknown>)['totalPnl'],
  );
  return value as PortfolioPnlResult;
}

function requireAverageDailyVolumes(
  functionName: string,
  value: unknown,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  requireArgumentObject(functionName, 'averageDailyVolumes', value);
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const instrumentId of Object.keys(raw).sort(compareKeys)) {
    requireIdentityString(functionName, 'averageDailyVolumes key', instrumentId);
    const path = `averageDailyVolumes['${instrumentId}']`;
    const volume = ownValue(raw, instrumentId);
    requirePositiveNumberField(functionName, path, volume, 'units traded per day');
    setOwnValue(out, instrumentId, volume);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Rule resolution and the state machine
// ---------------------------------------------------------------------------------------------------

function resolveRule(
  family: MonitorAlertFamily,
  override: MonitorRule | undefined,
  declared: { threshold: number | null; source: MonitorThresholdSource },
): ResolvedMonitorRule {
  const hysteresis = override?.hysteresis ?? null;
  const ruleThreshold = override?.threshold;
  const threshold = hysteresis !== null ? hysteresis.enter : (ruleThreshold ?? declared.threshold);
  const thresholdSource: MonitorThresholdSource =
    hysteresis !== null || ruleThreshold !== undefined ? 'rule' : declared.source;
  return {
    enabled: override?.enabled ?? true,
    threshold,
    thresholdSource,
    direction: override?.direction ?? FAMILY_DIRECTION[family],
    hysteresis: hysteresis === null ? null : { enter: hysteresis.enter, exit: hysteresis.exit },
    debounceEvaluations: override?.debounceEvaluations ?? 1,
    cooldownMs: override?.cooldownMs ?? 0,
    severity: override?.severity ?? FAMILY_SEVERITY[family],
  };
}

/** One keyed measurement a family produced. */
interface Observation {
  key: string;
  subject: string;
  value: number | null;
  /** The observation's own bound (a drift band, a group limit, the family limit); rule bounds win. */
  threshold: number | null;
  /** A missing mark breaches regardless of any threshold. */
  forcedBreach: boolean;
  /** Why the value is null / the breach is forced — surfaced in the alert and the warnings. */
  reason: string | null;
  /** Neutral prose of the measurement, composed into the alert message. */
  condition: string;
  evidence: Record<string, number | string | null>;
}

const FRESH_RULE_STATE: MonitorRuleState = {
  active: false,
  consecutiveBreaches: 0,
  lastRaisedAtMs: null,
  acknowledged: false,
  lastValue: null,
};

interface Transition {
  next: MonitorRuleState | null;
  alertState: MonitorAlertState | null;
  /** The bound the value was compared with (the exit bound while active under hysteresis). */
  bound: number | null;
  computable: boolean;
}

function transition(
  prior: MonitorRuleState | undefined,
  rule: ResolvedMonitorRule,
  observation: Observation,
  asOf: EpochMs,
  acknowledgedNow: boolean,
): Transition {
  const before = prior ?? FRESH_RULE_STATE;
  const bound =
    rule.hysteresis !== null
      ? before.active
        ? rule.hysteresis.exit
        : rule.hysteresis.enter
      : (rule.threshold ?? observation.threshold);
  let breach: boolean;
  if (observation.forcedBreach) {
    breach = true;
  } else if (observation.value === null || bound === null) {
    // Not computable: unknown is neither a breach nor a clear — the prior state is carried.
    return { next: prior ?? null, alertState: null, bound, computable: false };
  } else {
    breach = rule.direction === 'above' ? observation.value > bound : observation.value < bound;
  }
  const lastValue = observation.value;
  if (breach) {
    const consecutiveBreaches = before.consecutiveBreaches + 1;
    if (before.active) {
      const acknowledged = before.acknowledged || acknowledgedNow;
      return {
        next: {
          active: true,
          consecutiveBreaches,
          lastRaisedAtMs: before.lastRaisedAtMs,
          acknowledged,
          lastValue,
        },
        alertState: acknowledged ? 'acknowledged' : 'active',
        bound,
        computable: true,
      };
    }
    if (consecutiveBreaches < rule.debounceEvaluations) {
      return {
        next: { ...before, consecutiveBreaches, lastValue },
        alertState: null,
        bound,
        computable: true,
      };
    }
    if (before.lastRaisedAtMs !== null && asOf - before.lastRaisedAtMs < rule.cooldownMs) {
      return {
        next: { ...before, consecutiveBreaches, lastValue },
        alertState: 'suppressed',
        bound,
        computable: true,
      };
    }
    return {
      next: {
        active: true,
        consecutiveBreaches,
        lastRaisedAtMs: asOf,
        acknowledged: false,
        lastValue,
      },
      alertState: 'raised',
      bound,
      computable: true,
    };
  }
  if (before.active) {
    return {
      next: {
        active: false,
        consecutiveBreaches: 0,
        lastRaisedAtMs: before.lastRaisedAtMs,
        acknowledged: false,
        lastValue,
      },
      alertState: 'cleared',
      bound,
      computable: true,
    };
  }
  return {
    next: { ...before, consecutiveBreaches: 0, lastValue },
    alertState: null,
    bound,
    computable: true,
  };
}

// ---------------------------------------------------------------------------------------------------
// Valuation helpers
// ---------------------------------------------------------------------------------------------------

interface Holding {
  instrumentId: string;
  currency: string;
  quantity: number;
  accounts: string[];
  /** The instrument profile of the FIRST account's position (slice 5); later accounts must agree. */
  contractMultiplier: number;
  settlementStyle: SettlementStyle;
  contract: DerivativeContractTerms | null;
}

/**
 * Held instruments aggregated across accounts, sorted by instrument id. The fold guarantees one
 * profile per open position within an account; across accounts a disagreement (the same
 * instrument id with different terms) is reported as a warning and the first account's profile is
 * used — the contract-term families never guess between two sets of terms.
 */
function aggregateHoldings(state: PortfolioState, warnings: string[]): Holding[] {
  const byInstrument = new Map<string, Holding>();
  for (const accountId of Object.keys(state.accounts).sort(compareKeys)) {
    const account = ownValue(state.accounts, accountId)!;
    for (const instrumentId of Object.keys(account.positions).sort(compareKeys)) {
      const position = ownValue(account.positions, instrumentId)!;
      const existing = byInstrument.get(instrumentId);
      if (existing === undefined) {
        byInstrument.set(instrumentId, {
          instrumentId,
          currency: position.currency,
          quantity: position.quantity,
          accounts: [accountId],
          contractMultiplier: position.contractMultiplier,
          settlementStyle: position.settlementStyle,
          contract: position.contract ?? null,
        });
      } else {
        existing.quantity += position.quantity;
        existing.accounts.push(accountId);
        if (
          existing.contractMultiplier !== position.contractMultiplier ||
          existing.settlementStyle !== position.settlementStyle ||
          canonicalJsonOf(existing.contract) !== canonicalJsonOf(position.contract ?? null)
        ) {
          warnings.push(
            `account '${accountId}' holds ${instrumentId} under a different instrument profile (multiplier, settlement style, or contract terms) from account '${existing.accounts[0]}' — the contract-term families use account '${existing.accounts[0]}''s profile; reconcile the instrument ids.`,
          );
        }
      }
    }
  }
  return [...byInstrument.values()].sort((a, b) => compareKeys(a.instrumentId, b.instrumentId));
}

/** A spot usable as the mark of `instrumentId` in `currency`, or the reason it is not. */
function usableSpot(
  spots: NonNullable<MarketSnapshot['observations']['spots']>,
  instrumentId: string,
  currency: string,
): { price: number; reason: null } | { price: null; reason: string } {
  const spot = ownValue(spots, instrumentId);
  if (spot === undefined) {
    return {
      price: null,
      reason: `the market snapshot carries no observations.spots['${instrumentId}']`,
    };
  }
  if (spot.currency === undefined) {
    return {
      price: null,
      reason: `observations.spots['${instrumentId}'] states no currency (the position trades in ${currency})`,
    };
  }
  if (spot.currency !== currency) {
    return {
      price: null,
      reason: `observations.spots['${instrumentId}'] is quoted in ${spot.currency}, but the position trades in ${currency}`,
    };
  }
  return { price: spot.price, reason: null };
}

/** The state with every position removed — cash values without marks. */
function cashOnlyState(state: PortfolioState): PortfolioState {
  const accounts: Record<string, AccountState> = {};
  for (const accountId of Object.keys(state.accounts)) {
    setOwnValue(accounts, accountId, { ...ownValue(state.accounts, accountId)!, positions: {} });
  }
  return { ...state, accounts };
}

// ---------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------

/**
 * Evaluate one explicit valuation against the policy and the prior monitor state — see the module
 * comment for the decisions. Pure: same inputs, same alerts and state.
 *
 * @example
 * ```ts
 * import { monitorPortfolio } from '@totalfinance/portfolio/policy';
 *
 * const first = monitorPortfolio({
 *   portfolio: ledger.state,
 *   market,
 *   asOf: '2026-08-20',
 *   policy: { limits: { maximumPositionWeight: 0.25, maximumDrawdown: 0.1 } },
 *   previousState: null,
 * });
 * const next = monitorPortfolio({ ...sameInputs, asOf: '2026-08-21', previousState: first.state });
 * next.alerts; // [{ key: 'concentration-limit:AAPL', state: 'raised', value: 0.31, threshold: 0.25, … }]
 * ```
 */
export function monitorPortfolio(input: MonitorPortfolioInput): MonitorPortfolioResult {
  const functionName = 'monitorPortfolio';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requirePortfolioStateShape(functionName, 'portfolio', input.portfolio);
  if (input.asOf === undefined) {
    missingField(
      functionName,
      'asOf',
      `asOf is required — TotalFinance never reads the system clock, so the caller states the evaluation instant.\n  e.g. ${EXAMPLE_CALL}`,
    );
  }
  const asOf = resolveAsOf(input.asOf, functionName);
  requireEpochMsField(functionName, 'asOf', asOf);
  const { snapshot: market } = readMarketSnapshot({ snapshot: input.market });
  const quotes: CurrencyPairQuote[] = [];
  if (input.currencyConversions !== undefined) {
    requireArgumentArray(functionName, 'currencyConversions', input.currencyConversions);
    input.currencyConversions.forEach((quote, index) => {
      requireCurrencyPairQuoteShape(functionName, `currencyConversions[${index}]`, quote);
      quotes.push(quote);
    });
  }
  if (input.policy === undefined) {
    missingField(
      functionName,
      'policy',
      `policy is required — a monitor evaluates the caller's explicit goals; without a policy nothing is measured.\n  e.g. ${EXAMPLE_CALL}`,
    );
  }
  const policy = requireInvestmentPolicy(functionName, 'policy', input.policy);
  const classification = requireInstrumentClassification(
    functionName,
    input.instrumentClassification,
  );
  if (input.previousState === undefined) {
    missingField(
      functionName,
      'previousState',
      `previousState is required — pass the prior evaluation's state, or null for the FIRST evaluation. An omitted key would silently reset hysteresis, debounce, cooldown, acknowledgments, and the drawdown peak.\n  e.g. ${EXAMPLE_CALL}`,
    );
  }
  const previous =
    input.previousState === null
      ? null
      : requirePreviousMonitorState(functionName, input.previousState, asOf);
  const overrides = requireMonitorRules(functionName, input.rules);
  const acknowledgments = requireAcknowledgments(functionName, input.acknowledgments);
  const state = input.portfolio;
  const baseCurrency = state.baseCurrency;
  const reconciliation =
    input.reconciliation === undefined
      ? undefined
      : requireReconciliationResult(functionName, input.reconciliation, baseCurrency, asOf);
  const pnl =
    input.pnl === undefined
      ? undefined
      : requirePnlResult(functionName, input.pnl, baseCurrency, asOf);
  const volumes = requireAverageDailyVolumes(functionName, input.averageDailyVolumes);
  const stalenessLimitMs =
    input.marketStalenessLimitMs === undefined
      ? undefined
      : requireNonNegative(functionName, 'marketStalenessLimitMs', input.marketStalenessLimitMs);
  const unusualPnlThreshold =
    input.unusualPnlThreshold === undefined
      ? undefined
      : requireNonNegative(functionName, 'unusualPnlThreshold', input.unusualPnlThreshold);
  const residualTolerance =
    input.residualTolerance === undefined
      ? undefined
      : requireNonNegative(functionName, 'residualTolerance', input.residualTolerance);
  const optionExpirationWarningDays =
    input.optionExpirationWarningDays === undefined
      ? undefined
      : requireNonNegative(
          functionName,
          'optionExpirationWarningDays',
          input.optionExpirationWarningDays,
        );
  let assignmentRiskMoneyness: number | undefined;
  if (input.assignmentRiskMoneyness !== undefined) {
    requireFiniteNumberField(
      functionName,
      'assignmentRiskMoneyness',
      input.assignmentRiskMoneyness,
    );
    assignmentRiskMoneyness = input.assignmentRiskMoneyness;
  }

  const warnings: string[] = [];
  const limits = policy.limits ?? {};

  // ---- rules: defaults + policy limits + overrides ----
  const declaredThreshold = (
    value: number | undefined,
    source: 'policy' | 'input',
  ): { threshold: number | null; source: MonitorThresholdSource } =>
    value === undefined ? { threshold: null, source: 'none' } : { threshold: value, source };
  const rules: Record<MonitorAlertFamily, ResolvedMonitorRule> = {
    'allocation-drift': resolveRule('allocation-drift', overrides['allocation-drift'], {
      threshold: null,
      source: 'per-observation',
    }),
    'concentration-limit': resolveRule(
      'concentration-limit',
      overrides['concentration-limit'],
      declaredThreshold(limits.maximumPositionWeight, 'policy'),
    ),
    'leverage-limit': resolveRule(
      'leverage-limit',
      overrides['leverage-limit'],
      declaredThreshold(limits.maximumGrossLeverage, 'policy'),
    ),
    drawdown: resolveRule(
      'drawdown',
      overrides['drawdown'],
      declaredThreshold(limits.maximumDrawdown, 'policy'),
    ),
    'daily-loss': resolveRule(
      'daily-loss',
      overrides['daily-loss'],
      declaredThreshold(limits.maximumDailyLoss, 'policy'),
    ),
    'cash-reserve': resolveRule('cash-reserve', overrides['cash-reserve'], {
      threshold: null,
      source:
        policy.minimumCash !== undefined || policy.minimumCashWeight !== undefined
          ? 'policy'
          : 'none',
    }),
    'margin-pressure': resolveRule(
      'margin-pressure',
      overrides['margin-pressure'],
      declaredThreshold(limits.minimumSettledCash, 'policy'),
    ),
    liquidity: resolveRule(
      'liquidity',
      overrides['liquidity'],
      declaredThreshold(limits.maximumDaysToLiquidate, 'policy'),
    ),
    'option-expiration': resolveRule(
      'option-expiration',
      overrides['option-expiration'],
      declaredThreshold(optionExpirationWarningDays, 'input'),
    ),
    'assignment-risk': resolveRule(
      'assignment-risk',
      overrides['assignment-risk'],
      declaredThreshold(assignmentRiskMoneyness, 'input'),
    ),
    'stale-market-data': resolveRule(
      'stale-market-data',
      overrides['stale-market-data'],
      declaredThreshold(stalenessLimitMs, 'input'),
    ),
    'reconciliation-difference': resolveRule(
      'reconciliation-difference',
      overrides['reconciliation-difference'],
      { threshold: 0, source: 'input' },
    ),
    'unexplained-residual': resolveRule(
      'unexplained-residual',
      overrides['unexplained-residual'],
      declaredThreshold(residualTolerance, 'input'),
    ),
    'unusual-pnl': resolveRule(
      'unusual-pnl',
      overrides['unusual-pnl'],
      declaredThreshold(unusualPnlThreshold, 'input'),
    ),
  };
  const ruleDeclaresThreshold = (family: MonitorAlertFamily): boolean =>
    rules[family].thresholdSource === 'rule';

  // ---- holdings and marks: which instruments can be valued ----
  const holdings = aggregateHoldings(state, warnings);
  const spots = market.observations.spots ?? {};
  const unusable = new Map<string, string>();
  for (const holding of holdings) {
    const { reason } = usableSpot(spots, holding.instrumentId, holding.currency);
    if (reason !== null) unusable.set(holding.instrumentId, reason);
  }
  const snapshotInput = {
    asOf,
    market: input.market,
    ...(input.currencyConversions !== undefined
      ? { currencyConversions: input.currencyConversions }
      : {}),
  };
  let valued: PortfolioSnapshotResult | null = null;
  let cashRows: PortfolioSnapshotCashRow[];
  let totalCash: number;
  if (unusable.size === 0) {
    valued = portfolioSnapshot({ portfolio: state, ...snapshotInput });
    cashRows = valued.cash;
    totalCash = valued.totalCashBaseCurrencyValue;
    warnings.push(...valued.diagnostics.warnings);
  } else {
    // Marks are missing: value the cash side alone (it needs quotes, never marks) so the
    // cash-only families still evaluate; the weight-based families are skipped as unvalued.
    const cashOnly = portfolioSnapshot({ portfolio: cashOnlyState(state), ...snapshotInput });
    cashRows = cashOnly.cash;
    totalCash = cashOnly.totalCashBaseCurrencyValue;
    warnings.push(...cashOnly.diagnostics.warnings);
  }
  const netAssetValue = valued === null ? null : valued.netAssetValue;
  const unvaluedReason =
    unusable.size === 0
      ? null
      : `unvalued: ${unusable.size} held instrument${unusable.size === 1 ? '' : 's'} (${[...unusable.keys()].join(', ')}) ${unusable.size === 1 ? 'has' : 'have'} no usable mark — see the stale-market-data alerts`;
  const navReason =
    netAssetValue !== null && netAssetValue <= 0
      ? `net asset value ${netAssetValue} is not positive; weights of NAV are undefined`
      : null;

  // Per-instrument base-currency NOTIONAL (the exposure every weight is built on) and the NAV
  // contribution (market value — the unsettled P&L for a variation-margin position), aggregated
  // across accounts. Weights are signed notional ÷ NAV.
  const notionalByInstrument = new Map<string, number>();
  const valueByInstrument = new Map<string, number>();
  if (valued !== null) {
    for (const row of valued.positions) {
      notionalByInstrument.set(
        row.instrumentId,
        (notionalByInstrument.get(row.instrumentId) ?? 0) + row.baseCurrencyNotionalValue,
      );
      valueByInstrument.set(
        row.instrumentId,
        (valueByInstrument.get(row.instrumentId) ?? 0) + row.baseCurrencyMarketValue,
      );
    }
  }
  const weightOf = (instrumentId: string): number =>
    netAssetValue === null || netAssetValue <= 0
      ? 0
      : (notionalByInstrument.get(instrumentId) ?? 0) / netAssetValue;
  const cashWeight = netAssetValue === null || netAssetValue <= 0 ? 0 : totalCash / netAssetValue;
  const currentWeights: Record<string, number> = {};
  const instrumentCurrency: Record<string, string> = {};
  for (const holding of holdings) {
    setOwnValue(currentWeights, holding.instrumentId, weightOf(holding.instrumentId));
    setOwnValue(instrumentCurrency, holding.instrumentId, holding.currency);
  }
  const universe = [
    ...new Set([...holdings.map((h) => h.instrumentId), ...(policy.allowedInstruments ?? [])]),
  ].sort(compareKeys);
  const expansionInput = (targets: Parameters<typeof expandTargets>[1]['targets']) => ({
    targets,
    universe,
    instrumentClassification: classification,
    instrumentCurrency,
    currentWeights,
    sleeves: policy.model?.sleeves ?? [],
    withinGroupAllocation: policy.withinGroupAllocation,
    defaultDriftBand: policy.driftBand,
  });
  const declaredSleeves = new Set((policy.model?.sleeves ?? []).map((s) => s.sleeveId));

  // Drawdown peak: the current NAV joins the peak before the drawdown is measured.
  const priorPeak = previous?.peakNetAssetValue ?? null;
  const peakNetAssetValue =
    netAssetValue === null
      ? priorPeak
      : priorPeak === null
        ? netAssetValue
        : Math.max(priorPeak, netAssetValue);

  // ---- family evaluation ----
  const evaluations: MonitorFamilyEvaluation[] = [];
  const observations = new Map<MonitorAlertFamily, Observation[]>();
  const skip = (family: MonitorAlertFamily, reason: string): void => {
    evaluations.push({ family, status: 'skipped', observationCount: 0, reason });
  };
  const evaluate = (family: MonitorAlertFamily, list: Observation[]): void => {
    const seen = new Set<string>();
    for (const observation of list) {
      if (seen.has(observation.key)) {
        outOfRange(
          functionName,
          'portfolio',
          `${family} observed the key '${observation.key}' twice — an instrument id that spells like a group key ('<dimension>:<value>') collides with the group; rename the instrument or the group.`,
        );
      }
      seen.add(observation.key);
    }
    observations.set(family, list);
    evaluations.push({ family, status: 'evaluated', observationCount: list.length });
  };
  const gate = (family: MonitorAlertFamily, needsValuation: boolean): boolean => {
    if (!rules[family].enabled) {
      skip(family, `rules['${family}'].enabled is false`);
      return false;
    }
    if (needsValuation && unvaluedReason !== null) {
      skip(family, unvaluedReason);
      return false;
    }
    if (needsValuation && navReason !== null) {
      skip(family, navReason);
      return false;
    }
    return true;
  };

  // allocation-drift
  if (policy.targets === undefined && policy.model === undefined) {
    if (rules['allocation-drift'].enabled) {
      skip('allocation-drift', 'policy declares no targets (policy.targets or policy.model)');
    } else {
      skip('allocation-drift', "rules['allocation-drift'].enabled is false");
    }
  } else if (gate('allocation-drift', true)) {
    const rule = rules['allocation-drift'];
    const resolved = resolvePolicyTargets(functionName, policy, asOf);
    const expanded = expandTargets(functionName, expansionInput(resolved.targets));
    warnings.push(...expanded.warnings.map((w) => `allocation-drift: ${w}`));
    for (const item of expanded.unresolved) {
      warnings.push(`allocation-drift: target '${item.key}' is unresolved — ${item.reason}`);
    }
    const anyBand =
      expanded.instrumentTargets.some((t) => t.driftBand !== null) ||
      expanded.groupTargets.some((g) => g.driftBand !== null) ||
      (expanded.cashTarget?.driftBand ?? null) !== null;
    if (!ruleDeclaresThreshold('allocation-drift') && !anyBand) {
      skip(
        'allocation-drift',
        'policy declares no driftBand (and no target declares its own) — a band is the goal a drift alert measures against',
      );
    } else {
      const list: Observation[] = [];
      const bandless: string[] = [];
      const useHysteresis = rule.hysteresis !== null;
      for (const target of expanded.instrumentTargets) {
        const band = rule.threshold ?? target.driftBand;
        if (band === null && !useHysteresis) {
          bandless.push(target.instrumentId);
          continue;
        }
        const current = weightOf(target.instrumentId);
        const drift = Math.abs(current - target.targetWeight);
        list.push({
          key: target.instrumentId,
          subject: `instrument ${target.instrumentId}`,
          value: drift,
          threshold: band,
          forcedBreach: false,
          reason: null,
          condition: `${target.instrumentId} weighs ${pretty(current)} of NAV against a target of ${pretty(target.targetWeight)} (drift ${pretty(drift)}, band ${pretty(band)})`,
          evidence: {
            currentWeight: current,
            targetWeight: target.targetWeight,
            drift,
            driftBand: band,
            sourceGroups: target.sourceGroups.length === 0 ? null : target.sourceGroups.join(', '),
            implied: target.implied ? 'yes' : 'no',
            targetSource: resolved.source,
          },
        });
      }
      for (const group of expanded.groupTargets) {
        // An instrumentId group IS the instrument target above; the cash target compares cash.
        if (group.group.instrumentId !== undefined) continue;
        const band = rule.threshold ?? group.driftBand;
        if (band === null && !useHysteresis) {
          bandless.push(group.key);
          continue;
        }
        const current = isCashTargetGroup(group.group)
          ? cashWeight
          : stableSum(group.members.map((id) => weightOf(id)));
        const drift = Math.abs(current - group.targetWeight);
        list.push({
          key: group.key,
          subject: `group ${group.key}`,
          value: drift,
          threshold: band,
          forcedBreach: false,
          reason: null,
          condition: `group ${group.key} weighs ${pretty(current)} of NAV against a target of ${pretty(group.targetWeight)} (drift ${pretty(drift)}, band ${pretty(band)})`,
          evidence: {
            currentWeight: current,
            targetWeight: group.targetWeight,
            drift,
            driftBand: band,
            members: group.members.length === 0 ? null : group.members.join(', '),
            memberCount: group.members.length,
            targetSource: resolved.source,
          },
        });
      }
      if (bandless.length > 0) {
        warnings.push(
          `allocation-drift: no drift band for ${bandless.join(', ')} — declare policy.driftBand or a per-target driftBand to monitor ${bandless.length === 1 ? 'it' : 'them'}.`,
        );
      }
      evaluate('allocation-drift', list);
    }
  }

  // concentration-limit
  {
    const family = 'concentration-limit';
    const groupLimits = limits.maximumGroupWeights ?? [];
    if (
      limits.maximumPositionWeight === undefined &&
      groupLimits.length === 0 &&
      !ruleDeclaresThreshold(family)
    ) {
      if (rules[family].enabled) {
        skip(
          family,
          'policy declares no limits.maximumPositionWeight or limits.maximumGroupWeights',
        );
      } else {
        skip(family, `rules['${family}'].enabled is false`);
      }
    } else if (gate(family, true)) {
      const rule = rules[family];
      const list: Observation[] = [];
      const positionLimit = rule.threshold ?? limits.maximumPositionWeight ?? null;
      if (positionLimit !== null || rule.hysteresis !== null) {
        for (const holding of holdings) {
          const weight = weightOf(holding.instrumentId);
          const absolute = Math.abs(weight);
          list.push({
            key: holding.instrumentId,
            subject: `instrument ${holding.instrumentId}`,
            value: absolute,
            threshold: positionLimit,
            forcedBreach: false,
            reason: null,
            condition: `${holding.instrumentId} weighs ${pretty(absolute)} of NAV by notional against maximumPositionWeight ${pretty(positionLimit)}`,
            evidence: {
              weight,
              absoluteWeight: absolute,
              baseCurrencyNotionalValue: notionalByInstrument.get(holding.instrumentId) ?? 0,
              baseCurrencyMarketValue: valueByInstrument.get(holding.instrumentId) ?? 0,
              settlementStyle: holding.settlementStyle,
              netAssetValue,
              maximumPositionWeight: positionLimit,
              accounts: holding.accounts.join(', '),
            },
          });
        }
      }
      if (groupLimits.length > 0) {
        const usable = groupLimits.filter((limit) => {
          if (limit.group.sleeveId !== undefined && !declaredSleeves.has(limit.group.sleeveId)) {
            warnings.push(
              `${family}: limits.maximumGroupWeights names sleeve '${limit.group.sleeveId}', which policy.model declares no sleeve for — the group cannot be resolved and is not monitored.`,
            );
            return false;
          }
          return true;
        });
        // Membership through the ONE resolution law: zero-weight synthetic targets expand to the
        // same member lists a real target would (sleeve tree, classification, currency).
        const membership = expandTargets(
          functionName,
          expansionInput(usable.map((limit) => ({ group: limit.group, weight: 0 }))),
        );
        for (const limit of usable) {
          const key = targetGroupKey(limit.group);
          const group = membership.groupTargets.find((g) => g.key === key);
          const members = group?.members ?? [];
          const signed = isCashTargetGroup(limit.group)
            ? cashWeight
            : stableSum(members.map((id) => weightOf(id)));
          const absolute = Math.abs(signed);
          const bound = rule.threshold ?? limit.maximumWeight;
          list.push({
            key,
            subject: `group ${key}`,
            value: absolute,
            threshold: bound,
            forcedBreach: false,
            reason: null,
            condition: `group ${key} weighs ${pretty(absolute)} of NAV against its maximumWeight ${pretty(bound)}`,
            evidence: {
              weight: signed,
              absoluteWeight: absolute,
              maximumWeight: bound,
              members: members.length === 0 ? null : members.join(', '),
              memberCount: members.length,
              netAssetValue,
            },
          });
        }
      }
      evaluate(family, list);
    }
  }

  // leverage-limit
  {
    const family = 'leverage-limit';
    if (limits.maximumGrossLeverage === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) skip(family, 'policy declares no limits.maximumGrossLeverage');
      else skip(family, `rules['${family}'].enabled is false`);
    } else if (gate(family, true)) {
      const values = [...notionalByInstrument.values()];
      const long = stableSum(values.map((v) => Math.max(0, v)));
      const short = stableSum(values.map((v) => Math.max(0, -v)));
      const gross = long + short;
      const nav = netAssetValue!;
      const leverage = gross / nav;
      const bound = rules[family].threshold;
      evaluate(family, [
        {
          key: 'portfolio',
          subject: 'portfolio',
          value: leverage,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `gross notional exposure ${pretty(gross)} ÷ NAV ${pretty(nav)} = ${pretty(leverage)} against maximumGrossLeverage ${pretty(bound)}`,
          evidence: {
            grossExposure: gross,
            longExposure: long,
            shortExposure: short,
            netExposure: long - short,
            exposureBasis: 'baseCurrencyNotionalValue',
            netAssetValue: nav,
            maximumGrossLeverage: bound,
          },
        },
      ]);
    }
  }

  // drawdown
  {
    const family = 'drawdown';
    if (limits.maximumDrawdown === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) skip(family, 'policy declares no limits.maximumDrawdown');
      else skip(family, `rules['${family}'].enabled is false`);
    } else if (rules[family].enabled && unvaluedReason !== null) {
      skip(family, unvaluedReason);
    } else if (gate(family, false)) {
      const nav = netAssetValue!;
      const peak = peakNetAssetValue!;
      if (peak <= 0) {
        skip(
          family,
          `peak net asset value ${peak} is not positive; a drawdown from it is undefined`,
        );
      } else {
        const drawdown = 1 - nav / peak;
        const bound = rules[family].threshold;
        evaluate(family, [
          {
            key: 'portfolio',
            subject: 'portfolio',
            value: drawdown,
            threshold: bound,
            forcedBreach: false,
            reason: null,
            condition: `NAV ${pretty(nav)} is ${pretty(drawdown)} below its peak ${pretty(peak)} against maximumDrawdown ${pretty(bound)}`,
            evidence: {
              netAssetValue: nav,
              peakNetAssetValue: peak,
              drawdown,
              maximumDrawdown: bound,
            },
          },
        ]);
      }
    }
  }

  // daily-loss
  {
    const family = 'daily-loss';
    if (limits.maximumDailyLoss === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) skip(family, 'policy declares no limits.maximumDailyLoss');
      else skip(family, `rules['${family}'].enabled is false`);
    } else if (rules[family].enabled && unvaluedReason !== null) {
      skip(family, unvaluedReason);
    } else if (gate(family, false)) {
      if (previous === null) {
        skip(
          family,
          'first evaluation — there is no previous net asset value to measure a loss from',
        );
      } else if (previous.netAssetValue === null) {
        skip(
          family,
          `the previous evaluation (${epochMsToUtcDate(previous.asOf)}) was unvalued — there is no previous net asset value to measure a loss from`,
        );
      } else if (previous.netAssetValue <= 0) {
        skip(
          family,
          `the previous net asset value ${previous.netAssetValue} is not positive; a loss fraction of it is undefined`,
        );
      } else {
        const nav = netAssetValue!;
        const before = previous.netAssetValue;
        const loss = (before - nav) / before;
        const bound = rules[family].threshold;
        evaluate(family, [
          {
            key: 'portfolio',
            subject: 'portfolio',
            value: loss,
            threshold: bound,
            forcedBreach: false,
            reason: null,
            condition: `NAV moved from ${pretty(before)} (${epochMsToUtcDate(previous.asOf)}) to ${pretty(nav)}, a loss of ${pretty(loss)} against maximumDailyLoss ${pretty(bound)}`,
            evidence: {
              previousNetAssetValue: before,
              previousAsOf: previous.asOf,
              netAssetValue: nav,
              change: nav - before,
              loss,
              maximumDailyLoss: bound,
            },
          },
        ]);
      }
    }
  }

  // cash-reserve
  {
    const family = 'cash-reserve';
    const rule = rules[family];
    if (
      policy.minimumCash === undefined &&
      policy.minimumCashWeight === undefined &&
      !ruleDeclaresThreshold(family)
    ) {
      if (rule.enabled) skip(family, 'policy declares no minimumCash or minimumCashWeight');
      else skip(family, `rules['${family}'].enabled is false`);
    } else if (!rule.enabled) {
      skip(family, `rules['${family}'].enabled is false`);
    } else {
      const fromWeight =
        policy.minimumCashWeight === undefined
          ? null
          : netAssetValue === null
            ? undefined
            : policy.minimumCashWeight * netAssetValue;
      if (fromWeight === undefined && rule.threshold === null && policy.minimumCash === undefined) {
        skip(
          family,
          `${unvaluedReason ?? 'unvalued'} — minimumCashWeight needs NAV; declare minimumCash to monitor an absolute floor without marks`,
        );
      } else {
        if (fromWeight === undefined) {
          warnings.push(
            `${family}: minimumCashWeight cannot be applied while the portfolio is unvalued; only minimumCash is enforced this evaluation.`,
          );
        }
        const candidates: { floor: number; source: string }[] = [];
        if (policy.minimumCash !== undefined) {
          candidates.push({ floor: policy.minimumCash, source: 'minimumCash' });
        }
        if (fromWeight !== null && fromWeight !== undefined) {
          candidates.push({ floor: fromWeight, source: 'minimumCashWeight' });
        }
        const binding =
          candidates.length === 0
            ? null
            : candidates.reduce((best, c) => (c.floor > best.floor ? c : best));
        const bound = rule.threshold ?? binding?.floor ?? null;
        rules[family] = {
          ...rule,
          threshold: bound,
          thresholdSource: rule.thresholdSource === 'rule' ? 'rule' : 'policy',
        };
        evaluate(family, [
          {
            key: 'portfolio',
            subject: 'portfolio',
            value: totalCash,
            threshold: bound,
            forcedBreach: false,
            reason: null,
            condition: `cash ${pretty(totalCash)} ${baseCurrency} against a reserve floor of ${pretty(bound)} ${baseCurrency}${binding === null ? '' : ` (binding: ${binding.source})`}`,
            evidence: {
              cash: totalCash,
              baseCurrency,
              minimumCash: policy.minimumCash ?? null,
              minimumCashWeight: policy.minimumCashWeight ?? null,
              minimumCashFromWeight: fromWeight ?? null,
              netAssetValue,
              bindingFloor: rule.threshold !== null ? 'rule' : (binding?.source ?? null),
              floor: bound,
            },
          },
        ]);
      }
    }
  }

  // margin-pressure
  {
    const family = 'margin-pressure';
    if (limits.minimumSettledCash === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) skip(family, 'policy declares no limits.minimumSettledCash');
      else skip(family, `rules['${family}'].enabled is false`);
    } else if (gate(family, false)) {
      let settled = 0;
      let receivable = 0;
      let payable = 0;
      for (const row of cashRows) {
        const toBase = (amount: number, subject: string): number =>
          row.currency === baseCurrency
            ? amount
            : convertWithQuotes({
                functionName,
                amount,
                fromCurrency: row.currency,
                toCurrency: baseCurrency,
                quotes,
                subject,
              }).convertedAmount;
        settled += toBase(
          row.settledAmount,
          `account '${row.accountId}' ${row.currency} settled cash`,
        );
        receivable += toBase(
          row.unsettledReceivable,
          `account '${row.accountId}' ${row.currency} receivable`,
        );
        payable += toBase(
          row.unsettledPayable,
          `account '${row.accountId}' ${row.currency} payable`,
        );
      }
      const bound = rules[family].threshold;
      evaluate(family, [
        {
          key: 'portfolio',
          subject: 'portfolio',
          value: settled,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `settled cash ${pretty(settled)} ${baseCurrency} against minimumSettledCash ${pretty(bound)} ${baseCurrency}`,
          evidence: {
            settledCash: settled,
            totalCash,
            unsettledReceivable: receivable,
            unsettledPayable: payable,
            baseCurrency,
            minimumSettledCash: bound,
          },
        },
      ]);
    }
  }

  // liquidity
  {
    const family = 'liquidity';
    if (limits.maximumDaysToLiquidate === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) skip(family, 'policy declares no limits.maximumDaysToLiquidate');
      else skip(family, `rules['${family}'].enabled is false`);
    } else if (gate(family, false)) {
      if (volumes === undefined) {
        skip(
          family,
          'no averageDailyVolumes supplied — days to liquidate need a daily volume per instrument',
        );
      } else {
        const list: Observation[] = [];
        const missing: string[] = [];
        const bound = rules[family].threshold;
        for (const holding of holdings) {
          const volume = ownValue(volumes, holding.instrumentId);
          if (volume === undefined) {
            missing.push(holding.instrumentId);
            continue;
          }
          const quantity = Math.abs(holding.quantity);
          const days = quantity / (volume * MONITOR_LIQUIDITY_PARTICIPATION_RATE);
          list.push({
            key: holding.instrumentId,
            subject: `instrument ${holding.instrumentId}`,
            value: days,
            threshold: bound,
            forcedBreach: false,
            reason: null,
            condition: `${pretty(quantity)} ${holding.instrumentId} at ${pretty(volume)} units/day × ${MONITOR_LIQUIDITY_PARTICIPATION_RATE} participation takes ${pretty(days)} days against maximumDaysToLiquidate ${pretty(bound)}`,
            evidence: {
              quantity: holding.quantity,
              averageDailyVolume: volume,
              participationRate: MONITOR_LIQUIDITY_PARTICIPATION_RATE,
              daysToLiquidate: days,
              maximumDaysToLiquidate: bound,
            },
          });
        }
        if (missing.length > 0) {
          warnings.push(
            `${family}: no averageDailyVolumes entry for ${missing.join(', ')} — days to liquidate ${missing.length === 1 ? 'is' : 'are'} not computable for ${missing.length === 1 ? 'it' : 'them'}.`,
          );
        }
        evaluate(family, list);
      }
    }
  }

  // The option positions (aggregated across accounts) — the two contract-term families below
  // read the terms the fold carried from the opening fill; neither needs the portfolio valued.
  const optionHoldings = holdings.flatMap((holding) =>
    holding.contract !== null && holding.contract.kind === 'option'
      ? [{ holding, contract: holding.contract }]
      : [],
  );
  const describeOption = (holding: Holding, contract: OptionContractTerms): string =>
    `${holding.instrumentId} (${pretty(holding.quantity)} × ${contract.underlyingInstrumentId} ${contract.type} ${pretty(contract.strikePricePerUnit)} expiring ${epochMsToUtcDate(contract.expiryTimestampMs)})`;

  // option-expiration
  {
    const family = 'option-expiration';
    if (optionExpirationWarningDays === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) {
        skip(
          family,
          'no optionExpirationWarningDays supplied — how many days before expiry count as near is a goal, not a default',
        );
      } else {
        skip(family, `rules['${family}'].enabled is false`);
      }
    } else if (gate(family, false)) {
      const list: Observation[] = [];
      const bound = rules[family].threshold;
      for (const { holding, contract } of optionHoldings) {
        const daysToExpiry = (contract.expiryTimestampMs - asOf) / MS_PER_DAY;
        const underlying = usableSpot(spots, contract.underlyingInstrumentId, holding.currency);
        const when =
          daysToExpiry < 0
            ? `expired ${pretty(-daysToExpiry)} days before asOf with no lifecycle event recorded`
            : `expires in ${pretty(daysToExpiry)} days`;
        list.push({
          key: holding.instrumentId,
          subject: `instrument ${holding.instrumentId}`,
          value: daysToExpiry,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `${describeOption(holding, contract)} ${when} against optionExpirationWarningDays ${pretty(bound)}`,
          evidence: {
            expiryDate: epochMsToUtcDate(contract.expiryTimestampMs),
            expiryTimestampMs: contract.expiryTimestampMs,
            daysToExpiry,
            quantity: holding.quantity,
            contractMultiplier: holding.contractMultiplier,
            type: contract.type,
            strikePricePerUnit: contract.strikePricePerUnit,
            underlyingInstrumentId: contract.underlyingInstrumentId,
            underlyingMark: underlying.price,
            optionExpirationWarningDays: bound,
            accounts: holding.accounts.join(', '),
          },
        });
      }
      evaluate(family, list);
    }
  }

  // assignment-risk
  {
    const family = 'assignment-risk';
    if (assignmentRiskMoneyness === undefined && !ruleDeclaresThreshold(family)) {
      if (rules[family].enabled) {
        skip(
          family,
          'no assignmentRiskMoneyness supplied — the moneyness at which a short option counts as at risk of assignment is a goal, not a default',
        );
      } else {
        skip(family, `rules['${family}'].enabled is false`);
      }
    } else if (gate(family, false)) {
      const list: Observation[] = [];
      const bound = rules[family].threshold;
      for (const { holding, contract } of optionHoldings) {
        if (holding.quantity >= 0) continue; // only a WRITER can be assigned
        const daysToExpiry = (contract.expiryTimestampMs - asOf) / MS_PER_DAY;
        const strike = contract.strikePricePerUnit;
        const underlying = usableSpot(spots, contract.underlyingInstrumentId, holding.currency);
        const base = {
          key: holding.instrumentId,
          subject: `instrument ${holding.instrumentId}`,
          threshold: bound,
        };
        const evidence = {
          underlyingInstrumentId: contract.underlyingInstrumentId,
          underlyingMark: underlying.price,
          strikePricePerUnit: strike,
          type: contract.type,
          daysToExpiry,
          expiryDate: epochMsToUtcDate(contract.expiryTimestampMs),
          quantity: holding.quantity,
          contractMultiplier: holding.contractMultiplier,
          assignmentRiskMoneyness: bound,
          accounts: holding.accounts.join(', '),
        };
        if (underlying.price === null) {
          // The stale-market-data law: a missing mark is an alert, not a crash, and not a guess.
          list.push({
            ...base,
            value: null,
            forcedBreach: true,
            reason: underlying.reason,
            condition: `short ${describeOption(holding, contract)} cannot be measured for assignment risk — ${underlying.reason}`,
            evidence: { ...evidence, moneyness: null, reason: underlying.reason },
          });
          continue;
        }
        if (strike <= 0) {
          const reason = `strikePricePerUnit ${strike} is not positive; moneyness as a fraction of the strike is undefined`;
          list.push({
            ...base,
            value: null,
            forcedBreach: false,
            reason,
            condition: `short ${describeOption(holding, contract)} — ${reason}`,
            evidence: { ...evidence, moneyness: null, reason },
          });
          continue;
        }
        const moneyness =
          contract.type === 'call'
            ? (underlying.price - strike) / strike
            : (strike - underlying.price) / strike;
        list.push({
          ...base,
          value: moneyness,
          forcedBreach: false,
          reason: null,
          condition: `short ${describeOption(holding, contract)} is ${pretty(Math.abs(moneyness))} ${moneyness >= 0 ? 'in' : 'out of'} the money at ${contract.underlyingInstrumentId} ${pretty(underlying.price)} against assignmentRiskMoneyness ${pretty(bound)}`,
          evidence: { ...evidence, moneyness, reason: null },
        });
      }
      evaluate(family, list);
    }
  }

  // stale-market-data
  {
    const family = 'stale-market-data';
    const rule = rules[family];
    if (!rule.enabled) {
      skip(family, `rules['${family}'].enabled is false`);
    } else if (
      stalenessLimitMs === undefined &&
      !ruleDeclaresThreshold(family) &&
      unusable.size === 0
    ) {
      skip(
        family,
        'no marketStalenessLimitMs supplied and every held instrument has a usable mark — mark age is measured only against a declared limit',
      );
    } else {
      const list: Observation[] = [];
      const bound = rule.threshold;
      for (const holding of holdings) {
        const reason = unusable.get(holding.instrumentId);
        if (reason !== undefined) {
          list.push({
            key: holding.instrumentId,
            subject: `instrument ${holding.instrumentId}`,
            value: null,
            threshold: bound,
            forcedBreach: true,
            reason,
            condition: `${holding.instrumentId} cannot be marked — ${reason}`,
            evidence: {
              reason,
              markTimestampMs: null,
              marketAsOf: market.asOf,
              ageMs: null,
              marketStalenessLimitMs: bound,
              quantity: holding.quantity,
            },
          });
          continue;
        }
        if (bound === null && rule.hysteresis === null) continue;
        const spot = ownValue(spots, holding.instrumentId)!;
        const markTimestampMs = spot.timestampMs ?? market.asOf;
        const ageMs = asOf - markTimestampMs;
        list.push({
          key: holding.instrumentId,
          subject: `instrument ${holding.instrumentId}`,
          value: ageMs,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `the ${holding.instrumentId} mark is ${pretty(ageMs)} ms old (observed ${markTimestampMs}) against marketStalenessLimitMs ${pretty(bound)}`,
          evidence: {
            reason: null,
            markTimestampMs,
            marketAsOf: market.asOf,
            ageMs,
            marketStalenessLimitMs: bound,
            quantity: holding.quantity,
            markSource: spot.timestampMs === undefined ? 'snapshot asOf' : 'spot.timestampMs',
          },
        });
      }
      evaluate(family, list);
    }
  }

  // reconciliation-difference
  {
    const family = 'reconciliation-difference';
    if (!rules[family].enabled) {
      skip(family, `rules['${family}'].enabled is false`);
    } else if (reconciliation === undefined) {
      skip(
        family,
        'no reconciliation result supplied — pass reconcilePortfolio’s result to monitor it',
      );
    } else {
      const unexplained = reconciliation.differenceCount - reconciliation.explainedCount;
      const bound = rules[family].threshold;
      evaluate(family, [
        {
          key: 'portfolio',
          subject: 'portfolio',
          value: unexplained,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `reconciliation at ${epochMsToUtcDate(reconciliation.asOf)} reports ${reconciliation.differenceCount} difference${reconciliation.differenceCount === 1 ? '' : 's'}, ${reconciliation.explainedCount} explained (${unexplained} unexplained against a tolerance of ${pretty(bound)})`,
          evidence: {
            reconciled: reconciliation.reconciled ? 'true' : 'false',
            differenceCount: reconciliation.differenceCount,
            explainedCount: reconciliation.explainedCount,
            unexplainedCount: unexplained,
            reconciliationAsOf: reconciliation.asOf,
            suggestedCorrectionCount: reconciliation.suggestedCorrections.length,
          },
        },
      ]);
    }
  }

  // unexplained-residual
  {
    const family = 'unexplained-residual';
    if (!rules[family].enabled) {
      skip(family, `rules['${family}'].enabled is false`);
    } else if (pnl === undefined) {
      skip(family, 'no pnl result supplied — pass portfolioPnl’s result to monitor its residual');
    } else if (residualTolerance === undefined && !ruleDeclaresThreshold(family)) {
      skip(
        family,
        'no residualTolerance supplied — the tolerated residual is a goal, not a default',
      );
    } else {
      const magnitude = Math.abs(pnl.residual);
      const bound = rules[family].threshold;
      evaluate(family, [
        {
          key: 'portfolio',
          subject: 'portfolio',
          value: magnitude,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `the P&L identity over ${pnl.from.valuationDate} → ${pnl.to.valuationDate} leaves ${pretty(pnl.residual)} ${baseCurrency} unexplained against residualTolerance ${pretty(bound)}`,
          evidence: {
            residual: pnl.residual,
            absoluteResidual: magnitude,
            investmentReturn: pnl.investmentReturn,
            totalPnl: pnl.components.totalPnl,
            from: pnl.from.valuationDate,
            to: pnl.to.valuationDate,
            residualTolerance: bound,
          },
        },
      ]);
    }
  }

  // unusual-pnl
  {
    const family = 'unusual-pnl';
    if (!rules[family].enabled) {
      skip(family, `rules['${family}'].enabled is false`);
    } else if (pnl === undefined) {
      skip(family, 'no pnl result supplied — pass portfolioPnl’s result to monitor its size');
    } else if (unusualPnlThreshold === undefined && !ruleDeclaresThreshold(family)) {
      skip(
        family,
        'no unusualPnlThreshold supplied — what counts as unusual is a goal, not a default',
      );
    } else if (gate(family, true)) {
      const nav = netAssetValue!;
      const ratio = Math.abs(pnl.components.totalPnl) / nav;
      const bound = rules[family].threshold;
      evaluate(family, [
        {
          key: 'portfolio',
          subject: 'portfolio',
          value: ratio,
          threshold: bound,
          forcedBreach: false,
          reason: null,
          condition: `P&L of ${pretty(pnl.components.totalPnl)} ${baseCurrency} over ${pnl.from.valuationDate} → ${pnl.to.valuationDate} is ${pretty(ratio)} of NAV ${pretty(nav)} against unusualPnlThreshold ${pretty(bound)}`,
          evidence: {
            totalPnl: pnl.components.totalPnl,
            investmentReturn: pnl.investmentReturn,
            residual: pnl.residual,
            netAssetValue: nav,
            ratioOfNetAssetValue: ratio,
            from: pnl.from.valuationDate,
            to: pnl.to.valuationDate,
            unusualPnlThreshold: bound,
          },
        },
      ]);
    }
  }

  // ---- the state machine over every observation; vanished and carried rules ----
  const priorRules = previous?.rules ?? {};
  const acknowledgedNow = new Set(acknowledgments);
  for (const key of acknowledgments) {
    if (ownValue(priorRules, key)?.active !== true) {
      warnings.push(
        `acknowledgments names '${key}', which is not an active rule in previousState — ignored (an acknowledgment attaches to an active alert).`,
      );
    }
  }
  const nextRules: Record<string, MonitorRuleState> = {};
  const alerts: MonitorAlert[] = [];
  const observedKeys = new Set<string>();
  for (const [family, list] of observations) {
    const rule = rules[family];
    for (const observation of list) {
      const key = `${family}:${observation.key}`;
      observedKeys.add(key);
      const prior = ownValue(priorRules, key);
      const result = transition(prior, rule, observation, asOf, acknowledgedNow.has(key));
      if (!result.computable) {
        warnings.push(
          `${family}: ${observation.subject} is not computable this evaluation${observation.reason === null ? '' : ` — ${observation.reason}`}; its prior state is carried forward.`,
        );
        if (result.next !== null) setOwnValue(nextRules, key, result.next);
        continue;
      }
      if (result.next !== null) setOwnValue(nextRules, key, result.next);
      if (result.alertState === null) continue;
      alerts.push({
        key,
        family,
        subject: observation.subject,
        severity: rule.severity,
        state: result.alertState,
        value: observation.value,
        threshold: result.bound,
        direction: rule.direction,
        message: `${family} ${result.alertState}: ${observation.condition}.`,
        evidence: {
          ...observation.evidence,
          ...(rule.hysteresis !== null
            ? { enterThreshold: rule.hysteresis.enter, exitThreshold: rule.hysteresis.exit }
            : {}),
          consecutiveBreaches: result.next?.consecutiveBreaches ?? 0,
          lastRaisedAtMs: result.next?.lastRaisedAtMs ?? null,
        },
      });
    }
  }
  const carriedActive: string[] = [];
  for (const key of Object.keys(priorRules).sort(compareKeys)) {
    if (observedKeys.has(key)) continue;
    const family = familyOfKey(key)!;
    const prior = ownValue(priorRules, key)!;
    if (!observations.has(family)) {
      // The family was skipped: unknown is not cleared — carry the entry forward verbatim.
      setOwnValue(nextRules, key, { ...prior });
      if (prior.active) carriedActive.push(key);
      continue;
    }
    if (!prior.active) continue;
    // The family evaluated and the subject is gone (a closed position, a removed target): clear.
    const rule = rules[family];
    const subject = key.slice(family.length + 1);
    alerts.push({
      key,
      family,
      subject,
      severity: rule.severity,
      state: 'cleared',
      value: null,
      threshold: rule.threshold,
      direction: rule.direction,
      message: `${family} cleared: ${subject} is no longer observed (the position closed or the target was removed).`,
      evidence: {
        reason: 'subject no longer observed',
        lastValue: prior.lastValue,
        lastRaisedAtMs: prior.lastRaisedAtMs,
        consecutiveBreaches: 0,
      },
    });
  }
  if (carriedActive.length > 0) {
    warnings.push(
      `${carriedActive.length} active rule${carriedActive.length === 1 ? '' : 's'} in skipped families carried forward unevaluated: ${carriedActive.join(', ')}.`,
    );
  }
  alerts.sort((a, b) => compareKeys(a.key, b.key));

  const sortedRules: Record<string, MonitorRuleState> = {};
  for (const key of Object.keys(nextRules).sort(compareKeys)) {
    setOwnValue(sortedRules, key, ownValue(nextRules, key)!);
  }
  const nextState: PortfolioMonitorState = {
    schemaVersion: PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION,
    asOf,
    netAssetValue,
    peakNetAssetValue,
    evaluationCount: (previous?.evaluationCount ?? 0) + 1,
    rules: sortedRules,
  };
  const count = (alertState: MonitorAlertState): number =>
    alerts.filter((alert) => alert.state === alertState).length;

  return deepFreeze(
    requireRepresentableResult(functionName, {
      asOf,
      baseCurrency,
      netAssetValue,
      alerts,
      evaluated: evaluations,
      state: nextState,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        liquidityParticipationRate: MONITOR_LIQUIDITY_PARTICIPATION_RATE,
        conventions: CONVENTIONS,
        rulesApplied: rules,
      },
      diagnostics: {
        warnings,
        unsupportedFamilies: DEFERRED_FAMILIES.map((entry) => ({ ...entry })),
        raisedCount: count('raised'),
        activeCount: Object.values(sortedRules).filter((entry) => entry.active).length,
        clearedCount: count('cleared'),
        suppressedCount: count('suppressed'),
        acknowledgedCount: count('acknowledged'),
      },
    }),
  );
}
