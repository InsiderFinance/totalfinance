import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { optionChainHealth, type OptionChainHealthInput } from '@totalfinance/options';
import { OPTION_CHAIN_HEALTH_FIXTURES } from '../first-touch/fixtures/options-chain-health.js';
import { probeContract } from './contract-probe.js';
import {
  incompleteBaseline,
  provesArgumentConformance,
  satisfiedBranch,
  type SynthesisField,
  type SynthesisParameter,
} from './contract-synthesis.js';

const artifact = JSON.parse(
  readFileSync(new URL('./public-contracts.json', import.meta.url), 'utf8'),
);
const record = artifact.contracts.find(
  (item: { id: string }) => item.id === '@totalfinance/options:optionChainHealth',
);
const parameters = record.signatures[0].parameters as SynthesisParameter[];
const fresh = OPTION_CHAIN_HEALTH_FIXTURES['options.optionChainHealth']!;
const coordinates = parameters.map((coordinate, index) => {
  const fields = satisfiedBranch(coordinate, fresh()[index]);
  return { ...coordinate, ...(fields ? { fields } : {}) };
});

describe('positive omission proof inspects supplied data without invoking accessors', () => {
  const numeric: SynthesisField = {
    name: '[]',
    type: 'number',
    kind: 'numeric',
    optional: false,
    nullable: false,
  };
  const values: SynthesisField = {
    name: 'values',
    type: 'number[]',
    kind: 'array',
    optional: false,
    nullable: false,
    element: numeric,
  };
  const model: SynthesisField = {
    name: 'model',
    type: 'string',
    kind: 'string',
    optional: false,
    nullable: false,
  };
  const parameter: SynthesisParameter = {
    name: 'input',
    type: 'Model | QuoteOnly',
    kind: 'object',
    optional: false,
    fieldTree: [model, values],
    branches: [
      {
        type: 'Model',
        kind: 'object',
        fields: [
          model,
          {
            ...values,
            type: 'Array<number | undefined>',
            element: { ...numeric, type: 'number | undefined' },
          },
        ],
      },
      { type: 'QuoteOnly', kind: 'object', fields: [values] },
    ],
  };
  const sparse = (): number[] => {
    const result = [1, 1, 1];
    result.length = 4;
    return result;
  };

  it('checks every own array index, including holes and wrong values after the sampled prefix', () => {
    for (const list of [sparse(), [1, 1, 1, 'wrong']]) {
      expect(incompleteBaseline([parameter], [{ values: list }])).toBeNull();
      expect(provesArgumentConformance([parameter], [{ values: list }])).toBe(false);
    }
    const input = Object.freeze({ values: Object.freeze([1, 1, 1, 1]) });
    expect(provesArgumentConformance([parameter], [input])).toBe(true);
    expect(provesArgumentConformance([parameter], [input])).toBe(true);
    expect(input.values).toEqual([1, 1, 1, 1]);
  });

  it('retains authoritative omission evidence for a sparse-array arm transition', () => {
    const fixture = () => [{ model: 'bsm', values: sparse() }];
    // Deliberately faulty runtime: accepting this omission must remain visible as evidence.
    const result = probeContract(() => 0, fixture, {
      coordinates: [{ fields: [model, values] }],
      acceptsOmittedArguments: (args) => provesArgumentConformance([parameter], args),
    });
    expect(
      result.find((item) => item.field === 'model' && item.mutation === 'omit-required'),
    ).toMatchObject({ declared: true, verdict: 'accepted' });
  });

  it('does not hide supplied non-enumerable opaque fields', () => {
    const opaque: SynthesisParameter = {
      name: 'input',
      type: 'Envelope',
      kind: 'object',
      optional: false,
      fieldTree: [{ ...numeric, name: 'opaque', type: 'ForeignType', kind: 'other' }],
    };
    const hidden = Object.defineProperty({}, 'opaque', { value: {}, enumerable: false });
    expect(incompleteBaseline([opaque], [hidden])).toBeNull();
    expect(provesArgumentConformance([opaque], [hidden])).toBe(false);
    expect(provesArgumentConformance([opaque], [{ opaque: {} }])).toBe(false);
  });

  it('declines accessors before any baseline or descendant walker can invoke them', () => {
    let reads = 0;
    const getter = () => {
      reads += 1;
      return [1, 1, 1, 1];
    };
    const input = Object.defineProperty({}, 'values', { get: getter, enumerable: true });
    expect(provesArgumentConformance([parameter], [input])).toBe(false);
    const list = [1, 1, 1, 1];
    Object.defineProperty(list, '3', { get: getter, enumerable: true });
    expect(provesArgumentConformance([parameter], [{ values: list }])).toBe(false);
    const args: unknown[] = [{ values: [1] }];
    Object.defineProperty(args, '0', { get: getter, enumerable: true });
    expect(provesArgumentConformance([parameter], args)).toBe(false);
    expect(reads).toBe(0);
  });

  it.each(['open', 'passthrough'])('preserves %s policy only for unconsumed metadata', (policy) => {
    let reads = 0;
    const metadata = Object.defineProperty({}, 'foreignGetter', {
      get: () => {
        reads += 1;
        throw new Error('unconsumed metadata was read');
      },
    });
    const declared = { ...parameter, policy };
    const input = { values: [1, 1, 1, 1], metadata, [Symbol('vendor')]: metadata };
    expect(incompleteBaseline([declared], [input])).toBeNull();
    expect(provesArgumentConformance([declared], [input])).toBe(true);
    expect(provesArgumentConformance([parameter], [input])).toBe(false);
    expect(provesArgumentConformance([declared], [{ ...input, values: [1, 1, 1, 'wrong'] }])).toBe(
      false,
    );
    expect(provesArgumentConformance([declared], [{ ...input, values: sparse() }])).toBe(false);
    expect(provesArgumentConformance([declared], [{ metadata }])).toBe(false);
    expect(reads).toBe(0);

    const result = probeContract(
      () => 0,
      () => [{ model: 'bsm', ...input }],
      {
        coordinates: [{ fields: [model, values] }],
        acceptsOmittedArguments: (args) => provesArgumentConformance([declared], args),
      },
    );
    expect(
      result.filter((item) => item.field === 'model' && item.mutation === 'omit-required'),
    ).toEqual([]);
    expect(result.some((item) => item.field === 'model' && item.mutation === 'wrong-type')).toBe(
      true,
    );
    expect(reads).toBe(0);
  });

  it('declines unknown non-data fields even when the policy permits metadata', () => {
    let reads = 0;
    for (const policy of ['closed', 'open', 'passthrough']) {
      for (const key of ['metadata', Symbol('metadata')]) {
        const input = { values: [1] };
        Object.defineProperty(input, key, {
          enumerable: true,
          get: () => {
            reads += 1;
            return 1;
          },
        });
        expect(provesArgumentConformance([{ ...parameter, policy }], [input])).toBe(false);
        const hidden = Object.defineProperty({ values: [1] }, key, { value: 1 });
        expect(provesArgumentConformance([{ ...parameter, policy }], [hidden])).toBe(false);
      }
    }
    expect(reads).toBe(0);
  });

  it('declines sparse argument lists, decorated arrays, and work-budget exhaustion', () => {
    const args: unknown[] = [];
    args.length = 1;
    expect(provesArgumentConformance([{ ...parameter, optional: true }], args)).toBe(false);
    const decorated = Object.assign([1, 1, 1, 1], { metadata: true });
    expect(provesArgumentConformance([parameter], [{ values: decorated }])).toBe(false);
    const enormous: number[] = [];
    enormous.length = 0xffff_ffff;
    expect(provesArgumentConformance([parameter], [{ values: enormous }])).toBe(false);
  });
});
const acceptsOmittedArguments = (args: unknown[]) => provesArgumentConformance(parameters, args);
const invoke = (...args: unknown[]) => optionChainHealth(args[0] as OptionChainHealthInput);
const probes = (fixture = fresh) =>
  probeContract(invoke, fixture, { coordinates, acceptsOmittedArguments });

