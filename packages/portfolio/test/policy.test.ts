/**
 * FC7 slice 4 — the investment-policy grammar: model artifacts, dated target resolution, and the
 * ONE group-to-instrument expansion law. Every number is hand-computed in a comment.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  MODEL_PORTFOLIO_KIND,
  MODEL_PORTFOLIO_SCHEMA_VERSION,
  createModelPortfolio,
  isModelPortfolio,
  resolveModelTargets,
  type ModelPortfolioDefinition,
} from '../src/policy.js';
import {
  expandTargets,
  requireInvestmentPolicy,
  requireModelPortfolio,
  targetGroupKey,
} from '../src/policy-grammar.js';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeeplyFrozen);
}

const BALANCED: ModelPortfolioDefinition = {
  modelId: 'balanced',
  version: 1,
  baseCurrency: 'USD',
  strategic: {
    effectiveFrom: '2026-01-01',
    targets: [
      { group: { tag: 'equity' }, weight: 0.6 },
      { group: { tag: 'fixed-income' }, weight: 0.3 },
      { group: { assetClass: 'cash' }, weight: 0.1 },
    ],
  },
};

describe('createModelPortfolio — an immutable, content-addressed target artifact', () => {
  it('freezes a validated definition with its kind, schema version, and hash', () => {
    const model = createModelPortfolio(BALANCED);
    expect(model.kind).toBe(MODEL_PORTFOLIO_KIND);
    expect(model.schemaVersion).toBe(MODEL_PORTFOLIO_SCHEMA_VERSION);
    expect(model.contentHash.startsWith('sha256:')).toBe(true);
    expect(isDeeplyFrozen(model)).toBe(true);
    expect(isModelPortfolio(model)).toBe(true);
    // Identity is content: the same definition hashes the same; a changed weight is another model.
    expect(createModelPortfolio(BALANCED).contentHash).toBe(model.contentHash);
    const shifted = createModelPortfolio({
      ...BALANCED,
      strategic: {
        ...BALANCED.strategic,
        targets: [
          { group: { tag: 'equity' }, weight: 0.5 },
          { group: { tag: 'fixed-income' }, weight: 0.4 },
          { group: { assetClass: 'cash' }, weight: 0.1 },
        ],
      },
    });
    expect(shifted.contentHash).not.toBe(model.contentHash);
  });

  it('detects an artifact edited after creation', () => {
    const model = createModelPortfolio(BALANCED);
    const tampered = JSON.parse(JSON.stringify(model)) as { version: number };
    tampered.version = 2;
    expect(isModelPortfolio(tampered)).toBe(false);
    const error = caught(() => requireModelPortfolio('test', 'model', tampered));
    expect(isQuantError(error, 'artifact.id_mismatch')).toBe(true);
    expect((error as Error).message).toContain('edited after creation');
  });

  it('refuses the definitions the grammar forbids, each with a teaching', () => {
    const refuse = (definition: unknown, code: string, fragment: string): void => {
      const error = caught(() => createModelPortfolio(definition as ModelPortfolioDefinition));
      expect(isQuantError(error, code), String((error as Error)?.message)).toBe(true);
      expect((error as Error).message).toContain(fragment);
    };
    refuse({ ...BALANCED, version: 0 }, 'input.out_of_range', 'safe integer ≥ 1');
    refuse({ ...BALANCED, version: 1.5 }, 'input.out_of_range', 'safe integer');
    const { strategic: _strategic, ...noStrategic } = BALANCED;
    refuse(noStrategic, 'input.missing_field', 'strategic is required');
    refuse({ ...BALANCED, extra: true }, 'input.unknown_field', 'extra');
    refuse(
      {
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          targets: [{ group: { tag: 'equity' }, weight: 0.6, riskBudget: 0.5 }],
        },
      },
      'input.out_of_range',
      'exactly one of weight',
    );
    refuse(
      {
        ...BALANCED,
        strategic: { effectiveFrom: '2026-01-01', targets: [{ group: { tag: 'equity' } }] },
      },
      'input.missing_field',
      'exactly one of weight',
    );
    // A percentage where a decimal belongs.
    refuse(
      {
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          targets: [{ group: { tag: 'equity' }, weight: 60 }],
        },
      },
      'input.out_of_range',
      'percentage',
    );
    // Two dimensions in one group are two targets.
    refuse(
      {
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          targets: [{ group: { tag: 'equity', assetClass: 'stock' }, weight: 0.6 }],
        },
      },
      'input.out_of_range',
      'exactly ONE dimension',
    );
    refuse(
      {
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          targets: [
            { group: { tag: 'equity' }, weight: 0.6 },
            { group: { tag: 'equity' }, weight: 0.3 },
          ],
        },
      },
      'input.out_of_range',
      "'tag:equity' twice",
    );
    // 0.7 + 0.4 on one dimension is more than the whole portfolio.
    refuse(
      {
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          targets: [
            { group: { tag: 'equity' }, weight: 0.7 },
            { group: { tag: 'fixed-income' }, weight: 0.4 },
          ],
        },
      },
      'input.out_of_range',
      'cannot exceed 1',
    );
    refuse(
      {
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          effectiveTo: '2025-12-01',
          targets: BALANCED.strategic.targets,
        },
      },
      'input.out_of_range',
      'must be after effectiveFrom',
    );
  });

  it('validates sleeves as a tree: member weights sum to 1, siblings sum to 1, no cycles, no orphans', () => {
    const withSleeves = (sleeves: unknown): unknown => ({
      ...BALANCED,
      strategic: {
        effectiveFrom: '2026-01-01',
        targets: [
          { group: { sleeveId: 'equity' }, weight: 0.9 },
          { group: { assetClass: 'cash' }, weight: 0.1 },
        ],
      },
      sleeves,
    });
    const good = createModelPortfolio(
      withSleeves([
        { sleeveId: 'equity' },
        {
          sleeveId: 'us',
          parentSleeveId: 'equity',
          weightWithinParent: 0.7,
          members: [{ instrumentId: 'AAPL', weight: 1 }],
        },
        {
          sleeveId: 'international',
          parentSleeveId: 'equity',
          weightWithinParent: 0.3,
          members: [
            { instrumentId: 'VXUS', weight: 0.5 },
            { instrumentId: 'VEA', weight: 0.5 },
          ],
        },
      ]) as ModelPortfolioDefinition,
    );
    expect(good.sleeves).toHaveLength(3);
    const refuse = (sleeves: unknown, code: string, fragment: string): void => {
      const error = caught(() =>
        createModelPortfolio(withSleeves(sleeves) as ModelPortfolioDefinition),
      );
      expect(isQuantError(error, code), String((error as Error)?.message)).toBe(true);
      expect((error as Error).message).toContain(fragment);
    };
    refuse(
      [{ sleeveId: 'equity', members: [{ instrumentId: 'AAPL', weight: 0.6 }] }],
      'input.out_of_range',
      'sum to 1',
    );
    refuse(
      [
        { sleeveId: 'equity' },
        {
          sleeveId: 'us',
          parentSleeveId: 'equity',
          weightWithinParent: 0.7,
          members: [{ instrumentId: 'AAPL', weight: 1 }],
        },
      ],
      'input.out_of_range',
      'siblings must sum to 1',
    );
    refuse(
      [
        { sleeveId: 'equity', parentSleeveId: 'us', weightWithinParent: 1 },
        { sleeveId: 'us', parentSleeveId: 'equity', weightWithinParent: 1 },
      ],
      'input.out_of_range',
      'cycle',
    );
    refuse([{ sleeveId: 'equity' }], 'input.missing_field', 'neither members nor child sleeves');
    refuse(
      [
        { sleeveId: 'equity', members: [{ instrumentId: 'AAPL', weight: 1 }] },
        {
          sleeveId: 'orphan',
          parentSleeveId: 'nowhere',
          weightWithinParent: 1,
          members: [{ instrumentId: 'X', weight: 1 }],
        },
      ],
      'input.out_of_range',
      'not declared',
    );
    // A sleeve target must name a declared sleeve.
    const error = caught(() =>
      createModelPortfolio({
        ...BALANCED,
        strategic: {
          effectiveFrom: '2026-01-01',
          targets: [{ group: { sleeveId: 'ghost' }, weight: 1 }],
        },
      }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect((error as Error).message).toContain("sleeve 'ghost'");
  });

  it('a glide path declares its interpolation and, when linear, keeps one group set', () => {
    const glide = (interpolation: unknown, secondTargets: unknown): unknown => ({
      ...BALANCED,
      glidePath: {
        interpolation,
        points: [
          { effectiveFrom: '2026-01-01', targets: BALANCED.strategic.targets },
          { effectiveFrom: '2027-01-01', targets: secondTargets },
        ],
      },
    });
    const later = [
      { group: { tag: 'equity' }, weight: 0.5 },
      { group: { tag: 'fixed-income' }, weight: 0.4 },
      { group: { assetClass: 'cash' }, weight: 0.1 },
    ];
    expect(
      createModelPortfolio(glide('linear', later) as ModelPortfolioDefinition).glidePath!
        .interpolation,
    ).toBe('linear');
    const missing = caught(() =>
      createModelPortfolio({ ...BALANCED, glidePath: { points: [] } } as never),
    );
    expect(isQuantError(missing, 'input.missing_field')).toBe(true);
    expect((missing as Error).message).toContain('interpolation is required');
    const differentGroups = caught(() =>
      createModelPortfolio(
        glide('linear', [{ group: { tag: 'equity' }, weight: 1 }]) as ModelPortfolioDefinition,
      ),
    );
    expect(isQuantError(differentGroups, 'input.out_of_range')).toBe(true);
    expect((differentGroups as Error).message).toContain('SAME groups');
    expect(
      isQuantError(
        caught(() => createModelPortfolio(glide('cubic', later) as never)),
        'input.invalid_enum',
      ),
    ).toBe(true);
  });
});

describe('resolveModelTargets — which targets are effective at an instant', () => {
  const model = createModelPortfolio({
    ...BALANCED,
    tactical: [
      {
        effectiveFrom: '2026-03-01',
        effectiveTo: '2026-04-01',
        targets: [
          { group: { tag: 'equity' }, weight: 0.5 },
          { group: { tag: 'fixed-income' }, weight: 0.4 },
          { group: { assetClass: 'cash' }, weight: 0.1 },
        ],
        note: 'risk-off March',
      },
    ],
  });

  it('strategic before, tactical inside its window, strategic again after', () => {
    expect(resolveModelTargets({ model, asOf: '2026-02-15' }).source).toBe('strategic');
    const march = resolveModelTargets({ model, asOf: '2026-03-15' });
    expect(march.source).toBe('tactical');
    expect(march.effectiveFrom).toBe(Date.UTC(2026, 2, 1));
    expect(march.targets[0]!.weight).toBe(0.5);
    // effectiveTo is exclusive.
    expect(resolveModelTargets({ model, asOf: '2026-04-01' }).source).toBe('strategic');
    // Before the strategic set nothing is effective — a typed refusal, never an empty default.
    const early = caught(() => resolveModelTargets({ model, asOf: '2025-12-31' }));
    expect(isQuantError(early, 'input.out_of_range')).toBe(true);
    expect((early as Error).message).toContain('no target set is effective');
    expect(
      isQuantError(
        caught(() => resolveModelTargets({ model } as never)),
        'input.missing_field',
      ),
    ).toBe(true);
  });

  it('steps or interpolates a glide path, and tactical still wins over it', () => {
    const later = [
      { group: { tag: 'equity' }, weight: 0.5 },
      { group: { tag: 'fixed-income' }, weight: 0.4 },
      { group: { assetClass: 'cash' }, weight: 0.1 },
    ];
    const points = [
      { effectiveFrom: '2026-01-01', targets: BALANCED.strategic.targets },
      { effectiveFrom: '2027-01-01', targets: later },
    ];
    const stepped = createModelPortfolio({
      ...BALANCED,
      glidePath: { interpolation: 'step', points },
    });
    const linear = createModelPortfolio({
      ...BALANCED,
      glidePath: { interpolation: 'linear', points },
    });
    // 2026-07-02 is 182 days after 2026-01-01; the span is 365 days.
    const asOf = '2026-07-02';
    const step = resolveModelTargets({ model: stepped, asOf });
    expect(step.source).toBe('glide-path');
    expect(step.targets[0]!.weight).toBe(0.6);
    expect(step.interpolation).toBeUndefined();
    const between = resolveModelTargets({ model: linear, asOf });
    const fraction = 182 / 365;
    expect(between.interpolation).toEqual({
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2027, 0, 1),
      fraction,
    });
    // equity: 0.6 + (0.5 − 0.6) × 182/365 = 0.6 − 0.049863… = 0.550137…
    expect(between.targets[0]!.weight).toBeCloseTo(0.6 - 0.1 * fraction, 12);
    expect(between.targets[1]!.weight).toBeCloseTo(0.3 + 0.1 * fraction, 12);
    expect(between.targets[2]!.weight).toBeCloseTo(0.1, 12);
    // Past the last point the last point holds.
    expect(resolveModelTargets({ model: linear, asOf: '2028-01-01' }).targets[0]!.weight).toBe(0.5);
    // A tactical override still wins inside its window.
    const withTactical = createModelPortfolio({
      ...BALANCED,
      glidePath: { interpolation: 'linear', points },
      tactical: [{ effectiveFrom: '2026-07-01', effectiveTo: '2026-08-01', targets: later }],
    });
    expect(resolveModelTargets({ model: withTactical, asOf }).source).toBe('tactical');
  });
});

describe('expandTargets — group goals become instrument goals under ONE law', () => {
  const classification = {
    AAPL: { assetClass: 'equity', tags: ['equity', 'tech'] },
    MSFT: { assetClass: 'equity', tags: ['equity', 'tech'] },
    TLT: { assetClass: 'bond', tags: ['fixed-income'] },
  };
  const base = {
    universe: ['AAPL', 'MSFT', 'TLT'],
    instrumentClassification: classification,
    instrumentCurrency: { AAPL: 'USD', MSFT: 'USD', TLT: 'USD' },
    currentWeights: { AAPL: 0.4, MSFT: 0.2, TLT: 0.3 },
    sleeves: [],
    defaultDriftBand: 0.03,
  };
  const targets = BALANCED.strategic.targets;

  it('splits a group equally or proportionally, and never without being told how', () => {
    const equal = expandTargets('test', { ...base, targets, withinGroupAllocation: 'equal' });
    // equity 0.6 across AAPL/MSFT equally = 0.3 each; fixed-income 0.3 → TLT; cash 0.1.
    expect(equal.instrumentTargets.map((t) => [t.instrumentId, t.targetWeight])).toEqual([
      ['AAPL', 0.3],
      ['MSFT', 0.3],
      ['TLT', 0.3],
    ]);
    expect(equal.cashTarget).toEqual({ targetWeight: 0.1, driftBand: 0.03, implied: false });
    expect(equal.unresolved).toEqual([]);
    expect(equal.declaredWeightTotal).toBeCloseTo(1, 12);
    expect(equal.instrumentTargets[0]!.sourceGroups).toEqual(['tag:equity']);
    expect(equal.instrumentTargets[0]!.driftBand).toBe(0.03);

    const proportional = expandTargets('test', {
      ...base,
      targets,
      withinGroupAllocation: 'proportional-to-current',
    });
    // AAPL 0.4 / (0.4 + 0.2) × 0.6 = 0.4; MSFT 0.2.
    expect(
      proportional.instrumentTargets.find((t) => t.instrumentId === 'AAPL')!.targetWeight,
    ).toBeCloseTo(0.4, 12);
    expect(
      proportional.instrumentTargets.find((t) => t.instrumentId === 'MSFT')!.targetWeight,
    ).toBeCloseTo(0.2, 12);

    const undeclared = expandTargets('test', {
      ...base,
      targets,
      withinGroupAllocation: undefined,
    });
    expect(undeclared.unresolved.map((u) => u.key)).toEqual(['tag:equity']);
    expect(undeclared.unresolved[0]!.reason).toContain('withinGroupAllocation');
    // The single-member group still resolves.
    expect(undeclared.instrumentTargets.find((t) => t.instrumentId === 'TLT')!.targetWeight).toBe(
      0.3,
    );
    // Proportional with nothing held falls back to equal — and says so.
    const empty = expandTargets('test', {
      ...base,
      currentWeights: {},
      targets,
      withinGroupAllocation: 'proportional-to-current',
    });
    expect(empty.instrumentTargets.find((t) => t.instrumentId === 'AAPL')!.targetWeight).toBe(0.3);
    expect(empty.warnings[0]).toContain('split equally');
  });

  it('flows a sleeve target down the tree', () => {
    const sleeves = [
      { sleeveId: 'equity' },
      {
        sleeveId: 'us',
        parentSleeveId: 'equity',
        weightWithinParent: 0.7,
        members: [{ instrumentId: 'AAPL', weight: 1 }],
      },
      {
        sleeveId: 'international',
        parentSleeveId: 'equity',
        weightWithinParent: 0.3,
        members: [{ instrumentId: 'VXUS', weight: 1 }],
      },
    ];
    const out = expandTargets('test', {
      ...base,
      universe: ['AAPL'],
      sleeves,
      targets: [
        { group: { sleeveId: 'equity' }, weight: 0.6 },
        { group: { assetClass: 'cash' }, weight: 0.4 },
      ],
      withinGroupAllocation: undefined,
    });
    // AAPL 0.6 × 0.7 = 0.42; VXUS 0.6 × 0.3 = 0.18 (joins the universe through the sleeve).
    expect(out.instrumentTargets.map((t) => [t.instrumentId, t.targetWeight])).toEqual([
      ['AAPL', 0.42],
      ['VXUS', 0.18],
    ]);
    expect(out.groupTargets[0]!.members).toEqual(['AAPL', 'VXUS']);
    expect(out.unresolved).toEqual([]);
  });

  it('reports conflicts, empty groups, risk budgets, implied zeros, and undeclared remainders', () => {
    // AAPL named by an instrument target AND the equity group: two goals for one holding.
    const conflict = expandTargets('test', {
      ...base,
      targets: [
        { group: { instrumentId: 'AAPL' }, weight: 0.2 },
        { group: { tag: 'equity' }, weight: 0.5 },
        { group: { tag: 'fixed-income' }, weight: 0.2 },
        { group: { assetClass: 'cash' }, weight: 0.1 },
      ],
      withinGroupAllocation: 'equal',
    });
    expect(conflict.unresolved.map((u) => u.key).sort()).toEqual([
      'instrumentId:AAPL',
      'tag:equity',
    ]);
    expect(conflict.unresolved[0]!.reason).toContain('overlapping targets');
    expect(conflict.instrumentTargets.some((t) => t.instrumentId === 'AAPL')).toBe(false);

    const empty = expandTargets('test', {
      ...base,
      targets: [
        { group: { tag: 'commodities' }, weight: 0.1 },
        { group: { tag: 'equity' }, weight: 0.6 },
        { group: { tag: 'fixed-income' }, weight: 0.2 },
        { group: { assetClass: 'cash' }, weight: 0.1 },
      ],
      withinGroupAllocation: 'equal',
    });
    expect(empty.unresolved.map((u) => u.key)).toEqual(['tag:commodities']);
    expect(empty.unresolved[0]!.reason).toContain('no instrument in the universe');

    const risk = expandTargets('test', {
      ...base,
      targets: [
        { group: { tag: 'equity' }, riskBudget: 0.6 },
        { group: { tag: 'fixed-income' }, riskBudget: 0.4 },
      ],
      withinGroupAllocation: 'equal',
    });
    // Both budgets need a covariance; with no weights declared, the three holdings are uncovered too.
    expect(
      risk.unresolved.filter((u) => u.reason.includes('covariance')).map((u) => u.key),
    ).toEqual(['tag:equity', 'tag:fixed-income']);
    expect(risk.unresolved).toHaveLength(5);
    expect(risk.instrumentTargets).toEqual([]);

    // Targets sum to 1 → an uncovered holding (GLD) has an implied target of 0.
    const implied = expandTargets('test', {
      ...base,
      universe: ['AAPL', 'MSFT', 'TLT', 'GLD'],
      targets,
      withinGroupAllocation: 'equal',
    });
    const gold = implied.instrumentTargets.find((t) => t.instrumentId === 'GLD')!;
    expect(gold).toEqual({
      instrumentId: 'GLD',
      targetWeight: 0,
      driftBand: 0.03,
      sourceGroups: [],
      implied: true,
    });
    expect(implied.unresolved).toEqual([]);

    // Targets sum to 0.9 with GLD uncovered → the remainder is undeclared, never assumed.
    const remainder = expandTargets('test', {
      ...base,
      universe: ['AAPL', 'MSFT', 'TLT', 'GLD'],
      targets: [
        { group: { tag: 'equity' }, weight: 0.6 },
        { group: { tag: 'fixed-income' }, weight: 0.3 },
      ],
      withinGroupAllocation: 'equal',
    });
    expect(remainder.unresolved.map((u) => u.key)).toEqual(['instrumentId:GLD']);
    expect(remainder.unresolved[0]!.reason).toContain('0.9');
    expect(remainder.cashTarget).toBeNull();
    // Fully covered instruments but no cash target and 0.9 declared → the cash remainder is undeclared.
    const noCash = expandTargets('test', {
      ...base,
      targets: [
        { group: { tag: 'equity' }, weight: 0.6 },
        { group: { tag: 'fixed-income' }, weight: 0.3 },
      ],
      withinGroupAllocation: 'equal',
    });
    expect(noCash.unresolved.map((u) => u.key)).toEqual(['assetClass:cash']);
    // Sum to 1 without a cash target → cash 0 implied.
    const impliedCash = expandTargets('test', {
      ...base,
      targets: [
        { group: { tag: 'equity' }, weight: 0.7 },
        { group: { tag: 'fixed-income' }, weight: 0.3 },
      ],
      withinGroupAllocation: 'equal',
    });
    expect(impliedCash.cashTarget).toEqual({ targetWeight: 0, driftBand: 0.03, implied: true });
    expect(targetGroupKey({ assetClass: 'cash' })).toBe('assetClass:cash');
  });
});

describe('requireInvestmentPolicy — a closed, explicit policy', () => {
  it('accepts the accepted example and echoes it validated', () => {
    const policy = requireInvestmentPolicy('test', 'policy', {
      targets: BALANCED.strategic.targets,
      withinGroupAllocation: 'proportional-to-current',
      driftBand: 0.03,
      maximumTurnover: 0.15,
      minimumCash: 5_000,
      limits: {
        maximumPositionWeight: 0.25,
        maximumDrawdown: 0.2,
        maximumGroupWeights: [{ group: { tag: 'tech' }, maximumWeight: 0.4 }],
      },
      allowedAccounts: ['main'],
      contributionHandling: 'invest-to-targets',
      lotSelectionObjective: 'tax-aware-extension-v1',
    });
    expect(policy.targets).toHaveLength(3);
    expect(policy.limits!.maximumGroupWeights![0]!.maximumWeight).toBe(0.4);
    expect(policy.lotSelectionObjective).toBe('tax-aware-extension-v1');
  });

  it('refuses two sources of goals, contradictory lists, out-of-range limits, and unknown keys', () => {
    const refuse = (policy: unknown, code: string, fragment: string): void => {
      const error = caught(() => requireInvestmentPolicy('test', 'policy', policy));
      expect(isQuantError(error, code), String((error as Error)?.message)).toBe(true);
      expect((error as Error).message).toContain(fragment);
    };
    const model = createModelPortfolio(BALANCED);
    refuse(
      { targets: BALANCED.strategic.targets, model },
      'input.out_of_range',
      'exactly one place',
    );
    refuse(
      { allowedInstruments: ['AAPL'], restrictedInstruments: ['AAPL'] },
      'input.out_of_range',
      'both allows and restricts',
    );
    refuse({ limits: { maximumDrawdown: 1.5 } }, 'input.out_of_range', '[0, 1]');
    refuse({ limits: { maximumGrossLeverage: 0 } }, 'input.out_of_range', '> 0');
    refuse({ minimumCashWeight: 2 }, 'input.out_of_range', '[0, 1]');
    refuse({ withinGroupAllocation: 'random' }, 'input.invalid_enum', 'proportional-to-current');
    refuse({ driftband: 0.03 }, 'input.unknown_field', 'driftband');
    refuse({ limits: { maxDrawdown: 0.2 } }, 'input.unknown_field', 'maxDrawdown');
    refuse({ model: { ...model, version: 3 } }, 'artifact.id_mismatch', 'edited after creation');
  });
});
