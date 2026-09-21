/**
 * Phase 3B.N — removed public identities stay removed (law N9: pre-1.0 corrections are clean).
 *
 * `COMPILE_FAIL_FIXTURES` in `tools/manifest/naming-policy.ts` records each removed form as DATA at
 * N0; this file is where the executable evidence lands, one migration at a time. A fixture whose
 * `landsIn` phase has shipped must be asserted here — otherwise "we removed it" is a claim rather
 * than a contract, and nothing stops a compatibility alias reappearing.
 *
 * Every phase that has shipped is covered below, and the LAST test in the file proves it: the union
 * of the per-phase `COVERED_*` lists must equal every fixture id. Adding a fixture without evidence
 * fails there, which is the property that makes the earlier phases' silence impossible to repeat —
 * N2, N4 and N7 sat here as data-only claims until this gate was closed.
 *
 * Two kinds of evidence appear here, chosen by what the removal actually was:
 *
 *   - RUNTIME rejection, for a renamed field on a validated input. The old spelling must throw
 *     `input.unknown_field`, not be silently ignored — a spread-and-ignore is precisely how a
 *     renamed MCP field went dead earlier in this phase.
 *   - The committed NAMING BASELINE, for a renamed type or type member. TypeScript members are
 *     erased at runtime, so `public-naming.json` (which walks every public field) is the artifact
 *     that can testify. A reappearing `Bar.ts` would show up there as a new identity.
 *
 * Retired spellings are written by concatenation (`'implied' + 'Vol'`) so a future sweep cannot
 * rewrite the very strings these tests exist to prove are gone. That is not paranoia: it happened.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as umbrella from 'totalfinance';
import * as mcp from '@totalfinance/mcp';
import { defaultTools } from '@totalfinance/mcp';
import * as options from '@totalfinance/options';
import * as strategy from '@totalfinance/strategy';
import { requireTradeIntent } from '@totalfinance/portfolio/trade';
import { resolvedExpiry } from '@totalfinance/core';
import { flow } from '@totalfinance/structure';
import { ANALYSIS_VOL_FIXTURES } from './first-touch/fixtures/analysis-vol.js';
import * as blackScholesKernels from '@totalfinance/options/black-scholes';
import * as ta from '@totalfinance/technical-analysis';
import * as volatility from '@totalfinance/volatility';
import * as fixedIncome from '@totalfinance/fixed-income';
import * as risk from '@totalfinance/risk';
import { CANONICAL_TOKENS, COMPILE_FAIL_FIXTURES } from './manifest/naming-policy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');

/** Every workspace package's published name. */
function workspacePackageNames(): string[] {
  return readdirSync(PACKAGES)
    .map((dir) => resolve(PACKAGES, dir, 'package.json'))
    .filter((path) => existsSync(path))
    .map((path) => (JSON.parse(readFileSync(path, 'utf8')) as { name: string }).name);
}

/** The committed public-naming baseline, as a set of stable identity ids. */
const baselineIds: ReadonlySet<string> = new Set(
  (
    JSON.parse(readFileSync(resolve(ROOT, 'tools/manifest/public-naming.json'), 'utf8')) as {
      identities: { id: string }[];
    }
  ).identities.map((identity) => identity.id),
);

/** Assert a public field identity is present under its canonical name and absent under the old one. */
function expectFieldRenamed(
  packageName: string,
  owner: string,
  retired: string,
  canonical: string,
) {
  const id = (field: string) => `${packageName}|field|${owner}.${field}`;
  expect(
    baselineIds.has(id(canonical)),
    `${owner}.${canonical} is missing from the naming baseline — regenerate with \`pnpm naming:update\``,
  ).toBe(true);
  expect(
    baselineIds.has(id(retired)),
    `${owner}.${retired} is back in the public surface; law N9 forbids the compatibility alias`,
  ).toBe(false);
}

/**
 * The same evidence for a METHOD. `CandleView.bodyHigh` is a method, not a field, and asserting it
 * with `expectFieldRenamed` looked for `…|field|CandleView.bodyHigh` — an id that will never exist,
 * so the assertion failed on a rename that had landed correctly. A helper that can only describe one
 * identity kind quietly limits which renames can be evidenced at all.
 */
function expectMethodRenamed(
  packageName: string,
  owner: string,
  retired: string,
  canonical: string,
) {
  const id = (method: string) => `${packageName}|method|${owner}.${method}`;
  expect(
    baselineIds.has(id(canonical)),
    `${owner}.${canonical} is missing from the naming baseline — regenerate with \`pnpm naming:update\``,
  ).toBe(true);
  expect(
    baselineIds.has(id(retired)),
    `${owner}.${retired} is back in the public surface; law N9 forbids the compatibility alias`,
  ).toBe(false);
}

/**
 * Registry parameter names are public: they are what a caller passes to `indicator(name, params)`.
 *
 * RV9 — this used to match by SUFFIX across the entire baseline. `indicator` was passed in but only
 * ever reached the failure message, never the matching, so the assertions read:
 *
 *   present: SOME identity, in ANY package, on ANY owner, ends `.bollingerBandPeriod`
 *   absent:  NO identity, in ANY package, on ANY owner, ends `.bbPeriod`
 *
 * Neither is the claim. The first passes on a same-named field belonging to something else
 * entirely, so the rename could fail to land and the test would still be green; the second fails on
 * an unrelated package's legitimate field, which is a gate that goes red for a reason unconnected to
 * what it names. A helper whose first argument does nothing is a helper that measures nothing.
 *
 * Now it resolves the EXACT identity, and — because a registry parameter fans out across owners
 * (`squeeze(parameters)`, `SqueezeCore`, `SqueezeStream.constructor`, `SqueezeParameters` all carry
 * the same field) — it also sweeps the OWNING PACKAGE for the retired spelling, so a compatibility
 * alias reappearing on any sibling owner is caught. Scoped, not global.
 */
function expectParameterRenamed(
  packageName: string,
  owner: string,
  retired: string,
  canonical: string,
) {
  const exact = (field: string) => `${packageName}|field|${owner}.${field}`;
  expect(
    baselineIds.has(exact(canonical)),
    `${owner}.${canonical} is missing from the naming baseline — run \`pnpm naming:update\``,
  ).toBe(true);
  expect(
    baselineIds.has(exact(retired)),
    `${owner}.${retired} is back in the public surface; law N9 forbids the compatibility alias`,
  ).toBe(false);
  // The fan-out sweep: same package, any owner, retired spelling.
  const survivors = [...baselineIds].filter(
    (id) => id.startsWith(`${packageName}|field|`) && id.endsWith(`.${retired}`),
  );
  expect(
    survivors,
    `${retired} survives on a sibling owner in ${packageName}:\n${survivors.join('\n')}`,
  ).toEqual([]);
}

/** The error code a Law-12 unknown-field rejection must carry. */
const UNKNOWN_FIELD = 'input.unknown_field';

/** Call `run`, returning the thrown error's `code` (or a marker when nothing was thrown). */
function codeOfThrow(run: () => unknown): string {
  try {
    run();
  } catch (caught) {
    return (caught as { code?: string }).code ?? '(untyped error)';
  }
  return '(did not throw)';
}

