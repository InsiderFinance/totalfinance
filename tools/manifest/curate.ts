/**
 * One-off curation pass (P3.1a) — assign hand-reviewed roles to every `unclassified` entry.
 *
 * This script encodes the human classification decisions in reviewable per-package rule tables
 * and applies them to the generated skeletons. After this run, the JSON manifests are the source
 * of truth: `pnpm manifest:update` preserves these roles and only inserts `unclassified` for
 * genuinely NEW exports. Keep this file — the tables document the reasoning — but it is not part
 * of any pipeline.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./packages', import.meta.url));

import type { PackageManifest, Role } from './schema.js';

type Rule = [pattern: string, role: Role, note?: string];

/** Per-package rule tables: `re:`-prefixed regex → role (+ optional note). */
const RULES: Record<string, Rule[]> = {
  backtest: [
    // Research/report tier — rich results with diagnostics.
    [
      're:^(attribution|eventDriven|vectorized|walkForward|monteCarloResample|optionsBacktest|optionsTearSheet|tearSheet|returnStatistics)$',
      'analysis',
    ],
    // Cost/broker model factories plugged into the engines.
    ['re:^(borrow|brokers|fees|slippage)\\.', 'artifact', 'cost/broker model factory'],
    // Signal/series plumbing.
    [
      're:^(checkDataAlignment|crossOver(Series)?|crossUnder(Series)?|equityToReturns|gtSeries|latchSeries|ltSeries|toEquityPoints)$',
      'helper',
    ],
  ],
  calendars: [
    ['re:\\.(name|timezone|version)$', 'constant'],
    ['re:^(NYSE|CBOE|crypto24x7)\\.', 'helper', 'calendar instance method'],
    ['re:^usMarket(Closures|HalfDayRules|HolidayRules)$', 'constant', 'holiday rule data'],
    ['re:^(expirations|nextExpiry|requireCalendar|withTradingVocabulary)$', 'helper'],
  ],
  core: [
    // Trusted tier: validation, time, formatting, envelope plumbing — all helpers by design.
    ['re:\\.(name|timezone|version)$', 'constant'],
    ['re:^s\\.', 'schema', 'schema combinator'],
    ['re:.*', 'helper', 'trusted-tier utility (specification Law 7)'],
  ],
  crypto: [
    // P3.2 migrated the whole package to the analysis grammar (rich Computed results).
    ['re:.*', 'analysis'],
  ],
  'fixed-income': [
    [
      're:^(addMonths|adjustDate|compareDates|daysInMonth|daysInYear|isEndOfMonth|isLeapYear|yearFraction|generateSchedule|paymentsPerYear|discountFromZero|zeroFromDiscount|conversionFactor|tipsIndexRatio)$',
      'helper',
      'date/curve arithmetic utility',
    ],
    [
      're:^(bachelierKernel|blackKernel)$',
      'kernel',
      'flat kernel on the FI root — evict to an expert subpath (kernels-off-roots ledger)',
    ],
    ['re:^(bonds|curves)\\.', 'artifact', 'instrument/curve factory'],
    ['re:^(cir|vasicek|hullWhite|g2pp|shortRateTree)$', 'artifact', 'short-rate model factory'],
    ['re:^credit\\.(survivalFrom.*|flatHazard)$', 'artifact', 'credit curve factory'],
    ['re:.*', 'analysis'],
  ],
  math: [
    // The numerical foundation IS the kernel tier (spec Law 7).
    ['re:.*', 'kernel'],
  ],
  mcp: [['re:.*', 'helper', 'MCP integration (server/pack/tool builders)']],
  options: [
    // Flat model kernels — reachable only via expert subpaths after P3.3.
    [
      're:^(bsm|black76|bachelier|heston(Cos)?|sabr|localVolatility|gbm)[A-Z]',
      'kernel',
      'expert model kernel (subpath entrypoints)',
    ],
    [
      're:^(hestonPrice|hestonImpliedVolatility|hestonMonteCarloEstimate|hestonMonteCarloPrice|sabrVolatility|sabrPrice|sabrMonteCarloPrice|sabrMonteCarloEstimate|gbmPath|gbmTerminal|localVolatilityGrid|localVolatilityMonteCarloEstimate|localVolatilityMonteCarloPrice|equityLattice|monteCarloEuropean|monteCarloPrice)$',
      'kernel',
      'expert model kernel (subpath entrypoints)',
    ],
    // Exotics families: the curated namespaces ARE the sanctioned root surface; members are the
    // expert model tier (single-object typed inputs, lean numeric output).
    [
      're:^(asian|autocallable|barrier|basket|cliquet|compo|digital|doubleTouch|forwardStart|gbm|heston|inverseOption|localVolatility|lookback|napoleon|quanto|rainbow|reverseCliquet|sabr|spread|touch|varianceSwap|volatilitySwap)\\.',
      'kernel',
      'exotics/model member (namespace is the curated root surface)',
    ],
    ['re:^engines\\.|^defineOptionPricingEngine$', 'helper', 'pricing-engine factory'],
    [
      're:^(option\\.(call|put|usEquityCall|usEquityPut|european)|callContract|putContract|usEquityCall|usEquityPut|european|market|americanExercise|dividendTermStructure)$',
      'artifact',
      'contract/market builder',
    ],
    [
      're:^(option\\.(price|impliedVolatility|compareEngines)|priceOption|impliedVolatilityOption|americanImpliedVolatility|compareEngines|impliedVolatility|impliedVolatilityMany|priceMany|checkBlackScholesNoArbitrage|dupireLocalVolatility)$',
      'analysis',
    ],
    [
      're:^(impliedBorrow|impliedDividendYield|impliedForward|boxSpreadRate)$',
      'facade',
      'scalar extractor — .explain twin pending (facade-explain ledger)',
    ],
    ['re:^selectQuotePrice$', 'helper'],
  ],
  performance: [
    [
      're:^(simpleReturns|logReturns|cumulativeReturns|equityCurve|underwater|maxDrawdownFromReturns)$',
      'helper',
      'series transform (facade twin with .explain lives on the main metric)',
    ],
    [
      're:^(annualizationAssumptions|degenerateAwareDiagnostics|requireSeries|returnsDiagnostics|riskAdjustedAssumptions)$',
      'helper',
    ],
  ],
  risk: [
    [
      're:^(walkForwardSplits|purgedKFold|adjustPValues|covarianceToCorrelation|rawGreeksFromDisplay|survivorshipWarning|parameterSweepDiagnostics)$',
      'helper',
    ],
    ['re:^shock\\.', 'artifact', 'scenario/shock builder'],
    ['re:.*', 'analysis'],
  ],
  strategy: [
    ['re:^legs\\.', 'artifact', 'leg builder'],
    ['re:^(strategy|buildStrategy|strategyFromChain)$', 'artifact', 'position factory'],
    ['re:^(explainPosition|optimizeStrategy|scanStrategies|classifyStrategy)$', 'analysis'],
    [
      're:^(listStrategies|strategyOf|strategySignature|payoffSvg|expectedIntrinsic|terminalCdf|touchProbability)$',
      'helper',
      'catalog/scalar utility (probability facades live in @totalfinance/volatility)',
    ],
    // The ~60 named strategy constructors (ironCondor, jadeLizard, …) build Positions.
    ['re:.*', 'artifact', 'named strategy constructor'],
  ],
  structure: [
    ['re:^deltaAdjustedPremium$', 'helper'],
    ['re:.*', 'analysis'],
  ],
  ta: [
    // Alternative chart-type constructors + their namespace twins: series transforms.
    [
      're:^(charts|aggregators)\\.|^(dollarBars|dollarImbalanceBars|dollarRunBars|imbalanceBars|kagi|lineBreak|pointAndFigure|rangeBars|renko|runBars|tickBars|volumeBars|volumeImbalanceBars|volumeRunBars|footprintBars|resample|alignToBars|barsFromColumns|columnsFromBars|closes)$',
      'helper',
      'bar/series transform',
    ],
    ['re:^bar\\.', 'helper', 'single-bar accessor'],
    // Price-action structure detectors (flat + namespace twins): plain-value quant answers whose
    // .explain twins are pending — tracked on the facade-explain ledger via the priceAction note.
    [
      're:^priceAction\\.|^(breakouts|channel|fibExtension|fibRetracement|fractals|gapFill|gaps|lineAt|marketStructure|openingRange|openingRangeBreakout|orbRetest|pivots|previousSessionLevels|sessionRanges|supportResistance|swings|trendlines|zigzag|divergences)$',
      'analysis',
      'structure detector returning rich level/point data',
    ],
    // Signal DSL combinators.
    [
      're:^(gt|gte|lt|lte|between|rising|falling|not|pairs|condition|signal|crossOver|crossUnder)$',
      'helper',
      'signal DSL combinator',
    ],
    // Registry / discovery / docs machinery.
    [
      're:^(defineIndicator|register|getIndicator|hasIndicator|listIndicators|searchIndicators|aliasesOf|resolveIndicator|resolveIndicatorName|resolveCandleName|indicatorCategories|indicatorWarmup|indicatorWarmups|describeIndicator|bindIndicatorMetadata|makeIndicator|compatibilityMatrixMarkdown|registryMarkdown|warmupMarkdown|checkSnapshotVersion|candlestickNames|detectCandles|candleColor|candleAverage|talibCandle|cdlPattern|cdl[A-Z].*Talib|features|mavp)$',
      'helper',
      'registry/discovery/meta',
    ],
    // Async stream plumbing.
    ['re:^(collect|collectAsync|streamAsync)$', 'helper', 'stream plumbing'],
    // Microstructure tier — plain-value; explain twins pending where they are quant answers.
    [
      're:^(microprice|bookImbalance|orderBookImbalance|cumulativeVolumeDelta|tradeSign|tickVolumeProfile|volumeProfile)$',
      'analysis',
      'microstructure metric returning rich/aligned data',
    ],
  ],
  volatility: [
    [
      're:^(sviVolatility|sviTotalVariance|sviG|sviMinG|sviButterflyFree|ssviVolatility|ssviTotalVariance|ssviArbitrageFree|ssviSliceW|ssviToSVI|essviVolatility|essviTotalVariance|essviArbitrageFree|thetaAt|phiValue|calibrationWeights|prepareSlices|atmTotalVariance|vannaVolga5Density|vannaVolgaDensity|vannaVolgaApproximation)$',
      'kernel',
      'model evaluator (root-flat today — kernels-off-roots ledger)',
    ],
    [
      're:^(volatilitySurface|localVolatilitySurface|smileFromQuotes|swaptionCube)$',
      'artifact',
      'surface/cube factory',
    ],
    ['re:.*', 'analysis'],
  ],
};

