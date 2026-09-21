/**
 * The investment-policy grammar behind `@totalfinance/portfolio/policy` (FC7 slice 4, Stage 4.4): model
 * portfolios with versioned strategic/tactical/glide-path targets and hierarchical sleeves, the
 * user-supplied `InvestmentPolicy`, and the ONE target-resolution law that `allocatePortfolio`,
 * `proposePortfolioRebalance`, and `monitorPortfolio` share. This module is INTERNAL: `policy.ts`
 * is the public subpath and re-exports only the reviewed surface.
 *
 * Decisions this module executes (agent-native doc, "Portfolio management workflows" →
 * "Investment policy"; tracker §FC7 "Portfolio-side management"):
 *
 * - A policy is a USER-SUPPLIED artifact, never advice: every goal is explicit and **missing goals
 *   do not become secret defaults** — a group target with no way to split it, a universe the
 *   targets do not cover, or a risk budget without a covariance is reported as `unresolved`, never
 *   quietly filled in.
 * - Targets are declared on GROUPS (`instrumentId`, `sleeveId`, `assetClass`, `currency`, `tag`,
 *   `underlying`, `strategy`) — the same identity vocabulary the P&L and timeline groupings use —
 *   and `{ assetClass: 'cash' }` is THE cash target (the accepted example's spelling).
 * - A model portfolio is an immutable, content-addressed artifact (`kind: 'totalfinance.model-portfolio'`)
 *   whose targets resolve at an explicit `asOf`: tactical sets effective at that instant win over
 *   the glide path, which wins over the strategic set. Nothing is interpolated unless the model says
 *   `interpolation: 'linear'`.
 */

import {
  CONVENTIONS_VERSION,
  DataError,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  resolveAsOf,
  type EpochMs,
} from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import {
  deepFreeze,
  describeInputValue,
  epochMsToUtcDate,
  ownValue,
  requireCurrencyCode,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
  requirePositiveNumberField,
} from './internal.js';
import type { InstrumentClassification } from './pnl.js';

// ---------------------------------------------------------------------------------------------------
// Public types — targets
// ---------------------------------------------------------------------------------------------------

/**
 * The group a target applies to — EXACTLY ONE key. `instrumentId` and `sleeveId` resolve through
 * the model; the classification keys resolve through the caller's `instrumentClassification`
 * (`currency` through each position's trading currency). `{ assetClass: 'cash' }` targets cash.
 */
export interface TargetGroup {
  instrumentId?: string;
  sleeveId?: string;
  assetClass?: string;
  currency?: string;
  tag?: string;
  underlying?: string;
  strategy?: string;
}

export type TargetGroupKey = keyof TargetGroup;

/** One allocation goal. Exactly one of `weight` (share of NAV) or `riskBudget` (share of risk). */
export interface AllocationTarget {
  group: TargetGroup;
  /** Target weight as a decimal fraction of net asset value (negative = short target). */
  weight?: number;
  /**
   * Target share of total portfolio risk (decimal). Carried on the artifact; this build's
   * portfolio-side calls act on WEIGHTS and report a risk-budget target as unresolved — turning a
   * risk budget into weights needs a covariance, which lives on the risk side (`@totalfinance/risk`).
   */
  riskBudget?: number;
  /** Absolute drift band for this target (decimal of NAV); overrides the policy's `driftBand`. */
  driftBand?: number;
}

/** A dated, complete set of targets. */
export interface TargetSet {
  /** When the set becomes effective (`'YYYY-MM-DD'`, zoned ISO datetime, or epoch ms). */
  effectiveFrom: EpochMs | string;
  /** Optional end of effectiveness (exclusive) — for tactical overrides. */
  effectiveTo?: EpochMs | string;
  targets: AllocationTarget[];
  note?: string;
}

/** A sleeve member: an instrument and its weight WITHIN the sleeve (members sum to 1). */
export interface SleeveMember {
  instrumentId: string;
  weight: number;
}

/**
 * A hierarchical sleeve. A LEAF declares `members`; a CHILD declares `parentSleeveId` and its
 * `weightWithinParent` (siblings sum to 1). A parent's own target weight flows down the tree.
 */
export interface ModelSleeve {
  sleeveId: string;
  parentSleeveId?: string;
  weightWithinParent?: number;
  members?: SleeveMember[];
  note?: string;
}

export interface BenchmarkConstituent {
  instrumentId: string;
  weight: number;
}

/** Benchmark identity — a name and, when known, its dated membership. */
export interface BenchmarkIdentity {
  benchmarkId: string;
  /** The instant the membership below is stated at. */
  asOf?: EpochMs | string;
  /** Constituent weights (sum to 1) — the identity a tracking comparison is made against. */
  constituents?: BenchmarkConstituent[];
}

export interface LiabilityEntry {
  date: EpochMs | string;
  /** Positive amount due on `date`, in `currency`. */
  amount: number;
  currency: string;
}

/** A schedule of dated liabilities / planned withdrawals the portfolio must fund. */
export interface LiabilitySchedule {
  entries: LiabilityEntry[];
  note?: string;
}

/** One glide-path point: a dated target set that runs until the next point (no `effectiveTo`). */
export type GlidePathPoint = Omit<TargetSet, 'effectiveTo'>;

/** Dated strategic target sets along a horizon; `interpolation` is REQUIRED (never guessed). */
export interface GlidePath {
  interpolation: 'step' | 'linear';
  points: GlidePathPoint[];
}

/** The definition {@link createModelPortfolio} freezes. */
export interface ModelPortfolioDefinition {
  modelId: string;
  /** Safe integer ≥ 1 — a changed model is a new version, never an edit in place. */
  version: number;
  baseCurrency: string;
  strategic: TargetSet;
  /** Dated complete overrides; the latest set effective at `asOf` wins. */
  tactical?: TargetSet[];
  glidePath?: GlidePath;
  sleeves?: ModelSleeve[];
  benchmark?: BenchmarkIdentity;
  liabilities?: LiabilitySchedule;
  horizonEndDate?: EpochMs | string;
  note?: string;
}

export const MODEL_PORTFOLIO_KIND = 'totalfinance.model-portfolio';
export const MODEL_PORTFOLIO_SCHEMA_VERSION = 1;

/** The immutable, content-addressed model artifact. */
export interface ModelPortfolio extends ModelPortfolioDefinition {
  kind: typeof MODEL_PORTFOLIO_KIND;
  schemaVersion: number;
  /** `sha256:` over the canonical definition (kind and schemaVersion included). */
  contentHash: string;
}

// ---------------------------------------------------------------------------------------------------
// Public types — the investment policy
// ---------------------------------------------------------------------------------------------------

export type WithinGroupAllocation = 'proportional-to-current' | 'equal';
export type ContributionHandling = 'invest-to-targets' | 'hold-as-cash';
export type WithdrawalHandling = 'raise-from-overweights' | 'pro-rata';
export type IncomeReinvestment = 'reinvest' | 'hold-as-cash';

export interface GroupWeightLimit {
  group: TargetGroup;
  /** Maximum absolute weight of the group (decimal of NAV). */
  maximumWeight: number;
}

/** Hard limits a proposal must satisfy and a monitor evaluates. Every limit is explicit. */
export interface PolicyLimits {
  /** Maximum absolute weight of any single instrument (decimal of NAV). */
  maximumPositionWeight?: number;
  maximumGroupWeights?: GroupWeightLimit[];
  /** Maximum gross exposure ÷ NAV (1 = unlevered). */
  maximumGrossLeverage?: number;
  /** Maximum peak-to-trough drawdown of NAV (decimal). */
  maximumDrawdown?: number;
  /** Maximum one-evaluation NAV loss (decimal of the prior NAV). */
  maximumDailyLoss?: number;
  /** Maximum days to liquidate any position at the supplied participation rate. */
  maximumDaysToLiquidate?: number;
  /** Minimum settled cash in base currency (a margin/buying-power floor; may be negative). */
  minimumSettledCash?: number;
}

/**
 * The user-supplied investment policy (agent-native "Investment policy"). Targets come inline or
 * from a model artifact — never both. Everything else is optional and explicit.
 */
