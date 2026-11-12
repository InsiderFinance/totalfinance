import { describe, expect, it } from 'vitest';
import { fetchGitHubStats, STAR_COUNT_MIN, starCountLabel } from '../src/github';

describe('GitHub star count', () => {
  it('shows no count until it is worth showing, then a compact one', () => {
    expect(starCountLabel(null)).toBeNull();
    expect(starCountLabel(2)).toBeNull();
    expect(starCountLabel(STAR_COUNT_MIN - 1)).toBeNull();
    expect(starCountLabel(STAR_COUNT_MIN)).toBe(String(STAR_COUNT_MIN));
    expect(starCountLabel(999)).toBe('999');
    expect(starCountLabel(1234)).toBe('1.2k');
    expect(starCountLabel(12_400)).toBe('12k');
  });

  it('reads the count, and never fails a build when GitHub does', async () => {
    const ok =
      (body: unknown, status = 200) =>
      async () =>
        new Response(JSON.stringify(body), { status });
    const repo = 'https://github.com/InsiderFinance/totalfinance';
    expect((await fetchGitHubStats(repo, { fetch: ok({ stargazers_count: 42 }) })).stars).toBe(42);
    expect(await fetchGitHubStats(repo, { fetch: ok({}, 403) })).toEqual({
      stars: null,
      fetchedAt: null,
    });
    expect((await fetchGitHubStats(repo, { fetch: ok({ stargazers_count: 'many' }) })).stars).toBe(
      null,
    );
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    expect((await fetchGitHubStats(repo, { fetch: offline })).stars).toBeNull();
  });
});
