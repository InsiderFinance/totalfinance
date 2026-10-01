/**
 * Compile-only type contract for selective model exposure (selective Greeks and exposure spec,
 * decisions 6 and 11–13). Typechecked by `pnpm typecheck`; never executed. Every `@ts-expect-error`
 * must stay an error — an unused one fails the typecheck.
 */
import {
  exposure,
  exposureFromGreeks,
  gammaExposure,
  vannaExposure,
  type ContractExposure,
  type ExposureMetric,
  type ExposureProfile,
  type ExposureShortcutInput,
  type ExposureTotals,
  type StrikeRow,
  type SuppliedExposureInput,
  type SuppliedExposureMarket,
  type SuppliedExposureReport,
  type SuppliedExposureMetric,
  type SuppliedExposureQuote,
  type SuppliedExposureTotals,
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

// ---- supplied Greeks: the same rule for GEX/DEX selection ----
declare const supplied: SuppliedExposureInput;
const report = exposureFromGreeks(supplied);
export const releasedReport: SuppliedExposureReport = report;
export const releasedTotals: SuppliedExposureTotals = report.aggregate;

declare const quotes: SuppliedExposureQuote[];
declare const market: SuppliedExposureMarket;
const gexOnly = exposureFromGreeks({
  quotes: [
    { ...quotes[0]!, greeks: { gamma: 0.02, provenance: { source: 'feed', timestampMs: 0 } } },
  ],
  market,
  config: {
    gexConvention: { calls: 1, puts: -1 },
    gammaUnit: 'per1PercentMove',
    maximumObservationAgeMs: 60_000,
  },
  metrics: ['gex'],
});
export const suppliedGex: number = gexOnly.aggregate.gex;
// @ts-expect-error DEX was not selected
void gexOnly.aggregate.dex;
// @ts-expect-error the DEX sign rides only with dex
void gexOnly.contributions[0]!.dexSign;
export const suppliedGammaUnit: string = gexOnly.assumptions.gammaUnit;
// @ts-expect-error the DEX convention is not echoed for a GEX-only report
void gexOnly.assumptions.dexConvention;

exposureFromGreeks({
  quotes,
  market,
  // @ts-expect-error a GEX report needs gexConvention and gammaUnit
  config: { dexConvention: { calls: 1, puts: 1 }, maximumObservationAgeMs: 0 },
  metrics: ['gex'],
});
// @ts-expect-error an empty literal selection computes nothing
exposureFromGreeks({ ...supplied, metrics: [] });
// @ts-expect-error vega is not a supplied-Greek exposure
exposureFromGreeks({ ...supplied, metrics: ['vega'] });

declare const suppliedChoice: SuppliedExposureMetric[];
const dynamicSupplied = exposureFromGreeks({ ...supplied, metrics: suppliedChoice });
export const maybeSuppliedGex: number | undefined = dynamicSupplied.aggregate.gex;
// @ts-expect-error a dynamic selection cannot claim GEX was computed
export const certainSuppliedGex: number = dynamicSupplied.aggregate.gex;

// ---- the released signatures still name the released types (overload order) ----
type ReleasedExposureInput = Parameters<typeof exposure>[0];
declare const releasedInput: ReleasedExposureInput;
export const releasedProfile: ExposureProfile = exposure(releasedInput);
export const releasedReturn: ExposureProfile = null as unknown as ReturnType<typeof exposure>;
type ReleasedSuppliedInput = Parameters<typeof exposureFromGreeks>[0];
declare const releasedSupplied: ReleasedSuppliedInput;
export const releasedSuppliedReport: SuppliedExposureReport = exposureFromGreeks(releasedSupplied);
export const releasedSuppliedReturn: SuppliedExposureReport = null as unknown as ReturnType<
  typeof exposureFromGreeks
>;