describe('3B.N1 — removed package and domain identities', () => {
  it('no workspace package publishes the old scoped names', () => {
    const names = workspacePackageNames();
    expect(names).not.toContain('@totalfinance/vol');
    expect(names).not.toContain('@totalfinance/ta');
    expect(names).toContain('@totalfinance/volatility');
    expect(names).toContain('@totalfinance/technical-analysis');
  });

  it('no source directory keeps the old package folder', () => {
    expect(existsSync(resolve(PACKAGES, 'vol'))).toBe(false);
    expect(existsSync(resolve(PACKAGES, 'ta'))).toBe(false);
    expect(existsSync(resolve(PACKAGES, 'volatility'))).toBe(true);
    expect(existsSync(resolve(PACKAGES, 'technical-analysis'))).toBe(true);
  });

  it('the umbrella export map drops the old subpaths', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PACKAGES, 'totalfinance/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    const subpaths = Object.keys(manifest.exports);
    expect(subpaths).not.toContain('./vol');
    expect(subpaths).not.toContain('./ta');
    expect(subpaths).toContain('./volatility');
    expect(subpaths).toContain('./technical-analysis');
  });

  it('the umbrella exposes the full namespace names and no old alias', () => {
    const names = Object.keys(umbrella);
    expect(names).not.toContain('vol');
    expect(names).not.toContain('ta');
    expect(names).toContain('volatility');
    expect(names).toContain('technicalAnalysis');
  });

  it('MCP tool identities carry the full domain names', () => {
    // Repairs B1: a tool NAME is the operation id with dots replaced by underscores (the MCP name
    // grammar); the dotted operation id rides `_meta`. Both spellings are checked for the old
    // domains so neither form can carry them back.
    const ids = defaultTools().map((tool) => tool.name);
    const stale = ids.filter((id) =>
      ['totalfinance.vol.', 'totalfinance.ta.', 'totalfinance_vol_', 'totalfinance_ta_'].some(
        (prefix) => id.startsWith(prefix),
      ),
    );
    expect(stale, `MCP tool ids still on the removed domains:\n${stale.join('\n')}`).toEqual([]);
    expect(ids.some((id) => id.startsWith('totalfinance_volatility_'))).toBe(true);
    expect(ids.some((id) => id.startsWith('totalfinance_technical_analysis_'))).toBe(true);
  });

  it('MCP pack factories use the full domain names and no old alias', () => {
    const exported = mcp as unknown as Record<string, unknown>;
    // Removed names are built by concatenation so a repo-wide sweep cannot rewrite the very
    // identifiers this test exists to prove are GONE.
    expect(exported['vol' + 'Pack']).toBeUndefined();
    expect(exported['ta' + 'Pack']).toBeUndefined();
    expect(typeof exported['volatilityPack']).toBe('function');
    expect(typeof exported['technicalAnalysisPack']).toBe('function');
  });

  it('every 3B.N1 compile-fail fixture is covered by an assertion in this file', () => {
    const landed = COMPILE_FAIL_FIXTURES.filter((fixture) => fixture.landsIn === '3B.N1');
    // The eight N1 records: two packages, two umbrella subpaths, two umbrella namespaces, two MCP
    // domains — each asserted above. This guards against a fixture being marked N1 without evidence.
    expect(landed.map((fixture) => fixture.id).sort()).toEqual([...COVERED_N1].sort());
  });
});

/** The N1 fixtures asserted in the block above. */
const COVERED_N1 = [
  'naming/mcp/ta-tools',
  'naming/mcp/vol-tools',
  'naming/package/ta',
  'naming/package/vol',
  'naming/subpath/totalfinance-ta',
  'naming/subpath/totalfinance-vol',
  'naming/umbrella/ta',
  'naming/umbrella/vol',
] as const;

/** The N2 fixtures asserted below. */
const COVERED_N2 = [
  'naming/core/market-rate',
  'naming/core/bar-ts',
  'naming/core/quote-implied-vol',
] as const;

describe('3B.N2 — removed core market-data field names', () => {
  // All three are interface MEMBERS, erased at runtime, so the committed naming baseline is the
  // witness. Each retired name was also ambiguous in a way worth restating: `ts` did not say its
  // unit, `impliedVol` truncated the quantity, and a bare `rate` did not say WHICH rate.
  it('Bar carries an explicit millisecond timestamp, not `ts`', () => {
    expectFieldRenamed('@totalfinance/core', 'Bar', 't' + 's', 'timestampMs');
  });

  it('OptionQuote spells out implied volatility', () => {
    expectFieldRenamed('@totalfinance/core', 'OptionQuote', 'implied' + 'Vol', 'impliedVolatility');
  });

  it('MarketInputs names WHICH rate', () => {
    expectFieldRenamed('@totalfinance/core', 'MarketInputs', 'rate', 'riskFreeRate');
  });
});

/** The N4 fixtures asserted below. */
const COVERED_N4 = [
  'naming/flagship/bs',
  'naming/flagship/bsm-price',
  'naming/flagship/bsm-implied-vol',
  'naming/field/vol',
  'naming/field/t',
  'naming/field/rate',
] as const;

describe('3B.N4 — removed flagship pricing names and their bare input fields', () => {
  const exported = options as unknown as Record<string, unknown>;
  // The canonical kernels live on the `./black-scholes` subpath (the root entrypoint carries the
  // `blackScholes` facade), so BOTH surfaces are checked — a reappearing abbreviation on either one
  // is the same regression, and checking only the root would have proved nothing about the kernels.
  const kernels = blackScholesKernels as unknown as Record<string, unknown>;

  it('no abbreviated flagship entry point survives on either entrypoint', () => {
    for (const surface of [exported, kernels]) {
      expect(surface['b' + 's']).toBeUndefined();
      expect(surface['bsm' + 'Price']).toBeUndefined();
      expect(surface['bsm' + 'ImpliedVol']).toBeUndefined();
    }
    // …and the canonical replacements are real, so this is a rename and not a deletion.
    expect(typeof exported['blackScholes']).toBe('object');
    expect(typeof kernels['blackScholesPrice']).toBe('function');
    expect(typeof kernels['blackScholesImpliedVolatility']).toBe('function');
  });

  // The canonical call, kept beside the rejections so the three below are provably about the ONE
  // field each changes rather than about a generally malformed input.
  const canonical = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.2,
    type: 'call',
  } as const;

  it('the canonical spelling prices', () => {
    expect(options.blackScholes.price(canonical)).toBeGreaterThan(0);
  });

  /** `canonical` with one field renamed back to its retired spelling. */
  function withRetired(retired: string, replaces: keyof typeof canonical): Record<string, unknown> {
    const input: Record<string, unknown> = { ...canonical };
    delete input[replaces];
    input[retired] = canonical[replaces];
    return input;
  }

  it.each([
    ['v' + 'ol', 'volatility'],
    ['t', 'timeToExpiryYears'],
    ['rate', 'riskFreeRate'],
  ] as const)('a retired bare `%s` is rejected, not silently ignored', (retired, replaces) => {
    expect(
      codeOfThrow(() =>
        options.blackScholes.price(
          withRetired(retired, replaces) as unknown as Parameters<
            typeof options.blackScholes.price
          >[0],
        ),
      ),
    ).toBe(UNKNOWN_FIELD);
  });
});

/** The N7 fixtures asserted below. */
const COVERED_N7 = [
  'naming/ta/vol-cutoff',
  'naming/ta/snapshot-v',
  'naming/ta/snapshot-type',
  'naming/ta/snapshot-flat-state',
] as const;

describe('3B.N7 — removed TA parameter and the pre-envelope snapshot shape', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100 + i * 0.1,
    volume: 1_000 + i,
  }));

  it('vfi rejects the retired volume cutoff spelling', () => {
    // `volCutoff` read as a VOLATILITY cutoff; the parameter has always been about volume.
    expect(
      codeOfThrow(() =>
        ta.vfi(bars, { period: 10, ['vol' + 'Cutoff']: 2.5 } as unknown as Parameters<
          typeof ta.vfi
        >[1]),
      ),
    ).toBe(UNKNOWN_FIELD);
    expect(ta.vfi(bars, { period: 10, volumeCutoff: 2.5 }).length).toBe(bars.length);
  });

  it('the snapshot type is named for its package, and the old name is gone', () => {
    expect(
      baselineIds.has('@totalfinance/technical-analysis|export|TechnicalAnalysisSnapshot'),
    ).toBe(true);
    expect(baselineIds.has('@totalfinance/technical-analysis|export|' + 'Snap' + 'shot')).toBe(
      false,
    );
    expect(baselineIds.has('totalfinance|export|' + 'Snap' + 'shot')).toBe(false);
  });

  it('a snapshot carries `schemaVersion`, never a bare `v`', () => {
    const snapshot = ta.rsi.stream({ period: 14 }).toJSON();
    expect(Object.keys(snapshot).sort()).toEqual(['kind', 'schemaVersion', 'state']);
    expect(snapshot.schemaVersion).toBe(ta.SCHEMA_VERSION);
    expect(
      baselineIds.has('@totalfinance/technical-analysis|field|TechnicalAnalysisSnapshot.v'),
    ).toBe(false);
    expect(
      baselineIds.has(
        '@totalfinance/technical-analysis|field|TechnicalAnalysisSnapshot.schemaVersion',
      ),
    ).toBe(true);
  });

  it('the flat pre-envelope snapshot is rejected, not restored with undefined state', () => {
    const stream = ta.ema.stream({ period: 10 });
    for (const bar of bars) stream.next(bar.close);
    // The v1 shape: indicator state at the SAME level as the envelope's own fields.
    const flat = { kind: 'ema', ['v']: 1, ...stream.toJSON().state };
    expect(
      codeOfThrow(() => ta.ema.fromJSON(flat as unknown as Parameters<typeof ta.ema.fromJSON>[0])),
    ).not.toBe('(did not throw)');
  });
});

