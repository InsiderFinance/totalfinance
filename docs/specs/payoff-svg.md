# Spec — Zero-dependency payoff SVG rendering (`@totalfinance/strategy`)

> Roadmap Tier 3 → "Strategy intelligence": _"Zero-dep payoff/scenario SVG rendering — `chartData()`
> already computes everything; emitting a self-contained SVG makes every UI, notebook, and agent
> artifact instantly visual."_ Status: **shipped** as `payoffSvg` in `packages/strategy/src/svg.ts`,
> covered by `packages/strategy/test/svg.test.ts`, full CI green.

## Goal

Turn any `Position` into a **self-contained** `<svg>` payoff diagram — the classic option P&L chart:
the expiration payoff curve with profit shaded green and loss shaded red, the break-even markers, the
current spot, and the max-profit/max-loss guides. No dependencies, no external refs (CSP-safe), no DOM —
just a string. So an optimizer candidate, a hand-built spread, or an agent's answer becomes a picture
you can drop into a README, a notebook, an email, or an MCP artifact.

## Why this is a composition, not a re-implementation

Everything the picture needs already exists on `Position`:

- `chartData({ prices, include })` (position.ts) — the payoff series `{ underlyingPrice, expirationPnl,
currentPnl? }` over a price grid (and the current-P&L curve when a `market` is given).
- `metrics()` — `breakevens`, `maxProfit`, `maxLoss`, `netDebit` for the annotations.

`payoffSvg` samples those, maps them to screen coordinates, and emits SVG. It is a **renderer**, not a
second payoff engine — the curve it draws is exactly `pnlAtExpiry`.

## API

```ts
interface PayoffSvgOptions {
  /** X-axis price range. Omit for a sensible auto-range around the strikes + breakevens. */
  prices?: PriceRange; // { from, to, steps }
  width?: number; // px, default 640
  height?: number; // px, default 360
  /** Draw a marker at the current spot. */
  spot?: number;
  /** Also draw the CURRENT (pre-expiry) P&L curve (dashed); needs a market (or the position's own). */
  includeCurrentPnl?: boolean;
  market?: Partial<Omit<MarkToMarketInput, 'spot'>>;
  /** Chart title (XML-escaped). */
  title?: string;
  /** Color theme. Default 'light'. */
  theme?: 'light' | 'dark';
}
function payoffSvg(position: Position, opts?: PayoffSvgOptions): string;
```

## What it draws

- **Expiration payoff curve** over the price range, with the area between the curve and the zero line
  **shaded green where P&L > 0 and red where P&L < 0** (via two fills of the same area path, each
  clipped to the corresponding half-plane — exact at the zero crossings).
- **Zero P&L line** (subtle horizontal reference).
- **Break-even markers** (from `metrics().breakevens`) — a tick + label on the x-axis.
- **Spot marker** (vertical guide + label) when `spot` is given.
- **Max profit / max loss** guides + labels (from `metrics()`), with `∞` when a side is unbounded.
- **Current-P&L curve** (dashed) when `includeCurrentPnl` and a market are available.
- **Axis labels** (price min/max, P&L min/max) and an optional **title**; a small legend when the
  current curve is drawn. All text XML-escaped.

## Semantics & honesty contract

- **Renderer only** — the curve is exactly `pnlAtExpiry`; no smoothing that would misrepresent the
  kinks. `payoffSvg(position)` and `strategy(position.legs).pnlAtExpiry` agree at every sampled price.
- **Self-contained** — one `<svg>` element with inline styles and no external URLs, fonts, or scripts;
  safe to inline anywhere (CSP-friendly), deterministic (no clock, no randomness).
- **Sensible defaults** — omit `prices` and it auto-ranges to `[0.85·min, 1.15·max]` of the strikes +
  breakevens (clamped ≥ 0) with ~120 steps, so `payoffSvg(position)` "just works".
- **Single-expiry** — payoff diagrams are single-expiration; a calendar/diagonal throws the same typed
  error `pnlAtExpiry`/`metrics` already throw.
- Typed guards: a non-`Position`; `width`/`height` below the fixed axis padding (`≥ 120 × 100`, else the
  plot/clip rects would get negative dimensions and not render); a bad `prices` range; `includeCurrentPnl` without any
  market throws a teaching error (as `chartData` does).

## Build checklist

1. **Types** — `PayoffSvgOptions`.
2. **Data** — auto-range (strikes + breakevens) or the given `prices`; `chartData` for the series;
   `metrics()` for breakevens / max P&L.
3. **Scales** — price→x, pnl→y (with headroom); the zero-line y.
4. **Render** — profit/loss shaded area (two clipped fills), curve polyline, zero line, breakeven /
   spot / max guides, axis labels, title, optional current-P&L curve + legend; XML-escape all text.
5. **Exports + API report + READMEs/llms.**
6. **Tests** — output is a well-formed self-contained `<svg>` (starts with `<svg`, ends `</svg>`, no
   `http`/`<script`); a long-call diagram has an up-sloping right side and the break-even ≈ strike +
   premium appears; profit/loss colors both present for a spread; auto-range brackets the strikes; a
   custom `prices`/`width`/`height` are honored; `spot`/`title` appear (escaped); `includeCurrentPnl`
   without a market throws; a multi-expiry position throws; deterministic (same input → identical
   string).

## Deferred (explicitly)

- **Equity-curve / drawdown SVG** for backtests, and a **scenario heatmap** (spot × vol/time) — the
  same renderer generalized; a dedicated `@totalfinance/viz` package is the home once rendering grows beyond
  the payoff diagram.
- **Greeks overlays** (delta/theta curves on a secondary axis) — `chartData` already emits them.
- **PNG/other formats** — SVG is the zero-dep primitive; rasterization is an edge concern.
