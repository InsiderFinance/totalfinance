#!/usr/bin/env node
/**
 * Captures the model-exposure behavior of the PUBLISHED `@insiderfinance/totalfinance@0.1.0` as a
 * golden file, so the selective-exposure work (docs/specs/selective-greeks-and-exposure.md,
 * decision 11) is checked against the released artifact rather than against the code it rewrote.
 *
 * Reproduce (the output must not change — it pins a released version):
 *
 *     npm install --prefix /tmp/tf010 @insiderfinance/totalfinance@0.1.0
 *     node tools/golden/capture-exposure-baseline.mjs \
 *       /tmp/tf010/node_modules/@insiderfinance/totalfinance/modules/structure/dist/index.js
 *
 * Output (committed, so CI needs no network):
 *   packages/structure/test/golden/exposure-0.1.0.json
 *
 * The chain is synthetic and deterministic: five expiries around a Monday snapshot (0DTE, a
 * mid-week, the June monthly OPEX, July and September), a 13-strike ladder of calls and puts, a
 * smile, pseudo-random open interest, quotes that need the IV fallback from bid/ask, and rows the
 * profile must skip (zero open interest, an expired expiry, no usable IV or price).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error(
    'usage: capture-exposure-baseline.mjs <path to 0.1.0 modules/structure/dist/index.js>',
  );
  process.exit(2);
}
const { exposure } = await import(pathToFileURL(entry).href);

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

const entries = CASES.map(({ name, input }) => {
  const profile = exposure(input);
  return {
    name,
    input,
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

const here = dirname(fileURLToPath(import.meta.url));
const out = join(
  here,
  '..',
  '..',
  'packages',
  'structure',
  'test',
  'golden',
  'exposure-0.1.0.json',
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      // -0, NaN and ±Infinity do not survive JSON; they are written as strings and revived by the test.
      meta: {
        generator: 'tools/golden/capture-exposure-baseline.mjs',
        reference: '@insiderfinance/totalfinance@0.1.0 (published), structure exposure()',
        node: process.version,
      },
      entries,
    },
    (_key, value) =>
      typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))
        ? String(Object.is(value, -0) ? '-0' : value)
        : value,
    1,
  ) + '\n',
);
console.log(`wrote ${out} (${entries.length} cases, ${quotes.length} quotes each)`);
