/**
 * "Explain this position" narrative (spec §12, roadmap Tier 3, agent-native). Turn a {@link Position}
 * into a structured explanation + a prose summary an agent can relay: what the structure IS, the thesis
 * it expresses (direction, movement vs stability, vol/time posture), the economics, the probability of
 * profit, and the risks. Every claim is grounded in an existing engine primitive — `classifyStrategy`,
 * `metrics()`, `pnlAtExpiry` (market-free posture), `probability()`, and `value().greeks` — never
 * invented. Degrades gracefully: without a market it still names, describes, and gives the economics +
 * directional/move posture. See `docs/specs/explain-position.md`.
 */

import {
  resolveValuationAsOf,
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  ErrorCode,
  ensurePositive,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureKnownKeys,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import { classifyStrategy } from './classify.js';
import { rewardToRisk, type Position } from './position.js';
import { ensureOptionalMarketExpiry } from './validate.js';
import type { Leg, MarkToMarketInput } from './types.js';

/** Options for {@link explainPosition}. */
export interface ExplainPositionOptions {
  /** Market for probability + greeks (spot/vol/rate/asOf); merges over the position's own market. */
  market?: Partial<MarkToMarketInput>;
  /** Underlying name for the prose (e.g. `'AAPL'`); default `'the underlying'`. */
  underlyingLabel?: string;
}

/** {@link ExplainPositionOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const EXPLAIN_POSITION_OPTIONS_KEYS = ['market', 'underlyingLabel'] as const;

export type DirectionalBias = 'bullish' | 'bearish' | 'neutral';
export type MoveBias = 'wants-movement' | 'wants-stability' | 'neutral';
export type VolatilityBias =
  | 'benefits-from-rising-impliedVolatility'
  | 'benefits-from-falling-impliedVolatility'
  | 'neutral';
export type TimeBias = 'decay-helps' | 'decay-hurts' | 'neutral';

/** A structured, prose-ready explanation of a position. */
export interface PositionExplanation {
  /** The classification, or `'custom'`. */
  name: string;
  /** Other payoff-identical names. */
  aliases: string[];
  /** Readable leg list, sorted by strike. */
  structure: string;
  directionalBias: DirectionalBias;
  moveBias: MoveBias;
  definedRisk: boolean;
  economics: {
    /** Net cash: `+` = debit paid, `−` = credit received (per contract). */
    net: number;
    /** Maximum profit, or `null` when unbounded. */
    maxProfit: number | null;
    /** Maximum loss (negative), or `null` when unbounded. */
    maxLoss: number | null;
    breakevens: number[];
    /** `|maxProfit / maxLoss|`, or `null` when undefined (an unbounded side or a zero max loss). */
    rewardToRisk: number | null;
  };
  /** Present when a market is available. */
  volatilityBias?: VolatilityBias;
  timeBias?: TimeBias;
  probability?: { probabilityOfProfit: number; expectedValue: number };
  greeks?: { delta: number; gamma: number; theta: number; vega: number; rho: number };
  risks: string[];
  /** The prose narrative composing all of the above. */
  summary: string;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    /** How the name was derived — always the structural classifier (identity is never remembered). */
    classifier: 'structural-base-signature';
    /** Whether a usable market priced the greek/probability posture (false = payoff-only read). */
    marketDependent: boolean;
  };
  /** Structured warnings; always present (possibly empty) — a missing market explains itself here. */
  diagnostics: { warnings: QuantWarning[] };
}

/** A strategy Position built by `strategy(...)` / a named builder — not a raw object. */
function requirePosition(position: unknown): asserts position is Position {
  const p = position as { legs?: unknown; metrics?: unknown; pnlAtExpiry?: unknown } | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    !Array.isArray(p.legs) ||
    typeof p.metrics !== 'function' ||
    typeof p.pnlAtExpiry !== 'function'
  ) {
    throw new InputError(
      'explainPosition: position must be a strategy Position (from strategy(...) or a named builder).',
      { code: ErrorCode.InputWrongType },
    );
  }
}

/** `$1,234.50`, or `−$…`; an unbounded amount (`null`) renders as the word. */
function money(n: number | null): string {
  if (n === null) return 'unbounded';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `−$${s}` : `$${s}`;
}

/** A price, compactly (no currency). */
function price(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
}

