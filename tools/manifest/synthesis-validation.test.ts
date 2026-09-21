/**
 * The static baseline validator must be able to FAIL.
 *
 * `incompleteBaseline` checks a synthesized request against the declaration it was built from, before
 * the boundary is called: every required field present, no undeclared key. Across the whole library it
 * currently reports nothing, and that is the useful result — it means the 93 `baseline-rejected`
 * records are contracts refusing well-formed requests rather than the harness handing them malformed
 * ones, which is the only reading under which a rejection says anything about the library.
 *
 * A validator that always passes would report exactly the same thing. So these fixtures prove it
 * distinguishes the cases it claims to, and keep proving it: without them, a bug that made it return
 * `null` unconditionally would look like good news.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPTS,
  synthesizeCall,
  baselineGap,
  baselineGapFingerprint,
  incompleteBaseline,
  satisfiedBranch,
  enumerateVariants,
  synthesizeArguments,
  type SynthesisField,
  type SynthesisParameter,
} from './contract-synthesis.js';

const declared: SynthesisParameter[] = [
  {
    name: 'input',
    type: 'Req',
    optional: false,
    kind: 'object',
    fieldTree: [
      { name: 'spot', type: 'number', kind: 'numeric', optional: false, nullable: false },
      { name: 'note', type: 'string', kind: 'string', optional: true, nullable: false },
      {
        name: 'nested',
        type: 'Inner',
        kind: 'object',
        optional: true,
        nullable: false,
        fields: [
          { name: 'depth', type: 'number', kind: 'numeric', optional: false, nullable: false },
        ],
      },
    ],
  },
];

/** Arm kinds for which a bare scalar is a LEGAL value, so a validator must not convict one. */
const SCALAR_ARM_KINDS = new Set(['numeric', 'primitive', 'string', 'enum', 'boolean']);

describe('static baseline validation (R11)', () => {
  it('accepts a complete request', () => {
    expect(incompleteBaseline(declared, [{ spot: 100 }])).toBeNull();
  });

  it('catches a MISSING required field', () => {
    expect(incompleteBaseline(declared, [{ note: 'x' }])).toMatch(/spot is required/);
  });

  it('catches an UNDECLARED key — the harness inventing a field is a synthesis bug', () => {
    expect(incompleteBaseline(declared, [{ spot: 100, qzxBogus: 1 }])).toMatch(/not declared/);
  });

  it('allows a declared optional to be present or absent', () => {
    expect(incompleteBaseline(declared, [{ spot: 100, note: 'x' }])).toBeNull();
    expect(incompleteBaseline(declared, [{ spot: 100 }])).toBeNull();
  });

  it('descends into a nested object it chose to supply', () => {
    // Omitting the optional `nested` is fine; supplying it without its required member is not.
    expect(incompleteBaseline(declared, [{ spot: 100, nested: {} }])).toMatch(
      /nested\.depth is required/,
    );
    expect(incompleteBaseline(declared, [{ spot: 100, nested: { depth: 1 } }])).toBeNull();
  });
});

describe('callback return synthesis', () => {
  it('builds a callable whose unconstrained array return has a valid empty baseline', () => {
    const parameters: SynthesisParameter[] = [
      {
        name: 'entry',
        type: 'Entry',
        optional: false,
        kind: 'object',
        fieldTree: [
          {
            name: 'indicator',
            type: 'AnyIndicator',
            kind: 'function',
            optional: false,
            nullable: false,
            callSignature: { parameters: 2, returns: 'Array<any>' },
            returns: {
              name: '()',
              type: 'Array<any>',
              kind: 'array',
              optional: false,
              nullable: false,
              element: {
                name: '[]',
                type: 'any',
                kind: 'other',
                optional: false,
                nullable: false,
              },
            },
          },
        ],
      },
    ];

    const args = synthesizeArguments(parameters, [], 0);
    expect(args).not.toBeNull();
    const indicator = (args![0] as { indicator: (...values: unknown[]) => unknown }).indicator;
    expect(indicator([], {})).toEqual([]);
  });
});

/**
 * A ROOT UNION parameter — the half of this the harness could not see.
 *
 * `fieldTree` for a discriminated union is what every branch SHARES, so for `SSVIPhi` it is `{ kind }`
 * alone. Synthesis built that, the boundary said "phi.lambda is required", and `phiValue` was filed
 * `unmeasured / baseline-rejected` — a measurable contract recorded as unmeasurable. Both halves of the
 * harness now read a union the same way: build ONE branch, and accept a value that satisfies ONE branch.
 *
 * The failure these guard against is subtle, because it is a DISAGREEMENT rather than a crash. If only
 * the builder were union-aware, every union baseline would be rejected by the validator as undeclared;
 * if only the validator were, nothing would change at all. Each direction is asserted separately below.
 */
const unionDeclared: SynthesisParameter[] = [
  {
    name: 'phi',
    type: 'PowerLaw | HestonLike',
    optional: false,
    kind: 'object',
    // What every branch shares — and what the harness used to build from.
    fieldTree: [{ name: 'kind', type: 'string', kind: 'string', optional: false, nullable: false }],
    branches: [
      {
        type: 'PowerLaw',
        kind: 'object',
        fields: [
          { name: 'kind', type: 'string', kind: 'string', optional: false, nullable: false },
          { name: 'eta', type: 'number', kind: 'numeric', optional: false, nullable: false },
          { name: 'gamma', type: 'number', kind: 'numeric', optional: false, nullable: false },
        ],
      },
      {
        type: 'HestonLike',
        kind: 'object',
        fields: [
          { name: 'kind', type: 'string', kind: 'string', optional: false, nullable: false },
          { name: 'lambda', type: 'number', kind: 'numeric', optional: false, nullable: false },
        ],
      },
    ],
  },
];

