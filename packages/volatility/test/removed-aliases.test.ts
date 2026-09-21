import { describe, expect, it } from 'vitest';
import * as vol from '@totalfinance/volatility';

/**
 * Alignment spec D5 — pre-release renames DELETE the old name; there are no released consumers,
 * so a deprecated alias is fictional backward compatibility that pollutes autocomplete. This pins
 * the deletion: the upper-acronym fit/calibrate spellings and the expected-move `iv` field are
 * gone, and the retired `iv` key is rejected BY NAME so the mistake teaches its fix.
 */
describe('pre-release aliases are deleted, not deprecated (specification D5)', () => {
  it('the upper-acronym fit/calibrate spellings no longer exist', () => {
    const exported = Object.keys(vol);
    for (const gone of [
      'fitSVI',
      'fitSABRSmile',
      'calibrateSSVI',
      'calibrateESSVI',
      'fitSvi',
      'fitSabrSmile',
      'fitEventVolatility',
    ]) {
      expect(exported, `${gone} should be deleted`).not.toContain(gone);
    }
    // The canonical lower-acronym names are the surface.
    expect(typeof vol.calibrateSvi).toBe('function');
    expect(typeof vol.calibrateSabrSmile).toBe('function');
    expect(typeof vol.calibrateSsvi).toBe('function');
    expect(typeof vol.calibrateEssvi).toBe('function');
  });

  // The RETIRED spellings are built by concatenation, for the same reason as the package-identity
  // assertions above: a repo-wide `iv`/`vol` → `impliedVolatility` sweep would otherwise rewrite the
  // very keys this test exists to prove are GONE. It did exactly that once — the assertions below
  // were flipped to demand that the CANONICAL name be rejected, and the guard was rewritten to
  // match, so a function named `expectedMoveFromImpliedVolatility` threw on `impliedVolatility`.
  const RETIRED_IV = 'i' + 'v';
  const RETIRED_VOL = 'v' + 'ol';

  it('the canonical `impliedVolatility` input is ACCEPTED (spec §3B.N worked example)', () => {
    const move = vol.expectedMoveFromImpliedVolatility({
      spot: 100,
      impliedVolatility: 0.2,
      timeToExpiryYears: 0.25,
    });
    expect(move.oneSigma).toBeCloseTo(100 * 0.2 * Math.sqrt(0.25), 12);
    expect(move.oneSigmaFraction).toBeCloseTo(0.2 * Math.sqrt(0.25), 12);
  });

  it.each([RETIRED_IV, RETIRED_VOL])(
    'expectedMoveFromImpliedVolatility rejects the retired `%s` key with a teaching error',
    (retired) => {
      expect(() =>
        vol.expectedMoveFromImpliedVolatility({
          spot: 100,
          [retired]: 0.2,
          timeToExpiryYears: 0.25,
        } as never),
      ).toThrow(new RegExp(`'${retired}' is not an input — the field is named impliedVolatility`));
    },
  );

  it('a silent retired/canonical conflict is impossible — the retired key throws even alongside the canonical one', () => {
    expect(() =>
      vol.expectedMoveFromImpliedVolatility({
        spot: 100,
        impliedVolatility: 0.2,
        [RETIRED_VOL]: 0.8,
        timeToExpiryYears: 0.25,
      } as never),
    ).toThrow(new RegExp(`'${RETIRED_VOL}' is not an input`));
  });

  it('expectedMoveFromImpliedVolatility still teaches when impliedVolatility is missing', () => {
    expect(() =>
      vol.expectedMoveFromImpliedVolatility({ spot: 100, timeToExpiryYears: 0.25 } as never),
    ).toThrow(/impliedVolatility is required/);
  });
});