export interface InvestmentPolicy {
  targets?: AllocationTarget[];
  model?: ModelPortfolio;
  /**
   * How a GROUP target (assetClass/currency/tag/underlying/strategy) is split across its member
   * instruments. REQUIRED whenever such a target resolves to more than one instrument.
   */
  withinGroupAllocation?: WithinGroupAllocation;
  /** Default absolute drift band (decimal of NAV) — a target outside its band triggers trades/alerts. */
  driftBand?: number;
  reviewCadenceDays?: number;
  /** Maximum turnover per proposal: `Σ|trade notional| ÷ NAV` (buys and sells both counted). */
  maximumTurnover?: number;
  /** Maximum estimated transaction cost per proposal, in base currency. */
  maximumEstimatedTransactionCost?: number;
  /** Cash reserve in base currency that a proposal may never spend below. */
  minimumCash?: number;
  /** Cash reserve as a decimal of NAV (alternative spelling; both may be set — the larger binds). */
  minimumCashWeight?: number;
  limits?: PolicyLimits;
  allowedInstruments?: string[];
  restrictedInstruments?: string[];
  allowedAccounts?: string[];
  benchmark?: BenchmarkIdentity;
  /** Prose statement of the performance objective. String-typed by design. */
  performanceObjective?: string;
  contributionHandling?: ContributionHandling;
  withdrawalHandling?: WithdrawalHandling;
  incomeReinvestment?: IncomeReinvestment;
  /**
   * Identity of an external tax-aware lot-selection objective. This build reports lots under the
   * ledger's own relief policy and echoes this identity; it never applies an objective it does not
   * implement.
   */
  lotSelectionObjective?: string;
}

// ---------------------------------------------------------------------------------------------------
// Public types — resolution
// ---------------------------------------------------------------------------------------------------

export type ResolvedTargetSource = 'inline' | 'strategic' | 'tactical' | 'glide-path';

/** The targets effective at one instant, with where they came from. */
export interface ResolvedTargets {
  targets: AllocationTarget[];
  source: ResolvedTargetSource;
  /** The effective-from instant of the winning set (`null` for inline targets). */
  effectiveFrom: EpochMs | null;
  /** Present when a linear glide path interpolated between two points. */
  interpolation?: { from: EpochMs; to: EpochMs; fraction: number };
}

/** One instrument's resolved target after group expansion. */
export interface InstrumentTarget {
  instrumentId: string;
  targetWeight: number;
  driftBand: number | null;
  /** The target group keys (`'assetClass:equity'`) that produced this weight. */
  sourceGroups: string[];
  /** True when the instrument was covered by no target and the targets sum to 1 (implied zero). */
  implied: boolean;
}

/** One group target after membership resolution. */
export interface GroupTarget {
  key: string;
  group: TargetGroup;
  targetWeight: number;
  driftBand: number | null;
  members: string[];
}

export interface UnresolvedTarget {
  key: string;
  group: TargetGroup;
  reason: string;
}

/** The expansion of group targets to instrument targets — what allocation and rebalancing act on. */
export interface ExpandedTargets {
  instrumentTargets: InstrumentTarget[];
  groupTargets: GroupTarget[];
  /** The cash target (`{ assetClass: 'cash' }`), implied zero when the targets sum to 1 without one. */
  cashTarget: { targetWeight: number; driftBand: number | null; implied: boolean } | null;
  /** Σ of the resolved group weights including cash (before implied zeros). */
  declaredWeightTotal: number;
  unresolved: UnresolvedTarget[];
  warnings: string[];
}

export interface ExpandTargetsInput {
  targets: AllocationTarget[];
  /** Every instrument the expansion may assign a target to (holdings ∪ allowed ∪ sleeve members). */
  universe: string[];
  instrumentClassification: Record<string, InstrumentClassification>;
  /** Trading currency per instrument — resolves `currency` targets. */
  instrumentCurrency: Record<string, string>;
  /** Current weights per instrument (decimal of NAV) — for `'proportional-to-current'`. */
  currentWeights: Record<string, number>;
  sleeves: ModelSleeve[];
  withinGroupAllocation: WithinGroupAllocation | undefined;
  defaultDriftBand: number | undefined;
}

// ---------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------

const TARGET_GROUP_KEYS = [
  'instrumentId',
  'sleeveId',
  'assetClass',
  'currency',
  'tag',
  'underlying',
  'strategy',
] as const;
const TARGET_KEYS = ['group', 'weight', 'riskBudget', 'driftBand'] as const;
const TARGET_SET_KEYS = ['effectiveFrom', 'effectiveTo', 'targets', 'note'] as const;
const SLEEVE_KEYS = [
  'sleeveId',
  'parentSleeveId',
  'weightWithinParent',
  'members',
  'note',
] as const;
const SLEEVE_MEMBER_KEYS = ['instrumentId', 'weight'] as const;
const BENCHMARK_KEYS = ['benchmarkId', 'asOf', 'constituents'] as const;
const CONSTITUENT_KEYS = ['instrumentId', 'weight'] as const;
const LIABILITY_KEYS = ['entries', 'note'] as const;
const LIABILITY_ENTRY_KEYS = ['date', 'amount', 'currency'] as const;
const GLIDE_PATH_KEYS = ['interpolation', 'points'] as const;
const GLIDE_INTERPOLATIONS = ['step', 'linear'] as const;
const DEFINITION_KEYS = [
  'modelId',
  'version',
  'baseCurrency',
  'strategic',
  'tactical',
  'glidePath',
  'sleeves',
  'benchmark',
  'liabilities',
  'horizonEndDate',
  'note',
] as const;
const ARTIFACT_KEYS = [...DEFINITION_KEYS, 'kind', 'schemaVersion', 'contentHash'] as const;
const LIMIT_KEYS = [
  'maximumPositionWeight',
  'maximumGroupWeights',
  'maximumGrossLeverage',
  'maximumDrawdown',
  'maximumDailyLoss',
  'maximumDaysToLiquidate',
  'minimumSettledCash',
] as const;
const GROUP_LIMIT_KEYS = ['group', 'maximumWeight'] as const;
const POLICY_KEYS = [
  'targets',
  'model',
  'withinGroupAllocation',
  'driftBand',
  'reviewCadenceDays',
  'maximumTurnover',
  'maximumEstimatedTransactionCost',
  'minimumCash',
  'minimumCashWeight',
  'limits',
  'allowedInstruments',
  'restrictedInstruments',
  'allowedAccounts',
  'benchmark',
  'performanceObjective',
  'contributionHandling',
  'withdrawalHandling',
  'incomeReinvestment',
  'lotSelectionObjective',
] as const;
const WITHIN_GROUP_ALLOCATIONS: readonly WithinGroupAllocation[] = [
  'proportional-to-current',
  'equal',
];
const CONTRIBUTION_HANDLINGS: readonly ContributionHandling[] = [
  'invest-to-targets',
  'hold-as-cash',
];
const WITHDRAWAL_HANDLINGS: readonly WithdrawalHandling[] = ['raise-from-overweights', 'pro-rata'];
const INCOME_REINVESTMENTS: readonly IncomeReinvestment[] = ['reinvest', 'hold-as-cash'];

/** Weight sums are compared at this tolerance (float arithmetic on declared decimals). */
export const WEIGHT_TOLERANCE = 1e-9;
/** The cash target's spelling — the accepted example's `{ assetClass: 'cash' }`. */
export const CASH_ASSET_CLASS = 'cash';

const MODEL_EXAMPLE_CALL =
  "createModelPortfolio({ modelId: 'balanced', version: 1, baseCurrency: 'USD', strategic: { effectiveFrom: '2026-01-01', targets: [{ group: { tag: 'equity' }, weight: 0.6 }, { group: { tag: 'fixed-income' }, weight: 0.3 }, { group: { assetClass: 'cash' }, weight: 0.1 }] } })";

const POLICY_EXAMPLE =
  "policy: { targets: [{ group: { tag: 'equity' }, weight: 0.6 }, { group: { tag: 'fixed-income' }, weight: 0.3 }, { group: { assetClass: 'cash' }, weight: 0.1 }], withinGroupAllocation: 'proportional-to-current', driftBand: 0.03, maximumTurnover: 0.15, minimumCash: 5_000 }";

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

function requireLiteral<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.map((v) => `'${v}'`).join(', ')}. Received ${describeInputValue(value)}.`,
      {
        code: typeof value === 'string' ? ErrorCode.InputInvalidEnum : ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
  return value as T;
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

function requireInstant(functionName: string, field: string, value: unknown): EpochMs {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InputError(
      `${functionName}: ${field} must be an epoch-millisecond number, a 'YYYY-MM-DD' date, or a zoned ISO datetime. Received ${
        value === null ? 'null' : typeof value
      }.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
  const resolved = resolveAsOf(value, functionName);
  requireEpochMsField(functionName, field, resolved);
  return resolved;
}

function requireIdentityList(functionName: string, field: string, value: unknown): string[] {
  requireArgumentArray(functionName, field, value);
  const out: string[] = [];
  const seen = new Set<string>();
  (value as unknown[]).forEach((entry, index) => {
    requireIdentityString(functionName, `${field}[${index}]`, entry);
    if (seen.has(entry)) {
      outOfRange(functionName, field, `${field} lists '${entry}' twice.`);
    }
    seen.add(entry);
    out.push(entry);
  });
  return out;
}