describe('union-aware baseline synthesis (#369)', () => {
  it('BUILDS one branch, not the merged tree', () => {
    const args = synthesizeArguments(unionDeclared, [], 0);
    expect(args, 'a union parameter must still synthesize').not.toBeNull();
    const phi = (args as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(phi).sort()).toEqual(['eta', 'gamma', 'kind']);
  });

  /**
   * SUPERSEDED BY RV14 P0-5, and the replacement is stronger.
   *
   * #369 made `attempt` walk the branches, so a refused branch was not the end of the road. That
   * bought coverage and cost identity: one counter selected the union branch, the curated value
   * alternative AND the admitted optionals, and because measurement returns the moment a baseline
   * runs, a HEALTHY union was measured on branch 0 and never revisited. Every branch is now
   * enumerated as its own variant and measured on its own, so retry no longer has to carry it.
   *
   * The property #369 existed for is preserved and widened — a refused branch is not the end of the
   * road because the OTHER branches are measured regardless, not because attempt 1 stumbles onto
   * one. See `variant-measurement.test.ts`.
   */
  it('does NOT let `attempt` change the branch — retry walks VALUES, not alternatives', () => {
    const second = synthesizeArguments(unionDeclared, [], 1) as unknown[];
    expect(
      Object.keys(second[0] as Record<string, unknown>).sort(),
      'attempt must not silently re-select the union branch',
    ).toEqual(['eta', 'gamma', 'kind']);
    // Attempts beyond the branch count still synthesize rather than producing nothing.
    const beyond = synthesizeArguments(unionDeclared, [], ATTEMPTS) as unknown[];
    expect(beyond[0]).toBeDefined();
  });

  it('enumerates EVERY branch as its own variant, which is what replaced the retry', () => {
    const { variants } = enumerateVariants(unionDeclared, []);
    expect(variants).toHaveLength(2);
    const other = variants[1]!;
    const built = synthesizeArguments(
      unionDeclared,
      [],
      0,
      undefined,
      other.selection,
    ) as unknown[];
    expect(Object.keys(built[0] as Record<string, unknown>).sort()).toEqual(['kind', 'lambda']);
  });

  it('ACCEPTS a value satisfying one branch, which the merged tree calls undeclared', () => {
    expect(
      incompleteBaseline(unionDeclared, [{ kind: 'power-law', eta: 1, gamma: 0.5 }]),
    ).toBeNull();
    expect(incompleteBaseline(unionDeclared, [{ kind: 'heston-like', lambda: 1 }])).toBeNull();
  });

  it('still REJECTS a value satisfying no branch — and says so', () => {
    const gap = incompleteBaseline(unionDeclared, [{ kind: 'power-law', eta: 1 }]);
    expect(gap).toMatch(/satisfies no branch/);
    // Every branch's own complaint is named, because no single branch's is the right one to report.
    expect(gap).toMatch(/gamma is required/);
    expect(gap).toMatch(/lambda is required/);
  });

  it('does not mistake a MIXTURE of two branches for a valid value', () => {
    // `eta` belongs to branch 0 and `lambda` to branch 1; neither branch declares both.
    expect(incompleteBaseline(unionDeclared, [{ kind: 'x', eta: 1, gamma: 1, lambda: 1 }])).toMatch(
      /satisfies no branch/,
    );
  });

  /**
   * Bound to the LIVE artifact, so the unit fixtures above cannot drift away from the thing they
   * describe. If `SSVIPhi` stops being a union, or the generator stops recording its branches, this
   * fails rather than leaving four green tests describing a shape that no longer exists.
   */
  it('describes a union the generator actually records', () => {
    const artifact = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as {
      contracts?: {
        id: string;
        signatures?: { parameters?: { name: string; branches?: unknown[] }[] }[];
      }[];
    };
    const record = (artifact.contracts ?? []).find(
      (r) => r.id === '@totalfinance/volatility:phiValue',
    );
    expect(record, 'phiValue is no longer in the artifact').toBeDefined();
    const phi = record?.signatures?.[0]?.parameters?.[0];
    expect(phi?.name).toBe('phi');
    expect(phi?.branches?.length, 'SSVIPhi no longer records its branches').toBe(2);
  });
});

/**
 * A GENERIC STRING is `'x'` — and `'x'` is never a date.
 *
 * `'x'` is the right last resort for a free-form string and a guaranteed failure for a date-typed one,
 * which is what twelve boundaries were answering: `Invalid ISO date "x" (expected YYYY-MM-DD)`,
 * `could not parse expiry "x"`. The fallback now reads the NAME, and only at the three places a
 * generic string is produced — a field tree, a bare parameter, and the inline-object-type parser —
 * so it can only ever replace a value that was already going to fail.
 *
 * The list of date words is closed on purpose. `period` and `term` are lookbacks far more often than
 * dates, and the asymmetry that makes this safe (a wrong guess costs coverage, never correctness)
 * stops holding once a guess displaces a value that was working.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('the generic string fallback knows a date from a name', () => {
  const stringParameter = (name: string): SynthesisParameter[] => [
    { name, type: 'string', optional: false, kind: 'primitive' },
  ];

  it('gives a date-named PARAMETER an ISO date', () => {
    const [value] = synthesizeArguments(stringParameter('from'), [], 0) as unknown[];
    expect(value).toMatch(ISO_DATE);
  });

  it('leaves a free-form string parameter alone', () => {
    // The failure this guards against is over-reach: widening the default for every string would
    // break the free-form fields that accept 'x' today.
    //
    // The name has to be one the CURATED table has never heard of, or this asserts nothing about the
    // fallback. `label` is curated (it answers `'test'`), and picking it made this fail for the right
    // reason before it could pass for the wrong one.
    const [value] = synthesizeArguments(stringParameter('note'), [], 0) as unknown[];
    expect(value).toBe('x');
  });

  it('gives a date-named FIELD an ISO date, and only that field', () => {
    const parameters: SynthesisParameter[] = [
      {
        name: 'range',
        type: 'Range',
        optional: false,
        kind: 'object',
        fieldTree: [
          { name: 'to', type: 'string', kind: 'string', optional: false, nullable: false },
          { name: 'note', type: 'string', kind: 'string', optional: false, nullable: false },
        ],
      },
    ];
    const [value] = synthesizeArguments(parameters, [], 0) as unknown[];
    const range = value as Record<string, unknown>;
    expect(range['to']).toMatch(ISO_DATE);
    expect(range['note']).toBe('x');
  });

  it('gives a date-named field of an INLINE object type an ISO date', () => {
    // `expirations(calendar, range: { from: string; to: string })` declares this shape nowhere else,
    // so the inline parser IS the contract and was the only site still emitting 'x' for a date.
    const parameters: SynthesisParameter[] = [
      {
        name: 'range',
        type: '{ from: string; note: string }',
        optional: false,
        kind: 'object',
      },
    ];
    const [value] = synthesizeArguments(parameters, [], 0) as unknown[];
    const range = value as Record<string, unknown>;
    expect(range['from']).toMatch(ISO_DATE);
    expect(range['note']).toBe('x');
  });

  it('still honours the `[a-z]Date$` suffix rule it generalizes', () => {
    const [value] = synthesizeArguments(stringParameter('valuationDate'), [], 0) as unknown[];
    expect(value).toMatch(ISO_DATE);
  });
});

/**
 * A CHOICE GROUP — "exactly one of quantity or notional" — is not expressible as requiredness.
 *
 * Every alternative in such a group is correctly declared OPTIONAL, because none of them is
 * individually required. So the minimal required-only baseline supplies NONE of them and is rejected:
 * `SimulatedBroker.submit` wants one of `quantity`/`notional`, `barsFromColumns` wants at least one of
 * `open`/`high`/`low`/`close`/`volume`, `prepareSlices` wants `w` or `impliedVolatility`. The
 * declaration is right and the library is right; the harness had no way to say "one of these".
 *
 * The retry admits the first `attempt` optionals. That is a blunt rule, and what makes it acceptable
 * is WHEN it runs: `measureWithAlternatives` returns the moment a result is anything other than
 * `baseline-rejected`, so attempt 1 exists only because attempt 0 was refused. A wider call can never
 * displace a working baseline — which is exactly why attempt 0 must stay minimal, and the first test
 * below is the one that would catch it if it ever stopped being.
 */
