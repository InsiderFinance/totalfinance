# Spec — Leaner TA discovery (`@totalfinance/technical-analysis` + `@totalfinance/mcp`)

> Roadmap Tier 3 → Agent-native → _"Leaner TA discovery (`technical_analysis.describe`, search/filter, pagination)."_
> Status: **shipped** as `indicatorWarmup` / `describeIndicator` / `searchIndicators` in `@totalfinance/technical-analysis`
> and the `totalfinance.technical_analysis.describe` MCP tool + a searchable/paginated `totalfinance.technical_analysis.list`, covered by
> `packages/technical-analysis/test/discover.test.ts` and `packages/mcp/test/server.test.ts`, full CI green.

## Goal

The TA registry is ~335 indicators. Today an agent's only discovery path is `totalfinance.technical_analysis.list`, which
returns **every** indicator (~27 KB) on each call, and to learn one indicator's details it must scan
that whole payload. That is a lot of tokens to answer "what params does `rsi` take, and how much warmup
does it need?" This adds the **targeted** path:

- **`technical_analysis.describe(name)`** — one indicator's full card: category, input kind, params, defaults, which are
  required, its **warmup** (leading bars before the first real value), and its **cross-library aliases**
  (TA-Lib / pandas-ta / TradingView). Alias-aware, so `describe('RSI')` resolves the canonical name.
- **`technical_analysis.list` search + pagination** — narrow the bulk list by a **name/alias search** and page it with
  `limit`/`offset`, with the full match `total` disclosed. Backward-compatible: with no `limit` it still
  returns everything.

The `@totalfinance/technical-analysis` package gains the reusable primitives (`describeIndicator`, `searchIndicators`,
`indicatorWarmup`); the MCP tools are thin wrappers, so the capability isn't MCP-only.

## Why warmup belongs in describe, not list

`technical_analysis.list` already discloses each indicator's `defaults` and `required` params (the discovery disclosure
law). **Warmup** is the one field it omits — because measuring it means actually running the indicator
over a probe series (`indicator.explain(...).diagnostics.warmup`), which for all 335 at once is wasteful
when the agent wants one. So warmup is computed **per indicator, on demand** in `describe`.

## `@totalfinance/technical-analysis` primitives

```ts
/** The warmup of a single indicator (alias-aware name), measured on a probe series. */
function indicatorWarmup(name: string, probeLength?: number): WarmupMetadata; // { name, category, inputs, params, warmup }

interface IndicatorDescription {
  name: string; // canonical name
  category: IndicatorCategory;
  inputs: 'series' | 'bars' | 'pair';
  parameters: string[];
  defaults: Record<string, unknown>; // per-optional-param default; a derived default is a resolver fn
  required: string[]; // params with no default
  warmup: number | null; // leading bars before the first value (null = never emitted on the probe)
  aliases?: { talib?: string | string[]; pandas?: string | string[]; tradingview?: string };
}
/** One indicator's full metadata card (alias-aware). Throws a typed error on an unknown name. */
function describeIndicator(name: string, probeLength?: number): IndicatorDescription;

interface SearchIndicatorsOptions {
  query?: string; // case-insensitive substring of the name OR any alias
  category?: IndicatorCategory;
  limit?: number; // page size; default: all matches
  offset?: number; // default 0
}
interface IndicatorRow {
  // the ta.list row shape (no warmup — that's per-describe)
  name: string;
  category: IndicatorCategory;
  inputs: 'series' | 'bars' | 'pair';
  parameters: string[];
  defaults: Record<string, unknown>;
  required: string[];
}
interface SearchIndicatorsResult {
  total: number; // matches before pagination
  offset: number;
  limit: number | null; // the applied page size (null = unbounded)
  indicators: IndicatorRow[];
}
/** Filter the registry by name/alias search + category, then paginate. */
function searchIndicators(opts?: SearchIndicatorsOptions): SearchIndicatorsResult;
```

- **Alias-aware resolution** — `describeIndicator`/`indicatorWarmup` resolve the input through
  `resolveIndicator` (so a TA-Lib/pandas name or a registered alias maps to the canonical indicator).
- **Search over names + aliases** — `searchIndicators({ query })` matches the query as a case-insensitive
  substring of the canonical name **or** any TA-Lib/pandas/TradingView alias, so `query: 'stoch'` finds
  the stochastic family however it's spelled.