/** A declared-weight total for prose: 12 significant digits, so 0.6 + 0.3 reads 0.9. */
function readable(value: number): string {
  return String(Number(value.toPrecision(12)));
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** The single key of a validated target group, as `'<dimension>:<value>'`. */
export function targetGroupKey(group: TargetGroup): string {
  for (const key of TARGET_GROUP_KEYS) {
    const value = group[key];
    if (value !== undefined) return `${key}:${value}`;
  }
  throw new DataError('targetGroupKey: the group names no dimension.', {
    code: ErrorCode.InputMissingField,
    context: { function: 'targetGroupKey', field: 'group' },
  });
}

/** Whether a group is the cash target. */
export function isCashTargetGroup(group: TargetGroup): boolean {
  return group.assetClass === CASH_ASSET_CLASS;
}

// ---------------------------------------------------------------------------------------------------
// Validation — targets
// ---------------------------------------------------------------------------------------------------

/** Validate one target group: an object with exactly ONE dimension key holding an identity string. */
export function requireTargetGroup(
  functionName: string,
  path: string,
  value: unknown,
): TargetGroup {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, TARGET_GROUP_KEYS);
  const group = value as Record<string, unknown>;
  const present = TARGET_GROUP_KEYS.filter((key) => group[key] !== undefined);
  if (present.length !== 1) {
    throw new InputError(
      `${functionName}: ${path} must name exactly ONE dimension (${TARGET_GROUP_KEYS.join(', ')}); received ${
        present.length === 0 ? 'none' : present.join(' + ')
      }. A target on two dimensions is two targets.`,
      {
        code: present.length === 0 ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
        context: { function: functionName, field: path },
      },
    );
  }
  const key = present[0]!;
  requireIdentityString(functionName, `${path}.${key}`, group[key]);
  return { [key]: group[key] } as TargetGroup;
}

/** Validate one allocation target. */
export function requireAllocationTarget(
  functionName: string,
  path: string,
  value: unknown,
): AllocationTarget {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, TARGET_KEYS);
  const target = value as Record<string, unknown>;
  const group = requireTargetGroup(functionName, `${path}.group`, target['group']);
  const hasWeight = target['weight'] !== undefined;
  const hasRiskBudget = target['riskBudget'] !== undefined;
  if (hasWeight === hasRiskBudget) {
    throw new InputError(
      `${functionName}: ${path} must declare exactly one of weight (share of NAV) or riskBudget (share of risk)${
        hasWeight ? ' — both were given' : ' — neither was given'
      }.\n  e.g. { group: { tag: 'equity' }, weight: 0.6 }`,
      {
        code: hasWeight ? ErrorCode.InputOutOfRange : ErrorCode.InputMissingField,
        context: { function: functionName, field: path },
      },
    );
  }
  const out: AllocationTarget = { group };
  if (hasWeight) {
    requireFiniteNumberField(functionName, `${path}.weight`, target['weight']);
    if (Math.abs(target['weight']) > 1) {
      outOfRange(
        functionName,
        `${path}.weight`,
        `${path}.weight is a decimal fraction of NAV, so |weight| ≤ 1. Received ${target['weight']} (a percentage?).`,
      );
    }
    out.weight = target['weight'];
  } else {
    requireFiniteNumberField(functionName, `${path}.riskBudget`, target['riskBudget']);
    if (target['riskBudget'] < 0 || target['riskBudget'] > 1) {
      outOfRange(
        functionName,
        `${path}.riskBudget`,
        `${path}.riskBudget is a decimal share of total risk in [0, 1]. Received ${target['riskBudget']}.`,
      );
    }
    out.riskBudget = target['riskBudget'];
  }
  if (target['driftBand'] !== undefined) {
    out.driftBand = requireNonNegative(functionName, `${path}.driftBand`, target['driftBand']);
  }
  return out;
}

/** Validate a target list: each target valid, no duplicate groups, per-dimension sums ≤ 1. */
export function requireAllocationTargets(
  functionName: string,
  path: string,
  value: unknown,
): AllocationTarget[] {
  requireArgumentArray(functionName, path, value);
  if ((value as unknown[]).length === 0) {
    missingField(
      functionName,
      path,
      `${path} must contain at least one target.\n  e.g. ${POLICY_EXAMPLE}`,
    );
  }
  const targets = (value as unknown[]).map((entry, index) =>
    requireAllocationTarget(functionName, `${path}[${index}]`, entry),
  );
  const seen = new Set<string>();
  const weightByDimension = new Map<string, number>();
  const riskByDimension = new Map<string, number>();
  targets.forEach((target, index) => {
    const key = targetGroupKey(target.group);
    if (seen.has(key)) {
      outOfRange(
        functionName,
        `${path}[${index}].group`,
        `${path} names the group '${key}' twice — one target per group.`,
      );
    }
    seen.add(key);
    const dimension = key.slice(0, key.indexOf(':'));
    if (target.weight !== undefined) {
      weightByDimension.set(dimension, (weightByDimension.get(dimension) ?? 0) + target.weight);
    } else {
      riskByDimension.set(dimension, (riskByDimension.get(dimension) ?? 0) + target.riskBudget!);
    }
  });
  for (const [dimension, total] of weightByDimension) {
    if (total > 1 + WEIGHT_TOLERANCE) {
      outOfRange(
        functionName,
        path,
        `${path} allocates ${total} of NAV across the '${dimension}' dimension — weights on one dimension cannot exceed 1.`,
      );
    }
  }
  for (const [dimension, total] of riskByDimension) {
    if (total > 1 + WEIGHT_TOLERANCE) {
      outOfRange(
        functionName,
        path,
        `${path} budgets ${total} of total risk across the '${dimension}' dimension — risk budgets on one dimension cannot exceed 1.`,
      );
    }
  }
  return targets;
}

function requireTargetSet(functionName: string, path: string, value: unknown): TargetSet {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, TARGET_SET_KEYS);
  const set = value as Record<string, unknown>;
  if (set['effectiveFrom'] === undefined) {
    missingField(
      functionName,
      `${path}.effectiveFrom`,
      `${path}.effectiveFrom is required — a target set is dated.`,
    );
  }
  const effectiveFrom = requireInstant(functionName, `${path}.effectiveFrom`, set['effectiveFrom']);
  const out: TargetSet = {
    effectiveFrom: set['effectiveFrom'] as EpochMs | string,
    targets: requireAllocationTargets(functionName, `${path}.targets`, set['targets']),
  };
  if (set['effectiveTo'] !== undefined) {
    const effectiveTo = requireInstant(functionName, `${path}.effectiveTo`, set['effectiveTo']);
    if (effectiveTo <= effectiveFrom) {
      outOfRange(
        functionName,
        `${path}.effectiveTo`,
        `${path}.effectiveTo (${epochMsToUtcDate(effectiveTo)}) must be after effectiveFrom (${epochMsToUtcDate(effectiveFrom)}).`,
      );
    }
    out.effectiveTo = set['effectiveTo'] as EpochMs | string;
  }
  if (set['note'] !== undefined) {
    if (typeof set['note'] !== 'string') {
      throw new InputError(`${functionName}: ${path}.note must be a string.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${path}.note` },
      });
    }
    out.note = set['note'];
  }
  return out;
}

