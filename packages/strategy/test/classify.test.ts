import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@totalfinance/math';
import {
  buildStrategy,
  classifyStrategy,
  ironCondor,
  legs,
  listStrategies,
  strategy,
  strategySignature,
} from '../src/index.js';
// The raw registry is internal (public dispatch is buildStrategy) — tests reach it directly.
import { strategyRegistry } from '../src/manifest.js';

/**
 * DX §4.5 — strategy identity is DERIVED, never remembered.
 *
 * The round-trip law: every manifest entry, built from its own example, classifies back to its
 * own name — so the classifier can never drift from the builders, and a new builder without a
 * registered example fails here.
 */
const market = {
  spot: 105,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T00:00:00Z',
  expiry: '2026-06-19',
} as const;

describe('the round-trip law: every builder classifies to its own name', () => {
  for (const entry of strategyRegistry()) {
    it(`${entry.name} round-trips`, () => {
      const position = entry.builder(entry.example as never, { premiums: 'model', market });
      const matches = classifyStrategy(position).matches.map((m) => m.name);
      expect(matches).toContain(entry.name);
    });
  }

  it('the manifest is complete: every builder attached to the strategy namespace is registered', () => {
    const registered = new Set(strategyRegistry().map((e) => e.name));
    const nonBuilders = new Set(['listStrategies', 'buildStrategy']);
    const attached = Object.keys(strategy).filter(
      (k) =>
        typeof (strategy as unknown as Record<string, unknown>)[k] === 'function' &&
        !nonBuilders.has(k),
    );
    for (const name of attached)
      expect(registered, `unregistered builder: ${name}`).toContain(name);
    expect(attached.length).toBe(registered.size);
  });
});

describe('buildStrategy: the public dynamic dispatch', () => {
  it('builds by name exactly like calling the builder directly', () => {
    const input = { putLong: 90, putShort: 95, callShort: 110, callLong: 115 };
    const pos = buildStrategy({
      name: 'ironCondor',
      input,
      config: { premiums: 'model', market },
    });
    expect(pos.constructedAs).toBe('ironCondor');
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('ironCondor');
  });

  it('a near-miss name gets a did-you-mean hint', () => {
    expect(() => buildStrategy({ name: 'ironcondor', input: {} })).toThrowError(
      /Did you mean 'ironCondor'/,
    );
  });

  it('an unknown name throws input.invalid_enum carrying the full catalog', () => {
    try {
      buildStrategy({ name: 'flyingButtress', input: {} });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as { code?: string; context?: { known?: string[] } };
      expect(e.code).toBe('input.invalid_enum');
      expect(e.context?.known).toContain('ironCondor');
      expect(e.context?.known?.length).toBe(listStrategies().length);
    }
  });
});