/** One leg, human-readable. */
function describeLeg(leg: Leg): string {
  const side = leg.quantity > 0 ? 'long' : 'short';
  const qty = Math.abs(leg.quantity);
  // A stock leg's quantity is ALREADY in shares (`coveredCall` builds `quantity: 100 · contracts`),
  // so the ×100 here re-applied the contract multiplier and described a 1-lot covered call as
  // "long 10000 shares".
  if (leg.kind === 'stock') return `${side} ${qty} shares @ ${price(leg.price)}`;
  return `${side} ${qty} ${leg.kind} @ ${price(leg.strike)} (${money(leg.premium)})`;
}

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

/** Builder name → readable phrase for prose (`ironCondor` → `iron condor`). */
function humanize(name: string): string {
  if (name === 'custom') return 'custom position';
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Explain a {@link Position}: name, structure, posture, economics, probability, greeks, risks, and a
 * prose summary. See the spec.
 */
/** `market.legVolatilities`, when present: an array aligned to the legs, each stated entry a positive volatility. */
function requireLegVolatilitiesWhenPresent(
  value: unknown,
  legCount: number,
  functionName: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== legCount) {
    throw new InputError(
      `${functionName}: market.legVolatilities must be an array aligned to the position's ${legCount} legs (a number overrides that leg's volatility; undefined leaves it). Received ${Array.isArray(value) ? `${value.length} entries` : value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongShape, context: { field: 'market.legVolatilities' } },
    );
  }
  value.forEach((v, i) => {
    if (v === undefined) return;
    ensurePositive(
      v as number,
      `market.legVolatilities[${i}]`,
      functionName,
      ErrorCode.InputNegativeVolatility,
    );
  });
}

export function explainPosition(
  position: Position,
  options: ExplainPositionOptions = {},
): PositionExplanation {
  requirePosition(position);
  requireArgumentObject('explainPosition', 'options', options);
  // Law 12: a misspelled option (`underlyinglabel`) must teach, never silently fall to the default.
  ensureKnownKeys('explainPosition', 'options', options, EXPLAIN_POSITION_OPTIONS_KEYS);
  // A null market is a wrong-typed value, not "no market" (the 350c2796 ruling): probability and
  // greeks would silently degrade to the market-free posture the caller thought they overrode.
  if (options.market !== undefined) {
    if (options.market === null || typeof options.market !== 'object') {
      throw new InputError(
        `explainPosition: market must be an object of market fields when provided. Received ${options.market === null ? 'null' : typeof options.market}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'market' } },
      );
    }
    for (const field of [
      'spot',
      'volatility',
      'riskFreeRate',
      'dividendYield',
      'volatilityShock',
    ] as const) {
      ensureFiniteWhenPresent(
        (options.market as Record<string, unknown>)[field],
        `market.${field}`,
        'explainPosition',
      );
    }
    ensureOptionalMarketExpiry(
      (options.market as Record<string, unknown>)['expiry'],
      'explainPosition',
    );
    // Preview P1: per-leg volatility overrides ride the same market shape `value()` takes — validate
    // them here too, so a null or a misaligned array teaches instead of passing through unread.
    requireLegVolatilitiesWhenPresent(
      (options.market as Record<string, unknown>)['legVolatilities'],
      position.legs.length,
      'explainPosition',
    );
    const asOf = (options.market as Record<string, unknown>)['asOf'];
    if (asOf !== undefined && typeof asOf === 'number' && !Number.isFinite(asOf)) {
      throw new InputError(
        `explainPosition: market.asOf must be a FINITE epoch-ms number when numeric. Received ${String(asOf)}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'market.asOf' } },
      );
    }
    if (asOf !== undefined && typeof asOf !== 'string' && typeof asOf !== 'number') {
      throw new InputError(
        `explainPosition: market.asOf must be an ISO date string (or epoch ms) when provided. Received ${asOf === null ? 'null' : typeof asOf}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'market.asOf' } },
      );
    }
    // Resolve EAGERLY: an unparseable asOf string used to be silently ignored whenever the market
    // was too thin for greeks — same garbage, teaching on one path and silence on the other.
    if (asOf !== undefined) resolveValuationAsOf(asOf as string | number, 'explainPosition');
  }
  if (options.underlyingLabel !== undefined && typeof options.underlyingLabel !== 'string') {
    throw new InputError(
      `explainPosition: underlyingLabel must be a string when provided. Received ${options.underlyingLabel === null ? 'null' : typeof options.underlyingLabel}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'underlyingLabel' } },
    );
  }
  const label = options.underlyingLabel ?? 'the underlying';

  // Name.
  const { matches } = classifyStrategy(position);
  const name = matches[0]?.name ?? 'custom';
  const aliases = matches.slice(1).map((m) => m.name);

  // Economics (also enforces single-expiry — a payoff posture is single-expiration).
  const m = position.metrics();
  const definedRisk = m.bounded.loss;
  const economics = {
    net: m.netDebit,
    maxProfit: m.maxProfit,
    maxLoss: m.maxLoss,
    breakevens: m.breakevens,
    // The ONE reward-to-risk definition (B3): `null` when undefined — an unbounded side or a zero
    // max loss — exactly as `probability().riskReward` reports it, so the two engine reads of the
    // same position never disagree and no `Infinity` reads as "the best possible trade".
    rewardToRisk: rewardToRisk(m).ratio,
  };

  // Structure, sorted by strike (stock legs at their entry price).
  const structure = [...position.legs]
    .sort(
      (a, b) =>
        (a.kind === 'stock' ? a.price : a.strike) - (b.kind === 'stock' ? b.price : b.strike),
    )
    .map(describeLeg)
    .join(', ');

  // Market-free posture from the payoff shape.
  const refs = position.legs
    .map((l) => (l.kind === 'stock' ? l.price : l.strike))
    .filter((x) => x > 0);
  const kMin = refs.length ? Math.min(...refs) : 1;
  const kMax = refs.length ? Math.max(...refs) : 100;
  const span = kMax - kMin || kMax * 0.4 || 1;
  const lowP = Math.max(0.01, kMin - span);
  const highP = kMax + span;
  const centerP = (kMin + kMax) / 2;
  const pnlLow = position.pnlAtExpiry(lowP);
  const pnlHigh = position.pnlAtExpiry(highP);
  const pnlCenter = position.pnlAtExpiry(centerP);
  const scale = Math.max(Math.abs(pnlLow), Math.abs(pnlHigh), Math.abs(pnlCenter), 1);
  const band = 0.25 * scale;

  const directionalBias: DirectionalBias =
    Math.abs(pnlHigh - pnlLow) < band ? 'neutral' : pnlHigh > pnlLow ? 'bullish' : 'bearish';
  const tailAverage = (pnlLow + pnlHigh) / 2;
  const moveBias: MoveBias =
    pnlCenter > tailAverage + band
      ? 'wants-stability'
      : tailAverage > pnlCenter + band
        ? 'wants-movement'
        : 'neutral';

  // Market-dependent: greeks (vol/time posture) and probability. Omit if the market can't price them.
  let greeks: PositionExplanation['greeks'];
  let volatilityBias: VolatilityBias | undefined;
  let timeBias: TimeBias | undefined;
  try {
    const g = position.value(options.market ?? {}).greeks;
    greeks = { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: g.rho };
    volatilityBias =
      g.vega > 1e-9
        ? 'benefits-from-rising-impliedVolatility'
        : g.vega < -1e-9
          ? 'benefits-from-falling-impliedVolatility'
          : 'neutral';
    timeBias = g.theta > 1e-9 ? 'decay-helps' : g.theta < -1e-9 ? 'decay-hurts' : 'neutral';
  } catch {
    // No / insufficient market — greek posture omitted (disclosed in the summary).
  }
  let probability: PositionExplanation['probability'];
  try {
    const p = position.probability(options.market ?? {});
    probability = { probabilityOfProfit: p.probabilityOfProfit, expectedValue: p.expectedValue };
  } catch {
    // No / insufficient market — probability omitted.
  }

  // Risks.
  const risks: string[] = [];
  if (!definedRisk) risks.push('Undefined risk — the maximum loss is not capped.');
  for (const leg of position.legs) {
    if (leg.kind !== 'stock' && leg.quantity < 0) {
      risks.push(
        `Assignment risk — the short ${leg.kind} at ${price(leg.strike)} can be assigned if it is in the money at expiry.`,
      );
    }
  }
  const decayHurts = timeBias !== undefined ? timeBias === 'decay-hurts' : m.netDebit > 0;
  if (decayHurts) {
    risks.push(
      `Time decay works against the position — it loses value each day ${label} sits still.`,
    );
  }

  // Prose.
  const hasMarket = greeks !== undefined || probability !== undefined;
  const summary = composeSummary({
    name,
    label,
    definedRisk,
    directionalBias,
    moveBias,
    economics,
    probability,
    volatilityBias,
    timeBias,
    hasMarket,
    risks,
  });

  // Law 2 report grammar: the omitted market-dependent posture is DISCLOSED as a structured
  // warning, not just prose (the summary sentence and this warning always agree).
  const warnings: QuantWarning[] = [];
  if (!hasMarket) {
    warnings.push(
      warning(
        WarningCode.GreeksNotComputed,
        'No/insufficient market — the greek posture and probability of profit were omitted; supply market: { spot, volatility, riskFreeRate, asOf }.',
        'info',
      ),
    );
  }

  return {
    name,
    aliases,
    structure,
    directionalBias,
    moveBias,
    definedRisk,
    economics,
    ...(volatilityBias !== undefined ? { volatilityBias } : {}),
    ...(timeBias !== undefined ? { timeBias } : {}),
    ...(probability !== undefined ? { probability } : {}),
    ...(greeks !== undefined ? { greeks } : {}),
    risks,
    summary,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      classifier: 'structural-base-signature',
      marketDependent: hasMarket,
    },
    diagnostics: { warnings },
  };
}

interface SummaryParts {
  name: string;
  label: string;
  definedRisk: boolean;
  directionalBias: DirectionalBias;
  moveBias: MoveBias;
  economics: PositionExplanation['economics'];
  probability: PositionExplanation['probability'];
  volatilityBias: VolatilityBias | undefined;
  timeBias: TimeBias | undefined;
  hasMarket: boolean;
  risks: string[];
}

/** Compose the natural-language summary from the computed facts. */
function composeSummary(p: SummaryParts): string {
  const noun = humanize(p.name);
  const risk = p.definedRisk ? 'defined-risk' : 'undefined-risk';
  const sentences: string[] = [];

  // 1) What it is + the thesis (direction + movement), woven together.
  const thesis =
    p.directionalBias === 'neutral'
      ? p.moveBias === 'wants-stability'
        ? `it profits if ${p.label} stays within a range`
        : p.moveBias === 'wants-movement'
          ? `it profits if ${p.label} makes a large move in either direction`
          : `its P&L is roughly neutral to ${p.label}'s direction`
      : `it profits as ${p.label} ${p.directionalBias === 'bullish' ? 'rises' : 'falls'}` +
        (p.moveBias === 'wants-movement' ? ', and more so on a large move' : '');
  sentences.push(`This ${noun} is a ${risk}, ${p.directionalBias} strategy — ${thesis}.`);

  // 2) Economics.
  const { net, maxProfit, maxLoss, breakevens } = p.economics;
  const entry =
    net > 0
      ? `costs ${money(net)} to open`
      : net < 0
        ? `collects ${money(-net)} up front`
        : 'opens for even';
  const be =
    breakevens.length === 0
      ? ''
      : ` Breakeven${breakevens.length > 1 ? 's' : ''} at ${breakevens.map(price).join(' and ')}.`;
  // The prose and the `rewardToRisk` number must agree: when a side is unbounded there is no
  // ratio to quote, and the report says so rather than leaving a null to be misread as "no reward".
  const riskNote = p.definedRisk
    ? p.economics.rewardToRisk === null
      ? ' The reward-to-risk ratio is undefined (an unbounded profit or a zero maximum loss), so it is reported as null.'
      : ''
    : ' This is undefined risk — the loss is unbounded, so reward-to-risk has no ratio and is reported as null.';
  sentences.push(
    `It ${entry}; max profit ${money(maxProfit)}, max loss ${money(maxLoss)}.${riskNote}${be}`,
  );

  // 3) Probability (with market).
  if (p.probability) {
    sentences.push(
      `The model puts the probability of profit at ${pct(p.probability.probabilityOfProfit)}, with an expected value of ${money(p.probability.expectedValue)}.`,
    );
  }

  // 4) Greek posture (with market).
  const posture: string[] = [];
  if (p.timeBias && p.timeBias !== 'neutral') {
    posture.push(
      p.timeBias === 'decay-helps'
        ? 'time decay works in your favor'
        : 'time decay works against you',
    );
  }
  if (p.volatilityBias && p.volatilityBias !== 'neutral') {
    posture.push(
      p.volatilityBias === 'benefits-from-rising-impliedVolatility'
        ? 'it gains from rising implied volatility'
        : 'it gains from falling implied volatility',
    );
  }
  if (posture.length) sentences.push(`On the greeks, ${posture.join(' and ')}.`);
  else if (!p.hasMarket)
    sentences.push(
      'Supply a market (spot, volatility, rate, asOf) for the probability of profit and greek posture.',
    );

  // 5) Lead risk.
  if (p.risks.length) sentences.push(p.risks[0]!);

  return sentences.join(' ');
}