function requireSleeves(functionName: string, path: string, value: unknown): ModelSleeve[] {
  requireArgumentArray(functionName, path, value);
  const sleeves: ModelSleeve[] = [];
  const byId = new Map<string, ModelSleeve>();
  (value as unknown[]).forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    requireArgumentObject(functionName, entryPath, entry);
    ensureKnownKeys(functionName, entryPath, entry as object, SLEEVE_KEYS);
    const raw = entry as Record<string, unknown>;
    requireIdentityString(functionName, `${entryPath}.sleeveId`, raw['sleeveId']);
    if (byId.has(raw['sleeveId'])) {
      outOfRange(
        functionName,
        `${entryPath}.sleeveId`,
        `${path} declares sleeve '${raw['sleeveId']}' twice.`,
      );
    }
    const sleeve: ModelSleeve = { sleeveId: raw['sleeveId'] };
    if (raw['parentSleeveId'] !== undefined) {
      requireIdentityString(functionName, `${entryPath}.parentSleeveId`, raw['parentSleeveId']);
      if (raw['parentSleeveId'] === sleeve.sleeveId) {
        outOfRange(
          functionName,
          `${entryPath}.parentSleeveId`,
          `sleeve '${sleeve.sleeveId}' cannot be its own parent.`,
        );
      }
      sleeve.parentSleeveId = raw['parentSleeveId'];
      if (raw['weightWithinParent'] === undefined) {
        missingField(
          functionName,
          `${entryPath}.weightWithinParent`,
          `${entryPath}.weightWithinParent is required for a child sleeve (siblings sum to 1).`,
        );
      }
      sleeve.weightWithinParent = requireNonNegative(
        functionName,
        `${entryPath}.weightWithinParent`,
        raw['weightWithinParent'],
      );
    } else if (raw['weightWithinParent'] !== undefined) {
      outOfRange(
        functionName,
        `${entryPath}.weightWithinParent`,
        `${entryPath}.weightWithinParent is only meaningful with parentSleeveId.`,
      );
    }
    if (raw['members'] !== undefined) {
      requireArgumentArray(functionName, `${entryPath}.members`, raw['members']);
      if ((raw['members'] as unknown[]).length === 0) {
        missingField(
          functionName,
          `${entryPath}.members`,
          `${entryPath}.members must not be empty.`,
        );
      }
      const seen = new Set<string>();
      sleeve.members = (raw['members'] as unknown[]).map((member, memberIndex) => {
        const memberPath = `${entryPath}.members[${memberIndex}]`;
        requireArgumentObject(functionName, memberPath, member);
        ensureKnownKeys(functionName, memberPath, member as object, SLEEVE_MEMBER_KEYS);
        const m = member as Record<string, unknown>;
        requireIdentityString(functionName, `${memberPath}.instrumentId`, m['instrumentId']);
        if (seen.has(m['instrumentId'])) {
          outOfRange(
            functionName,
            memberPath,
            `sleeve '${sleeve.sleeveId}' lists '${m['instrumentId']}' twice.`,
          );
        }
        seen.add(m['instrumentId']);
        return {
          instrumentId: m['instrumentId'],
          weight: requireNonNegative(functionName, `${memberPath}.weight`, m['weight']),
        };
      });
      const total = sum(sleeve.members.map((member) => member.weight));
      if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
        outOfRange(
          functionName,
          `${entryPath}.members`,
          `sleeve '${sleeve.sleeveId}' member weights sum to ${total}; they must sum to 1 (weights are WITHIN the sleeve).`,
        );
      }
    }
    if (raw['note'] !== undefined) {
      if (typeof raw['note'] !== 'string') {
        throw new InputError(`${functionName}: ${entryPath}.note must be a string.`, {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${entryPath}.note` },
        });
      }
      sleeve.note = raw['note'];
    }
    byId.set(sleeve.sleeveId, sleeve);
    sleeves.push(sleeve);
  });
  // Structure: parents exist, no cycles, siblings sum to 1, every sleeve is a leaf or a parent.
  const children = new Map<string, ModelSleeve[]>();
  for (const sleeve of sleeves) {
    if (sleeve.parentSleeveId !== undefined) {
      if (!byId.has(sleeve.parentSleeveId)) {
        outOfRange(
          functionName,
          path,
          `sleeve '${sleeve.sleeveId}' names parent '${sleeve.parentSleeveId}', which is not declared.`,
        );
      }
      const list = children.get(sleeve.parentSleeveId) ?? [];
      list.push(sleeve);
      children.set(sleeve.parentSleeveId, list);
    }
  }
  for (const sleeve of sleeves) {
    const seen = new Set<string>([sleeve.sleeveId]);
    let cursor = sleeve.parentSleeveId;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        outOfRange(functionName, path, `sleeves form a cycle through '${cursor}'.`);
      }
      seen.add(cursor);
      cursor = byId.get(cursor)!.parentSleeveId;
    }
    const kids = children.get(sleeve.sleeveId) ?? [];
    if (kids.length > 0 && sleeve.members !== undefined) {
      outOfRange(
        functionName,
        path,
        `sleeve '${sleeve.sleeveId}' declares members AND has child sleeves — a sleeve is a leaf or a parent, not both.`,
      );
    }
    if (kids.length === 0 && sleeve.members === undefined) {
      missingField(
        functionName,
        path,
        `sleeve '${sleeve.sleeveId}' has neither members nor child sleeves — an empty sleeve cannot be allocated.`,
      );
    }
    if (kids.length > 0) {
      const total = sum(kids.map((kid) => kid.weightWithinParent!));
      if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
        outOfRange(
          functionName,
          path,
          `the child sleeves of '${sleeve.sleeveId}' weigh ${total} within it; siblings must sum to 1.`,
        );
      }
    }
  }
  return sleeves;
}

function requireBenchmark(functionName: string, path: string, value: unknown): BenchmarkIdentity {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, BENCHMARK_KEYS);
  const raw = value as Record<string, unknown>;
  requireIdentityString(functionName, `${path}.benchmarkId`, raw['benchmarkId']);
  const out: BenchmarkIdentity = { benchmarkId: raw['benchmarkId'] };
  if (raw['asOf'] !== undefined) {
    requireInstant(functionName, `${path}.asOf`, raw['asOf']);
    out.asOf = raw['asOf'] as EpochMs | string;
  }
  if (raw['constituents'] !== undefined) {
    requireArgumentArray(functionName, `${path}.constituents`, raw['constituents']);
    const seen = new Set<string>();
    out.constituents = (raw['constituents'] as unknown[]).map((entry, index) => {
      const entryPath = `${path}.constituents[${index}]`;
      requireArgumentObject(functionName, entryPath, entry);
      ensureKnownKeys(functionName, entryPath, entry as object, CONSTITUENT_KEYS);
      const c = entry as Record<string, unknown>;
      requireIdentityString(functionName, `${entryPath}.instrumentId`, c['instrumentId']);
      if (seen.has(c['instrumentId'])) {
        outOfRange(functionName, entryPath, `${path} lists '${c['instrumentId']}' twice.`);
      }
      seen.add(c['instrumentId']);
      requireFiniteNumberField(functionName, `${entryPath}.weight`, c['weight']);
      return { instrumentId: c['instrumentId'], weight: c['weight'] };
    });
    if (out.constituents.length === 0) {
      missingField(
        functionName,
        `${path}.constituents`,
        `${path}.constituents must not be empty when given.`,
      );
    }
    const total = sum(out.constituents.map((c) => c.weight));
    if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
      outOfRange(
        functionName,
        `${path}.constituents`,
        `${path}.constituents weigh ${total}; a benchmark's membership sums to 1.`,
      );
    }
  }
  return out;
}

function requireLiabilities(functionName: string, path: string, value: unknown): LiabilitySchedule {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, LIABILITY_KEYS);
  const raw = value as Record<string, unknown>;
  requireArgumentArray(functionName, `${path}.entries`, raw['entries']);
  let previous = -Infinity;
  const entries = (raw['entries'] as unknown[]).map((entry, index) => {
    const entryPath = `${path}.entries[${index}]`;
    requireArgumentObject(functionName, entryPath, entry);
    ensureKnownKeys(functionName, entryPath, entry as object, LIABILITY_ENTRY_KEYS);
    const e = entry as Record<string, unknown>;
    const date = requireInstant(functionName, `${entryPath}.date`, e['date']);
    if (date < previous) {
      outOfRange(
        functionName,
        `${entryPath}.date`,
        `${path}.entries must be in non-decreasing date order.`,
      );
    }
    previous = date;
    requirePositiveNumberField(
      functionName,
      `${entryPath}.amount`,
      e['amount'],
      'a liability is an amount due',
    );
    return {
      date: e['date'] as EpochMs | string,
      amount: e['amount'] as number,
      currency: (() => {
        requireCurrencyCode(functionName, `${entryPath}.currency`, e['currency']);
        return e['currency'] as string;
      })(),
    };
  });
  const out: LiabilitySchedule = { entries };
  if (raw['note'] !== undefined) {
    if (typeof raw['note'] !== 'string') {
      throw new InputError(`${functionName}: ${path}.note must be a string.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${path}.note` },
      });
    }
    out.note = raw['note'];
  }
  return out;
}

