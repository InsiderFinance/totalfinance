/**
 * The `@totalfinance/fixed-income` deep entrypoints (WS3.8) resolve and expose their public surface, so a
 * consumer can import one concept (`@totalfinance/fixed-income/lattice`) without pulling the whole package.
 * This enumerates every subpath in the package's exports map.
 */

import { describe, expect, it } from 'vitest';
import { isLeapYear } from '@totalfinance/fixed-income/conventions';
import { curves } from '@totalfinance/fixed-income/curves';
import { bonds } from '@totalfinance/fixed-income/bonds';
import { blackKernel } from '@totalfinance/fixed-income/rates';
import { vasicek } from '@totalfinance/fixed-income/models';
import { cdsValue } from '@totalfinance/fixed-income/credit';
import { callableBond } from '@totalfinance/fixed-income/lattice';
import { convertibleBond } from '@totalfinance/fixed-income/convertible';
import { swapXva } from '@totalfinance/fixed-income/xva';
import { crossCurrencyBasisCurve } from '@totalfinance/fixed-income/cross-currency';
import { bondFuture, conversionFactor } from '@totalfinance/fixed-income/futures';
import { breakevenInflation, tipsIndexRatio } from '@totalfinance/fixed-income/inflation';

describe('@totalfinance/fixed-income deep entrypoints', () => {
  it('every exports-map subpath resolves and exposes its concept', () => {
    expect(typeof isLeapYear).toBe('function'); // ./conventions
    expect(curves).toBeDefined(); // ./curves
    expect(bonds).toBeDefined(); // ./bonds
    expect(blackKernel).toBeDefined(); // ./rates
    expect(vasicek).toBeDefined(); // ./models
    expect(typeof cdsValue).toBe('function'); // ./credit
    expect(typeof callableBond).toBe('function'); // ./lattice (WS3.8)
    expect(typeof convertibleBond).toBe('function'); // ./convertible (WS3.8)
    expect(typeof swapXva).toBe('function'); // ./xva (WS3.8)
    expect(typeof crossCurrencyBasisCurve).toBe('function'); // ./cross-currency
    // Both modules shipped without an exports entry, so the only way to reach bond-future basis or
    // TIPS analytics was to pull the whole package — the two heaviest reasons to import it.
    expect(typeof bondFuture).toBe('function'); // ./futures
    expect(typeof conversionFactor).toBe('function'); // ./futures
    expect(typeof tipsIndexRatio).toBe('function'); // ./inflation
    expect(typeof breakevenInflation).toBe('function'); // ./inflation
  });
});
