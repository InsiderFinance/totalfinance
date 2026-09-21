/**
 * The GENERATED contract for `strategyFromChain` must describe, variant by variant, exactly what the
 * runtime accepts.
 *
 * `FromChainOptions` is seven `CommonOptions & { … }` branches covering ten `FromChainType` values —
 * the four directional spreads share one branch. The generated parameter tree originally recorded
 * only what every branch SHARED (six fields), dropping `shortDelta`, `wingWidth`, `width`, `strike`,
 * `stockPrice`, `farExpiry` and `right`. Runtime was safe because `from-chain.ts` carries a
 * hand-written per-variant allowlist; a validator generated from the artifact would have rejected
 * every valid call.
 *
 * RV12 — the first version of this test claimed exact bidirectional parity and did not have it. It
 * checked seven branches, six common fields, the UNION of discriminated fields, and one rejection.
 * That passes if fields move to the WRONG branch, if extra fields appear, if requiredness flips, or
 * if the four spread variants diverge — every failure mode that matters. The union of a set tells you
 * almost nothing about its partition.
 *
 * So this expands the branches by their discriminator literals into all ten variants and compares
 * each against what the function ACTUALLY does. Not against a second copy of the table: a table can
 * agree with a table while both disagree with the code.
 */
import { describe, expect, it } from 'vitest';
import { resolvedExpiry } from '@totalfinance/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OptionQuote } from '@totalfinance/core';
import { strategyFromChain } from '@totalfinance/strategy';
import {
  armsOfNode,
  type ManifestArtifact,
  type ManifestNode,
} from '../../../tools/manifest/manifest-nodes.js';

/**
 * Read through the SHARED manifest reader, not a local echo of the artifact's shape.
 *
 * This file declared its own `Parameter { branchFields }` and broke the moment that representation
 * was retired — a package test failing on a tools-side change it had no way to see coming. The
 * shared types are the one place the published node shape is written down, so the next change to it
 * is a compile error here rather than a red suite.
 */
const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../tools/manifest/public-contracts.json', import.meta.url)),
    'utf8',
  ),
) as ManifestArtifact;

/** The ten variants, expanded from the seven branches by their `type` discriminator literals. */
function variantsFromArtifact(): Map<
  string,
  { fields: Set<string>; optional: Set<string>; kind: Map<string, string> }
> {
  const record = (artifact.contracts ?? []).find(
    (candidate) => candidate.id === '@totalfinance/strategy:strategyFromChain',
  );
  if (!record)
    throw new Error('no @totalfinance/strategy:strategyFromChain record — subject is gone');
  const parameter = (record.signatures ?? [])
    .flatMap((signature) => signature.parameters ?? [])
    .find((candidate) => candidate.name === 'options');
  const arms = armsOfNode(parameter);
  if (!arms) throw new Error('strategyFromChain#options records no branches');

  const out = new Map<
    string,
    { fields: Set<string>; optional: Set<string>; kind: Map<string, string> }
  >();
  for (const arm of arms) {
    const branch: ManifestNode[] = arm.fields ?? [];
    if (branch.length === 0) continue;
    const discriminator = branch.find((field) => field.name === 'type');
    expect(
      discriminator?.literals?.length,
      'every branch must carry its `type` discriminator literals, or it cannot be attributed to a variant',
    ).toBeTruthy();
    for (const admitted of discriminator!.literals!) {
      /**
       * A discriminator's admitted values are `LiteralValue` now, not `string`. `type` here is a
       * STRING domain, and the assertion is what makes that a fact rather than a hope: `String(...)`
       * claimed to narrow and actually converted, so a numeric discriminator would have keyed this
       * map by its decimal spelling and silently passed as the same variant.
       */
      expect(typeof admitted, `${String(admitted)} is not a string discriminator`).toBe('string');
      const variant = admitted as string;
      expect(out.has(variant), `${variant} is described by two branches`).toBe(false);
      out.set(variant, {
        fields: new Set(branch.map((field) => field.name ?? '')),
        optional: new Set(
          branch.filter((field) => field.optional).map((field) => field.name ?? ''),
        ),
        // The declared KIND per field, so a mutation can be the wrong type on purpose rather than
        // whatever a test author guessed the field was.
        kind: new Map<string, string>(
          branch.map((field) => [field.name ?? '', field.kind ?? 'unknown']),
        ),
      });
    }
  }
  return out;
}