function requireGlidePath(functionName: string, path: string, value: unknown): GlidePath {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, GLIDE_PATH_KEYS);
  const raw = value as Record<string, unknown>;
  if (raw['interpolation'] === undefined) {
    missingField(
      functionName,
      `${path}.interpolation`,
      `${path}.interpolation is required ('step' holds each point until the next; 'linear' interpolates weights between points) — a glide path's shape is a goal, not a default.`,
    );
  }
  const interpolation = requireLiteral(
    functionName,
    `${path}.interpolation`,
    raw['interpolation'],
    GLIDE_INTERPOLATIONS,
  );
  requireArgumentArray(functionName, `${path}.points`, raw['points']);
  if ((raw['points'] as unknown[]).length === 0) {
    missingField(
      functionName,
      `${path}.points`,
      `${path}.points must contain at least one dated target set.`,
    );
  }
  const points = (raw['points'] as unknown[]).map((entry, index) =>
    requireTargetSet(functionName, `${path}.points[${index}]`, entry),
  );
  let previous = -Infinity;
  points.forEach((point, index) => {
    const from = resolveAsOf(point.effectiveFrom, functionName);
    if (from <= previous) {
      outOfRange(
        functionName,
        `${path}.points[${index}].effectiveFrom`,
        `${path}.points must be in strictly increasing effectiveFrom order.`,
      );
    }
    previous = from;
    if (point.effectiveTo !== undefined) {
      outOfRange(
        functionName,
        `${path}.points[${index}].effectiveTo`,
        `a glide-path point runs until the next point; effectiveTo is not allowed here.`,
      );
    }
    if (interpolation === 'linear' && index > 0) {
      const before = new Set(points[index - 1]!.targets.map((t) => targetGroupKey(t.group)));
      const now = new Set(point.targets.map((t) => targetGroupKey(t.group)));
      const same = before.size === now.size && [...before].every((k) => now.has(k));
      if (!same) {
        outOfRange(
          functionName,
          `${path}.points[${index}].targets`,
          `linear interpolation needs every point to name the SAME groups (point ${index - 1} names ${[...before].join(', ')}; point ${index} names ${[...now].join(', ')}). Use 'step', or restate both points over one group set.`,
        );
      }
      const riskMixed =
        points[index - 1]!.targets.some((t) => t.riskBudget !== undefined) ||
        point.targets.some((t) => t.riskBudget !== undefined);
      if (riskMixed) {
        outOfRange(
          functionName,
          `${path}.points[${index}].targets`,
          `linear interpolation is defined over weights; risk-budget targets need 'step'.`,
        );
      }
    }
  });
  return { interpolation, points };
}

// ---------------------------------------------------------------------------------------------------
// Validation — the model and the policy
// ---------------------------------------------------------------------------------------------------

/** Validate a {@link ModelPortfolioDefinition} (closed keys, dated sets, sleeve structure). */
export function requireModelPortfolioDefinition(
  functionName: string,
  path: string,
  value: unknown,
): ModelPortfolioDefinition {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, DEFINITION_KEYS);
  const raw = value as Record<string, unknown>;
  requireIdentityString(functionName, `${path}.modelId`, raw['modelId']);
  if (raw['version'] === undefined) {
    missingField(
      functionName,
      `${path}.version`,
      `${path}.version is required (a safe integer ≥ 1; a changed model is a new version).\n  e.g. ${MODEL_EXAMPLE_CALL}`,
    );
  }
  const version = requireSafeIntegerAtLeast(functionName, `${path}.version`, raw['version'], 1);
  requireCurrencyCode(functionName, `${path}.baseCurrency`, raw['baseCurrency']);
  const baseCurrency = raw['baseCurrency'] as string;
  if (raw['strategic'] === undefined) {
    missingField(
      functionName,
      `${path}.strategic`,
      `${path}.strategic is required — the dated strategic target set.\n  e.g. ${MODEL_EXAMPLE_CALL}`,
    );
  }
  const out: ModelPortfolioDefinition = {
    modelId: raw['modelId'],
    version,
    baseCurrency,
    strategic: requireTargetSet(functionName, `${path}.strategic`, raw['strategic']),
  };
  if (raw['tactical'] !== undefined) {
    requireArgumentArray(functionName, `${path}.tactical`, raw['tactical']);
    out.tactical = (raw['tactical'] as unknown[]).map((entry, index) =>
      requireTargetSet(functionName, `${path}.tactical[${index}]`, entry),
    );
  }
  if (raw['glidePath'] !== undefined) {
    out.glidePath = requireGlidePath(functionName, `${path}.glidePath`, raw['glidePath']);
  }
  if (raw['sleeves'] !== undefined) {
    out.sleeves = requireSleeves(functionName, `${path}.sleeves`, raw['sleeves']);
  }
  if (raw['benchmark'] !== undefined) {
    out.benchmark = requireBenchmark(functionName, `${path}.benchmark`, raw['benchmark']);
  }
  if (raw['liabilities'] !== undefined) {
    out.liabilities = requireLiabilities(functionName, `${path}.liabilities`, raw['liabilities']);
  }
  if (raw['horizonEndDate'] !== undefined) {
    requireInstant(functionName, `${path}.horizonEndDate`, raw['horizonEndDate']);
    out.horizonEndDate = raw['horizonEndDate'] as EpochMs | string;
  }
  if (raw['note'] !== undefined) {
    if (typeof raw['note'] !== 'string') {
      throw new InputError(`${functionName}: ${path}.note must be a string.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${path}.note` },
      });
    }
    out.note = raw['note'];
  }
  // Every sleeve target must name a declared sleeve.
  const sleeveIds = new Set((out.sleeves ?? []).map((s) => s.sleeveId));
  const sets: [string, TargetSet][] = [
    [`${path}.strategic`, out.strategic],
    ...(out.tactical ?? []).map((set, i): [string, TargetSet] => [`${path}.tactical[${i}]`, set]),
    ...(out.glidePath?.points ?? []).map((set, i): [string, TargetSet] => [
      `${path}.glidePath.points[${i}]`,
      set,
    ]),
  ];
  for (const [setPath, set] of sets) {
    set.targets.forEach((target, index) => {
      if (target.group.sleeveId !== undefined && !sleeveIds.has(target.group.sleeveId)) {
        outOfRange(
          functionName,
          `${setPath}.targets[${index}].group.sleeveId`,
          `${setPath}.targets[${index}] targets sleeve '${target.group.sleeveId}', which ${path}.sleeves does not declare.`,
        );
      }
    });
  }
  return out;
}

function modelContentHash(definition: ModelPortfolioDefinition): string {
  return contentHash({
    kind: MODEL_PORTFOLIO_KIND,
    schemaVersion: MODEL_PORTFOLIO_SCHEMA_VERSION,
    ...definition,
  });
}

/**
 * Freeze a {@link ModelPortfolioDefinition} into an immutable, content-addressed
 * {@link ModelPortfolio} artifact. The definition is fully validated first; the hash covers
 * everything (a changed target is a different model).
 *
 * @example
 * ```ts
 * import { createModelPortfolio } from '@totalfinance/portfolio/policy';
 *
 * const model = createModelPortfolio({
 *   modelId: 'balanced',
 *   version: 1,
 *   baseCurrency: 'USD',
 *   strategic: {
 *     effectiveFrom: '2026-01-01',
 *     targets: [
 *       { group: { tag: 'equity' }, weight: 0.6 },
 *       { group: { tag: 'fixed-income' }, weight: 0.3 },
 *       { group: { assetClass: 'cash' }, weight: 0.1 },
 *     ],
 *   },
 * });
 * model.contentHash; // 'sha256:…'
 * ```
 */
export function createModelPortfolio(definition: ModelPortfolioDefinition): ModelPortfolio {
  const functionName = 'createModelPortfolio';
  const validated = requireModelPortfolioDefinition(functionName, 'definition', definition);
  const artifact: ModelPortfolio = {
    kind: MODEL_PORTFOLIO_KIND,
    schemaVersion: MODEL_PORTFOLIO_SCHEMA_VERSION,
    ...validated,
    contentHash: modelContentHash(validated),
  };
  return deepFreeze(artifact);
}

/** Validate a {@link ModelPortfolio} artifact, including that its hash matches its content. */
export function requireModelPortfolio(
  functionName: string,
  path: string,
  value: unknown,
): ModelPortfolio {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, ARTIFACT_KEYS);
  const raw = value as Record<string, unknown>;
  if (raw['kind'] !== MODEL_PORTFOLIO_KIND) {
    throw new InputError(
      `${functionName}: ${path}.kind must be '${MODEL_PORTFOLIO_KIND}' (a createModelPortfolio artifact). Received ${describeInputValue(raw['kind'])}.`,
      {
        code: ErrorCode.SnapshotKindMismatch,
        context: { function: functionName, field: `${path}.kind` },
      },
    );
  }
  if (raw['schemaVersion'] !== MODEL_PORTFOLIO_SCHEMA_VERSION) {
    throw new InputError(
      `${functionName}: ${path}.schemaVersion must be ${MODEL_PORTFOLIO_SCHEMA_VERSION}. Received ${describeInputValue(raw['schemaVersion'])}.`,
      {
        code: ErrorCode.SnapshotUnsupportedVersion,
        context: { function: functionName, field: `${path}.schemaVersion` },
      },
    );
  }
  requireIdentityString(functionName, `${path}.contentHash`, raw['contentHash']);
  const body: Record<string, unknown> = { ...raw };
  delete body['kind'];
  delete body['schemaVersion'];
  delete body['contentHash'];
  const definition = requireModelPortfolioDefinition(functionName, path, body);
  const expected = modelContentHash(definition);
  if (expected !== raw['contentHash']) {
    throw new DataError(
      `${functionName}: ${path}.contentHash (${String(raw['contentHash'])}) does not match the model's content (${expected}) — the artifact was edited after creation. Create a new version with createModelPortfolio.`,
      {
        code: ErrorCode.ArtifactIdMismatch,
        context: { function: functionName, field: `${path}.contentHash` },
      },
    );
  }
  return {
    kind: MODEL_PORTFOLIO_KIND,
    schemaVersion: MODEL_PORTFOLIO_SCHEMA_VERSION,
    ...definition,
    contentHash: expected,
  };
}