const withOptionals: SynthesisParameter[] = [
  {
    name: 'request',
    type: 'OrderRequest',
    optional: false,
    kind: 'object',
    fieldTree: [
      { name: 'side', type: 'string', kind: 'string', optional: false, nullable: false },
      { name: 'quantity', type: 'number', kind: 'numeric', optional: true, nullable: false },
      { name: 'notional', type: 'number', kind: 'numeric', optional: true, nullable: false },
    ],
  },
];

const built = (attempt: number): Record<string, unknown> =>
  (synthesizeArguments(withOptionals, [], attempt) as unknown[])[0] as Record<string, unknown>;

describe('choice groups: the retry widens, attempt 0 does not', () => {
  it('attempt 0 is still the MINIMAL call — required only', () => {
    // The whole safety argument rests on this. If attempt 0 ever widened, `omit-required` would be
    // probing a request that was never minimal, and every verdict built on it would be describing
    // something else.
    expect(Object.keys(built(0))).toEqual(['side']);
  });

  it('attempt 1 admits ONE optional, which is what satisfies a choice group', () => {
    expect(Object.keys(built(1)).sort()).toEqual(['quantity', 'side']);
  });

  it('attempt 2 admits two, in declaration order', () => {
    expect(Object.keys(built(2)).sort()).toEqual(['notional', 'quantity', 'side']);
  });

  it('never admits more optionals than the contract declares', () => {
    // `attempt` is bounded by ATTEMPTS, but the object is bounded by the declaration.
    expect(Object.keys(built(ATTEMPTS + 5)).sort()).toEqual(['notional', 'quantity', 'side']);
  });

  it('an unbuildable optional is skipped, not fatal', () => {
    // An optional was never required; refusing to build the whole request over one would throw the
    // retry away entirely, which is the opposite of what the retry is for.
    const unbuildable: SynthesisParameter[] = [
      {
        name: 'request',
        type: 'Req',
        optional: false,
        kind: 'object',
        fieldTree: [
          { name: 'side', type: 'string', kind: 'string', optional: false, nullable: false },
          { name: 'weird', type: 'symbol', kind: 'unknown', optional: true, nullable: false },
        ],
      },
    ];
    const args = synthesizeArguments(unbuildable, [], 1);
    expect(args, 'an unbuildable optional must not sink the request').not.toBeNull();
    expect(Object.keys((args as unknown[])[0] as Record<string, unknown>)).toEqual(['side']);
  });
});

/**
 * A UNION HAS THREE READERS, and all of them must pick the same branch.
 *
 * #369 made the BUILDER build one branch and the VALIDATOR accept one branch, and missed that the
 * PROBE reads the same parameter through a third path — `fieldTrees`. Handed the merged tree, a field
 * that exists only on the chosen branch is not "declared", so its mutations are emitted without
 * authority and cannot convict: `strategyFromChain` accepted deletion of `wingWidth`, which its branch
 * declares REQUIRED, and the harness recorded that as advisory.
 *
 * Selection is by VALUE, not by index, because the two callers choose branches differently: synthesis
 * retries onto later branches via `attempt`, and a hand-written fixture picks whatever branch it likes.
 */
describe('satisfiedBranch: the probe reads the branch the value satisfies', () => {
  const parameter = {
    fieldTree: [{ name: 'kind', type: 'string', kind: 'string', optional: false, nullable: false }],
    branches: [
      {
        type: '',
        kind: 'object',
        fields: [
          { name: 'kind', type: 'string', kind: 'string', optional: false, nullable: false },
          { name: 'eta', type: 'number', kind: 'numeric', optional: false, nullable: false },
        ],
      },
      {
        type: '',
        kind: 'object',
        fields: [
          { name: 'kind', type: 'string', kind: 'string', optional: false, nullable: false },
          { name: 'lambda', type: 'number', kind: 'numeric', optional: false, nullable: false },
        ],
      },
    ],
  };

  it('picks the branch the value satisfies, not the first one', () => {
    expect(satisfiedBranch(parameter, { kind: 'h', lambda: 1 })?.map((f) => f.name)).toEqual([
      'kind',
      'lambda',
    ]);
    expect(satisfiedBranch(parameter, { kind: 'p', eta: 1 })?.map((f) => f.name)).toEqual([
      'kind',
      'eta',
    ]);
  });

  it('falls back to the merged tree when no branch matches', () => {
    // Today's behaviour, preserved deliberately: an unmatched value or a misaligned argument index
    // must not lose the contract altogether, only the extra authority the branch would have given.
    expect(
      satisfiedBranch(parameter, { kind: 'x', eta: 1, lambda: 1 })?.map((f) => f.name),
    ).toEqual(['kind']);
  });

  it('returns the declared tree unchanged for a parameter that is not a union', () => {
    const plain = {
      fieldTree: [
        { name: 'spot', type: 'number', kind: 'numeric', optional: false, nullable: false },
      ],
    };
    expect(satisfiedBranch(plain, { spot: 1 })).toBe(plain.fieldTree);
  });
});

/**
 * THE REVIEWER'S COUNTEREXAMPLE, kept as a test.
 *
 * `{ type: 'coveredCall', shortDelta: 0.3 }` satisfies the `strangle` branch's key set exactly —
 * both declare `type` and `shortDelta` — so key-only matching attributed a coveredCall call to a
 * strangle's contract. Every field the two branches do NOT share then went unexamined, while the
 * record showed a measured boundary. A union carries a discriminator precisely so this question has
 * one answer, and the answer must not depend on branch order.
 */
