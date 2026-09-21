/** Shared happy-path input builders for the deep-sweep fixtures. Thunks — always fresh objects. */

// ── shared inputs ────────────────────────────────────────────────────────────────────────────────

export const CLOSES = (): number[] =>
  Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 6 + i * 0.08 + (i % 5) * 0.3);

export const BARS = (): Array<{
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> => {
  const closes = CLOSES();
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]!;
    return {
      open,
      high: Math.max(open, c) + 1 + (i % 3) * 0.4,
      low: Math.min(open, c) - 1 - (i % 4) * 0.3,
      close: c,
      volume: 1000 + ((i * 37) % 500),
    };
  });
};

export const RETURNS = (): number[] =>
  Array.from({ length: 120 }, (_, i) => 0.0004 + 0.01 * Math.sin(i / 5) - (i % 7) * 0.001);

export const WEIGHTS_PATH = (): number[][] => [
  [0.5, 0.5],
  [0.6, 0.4],
  [0.55, 0.45],
];

export const COV2 = (): number[][] => [
  [0.04, 0.006],
  [0.006, 0.09],
];

/**
 * An `OptionMarket` (MarketInputs family) — carries the canonical `riskFreeRate`.
 *
 * NO `expiry`: `OptionMarket` does not declare one. Expiry belongs to the CONTRACT
 * (`OptionContract.expiry`, required) — which is why `priceMany` prices MANY contracts, each with
 * its own expiry, against ONE market. The key used to sit here and was inert: every options engine
 * resolves time-to-expiry from `contract.expiry`, so it decorated the fixture without moving a
 * single result. `PremiumMarket` below is the contract that genuinely owns an optional `expiry`.
 */
export const MARKET = (): Record<string, unknown> => ({
  spot: 105,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T00:00:00Z',
});

/**
 * A `PremiumMarket` (strategy). It still spells the discount rate `rate`; that contract migrates in
 * 3B.N6, so the two fixtures are deliberately separate rather than one shape serving both.
 */
export const PREMIUM_MARKET = (): Record<string, unknown> => ({
  spot: 105,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T00:00:00Z',
  expiry: '2026-06-19',
});

export type FixtureThunk = () => unknown[];

/**
 * ONE flat implied-volatility surface, shared by every fixture that wants one.
 *
 * A single object rather than a factory, deliberately. `dupireLocalVolatility` and
 * `localVolatility.fromImplied` are the same callable reached two ways — the fixture comment has
 * said "identity twin" all along — and each file used to mint its OWN `() => 0.2`. Two closures with
 * identical behaviour cannot be PROVEN equal (source text describes shape, not behaviour), so the
 * fixture-conflict rule correctly refused to merge them. Sharing the object makes the twinning a
 * fact the harness can check rather than a claim in a comment.
 *
 * Safe to share: a surface is pure, and probes mutate the arguments they are handed, never a
 * function passed inside one.
 */
export const FLAT_IMPLIED_SURFACE: (level: number, timeToExpiryYears: number) => number = () => 0.2;