/** Whether a value is a structurally valid, untampered model artifact (a predicate: never throws). */
export function isModelPortfolio(value: unknown): value is ModelPortfolio {
  try {
    requireModelPortfolio('isModelPortfolio', 'value', value);
    return true;
  } catch {
    return false;
  }
}

/** Validate {@link PolicyLimits}. */
export function requirePolicyLimits(
  functionName: string,
  path: string,
  value: unknown,
): PolicyLimits {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, LIMIT_KEYS);
  const raw = value as Record<string, unknown>;
  const out: PolicyLimits = {};
  if (raw['maximumPositionWeight'] !== undefined) {
    out.maximumPositionWeight = requireNonNegative(
      functionName,
      `${path}.maximumPositionWeight`,
      raw['maximumPositionWeight'],
    );
  }
  if (raw['maximumGroupWeights'] !== undefined) {
    requireArgumentArray(functionName, `${path}.maximumGroupWeights`, raw['maximumGroupWeights']);
    const seen = new Set<string>();
    out.maximumGroupWeights = (raw['maximumGroupWeights'] as unknown[]).map((entry, index) => {
      const entryPath = `${path}.maximumGroupWeights[${index}]`;
      requireArgumentObject(functionName, entryPath, entry);
      ensureKnownKeys(functionName, entryPath, entry as object, GROUP_LIMIT_KEYS);
      const limit = entry as Record<string, unknown>;
      const group = requireTargetGroup(functionName, `${entryPath}.group`, limit['group']);
      const key = targetGroupKey(group);
      if (seen.has(key))
        outOfRange(functionName, entryPath, `${path}.maximumGroupWeights limits '${key}' twice.`);
      seen.add(key);
      return {
        group,
        maximumWeight: requireNonNegative(
          functionName,
          `${entryPath}.maximumWeight`,
          limit['maximumWeight'],
        ),
      };
    });
  }
  if (raw['maximumGrossLeverage'] !== undefined) {
    requirePositiveNumberField(
      functionName,
      `${path}.maximumGrossLeverage`,
      raw['maximumGrossLeverage'],
      'gross exposure ÷ NAV (1 = unlevered)',
    );
    out.maximumGrossLeverage = raw['maximumGrossLeverage'] as number;
  }
  if (raw['maximumDrawdown'] !== undefined) {
    const v = requireNonNegative(functionName, `${path}.maximumDrawdown`, raw['maximumDrawdown']);
    if (v > 1)
      outOfRange(
        functionName,
        `${path}.maximumDrawdown`,
        `${path}.maximumDrawdown is a decimal in [0, 1]. Received ${v}.`,
      );
    out.maximumDrawdown = v;
  }
  if (raw['maximumDailyLoss'] !== undefined) {
    const v = requireNonNegative(functionName, `${path}.maximumDailyLoss`, raw['maximumDailyLoss']);
    if (v > 1)
      outOfRange(
        functionName,
        `${path}.maximumDailyLoss`,
        `${path}.maximumDailyLoss is a decimal in [0, 1]. Received ${v}.`,
      );
    out.maximumDailyLoss = v;
  }
  if (raw['maximumDaysToLiquidate'] !== undefined) {
    requirePositiveNumberField(
      functionName,
      `${path}.maximumDaysToLiquidate`,
      raw['maximumDaysToLiquidate'],
      'a liquidation horizon in days',
    );
    out.maximumDaysToLiquidate = raw['maximumDaysToLiquidate'] as number;
  }
  if (raw['minimumSettledCash'] !== undefined) {
    requireFiniteNumberField(functionName, `${path}.minimumSettledCash`, raw['minimumSettledCash']);
    out.minimumSettledCash = raw['minimumSettledCash'];
  }
  return out;
}

/**
 * Validate an {@link InvestmentPolicy}: closed keys, typed limits, targets inline XOR from a model
 * artifact (whose hash is re-verified), identity lists without duplicates.
 */
