/**
 * Zero-dependency payoff SVG rendering (spec §12.5, roadmap Tier 3). Turn any {@link Position} into a
 * self-contained `<svg>` payoff diagram — the expiration P&L curve with profit shaded green / loss red,
 * break-even markers, the spot, and max-profit/max-loss guides. No dependencies, no external refs
 * (CSP-safe), no DOM — just a string, so a strategy becomes a picture in a README, notebook, email, or
 * MCP artifact.
 *
 * A renderer, not a second payoff engine: the curve is exactly `chartData`/`pnlAtExpiry`, and the
 * annotations are exactly `metrics()`. See `docs/specs/payoff-svg.md`.
 */

import {
  ErrorCode,
  InputError,
  ensureEnum,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentObject,
  requireFiniteFields,
  resolveValuationAsOf,
} from '@totalfinance/core';
import { autoPriceRange } from './auto-range.js';
import type { Position } from './position.js';
import type { MarkToMarketInput, PriceRange } from './types.js';
import { ensureOptionalMarketExpiry } from './validate.js';

/** Options for {@link payoffSvg}. */
export interface PayoffSvgOptions {
  /** X-axis price range. Omit for an auto-range around the strikes + breakevens. */
  prices?: PriceRange;
  /** Width in px (default 640). */
  width?: number;
  /** Height in px (default 360). */
  height?: number;
  /** Draw a marker at the current spot. */
  spot?: number;
  /** Also draw the CURRENT (pre-expiry) P&L curve (dashed); needs a market (or the position's own). */
  includeCurrentPnl?: boolean;
  market?: Partial<Omit<MarkToMarketInput, 'spot'>>;
  /** Chart title (XML-escaped). */
  title?: string;
  /** Color theme (default 'light'). */
  theme?: 'light' | 'dark';
}

const PAYOFF_SVG_OPTION_KEYS = [
  'prices',
  'width',
  'height',
  'spot',
  'includeCurrentPnl',
  'market',
  'title',
  'theme',
] as const;
const PRICE_RANGE_KEYS = ['from', 'to', 'steps'] as const;
const MARKET_KEYS = [
  'asOf',
  'expiry',
  'volatility',
  'riskFreeRate',
  'dividendYield',
  'volatilityShock',
] as const;
const MARKET_NUMERIC_KEYS = [
  'volatility',
  'riskFreeRate',
  'dividendYield',
  'volatilityShock',
] as const;

interface Theme {
  bg: string;
  text: string;
  grid: string;
  curve: string;
  current: string;
  profit: string;
  loss: string;
  zero: string;
  spot: string;
}

const THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    bg: '#ffffff',
    text: '#334155',
    grid: '#e2e8f0',
    curve: '#2563eb',
    current: '#7c3aed',
    profit: '#16a34a',
    loss: '#dc2626',
    zero: '#94a3b8',
    spot: '#0f172a',
  },
  dark: {
    bg: '#0f172a',
    text: '#cbd5e1',
    grid: '#1e293b',
    curve: '#60a5fa',
    current: '#c4b5fd',
    profit: '#22c55e',
    loss: '#f87171',
    zero: '#475569',
    spot: '#e2e8f0',
  },
};

