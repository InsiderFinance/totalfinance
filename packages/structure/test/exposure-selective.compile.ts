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
  type ExposureInput,
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
// A view asking for a metric the profile did not compute type-checks and is refused at run time
// (input.invalid_enum, exposure-selective.test.ts); the DEFAULT view is typed to the selection.

const vanna = vannaExposure(input);
export const vannaTotal: number = vanna.aggregate.vanna;
// @ts-expect-error the raw gamma rides only with gex
void vanna.contracts[0]!.gamma;
// atSpot re-evaluates gex/dex: on a profile that computed neither it returns nothing typed and
// refuses at run time (input.invalid_enum) rather than inventing a value.
export const vannaAtSpot: Record<never, never> = vanna.atSpot(6500);
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

// ---- selections the type cannot pin down: only what every possibility holds is required ----
declare const condition: boolean;
const conditionalMetrics = condition ? (['gex'] as const) : (['dex'] as const);
const conditional = exposure({ ...input, metrics: conditionalMetrics });
export const conditionalMaybeGex: number | undefined = conditional.aggregate.gex;
// @ts-expect-error gex is undefined on the dex branch
export const conditionalGex: number = conditional.aggregate.gex;
// @ts-expect-error nor is the row's raw gamma guaranteed
export const conditionalRowGamma: number = conditional.contracts[0]!.gamma;
// @ts-expect-error nor a by-strike gex column
export const conditionalStrikeGex: number = conditional.byStrike()[0]!.gex;
// @ts-expect-error vanna is in neither branch
void conditional.aggregate.vanna;
const sharedMetrics = condition ? (['gex', 'vanna'] as const) : (['vanna'] as const);
const sharedProfile = exposure({ ...input, metrics: sharedMetrics });
export const sharedVanna: number = sharedProfile.aggregate.vanna;
// @ts-expect-error gex is only on one branch
export const sharedGex: number = sharedProfile.aggregate.gex;
declare const whichMetric: 'gex' | 'dex';
const unionMetric = exposure({ ...input, metrics: [whichMetric] });
export const unionMaybeDex: number | undefined = unionMetric.aggregate.dex;
// @ts-expect-error the element may be gex
export const unionDex: number = unionMetric.aggregate.dex;

// ---- malformed selections ----
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

// Which Greeks and controls a selection requires is checked per row at run time (typed
// input.missing_field, supplied-exposure-selective.test.ts); the request type lets either be absent.
// @ts-expect-error vega is not a supplied-Greek exposure
exposureFromGreeks({ ...supplied, metrics: ['vega'] });

const suppliedConditional = exposureFromGreeks({
  ...supplied,
  metrics: condition ? (['gex'] as const) : (['dex'] as const),
});
export const suppliedMaybeGex: number | undefined = suppliedConditional.aggregate.gex;
// @ts-expect-error GEX is undefined on the DEX branch
export const suppliedConditionalGex: number = suppliedConditional.aggregate.gex;
const suppliedUnion = exposureFromGreeks({ ...supplied, metrics: [whichMetric] });
// @ts-expect-error the element may be gex
export const suppliedUnionDex: number = suppliedUnion.aggregate.dex;

// `breakdowns`: omitted or true carries byStrike/byExpiry; false leaves them out; a runtime boolean
// makes them optional.
export const releasedByStrike: unknown[] = exposureFromGreeks(supplied).byStrike;
export const explicitByExpiry: unknown[] = exposureFromGreeks({
  ...supplied,
  breakdowns: true,
}).byExpiry;
const lean = exposureFromGreeks({ ...supplied, breakdowns: false });
export const leanAggregate: number = lean.aggregate.gex;
// @ts-expect-error breakdowns: false leaves byStrike out of the report
void lean.byStrike;
// @ts-expect-error and byExpiry
void lean.byExpiry;
declare const maybeBreakdowns: boolean;
const dynamicBreakdowns = exposureFromGreeks({ ...supplied, breakdowns: maybeBreakdowns });
export const maybeByStrike: unknown[] | undefined = dynamicBreakdowns.byStrike;
// @ts-expect-error a runtime boolean cannot promise the breakdowns exist
export const certainByStrike: unknown[] = dynamicBreakdowns.byStrike;
// @ts-expect-error breakdowns is a boolean, not a list
exposureFromGreeks({ ...supplied, breakdowns: ['strike'] });

declare const suppliedChoice: SuppliedExposureMetric[];
const dynamicSupplied = exposureFromGreeks({ ...supplied, metrics: suppliedChoice });
export const maybeSuppliedGex: number | undefined = dynamicSupplied.aggregate.gex;
// @ts-expect-error a dynamic selection cannot claim GEX was computed
export const certainSuppliedGex: number = dynamicSupplied.aggregate.gex;

// ---- released callers name the released types and get the released results ----
declare const releasedInput: ExposureInput;
export const releasedProfile: ExposureProfile = exposure(releasedInput);
declare const releasedSupplied: SuppliedExposureInput;
export const releasedSuppliedReport: SuppliedExposureReport = exposureFromGreeks(releasedSupplied);
// A released input's fields keep their released (required) types.
export const releasedConvention: 1 | -1 = releasedSupplied.config.dexConvention.calls;
