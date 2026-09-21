/**
 * DELETING AN OPTIONAL FIELD MUST SUCCEED — and must never be recorded as a failure.
 *
 * `probeContract`'s own documentation states the rule twice: "`omit-required` fires only on fields the
 * contract declares REQUIRED" (contract-probe.ts), and "Deleting an optional field must succeed"
 * (`AUTHORITATIVE_WHEN_DECLARED`, contract-enforcement.ts). Neither was implemented. A PRESENT optional
 * field fell past the guard, got probed for omission, was tagged `declared: true` — which
 * `isAuthoritative` reads as "the contract decided this" — and the acceptance was filed as a defect.
 *
 * It convicted 450 boundaries on nothing else, 27% of the `defective` headline. `blackScholes.price`
 * was `defective` with one failure, `omit-required/dividendYield`, while returning 9.87 for the call
 * that omitted it.
 *
 * These fixtures exist because the rule had been WRITTEN DOWN for months and was still wrong: prose in
 * a comment is not a gate. The last test binds the rule to the committed artifact, so the invariant is
 * asserted against the whole library rather than against three hand-made shapes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeContract } from './contract-probe.js';
import { type ManifestArtifact, walkManifest } from './manifest-nodes.js';

/** A boundary that honours its optional field: it defaults, and never rejects the omission. */
const boundary = (input: Record<string, unknown>): number => {
  if (typeof input !== 'object' || input === null) throw new TypeError('input must be an object');
  if (typeof input['spot'] !== 'number') throw new TypeError('spot must be a number');
  const dividendYield = typeof input['note'] === 'string' ? 0 : (input['dividendYield'] ?? 0);
  if (typeof dividendYield !== 'number') throw new TypeError('dividendYield must be a number');
  return (input['spot'] as number) - dividendYield;
};

const TREE = [
  { name: 'spot', type: 'number', kind: 'numeric', optional: false, nullable: false },
  { name: 'dividendYield', type: 'number', kind: 'numeric', optional: true, nullable: false },
];

const probe = (argument: Record<string, unknown>) =>
  probeContract(
    (...args: unknown[]) => boundary(args[0] as Record<string, unknown>),
    () => [{ ...argument }],
    { coordinates: [{ kind: 'object', optional: false, fields: TREE }] },
  );

const mutationsOn = (results: ReturnType<typeof probe>, field: string, mutation: string) =>
  results.filter((r) => r.field === field && r.mutation === mutation);

