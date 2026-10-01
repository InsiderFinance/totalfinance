/**
 * Compile-only type contract for selective model exposure (selective Greeks and exposure spec,
 * decisions 6 and 11–13). Typechecked by `pnpm typecheck`; never executed. Every `@ts-expect-error`
 * must stay an error — an unused one fails the typecheck.
 */
import {
  exposure,
  gammaExposure,
  vannaExposure,
  type ContractExposure,
  type ExposureMetric,
  type ExposureProfile,
  type ExposureShortcutInput,
  type ExposureTotals,
  type StrikeRow,
} from '@totalfinance/structure';

declare const input: ExposureShortcutInput;

// ---- omitting metrics: the full profile, typed exactly as before ----
const full = exposure(input);
export const fullProfile: ExposureProfile = full;
export const fullTotals: ExposureTotals = full.aggregate;
export const fullRow: ContractExposure = full.contracts[0]!;
export const fullAtSpot: { gex: number; dex: number } = full.atSpot(6500);
export const fullStrikes: StrikeRow[] = full.byStrike();

// ---- a literal selection: exactly those metrics ----
const gd = exposure({ ...input, metrics: ['gex', 'dex'] });
export const gdGex: number = gd.aggregate.gex;
export const gdDex: number = gd.aggregate.dex;
// @ts-expect-error vanna was not selected, so it does not exist
void gd.aggregate.vanna;
export const gdGamma: number = gd.contracts[0]!.gamma;
export const gdDelta: number = gd.contracts[0]!.delta;
export const gdAtSpot: { gex: number; dex: number } = gd.atSpot(6500);
export const gdStrikeGex: number = gd.byStrike()[0]!.gex;
export const gdStrikeCallGex: number = gd.byStrike()[0]!.callGex;
// @ts-expect-error a view cannot ask for a metric the profile did not compute
gd.byStrike(['vega']);

const vanna = vannaExposure(input);
export const vannaTotal: number = vanna.aggregate.vanna;
// @ts-expect-error the raw gamma rides only with gex
void vanna.contracts[0]!.gamma;
// @ts-expect-error atSpot re-evaluates gex/dex, and this profile computed neither
vanna.atSpot(6500);
// Analyses compute their own dependencies, so they are available on every profile.
export const vannaWall: number | null = vanna.levels().vannaWall;

const gamma = gammaExposure(input);
export const gammaAtSpot: number = gamma.atSpot(6500).gex;
// @ts-expect-error a gamma profile does not re-evaluate dex
void gamma.atSpot(6500).dex;
// @ts-expect-error a shortcut IS its selection; it takes no metrics
gammaExposure({ ...input, metrics: ['gex'] });

// ---- a dynamic selection: honest optional metrics ----
declare const chosen: ExposureMetric[];
const dynamic = exposure({ ...input, metrics: chosen });
export const maybeGex: number | undefined = dynamic.aggregate.gex;
// @ts-expect-error a dynamic selection cannot claim gex was computed
export const certainGex: number = dynamic.aggregate.gex;
export const maybeGamma: number | undefined = dynamic.contracts[0]!.gamma;

// ---- malformed selections ----
// @ts-expect-error an empty literal selection computes nothing
exposure({ ...input, metrics: [] });
// @ts-expect-error unknown metric
exposure({ ...input, metrics: ['gamma'] });
