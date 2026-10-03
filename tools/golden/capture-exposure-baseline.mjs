#!/usr/bin/env node
/**
 * Captures the model-exposure behavior of the PUBLISHED `@insiderfinance/totalfinance@0.1.0` as a
 * golden file, so the selective-exposure work (docs/specs/selective-greeks-and-exposure.md,
 * decision 11) is checked against the released artifact rather than against the code it rewrote.
 *
 * Reproduce (the output must not change — it pins a released version):
 *
 *     npm install --prefix /tmp/tf010 @insiderfinance/totalfinance@0.1.0
 *     STRUCTURE=/tmp/tf010/node_modules/@insiderfinance/totalfinance/modules/structure/dist/index.js
 *     node tools/golden/capture-exposure-baseline.mjs "$STRUCTURE"
 *
 * Output (committed, so CI needs no network):
 *   packages/structure/test/golden/exposure-0.1.0.inputs.json               model exposure() cases
 *   packages/structure/test/golden/exposure-0.1.0.<platform>-<arch>.json    their 0.1.0 results here
 *   packages/structure/test/golden/supplied-exposure-0.1.0.json            exposureFromGreeks()
 *
 * MODEL RESULTS ARE PER PLATFORM. V8's transcendental functions (Math.exp, log, pow, sin, …) can
 * differ in the last bit between its builds: darwin-arm64, linux-arm64 and x64 (Linux and macOS
 * alike) each return a few different last bits on these cases. 0.1.0 is not reproducible across
 * them bit for bit, so exact parity is checked against what 0.1.0 returns on the SAME platform.
 * The result is stable across Node 22.13–26 and across official and Homebrew builds. Each
 * platform is captured from the committed inputs (read back below, so every platform prices
 * identical quotes). From an Apple-silicon Mac, all four:
 *
 *     node tools/golden/capture-exposure-baseline.mjs "$STRUCTURE"              # darwin-arm64
 *     arch -x86_64 node-v22.23.2-darwin-x64/bin/node \
 *       tools/golden/capture-exposure-baseline.mjs "$STRUCTURE"                 # darwin-x64
 *     for p in amd64 arm64; do                                                  # linux-x64, -arm64
 *       docker run --rm --platform linux/$p -v "$PWD:/repo" -v /tmp/tf010:/tmp/tf010:ro -w /repo \
 *         node:22-bookworm-slim node tools/golden/capture-exposure-baseline.mjs "$STRUCTURE"
 *     done
 *
 * The supplied-Greek report is arithmetic on supplied Greeks and is byte-identical on all four,
 * so it is one file.
 *
 * The chain is synthetic and deterministic: five expiries around a Monday snapshot (0DTE, a
 * mid-week, the June monthly OPEX, July and September), a 13-strike ladder of calls and puts, a
 * smile, pseudo-random open interest, quotes that need the IV fallback from bid/ask, and rows the
 * profile must skip (zero open interest, an expired expiry, no usable IV or price).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error(
    'usage: capture-exposure-baseline.mjs <path to 0.1.0 modules/structure/dist/index.js>',
  );
  process.exit(2);
}
const structureUrl = pathToFileURL(entry);
const { exposure, exposureFromGreeks } = await import(structureUrl.href);
const { resolvedExpiry } = await import(new URL('../../core/dist/index.js', structureUrl).href);

// Deterministic LCG (Numerical Recipes constants) — no Math.random.
let state = 20261001;
const next = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};

const SPOT = 6500;
const EXPIRIES = [
  '2026-06-12',
  '2026-06-15',
  '2026-06-17',
  '2026-06-19',
  '2026-07-17',
  '2026-09-18',
];
const quotes = [];
for (const expiry of EXPIRIES) {
  for (let k = 0; k < 13; k++) {
    const strike = 6200 + k * 50;
    for (const type of ['call', 'put']) {
      const moneyness = Math.log(strike / SPOT);
      const iv = 0.16 - 0.35 * moneyness + 1.4 * moneyness * moneyness;
      const openInterest = Math.floor(next() * 4000);
      const quote = {
        contract: { underlying: 'SPX', expiry, strike, type, style: 'european' },
        ts: Date.UTC(2026, 5, 15, 18, 30),
        openInterest,
        underlyingPrice: SPOT,
      };
      const roll = next();
      if (roll < 0.12) {
        // IV fallback path: no impliedVolatility, a two-sided market instead.
        const mid =
          type === 'call' ? Math.max(SPOT - strike, 0) + 40 : Math.max(strike - SPOT, 0) + 40;
        quote.bid = mid * 0.98;
        quote.ask = mid * 1.02;
      } else if (roll < 0.15) {
        // Unusable: neither IV nor a price — skipped and counted.
      } else {
        quote.impliedVolatility = iv;
      }
      if (next() < 0.1) quote.contract.multiplier = 50;
      quotes.push(quote);
    }
  }
}

const ALL = ['gex', 'dex', 'vega', 'vanna', 'charm', 'theta', 'vomma', 'speed', 'color'];
const CASES = [
  {
    name: 'dealerShortGamma per1PercentMove',
    input: {
      quotes,
      market: {
        spot: SPOT,
        riskFreeRate: 0.043,
        dividendYield: 0.013,
        asOf: '2026-06-15T14:30:00-04:00',
      },
      config: { convention: 'dealerShortGamma' },
    },
  },
  {
    name: 'callsPositivePutsNegative perPoint, spot from quotes',
    input: {
      quotes,
      market: { riskFreeRate: 0.043, asOf: '2026-06-15T14:30:00-04:00' },
      config: {
        convention: 'callsPositivePutsNegative',
        gammaUnit: 'perPoint',
        priceSource: 'mid',
      },
    },
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const goldenDirectory = join(here, '..', '..', 'packages', 'structure', 'test', 'golden');
mkdirSync(goldenDirectory, { recursive: true });
const writeGolden = (name, document) =>
  writeFileSync(
    join(goldenDirectory, name),
    JSON.stringify(
      document,
      // -0, NaN and ±Infinity do not survive JSON; they are written as strings and revived by the test.
      (_key, value) =>
        typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
          ? String(Object.is(value, -0) ? '-0' : value)
          : value,
      1,
    ) + '\n',
  );

// The cases are generated once and then committed. A capture on another platform reads them back
// instead of regenerating them (the generator calls Math.log), so every platform prices identical
// quotes — the same JSON the test feeds to the code under test.
const inputsFile = 'exposure-0.1.0.inputs.json';
if (existsSync(join(goldenDirectory, inputsFile))) {
  const committed = JSON.parse(readFileSync(join(goldenDirectory, inputsFile), 'utf8')).entries;
  for (const testCase of CASES) {
    const match = committed.find((entry) => entry.name === testCase.name);
    if (!match) throw new Error(`${inputsFile} has no case named ${testCase.name}`);
    testCase.input = match.input;
  }
} else {
  writeGolden(inputsFile, {
    meta: {
      generator: 'tools/golden/capture-exposure-baseline.mjs',
      purpose: 'the model exposure() cases; their 0.1.0 results are per platform',
    },
    entries: CASES,
  });
}

const platform = `${process.platform}-${process.arch}`;
const entries = CASES.map(({ name, input }) => {
  const profile = exposure(input);
  return {
    name,
    expected: {
      spot: profile.spot,
      contracts: profile.contracts,
      aggregate: profile.aggregate,
      assumptions: profile.assumptions,
      diagnostics: profile.diagnostics,
      levels: profile.levels(),
      levelsWideBand: profile.levels({ pinRiskBand: 0.02 }),
      netDrift: profile.netDrift(),
      byStrike: profile.byStrike(),
      byStrikeGex: profile.byStrike(['gex']),
      byStrikeVannaCharm: profile.byStrike(['vanna', 'charm']),
      byExpiry: profile.byExpiry(),
      atSpot: [6300, 6500, 6512.5, 6700].map((s) => ({ spot: s, ...profile.atSpot(s) })),
      scenarioDefault: profile.scenarioMap(),
      scenarioFull: profile.scenarioMap({
        spot: { from: 6300, to: 6700, steps: 5 },
        volatilityShock: [-0.05, 0, 0.05],
        timeAdvance: [0, 1 / 365, 3 / 365],
        metrics: ALL,
      }),
      scenarioGammaOnly: profile.scenarioMap({ spot: [6400, 6450, 6500], metrics: ['gex'] }),
    },
  };
});

const platformFile = `exposure-0.1.0.${platform}.json`;
writeGolden(platformFile, {
  meta: {
    generator: 'tools/golden/capture-exposure-baseline.mjs',
    reference: '@insiderfinance/totalfinance@0.1.0 (published), structure exposure()',
    platform,
    node: process.version,
  },
  entries,
});
console.log(`wrote ${platformFile} (${entries.length} cases, ${quotes.length} quotes each)`);

// ---- exposureFromGreeks: supplied-Greek accounting ----
// Every exclusion path, duplicates, the multiplier fallback and zero open interest, at one snapshot.
const asOfMs = Date.parse('2026-09-01T15:00:00Z');
const supplied = [];
const SUPPLIED_EXPIRIES = ['2026-08-28', '2026-09-04', '2026-09-18', '2026-10-16'];
let row = 0;
for (const expiry of SUPPLIED_EXPIRIES) {
  for (const strike of [95, 100, 105]) {
    for (const type of ['call', 'put']) {
      const delta = type === 'call' ? 0.5 + (100 - strike) / 40 : -0.5 + (100 - strike) / 40;
      const gamma = 0.01 + next() * 0.04;
      const quote = {
        contract: {
          underlying: 'SPY',
          type,
          style: 'american',
          strike,
          expiry,
          ...resolvedExpiry(expiry),
          ...(row % 7 === 3 ? {} : { multiplier: 100 }),
        },
        source: 'chain-feed',
        timestampMs: asOfMs - 1000,
        openInterest: row % 11 === 5 ? 0 : Math.floor(next() * 5000),
        greeks: {
          delta,
          gamma,
          provenance: { source: 'greek-feed', timestampMs: asOfMs - 500, model: 'vendor' },
        },
      };
      if (row % 9 === 4) delete quote.greeks; // missingGreeks
      if (row % 13 === 6) delete quote.openInterest; // missingOpenInterest
      if (row % 10 === 7) quote.timestampMs = asOfMs - 120_000; // staleQuote
      if (row % 17 === 8 && quote.greeks) quote.greeks.provenance.timestampMs = asOfMs + 1; // futureGreeks
      supplied.push(quote);
      row++;
    }
  }
}
supplied.push({ ...supplied[14], source: 'second-feed' }); // a repeated identity

const SUPPLIED_CASES = [
  {
    name: 'per1PercentMove, dealer-style signs, default multiplier',
    input: {
      quotes: supplied,
      market: {
        underlying: 'SPY',
        spot: 100.25,
        source: 'spot-feed',
        timestampMs: asOfMs - 200,
        asOf: asOfMs,
      },
      config: {
        gexConvention: { calls: 1, puts: -1 },
        dexConvention: { calls: 1, puts: 1 },
        gammaUnit: 'per1PercentMove',
        maximumObservationAgeMs: 60_000,
        defaultMultiplier: 10,
      },
    },
  },
  {
    name: 'perPoint, inverted signs',
    input: {
      quotes: supplied,
      market: {
        underlying: 'SPY',
        spot: 99.5,
        source: 'spot-feed',
        timestampMs: asOfMs,
        asOf: '2026-09-01T11:00:00-04:00',
      },
      config: {
        gexConvention: { calls: -1, puts: 1 },
        dexConvention: { calls: -1, puts: -1 },
        gammaUnit: 'perPoint',
        maximumObservationAgeMs: 90_000,
        defaultMultiplier: 100,
      },
    },
  },
];
const suppliedOut = join(
  here,
  '..',
  '..',
  'packages',
  'structure',
  'test',
  'golden',
  'supplied-exposure-0.1.0.json',
);
writeFileSync(
  suppliedOut,
  JSON.stringify(
    {
      meta: {
        generator: 'tools/golden/capture-exposure-baseline.mjs',
        reference: '@insiderfinance/totalfinance@0.1.0 (published), structure exposureFromGreeks()',
        node: process.version,
      },
      entries: SUPPLIED_CASES.map(({ name, input }) => ({
        name,
        input,
        expected: exposureFromGreeks(input),
      })),
    },
    null,
    1,
  ) + '\n',
);
console.log(
  `wrote ${suppliedOut} (${SUPPLIED_CASES.length} cases, ${supplied.length} quotes each)`,
);