/** XML-escape text content / attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** XML 1.0 cannot represent control characters or lone surrogate code units, escaped or not. */
function requireXmlText(value: string, functionName: string, field: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    const isForbiddenControl =
      unit <= 0x08 || unit === 0x0b || unit === 0x0c || (unit >= 0x0e && unit <= 0x1f);
    const isForbiddenNoncharacter = unit === 0xfffe || unit === 0xffff;
    const isHighSurrogate = unit >= 0xd800 && unit <= 0xdbff;
    const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
    }
    if (!isForbiddenControl && !isForbiddenNoncharacter && !isHighSurrogate && !isLowSurrogate) {
      continue;
    }
    throw new InputError(
      `${functionName}: ${field} contains a character XML 1.0 cannot represent (control characters and lone UTF-16 surrogates are not allowed).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field },
      },
    );
  }
}

/** Compact number formatting: integers plain, otherwise up to 2 decimals (trailing zeros trimmed). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(2)).toString();
}

/** A stable, content-derived id suffix so clipPath ids never collide across inlined SVGs. */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'totalfinance' + (h >>> 0).toString(36);
}

/** A strategy Position built by `strategy(...)` / a named builder — not a raw object. */
function requirePosition(position: unknown): asserts position is Position {
  const p = position as { legs?: unknown; metrics?: unknown; chartData?: unknown } | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    !Array.isArray(p.legs) ||
    typeof p.metrics !== 'function' ||
    typeof p.chartData !== 'function'
  ) {
    throw new InputError(
      'payoffSvg: position must be a strategy Position (from strategy(...) or a named builder).',
      { code: ErrorCode.InputWrongType },
    );
  }
}

function validateOptions(options: PayoffSvgOptions): void {
  const functionName = 'payoffSvg';
  ensureKnownKeys(functionName, 'options', options, PAYOFF_SVG_OPTION_KEYS);

  for (const field of ['width', 'height', 'spot'] as const) {
    ensureFiniteWhenPresent(options[field], field, functionName);
  }
  if (options.includeCurrentPnl !== undefined && typeof options.includeCurrentPnl !== 'boolean') {
    throw new InputError(
      `${functionName}: includeCurrentPnl must be a boolean when provided. Received ${options.includeCurrentPnl === null ? 'null' : typeof options.includeCurrentPnl}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'includeCurrentPnl' },
      },
    );
  }
  if (options.title !== undefined && typeof options.title !== 'string') {
    throw new InputError(
      `${functionName}: title must be a string when provided. Received ${options.title === null ? 'null' : typeof options.title}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'title' },
      },
    );
  }
  if (options.title !== undefined) requireXmlText(options.title, functionName, 'title');
  if (options.theme !== undefined) {
    ensureEnum(options.theme, ['light', 'dark'] as const, 'theme', functionName);
  }

  if (options.prices !== undefined) {
    requireArgumentObject(functionName, 'options.prices', options.prices);
    ensureKnownKeys(functionName, 'options.prices', options.prices, PRICE_RANGE_KEYS);
    requireFiniteFields(
      functionName,
      options.prices as unknown as Record<string, unknown>,
      PRICE_RANGE_KEYS,
      { exampleCall: 'payoffSvg(position, { prices: { from: 80, to: 120, steps: 201 } })' },
    );
  }

  if (options.market !== undefined) {
    requireArgumentObject(functionName, 'options.market', options.market);
    ensureKnownKeys(functionName, 'options.market', options.market, MARKET_KEYS);
    for (const field of MARKET_NUMERIC_KEYS) {
      ensureFiniteWhenPresent(options.market[field], `market.${field}`, functionName);
    }
    ensureOptionalMarketExpiry(options.market.expiry, functionName);
    const asOf = options.market.asOf;
    if (asOf !== undefined) {
      if (typeof asOf !== 'string' && typeof asOf !== 'number') {
        throw new InputError(
          `${functionName}: market.asOf must be an ISO date string or epoch-ms number when provided. Received ${asOf === null ? 'null' : typeof asOf}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: 'market.asOf' },
          },
        );
      }
      resolveValuationAsOf(asOf, functionName);
    }
  }
}

/**
 * Render a {@link Position}'s payoff diagram as a self-contained `<svg>` string. See the spec.
 */