/** The N8 fixtures asserted below. */
const COVERED_N8 = [
  'naming/risk/spot-volatility',
  'naming/risk/pnl-volatility',
  'naming/core/fd-bumps',
  'naming/volatility/spot-beta-fn',
  'naming/volatility/spot-beta-field',
  'naming/volatility/min-variance-delta',
  'naming/volatility/probability-itm',
  'naming/mcp/probability-itm',
  'naming/volatility/de-earned',
  'naming/options/basket-price-approximation',
  'naming/options/fair-volatility-approximation',
  'naming/options/simulation-options',
  'naming/options/monte-carlo-options',
  'naming/ta/gap-min-percent',
  // RV7 — forms a trailing digit (or an unlisted short token) had hidden from the denylist.
  'naming/options/iv-bracket-lower',
  'naming/options/iv-bracket-upper',
  'naming/options/spread-volatility-1',
  'naming/options/spread-volatility-2',
  'naming/volatility/skew-wing-iv',
  'naming/volatility/skew-risk-reversal',
  'naming/volatility/skew-butterfly',
  'naming/ta/candle-body-high',
  'naming/ta/candle-body-low',
  'naming/ta/bollinger-period',
  'naming/ta/keltner-period',
  'naming/ta/keltner-multiplier',
  'naming/ta/band-multipliers',
] as const;

describe('3B.N8 — names that were spelled out and still said the wrong thing', () => {
  // Unlike N1–N7 these are mostly NOT abbreviations. Each one passed every mechanical gate and had
  // to be caught by reading, which is the argument the phase exists to make.

  /**
   * RV7 — the four forms a DIGIT was hiding.
   *
   * These are abbreviations, which N1–N7 were supposed to have taken. They survived because the
   * tokenizer kept trailing digits attached to their letter run, so `vol1` never presented `vol` to
   * a denylist that has forbidden it since N0. `lo`/`hi` were simply never listed at all. The
   * inventory called every one of them `explicit`, which is why the closeout could report an empty
   * queue while they sat in the public surface.
   */
  it('an implied-vol bracket names its bound in full', () => {
    expectFieldRenamed(
      '@totalfinance/options',
      'BlackScholesImpliedVolatilityOptions',
      'lo' + 'Volatility',
      'lowerVolatilityBound',
    );
    expectFieldRenamed(
      '@totalfinance/options',
      'BlackScholesImpliedVolatilityOptions',
      'hi' + 'Volatility',
      'upperVolatilityBound',
    );
  });

  it('a skew surface spells its desk vocabulary', () => {
    // `rr`/`bf`/`iv` are options-desk initialisms. Fluent on a trading floor, opaque in a library a
    // general caller imports — and the digits hid all three from the denylist.
    expectFieldRenamed(
      '@totalfinance/volatility',
      'SkewMetrics',
      'iv' + '25Put',
      'put25DeltaImpliedVolatility',
    );
    expectFieldRenamed(
      '@totalfinance/volatility',
      'SkewMetrics',
      'rr' + '25',
      'riskReversal25Delta',
    );
    expectFieldRenamed('@totalfinance/volatility', 'SkewMetrics', 'bf' + '25', 'butterfly25Delta');
  });

  it('a candle body names its high and low', () => {
    // `GannHiLo` keeps `hi`/`lo` by EXACT allowlist — it is the published indicator name. These two
    // had no such claim, and a blanket exemption would have carried them along with it.
    expectMethodRenamed(
      '@totalfinance/technical-analysis',
      'CandleView',
      'hi' + 'Body',
      'bodyHigh',
    );
    expectMethodRenamed('@totalfinance/technical-analysis', 'CandleView', 'lo' + 'Body', 'bodyLow');
  });

  it('indicator parameters spell their band and channel', () => {
    // These sat in the registry beside `bollingerStandardDeviations`, already spelled out — so the
    // inconsistency was visible in a single line of the same object literal for the whole of 3B.N.
    //
    // `bb` and `mult` themselves stay, as NAME entries: `bb` is the TA-Lib spelling exported beside
    // `stoch`/`willr`, and `mult` is TA-Lib's `MULT` operator, not a truncation of "multiplier". A
    // TOKEN entry for either would have exempted every compound containing it.
    expectParameterRenamed(
      '@totalfinance/technical-analysis',
      'SqueezeParameters',
      'bb' + 'Period',
      'bollingerBandPeriod',
    );
    expectParameterRenamed(
      '@totalfinance/technical-analysis',
      'SqueezeParameters',
      'kc' + 'Period',
      'keltnerChannelPeriod',
    );
    expectParameterRenamed(
      '@totalfinance/technical-analysis',
      'SqueezeParameters',
      'kc' + 'Mult',
      'keltnerChannelMultiplier',
    );
  });

  it('a two-asset spread names both volatilities in full', () => {
    // The source carried the retired rule that justified them — "flat inputs use `vol`" — in a
    // docstring, long after the rule itself was gone.
    expectFieldRenamed('@totalfinance/options', 'SpreadInput', 'vol' + '1', 'volatility1');
    expectFieldRenamed('@totalfinance/options', 'SpreadInput', 'vol' + '2', 'volatility2');
  });

  it('a spot-return volatility says `return`', () => {
    // The docstring had to shout "spot RETURN volatility" to disambiguate the field name.
    expectFieldRenamed(
      '@totalfinance/risk',
      'UnderlyingRiskFactor',
      'spot' + 'Volatility',
      'spotReturnVolatility',
    );
  });

  it('a P&L stdev is not called a volatility', () => {
    // Currency-denominated, over a horizon — and its sibling is `pnlMean`, so `pnlStandardDeviation`
    // is the pair. "Volatility" would imply an annualized return quantity.
    expectFieldRenamed(
      '@totalfinance/risk',
      'BookVaRMethodResult',
      'pnl' + 'Volatility',
      'pnlStandardDeviation',
    );
  });

  it('the finite-difference bump record is spelled out on every Diagnostics', () => {
    for (const pkg of ['@totalfinance/core', '@totalfinance/backtest']) {
      expectFieldRenamed(pkg, 'Diagnostics', 'fd' + 'Bumps', 'finiteDifferenceBumps');
    }
  });

  it('the vol-spot beta has ONE name, and the estimator is a verb', () => {
    const exported = volatility as unknown as Record<string, unknown>;
    expect(typeof exported['estimateVolatilitySpotBeta']).toBe('function');
    expect(exported['volatilitySpot' + 'Beta']).toBeUndefined();
    // Law N5: the quantity was `betaVolatilitySpot` on two result types and `volatilitySpotBeta` on
    // two others. It is now one name, on all of them — including the hedge input it feeds.
    const retired = [...baselineIds].filter((id) => id.endsWith('.beta' + 'VolatilitySpot'));
    expect(retired, `the retired field spelling survives:\n${retired.join('\n')}`).toEqual([]);
    for (const owner of [
      'VolatilitySpotBeta',
      'MinimumVarianceDeltaOptions',
      'MinimumVarianceDeltaResult',
    ]) {
      expect(
        baselineIds.has(`@totalfinance/volatility|field|${owner}.volatilitySpotBeta`),
        `${owner} should carry the canonical quantity name`,
      ).toBe(true);
    }
    // RATIFIED DIVERGENCE (2026-08-02 defect-fix wave). `StickyRegime` is deliberately NOT on that
    // list, because it never held the same quantity: its field is ∂σ/∂ln(S) while the other three
    // are ∂σ/∂S. One name over two units is not what Law N5 asks for — N5 wants one name per
    // CONCEPT, and these are two concepts that differ by a factor of the spot. Chaining them was a
    // silent hedge error the receiving function could not detect: feeding the sticky-regime value
    // into `minimumVarianceDelta` returned a delta of −197 where the correct answer is 0.154, and
    // both are finite numbers, so nothing downstream could tell. The unit now lives in the name.
    expect(
      baselineIds.has('@totalfinance/volatility|field|StickyRegime.volatilitySpotBetaPerLogSpot'),
      'StickyRegime carries the per-log-spot name that states its unit',
    ).toBe(true);
    expect(
      baselineIds.has('@totalfinance/volatility|field|StickyRegime.volatilitySpotBeta'),
      'the unit-ambiguous spelling must not come back on StickyRegime',
    ).toBe(false);
  });

  it('in-the-money is spelled out on the export and on its MCP tool', () => {
    const exported = volatility as unknown as Record<string, unknown>;
    expect(typeof exported['probabilityInTheMoney']).toBe('function');
    expect(exported['probability' + 'Itm']).toBeUndefined();
    const ids = defaultTools().map((tool) => tool.name);
    expect(ids).toContain('totalfinance_volatility_probability_in_the_money');
    expect(ids).not.toContain('totalfinance_volatility_probability_' + 'itm');
  });

  it('the event-stripped volatility says what it strips', () => {
    // "de-earned" is desk jargon, and the function strips a GENERIC event jump — which is what its
    // own docstring says it does.
    const exported = volatility as unknown as Record<string, unknown>;
    expect(typeof exported['eventStrippedVolatility']).toBe('function');
    expect(exported['deEarned' + 'Volatility']).toBeUndefined();
  });

  it('the approximation methods read as verbs', () => {
    const basket = (options as unknown as Record<string, Record<string, unknown>>)['basket']!;
    expect(typeof basket['approximatePrice']).toBe('function');
    expect(basket['price' + 'Approximation']).toBeUndefined();
    const volatilitySwap = (options as unknown as Record<string, Record<string, unknown>>)[
      'volatilitySwap'
    ]!;
    expect(typeof volatilitySwap['approximateFairVolatility']).toBe('function');
    expect(volatilitySwap['fairVolatility' + 'Approximation']).toBeUndefined();
  });

  it('the gap filter and the reported gap size share ONE unit', () => {
    const bars = [
      { high: 100, low: 99, close: 99.5, volume: 1_000 },
      { open: 102, high: 103, low: 101.5, close: 102.5, volume: 1_200 },
    ];
    // The retired spelling THROWS. Silently ignoring it would filter 100x wrong: a caller who wrote
    // `minPercent: 0.5` meaning "half a percent" would instead see only gaps above 50%.
    expect(
      codeOfThrow(() =>
        ta.gaps(bars, { ['minPer' + 'cent']: 0.5 } as unknown as Parameters<typeof ta.gaps>[1]),
      ),
    ).toBe(UNKNOWN_FIELD);
    const report = ta.gaps(bars, { minSizeFraction: 0.005 });
    expect(report.assumptions.minSizeFraction).toBe(0.005);
    // Same unit on the way out: a ~2.5% gap reads 0.025, not 2.5.
    expect(report.gaps[0]?.sizeFraction).toBeCloseTo((102 - 99.5) / 99.5, 9);
    expect(baselineIds.has('@totalfinance/technical-analysis|field|Gap.si' + 'ze')).toBe(false);
    expect(baselineIds.has('@totalfinance/technical-analysis|field|Gap.sizeFraction')).toBe(true);
  });

  it('the Monte-Carlo option types say which simulation, and no longer collide across packages', () => {
    expect(baselineIds.has('@totalfinance/options|export|MonteCarloSamplingOptions')).toBe(true);
    expect(baselineIds.has('@totalfinance/options|export|MonteCarloPriceOptions')).toBe(true);
    expect(baselineIds.has('@totalfinance/options|export|' + 'Simulation' + 'Options')).toBe(false);
    expect(baselineIds.has('@totalfinance/options|export|' + 'MonteCarlo' + 'Options')).toBe(false);
    // @totalfinance/math keeps the generic estimator's name — the collision is GONE, not relocated, so
    // the umbrella re-exports exactly one `MonteCarloOptions`.
    expect(baselineIds.has('@totalfinance/math|export|MonteCarloOptions')).toBe(true);
    const umbrellaCollisions = [...baselineIds].filter((id) =>
      id.startsWith('totalfinance|export|MonteCarlo'),
    );
    expect(umbrellaCollisions).toContain('totalfinance|export|MonteCarloOptions');
  });
});