- **Pagination** — `limit`/`offset` slice the (sorted, filtered) matches; `total` is the full count so a
  caller knows whether to page. `limit` omitted ⇒ all matches (unbounded).

## MCP tools

- **`totalfinance.technical_analysis.describe`** (new): input `{ name, probeLength? }`, returns the `IndicatorDescription`
  with `defaults` rendered JSON-safe (a derived resolver → `'(derived)'`, as `technical_analysis.list` already does). A
  one-line `summary` names the indicator, its input kind, and its warmup.
- **`totalfinance.technical_analysis.list`** (extended): input gains `search`, `limit`, `offset` alongside `category`. Output
  gains `total` (full match count) and `offset`; `count` stays the number of rows returned (so
  `count === indicators.length`, preserving the existing contract). With no `limit`, the full list is
  returned exactly as before.

## Honesty / envelope contract

- **Unknown name fails loudly** — `describe`/`indicatorWarmup` on an unregistered name (after alias
  resolution) throws a typed `InputError` naming the miss, never an empty or guessed card.
- **`warmup: null` is explicit** — an indicator that never emits within the probe window reports `null`
  (not `0`), disclosing "warmup exceeds the probe" rather than implying instant readiness.
- **Backward-compatible list** — the default `technical_analysis.list` payload is unchanged (all indicators, `count ===
indicators.length`); the lean paths are additive.
- **Derived defaults disclosed** — a default computed from another param surfaces as `'(derived)'` in the
  MCP layer (JSON can't carry the resolver), so an agent still sees that the param is optional.
- Typed guards (`name` a non-empty string; valid `probeLength`/`limit`/`offset`/`category`).

## Build checklist

1. **ta: warmup** — factor the per-indicator warmup measurement out of `indicatorWarmups`; add
   `indicatorWarmup(name, probeLength?)` (alias-aware).
2. **ta: discover** — `describeIndicator` (meta + defaults/required + warmup + aliases) and
   `searchIndicators` (name/alias search + category + pagination); exports.
3. **mcp: describe** — the `totalfinance.technical_analysis.describe` tool (JSON-safe defaults, summary).
4. **mcp: list** — extend `technical_analysis.list` with `search`/`limit`/`offset` and `total`/`offset` output, wrapping
   `searchIndicators`; keep the default full-list contract.
5. **Exports + API report + READMEs/llms** (+ any deep-sweep fixtures).
6. **Tests** — `describeIndicator` returns params/defaults/required/warmup/aliases and resolves an alias;
   an unknown name throws; `indicatorWarmup` matches the bulk `indicatorWarmups` value for a sample
   indicator; `searchIndicators` filters by name and by alias, respects category, and paginates with a
   correct `total`; the MCP `technical_analysis.describe` tool and the extended `technical_analysis.list` (search/pagination + preserved
   default) work over the tool interface; guards.

## Wave 6 §4 — shipped

- **Fuzzy ranking** — `searchIndicators` gains `match: 'substring' | 'fuzzy' | 'auto'` (default `auto`)
  and `minScore`. `auto` keeps exact/substring hits when any exist and falls back to a deterministic
  Damerau–Levenshtein fuzzy match only when they do not; queried rows carry inspectable `match` evidence
  (`kind` / `score` / `matchedOn`). Ranking: class → score → canonical-over-alias → name.
- **Output-shape metadata** — every registered indicator declares `output: IndicatorOutputMetadata` (a
  recursive value schema — scalar / record / vector — plus an optional visualization). `register` and
  `defineIndicator` require and validate it; `describeIndicator`, `searchIndicators`, and
  `registryMarkdown` expose the same source-controlled object; runtime probes verify all 335 shapes in
  `test/output-meta.test.ts`. See [`wave6-quant-moats.md`](./wave6-quant-moats.md#wave6-ta-metadata).

## Deferred (explicitly)

- **A `technical_analysis.describe` batch** — several names at once (v1 is one name per call).
- **Semantic/embedding search** and **model-generated indicator explanations** — beyond deterministic
  fuzzy matching.
- **Automatic metadata inference as the source of truth** — runtime inference verifies the curated
  metadata; it never silently redefines it.
