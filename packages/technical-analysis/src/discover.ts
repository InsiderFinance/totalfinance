/**
 * Targeted TA discovery (spec: `docs/specs/ta-discovery.md`, roadmap Tier 3, agent-native). The registry
 * is ~335 indicators, so `listIndicators()` is a large payload; these give the *narrow* paths an agent
 * actually needs — one indicator's full card (`describeIndicator`) and a name/alias search with
 * pagination (`searchIndicators`) — so discovery costs a fraction of the tokens.
 */

import { ErrorCode, InputError, ensureKnownKeys } from '@totalfinance/core';
import { type IndicatorAliasRow, aliasesOf, resolveIndicator } from './aliases.js';
import { bestSimilarity, type NormalizedName, normalizeName } from './fuzzy.js';
import type { IndicatorConventions } from './framework.js';
import type { IndicatorOutputMetadata } from './output-meta.js';
import {
  type IndicatorCategory,
  type IndicatorInputs,
  listIndicators,
  type RegisteredIndicator,
} from './registry.js';
import { indicatorWarmup } from './warmup.js';

/** One indicator's full metadata card. */
export interface IndicatorDescription {
  /** Canonical registered name. */
  name: string;
  category: IndicatorCategory;
  /** Input kind expected by the indicator. */
  inputs: IndicatorInputs;
  /** All parameter names (including defaulted ones the caller may omit). */
  parameters: string[];
  /** Declared default per optional parameter; a derived default is a resolver function. */
  defaults: Record<string, unknown>;
  /** Parameters with no default — the caller must supply these. */
  required: string[];
  /** Leading bars before the first real value, or `null` if it never emitted within the probe. */
  warmup: number | null;
  /** The output metadata — recursive value schema + optional visualization (Wave 6 §4). */
  output: IndicatorOutputMetadata;
  /**
   * The choices this indicator made that its parameters do not reveal (Wilder vs EMA smoothing, what
   * a flat window resolves to, how the first value is seeded) — present only where such a choice
   * exists. This is the field that answers "why does your RSI disagree with my other library?"
   * without leaving the tool schema.
   */
  conventions?: IndicatorConventions;
  /** Cross-library aliases (TA-Lib / pandas-ta / TradingView), when known. */
  aliases?: Omit<IndicatorAliasRow, 'totalfinance'>;
}

/** Inspectable evidence for why a queried row matched — its match class, score, and the name that hit. */
export interface IndicatorMatchEvidence {
  kind: 'canonical-exact' | 'alias-exact' | 'canonical-substring' | 'alias-substring' | 'fuzzy';
  /** `1` for an exact match; the substring length ratio; or the normalized fuzzy similarity in `[0, 1]`. */
  score: number;
  /** The canonical name or alias (raw) that produced the match. */
  matchedOn: { source: 'canonical' | 'alias'; value: string };
}

/** The bulk-list row shape (no warmup — that is a per-`describe` measurement). */
export interface IndicatorRow {
  name: string;
  category: IndicatorCategory;
  inputs: IndicatorInputs;
  parameters: string[];
  defaults: Record<string, unknown>;
  required: string[];
  /** The output metadata — recursive value schema + optional visualization (Wave 6 §4). */
  output: IndicatorOutputMetadata;
  /** Present only for a queried search — the deterministic match evidence for ranking/inspection. */
  match?: IndicatorMatchEvidence;
}

/** How a `query` is matched. `auto` (default) uses substring first, deterministic fuzzy only as a fallback. */
export type SearchMatchMode = 'substring' | 'fuzzy' | 'auto';

/** Options for {@link searchIndicators}. */
export interface SearchIndicatorsOptions {
  /** Case-insensitive substring/fuzzy match of the canonical name OR any alias. */
  query?: string;
  category?: IndicatorCategory;
  /** Non-negative safe-integer page size; omit for all matches. */
  limit?: number;
  /** Non-negative safe-integer page offset; default 0. */
  offset?: number;
  /** Match mode (default `'auto'`). Only meaningful with a `query`. */
  match?: SearchMatchMode;
  /** Minimum fuzzy similarity in `[0, 1]` (default `0.7`). Only used for fuzzy matching, needs a `query`. */
  minScore?: number;
}

/** {@link SearchIndicatorsOptions} keys (Law 12 — an unknown option must throw, never no-op). */
const SEARCH_INDICATORS_OPTIONS_KEYS = [
  'query',
  'category',
  'limit',
  'offset',
  'match',
  'minScore',
] as const;

/** Result of {@link searchIndicators}. */
export interface SearchIndicatorsResult {
  /** Matches before pagination. */
  total: number;
  offset: number;
  /** The applied page size (`null` = unbounded). */
  limit: number | null;
  indicators: IndicatorRow[];
}

function requiredParams(entry: RegisteredIndicator): string[] {
  return entry.parameters.filter((p) => !(entry.defaults && p in entry.defaults));
}

function toRow(entry: RegisteredIndicator): IndicatorRow {
  return {
    name: entry.name,
    category: entry.category,
    inputs: entry.inputs,
    parameters: entry.parameters,
    defaults: entry.defaults ?? {},
    required: requiredParams(entry),
    output: entry.output,
  };
}