/** The N9 fixtures asserted below. */
const COVERED_N9 = [
  'naming/structure/gex-call-oi',
  'naming/structure/gex-put-oi',
  'naming/structure/levels-largest-call-oi',
  'naming/structure/levels-largest-put-oi',
  'naming/structure/flow-volume-oi-ratio',
  'naming/structure/rank-min-volume-oi-ratio',
  'naming/volatility/vrp-term-structure-fn',
  'naming/volatility/vrp-term-structure-options',
  'naming/volatility/vrp-term-structure-result',
  'naming/volatility/vrp-point',
  'naming/volatility/vrp-point-field',
  'naming/volatility/vrp-index-field',
  'naming/volatility/vrp-engine-string',
  'naming/fixed-income/zcb-option',
  'naming/fixed-income/zcb-option-error-text',
  'naming/math/ledoit-wolf-target',
  'naming/risk/average-daily-volume',
  'naming/risk/average-daily-volume-multiple',
  'naming/ta/ma-export',
  'naming/ta/ma-registry-name',
  'naming/ta/ma-name-type',
  'naming/ta/ma-parameters-type',
  'naming/ta/ma-type-type',
  'naming/ta/ma-names-const',
  'naming/ta/ma-types-const',
  'naming/ta/ma-ribbon',
  'naming/ta/ma-ribbon-parameters',
  'naming/ta/ma-ribbon-stream',
  'naming/ta/rainbow-ma',
  'naming/ta/rainbow-ma-stream',
  'naming/ta/weighted-ma-stream',
  'naming/ta/holt-winter-ma',
  'naming/ta/ma-type-parameter',
  'naming/ta/macd-ext-ma-types',
  'naming/ta/macd-ext-signal-ma',
  'naming/ta/qqe-rsi-ma',
  'naming/ta/elder-thermometer-ma',
  'naming/ta/agg-stream',
  'naming/math/mat-mul',
  'naming/math/mat-vec',
  'naming/math/lu-pivot-indices',
  'naming/options/dupire-log-moneyness-step',
  'naming/volatility/implied-volatilities',
  'naming/ta/brar-fields',
  'naming/ta/cpr-central-pivots',
  'naming/ta/term-operator',
] as const;