describe('satisfiedBranch selects by discriminator, not by key set', () => {
  const parameter = {
    fieldTree: [{ name: 'type', type: 'string', kind: 'enum', optional: false, nullable: false }],
    branches: [
      {
        type: '',
        kind: 'object',
        fields: [
          {
            name: 'type',
            type: 'string',
            kind: 'enum',
            optional: false,
            nullable: false,
            literals: ['strangle'],
          },
          { name: 'shortDelta', type: 'number', kind: 'numeric', optional: false, nullable: false },
        ],
      },
      {
        type: '',
        kind: 'object',
        fields: [
          {
            name: 'type',
            type: 'string',
            kind: 'enum',
            optional: false,
            nullable: false,
            literals: ['coveredCall'],
          },
          { name: 'shortDelta', type: 'number', kind: 'numeric', optional: false, nullable: false },
          { name: 'stockPrice', type: 'number', kind: 'numeric', optional: true, nullable: false },
        ],
      },
    ],
  };

  it('picks coveredCall for a coveredCall value, though strangle fits the keys first', () => {
    const chosen = satisfiedBranch(parameter, { type: 'coveredCall', shortDelta: 0.3 });
    expect(chosen?.map((f) => f.name).sort()).toEqual(['shortDelta', 'stockPrice', 'type']);
  });

  it('still picks strangle for a strangle value', () => {
    const chosen = satisfiedBranch(parameter, { type: 'strangle', shortDelta: 0.3 });
    expect(chosen?.map((f) => f.name).sort()).toEqual(['shortDelta', 'type']);
  });

  it('prefers the branch that MATCHED a discriminator over one that merely fits', () => {
    /**
     * The case that isolates the tiebreak. Eliminating branches whose literals the value contradicts
     * is what fixes the reviewer's counterexample; this is the residue that elimination cannot decide
     * — two branches both admit the value, one because it names the discriminator and one because it
     * declares no literals at all. Without the preference the answer is branch ORDER, which is not a
     * property of the contract.
     */
    const ambiguous = {
      fieldTree: [{ name: 'type', type: 'string', kind: 'enum', optional: false, nullable: false }],
      branches: [
        {
          type: '',
          kind: 'object',
          fields: [
            { name: 'type', type: 'string', kind: 'string', optional: false, nullable: false },
            {
              name: 'shortDelta',
              type: 'number',
              kind: 'numeric',
              optional: false,
              nullable: false,
            },
          ],
        },
        {
          type: '',
          kind: 'object',
          fields: [
            {
              name: 'type',
              type: 'string',
              kind: 'enum',
              optional: false,
              nullable: false,
              literals: ['coveredCall'],
            },
            {
              name: 'shortDelta',
              type: 'number',
              kind: 'numeric',
              optional: false,
              nullable: false,
            },
          ],
        },
      ],
    };
    const chosen = satisfiedBranch(ambiguous, { type: 'coveredCall', shortDelta: 0.3 });
    expect(chosen?.find((f) => f.name === 'type')?.literals).toEqual(['coveredCall']);
  });

  it('refuses to attribute a value to a branch whose literal it contradicts', () => {
    // No branch admits `type: 'qzxBogus'`, so the merged tree is the honest answer — attributing it
    // to branch 0 would measure a contract the value explicitly says it is not.
    const chosen = satisfiedBranch(parameter, { type: 'qzxBogus', shortDelta: 0.3 });
    expect(chosen?.map((f) => f.name)).toEqual(['type']);
  });
});

/**
 * A BASELINE IS A CALL, AND A CALL HAS ARGUMENTS — not just a shape per parameter.
 *
 * `incompleteBaseline` walked the PARAMETERS and skipped every optional non-object one
 * unconditionally, without consuming an argument index. So an optional a hand fixture actually
 * supplied was never validated, and skipping it without advancing misaligned every argument after
 * it — the next parameter was judged against the wrong value. It also never asked what a value IS,
 * so a number where a string is declared, or a member outside a closed set, counted as complete.
 */
describe('baseline validation judges the arguments that were passed', () => {
  const coordinates: SynthesisParameter[] = [
    { name: 'series', type: 'ArrayLike<number>', optional: false, kind: 'series' },
    {
      name: 'source',
      type: 'PriceSource',
      optional: true,
      kind: 'primitive',
      literals: ['bid', 'ask', 'mid'],
    },
    { name: 'window', type: 'number', optional: false, kind: 'numeric' },
  ];

  it('validates an optional the caller SUPPLIED, instead of skipping it', () => {
    expect(incompleteBaseline(coordinates, [[1, 2, 3], 'qzxBogus', 5])).toMatch(
      /source must be one of/,
    );
  });

  it('accepts a supplied optional that IS in the declared domain', () => {
    expect(incompleteBaseline(coordinates, [[1, 2, 3], 'mid', 5])).toBeNull();
  });

  it('catches an absent REQUIRED scalar rather than reading past it', () => {
    // `window` is required and simply not there. The old walk skipped `source` without advancing,
    // so `window` was judged against `source`'s value and the absence went unnoticed.
    expect(incompleteBaseline(coordinates, [[1, 2, 3], 'mid'])).toMatch(/window is required/);
  });

  /**
   * Asserted on the structured GAP, not on the sentence.
   *
   * These matched `/window must be a finite number/` and broke the moment the validator learned to
   * quote the declared type instead — which is the tell that they were testing the prose. `category`
   * and `path` are the machine-comparable facts, and the same reasoning already keys the fixture
   * allowlist.
   */
  it('catches a wrong primitive type in a supplied coordinate', () => {
    const gap = baselineGap(coordinates, [[1, 2, 3], 'mid', 'not-a-number']);
    expect(gap && baselineGapFingerprint(gap)).toBe('wrong-type@window');
  });

  it('catches NaN where a finite number is declared', () => {
    // NaN IS a number, so only a finiteness check can see it — the silent-miscompute class.
    const gap = baselineGap(coordinates, [[1, 2, 3], 'mid', Number.NaN]);
    expect(gap && baselineGapFingerprint(gap)).toBe('wrong-type@window');
  });
});

/**
 * A FIXED-ARITY TUPLE IS NOT A SERIES, and handing it one loses the whole contract.
 *
 * `restoreRandomNumberGenerator` declares `state: [number]` for mulberry32 and
 * `[number, number, number, number]` for xoshiro128ss. Both matched the generic numeric-array
 * fallback, got sixty samples, and the boundary rightly refused them — so a contract whose arity the
 * checker had recorded EXACTLY was filed `unmeasured / baseline-rejected`, once per algorithm.
 *
 * The second fixture is the one that keeps this honest: a variable-length numeric array must still
 * get a series, or "respect the declared arity" would quietly become "never build a series again".
 */