describe('classification behavior', () => {
  const condorInput = { putLong: 90, putShort: 95, callShort: 110, callLong: 115 } as const;

  it('scale invariance: a 3-lot condor is still an iron condor', () => {
    const pos = ironCondor({ ...condorInput, quantity: 3 }, { premiums: 'model', market });
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('ironCondor');
  });

  it('tweaked past recognition classifies as custom (empty match list)', () => {
    const pos = ironCondor(condorInput, { premiums: 'model', market });
    const edited = pos.legs
      .filter((l) => l.strike !== 115) // drop a wing
      .map((l) => (l.strike === 95 ? { ...l, quantity: l.quantity * 2 } : { ...l }));
    expect(classifyStrategy(edited).matches).toEqual([]);
  });

  it('a tweak that lands on ANOTHER known structure is recognized as that structure', () => {
    const pos = ironCondor(condorInput, { premiums: 'model', market });
    // Drop both put legs: what remains is exactly a bear call spread (short 110 / long 115 call).
    const edited = pos.legs.filter((l) => l.kind !== 'put');
    expect(classifyStrategy(edited).matches.map((m) => m.name)).toContain('bearCallSpread');
  });

  it('payoff-identical aliases all match (shortPut ≡ cashSecuredPut), manifest order first', () => {
    const matches = classifyStrategy([
      legs.put({ strike: 95, premium: 2, quantity: -1 }),
    ]).matches.map((m) => m.name);
    expect(matches).toContain('shortPut');
    expect(matches).toContain('cashSecuredPut');
    expect(matches[0]).toBe('shortPut');
  });

  it('wing symmetry separates butterflies from broken wings', () => {
    const fly = strategy.longCallButterfly(
      { lower: 95, middle: 105, upper: 115 },
      { premiums: 'model', market },
    );
    const bwb = strategy.callBrokenWing(
      { lower: 95, middle: 105, upper: 120 },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(fly).matches.map((m) => m.name)).toContain('longCallButterfly');
    expect(classifyStrategy(bwb).matches.map((m) => m.name)).toContain('callBrokenWing');
  });

  // Regressions for the geometry over-fit: signatures used to bake the example's wing-gap
  // symmetry into EVERY ≥3-strike structure, so a spacing different from the example → [].
  it('an EVENLY spaced iron condor is still an iron condor', () => {
    const pos = ironCondor(
      { putLong: 90, putShort: 100, callShort: 110, callLong: 120 },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('ironCondor');
  });

  it('an UNEVENLY winged iron condor is also still an iron condor', () => {
    const pos = ironCondor(
      { putLong: 80, putShort: 100, callShort: 110, callLong: 115 },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('ironCondor');
  });

  it('an equal-gap jade lizard is still a jade lizard', () => {
    const pos = strategy.jadeLizard(
      { put: 95, shortCall: 105, longCall: 115 },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('jadeLizard');
  });

  it('a narrow-wing (uneven) long call condor is still a long call condor', () => {
    const pos = strategy.longCallCondor(
      { k1: 90, k2: 95, k3: 110, k4: 115 },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('longCallCondor');
  });

  it('an unevenly spaced bull call ladder is still a bull call ladder', () => {
    const pos = strategy.bullCallLadder(
      { lower: 100, middle: 110, upper: 135 },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('bullCallLadder');
  });

  it('a diagonal call spread with REVERSED strike order still classifies to its name', () => {
    // The builder accepts either ordering of shortStrike/longStrike; the manifest example uses
    // shortStrike > longStrike, this uses the opposite.
    const pos = strategy.diagonalCallSpread(
      { shortStrike: 100, nearExpiry: '2026-06-19', longStrike: 110, farExpiry: '2026-09-18' },
      { premiums: 'model', market },
    );
    expect(classifyStrategy(pos).matches.map((m) => m.name)).toContain('diagonalCallSpread');
  });
});

/**
 * The property round-trip law: EVERY manifest entry, built not just from its example but from
 * randomized valid strike sets — varied spacing (even AND uneven), scale, and (where the builder
 * accepts it) strike order — classifies back to its own name. Deterministically seeded.
 *
 * Spacing constraints derive from each entry's DEFINING inequalities: the symmetric butterflies
 * are only butterflies with equal wings, the broken wings only with unequal wings; everything
 * else must survive both.
 */
describe('the round-trip law holds for randomized strike sets (property test)', () => {
  const EQUAL_WINGS = new Set([
    'longCallButterfly',
    'longPutButterfly',
    'shortCallButterfly',
    'shortPutButterfly',
  ]);
  const UNEQUAL_WINGS = new Set([
    'callBrokenWing',
    'putBrokenWing',
    'inverseCallBrokenWing',
    'inversePutBrokenWing',
  ]);
  /** Builders whose two strikes may come in either order (nothing constrains them). */
  const ORDER_TOLERANT = new Set(['diagonalCallSpread', 'diagonalPutSpread']);

  type Mode = 'even' | 'uneven' | 'reversed';

  /** All distinct numbers in an example, ascending — the strike values to remap. */
  const numericValues = (example: Record<string, unknown>): number[] => {
    const out = new Set<number>();
    const walk = (v: unknown): void => {
      if (typeof v === 'number') out.add(v);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(example);
    return [...out].sort((a, b) => a - b);
  };

  /**
   * A random strictly monotone (order- and equality-preserving) remap of the example's numbers:
   * varies scale and spacing while keeping every defining inequality of the input intact.
   * 'even' assigns equal gaps; 'uneven' assigns strictly growing (pairwise distinct) gaps;
   * 'reversed' inverts the order (diagonals only).
   */
  const monotoneMap = (
    values: number[],
    randomNumberGenerator: { next(): number },
    mode: Mode,
  ): Map<number, number> => {
    const base = 50 + Math.floor(randomNumberGenerator.next() * 400);
    const unit = 1 + Math.floor(randomNumberGenerator.next() * 20);
    const order = mode === 'reversed' ? [...values].reverse() : values;
    const out = new Map<number, number>();
    let x = base;
    order.forEach((v, i) => {
      out.set(v, x);
      x += mode === 'even' ? unit : unit * (i + 1) + 1;
    });
    return out;
  };

  /** Rebuild an example input with every number sent through the map (strings untouched). */
  const remap = (example: unknown, map: Map<number, number>): unknown => {
    if (typeof example === 'number') return map.get(example);
    if (Array.isArray(example)) return example.map((v) => remap(v, map));
    if (example !== null && typeof example === 'object') {
      return Object.fromEntries(Object.entries(example).map(([k, v]) => [k, remap(v, map)]));
    }
    return example;
  };

  const entries = strategyRegistry();
  entries.forEach((entry, index) => {
    it(`${entry.name} round-trips across spacing/scale${
      ORDER_TOLERANT.has(entry.name) ? '/order' : ''
    } variations`, () => {
      const randomNumberGenerator = mulberry32(0xc0ffee + index); // deterministic per entry — no Math.random flake
      const values = numericValues(entry.example);
      const modes: Mode[] = EQUAL_WINGS.has(entry.name)
        ? ['even']
        : UNEQUAL_WINGS.has(entry.name)
          ? ['uneven']
          : values.length >= 2
            ? ['even', 'uneven']
            : ['even'];
      if (ORDER_TOLERANT.has(entry.name)) modes.push('reversed');
      for (const mode of modes) {
        for (let trial = 0; trial < 4; trial++) {
          const input = remap(
            entry.example,
            monotoneMap(values, randomNumberGenerator, mode),
          ) as Record<string, unknown>;
          const built = entry.builder(input as never, { premiums: 'model', market });
          expect(
            classifyStrategy(built).matches.map((m) => m.name),
            `${entry.name} [${mode} #${trial}] input=${JSON.stringify(input)}`,
          ).toContain(entry.name);
        }
      }
      // Scale invariance in QUANTITY too: a 3-lot structure keeps its name (gcd reduction).
      const scaled = entry.builder({ ...entry.example, quantity: 3 } as never, {
        premiums: 'model',
        market,
      });
      expect(classifyStrategy(scaled).matches.map((m) => m.name)).toContain(entry.name);
    });
  });

  it('registry signatures are discriminative: no two names collapse except documented aliases', () => {
    // Two DIFFERENT named strategies must never share (base signature, wing-gap class) — else the
    // classifier could not tell them apart. The ONLY sanctioned collisions are payoff-identical
    // aliases, enumerated here. (Butterflies and broken wings share a BASE signature by design and
    // are split by the wing-gap tie-breaker, so their composite keys differ.)
    const PAYOFF_IDENTICAL_ALIASES: string[][] = [['shortPut', 'cashSecuredPut']];
    const gapClass = (
      legList: readonly { kind: string; strike?: number | undefined }[],
    ): string => {
      // (a stock row reports no strike; only option strikes shape the wing gaps)
      const strikes = [
        ...new Set(
          legList.flatMap((l) => (l.kind === 'stock' || l.strike === undefined ? [] : [l.strike])),
        ),
      ].sort((a, b) => a - b);
      if (strikes.length < 3) return 'null';
      const deltas = strikes.slice(1).map((k, i) => k - strikes[i]!);
      return deltas.some((d) => Math.abs(d - deltas[0]!) > 1e-9) ? 'asym' : 'sym';
    };
    const groups = new Map<string, string[]>();
    for (const entry of strategyRegistry()) {
      const pos = entry.builder(entry.example as never, { premiums: 'model', market });
      const key = `${strategySignature(pos.legs)}##${gapClass(pos.legs)}`;
      groups.set(key, [...(groups.get(key) ?? []), entry.name]);
    }
    for (const [key, names] of groups) {
      if (names.length === 1) continue;
      const sanctioned = PAYOFF_IDENTICAL_ALIASES.some(
        (alias) => names.length === alias.length && names.every((n) => alias.includes(n)),
      );
      expect(
        sanctioned,
        `signature collision not in the documented alias list: [${names.join(', ')}] at ${key}`,
      ).toBe(true);
    }
  });
});

describe('constructedAs provenance (dx §4.5)', () => {
  it('a named builder stamps constructedAs; raw strategy(legs) has none', () => {
    const named = ironCondor(
      { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
      { premiums: 'model', market },
    );
    expect(named.constructedAs).toBe('ironCondor');
    expect(named.assumptions().constructedAs).toBe('ironCondor');
    const raw = strategy([...named.legs]);
    expect(raw.constructedAs).toBeUndefined();
    expect(raw.assumptions().constructedAs).toBeUndefined();
  });
});

describe('listStrategies (agent discovery)', () => {
  it('serves every builder with a description and a buildable example', () => {
    const list = listStrategies();
    expect(list.length).toBeGreaterThanOrEqual(55);
    for (const d of list) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.example).toBeTypeOf('object');
    }
    expect(list.filter((d) => d.multiExpiry)).toHaveLength(5);
  });
});