function roleFor(domain: string, name: string): { role: Role; note?: string } | null {
  for (const [pat, role, note] of RULES[domain] ?? []) {
    const re = new RegExp(pat.slice(3));
    if (pat.startsWith('re:') && re.test(name)) return note ? { role, note } : { role };
  }
  return null;
}

const SEEDED =
  /(monteCarloPrice|monteCarloEstimate|monteCarlo|Resample|bootstrap(?!Hazard)|brownianBridge|Sampler|Sample($|s)|sobolSequence|haltonPoint|haltonSequence|mulberry32|xoshiro128ss|restoreRng|stratifiedUniforms)/;

for (const domain of Object.keys(RULES)) {
  const path = `${DIR}/${domain}.json`;
  const m = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
  let applied = 0;
  const left: string[] = [];
  for (const [name, e] of Object.entries(m.exports)) {
    if (e.role === 'unclassified') {
      const hit = roleFor(domain, name);
      if (hit) {
        e.role = hit.role;
        if (hit.note) e.note = hit.note;
        applied += 1;
      } else {
        left.push(name);
      }
    }
    if (
      e.kind === 'function' &&
      SEEDED.test(name) &&
      ['kernel', 'analysis'].includes(e.role) &&
      !e.determinism
    ) {
      e.determinism = 'seeded';
    }
  }
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`${domain}: ${applied} classified${left.length ? `, LEFT: ${left.join(', ')}` : ''}`);
}