export function payoffSvg(position: Position, options: PayoffSvgOptions = {}): string {
  requirePosition(position);
  requireArgumentObject('payoffSvg', 'options', options);
  validateOptions(options);
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  ensurePositive(width, 'width', 'payoffSvg');
  ensurePositive(height, 'height', 'payoffSvg');
  // The plot area must be positive after the fixed axis padding (padL+padR = 72, padT+padB ≤ 74),
  // else the frame/clip rects would get negative dimensions (a broken, non-rendering SVG).
  const MIN_W = 120;
  const MIN_H = 100;
  if (width < MIN_W || height < MIN_H) {
    throw new InputError(
      `payoffSvg: width must be ≥ ${MIN_W} and height ≥ ${MIN_H} to fit the axes; got ${width}×${height}.`,
      { code: ErrorCode.InputOutOfRange, context: { width, height } },
    );
  }
  const theme = THEMES[options.theme ?? 'light'];

  // metrics() also enforces single-expiry (a payoff diagram is single-expiration).
  const metrics = position.metrics();

  // Price range: explicit, or an auto-range around the strikes + finite breakevens (+ spot).
  let range: PriceRange;
  if (options.prices !== undefined) {
    range = options.prices;
  } else {
    range = autoPriceRange([
      ...position.legs.map((l) => (l.kind === 'stock' ? l.price : l.strike)),
      ...metrics.breakevens,
      ...(options.spot !== undefined ? [options.spot] : []),
    ]);
  }

  const includeCurrent = options.includeCurrentPnl === true;
  const rows = position.chartData({
    prices: range,
    include: { expirationPnl: true, ...(includeCurrent ? { currentPnl: true } : {}) },
    ...(options.market !== undefined ? { market: options.market } : {}),
  });
  if (rows.length < 2) {
    throw new InputError('payoffSvg: prices range must produce at least 2 points.', {
      code: ErrorCode.InputOutOfRange,
      context: { steps: rows.length },
    });
  }

  const xs = rows.map((r) => r.underlyingPrice);
  const expPnl = rows.map((r) => r.expirationPnl ?? 0);
  const curPnl = includeCurrent ? rows.map((r) => r.currentPnl ?? 0) : [];
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const allPnl = [...expPnl, ...curPnl, 0];
  let yLo = Math.min(...allPnl);
  let yHi = Math.max(...allPnl);
  const pad = (yHi - yLo) * 0.12 || Math.max(1, Math.abs(yHi) * 0.2);
  yLo -= pad;
  yHi += pad;

  // Plot area.
  const padL = 56;
  const padR = 16;
  const padT = options.title ? 34 : 16;
  const padB = 40;
  const px0 = padL;
  const py0 = padT;
  const px1 = width - padR;
  const py1 = height - padB;
  const sx = (price: number): number => px0 + ((price - xLo) / (xHi - xLo || 1)) * (px1 - px0);
  const sy = (pnl: number): number => py1 - ((pnl - yLo) / (yHi - yLo || 1)) * (py1 - py0);
  const zeroY = sy(0);
  const n2 = (v: number): number => Math.round(v * 100) / 100; // trim coordinate noise

  const polyline = (values: number[]): string =>
    xs.map((price, i) => `${n2(sx(price))},${n2(sy(values[i]!))}`).join(' ');

  // Area between the payoff curve and the zero line — filled green (clipped above 0) + red (below 0).
  const areaPath = `M ${n2(sx(xs[0]!))} ${n2(zeroY)} ${xs
    .map((price, i) => `L ${n2(sx(price))} ${n2(sy(expPnl[i]!))}`)
    .join(' ')} L ${n2(sx(xs[xs.length - 1]!))} ${n2(zeroY)} Z`;
  const id = hashId(`${xLo},${xHi},${yLo},${yHi},${width},${height}`);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-sans-serif, system-ui, sans-serif" role="img">`,
  );
  parts.push(
    `<defs>` +
      `<clipPath id="${id}-up"><rect x="${n2(px0)}" y="${n2(py0)}" width="${n2(px1 - px0)}" height="${n2(Math.max(0, zeroY - py0))}"/></clipPath>` +
      `<clipPath id="${id}-dn"><rect x="${n2(px0)}" y="${n2(zeroY)}" width="${n2(px1 - px0)}" height="${n2(Math.max(0, py1 - zeroY))}"/></clipPath>` +
      `</defs>`,
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.bg}"/>`);
  // Profit / loss shading.
  parts.push(
    `<path d="${areaPath}" fill="${theme.profit}" fill-opacity="0.16" clip-path="url(#${id}-up)"/>`,
  );
  parts.push(
    `<path d="${areaPath}" fill="${theme.loss}" fill-opacity="0.16" clip-path="url(#${id}-dn)"/>`,
  );
  // Zero line + plot frame.
  parts.push(
    `<line x1="${n2(px0)}" y1="${n2(zeroY)}" x2="${n2(px1)}" y2="${n2(zeroY)}" stroke="${theme.zero}" stroke-width="1"/>`,
  );
  parts.push(
    `<rect x="${n2(px0)}" y="${n2(py0)}" width="${n2(px1 - px0)}" height="${n2(py1 - py0)}" fill="none" stroke="${theme.grid}" stroke-width="1"/>`,
  );
  // Breakevens.
  for (const be of metrics.breakevens) {
    if (!Number.isFinite(be) || be < xLo || be > xHi) continue;
    const x = n2(sx(be));
    parts.push(
      `<line x1="${x}" y1="${n2(py0)}" x2="${x}" y2="${n2(py1)}" stroke="${theme.grid}" stroke-width="1" stroke-dasharray="3 3"/>`,
    );
    parts.push(
      `<text x="${x}" y="${n2(py1 + 13)}" fill="${theme.text}" font-size="10" text-anchor="middle">${esc(fmt(be))}</text>`,
    );
  }
  // Spot marker.
  if (options.spot !== undefined && options.spot >= xLo && options.spot <= xHi) {
    const x = n2(sx(options.spot));
    parts.push(
      `<line x1="${x}" y1="${n2(py0)}" x2="${x}" y2="${n2(py1)}" stroke="${theme.spot}" stroke-width="1.5" stroke-dasharray="2 2"/>`,
    );
    parts.push(
      `<text x="${x}" y="${n2(py0 - 3)}" fill="${theme.spot}" font-size="10" text-anchor="middle">spot ${esc(fmt(options.spot))}</text>`,
    );
  }
  // Current-P&L curve (dashed) then the expiration curve on top.
  if (includeCurrent) {
    parts.push(
      `<polyline points="${polyline(curPnl)}" fill="none" stroke="${theme.current}" stroke-width="1.5" stroke-dasharray="5 3"/>`,
    );
  }
  parts.push(
    `<polyline points="${polyline(expPnl)}" fill="none" stroke="${theme.curve}" stroke-width="2"/>`,
  );
  // Axis labels.
  const axisText = (x: number, y: number, s: string, anchor: string): string =>
    `<text x="${n2(x)}" y="${n2(y)}" fill="${theme.text}" font-size="10" text-anchor="${anchor}">${esc(s)}</text>`;
  parts.push(axisText(px0, py1 + 26, fmt(xLo), 'start'));
  parts.push(axisText(px1, py1 + 26, fmt(xHi), 'end'));
  parts.push(axisText(px0 - 6, py0 + 4, fmt(yHi), 'end'));
  parts.push(axisText(px0 - 6, py1, fmt(yLo), 'end'));
  parts.push(axisText(px0 - 6, n2(zeroY) + 3, '0', 'end'));
  // Max profit / loss labels.
  // An unbounded tail is labelled as the word (B3): there is no number to draw.
  parts.push(
    `<text x="${n2(px1 - 4)}" y="${n2(py0 + 12)}" fill="${theme.profit}" font-size="10" text-anchor="end">max ${metrics.maxProfit === null ? 'unbounded' : `+${esc(fmt(metrics.maxProfit))}`}</text>`,
  );
  parts.push(
    `<text x="${n2(px1 - 4)}" y="${n2(py1 - 4)}" fill="${theme.loss}" font-size="10" text-anchor="end">max ${metrics.maxLoss === null ? 'unbounded' : esc(fmt(metrics.maxLoss))}</text>`,
  );
  // Title + legend.
  if (options.title) {
    parts.push(
      `<text x="${n2((px0 + px1) / 2)}" y="18" fill="${theme.text}" font-size="13" font-weight="600" text-anchor="middle">${esc(options.title)}</text>`,
    );
  }
  if (includeCurrent) {
    parts.push(
      `<text x="${n2(px0 + 4)}" y="${n2(py0 + 12)}" fill="${theme.text}" font-size="10">` +
        `<tspan fill="${theme.curve}">— expiry</tspan> <tspan fill="${theme.current}">- - current</tspan></text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}