const VARIANTS = variantsFromArtifact();
const ALL_FIELDS = [...new Set([...VARIANTS.values()].flatMap((v) => [...v.fields]))].sort();

/** A minimally-shaped call for a variant, with one extra field spliced in. */
function unknownFieldErrorFor(variant: string, field: string): string {
  try {
    strategyFromChain(
      [] as never,
      {
        type: variant,
        expiry: '2026-03-20',
        [field]: 1,
      } as never,
    );
    return '';
  } catch (error) {
    const message = (error as Error).message;
    // Only an UNKNOWN-KEY complaint counts; a missing-required or empty-rows failure is unrelated.
    return /unknown field/i.test(message) && message.includes(field) ? message : '';
  }
}

/**
 * A REAL chain, because an empty one makes the answer unknowable.
 *
 * `strategyFromChain([], …)` dies on the rows before it finishes judging the options, so "the runtime
 * did not reject this mutation" and "the runtime never got far enough to look" produce the same
 * silence. A nine-strike chain around spot 100, with a second expiry for the calendar variant, lets
 * every mutation below reach the validator it is aimed at.
 */
const PARITY_EXPIRY = '2026-04-17';
const PARITY_FAR_EXPIRY = '2026-06-19';

const quote = (
  type: 'call' | 'put',
  strike: number,
  mid: number,
  delta: number,
  expiry: string = PARITY_EXPIRY,
): OptionQuote => ({
  contract: {
    underlying: 'XYZ',
    type,
    style: 'american',
    strike,
    expiry,
    ...resolvedExpiry(expiry),
  },
  timestampMs: 0,
  bid: mid - 0.1,
  ask: mid + 0.1,
  mid,
  last: mid + 0.5,
  mark: mid + 0.2,
  impliedVolatility: 0.28,
  underlyingPrice: 100,
  greeks: { delta },
});

const PARITY_GRID: [number, number, number][] = [
  [85, 16.5, 0.82],
  [90, 12.4, 0.72],
  [95, 8.9, 0.6],
  [100, 6.0, 0.5],
  [105, 3.9, 0.38],
  [110, 2.4, 0.28],
  [115, 1.4, 0.18],
];

const PARITY_CHAIN: OptionQuote[] = PARITY_GRID.flatMap(([strike, mid, delta]) => [
  quote('call', strike, mid, delta),
  quote('put', strike, mid - 1, -(1 - delta)),
  quote('call', strike, mid + 1.5, delta, PARITY_FAR_EXPIRY),
  quote('put', strike, mid + 0.5, -(1 - delta), PARITY_FAR_EXPIRY),
]);

/**
 * A CANONICALLY VALID call for a variant — the precondition every mutation below depends on.
 *
 * Mutating one field only means something if the UNMUTATED call succeeds. Without that, "the runtime
 * did not complain about `multiplier`" can equally mean "the call died earlier for an unrelated
 * reason and never looked at it" — which is precisely what happened when this was first written:
 * `{ type, expiry, multiplier: NaN }` failed on a missing `shortDelta` with "no quotes to select
 * from", a message that does not name `multiplier`, and the test read that silence as acceptance.
 * The library was rejecting NaN correctly the whole time.
 */
const CANONICAL: Record<string, unknown> = {
  expiry: PARITY_EXPIRY,
  farExpiry: PARITY_FAR_EXPIRY,
  shortDelta: 0.3,
  wingWidth: 5,
  width: 5,
  strike: 100,
  stockPrice: 100,
  right: 'call',
  quantity: 1,
  price: 1,
  multiplier: 100,
  spot: 100,
};

function baseFor(variant: string): Record<string, unknown> {
  const shape = VARIANTS.get(variant)!;
  const options: Record<string, unknown> = { type: variant };
  for (const field of shape.fields) {
    if (field === 'type' || shape.optional.has(field)) continue;
    options[field] = CANONICAL[field] ?? 1;
  }
  return options;
}