describe('omission probes use the complete declaration, not just the baseline union arm', () => {
  it('never treats opaque or truncated baseline abstention as positive conformance proof', () => {
    const opaque: SynthesisParameter = {
      name: 'input',
      kind: 'other',
      type: 'ForeignType',
      optional: false,
    };
    expect(incompleteBaseline([opaque], [{}])).toBeNull();
    expect(provesArgumentConformance([opaque], [{}])).toBe(false);
    const truncated: SynthesisParameter = {
      name: 'input',
      kind: 'object',
      type: 'Truncated',
      optional: false,
      fieldTree: [
        {
          name: 'nested',
          type: 'Nested',
          kind: 'object',
          optional: false,
          nullable: false,
          truncated: true,
        },
      ],
    };
    expect(provesArgumentConformance([truncated], [{ nested: {} }])).toBe(false);
  });
  it('rejects supplied never fields and undefined-only fields in the baseline walker', () => {
    for (const type of ['never', 'undefined', 'void']) {
      const parameter: SynthesisParameter = {
        name: 'input',
        type: '{ forbidden?: never }',
        kind: 'object',
        optional: false,
        fieldTree: [{ name: 'forbidden', type, kind: 'other', optional: true, nullable: false }],
      };
      expect(incompleteBaseline([parameter], [{ forbidden: {} }])).not.toBeNull();
      expect(provesArgumentConformance([parameter], [{ forbidden: {} }])).toBe(false);
    }
  });
  it('omitting model really is a valid quote-only input in TypeScript and at runtime', () => {
    const baseline = fresh()[0] as OptionChainHealthInput;
    const quoteOnly = {
      quotes: baseline.quotes,
      market: baseline.market,
      config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
    } satisfies OptionChainHealthInput;
    expect(acceptsOmittedArguments([quoteOnly])).toBe(true);
    expect(optionChainHealth(quoteOnly).rows[0]?.model.status).toBe('not-requested');
  });
  it('does not execute or claim an invalid-input probe for a valid arm transition', () => {
    let transitions = 0;
    const result = probeContract(
      (...args) => {
        const input = args[0] as OptionChainHealthInput;
        if (input?.config && !Object.hasOwn(input.config, 'model') && acceptsOmittedArguments(args))
          transitions++;
        return invoke(...args);
      },
      fresh,
      { coordinates, acceptsOmittedArguments },
    );
    expect(transitions).toBe(0);
    expect(
      result.filter((item) => item.mutation === 'omit-required' && item.field === 'config.model'),
    ).toEqual([]);
  });
  it('still probes common required fields and mistyped or invalid model selections', () => {
    const result = probes();
    expect(
      result.find((item) => item.mutation === 'omit-required' && item.field === 'market.underlying')
        ?.verdict,
    ).toBe('rejected');
    expect(
      result.find((item) => item.mutation === 'invalid-literal' && item.field === 'config.model')
        ?.verdict,
    ).toBe('rejected');
    expect(
      result.find((item) => item.mutation === 'wrong-type' && item.field === 'config.model')
        ?.verdict,
    ).toBe('rejected');
  });
  it('still probes model omission when model-only solver controls make that call invalid', () => {
    const withSolver = () => {
      const input = fresh()[0] as OptionChainHealthInput;
      return [{ ...input, config: { ...input.config, solver: { lowerVolatilityBound: 0.01 } } }];
    };
    expect(
      probes(withSolver).find(
        (item) => item.mutation === 'omit-required' && item.field === 'config.model',
      )?.verdict,
    ).toBe('rejected');
  });
});