describe('3B.N9 — the short tokens that were never on the denylist', () => {
  /**
   * `oi` is two characters, so before the short-token sweep it presented nothing a denylist
   * recognized and the inventory called every `callOi`/`putOi`/`volumeOiRatio` `explicit` —
   * unrecognized, reported as reviewed. That is the whole reason this queue reopened.
   */

  it('the GEX call/put split and the OI walls spell out open interest', () => {
    for (const [retired, canonical] of [
      ['call' + 'Oi', 'callOpenInterest'],
      ['put' + 'Oi', 'putOpenInterest'],
    ] as const) {
      expectFieldRenamed('@totalfinance/structure', 'GexSplit', retired, canonical);
    }
    for (const [retired, canonical] of [
      ['largestCall' + 'Oi', 'largestCallOpenInterest'],
      ['largestPut' + 'Oi', 'largestPutOpenInterest'],
    ] as const) {
      expectFieldRenamed('@totalfinance/structure', 'Levels', retired, canonical);
    }
  });

  it('the volume/OI ratio is renamed as a FIELD and as the serialized rank VALUE', () => {
    expectFieldRenamed(
      '@totalfinance/structure',
      'FlowGroup',
      'volume' + 'OiRatio',
      'volumeOpenInterestRatio',
    );
    // The half the naming inventory cannot see. `RankByKey` is a string union whose members must be
    // keys of `FlowGroup` (`rank` sorts with `b[by]`), so the retired spelling was also a VALUE the
    // caller passes. The inventory walks declared identifiers, not string-union members, so only an
    // executable assertion can testify that the value moved too.
    const ranked = flow([
      {
        contract: {
          underlying: 'SPY',
          type: 'call',
          style: 'european',
          strike: 500,
          expiry: '2026-03-20',
          multiplier: 100,
          ...resolvedExpiry('2026-03-20'),
        },
        timestampMs: Date.UTC(2026, 2, 18, 14),
        price: 1,
        size: 10,
        openInterest: 5,
      },
    ]);
    const groups = ranked.groupBy(['underlying', 'expiry', 'strike', 'type']);
    expect(groups[0]!.volumeOpenInterestRatio).toBeCloseTo(10 / 5, 9);
    expect((groups[0] as unknown as Record<string, unknown>)['volume' + 'OiRatio']).toBeUndefined();
    // The canonical value is accepted...
    expect(() => ranked.rank(groups, { by: 'volumeOpenInterestRatio' })).not.toThrow();
    // ...and the retired one is rejected as an unknown enum member, not silently sorted by premium.
    expect(
      codeOfThrow(() =>
        ranked.rank(groups, { by: ('volume' + 'OiRatio') as 'volumeOpenInterestRatio' }),
      ),
    ).toBe('input.invalid_enum');
  });

  it('the retired rank threshold THROWS rather than being silently ignored', () => {
    // Law 12 landed on `rank` in the same commit as the rename. Without it the retired spelling was
    // read off no property at all: the filter would simply not apply and the caller would receive a
    // longer list than they asked for, with no signal. A renamed knob that is merely ignored is the
    // exact failure this phase exists to prevent.
    const analysis = flow([
      {
        contract: {
          underlying: 'SPY',
          type: 'call',
          style: 'european',
          strike: 500,
          expiry: '2026-03-20',
          multiplier: 100,
          ...resolvedExpiry('2026-03-20'),
        },
        timestampMs: Date.UTC(2026, 2, 18, 14),
        price: 1,
        size: 10,
      },
    ]);
    expect(
      codeOfThrow(() =>
        analysis.rank([], { ['minVolume' + 'OiRatio']: 0.5 } as unknown as { limit?: number }),
      ),
    ).toBe(UNKNOWN_FIELD);
    expect(() => analysis.rank([], { minVolumeOpenInterestRatio: 0.5 })).not.toThrow();
    expectFieldRenamed(
      '@totalfinance/structure',
      'RankOptions',
      'minVolume' + 'OiRatio',
      'minVolumeOpenInterestRatio',
    );
  });

  it('the variance risk premium has ONE spelling in the package that exports it', () => {
    // Law N5: `varianceRiskPremium` (event.ts) and `vrp` (variance-index.ts) were the same quantity
    // under two names in one package. The initialism is the one that goes.
    for (const [retired, canonical] of [
      ['v' + 'rpTermStructure', 'varianceRiskPremiumTermStructure'],
      ['V' + 'rpTermStructureOptions', 'VarianceRiskPremiumTermStructureOptions'],
      ['V' + 'rpTermStructureResult', 'VarianceRiskPremiumTermStructureResult'],
      ['V' + 'rpPoint', 'VarianceRiskPremiumPoint'],
    ] as const) {
      for (const pkg of ['@totalfinance/volatility', 'totalfinance']) {
        expect(
          baselineIds.has(`${pkg}|export|${canonical}`),
          `${pkg} should export ${canonical} — run \`pnpm naming:update\``,
        ).toBe(true);
        expect(
          baselineIds.has(`${pkg}|export|${retired}`),
          `${pkg} still exports ${retired}; law N9 forbids the compatibility alias`,
        ).toBe(false);
      }
    }
    expectFieldRenamed(
      '@totalfinance/volatility',
      'VarianceRiskPremiumPoint',
      'v' + 'rp',
      'varianceRiskPremium',
    );
    expectFieldRenamed(
      '@totalfinance/volatility',
      'VarianceRiskPremiumTermStructureResult',
      'indexV' + 'rp',
      'indexVarianceRiskPremium',
    );
    // The exported FUNCTION of the same name is untouched — the rename spells the initialism out to
    // meet it, it does not move it.
    expect(baselineIds.has('@totalfinance/volatility|export|varianceRiskPremium')).toBe(true);
  });

  it('the diagnostics engine string moved with the function that emits it', () => {
    // No gate can see this one. `Diagnostics.engine` is a free-form string, so neither the compiler
    // nor the naming inventory ties it to the function name — but a caller reads it off every
    // result. An executable assertion is the only thing that can testify.
    //
    // The arguments come from the first-touch fixture rather than being written here, because that
    // one is maintained against the real signature: a hand-built input drifts silently into
    // "unknown field" and then the assertion below is only proving that the call threw.
    const build = ANALYSIS_VOL_FIXTURES['volatility.varianceRiskPremiumTermStructure'];
    expect(build, 'the first-touch fixture key must move with the rename — see below').toBeTruthy();
    const [args] = build!() as [Parameters<typeof volatility.varianceRiskPremiumTermStructure>[0]];
    const result = volatility.varianceRiskPremiumTermStructure(args);
    expect(result.diagnostics.engine).toBe('variance-risk-premium-term-structure');
    expect(result.diagnostics.engine).not.toContain('v' + 'rp-');
  });

  it('the zero-coupon bond option spells out the noun its own input type already spells', () => {
    for (const model of ['GaussianShortRateModel', 'HullWhiteModel', 'G2ppModel']) {
      expectMethodRenamed(
        '@totalfinance/fixed-income',
        model,
        'z' + 'cbOption',
        'zeroCouponBondOption',
      );
    }
  });

  it('the guard names fields the caller can actually write', () => {
    // The message said "requires tBond > tOption" and echoed `context: { tOption, tBond }`, but
    // those are LOCAL destructuring aliases — the public fields are `optionMaturity` and
    // `bondMaturity`. An error that names two fields the input type does not declare cannot be
    // acted on, and every gate passed it: `public-text-naming` flags denylisted TOKENS, and `t` is
    // allowlisted notation.
    // The fixture now passes the DECLARED field (`b`): vasicek closes its parameters, so the
    // old `theta` alias (cast through unknown) is rejected at construction — which is the guard
    // working, not the subject of this test (the zcb-option message below is).
    const model = fixedIncome.vasicek({ a: 0.1, b: 0.03, sigma: 0.01, r0: 0.03 });
    let caught: { message?: string; context?: Record<string, unknown> } = {};
    try {
      model.zeroCouponBondOption({
        optionMaturity: 5,
        bondMaturity: 1,
        strike: 0.8,
        right: 'call',
      });
    } catch (error) {
      caught = error as { message?: string; context?: Record<string, unknown> };
    }
    expect(caught.message, 'the guard must fire').toBeTruthy();
    expect(caught.message).toContain('bondMaturity');
    expect(caught.message).toContain('optionMaturity');
    expect(caught.message).not.toContain('t' + 'Bond');
    expect(caught.message).not.toContain('t' + 'Option');
    expect(Object.keys(caught.context ?? {}).sort()).toEqual(['bondMaturity', 'optionMaturity']);
  });

  it('the Ledoit-Wolf shrinkage target names its authors', () => {
    // ONE declaration, FOUR identities: @totalfinance/risk re-exports the options type as an alias
    // (`export type CovarianceOptions = EstimateCovarianceOptions`), so the field appears under both
    // packages and both type names. Asserting one of the four would leave three unproven.
    expectFieldRenamed(
      '@totalfinance/math',
      'EstimateCovarianceOptions',
      'l' + 'wTarget',
      'ledoitWolfTarget',
    );
    expectFieldRenamed(
      '@totalfinance/risk',
      'CovarianceOptions',
      'l' + 'wTarget',
      'ledoitWolfTarget',
    );
    const survivors = [...baselineIds].filter((id) => id.endsWith('.l' + 'wTarget'));
    expect(survivors, `the retired spelling survives:\n${survivors.join('\n')}`).toEqual([]);
    // The runtime key list that Law 12 checks is a STRING, invisible to the compiler: if it were left
    // behind, `covariance(..., { ledoitWolfTarget })` would throw on the CANONICAL name.
    expect(
      codeOfThrow(() =>
        risk.covariance(
          {
            returns: [
              [0.01, 0.02],
              [-0.005, 0.011],
              [0.007, -0.003],
              [0.002, 0.004],
            ],
          },
          { ledoitWolfTarget: 'identity' },
        ),
      ),
    ).not.toBe(UNKNOWN_FIELD);
  });

  it('average daily volume is spelled out on the field, not only in the error payload', () => {
    for (const owner of ['LiquidityPosition', 'MarketImpactInput']) {
      expectFieldRenamed('@totalfinance/risk', owner, 'ad' + 'v', 'averageDailyVolume');
    }
    expectFieldRenamed(
      '@totalfinance/risk',
      'LiquidityResult.perAsset',
      'ad' + 'vMultiple',
      'averageDailyVolumeMultiple',
    );
    // `MARKET_IMPACT_INPUT_KEYS` is a string array the compiler cannot see. Left behind, the
    // canonical spelling would be rejected as an unknown field — the rename failing CLOSED instead
    // of silently, but failing all the same.
    expect(
      codeOfThrow(() =>
        risk.marketImpact({ size: 10_000, averageDailyVolume: 1_000_000, volatility: 0.2 }),
      ),
    ).toBe('(did not throw)');
    expect(
      codeOfThrow(() =>
        risk.marketImpact({
          size: 10_000,
          ['ad' + 'v']: 1_000_000,
          volatility: 0.2,
        } as unknown as Parameters<typeof risk.marketImpact>[0]),
      ),
    ).toBe(UNKNOWN_FIELD);
  });

  it('every moving-average export and type is spelled out, in both packages', () => {
    for (const [retired, canonical] of [
      ['m' + 'a', 'movingAverage'],
      ['M' + 'aName', 'MovingAverageName'],
      ['M' + 'aParameters', 'MovingAverageParameters'],
      ['M' + 'aType', 'MovingAverageType'],
      ['m' + 'aRibbon', 'movingAverageRibbon'],
      ['M' + 'aRibbonParameters', 'MovingAverageRibbonParameters'],
      ['rainbowM' + 'a', 'rainbowMovingAverage'],
      ['holtWinterM' + 'a', 'holtWinterMovingAverage'],
    ] as const) {
      for (const pkg of ['@totalfinance/technical-analysis', 'totalfinance']) {
        expect(
          baselineIds.has(`${pkg}|export|${canonical}`),
          `${pkg} should export ${canonical} — run \`pnpm naming:update\``,
        ).toBe(true);
        expect(
          baselineIds.has(`${pkg}|export|${retired}`),
          `${pkg} still exports ${retired}; law N9 forbids the compatibility alias`,
        ).toBe(false);
      }
    }
    // Package-only exports (not re-exported by the umbrella at the time of writing).
    for (const [retired, canonical] of [
      ['MA' + '_NAMES', 'MOVING_AVERAGE_NAMES'],
      ['MA' + '_TYPES', 'MOVING_AVERAGE_TYPES'],
      ['M' + 'aRibbonStream', 'MovingAverageRibbonStream'],
      ['RainbowM' + 'aStream', 'RainbowMovingAverageStream'],
      ['WeightedM' + 'aStream', 'WeightedMovingAverageStream'],
      ['Ag' + 'gStream', 'AggregateStream'],
    ] as const) {
      expect(
        baselineIds.has(`@totalfinance/technical-analysis|export|${canonical}`),
        `${canonical} is missing from the naming baseline`,
      ).toBe(true);
      expect(
        baselineIds.has(`@totalfinance/technical-analysis|export|${retired}`),
        `${retired} is back in the public surface`,
      ).toBe(false);
    }
  });

  it('the REGISTRY NAME moved with the export — one concept, one public spelling', () => {
    // The registry key is DATA a caller passes: getIndicator(name), describeIndicator(name), and the
    // MCP `technical_analysis.calculate` indicator enum. Leaving it as `ma` while the export became
    // `movingAverage` would have reintroduced the two-spellings-for-one-concept defect the rename
    // exists to remove — and no type would have objected, because the key is a string.
    expect(
      ta.getIndicator('movingAverage'),
      'the canonical registry name must resolve',
    ).toBeTruthy();
    expect(
      ta.getIndicator('m' + 'a'),
      'the retired registry name must NOT resolve',
    ).toBeUndefined();
    expect(ta.listIndicators().map((i) => i.name)).toContain('movingAverage');
    expect(ta.listIndicators().map((i) => i.name)).not.toContain('m' + 'a');
  });

  it('the renamed parameter is accepted and the retired one is REJECTED at runtime', () => {
    // registry.ts `parameters` arrays feed ensureKnownKeys, and warmup.ts CANONICAL must carry the
    // same key or `indicatorWarmups` throws. Three separate string surfaces, none of them visible to
    // the compiler; if any is missed the canonical spelling stops working.
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3));
    expect(
      codeOfThrow(() => ta.movingAverage(closes, { period: 5, movingAverageType: 'ema' })),
    ).toBe('(did not throw)');
    expect(
      codeOfThrow(() =>
        ta.movingAverage(closes, {
          period: 5,
          ['m' + 'aType']: 'ema',
        } as unknown as Parameters<typeof ta.movingAverage>[1]),
      ),
    ).toBe(UNKNOWN_FIELD);
  });

  it('the moving-average parameter and output fields moved on every owner', () => {
    for (const owner of ['MovingAverageParameters', 'MavpParameters', 'AmatParameters']) {
      expectParameterRenamed(
        '@totalfinance/technical-analysis',
        owner,
        'm' + 'aType',
        'movingAverageType',
      );
    }
    for (const [retired, canonical] of [
      ['fastM' + 'aType', 'fastMovingAverageType'],
      ['slowM' + 'aType', 'slowMovingAverageType'],
      ['signalM' + 'aType', 'signalMovingAverageType'],
    ] as const) {
      expectFieldRenamed(
        '@totalfinance/technical-analysis',
        'MacdExtParameters',
        retired,
        canonical,
      );
    }
    expectFieldRenamed(
      '@totalfinance/technical-analysis',
      'QqePoint',
      'rsiM' + 'a',
      'rsiMovingAverage',
    );
    expectFieldRenamed(
      '@totalfinance/technical-analysis',
      'ElderThermometerPoint',
      'm' + 'a',
      'movingAverage',
    );
  });

  it('the snapshot envelope kind moved, and the opaque interior deliberately did not', () => {
    // `kind` is the indicator's public name by contract (`snapshotOf` requires it), so it moves.
    // The `state` INTERIOR is declared opaque in OPAQUE_STATE_ENVELOPES — consumers round-trip it
    // without branching on keys — so its keys stay, and a round-trip proves the two halves agree.
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3));
    const stream = ta.movingAverageRibbon.stream({ periods: [3, 5] });
    for (const c of closes) stream.next(c);
    const snapshot = stream.toJSON();
    expect(snapshot.kind).toBe('movingAverageRibbon');
    expect(snapshot.kind).not.toBe('m' + 'aRibbon');
    // Restoring through the renamed reader proves writer and reader still agree on the interior.
    const restored = ta.movingAverageRibbon.fromJSON(snapshot);
    expect(restored.toJSON()).toEqual(snapshot);
  });

  it('the last bare tokens are spelled out on math, volatility and TA surfaces', () => {
    for (const [retired, canonical] of [
      ['matM' + 'ul', 'matrixMultiply'],
      ['matV' + 'ec', 'matrixVectorProduct'],
    ] as const) {
      expect(baselineIds.has(`@totalfinance/math|export|${canonical}`)).toBe(true);
      expect(baselineIds.has(`@totalfinance/math|export|${retired}`)).toBe(false);
    }
    expectFieldRenamed('@totalfinance/math', 'LuResult', 'p' + 'iv', 'pivotIndices');
    for (const pkg of ['@totalfinance/options', '@totalfinance/volatility']) {
      expectFieldRenamed(pkg, 'DupireOptions', 'd' + 'k', 'logMoneynessStep');
    }
    expectFieldRenamed(
      '@totalfinance/volatility',
      'SABRSmileInput',
      'i' + 'vs',
      'impliedVolatilities',
    );
    expectFieldRenamed(
      '@totalfinance/volatility',
      'SurfaceSlice',
      'i' + 'vs',
      'impliedVolatilities',
    );
    expectFieldRenamed('@totalfinance/technical-analysis', 'Term', 'o' + 'p', 'operator');
  });

  it('BRAR and CPR are spelled out as PAIRS — a pardon may not half-name a type', () => {
    // Each of these types had one field in the queue and its sibling pardoned by a token rule that
    // described a different quantity (`ar` as an ARMA order, `tc` as a filter time constant). Both
    // pardons covered nothing but the field they misdescribed, so both were deleted rather than
    // narrowed. Asserting the PAIR is what stops a future rename from half-naming a type again.
    for (const [retired, canonical] of [
      ['a' + 'r', 'popularityIndex'],
      ['b' + 'r', 'willingnessIndex'],
    ] as const) {
      expectFieldRenamed('@totalfinance/technical-analysis', 'BrarPoint', retired, canonical);
    }
    for (const [retired, canonical] of [
      ['t' + 'c', 'topCentral'],
      ['b' + 'c', 'bottomCentral'],
    ] as const) {
      expectFieldRenamed('@totalfinance/technical-analysis', 'CprPoint', retired, canonical);
    }
    // The rules that pardoned the siblings are gone, not merely unused.
    expect(Object.keys(CANONICAL_TOKENS)).not.toContain('a' + 'r');
    expect(Object.keys(CANONICAL_TOKENS)).not.toContain('t' + 'c');
  });

  it('the first-touch fixture key moved too — a stale key is skipped, not failed', () => {
    // `tools/first-touch/*` looks the key up and does `if (!callable) continue`, so a fixture left
    // under the retired name stops exercising the function and NOTHING goes red. A dead fixture that
    // reads like a live one is the same defect class as a dead policy rule; assert it directly.
    expect(Object.keys(ANALYSIS_VOL_FIXTURES)).toContain(
      'volatility.varianceRiskPremiumTermStructure',
    );
    expect(Object.keys(ANALYSIS_VOL_FIXTURES)).not.toContain('volatility.v' + 'rpTermStructure');
  });
});