export function requireInvestmentPolicy(
  functionName: string,
  path: string,
  value: unknown,
): InvestmentPolicy {
  requireArgumentObject(functionName, path, value);
  ensureKnownKeys(functionName, path, value as object, POLICY_KEYS);
  const raw = value as Record<string, unknown>;
  const out: InvestmentPolicy = {};
  if (raw['targets'] !== undefined && raw['model'] !== undefined) {
    outOfRange(
      functionName,
      path,
      `${path} declares both targets and model — a policy's goals come from exactly one place.`,
    );
  }
  if (raw['targets'] !== undefined) {
    out.targets = requireAllocationTargets(functionName, `${path}.targets`, raw['targets']);
  }
  if (raw['model'] !== undefined) {
    out.model = requireModelPortfolio(functionName, `${path}.model`, raw['model']);
  }
  if (raw['withinGroupAllocation'] !== undefined) {
    out.withinGroupAllocation = requireLiteral(
      functionName,
      `${path}.withinGroupAllocation`,
      raw['withinGroupAllocation'],
      WITHIN_GROUP_ALLOCATIONS,
    );
  }
  if (raw['driftBand'] !== undefined) {
    out.driftBand = requireNonNegative(functionName, `${path}.driftBand`, raw['driftBand']);
  }
  if (raw['reviewCadenceDays'] !== undefined) {
    requirePositiveNumberField(
      functionName,
      `${path}.reviewCadenceDays`,
      raw['reviewCadenceDays'],
      'a review cadence in days',
    );
    out.reviewCadenceDays = raw['reviewCadenceDays'] as number;
  }
  if (raw['maximumTurnover'] !== undefined) {
    out.maximumTurnover = requireNonNegative(
      functionName,
      `${path}.maximumTurnover`,
      raw['maximumTurnover'],
    );
  }
  if (raw['maximumEstimatedTransactionCost'] !== undefined) {
    out.maximumEstimatedTransactionCost = requireNonNegative(
      functionName,
      `${path}.maximumEstimatedTransactionCost`,
      raw['maximumEstimatedTransactionCost'],
    );
  }
  if (raw['minimumCash'] !== undefined) {
    requireFiniteNumberField(functionName, `${path}.minimumCash`, raw['minimumCash']);
    out.minimumCash = raw['minimumCash'];
  }
  if (raw['minimumCashWeight'] !== undefined) {
    const v = requireNonNegative(
      functionName,
      `${path}.minimumCashWeight`,
      raw['minimumCashWeight'],
    );
    if (v > 1)
      outOfRange(
        functionName,
        `${path}.minimumCashWeight`,
        `${path}.minimumCashWeight is a decimal of NAV in [0, 1]. Received ${v}.`,
      );
    out.minimumCashWeight = v;
  }
  if (raw['limits'] !== undefined) {
    out.limits = requirePolicyLimits(functionName, `${path}.limits`, raw['limits']);
  }
  if (raw['allowedInstruments'] !== undefined) {
    out.allowedInstruments = requireIdentityList(
      functionName,
      `${path}.allowedInstruments`,
      raw['allowedInstruments'],
    );
  }
  if (raw['restrictedInstruments'] !== undefined) {
    out.restrictedInstruments = requireIdentityList(
      functionName,
      `${path}.restrictedInstruments`,
      raw['restrictedInstruments'],
    );
  }
  if (out.allowedInstruments !== undefined && out.restrictedInstruments !== undefined) {
    const both = out.allowedInstruments.filter((id) => out.restrictedInstruments!.includes(id));
    if (both.length > 0) {
      outOfRange(
        functionName,
        `${path}.restrictedInstruments`,
        `${path} both allows and restricts ${both.join(', ')}.`,
      );
    }
  }
  if (raw['allowedAccounts'] !== undefined) {
    out.allowedAccounts = requireIdentityList(
      functionName,
      `${path}.allowedAccounts`,
      raw['allowedAccounts'],
    );
  }
  if (raw['benchmark'] !== undefined) {
    out.benchmark = requireBenchmark(functionName, `${path}.benchmark`, raw['benchmark']);
  }
  if (raw['performanceObjective'] !== undefined) {
    if (typeof raw['performanceObjective'] !== 'string') {
      throw new InputError(`${functionName}: ${path}.performanceObjective must be a string.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${path}.performanceObjective` },
      });
    }
    out.performanceObjective = raw['performanceObjective'];
  }
  if (raw['contributionHandling'] !== undefined) {
    out.contributionHandling = requireLiteral(
      functionName,
      `${path}.contributionHandling`,
      raw['contributionHandling'],
      CONTRIBUTION_HANDLINGS,
    );
  }
  if (raw['withdrawalHandling'] !== undefined) {
    out.withdrawalHandling = requireLiteral(
      functionName,
      `${path}.withdrawalHandling`,
      raw['withdrawalHandling'],
      WITHDRAWAL_HANDLINGS,
    );
  }
  if (raw['incomeReinvestment'] !== undefined) {
    out.incomeReinvestment = requireLiteral(
      functionName,
      `${path}.incomeReinvestment`,
      raw['incomeReinvestment'],
      INCOME_REINVESTMENTS,
    );
  }
  if (raw['lotSelectionObjective'] !== undefined) {
    requireIdentityString(
      functionName,
      `${path}.lotSelectionObjective`,
      raw['lotSelectionObjective'],
    );
    out.lotSelectionObjective = raw['lotSelectionObjective'];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Resolution — which targets are effective at an instant
// ---------------------------------------------------------------------------------------------------

function interpolateTargets(from: TargetSet, to: TargetSet, fraction: number): AllocationTarget[] {
  const later = new Map(to.targets.map((t) => [targetGroupKey(t.group), t] as const));
  return from.targets.map((target) => {
    const next = later.get(targetGroupKey(target.group))!;
    const out: AllocationTarget = {
      group: target.group,
      weight: target.weight! + (next.weight! - target.weight!) * fraction,
    };
    const band = next.driftBand ?? target.driftBand;
    if (band !== undefined) out.driftBand = band;
    return out;
  });
}

/** Input for {@link resolveModelTargets}. */
export interface ResolveModelTargetsInput {
  model: ModelPortfolio;
  /** The instant to resolve at (`'YYYY-MM-DD'`, zoned ISO datetime, or epoch ms). */
  asOf: EpochMs | string;
}

const RESOLVE_KEYS = ['model', 'asOf'] as const;

/**
 * The targets a model makes effective at `asOf`: the latest tactical set covering the instant,
 * else the glide path (stepped or interpolated), else the strategic set. An instant before the
 * strategic set is effective is a typed refusal — a model has no targets there.
 *
 * @example
 * ```ts
 * const effective = resolveModelTargets({ model, asOf: '2026-06-30' });
 * effective.source; // 'strategic' | 'tactical' | 'glide-path'
 * ```
 */
export function resolveModelTargets(input: ResolveModelTargetsInput): ResolvedTargets {
  const functionName = 'resolveModelTargets';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input as object, RESOLVE_KEYS);
  if (input.asOf === undefined) {
    missingField(
      functionName,
      'asOf',
      `asOf is required — a model's targets are dated, so the instant they are resolved at is a goal, not a default.\n  e.g. resolveModelTargets({ model, asOf: '2026-06-30' })`,
    );
  }
  const { model, asOf } = input;
  const validated = requireModelPortfolio(functionName, 'model', model);
  const instant = requireInstant(functionName, 'asOf', asOf);
  let winner: { set: TargetSet; from: EpochMs } | null = null;
  for (const set of validated.tactical ?? []) {
    const from = resolveAsOf(set.effectiveFrom, functionName);
    const to =
      set.effectiveTo === undefined ? Infinity : resolveAsOf(set.effectiveTo, functionName);
    if (from <= instant && instant < to && (winner === null || from >= winner.from)) {
      winner = { set, from };
    }
  }
  if (winner !== null) {
    return { targets: winner.set.targets, source: 'tactical', effectiveFrom: winner.from };
  }
  if (validated.glidePath !== undefined) {
    const points = validated.glidePath.points.map((set) => ({
      set,
      from: resolveAsOf(set.effectiveFrom, functionName),
    }));
    let index = -1;
    for (let i = 0; i < points.length; i++) if (points[i]!.from <= instant) index = i;
    if (index >= 0) {
      const current = points[index]!;
      const next = points[index + 1];
      if (validated.glidePath.interpolation === 'linear' && next !== undefined) {
        const fraction = (instant - current.from) / (next.from - current.from);
        return {
          targets: interpolateTargets(current.set, next.set, fraction),
          source: 'glide-path',
          effectiveFrom: current.from,
          interpolation: { from: current.from, to: next.from, fraction },
        };
      }
      return { targets: current.set.targets, source: 'glide-path', effectiveFrom: current.from };
    }
  }
  const strategicFrom = resolveAsOf(validated.strategic.effectiveFrom, functionName);
  if (instant < strategicFrom) {
    outOfRange(
      functionName,
      'asOf',
      `no target set is effective at ${epochMsToUtcDate(instant)} — the strategic set of model '${validated.modelId}' v${validated.version} starts ${epochMsToUtcDate(strategicFrom)}. A model has no goals before its first dated set.`,
    );
  }
  return {
    targets: validated.strategic.targets,
    source: 'strategic',
    effectiveFrom: strategicFrom,
  };
}

/**
 * The targets a POLICY makes effective at `asOf`: inline targets verbatim, or the model's
 * resolution. A policy without targets is a typed refusal from the caller that needs them.
 */
export function resolvePolicyTargets(
  functionName: string,
  policy: InvestmentPolicy,
  asOf: EpochMs | string,
): ResolvedTargets {
  if (policy.targets !== undefined) {
    return { targets: policy.targets, source: 'inline', effectiveFrom: null };
  }
  if (policy.model !== undefined) return resolveModelTargets({ model: policy.model, asOf });
  throw new InputError(
    `${functionName}: policy declares no targets — give policy.targets or policy.model (a createModelPortfolio artifact). Missing goals are never defaulted.\n  e.g. ${POLICY_EXAMPLE}`,
    {
      code: ErrorCode.InputMissingField,
      context: { function: functionName, field: 'policy.targets' },
    },
  );
}

// ---------------------------------------------------------------------------------------------------
// Expansion — group targets to instrument targets
// ---------------------------------------------------------------------------------------------------

/** The classification group keys an instrument belongs to (`'assetClass:equity'`, `'tag:tech'`, …). */
export function instrumentGroupKeys(
  instrumentId: string,
  classification: InstrumentClassification | undefined,
  currency: string | undefined,
): string[] {
  const keys = [`instrumentId:${instrumentId}`];
  if (currency !== undefined) keys.push(`currency:${currency}`);
  if (classification?.assetClass !== undefined)
    keys.push(`assetClass:${classification.assetClass}`);
  if (classification?.underlying !== undefined)
    keys.push(`underlying:${classification.underlying}`);
  if (classification?.strategy !== undefined) keys.push(`strategy:${classification.strategy}`);
  for (const tag of classification?.tags ?? []) keys.push(`tag:${tag}`);
  return keys;
}

/** Leaf instrument weights of a sleeve subtree, each scaled by the path's within-parent weights. */
function sleeveLeafWeights(sleeveId: string, sleeves: ModelSleeve[]): Map<string, number> {
  const out = new Map<string, number>();
  const sleeve = sleeves.find((s) => s.sleeveId === sleeveId)!;
  if (sleeve.members !== undefined) {
    for (const member of sleeve.members) {
      out.set(member.instrumentId, (out.get(member.instrumentId) ?? 0) + member.weight);
    }
    return out;
  }
  for (const child of sleeves.filter((s) => s.parentSleeveId === sleeveId)) {
    for (const [instrumentId, weight] of sleeveLeafWeights(child.sleeveId, sleeves)) {
      out.set(instrumentId, (out.get(instrumentId) ?? 0) + weight * child.weightWithinParent!);
    }
  }
  return out;
}

/**
 * Expand resolved group targets to per-instrument target weights under the ONE resolution law:
 *
 * - `instrumentId` targets bind directly; `sleeveId` targets flow down the sleeve tree;
 * - classification/currency targets bind to the universe members that carry the group and split
 *   by `withinGroupAllocation` (REQUIRED when a group has more than one member — never guessed);
 * - an instrument named by two targets is a CONFLICT (both unresolved); a group with no members
 *   is unresolved; a risk-budget target is unresolved (needs a covariance — risk side);
 * - `{ assetClass: 'cash' }` is the cash target. When the declared weights sum to 1, every
 *   uncovered instrument (and a missing cash target) has an IMPLIED target of 0 and is flagged
 *   `implied`; when they sum to less than 1 the remainder is undeclared and the uncovered
 *   instruments are unresolved — missing goals do not become secret defaults.
 */