describe('fixed-arity numeric tuples (RV14 P0-3)', () => {
  const tupleField = (type: string): SynthesisParameter[] => [
    {
      name: 'snapshot',
      type: 'Snap',
      optional: false,
      kind: 'object',
      fieldTree: [
        {
          name: 'state',
          type,
          kind: 'array',
          optional: false,
          nullable: false,
          element: {
            name: '[]',
            type: 'number',
            kind: 'numeric',
            optional: false,
            nullable: false,
          },
        },
      ],
    },
  ];

  const stateOf = (type: string): unknown[] => {
    const args = synthesizeArguments(tupleField(type), [], 0) as unknown[];
    return (args[0] as { state: unknown[] }).state;
  };

  it('builds exactly the declared number of elements', () => {
    expect(stateOf('[number]')).toEqual([1]);
    expect(stateOf('[number, number, number, number]')).toEqual([1, 2, 3, 4]);
    expect(stateOf('readonly [number, number]')).toEqual([1, 2]);
  });

  it('never starts a state word at zero — an all-zero PRNG state is degenerate', () => {
    expect((stateOf('[number, number, number, number]') as number[]).every((n) => n > 0)).toBe(
      true,
    );
  });

  it('still builds a SERIES for a variable-length numeric array', () => {
    // The guard against over-fitting: `number[]` is genuinely variable and a two-element answer
    // would refuse every windowed indicator in the library.
    expect(stateOf('number[]').length).toBeGreaterThan(8);
    expect(stateOf('ArrayLike<number>').length).toBeGreaterThan(8);
  });
});

/**
 * THE VALIDATOR MUST CONVICT ON THE SHAPE THE LIBRARY ACTUALLY DECLARES.
 *
 * The first version of these fixtures used INLINE types — `{ spot: number }`, `ArrayLike<number>` —
 * and passed. Real coordinates are NAMED: `Matrix`, `CommissionInput`, `OptionQuote`. A named type
 * cannot be judged from its text, the check abstained, and an adversarial sweep of all 9,846 shipped
 * coordinates found `42` accepted as a valid baseline at 97.9% of object coordinates — 100% of those
 * carrying a field tree. `@totalfinance/math:determinant`, the function the review itself names, accepted
 * `42`, `"nonsense"` and `{ totally: 'wrong' }`.
 *
 * A check proved only on shapes the library does not contain is the failure this phase keeps finding,
 * and these fixtures exist because it was reintroduced by the fix for it.
 */
describe('named-type coordinates convict (RV16)', () => {
  const named = (name: string, type: string, kind: string): SynthesisParameter[] => [
    { name, type, kind, optional: false },
  ];

  it('an object coordinate declared by NAME rejects a scalar', () => {
    const gap = baselineGap(named('input', 'CommissionInput', 'object'), [42]);
    expect(gap && baselineGapFingerprint(gap)).toBe('wrong-type@input');
  });

  it('a series coordinate declared by NAME rejects a scalar and an object', () => {
    expect(baselineGap(named('matrix', 'Matrix', 'series'), [42])).not.toBeNull();
    expect(baselineGap(named('matrix', 'Matrix', 'series'), [{ totally: 'wrong' }])).not.toBeNull();
  });

  it('an OPTIONAL coordinate is still type-checked when it is supplied', () => {
    // `| undefined` used to abstain the entire check, exempting every optional coordinate in the
    // library — including explicitly judgeable ones. Optionality is about ABSENCE, not about what a
    // present value may be.
    expect(
      baselineGap(named('xs', 'ArrayLike<number> | undefined', 'series'), [0.2]),
    ).not.toBeNull();
    expect(
      baselineGap(named('input', 'CommissionInput | undefined', 'object'), [42]),
    ).not.toBeNull();
    // ...and omitting it is still fine.
    expect(
      baselineGap(
        [{ name: 'xs', type: 'ArrayLike<number> | undefined', kind: 'series', optional: true }],
        [],
      ),
    ).toBeNull();
  });

  it('ABSTAINS where a union has an unjudgeable member that might accept the value', () => {
    /**
     * The guard against over-reach, and it is load-bearing: `readSnapshot(expected: Kind |
     * ReadonlyArray<Kind>)` legitimately takes a bare `Kind`, which the array arm alone would refuse.
     * Convicting on a partial reading is how an earlier attempt produced 141 false gaps.
     */
    expect(
      baselineGap(named('expected', 'Kind | ReadonlyArray<Kind>', 'series'), ['sma']),
    ).toBeNull();
  });

  it('does not convict a lossy `kind` when the TYPE TEXT can decide', () => {
    // `asOf` is recorded `kind: numeric` and declared `string | number`; the text is judgeable, so it
    // decides and the summary is ignored. This is why `kind` is consulted only as a last resort.
    expect(baselineGap(named('asOf', 'string | number', 'numeric'), ['2026-01-02'])).toBeNull();
  });

  it('recognizes an array-returning callback as a callback, not as its return array', () => {
    const residuals = named('residuals', '(p: number[]) => number[]', 'callback');
    expect(baselineGap(residuals, [(p: number[]) => [p[0] ?? 0]])).toBeNull();
    expect(baselineGap(residuals, [[1]])?.category).toBe('wrong-type');
  });

  it('recognizes an object containing a callback as the object, not as its callback field', () => {
    const parameters = named(
      'parameters',
      '{ combine: (x: number, y: number) => number; kind: string; }',
      'object',
    );
    expect(
      baselineGap(parameters, [{ combine: (x: number, y: number) => x + y, kind: 'sum' }]),
    ).toBeNull();
    expect(baselineGap(parameters, [(x: number) => x])?.category).toBe('wrong-type');
  });
});