describe('omit-required never fires on a declared-optional field', () => {
  it('does NOT probe omission of a PRESENT optional field', () => {
    // The exact shape of the 450: the baseline supplies the optional, deleting it is accepted
    // because that is what optional means, and the acceptance was convicting the boundary.
    const results = probe({ spot: 100, dividendYield: 0.01 });
    expect(mutationsOn(results, 'dividendYield', 'omit-required')).toEqual([]);
  });

  it('DOES probe omission of a required field', () => {
    // The other half of the invariant. Without this, "emit nothing" would pass the test above.
    const results = probe({ spot: 100, dividendYield: 0.01 });
    expect(mutationsOn(results, 'spot', 'omit-required')).toHaveLength(1);
    expect(mutationsOn(results, 'spot', 'omit-required')[0]?.declared).toBe(true);
  });

  it('still probes WRONG-TYPE on a present optional — optional is not "any type"', () => {
    // Dropping the omission probe must not drop the type probe with it: "may be omitted" and "may be
    // any type" are different permissions, and only the first one is granted.
    const results = probe({ spot: 100, dividendYield: 0.01 });
    expect(mutationsOn(results, 'dividendYield', 'wrong-type').length).toBeGreaterThan(0);
  });

  it('still probes an ABSENT optional with a forbidden type', () => {
    const results = probe({ spot: 100 });
    expect(mutationsOn(results, 'dividendYield', 'optional-wrong-type')).toHaveLength(1);
  });

  /**
   * The invariant, asserted against the whole committed library rather than three fixtures.
   *
   * A hand-made shape proves the code path; this proves the RESULT. If the guard regresses, or a new
   * probe path grows its own copy of the same mistake, this fails with the boundary named.
   */
  it('no committed failure convicts a boundary for omitting an optional field', () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')) as {
        enforcement?: {
          id: string;
          failures?: { mutation: string; field?: string }[];
        }[];
      } & ManifestArtifact;

    const enforcement = read('public-enforcement.json');
    const contracts = read('public-contracts.json');
    const byId = new Map((contracts.contracts ?? []).map((r) => [r.id, r]));

    /**
     * EVERY declared path, through the shared walker.
     *
     * This used to descend `fieldTree` and a flattened `branchFields`, by hand — so it saw members
     * one level inside an object arm and nothing else: not tuple positions, not array elements, not
     * a callback's return contract, not an arm nested inside an arm. It kept passing after
     * `branchFields` was retired, which is worse than failing: the optional-field claim below was
     * being made over a shrinking share of the surface with no signal that its reach had changed.
     *
     * `walkManifest` enumerates every child relationship in one place, so the population this claim
     * covers is the whole declared graph and stays that way when the graph gains a relationship.
     */
    const optionalPaths = (id: string): Map<string, boolean> => {
      const found = new Map<string, boolean>();
      for (const signature of byId.get(id)?.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          walkManifest(parameter, ({ node, route }) => {
            const path = route
              .filter((step): step is { property: string } => 'property' in step)
              .map((step) => step.property)
              .join('.');
            if (path.length === 0) return;
            // A path reachable through several arms is optional only where every route says so; the
            // probe asks "was this field declared optional", and one required occurrence answers it.
            found.set(path, (found.get(path) ?? true) && node.optional === true);
          });
        }
      }
      return found;
    };

    const convicted: string[] = [];
    for (const row of enforcement.enforcement ?? []) {
      if (!row.failures?.length) continue;
      const optional = optionalPaths(row.id);
      for (const failure of row.failures) {
        if (failure.mutation !== 'omit-required' || !failure.field) continue;
        if (optional.get(failure.field) === true) convicted.push(`${row.id} — ${failure.field}`);
      }
    }
    expect(
      convicted.slice(0, 20),
      `${convicted.length} recorded failures convict a boundary for correctly accepting the omission ` +
        'of a field its own contract declares optional',
    ).toEqual([]);
  });
});

/**
 * A SCALAR COORDINATE IS A CONTRACT TOO — and it was skipped entirely.
 *
 * `probeContract` walked the arguments and did `if (!isPlainObject(argument)) continue`, so a scalar
 * beside an object was never examined. `selectQuotePrice(quote, source)` recorded 41 results, every
 * one on argument 0, while `source`'s five declared literals sat in the inventory untested. 181
 * measured public paths pair an object or series with a scalar coordinate, and for all of them the
 * verdict spoke for a call that was only half examined.
 *
 * The zero these guard against is the dangerous kind. Across the library `invalid-literal` records
 * NOTHING, which reads as "every enum is enforced" and would read exactly the same if the probe were
 * never emitted. These fixtures make the two distinguishable: a boundary that ignores its enum must
 * produce an ACCEPTED result here.
 */
const lenient = (...args: unknown[]): unknown => ({ got: args[1] });
const strict = (...args: unknown[]): unknown => {
  if (args[1] === undefined) throw new TypeError('source is required');
  if (typeof args[1] !== 'string') throw new TypeError('source must be a string');
  if (!['bid', 'ask'].includes(args[1])) throw new TypeError('source must be bid|ask');
  return { got: args[1] };
};

const SOURCE = {
  kind: 'primitive',
  type: 'PriceSource',
  optional: false,
  literals: ['bid', 'ask'] as const,
};

const probeScalarWith = (target: (...args: unknown[]) => unknown) =>
  probeContract(target, () => [{ spot: 1 }, 'bid'], {
    coordinates: [{ kind: 'object', optional: false, fields: [] }, SOURCE],
  }).filter((r) => r.argumentIndex === 1);