/**
 * One indicator's full metadata card (alias-aware): category, input kind, parameters, defaults, which are
 * required, its warmup, and its cross-library aliases. Throws on an unknown name. See the spec.
 */
export function describeIndicator(name: string, probeLength = 512): IndicatorDescription {
  const functionName = 'describeIndicator';
  if (typeof name !== 'string' || name.length === 0) {
    throw new InputError(`${functionName}: name must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { name },
    });
  }
  const entry = resolveIndicator(name);
  if (entry === undefined) {
    throw new InputError(`${functionName}: unknown indicator "${name}".`, {
      code: ErrorCode.InputInvalidEnum,
      context: { name },
    });
  }
  const { totalfinance: _canonical, ...aliases } = aliasesOf(entry.name) ?? {
    totalfinance: entry.name,
  };
  const hasAliases = Object.keys(aliases).length > 0;
  return {
    name: entry.name,
    category: entry.category,
    inputs: entry.inputs,
    parameters: entry.parameters,
    defaults: entry.defaults ?? {},
    required: requiredParams(entry),
    warmup: indicatorWarmup(entry.name, probeLength).warmup,
    output: entry.output,
    ...(entry.conventions ? { conventions: entry.conventions } : {}),
    ...(hasAliases ? { aliases } : {}),
  };
}

/** Flatten an alias row's cross-library names to a searchable string list. */
function aliasStrings(row: IndicatorAliasRow | undefined): string[] {
  if (row === undefined) return [];
  const out: string[] = [];
  const add = (v: string | string[] | undefined): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v);
  };
  add(row.talib);
  add(row.pandas);
  add(row.tradingview);
  return out;
}

/** Match-class ordering: exact beats substring beats fuzzy; canonical beats alias within a tier. */
const CLASS_RANK: Record<IndicatorMatchEvidence['kind'], number> = {
  'canonical-exact': 0,
  'alias-exact': 1,
  'canonical-substring': 2,
  'alias-substring': 3,
  fuzzy: 4,
};

/**
 * The best structural (exact/substring) and best fuzzy evidence for one indicator against a normalized
 * query. Structural evidence is deterministic and query-length-independent; fuzzy is only considered when
 * the query has ≥ 3 normalized characters and its similarity clears `minScore`.
 */
function computeMatch(
  queryFull: string,
  canonicalRaw: string,
  candidates: ReadonlyArray<{ source: 'canonical' | 'alias'; raw: string; norm: NormalizedName }>,
  minScore: number,
): { structural?: IndicatorMatchEvidence; fuzzy?: IndicatorMatchEvidence } {
  let structural: IndicatorMatchEvidence | undefined;
  let fuzzy: IndicatorMatchEvidence | undefined;
  const betterStructural = (
    a: IndicatorMatchEvidence,
    b: IndicatorMatchEvidence | undefined,
  ): boolean =>
    b === undefined ||
    CLASS_RANK[a.kind] < CLASS_RANK[b.kind] ||
    (CLASS_RANK[a.kind] === CLASS_RANK[b.kind] && a.score > b.score);

  for (const c of candidates) {
    if (queryFull === c.norm.full) {
      const ev: IndicatorMatchEvidence = {
        kind: c.source === 'canonical' ? 'canonical-exact' : 'alias-exact',
        score: 1,
        matchedOn: { source: c.source, value: c.raw },
      };
      if (betterStructural(ev, structural)) structural = ev;
      continue; // an exact match is the best this candidate can offer
    }
    if (queryFull.length > 0 && c.norm.full.includes(queryFull)) {
      const ev: IndicatorMatchEvidence = {
        kind: c.source === 'canonical' ? 'canonical-substring' : 'alias-substring',
        score: queryFull.length / c.norm.full.length,
        matchedOn: { source: c.source, value: c.raw },
      };
      if (betterStructural(ev, structural)) structural = ev;
    }
    if (queryFull.length >= 3) {
      const { score } = bestSimilarity(queryFull, c.norm);
      if (score >= minScore && (fuzzy === undefined || score > fuzzy.score)) {
        fuzzy = { kind: 'fuzzy', score, matchedOn: { source: c.source, value: c.raw } };
      }
    }
  }
  const result: { structural?: IndicatorMatchEvidence; fuzzy?: IndicatorMatchEvidence } = {};
  if (structural) result.structural = structural;
  if (fuzzy) result.fuzzy = fuzzy;
  void canonicalRaw;
  return result;
}

/**
 * Filter the registry by a name/alias search and category, then paginate — the token-lean alternative to
 * pulling all ~335 indicators. `query` matches the canonical name or any TA-Lib/pandas/TradingView alias.
 * `match: 'auto'` (default) uses exact/substring hits when any exist and falls back to a deterministic
 * Damerau–Levenshtein fuzzy match only when they do not; queried rows carry inspectable `match` evidence.
 * See `docs/specs/wave6-quant-moats.md` §4.
 */
export function searchIndicators(options: SearchIndicatorsOptions = {}): SearchIndicatorsResult {
  const functionName = 'searchIndicators';
  if (options === null || typeof options !== 'object') {
    throw new InputError(`${functionName}: options must be an object.`, {
      code: ErrorCode.InputWrongType,
      context: { options },
    });
  }
  ensureKnownKeys(functionName, 'options', options, SEARCH_INDICATORS_OPTIONS_KEYS);
  if (options.category !== undefined && typeof options.category !== 'string') {
    throw new InputError(
      `${functionName}: category must be a string when provided — omit the field to search all categories. Received ${options.category === null ? 'null' : typeof options.category}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'category' } },
    );
  }
  const { query, category, limit, offset = 0, minScore } = options;
  const match = options.match ?? 'auto';
  if (query !== undefined && typeof query !== 'string') {
    throw new InputError(`${functionName}: query must be a string.`, {
      code: ErrorCode.InputWrongType,
      context: { query },
    });
  }
  if (match !== 'auto' && match !== 'substring' && match !== 'fuzzy') {
    throw new InputError(
      `${functionName}: match must be 'auto', 'substring', or 'fuzzy'; got "${String(match)}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { match },
      },
    );
  }
  if (
    minScore !== undefined &&
    (typeof minScore !== 'number' || !(minScore >= 0 && minScore <= 1))
  ) {
    throw new InputError(
      `${functionName}: minScore must be a number in [0, 1]; got ${String(minScore)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { minScore },
      },
    );
  }
  // Safe integers (2026-08-23 review, P0): limit/offset only slice the fixed registry — no loop runs
  // off them — but past 2^53 they are no longer exact counts.
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new InputError(
      `${functionName}: limit must be a non-negative safe integer; omit it to return every match.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { limit },
      },
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new InputError(`${functionName}: offset must be a non-negative safe integer.`, {
      code: ErrorCode.InputOutOfRange,
      context: { offset },
    });
  }
  const hasQuery = query !== undefined && query.length > 0;
  // A minScore / non-default match mode is a no-op without a query — reject it rather than accept silently.
  if (!hasQuery) {
    if (minScore !== undefined) {
      throw new InputError(
        `${functionName}: minScore requires a query; it is only used for fuzzy matching.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { minScore },
        },
      );
    }
    if (options.match !== undefined && options.match !== 'auto') {
      throw new InputError(`${functionName}: match '${options.match}' requires a query.`, {
        code: ErrorCode.InputInvalidEnum,
        context: { match: options.match },
      });
    }
  }

  const entries = listIndicators(category);
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

  if (!hasQuery) {
    // Unfiltered: name-sorted, no match evidence (keeps pagination lean).
    const sorted = [...entries].sort(byName);
    const total = sorted.length;
    const page = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return { total, offset, limit: limit ?? null, indicators: page.map(toRow) };
  }

  const queryFull = normalizeName(query).full;
  const threshold = minScore ?? 0.7;
  const scored = entries.map((entry) => {
    const candidates: Array<{ source: 'canonical' | 'alias'; raw: string; norm: NormalizedName }> =
      [
        { source: 'canonical', raw: entry.name, norm: normalizeName(entry.name) },
        ...aliasStrings(aliasesOf(entry.name)).map((a) => ({
          source: 'alias' as const,
          raw: a,
          norm: normalizeName(a),
        })),
      ];
    return { entry, ...computeMatch(queryFull, entry.name, candidates, threshold) };
  });

  const structuralHits = scored.filter((s) => s.structural);
  let matched: Array<{ entry: RegisteredIndicator; evidence: IndicatorMatchEvidence }>;
  if (match === 'substring') {
    matched = structuralHits.map((s) => ({ entry: s.entry, evidence: s.structural! }));
  } else if (match === 'fuzzy') {
    matched = scored
      .filter((s) => s.structural ?? s.fuzzy)
      .map((s) => ({ entry: s.entry, evidence: s.structural ?? s.fuzzy! }));
  } else {
    // auto: prefer structural; fall back to fuzzy ONLY when no structural hit exists anywhere.
    matched =
      structuralHits.length > 0
        ? structuralHits.map((s) => ({ entry: s.entry, evidence: s.structural! }))
        : scored.filter((s) => s.fuzzy).map((s) => ({ entry: s.entry, evidence: s.fuzzy! }));
  }

  // Rank: match class ascending, score descending, a canonical-name match before an alias match at an
  // equal class+score (the more "intended" hit), then canonical name ascending — fully deterministic.
  matched.sort((a, b) => {
    const cr = CLASS_RANK[a.evidence.kind] - CLASS_RANK[b.evidence.kind];
    if (cr !== 0) return cr;
    if (a.evidence.score !== b.evidence.score) return b.evidence.score - a.evidence.score;
    const sa = a.evidence.matchedOn.source === 'canonical' ? 0 : 1;
    const sb = b.evidence.matchedOn.source === 'canonical' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return byName(a.entry, b.entry);
  });

  const total = matched.length;
  const page = limit === undefined ? matched.slice(offset) : matched.slice(offset, offset + limit);
  return {
    total,
    offset,
    limit: limit ?? null,
    indicators: page.map((m) => ({ ...toRow(m.entry), match: m.evidence })),
  };
}