/** Does the runtime accept this call at all? The precondition, asked out loud. */
function accepts(options: Record<string, unknown>): boolean {
  try {
    strategyFromChain(PARITY_CHAIN, options as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mutate one field of a canonically valid call and return the complaint, but only when the complaint
 * NAMES the mutated field. Naming is what separates a rejection of the mutation from an unrelated
 * failure, and it is also a real requirement: an error that refuses a call without saying which field
 * was wrong is not a usable error.
 */
function complaintAbout(
  variant: string,
  field: string,
  mutate: (options: Record<string, unknown>) => void,
): string {
  const options = baseFor(variant);
  mutate(options);
  try {
    strategyFromChain(PARITY_CHAIN, options as never);
    return '';
  } catch (error) {
    const message = (error as Error).message;
    return message.includes(field) ? message : '';
  }
}

/** A value the declared kind forbids. Mirrors the harness's own wrong-type vocabulary. */
function forbiddenFor(kind: string | undefined): unknown {
  switch (kind) {
    case 'numeric':
      return 'not-a-number';
    case 'string':
    case 'enum':
      return 1;
    case 'boolean':
      return 'yes';
    default:
      return undefined;
  }
}

describe('strategyFromChain — every variant, compared against what the runtime accepts', () => {
  it('the branches expand to exactly the ten FromChainType variants', () => {
    expect([...VARIANTS.keys()].sort()).toEqual([
      'bearCallSpread',
      'bearPutSpread',
      'bullCallSpread',
      'bullPutSpread',
      'calendar',
      'coveredCall',
      'ironCondor',
      'protectivePut',
      'straddle',
      'strangle',
    ]);
  });

  it('each variant records the exact discriminated fields, not the union of all of them', () => {
    /**
     * The property the previous test could not express: a field belongs to SOME variants and not
     * others, and putting it on the wrong one is invisible to a union check.
     */
    const discriminated = (variant: string): string[] =>
      [...VARIANTS.get(variant)!.fields]
        .filter(
          (name) => !['type', 'expiry', 'quantity', 'price', 'multiplier', 'spot'].includes(name),
        )
        .sort();
    expect(discriminated('ironCondor')).toEqual(['shortDelta', 'wingWidth']);
    for (const spread of ['bullCallSpread', 'bearCallSpread', 'bullPutSpread', 'bearPutSpread']) {
      expect(discriminated(spread), spread).toEqual(['shortDelta', 'width']);
    }
    expect(discriminated('straddle')).toEqual(['strike']);
    expect(discriminated('strangle')).toEqual(['shortDelta']);
    expect(discriminated('coveredCall')).toEqual(['shortDelta', 'stockPrice']);
    expect(discriminated('protectivePut')).toEqual(['shortDelta', 'stockPrice']);
    expect(discriminated('calendar')).toEqual(['farExpiry', 'right', 'strike']);
  });

  it('records requiredness, and records it per variant', () => {
    // `strike` is OPTIONAL on straddle and calendar; `farExpiry` is REQUIRED on calendar. A tree that
    // flattened requiredness would make a generated validator demand or excuse the wrong things.
    expect(VARIANTS.get('straddle')!.optional.has('strike')).toBe(true);
    expect(VARIANTS.get('calendar')!.optional.has('strike')).toBe(true);
    expect(VARIANTS.get('calendar')!.optional.has('farExpiry')).toBe(false);
    expect(VARIANTS.get('ironCondor')!.optional.has('wingWidth')).toBe(false);
    // Every variant shares the same optional commons, which is what makes them common.
    for (const [variant, shape] of VARIANTS) {
      for (const shared of ['quantity', 'price', 'multiplier', 'spot']) {
        expect(shape.optional.has(shared), `${variant}.${shared}`).toBe(true);
      }
      expect(shape.optional.has('expiry'), `${variant}.expiry`).toBe(false);
    }
  });

  it('THE RUNTIME AGREES: every field the artifact omits from a variant is rejected by it', () => {
    /**
     * The artifact against the code, one variant at a time. A field the artifact does not list for a
     * variant must be refused when passed to that variant — otherwise the recorded contract is
     * narrower than reality and a generated validator would reject valid calls.
     */
    const wrong: string[] = [];
    for (const [variant, shape] of VARIANTS) {
      for (const field of ALL_FIELDS) {
        if (shape.fields.has(field)) continue;
        if (!unknownFieldErrorFor(variant, field)) {
          wrong.push(`${variant} accepts \`${field}\`, which its recorded branch does not list`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /**
   * RUNTIME SEMANTIC PARITY, not field placement.
   *
   * The two tests above compare which FIELDS each variant accepts. That is placement parity, and it
   * was the whole of the runtime comparison — a variant could accept its declared field set and then
   * do nothing whatever with the values, and this file would have called that parity. Requiredness
   * was asserted only against the artifact, from a hardcoded list, so the runtime was never asked.
   *
   * These three ask it, for EVERY variant rather than a chosen few: omit each required field,
   * mistype each field against its declared kind, and put a non-finite number where a finite one is
   * declared. A complaint only counts when it NAMES the mutated field, so an unrelated failure
   * (empty rows) cannot be mistaken for a rejection.
   */
  it('every variant has a canonically VALID call — the precondition for the mutations below', () => {
    // If this fails, every mutation assertion after it is measuring an unreachable path.
    const unbuildable = [...VARIANTS.keys()].filter((variant) => !accepts(baseFor(variant)));
    expect(
      unbuildable,
      `these variants have no valid canonical call, so no mutation of them proves anything:\n${unbuildable.join('\n')}`,
    ).toEqual([]);
  });

  it('THE RUNTIME AGREES: omitting any required field is rejected, per variant', () => {
    const silent: string[] = [];
    for (const [variant, shape] of VARIANTS) {
      for (const field of shape.fields) {
        if (field === 'type' || shape.optional.has(field)) continue;
        const complaint = complaintAbout(variant, field, (options) => {
          delete options[field];
        });
        if (!complaint) {
          silent.push(
            `${variant}: omitting required \`${field}\` is not rejected by name — either it is ` +
              'accepted, or the refusal never says which field was missing',
          );
        }
      }
    }
    expect(silent, silent.join('\n')).toEqual([]);
  });

  it('THE RUNTIME AGREES: a wrong-typed field is rejected, per variant', () => {
    const silent: string[] = [];
    for (const [variant, shape] of VARIANTS) {
      for (const field of shape.fields) {
        if (field === 'type') continue;
        const forbidden = forbiddenFor(shape.kind.get(field));
        if (forbidden === undefined) continue;
        const complaint = complaintAbout(variant, field, (options) => {
          options[field] = forbidden;
        });
        if (!complaint) silent.push(`${variant}: \`${field}\` accepts a ${typeof forbidden}`);
      }
    }
    expect(silent, silent.join('\n')).toEqual([]);
  });

  it('THE RUNTIME AGREES: a non-finite number is rejected wherever a number is declared', () => {
    const silent: string[] = [];
    for (const [variant, shape] of VARIANTS) {
      for (const field of shape.fields) {
        if (shape.kind.get(field) !== 'numeric') continue;
        const complaint = complaintAbout(variant, field, (options) => {
          options[field] = Number.NaN;
        });
        if (!complaint) silent.push(`${variant}: \`${field}\` accepts NaN`);
      }
    }
    expect(silent, silent.join('\n')).toEqual([]);
  });

  it('THE RUNTIME AGREES: an invalid discriminator is rejected and teaches the valid set', () => {
    // The discriminator is what selects the branch, so accepting an unknown one would silently pick
    // some default and measure a variant nobody asked for.
    let message = '';
    try {
      strategyFromChain([] as never, { type: 'qzxBogusVariant', expiry: '2026-03-20' } as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, 'an unknown `type` was not rejected').not.toBe('');
    expect(message).toMatch(/type/);
    // A rejection that does not name the alternatives leaves the caller to guess.
    expect(message, `the error should teach the valid variants: ${message}`).toMatch(
      /ironCondor|straddle|calendar/,
    );
  });

  it('THE RUNTIME AGREES: every field the artifact lists for a variant is accepted by it', () => {
    // The other direction. A field the artifact lists but the runtime rejects means the recorded
    // contract is wider than reality, and a caller following the artifact gets thrown at.
    const wrong: string[] = [];
    for (const [variant, shape] of VARIANTS) {
      for (const field of shape.fields) {
        if (field === 'type') continue;
        const complaint = unknownFieldErrorFor(variant, field);
        if (complaint)
          wrong.push(`${variant} rejects \`${field}\`, which its recorded branch lists`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
