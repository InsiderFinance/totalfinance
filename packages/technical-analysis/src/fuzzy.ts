/**
 * Deterministic fuzzy name matching for TA discovery (spec: `docs/specs/wave6-quant-moats.md` §4).
 * Pure string math — no I/O, no clock, no randomness — so `searchIndicators`'s ranking is identical on
 * every runtime and stable under registry insertion order. Normalizes case / separators / camel-case,
 * then scores with a normalized Optimal-String-Alignment (restricted Damerau–Levenshtein) distance so a
 * one- or two-character typo still finds its indicator.
 */

/** A name split into its lowercased separator-free form plus its camel/word tokens. */
export interface NormalizedName {
  /** Lowercased, separators removed — e.g. `bollingerBands` → `bollingerbands`. */
  full: string;
  /** Lowercased word tokens — e.g. `bollingerBands` → `['bollinger', 'bands']`. */
  tokens: string[];
}

/** Normalize a name: lowercase, split camel-case + separators into tokens, and a separator-free `full`. */
export function normalizeName(name: string): NormalizedName {
  // Insert a space at camel-case boundaries (aA, a9, 9a), then split on any non-alphanumeric run.
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  const tokens = spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  return { full: tokens.join(''), tokens };
}

/**
 * Optimal String Alignment distance (restricted Damerau–Levenshtein): edit distance allowing insert,
 * delete, substitute, and the transposition of two ADJACENT characters. Deterministic and symmetric.
 */
export function osaDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  // Three rolling rows: d2 = i-2, d1 = i-1, cur = i.
  let d2 = new Array<number>(m + 1).fill(0);
  let d1 = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) d1[j] = j;
  let cur = new Array<number>(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        d1[j]! + 1, // deletion
        cur[j - 1]! + 1, // insertion
        d1[j - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d2[j - 2]! + 1); // adjacent transposition
      }
      cur[j] = best;
    }
    d2 = d1;
    d1 = cur;
    cur = new Array<number>(m + 1);
  }
  return d1[m]!;
}

/** Normalized similarity in `[0, 1]`: `1 − distance / max(len)`; 1 when both are empty. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - osaDistance(a, b) / longest;
}

/**
 * The best fuzzy similarity of a normalized query against a candidate name: the max over the candidate's
 * separator-free `full` form and each of its tokens, so `bolinger` matches the `bollinger` token of
 * `bollingerBands`. Returns the score and the sub-string that produced it.
 */
export function bestSimilarity(
  queryFull: string,
  candidate: NormalizedName,
): { score: number; matchedToken: string } {
  let score = similarity(queryFull, candidate.full);
  let matchedToken = candidate.full;
  for (const token of candidate.tokens) {
    const s = similarity(queryFull, token);
    if (s > score) {
      score = s;
      matchedToken = token;
    }
  }
  return { score, matchedToken };
}
