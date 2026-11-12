/**
 * The repository's GitHub star count, read once at build time for the "Star on GitHub" buttons.
 * A build never depends on GitHub: offline, rate-limited or slow, the buttons simply show no count.
 */

/** Below this, a count reads as weak social proof, so the buttons show only "Star on GitHub". */
export const STAR_COUNT_MIN = 100;

export interface GitHubStats {
  stars: number | null;
  /** ISO time the count was read, or null when it was not. */
  fetchedAt: string | null;
}

export async function fetchGitHubStats(
  repository: string,
  {
    fetch = globalThis.fetch,
    timeoutMs = 4000,
  }: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<GitHubStats> {
  const path = new URL(repository).pathname.replace(/^\/|\/$/g, '');
  try {
    const response = await fetch(`https://api.github.com/repos/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'totalfinance-docs-build' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { stars: null, fetchedAt: null };
    const stars = ((await response.json()) as { stargazers_count?: unknown }).stargazers_count;
    return typeof stars === 'number' && Number.isInteger(stars) && stars >= 0
      ? { stars, fetchedAt: new Date().toISOString() }
      : { stars: null, fetchedAt: null };
  } catch {
    return { stars: null, fetchedAt: null };
  }
}

/** "1.2k"-style count for a button, or null when there is none worth showing. */
export function starCountLabel(stars: number | null, minimum = STAR_COUNT_MIN): string | null {
  if (stars === null || stars < minimum) return null;
  if (stars < 1000) return String(stars);
  const thousands = stars / 1000;
  return `${thousands < 10 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`;
}