describe('portable diagnostic return previews', () => {
  const preview = (value: unknown) => probeScalarWith(() => value)[0]?.returned;

  it('renders the observed Linux and macOS scalar results identically', () => {
    expect(preview(0.2476734303459216)).toBe('0.247673430346');
    expect(preview(0.24767343034592149)).toBe(preview(0.2476734303459216));
  });

  it('rounds nested numbers before truncation, including the observed bond diagnostics', () => {
    const shared = { price: 19.731781625930868, context: 'x'.repeat(120) };
    const left = { straightPrice: 20.31046066468418, optionValue: 0.578679038753311, ...shared };
    const right = { straightPrice: 20.310460664684136, optionValue: 0.5786790387532683, ...shared };
    expect(preview(left)).toBe(preview(right));
    expect(preview(left)).toHaveLength(120);
    expect(preview(left)).toContain('"optionValue":0.578679038753');
  });

  it('retains meaningful numerical differences and exact safe integers', () => {
    expect(preview(0.25)).not.toBe(preview(0.2476734303459216));
    expect(preview(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(preview({ integer: Number.MAX_SAFE_INTEGER })).toContain('9007199254740991');
    expect(preview(1e-300)).toBe('1e-300');
  });

  it('does not turn non-finite scalar evidence into a plausible finite result', () => {
    expect(preview(NaN)).toBe('NaN');
    expect(preview(Infinity)).toBe('Infinity');
    expect(preview(-Infinity)).toBe('-Infinity');
    expect(preview(null)).toBe('null');
    expect(preview(undefined)).toBe('undefined');
  });

  it('does not round or mutate the library result itself', () => {
    const result = { values: [0.24767343034592149] };
    expect(preview(result)).toBe('{"values":[0.247673430346]}');
    expect(result.values[0]).toBe(0.24767343034592149);
  });
});

describe('scalar coordinates are probed, not skipped', () => {
  it('emits omit / wrong-type / invalid-literal for a declared scalar', () => {
    const mutations = probeScalarWith(strict)
      .map((r) => r.mutation)
      .sort();
    expect(mutations).toEqual(['invalid-literal', 'omit-required', 'wrong-type']);
  });

  it('a boundary that VALIDATES its enum refuses all three', () => {
    // `rejected` means a TYPED rejection (a QuantError carrying a code); a bare `TypeError` is
    // classified `untyped`, which the harness deliberately keeps distinct because an untyped throw
    // is a worse contract than a typed refusal. These fixtures throw bare TypeErrors, so the
    // assertion is "did not accept" rather than "rejected".
    expect(probeScalarWith(strict).every((r) => r.verdict !== 'accepted')).toBe(true);
  });

  it('a boundary that IGNORES its scalar accepts all three — the zero is not vacuous', () => {
    const accepted = probeScalarWith(lenient).filter((r) => r.verdict === 'accepted');
    expect(accepted.map((r) => r.mutation).sort()).toEqual([
      'invalid-literal',
      'omit-required',
      'wrong-type',
    ]);
  });

  it('INVALID-LITERAL is the only one that can tell an enum apart from a type check', () => {
    // The whole reason it exists as its own mutation. This boundary checks `typeof === 'string'` and
    // nothing more, so `wrong-type` (which substitutes a number) is REJECTED and reads as enforcement
    // while any string at all is accepted.
    const typeOnly = (...args: unknown[]): unknown => {
      if (typeof args[1] !== 'string') throw new TypeError('source must be a string');
      return { got: args[1] };
    };
    const byMutation = new Map(probeScalarWith(typeOnly).map((r) => [r.mutation, r.verdict]));
    expect(byMutation.get('wrong-type')).not.toBe('accepted');
    expect(byMutation.get('invalid-literal')).toBe('accepted');
  });

  it('marks the scalar probes DECLARED, so they can convict', () => {
    expect(probeScalarWith(lenient).every((r) => r.declared === true)).toBe(true);
  });
});

/**
 * A SINGLETON BOOLEAN DOMAIN IS A DOMAIN, AND `false` IS OUTSIDE IT.
 *
 * The probe declined to emit anything for one, reasoning that "`flag: true` has only `false`, and
 * sending it tests a boolean's ordinary handling rather than a domain violation". That is backwards.
 * Whether the boundary rejects `false` is the ONE thing separating `enabled: true` from
 * `enabled: boolean` — and with no probe emitted, a boundary that checks `typeof === 'boolean'` and
 * stops published `enforced` on the strength of `omit-required` and `wrong-type` alone.
 */
describe('a singleton boolean domain is probed with the other boolean', () => {
  const ENABLED = { kind: 'boolean', optional: false, literals: [true] } as const;

  const probeEnabled = (target: (...args: unknown[]) => unknown) =>
    probeContract(target, () => [true], {
      coordinates: [ENABLED as never],
    });

  /** Rejects unknown keys, missing fields and non-booleans — and accepts BOTH booleans. */
  const typeOnly = (...args: unknown[]): unknown => {
    if (typeof args[0] !== 'boolean') throw new TypeError('enabled must be a boolean');
    return { enabled: args[0] };
  };

  /** Honours the declared domain. */
  const strictDomain = (...args: unknown[]): unknown => {
    if (args[0] !== true) throw new TypeError('enabled must be true');
    return { enabled: args[0] };
  };

  it('emits an invalid-literal probe at all', () => {
    expect(probeEnabled(strictDomain).map((r) => r.mutation)).toContain('invalid-literal');
  });

  it('CONVICTS a type-only boundary that accepts `false`', () => {
    // The reviewer's boundary: every other mutation is refused, so without this one it reads as
    // enforced while accepting a value its declaration forbids.
    const byMutation = new Map(probeEnabled(typeOnly).map((r) => [r.mutation, r.verdict]));
    expect(byMutation.get('wrong-type')).not.toBe('accepted');
    expect(byMutation.get('invalid-literal')).toBe('accepted');
  });

  it('does not convict a boundary that honours the domain', () => {
    const literal = probeEnabled(strictDomain).filter((r) => r.mutation === 'invalid-literal');
    expect(literal.length).toBe(1);
    expect(literal[0]!.verdict).not.toBe('accepted');
  });

  it('probes `true` against a singleton `false` domain, symmetrically', () => {
    const results = probeContract(
      (...args: unknown[]) => {
        if (args[0] !== false) throw new TypeError('disabled must be false');
        return {};
      },
      () => [false],
      { coordinates: [{ kind: 'boolean', optional: false, literals: [false] } as never] },
    );
    expect(results.map((r) => r.mutation)).toContain('invalid-literal');
  });

  it('emits NOTHING for `boolean`, which is not a domain', () => {
    // `true | false` is one type to a caller. The exclusion belongs to the emitter, and this asserts
    // the probe agrees: a two-value boolean domain has no outside to send.
    const results = probeContract(
      (...args: unknown[]) => args[0],
      () => [true],
      {
        coordinates: [{ kind: 'boolean', optional: false, literals: [true, false] } as never],
      },
    );
    expect(results.map((r) => r.mutation)).not.toContain('invalid-literal');
  });

  it('reaches a singleton boolean on a NESTED FIELD, not only a scalar argument', () => {
    const nested = (...args: unknown[]): unknown => {
      const input = args[0] as Record<string, unknown>;
      if (typeof input['enabled'] !== 'boolean') throw new TypeError('enabled must be a boolean');
      return input;
    };
    const results = probeContract(nested, () => [{ enabled: true }], {
      coordinates: [
        {
          kind: 'object',
          optional: false,
          fields: [{ name: 'enabled', kind: 'boolean', optional: false, literals: [true] }],
        } as never,
      ],
    });
    const literal = results.filter((r) => r.mutation === 'invalid-literal');
    expect(literal.map((r) => r.field)).toContain('enabled');
    expect(literal[0]!.verdict).toBe('accepted');
  });
});

/**
 * `null` IS NOT A SECOND SPELLING OF OMISSION — and no other mutation can see the guard that
 * treats it as one.
 *
 * The defect class (found live in the 52f4e422e review): a guard reading
 * `if (v === undefined || v === null) return` accepts a value the declaration refuses, while
 * rejecting `wrong-type`'s string — so the boundary published as enforced on exactly the dimension
 * it is not. `ensureFiniteWhenPresent` shipped that shape for months, and the statistics options
 * validator copied it. Nulls arrive this way in practice: `JSON.stringify(NaN)` is null, a LEFT
 * JOIN is null, and a producer that "clears" a field writes null.
 */
describe('null-when-nonnullable', () => {
  const NULLABLE_TREE = [
    { name: 'spot', type: 'number', kind: 'numeric', optional: false, nullable: false },
    { name: 'cap', type: 'number | null', kind: 'numeric', optional: true, nullable: true },
    { name: 'floor', type: 'number', kind: 'numeric', optional: true, nullable: false },
  ];

  const probeNulls = (
    target: (input: Record<string, unknown>) => unknown,
    argument: Record<string, unknown>,
  ) =>
    probeContract(
      (...args: unknown[]) => target(args[0] as Record<string, unknown>),
      () => [{ ...argument }],
      { coordinates: [{ kind: 'object', optional: false, fields: NULLABLE_TREE }] },
    ).filter((r) => r.mutation === 'null-when-nonnullable');

  /** Honours the ruling: undefined omits, null rejects, declared-nullable null is welcome. */
  const strictNulls = (input: Record<string, unknown>): number => {
    for (const key of ['spot', 'floor']) {
      if (key in input && input[key] === null) throw new TypeError(`${key} must not be null`);
    }
    if (typeof input['spot'] !== 'number') throw new TypeError('spot must be a number');
    return input['spot'];
  };

  /** The defect shape: `v == null` reads as absence, so null sails through. */
  const lenientNulls = (input: Record<string, unknown>): number => {
    if (input['spot'] === undefined || input['spot'] === null) return 0;
    if (typeof input['spot'] !== 'number') throw new TypeError('spot must be a number');
    return input['spot'];
  };

  it('fires on a non-nullable REQUIRED field and a non-nullable ABSENT optional', () => {
    const fields = probeNulls(strictNulls, { spot: 100 }).map((r) => r.field);
    expect(fields).toContain('spot');
    expect(fields).toContain('floor');
  });

  it('does NOT fire on a field whose declaration admits null', () => {
    const fields = probeNulls(strictNulls, { spot: 100, cap: 5 }).map((r) => r.field);
    expect(fields).not.toContain('cap');
  });

  it('a boundary that rejects null refuses every probe', () => {
    expect(probeNulls(strictNulls, { spot: 100 }).every((r) => r.verdict !== 'accepted')).toBe(
      true,
    );
  });

  it('a guard that early-returns on null ACCEPTS — the zero is not vacuous', () => {
    const spot = probeNulls(lenientNulls, { spot: 100 }).find((r) => r.field === 'spot');
    expect(spot?.verdict).toBe('accepted');
  });

  it('is the ONLY mutation that can tell null-as-absence apart from a type check', () => {
    // `lenientNulls` rejects a string spot (wrong-type reads as enforcement) while accepting null.
    const all = probeContract(
      (...args: unknown[]) => lenientNulls(args[0] as Record<string, unknown>),
      () => [{ spot: 100 }],
      { coordinates: [{ kind: 'object', optional: false, fields: NULLABLE_TREE }] },
    );
    const spotVerdicts = new Map(
      all.filter((r) => r.field === 'spot').map((r) => [r.mutation, r.verdict]),
    );
    expect(spotVerdicts.get('wrong-type')).not.toBe('accepted');
    expect(spotVerdicts.get('null-when-nonnullable')).toBe('accepted');
  });

  it('marks every probe DECLARED, so it can convict', () => {
    expect(probeNulls(lenientNulls, { spot: 100 }).every((r) => r.declared === true)).toBe(true);
  });

  it('no committed failure convicts a boundary for accepting null on a DECLARED-NULLABLE field', () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')) as {
        enforcement?: {
          id: string;
          failures?: { mutation: string; field?: string }[];
        }[];
      } & ManifestArtifact;
    const enforcement = read('public-enforcement.json');
    const contracts = read('public-contracts.json');
    const byId = new Map((contracts.contracts ?? []).map((r) => [r.id, r]));

    // A path reachable through several arms is nullable if ANY route admits null — the probe must
    // not have fired there, so one nullable occurrence is enough to make a conviction wrong.
    const nullablePaths = (id: string): Set<string> => {
      const nullable = new Set<string>();
      for (const signature of byId.get(id)?.signatures ?? []) {
        for (const parameter of signature.parameters ?? []) {
          walkManifest(parameter, ({ node, route }) => {
            const path = route
              .filter((step): step is { property: string } => 'property' in step)
              .map((step) => step.property)
              .join('.');
            if (path.length === 0) return;
            if ((node as { nullable?: boolean }).nullable === true) nullable.add(path);
          });
        }
      }
      return nullable;
    };

    const convicted: string[] = [];
    for (const row of enforcement.enforcement ?? []) {
      if (!row.failures?.length) continue;
      const nullable = nullablePaths(row.id);
      for (const failure of row.failures) {
        if (failure.mutation !== 'null-when-nonnullable' || !failure.field) continue;
        if (nullable.has(failure.field)) convicted.push(`${row.id} — ${failure.field}`);
      }
    }
    expect(
      convicted.slice(0, 20),
      `${convicted.length} recorded failures convict a boundary for accepting null on a field ` +
        'whose own declaration admits it',
    ).toEqual([]);
  });
});