/**
 * Stage 4.5 (2026-09-02): the Heston calibration's starting point was spelled `seed`, which names
 * RANDOMNESS everywhere else in the library (`fitGarch`, the Monte-Carlo pricers). Both spellings —
 * the calibrator option and the surface config knob that threads into it — are retired for
 * `initialParameters` / `hestonInitialParameters`. Evidence is runtime: both inputs are closed
 * requests, so the old key must throw `input.unknown_field` with the did-you-mean teaching.
 */
const COVERED_STAGE_4_5 = [
  'naming/volatility/heston-surface-start',
  'naming/volatility/surface-config-heston-start',
] as const;

describe('Stage 4.5 — the Heston starting point is `initialParameters`, never `seed`', () => {
  const targets = [
    { strike: 95, timeToExpiryYears: 0.5, impliedVolatility: 0.22, forward: 101 },
    { strike: 100, timeToExpiryYears: 0.5, impliedVolatility: 0.2, forward: 101 },
    { strike: 105, timeToExpiryYears: 0.5, impliedVolatility: 0.19, forward: 101 },
  ];
  const market = { spot: 100, riskFreeRate: 0.02, dividendYield: 0 };
  const start = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.3, rho: -0.5 };

  it('calibrateHestonSurface refuses `options.seed` and names initialParameters', () => {
    let message = '';
    expect(
      codeOfThrow(() => {
        try {
          volatility.calibrateHestonSurface({
            targets,
            market,
            options: { ['se' + 'ed']: start },
          } as unknown as Parameters<typeof volatility.calibrateHestonSurface>[0]);
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      }),
    ).toBe(UNKNOWN_FIELD);
    expect(message).toContain('initialParameters');
  });

  it('volatilitySurface refuses `config.hestonSeed` and names hestonInitialParameters', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const quotes = [95, 100, 105].map((strike) => ({
      contract: {
        underlying: 'X',
        type: 'call' as const,
        style: 'european' as const,
        strike,
        expiry: '2026-07-02',
        ...resolvedExpiry('2026-07-02'),
      },
      timestampMs: asOf,
      impliedVolatility: 0.2,
      underlyingPrice: 100,
    }));
    let message = '';
    expect(
      codeOfThrow(() => {
        try {
          volatility.volatilitySurface({
            quotes,
            market: { spot: 100, riskFreeRate: 0.02, asOf },
            config: { model: 'heston', ['heston' + 'Seed']: start },
          } as unknown as Parameters<typeof volatility.volatilitySurface>[0]);
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      }),
    ).toBe(UNKNOWN_FIELD);
    expect(message).toContain('hestonInitialParameters');
  });
});