describe('the validator catches malformed calls across the REAL surface', () => {
  it('convicts a scalar at ≥99% of declared object coordinates', () => {
    /**
     * A library-wide bound, because a hand-made fixture cannot tell "the code path works" from "the
     * code path fires on the shapes we actually ship". The measured rate was 2.1% while five
     * hand-written cases all passed.
     */
    const artifact = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as { contracts: { signatures?: { parameters?: SynthesisParameter[] }[] }[] };
    let total = 0;
    let caught = 0;
    for (const record of artifact.contracts) {
      for (const parameter of record.signatures?.[0]?.parameters ?? []) {
        if (parameter.kind !== 'object') continue;
        total += 1;
        if (baselineGap([parameter], [42]) !== null) caught += 1;
      }
    }
    expect(total, 'no object coordinates found — the sweep is vacuous').toBeGreaterThan(1000);
    /**
     * EXACT, not a percentage. `> 0.99` permitted thirteen known misses across five real union
     * contracts — `restoreRandomNumberGenerator`, `deflatedSharpeRatio`, `spectralRisk`,
     * `strategyFromChain`, `phiValue` — because a bound expressed as a rate cannot tell an
     * unjudgeable coordinate from a judgeable one the walk simply failed to reach.
     */
    expect(total - caught, 'object coordinates that accept a scalar as a valid baseline').toBe(0);
  });

  it('convicts a scalar at every NESTED union field too, not only at parameter roots', () => {
    /**
     * The same sweep, RECURSIVELY — and the class the parameter-root version could not see.
     *
     * Field unions recorded their branch types under a different name from parameter unions
     * (`branches` versus `branchTypes`), and the recursive validator read only the parameter-level
     * one. So every field union arrived with no type text, every branch was judged as a bare shape,
     * and `objectGap` — which returns "valid" for anything that is not a plain object — accepted a
     * scalar. A recursive audit found 57 nested field-union occurrences in the committed trees and
     * ALL 57 accepted `42`.
     *
     * A gate that only checks the roots is how a whole class stays invisible while the number it
     * reports reads as complete. One name, one validator, one sweep, at every depth.
     */
    const artifact = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as { contracts: { id: string; signatures?: { parameters?: SynthesisParameter[] }[] }[] };

    /** Every nested union field, as a parameter the validator can be asked about directly. */
    const unionFields = (
      fields: readonly SynthesisField[] | undefined,
      depth = 0,
    ): SynthesisField[] => {
      if (!fields || depth > 6) return [];
      return fields.flatMap((field) => [
        ...((field.branches?.length ?? 0) > 1 ? [field] : []),
        ...unionFields(field.fields, depth + 1),
        ...unionFields(field.element ? [field.element] : undefined, depth + 1),
        ...(field.branches ?? []).flatMap((arm) => unionFields(arm.fields ?? [], depth + 1)),
      ]);
    };

    let total = 0;
    let caught = 0;
    for (const record of artifact.contracts) {
      for (const parameter of record.signatures?.[0]?.parameters ?? []) {
        const nested = [
          ...unionFields(parameter.fieldTree),
          ...(parameter.branches ?? []).flatMap((arm) => unionFields(arm.fields ?? [])),
          ...unionFields(parameter.elementFieldTree),
        ];
        for (const field of nested) {
          /**
           * A union WITH A SCALAR ARM must accept a scalar — convicting it would be the defect.
           *
           * This sweep predates non-object arms being recorded at all. While the inventory only kept
           * a union whose arms expanded to named members, "nested union field" implied "union of
           * shapes", and demanding that it reject `42` was sound. Now that every arm is recorded,
           * `perUnitTurnover: number | Array<number>` is in the population — and `42` satisfies its
           * `number` arm exactly. Eighteen occurrences, all that one declaration.
           *
           * So the claim is narrowed to what it always meant: a union that admits NO scalar must not
           * accept one. Skipping is counted out of `total` rather than into `caught`, so a shrinking
           * population still trips the vacuity floor below.
           */
          if ((field.branches ?? []).some((arm) => SCALAR_ARM_KINDS.has(arm.kind))) continue;
          total += 1;
          const asParameter: SynthesisParameter = {
            name: field.name,
            type: field.type,
            optional: false,
            kind: field.kind,
            ...(field.branches ? { branches: field.branches } : {}),
          };
          if (baselineGap([asParameter], [42]) !== null) caught += 1;
        }
      }
    }
    expect(total, 'no nested union fields found — the recursive sweep is vacuous').toBeGreaterThan(
      20,
    );
    expect(total - caught, 'nested union fields that accept a scalar as a valid baseline').toBe(0);
  });
});

describe('positional holes are preserved (RV17)', () => {
  /**
   * JavaScript BINDS BY POSITION, and the builder was compacting.
   *
   * `adjustDate(date, convention?, calendar?)` synthesized `[date, calendar]` with coordinates
   * labelled `[date, calendar]` — so the runtime received the calendar object as `convention`, and
   * `calendar` kept its default. The call returned early (the synthesized date is a business day),
   * nothing threw, and every mutation of argument 1 was filed as Calendar enforcement evidence about
   * an argument the function never saw as a calendar.
   */
  const params: SynthesisParameter[] = [
    { name: 'date', type: 'string', kind: 'primitive', optional: false },
    { name: 'convention', type: 'BusinessDayConvention', kind: 'primitive', optional: true },
    {
      name: 'calendar',
      type: 'Calendar',
      kind: 'object',
      optional: true,
      // A buildable shape, like the real `Calendar`. An empty tree builds nothing, and the
      // trailing-hole trim would then correctly remove the hole with it.
      fieldTree: [
        { name: 'name', type: 'string', kind: 'string', optional: false, nullable: false },
      ],
    },
  ];

  it('leaves an `undefined` hole where an optional was skipped', () => {
    const built = synthesizeCall(params, []);
    expect(built?.args).toHaveLength(3);
    expect(built?.args[1]).toBeUndefined();
  });

  it('labels coordinates by REAL javascript argument index', () => {
    const built = synthesizeCall(params, []);
    expect(built?.coordinates.map((coordinate) => coordinate.name)).toEqual([
      'date',
      'convention',
      'calendar',
    ]);
  });

  it('trims only TRAILING holes, so no coordinate describes an unpassed argument', () => {
    // With the object dropped there is nothing after the hole, and a caller would write `f(date)`.
    const trailing: SynthesisParameter[] = [params[0]!, params[1]!];
    const built = synthesizeCall(trailing, []);
    expect(built?.args).toHaveLength(1);
    expect(built?.coordinates.map((coordinate) => coordinate.name)).toEqual(['date']);
  });
});

