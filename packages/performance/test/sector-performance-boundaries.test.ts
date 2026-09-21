import { ErrorCode, InputError } from '@totalfinance/core';
import {
  sectorPerformance,
  sectorPerformanceSnapshot,
} from '@totalfinance/performance/sector-performance';
import { describe, expect, it } from 'vitest';
import { snapshotInput } from './sector-performance-fixtures.js';

const simpleInput = () => ({
  members: [{ securityId: 'A', sectorId: 'tech', sectorName: 'Technology', periodReturn: 0.1 }],
});
const snapshotArrays = [
  'eligibleUniverse',
  'completedSessions',
  'classifications',
  'splitAdjustedCloses',
] as const;

function errorOf(run: () => unknown): InputError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InputError);
    return error as InputError;
  }
  throw new Error('Expected a typed refusal');
}

function expectError(
  run: () => unknown,
  code: string,
  field: string,
  functionName = 'sectorPerformanceSnapshot',
): void {
  const error = errorOf(run);
  expect(error.code).toBe(code);
  expect(error.context).toMatchObject({ field, function: functionName });
}

describe('sector performance permanent malformed-input boundaries', () => {
  for (const [name, input, run] of [
    ['sectorPerformance', simpleInput, (value: unknown) => sectorPerformance(value as never)],
    [
      'sectorPerformanceSnapshot',
      snapshotInput,
      (value: unknown) => sectorPerformanceSnapshot(value as never),
    ],
  ] as const) {
    it.each([undefined, null, false, 2, 'bad', [], () => 1])(
      `${name} rejects a malformed request: %s`,
      (bad) => {
        expectError(() => run(bad), ErrorCode.InputWrongType, 'input', name);
      },
    );
    it(`${name} rejects retired/unknown controls with teaching`, () => {
      for (const key of ['policyVersion', 'weighting', 'dailyReturn', 'averageChange']) {
        const error = errorOf(() =>
          run({ ...input(), [key]: 'insiderfinance-sector-performance-v1' }),
        );
        expect(error.code).toBe(ErrorCode.InputUnknownField);
        expect(error.context).toMatchObject({ function: name, field: 'input', key });
        expect(error.message).toContain('Allowed fields:');
      }
    });
    it(`${name} bounds arrays before accessing any element`, () => {
      const rows = new Array(1_000_001);
      Object.defineProperty(rows, 0, {
        get: () => {
          throw new Error('Element accessed before budget check');
        },
      });
      const field = name === 'sectorPerformance' ? 'members' : 'splitAdjustedCloses';
      expectError(
        () => run({ ...input(), [field]: rows }),
        ErrorCode.InputOutOfRange,
        `input.${field}`,
        name,
      );
    });
  }

  for (const key of snapshotArrays) {
    it.each([undefined, null, {}, 'array', new Float64Array(1)])(
      `rejects malformed ${key}: %s`,
      (bad) => {
        expectError(
          () => sectorPerformanceSnapshot({ ...snapshotInput(), [key]: bad } as never),
          bad === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
          `input.${key}`,
        );
      },
    );
    // Includes BOTH independent PR336 sparse regressions, plus every other observation array.
    it.each([0, 1, 2])(`rejects a sparse ${key} at index %s`, (hole) => {
      const input = snapshotInput(3);
      const rows: unknown[] = [input[key][0], input[key][0], input[key][0]];
      delete rows[hole];
      expectError(
        () => sectorPerformanceSnapshot({ ...input, [key]: rows } as never),
        ErrorCode.InputWrongType,
        `input.${key}[${hole}]`,
      );
    });
    it(`rejects inherited slots in sparse ${key}`, () => {
      const input = snapshotInput();
      const rows = new Array(1);
      Object.setPrototypeOf(
        rows,
        Object.assign(Object.create(Array.prototype), { 0: input[key][0] }),
      );
      expectError(
        () => sectorPerformanceSnapshot({ ...input, [key]: rows }),
        ErrorCode.InputWrongType,
        `input.${key}[0]`,
      );
    });
    it.each([undefined, null, false, 1, 'row', [], () => 1])(
      `rejects malformed ${key} rows: %s`,
      (bad) => {
        expectError(
          () => sectorPerformanceSnapshot({ ...snapshotInput(), [key]: [bad] } as never),
          ErrorCode.InputWrongType,
          `input.${key}[0]`,
        );
      },
    );
    const row = snapshotInput()[key][0]!;
    for (const field of Object.keys(row)) {
      it(`requires consumed field ${key}[0].${field} even on decorated rows`, () => {
        for (const explicitlyUndefined of [false, true]) {
          const changed: Record<string, unknown> = { ...row, harmless: { extra: true } };
          if (explicitlyUndefined) changed[field] = undefined;
          else delete changed[field];
          expectError(
            () => sectorPerformanceSnapshot({ ...snapshotInput(), [key]: [changed] } as never),
            ErrorCode.InputMissingField,
            `input.${key}[0].${field}`,
          );
        }
      });
      if (typeof row[field] === 'string' && field !== 'quality') {
        it.each([null, false, 4, [], {}, ''])(
          `rejects wrong string ${key}[0].${field}: %s`,
          (bad) => {
            const pairedNull = bad === null && (field === 'sectorId' || field === 'sectorName');
            expectError(
              () =>
                sectorPerformanceSnapshot({
                  ...snapshotInput(),
                  [key]: [{ ...row, [field]: bad }],
                } as never),
              pairedNull ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
              pairedNull ? `input.${key}[0]` : `input.${key}[0].${field}`,
            );
          },
        );
      }
    }
  }

  it('checks the combined input budget before traversing even the first array', () => {
    const eligibleUniverse = new Array(500_000);
    Object.defineProperty(eligibleUniverse, 0, {
      get: () => {
        throw new Error('Early element access');
      },
    });
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...snapshotInput(),
          eligibleUniverse,
          classifications: new Array(500_000),
        }),
      ErrorCode.InputOutOfRange,
      'input.classifications',
    );
  });

  const numericCases: [unknown, string][] = [
    [undefined, ErrorCode.InputMissingField],
    [null, ErrorCode.InputWrongType],
    ['10', ErrorCode.InputWrongType],
    [true, ErrorCode.InputWrongType],
    [{}, ErrorCode.InputWrongType],
    [[], ErrorCode.InputWrongType],
    [1n, ErrorCode.InputWrongType],
    [NaN, ErrorCode.InputNaN],
    [Infinity, ErrorCode.InputNotFinite],
    [-Infinity, ErrorCode.InputNotFinite],
  ];
  const numericPaths = [
    ['cutoffs', 'sourceCutoffTimestampMs'],
    ['cutoffs', 'knowledgeCutoffTimestampMs'],
    ['cutoffs', 'sessionCompletedCutoffTimestampMs'],
    ['completedSessions', 'completedAtTimestampMs'],
    ['classifications', 'sourceTimestampMs'],
    ['classifications', 'knownAtTimestampMs'],
    ['splitAdjustedCloses', 'sourceTimestampMs'],
    ['splitAdjustedCloses', 'knownAtTimestampMs'],
    ['splitAdjustedCloses', 'splitAdjustedClose'],
  ] as const;
  for (const [container, field] of numericPaths) {
    it.each(numericCases)(
      `uses the exact numeric error ladder for ${container}.${field}: %s`,
      (bad, code) => {
        const input = snapshotInput();
        const parent = container === 'cutoffs' ? input.cutoffs : input[container][0]!;
        Object.assign(parent, { [field]: bad });
        expectError(
          () => sectorPerformanceSnapshot(input),
          code,
          `input.${container}${container === 'cutoffs' ? '' : '[0]'}.${field}`,
        );
      },
    );
    it(`validates numeric ranges for ${container}.${field}`, () => {
      for (const bad of field === 'splitAdjustedClose'
        ? [0, -1]
        : [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const input = snapshotInput();
        const parent = container === 'cutoffs' ? input.cutoffs : input[container][0]!;
        Object.assign(parent, { [field]: bad });
        expectError(
          () => sectorPerformanceSnapshot(input),
          ErrorCode.InputOutOfRange,
          `input.${container}${container === 'cutoffs' ? '' : '[0]'}.${field}`,
        );
      }
    });
  }

  it.each(numericCases)('uses the shared numeric ladder for simple returns: %s', (bad, code) => {
    const input = simpleInput();
    Object.assign(input.members[0]!, { periodReturn: bad });
    expectError(
      () => sectorPerformance(input),
      code,
      'input.members[0].periodReturn',
      'sectorPerformance',
    );
  });
  it.each([0, 1, 2])('rejects simple member holes at every position: %s', (index) => {
    const members = [simpleInput().members[0], simpleInput().members[0], simpleInput().members[0]];
    delete members[index];
    expectError(
      () => sectorPerformance({ members } as never),
      ErrorCode.InputWrongType,
      `input.members[${index}]`,
      'sectorPerformance',
    );
  });
  it.each([null, {}, new Float64Array(1), 'members'])(
    'rejects malformed simple member arrays: %s',
    (members) => {
      expectError(
        () => sectorPerformance({ members } as never),
        ErrorCode.InputWrongType,
        'input.members',
        'sectorPerformance',
      );
    },
  );
  it.each([undefined, null, false, 0, 'member', []])('rejects malformed simple rows: %s', (row) => {
    expectError(
      () => sectorPerformance({ members: [row] } as never),
      ErrorCode.InputWrongType,
      'input.members[0]',
      'sectorPerformance',
    );
  });
  it('requires every simple consumed field, with indexed errors', () => {
    for (const field of Object.keys(simpleInput().members[0]!)) {
      const member: Record<string, unknown> = { ...simpleInput().members[0]! };
      delete member[field];
      expectError(
        () => sectorPerformance({ members: [member] } as never),
        ErrorCode.InputMissingField,
        `input.members[0].${field}`,
        'sectorPerformance',
      );
    }
  });
  it('rejects below-total-loss returns, duplicate securities, and conflicting sector names', () => {
    expectError(
      () =>
        sectorPerformance({ members: [{ ...simpleInput().members[0]!, periodReturn: -1.000001 }] }),
      ErrorCode.InputOutOfRange,
      'input.members[0].periodReturn',
      'sectorPerformance',
    );
    expectError(
      () => sectorPerformance({ members: [simpleInput().members[0]!, simpleInput().members[0]!] }),
      ErrorCode.InputOutOfRange,
      'input.members[1]',
      'sectorPerformance',
    );
    expectError(
      () =>
        sectorPerformance({
          members: [
            simpleInput().members[0]!,
            { ...simpleInput().members[0]!, securityId: 'B', sectorName: 'Conflicting' },
          ],
        }),
      ErrorCode.InputOutOfRange,
      'input.members',
      'sectorPerformance',
    );
  });

  it('teaches the exact did-you-mean on closed controls', () => {
    const error = errorOf(() => sectorPerformance({ member: [] } as never));
    expect(error.code).toBe(ErrorCode.InputUnknownField);
    expect(error.context).toEqual({
      function: 'sectorPerformance',
      field: 'input',
      key: 'member',
      suggestion: 'members',
    });
    expect(error.message).toBe(
      'sectorPerformance: unknown field "member" in input — did you mean "members"? Allowed fields: members.',
    );
    for (const key of ['classificationTaxonomy', 'cutoffs'] as const) {
      const input = snapshotInput();
      const err = errorOf(() =>
        sectorPerformanceSnapshot({ ...input, [key]: { ...input[key], typo: true } }),
      );
      expect(err.code).toBe(ErrorCode.InputUnknownField);
      expect(err.context).toMatchObject({ field: `input.${key}`, key: 'typo' });
      for (const field of Object.keys(input[key])) {
        const changed = { ...input[key], [field]: undefined };
        expectError(
          () => sectorPerformanceSnapshot({ ...input, [key]: changed }),
          ErrorCode.InputMissingField,
          `input.${key}.${field}`,
        );
      }
    }
  });

  it('preserves indexed date, enum, bitemporal, paired-null, and session-reference errors', () => {
    const input = snapshotInput();
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          completedSessions: [{ ...input.completedSessions[0]!, sessionDate: '2026-02-30' }],
        }),
      ErrorCode.InputOutOfRange,
      'input.completedSessions[0].sessionDate',
    );
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          classifications: [{ ...input.classifications[0]!, effectiveToSessionDate: 'yesterday' }],
        }),
      ErrorCode.InputWrongType,
      'input.classifications[0].effectiveToSessionDate',
    );
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          classifications: [{ ...input.classifications[0]!, effectiveToSessionDate: '2019-01-01' }],
        }),
      ErrorCode.InputOutOfRange,
      'input.classifications[0].effectiveToSessionDate',
    );
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          classifications: [{ ...input.classifications[0]!, sectorId: null }],
        }),
      ErrorCode.InputWrongShape,
      'input.classifications[0]',
    );
    for (const key of ['classifications', 'splitAdjustedCloses'] as const) {
      expectError(
        () =>
          sectorPerformanceSnapshot({
            ...input,
            [key]: [{ ...input[key][0]!, knownAtTimestampMs: 0 }],
          }),
        ErrorCode.InputOutOfRange,
        `input.${key}[0].knownAtTimestampMs`,
      );
    }
    for (const quality of [null, 'FINAL', 1, false]) {
      expectError(
        () =>
          sectorPerformanceSnapshot({
            ...input,
            splitAdjustedCloses: [{ ...input.splitAdjustedCloses[0]!, quality }],
          } as never),
        ErrorCode.InputInvalidEnum,
        'input.splitAdjustedCloses[0].quality',
      );
    }
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          splitAdjustedCloses: [{ ...input.splitAdjustedCloses[0]!, sessionId: 'unknown' }],
        }),
      ErrorCode.InputOutOfRange,
      'input.splitAdjustedCloses[0].sessionId',
    );
  });

  it('pins duplicate identity and ambiguous precedence errors', () => {
    const input = snapshotInput();
    for (const key of snapshotArrays) {
      const rows = [input[key][0], input[key][0]];
      expectError(
        () => sectorPerformanceSnapshot({ ...input, [key]: rows } as never),
        ErrorCode.InputOutOfRange,
        `input.${key}[1]`,
      );
    }
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          classifications: [
            input.classifications[0]!,
            { ...input.classifications[0]!, classificationObservationId: 'revision-tie' },
          ],
        }),
      ErrorCode.InputOutOfRange,
      'input.classifications[1]',
    );
    expectError(
      () =>
        sectorPerformanceSnapshot({
          ...input,
          splitAdjustedCloses: [
            input.splitAdjustedCloses[0]!,
            { ...input.splitAdjustedCloses[0]!, closeObservationId: 'revision-tie' },
          ],
        }),
      ErrorCode.InputOutOfRange,
      'input.splitAdjustedCloses[1]',
    );
  });
});
