/**
 * The `@totalfinance/strategy` deep entrypoints (WS3.7) resolve and expose their public surface, so a
 * consumer can `import { scanStrategies } from '@totalfinance/strategy/scanner'` without pulling the
 * barrel.
 *
 * The `./builders` subpath is deliberately RETIRED: it used to serve the RAW builders module —
 * same names as the root exports but unwrapped (no manifest guard, no `constructedAs` provenance),
 * so behavior silently differed by import path. Named builders come from the root, which serves
 * the manifest-wrapped set.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bullCallSpread, scanStrategies, straddle } from '@totalfinance/strategy';
import { terminalCdf } from '@totalfinance/strategy/probability';
import { scanStrategies as scanFromSubpath } from '@totalfinance/strategy/scanner';

describe('@totalfinance/strategy deep entrypoints', () => {
  it('the ./builders subpath is retired — raw unwrapped builders are not exported', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./builders']).toBeUndefined();
    // The subpaths that remain are the ones tested below.
    expect(Object.keys(pkg.exports).sort()).toEqual(
      ['.', './from-chain', './package.json', './probability', './scanner'].sort(),
    );
  });

  it('named builders come from the root, manifest-wrapped (constructedAs stamped)', () => {
    expect(typeof straddle).toBe('function');
    expect(typeof bullCallSpread).toBe('function');
    const pos = straddle({ strike: 105, callPremium: 3, putPremium: 3 });
    expect(pos.constructedAs).toBe('straddle');
    const spread = bullCallSpread({
      long: { strike: 100, premium: 4.25 },
      short: { strike: 110, premium: 1.4 },
    });
    expect(spread.constructedAs).toBe('bullCallSpread');
  });

  it('./scanner exposes scanStrategies', () => {
    expect(typeof scanFromSubpath).toBe('function');
    expect(scanFromSubpath).toBe(scanStrategies);
  });

  it('./probability exposes the probability primitives', () => {
    expect(typeof terminalCdf).toBe('function');
  });
});
