/** Synthetic stand-in for an Alpaca-style bars API. No real vendor data. */
export interface VendorBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface VendorResponse {
  bars: VendorBar[];
  symbol: string;
  next_page_token: string | null;
}

export function makeVendorFetch(
  count: number,
  opts: { status?: number; failNetwork?: boolean; ignoreLimit?: boolean } = {},
): typeof fetch {
  const all: VendorBar[] = [];
  const start = Date.UTC(2026, 0, 5);
  for (let i = 0; i < count; i++) {
    const c = 100 + i;
    // vendor stamps daily bars at 04:00Z (midnight New York), the way Alpaca does
    all.push({
      t: new Date(start + i * 86400000 + 4 * 3600000).toISOString().replace('.000', ''),
      o: c - 0.5,
      h: c + 1,
      l: c - 1,
      c,
      v: 1000 + i,
    });
  }
  return (async (input: URL | string | Request) => {
    if (opts.failNetwork) throw new TypeError('fetch failed');
    if (opts.status)
      return new Response(JSON.stringify({ message: 'too many requests' }), {
        status: opts.status,
      });
    const url = new URL(String(input));
    const startDate = url.searchParams.get('start')!;
    const endDate = url.searchParams.get('end')!;
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('page_token') ?? 0);
    const matching = all.filter(
      (b) => b.t.slice(0, 10) >= startDate && b.t.slice(0, 10) <= endDate,
    );
    const size = opts.ignoreLimit ? limit + 1 : limit;
    const bars = matching.slice(offset, offset + size);
    const next = offset + bars.length < matching.length ? String(offset + bars.length) : null;
    const body: VendorResponse = { bars, symbol: 'SPY', next_page_token: next };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