describe('unions and tuples are validated, not waved through (RV17)', () => {
  it('a scalar satisfies NO object branch of a union', () => {
    // `objectGap` returns null — "valid" — for anything that is not a plain object, so every object
    // branch was satisfied vacuously and `42` was certified against five real union contracts.
    const union: SynthesisParameter[] = [
      {
        name: 'input',
        type: 'A | B',
        kind: 'object',
        optional: false,
        branches: [
          {
            type: 'A',
            kind: 'object',
            fields: [
              { name: 'a', type: 'number', kind: 'numeric', optional: false, nullable: false },
            ],
          },
          {
            type: 'B',
            kind: 'object',
            fields: [
              { name: 'b', type: 'number', kind: 'numeric', optional: false, nullable: false },
            ],
          },
        ],
      },
    ];
    expect(baselineGap(union, [42])).not.toBeNull();
    expect(baselineGap(union, [{ a: 1 }])).toBeNull();
  });

  it('a NON-OBJECT branch still accepts its own value', () => {
    // The first version of the branch fix filtered to object branches and immediately broke
    // `classifyStrategy`: two of its three alternatives are arrays, so a correct array baseline had
    // no branch left to satisfy and the harness called its own good call malformed.
    const mixed: SynthesisParameter[] = [
      {
        name: 'legs',
        type: 'Position | ReadonlyArray<number>',
        kind: 'series',
        optional: false,
        branches: [
          {
            type: 'Position',
            kind: 'object',
            fields: [
              { name: 'q', type: 'number', kind: 'numeric', optional: false, nullable: false },
            ],
          },
          { type: 'ReadonlyArray<number>', kind: 'array' },
        ],
      },
    ];
    expect(baselineGap(mixed, [[1, 2, 3]])).toBeNull();
    expect(baselineGap(mixed, [{ q: 1 }])).toBeNull();
    expect(baselineGap(mixed, ['neither'])).not.toBeNull();
  });

  it('a fixed tuple checks ARITY and each POSITION', () => {
    const tuple: SynthesisParameter[] = [
      { name: 'p', type: '[string, number]', kind: 'array', optional: false },
    ];
    expect(baselineGap(tuple, [['ok', 1]]), 'a valid pair must pass').toBeNull();
    expect(baselineGap(tuple, [[42, 'wrong']]), 'swapped positions').not.toBeNull();
    expect(baselineGap(tuple, [['ok']]), 'too short').not.toBeNull();
    expect(baselineGap(tuple, [['ok', 1, 2]]), 'too long').not.toBeNull();
  });

  it('builds an array of tuples position by position', () => {
    // `Array<[string, number]>` was producing sixty-element arrays of `"x"` — the element's own
    // element type won and the tuple's positions were never expressed. Both halves of the harness
    // were wrong in the same direction, so nothing caught it.
    const field: SynthesisParameter[] = [
      {
        name: 'input',
        type: 'Req',
        kind: 'object',
        optional: false,
        fieldTree: [
          {
            name: 'forwards',
            type: 'Array<[string, number]>',
            kind: 'array',
            optional: false,
            nullable: false,
            element: {
              name: '[]',
              type: '[string, number]',
              kind: 'array',
              optional: false,
              nullable: false,
            },
          },
        ],
      },
    ];
    const built = synthesizeCall(field, []);
    const forwards = (built?.args[0] as { forwards: unknown[] }).forwards;
    expect(forwards[0]).toEqual(['x', 1]);
    expect(baselineGap(built!.coordinates, built!.args)).toBeNull();
  });
});

describe('a tuple is validated by ARITY and by each POSITION, and legal tuples are accepted', () => {
  const tuple = (type: string): SynthesisParameter => ({
    name: 'pair',
    type,
    optional: false,
    kind: 'series',
  });
  const judge = (type: string, value: unknown) => baselineGap([tuple(type)], [value]);

  it('accepts a union POSITION rather than reading it as extra positions', () => {
    /**
     * `tupleMemberTypes` replaced every comma with a pipe and split on that, so
     * `[string | number, boolean]` read as THREE positions and the legal value `['ok', false]` was
     * rejected as "declares exactly 3 elements, got 2". A validator refusing a call TypeScript
     * accepts is the same class of error as accepting one it does not — it just fails the other way.
     */
    expect(judge('[string | number, boolean]', ['ok', false])).toBeNull();
    expect(judge('[string | number, boolean]', [1, true])).toBeNull();
    expect(judge('[string | number, boolean]', [true, true])?.category).toBe('wrong-type');
  });

  it('still convicts arity and per-position type errors', () => {
    expect(judge('[string, number]', ['ok', 1])).toBeNull();
    expect(judge('[string, number]', [42, 'wrong'])?.category).toBe('wrong-type');
    expect(judge('[string, number]', ['ok'])?.category).toBe('wrong-type');
    expect(judge('[string, number]', ['ok', 1, 2])?.category).toBe('wrong-type');
  });

  it('splits on TOP-LEVEL commas only — generics and nested tuples are one position each', () => {
    expect(judge('[a: Array<number>, b: string]', [[1], 'x'])).toBeNull();
    expect(judge('[[string, number], boolean]', [['a', 1], true])).toBeNull();
    expect(judge('[Map<string, number>, boolean]', [new Map(), true])).toBeNull();
  });

  it('abstains where arity is NOT the contract — rest and optional members', () => {
    // A variable-length tuple has no arity to check, so this reader has nothing to say rather than
    // something wrong to say.
    expect(judge('[...rest: number[]]', [1, 2, 3])).toBeNull();
    expect(judge('[a: string, b?: number]', ['x'])).toBeNull();
    expect(judge('[a: string, b?: number]', ['x', 1])).toBeNull();
  });

  it('reads an ARROW as an arrow, not as a closing bracket', () => {
    /**
     * `>` was counted as a bracket close, so depth went NEGATIVE inside
     * `{ build: (c: C) => P | null }` and `P | null` looked top-level. It split into two bogus
     * members, one of them unjudgeable — and one unjudgeable member abstains the whole check, which
     * is how `optionsBacktest.entry` stayed the last nested union in the library to accept `42`.
     */
    const callbackUnion: SynthesisParameter = {
      name: 'entry',
      type: 'WithBuild | Plain',
      optional: false,
      kind: 'object',
      branches: [
        {
          type: 'Common & { build: (context: Context) => Position | null; }',
          kind: 'object',
          fields: [
            {
              name: 'build',
              type: '(context: Context) => Position | null',
              kind: 'function',
              optional: false,
              nullable: false,
            },
          ],
        },
        {
          type: 'Plain',
          kind: 'object',
          fields: [
            { name: 'plain', type: 'number', kind: 'numeric', optional: false, nullable: false },
          ],
        },
      ],
    };
    expect(baselineGap([callbackUnion], [42])?.category).toBe('no-branch');
  });
});

describe('tuple positions are judged by TYPE, at every depth', () => {
  const tuple = (type: string): SynthesisParameter => ({
    name: 'pair',
    type,
    optional: false,
    kind: 'series',
  });
  const judge = (type: string, value: unknown) => baselineGap([tuple(type)], [value]);

  it('checks an inline object position by its members, not only by its keys', () => {
    // Presence alone accepted `[{ a: 'wrong' }, true]` against `[{ a: number }, boolean]` — the key
    // was there and its value could be anything.
    expect(judge('[{ a: number }, boolean]', [{ a: 'wrong' }, true])?.category).toBe('wrong-type');
    expect(judge('[{ a: number }, boolean]', [{ a: 1 }, true])).toBeNull();
    expect(judge('[{ a?: number }, boolean]', [{}, true])).toBeNull();
  });

  it('recurses into nested inline objects', () => {
    expect(judge('[{ a: { b: number } }, boolean]', [{ a: { b: 'no' } }, true])?.category).toBe(
      'wrong-type',
    );
    expect(judge('[{ a: { b: number } }, boolean]', [{ a: { b: 2 } }, true])).toBeNull();
  });

  it('reads a TEMPLATE LITERAL as a string, commas and all', () => {
    /**
     * The splitter tracked `'` and `"` and not `` ` ``, so `` `x,${string}` `` read as two positions
     * and a legal value was rejected for having the wrong arity. The pattern itself is not checked —
     * nothing here can — so it constrains the value to being a string and no further. Pretending to
     * verify it would be the worse error.
     */
    expect(judge('[`x,${string}`, boolean]', ['x,y', true])).toBeNull();
    expect(judge('[`x,${string}`, boolean]', [42, true])?.category).toBe('wrong-type');
  });
});