export function expandTargets(functionName: string, input: ExpandTargetsInput): ExpandedTargets {
  const warnings: string[] = [];
  const unresolved: UnresolvedTarget[] = [];
  const groupTargets: GroupTarget[] = [];
  const perInstrument = new Map<
    string,
    { weight: number; band: number | null; sources: string[] }
  >();
  const universe = [...new Set(input.universe)].sort();
  const universeKeys = new Map(
    universe.map((id) => [
      id,
      new Set(
        instrumentGroupKeys(
          id,
          ownValue(input.instrumentClassification, id),
          ownValue(input.instrumentCurrency, id),
        ),
      ),
    ]),
  );
  let cashTarget: ExpandedTargets['cashTarget'] = null;
  let declaredWeightTotal = 0;

  const bind = (
    instrumentId: string,
    weight: number,
    band: number | null,
    source: string,
  ): void => {
    const existing = perInstrument.get(instrumentId);
    if (existing === undefined) {
      perInstrument.set(instrumentId, { weight, band, sources: [source] });
      return;
    }
    existing.weight += weight;
    existing.sources.push(source);
    if (band !== null)
      existing.band = existing.band === null ? band : Math.min(existing.band, band);
  };

  for (const target of input.targets) {
    const key = targetGroupKey(target.group);
    const band = target.driftBand ?? input.defaultDriftBand ?? null;
    if (target.riskBudget !== undefined) {
      unresolved.push({
        key,
        group: target.group,
        reason: `risk budget ${target.riskBudget} needs a covariance to become weights — resolve it on the risk side (@totalfinance/risk) and restate as weight targets.`,
      });
      continue;
    }
    const weight = target.weight!;
    declaredWeightTotal += weight;
    if (isCashTargetGroup(target.group)) {
      cashTarget = { targetWeight: weight, driftBand: band, implied: false };
      groupTargets.push({
        key,
        group: target.group,
        targetWeight: weight,
        driftBand: band,
        members: [],
      });
      continue;
    }
    if (target.group.instrumentId !== undefined) {
      const id = target.group.instrumentId;
      if (!universeKeys.has(id)) {
        universe.push(id);
        universeKeys.set(
          id,
          new Set(
            instrumentGroupKeys(
              id,
              ownValue(input.instrumentClassification, id),
              ownValue(input.instrumentCurrency, id),
            ),
          ),
        );
      }
      bind(id, weight, band, key);
      groupTargets.push({
        key,
        group: target.group,
        targetWeight: weight,
        driftBand: band,
        members: [id],
      });
      continue;
    }
    if (target.group.sleeveId !== undefined) {
      const leaves = sleeveLeafWeights(target.group.sleeveId, input.sleeves);
      const members = [...leaves.keys()].sort();
      for (const id of members) {
        if (!universeKeys.has(id)) {
          universe.push(id);
          universeKeys.set(
            id,
            new Set(
              instrumentGroupKeys(
                id,
                ownValue(input.instrumentClassification, id),
                ownValue(input.instrumentCurrency, id),
              ),
            ),
          );
        }
        bind(id, weight * leaves.get(id)!, band, key);
      }
      groupTargets.push({
        key,
        group: target.group,
        targetWeight: weight,
        driftBand: band,
        members,
      });
      continue;
    }
    // Classification / currency dimension.
    const members = universe.filter((id) => universeKeys.get(id)!.has(key)).sort();
    if (members.length === 0) {
      unresolved.push({
        key,
        group: target.group,
        reason: `no instrument in the universe carries '${key}' — declare the group's members through instrumentClassification (or a sleeve), or add an instrumentId target.`,
      });
      groupTargets.push({
        key,
        group: target.group,
        targetWeight: weight,
        driftBand: band,
        members: [],
      });
      continue;
    }
    if (members.length === 1) {
      bind(members[0]!, weight, band, key);
    } else if (input.withinGroupAllocation === undefined) {
      unresolved.push({
        key,
        group: target.group,
        reason: `'${key}' resolves to ${members.length} instruments (${members.join(', ')}) and the policy declares no withinGroupAllocation ('proportional-to-current' or 'equal') — how a group target splits is a goal, not a default.`,
      });
      groupTargets.push({
        key,
        group: target.group,
        targetWeight: weight,
        driftBand: band,
        members,
      });
      continue;
    } else {
      const current = members.map((id) => Math.abs(ownValue(input.currentWeights, id) ?? 0));
      const currentTotal = sum(current);
      const equal = input.withinGroupAllocation === 'equal' || currentTotal <= WEIGHT_TOLERANCE;
      if (
        input.withinGroupAllocation === 'proportional-to-current' &&
        currentTotal <= WEIGHT_TOLERANCE
      ) {
        warnings.push(
          `'${key}' has no current holdings to split proportionally; its ${members.length} members are split equally.`,
        );
      }
      members.forEach((id, index) => {
        const share = equal ? 1 / members.length : current[index]! / currentTotal;
        bind(id, weight * share, band, key);
      });
    }
    groupTargets.push({ key, group: target.group, targetWeight: weight, driftBand: band, members });
  }

  // Conflicts: an instrument bound by two different targets is two goals for one holding.
  const conflicted = new Set<string>();
  for (const [id, entry] of perInstrument) {
    if (entry.sources.length > 1) {
      conflicted.add(id);
      for (const source of entry.sources) {
        if (!unresolved.some((u) => u.key === source)) {
          const group = groupTargets.find((g) => g.key === source)!.group;
          unresolved.push({
            key: source,
            group,
            reason: `'${id}' is targeted by ${entry.sources.join(' and ')} — overlapping targets on one instrument conflict; restate them on one dimension.`,
          });
        }
      }
      perInstrument.delete(id);
    }
  }

  const covered = new Set(perInstrument.keys());
  const fullyDeclared = Math.abs(declaredWeightTotal - 1) <= WEIGHT_TOLERANCE;
  const instrumentTargets: InstrumentTarget[] = [];
  for (const id of universe) {
    const entry = perInstrument.get(id);
    if (entry !== undefined) {
      instrumentTargets.push({
        instrumentId: id,
        targetWeight: entry.weight,
        driftBand: entry.band,
        sourceGroups: entry.sources,
        implied: false,
      });
      continue;
    }
    if (covered.has(id) || conflicted.has(id)) continue;
    if (fullyDeclared) {
      instrumentTargets.push({
        instrumentId: id,
        targetWeight: 0,
        driftBand: input.defaultDriftBand ?? null,
        sourceGroups: [],
        implied: true,
      });
    } else if (!unresolved.some((u) => u.key === `instrumentId:${id}`)) {
      unresolved.push({
        key: `instrumentId:${id}`,
        group: { instrumentId: id },
        reason: `'${id}' is covered by no target and the declared targets sum to ${readable(declaredWeightTotal)} of NAV, not 1 — declare the remaining ${readable(1 - declaredWeightTotal)} (a cash target, or targets naming this holding).`,
      });
    }
  }
  if (cashTarget === null && fullyDeclared) {
    cashTarget = { targetWeight: 0, driftBand: input.defaultDriftBand ?? null, implied: true };
  } else if (
    cashTarget === null &&
    declaredWeightTotal < 1 - WEIGHT_TOLERANCE &&
    universe.every((id) => perInstrument.has(id))
  ) {
    unresolved.push({
      key: `assetClass:${CASH_ASSET_CLASS}`,
      group: { assetClass: CASH_ASSET_CLASS },
      reason: `the declared targets sum to ${readable(declaredWeightTotal)} of NAV and there is no cash target — declare { assetClass: 'cash' } for the remaining ${readable(1 - declaredWeightTotal)}, or targets that use it.`,
    });
  }
  if (declaredWeightTotal > 1 + WEIGHT_TOLERANCE) {
    unresolved.push({
      key: 'targets',
      group: { assetClass: CASH_ASSET_CLASS },
      reason: `the declared targets sum to ${readable(declaredWeightTotal)} of NAV across dimensions — more than the whole portfolio; overlapping dimensions must not double-count.`,
    });
  }
  instrumentTargets.sort((a, b) =>
    a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0,
  );
  return { instrumentTargets, groupTargets, cashTarget, declaredWeightTotal, unresolved, warnings };
}

/** The policy grammar's conventions, echoed by every consumer. */
export const POLICY_CONVENTIONS_VERSION = CONVENTIONS_VERSION;