/**
 * Pre-publish interface repairs B7 (2026-09-20): a chain row is core `OptionQuote`, whose optional
 * `greeks` carry what a vendor supplied or what `options.chainGreeks` stamped. Strategy's
 * `ChainQuote` (`OptionQuote & { delta? }`) and volatility's `ObservedSkewQuote` (the same alias
 * under another name) were two spellings of one row; both are retired. Evidence is the naming
 * baseline (neither export exists under either package or the umbrella) plus the runtime teaching:
 * the delta-selection guard now names the call that exists, `chainGreeks`.
 */
const COVERED_REPAIRS_B7 = [
  'naming/strategy/chain-quote-row',
  'naming/volatility/observed-skew-quote-row',
] as const;

describe('Repairs B7 — one chain row: core `OptionQuote`, never a per-package alias', () => {
  it('the aliases are gone from every entrypoint and the core row carries `greeks`', () => {
    expect(baselineIds.has('@totalfinance/core|export|OptionQuote')).toBe(true);
    expect(baselineIds.has('@totalfinance/core|field|OptionQuote.greeks')).toBe(true);
    expect(baselineIds.has('@totalfinance/core|export|OptionQuoteGreeks')).toBe(true);
    for (const retired of ['Chain' + 'Quote', 'ObservedSkew' + 'Quote']) {
      for (const pkg of ['@totalfinance/strategy', '@totalfinance/volatility', 'totalfinance']) {
        expect(
          baselineIds.has(`${pkg}|export|${retired}`),
          `${pkg} exports ${retired} again; a chain row is core OptionQuote`,
        ).toBe(false);
      }
    }
  });

  it('delta-based selection teaches `chainGreeks` when a row has no Greeks', () => {
    // Both types, no Greeks: the condor reaches its delta-targeted short put and must teach.
    const rows = (['put', 'call'] as const).flatMap((type) =>
      [85, 90, 95, 100, 105, 110, 115].map((strike) => ({
        contract: {
          underlying: 'X',
          type,
          style: 'american' as const,
          strike,
          expiry: '2026-07-02',
          ...resolvedExpiry('2026-07-02'),
        },
        timestampMs: Date.UTC(2026, 0, 1),
        bid: 4,
        ask: 6,
        impliedVolatility: 0.3,
        underlyingPrice: 100,
      })),
    );
    let message = '';
    try {
      strategy.strategyFromChain(rows, {
        type: 'ironCondor',
        expiry: '2026-07-02',
        shortDelta: 0.3,
        wingWidth: 5,
        price: 'mid',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('chainGreeks({ quotes, market })');
    expect(message).not.toContain('.greeks()');
  });
});

/**
 * Pre-publish interface repairs B6 (2026-09-20): one order vocabulary. Side, type and time-in-force
 * are core's `OrderSide` / `OrderType` (kebab-case) / `TimeInForce`; portfolio's `Trade*` and
 * backtest's `Execution*` / `Side` spellings of the same three enums are retired. The fields that
 * said the wrong thing are renamed: an intent line sizes a `notionalWeight` (a target weight is a
 * policy's), an option's terms carry its `type` (never `right`), a backtest option specification's
 * instant is `expiresAt` like every resolved contract, and a store handle's instants are epoch
 * milliseconds under `*TimestampMs` like every other instant on the surface.
 */
const COVERED_REPAIRS_B6 = [
  'naming/portfolio/trade-side-alias',
  'naming/portfolio/trade-order-type-alias',
  'naming/portfolio/trade-time-in-force-alias',
  'naming/backtest/execution-order-type-alias',
  'naming/backtest/execution-time-in-force-alias',
  'naming/backtest/side-alias',
  'naming/portfolio/intent-order-target-weight',
  'naming/portfolio/option-terms-right',
  'naming/backtest/option-specification-expiry-instant',
  'naming/workflows/handle-created-at',
  'naming/workflows/handle-expires-at',
] as const;

describe('Repairs B6 — one order vocabulary', () => {
  it('the three enums are core names; no package re-spells them', () => {
    for (const name of ['OrderSide', 'OrderType', 'TimeInForce'])
      expect(baselineIds.has(`@totalfinance/core|export|${name}`), `${name} on core`).toBe(true);
    const retired = [
      ['@totalfinance/portfolio', 'Trade' + 'Side'],
      ['@totalfinance/portfolio', 'Trade' + 'OrderType'],
      ['@totalfinance/portfolio', 'Trade' + 'TimeInForce'],
      ['@totalfinance/backtest', 'Execution' + 'OrderType'],
      ['@totalfinance/backtest', 'Execution' + 'TimeInForce'],
      ['@totalfinance/backtest', 'Si' + 'de'],
    ] as const;
    for (const [pkg, name] of retired) {
      expect(baselineIds.has(`${pkg}|export|${name}`), `${pkg} exports ${name} again`).toBe(false);
      expect(baselineIds.has(`totalfinance|export|${name}`), `umbrella exports ${name} again`).toBe(
        false,
      );
    }
  });

  it('the renamed fields exist only under their new names', () => {
    expectFieldRenamed(
      '@totalfinance/portfolio',
      'TradeIntentOrder',
      'target' + 'Weight',
      'notionalWeight',
    );
    expectFieldRenamed('@totalfinance/portfolio', 'OptionContractTerms', 'ri' + 'ght', 'type');
    expectFieldRenamed(
      '@totalfinance/backtest',
      'OptionContractSpecification',
      'exp' + 'iry',
      'expiresAt',
    );
    expectFieldRenamed(
      '@totalfinance/workflows',
      'ResourceHandle',
      'created' + 'At',
      'createdTimestampMs',
    );
    expectFieldRenamed(
      '@totalfinance/workflows',
      'ResourceHandle',
      'expires' + 'At',
      'expiresTimestampMs',
    );
  });

  it('the retired spellings teach at runtime: the intent line, and the bar broker’s order type', () => {
    let message = '';
    expect(
      codeOfThrow(() => {
        try {
          requireTradeIntent('t', 'intent', {
            kind: 'totalfinance.trade-intent',
            schemaVersion: 1,
            accountId: 'main',
            asOf: 1,
            orders: [
              { instrumentId: 'AAA', side: 'buy', ['target' + 'Weight']: 0.1, type: 'market' },
            ],
          });
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      }),
    ).toBe(UNKNOWN_FIELD);
    expect(message).toContain('notionalWeight');
    const broker = new umbrella.backtest.SimulatedBroker({ cash: 1_000 });
    expect(() =>
      broker.submit({ symbol: 'X', side: 'buy', quantity: 1, type: ('stop' + 'Limit') as never }),
    ).toThrow(/stop-limit/);
  });
});

/**
 * Pre-publish interface repairs C (2026-09-20): one name per ratio — the suffixed
 * `sharpeRatio`/`sortinoRatio`/`calmarRatio`/`treynorRatio` aliases are gone and the bare forms
 * are the exports on the root and the subpaths alike — and one portfolio VaR door: `portfolioVaR`
 * takes `method: 'parametric' | 'historical' | 'monteCarlo'` where two method-named functions stood.
 */
const COVERED_REPAIRS_C = [
  'naming/performance/sharpe-ratio-alias',
  'naming/performance/sortino-ratio-alias',
  'naming/performance/calmar-ratio-alias',
  'naming/performance/treynor-ratio-alias',
  'naming/risk/parametric-portfolio-var-door',
  'naming/risk/monte-carlo-portfolio-var-door',
] as const;

describe('Repairs C — one name per ratio, one VaR door', () => {
  it('the suffixed ratio aliases are gone from every entrypoint; the bare names remain', () => {
    const performance = umbrella.performance as unknown as Record<string, unknown>;
    for (const [bare, suffixed] of [
      ['sharpe', 'sharpe' + 'Ratio'],
      ['sortino', 'sortino' + 'Ratio'],
      ['calmar', 'calmar' + 'Ratio'],
      ['treynor', 'treynor' + 'Ratio'],
    ] as const) {
      expect(typeof performance[bare], bare).toBe('function');
      expect(performance[suffixed], suffixed).toBeUndefined();
      expect(baselineIds.has(`@totalfinance/performance|export|${bare}`)).toBe(true);
      expect(baselineIds.has(`@totalfinance/performance|export|${suffixed}`)).toBe(false);
      expect(baselineIds.has(`totalfinance|export|${suffixed}`)).toBe(false);
    }
  });

  it('portfolioVaR is the one door and the method is never defaulted', () => {
    const risk = umbrella.risk as unknown as Record<string, unknown>;
    expect(typeof risk['portfolioVaR']).toBe('function');
    expect(risk['parametric' + 'PortfolioVaR']).toBeUndefined();
    expect(risk['monteCarlo' + 'PortfolioVaR']).toBeUndefined();
    expect(baselineIds.has('@totalfinance/risk|export|portfolioVaR')).toBe(true);
    expect(baselineIds.has('@totalfinance/risk|export|' + 'parametric' + 'PortfolioVaR')).toBe(
      false,
    );
    expect(baselineIds.has('@totalfinance/risk|export|' + 'monteCarlo' + 'PortfolioVaR')).toBe(
      false,
    );
    expect(
      codeOfThrow(() =>
        umbrella.risk.portfolioVaR({
          weights: [0.5, 0.5],
          covariance: [
            [0.04, 0.01],
            [0.01, 0.09],
          ],
        } as never),
      ),
    ).toBe('input.missing_field');
  });
});

describe('3B.N — every landed fixture has evidence', () => {
  /**
   * The gate that makes silence impossible: a fixture may not sit in the policy as a data-only
   * claim. Adding one without an assertion — or marking one `landsIn` a phase whose evidence block
   * does not name it — fails here.
   */
  it('the union of the per-phase covered lists is exactly the fixture set', () => {
    // Widened deliberately: the per-phase lists are `as const` so a reader sees the literal ids,
    // but comparing them against the policy's `string` ids needs the union collapsed.
    const covered: string[] = [
      ...COVERED_N1,
      ...COVERED_N2,
      ...COVERED_N4,
      ...COVERED_N7,
      ...COVERED_N8,
      ...COVERED_N9,
      ...COVERED_STAGE_4_5,
      ...COVERED_REPAIRS_B7,
      ...COVERED_REPAIRS_B6,
      ...COVERED_REPAIRS_C,
    ];
    const declared = COMPILE_FAIL_FIXTURES.map((fixture) => fixture.id);
    const missing = declared.filter((id) => !covered.includes(id));
    const stale = covered.filter((id) => !declared.includes(id));
    expect(
      missing,
      `fixtures recorded as removed with no executable evidence in this file:\n${missing.join('\n')}`,
    ).toEqual([]);
    expect(
      stale,
      `this file claims to cover fixtures that no longer exist in the policy:\n${stale.join('\n')}`,
    ).toEqual([]);
    expect(new Set(covered).size, 'a fixture id is listed twice').toBe(covered.length);
  });

  it('no fixture is marked as landing in a phase with no evidence block', () => {
    const withEvidence = new Set([
      '3B.N1',
      '3B.N2',
      '3B.N4',
      '3B.N7',
      '3B.N8',
      '3B.N9',
      '4.5',
      'repairs.B7',
      'repairs.B6',
      'repairs.C',
    ]);
    const orphaned = COMPILE_FAIL_FIXTURES.filter(
      (fixture) => !withEvidence.has(fixture.landsIn),
    ).map((fixture) => `${fixture.id} (${fixture.landsIn})`);
    expect(
      orphaned,
      `add a \`describe\` block for these phases before recording their fixtures:\n${orphaned.join('\n')}`,
    ).toEqual([]);
  });
});