describe('tuples are read from the COMPILER, not from rendered text', () => {
  const position = (
    name: string,
    type: string,
    kind: string,
    optional = false,
  ): SynthesisField => ({
    name,
    type,
    kind,
    optional,
    nullable: false,
  });
  const tupleParam = (tuple: SynthesisField[], type: string): SynthesisParameter => ({
    name: 'pair',
    type,
    optional: false,
    kind: 'series',
    tuple,
  });

  const arms: SynthesisParameter = {
    name: 'state',
    type: '[number] | [number, number, number, number]',
    optional: false,
    kind: 'series',
    branches: [
      { type: '[number]', kind: 'array', tuple: [position('0', 'number', 'numeric')] },
      {
        type: '[number, number, number, number]',
        kind: 'array',
        tuple: ['0', '1', '2', '3'].map((slot) => position(slot, 'number', 'numeric')),
      },
    ],
  };

  it('judges each position by the node that declares it, at every depth', () => {
    /**
     * The durable replacement for parsing rendered type text. Every lesson the text reader had to be
     * taught — top-level commas, arrows, quoted literals, template literals — arrived as a defect, in
     * both directions: legal calls rejected and malformed ones accepted. The checker knew the answer
     * all along, so the metadata carries it instead of the parser re-deriving it.
     */
    const nested = tupleParam(
      [
        {
          ...position('0', '[string, number]', 'array'),
          tuple: [position('0', 'string', 'string'), position('1', 'number', 'numeric')],
        },
        position('1', 'boolean', 'boolean'),
      ],
      '[[string, number], boolean]',
    );
    expect(baselineGap([nested], [[['a', 1], true]])).toBeNull();
    expect(baselineGap([nested], [[[42, 'wrong'], true]])?.category).toBe('wrong-type');
  });

  it('knows the legal ARITY RANGE when a position is optional', () => {
    // The text reader could only abstain on `[a: string, b?: number]`; the compiler says 1-to-2.
    const optional = tupleParam(
      [position('0', 'string', 'string'), position('1', 'number', 'numeric', true)],
      '[string, number?]',
    );
    expect(baselineGap([optional], [['a']])).toBeNull();
    expect(baselineGap([optional], [['a', 2]])).toBeNull();
    expect(baselineGap([optional], [['a', 'no']])?.category).toBe('wrong-type');
    expect(baselineGap([optional], [['a', 2, 3]])?.category).toBe('wrong-type');
  });

  it('reads a UNION OF TUPLES as a union, which the text reader could not', () => {
    /**
     * `[number] | [number, number, number, number]` starts with `[` and ends with `]`, so the bracket
     * test admitted it and the splitter — walking a string whose brackets close and reopen — produced
     * FOUR positions. `restoreRandomNumberGenerator`'s legal one-element state was rejected as
     * "declares exactly 4 elements, got 1": the validator refusing a call the language accepts, from
     * a shape it had misread as something else entirely.
     */
    expect(baselineGap([arms], [[1]])).toBeNull();
    expect(baselineGap([arms], [[1, 2, 3, 4]])).toBeNull();
    expect(baselineGap([arms], [[1, 2]])?.category).toBe('no-branch');
    expect(baselineGap([arms], [['a']])?.category).toBe('no-branch');
  });

  /**
   * RETIRED WITH ITS SUBJECT, deliberately rather than by deletion.
   *
   * This asserted that a union answers identically whether its arms are spelled as branch NODES or
   * as the legacy `branchTypes`/`branchTuples`/`branchFields` arrays — the property that made the
   * reader migration provable while BOTH spellings were live. The arrays are now gone from the
   * artifact and from every declaration, so there is no second spelling to disagree with: the test
   * could only pass, which is the definition of a check that has stopped asking its question.
   *
   * What replaced it is stronger and lives outside this file: `union-parity.test.ts` asserts the
   * artifact carries no retired key at all, and that arms are recorded for every rendered union.
   */

  it('leaves the TEXT reader with no work on the committed surface', () => {
    /**
     * The gate that keeps the fallback dead. Text parsing remains in the file for a declaration the
     * inventory has not recorded metadata for — but on the real surface there is none, and a new
     * tuple field arriving without metadata fails here rather than silently reviving the parser and
     * the class of defects that came with it.
     */
    const artifact = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as { contracts: { id: string; signatures?: { parameters?: SynthesisParameter[] }[] }[] };
    const tupleShaped = (type: string | undefined): boolean =>
      typeof type === 'string' &&
      /^\s*(readonly\s+)?\[/.test(type.trim()) &&
      type.trim().endsWith(']');
    let covered = 0;
    const bare: string[] = [];
    const walk = (
      fields: readonly SynthesisField[] | undefined,
      owner: string,
      depth = 0,
    ): void => {
      if (!fields || depth > 8) return;
      for (const field of fields) {
        if (tupleShaped(field.type)) {
          if (field.tuple || field.branches?.some((arm) => arm.tuple)) covered += 1;
          else bare.push(`${owner}.${field.name}: ${field.type}`);
        }
        walk(field.fields, owner, depth + 1);
        walk(field.tuple, owner, depth + 1);
        for (const arm of field.branches ?? []) walk(arm.tuple ?? [], owner, depth + 1);
        if (field.element) walk([field.element], owner, depth + 1);
        for (const arm of field.branches ?? []) walk(arm.fields ?? [], owner, depth + 1);
      }
    };
    for (const record of artifact.contracts) {
      for (const parameter of record.signatures?.[0]?.parameters ?? []) {
        walk(parameter.fieldTree, record.id);
        walk(parameter.elementFieldTree, record.id);
        for (const arm of parameter.branches ?? []) walk(arm.fields ?? [], record.id);
      }
    }
    expect(covered, 'no tuple fields found — the gate is vacuous').toBeGreaterThan(20);
    expect(
      bare,
      'a tuple field carries no compiler metadata and falls back to text parsing',
    ).toEqual([]);
  });
});
