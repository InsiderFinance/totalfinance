/**
 * A FIXTURE IS A CLAIM ABOUT THE CALLABLE, NOT ABOUT THE SPELLING IT WAS FILED UNDER.
 *
 * Fixtures were keyed to one public id, so every other name for the same runtime function was
 * measured against synthesis instead. `collectAsync` was the visible case: the scoped name built a
 * real `IndicatorStream` from its fixture and reported `async-result-unobserved`, while both umbrella
 * spellings failed to build one and reported `callback-input-required` — one function, one contract,
 * two accounts of what was wrong with it.
 *
 * Fixtures are now pooled across the semantic callable group (resolved function object + complete
 * contract fingerprint + invocation mode) and the source is recorded. These bind the properties that
 * make that safe: the evidence converges, it stays traceable, and it does NOT come from re-running
 * every alias — which would inflate execution counts and, for a stateful callable, make the result
 * depend on probe order.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sameCallShape, type ContractRecord } from './contract-enforcement.js';

const artifact = JSON.parse(
  readFileSync(fileURLToPath(new URL('./public-enforcement.json', import.meta.url)), 'utf8'),
) as {
  summary: { mutationsExecuted: Record<string, number>; inherited: number };
  enforcement: {
    id: string;
    implementation: string;
    verdict: string;
    unmeasuredReason?: string;
    fixtureSource?: string;
    measurementSource?: string;
    inheritedFrom?: string;
    mutationsExecuted?: Record<string, number>;
  }[];
};
const rows = artifact.enforcement;

/**
 * Field-rich contracts legitimately add probes without adding roots. A probes/root ceiling crossed
 * 35 after 290 extra null checks and 290 optional-type checks, while all 3,084 aliases still reused
 * evidence. Check the accounting directly: no alias executes, and every global counter equals the
 * sum of physical roots. The inherited-population ratchet tightens from >1,000 to the measured
 * 3,084 aliases. Defect plants prove aliases cannot lose attribution or double-claim executions.
 */
function aliasProbeAccountingErrors(subject: typeof artifact): string[] {
  const errors: string[] = [];
  const totals: Record<string, number> = {};
  let inherited = 0;
  for (const row of subject.enforcement) {
    if (row.inheritedFrom) inherited += 1;
    if (row.inheritedFrom || row.measurementSource) {
      if (row.mutationsExecuted) errors.push(`${row.id}: alias claims executions`);
      continue;
    }
    for (const [kind, count] of Object.entries(row.mutationsExecuted ?? {})) {
      totals[kind] = (totals[kind] ?? 0) + count;
    }
  }
  if (inherited !== subject.summary.inherited)
    errors.push('inherited total differs from alias rows');
  if (inherited < 3084) errors.push('inherited alias population regressed');
  for (const kind of new Set([
    ...Object.keys(totals),
    ...Object.keys(subject.summary.mutationsExecuted),
  ])) {
    if ((totals[kind] ?? 0) !== (subject.summary.mutationsExecuted[kind] ?? 0))
      errors.push(`${kind}: total differs from physical roots`);
  }
  return errors;
}

describe('pooled fixtures make one callable give one answer', () => {
  it('every `collectAsync` and `streamAsync` spelling reports the same reason', () => {
    // The named case. Three spellings each, and they disagreed 2-to-1 before pooling.
    for (const name of ['collectAsync', 'streamAsync']) {
      const family = rows.filter(
        (row) => row.id.endsWith(`:${name}`) || row.id.endsWith(`.${name}`),
      );
      expect(family.length, `${name} lost its aliases`).toBeGreaterThanOrEqual(3);
      const reasons = new Set(family.map((row) => `${row.verdict}/${row.unmeasuredReason ?? '-'}`));
      expect([...reasons], `${name} spellings disagree`).toEqual([
        'unmeasured/async-result-unobserved',
      ]);
    }
  });

  it('a fixture written under one name is used by the others, and says so', () => {
    // Traceability is the price of sharing: attribution without a recorded source is untraceable
    // evidence, so every pooled use names the path whose fixture produced it.
    const pooled = rows.filter((row) => row.fixtureSource);
    expect(
      pooled.length,
      'no record uses a pooled fixture — pooling is not reaching measurement',
    ).toBeGreaterThan(0);
    /**
     * The source must be a real path. It may equal the record's OWN id: once the group's evidence is
     * fanned out, the member that CONTRIBUTED the fixture receives it back, and "this path's fixture
     * produced this evidence" is exactly what that means. An earlier version asserted the two always
     * differ and failed on that case — the assertion was wrong, not the record.
     */
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of pooled) {
      expect(
        byId.get(row.fixtureSource!),
        `${row.id} names a missing fixture source`,
      ).toBeDefined();
    }
    // At least one record genuinely borrows from another name, or pooling is doing no work.
    expect(pooled.some((row) => row.fixtureSource !== row.id)).toBe(true);
  });

  it('a pooled fixture only crosses between paths with the SAME contract', () => {
    /**
     * Asserted on the contract fingerprint, NOT on `implementation`.
     *
     * The first version of this test compared `implementation` and failed on a true positive:
     * `@totalfinance/fixed-income:bootstrapHazardFromCds` and its `credit.` spelling record
     * `credit.d.ts#bootstrapHazardFromCds` and `credit.d.ts#credit.bootstrapHazardFromCds` — one
     * runtime function reached through two declaration paths. That is precisely why a
     * declaration-template identity cannot be the group key, and the test had reintroduced it.
     *
     * The runtime function object is not observable from the artifact, so this checks the half that
     * is: two paths sharing a fixture must declare the same call shape.
     *
     * The FIELD INDEX is excluded — `sameCallShape(a, b, true)` — because the group key excludes it,
     * deliberately and for a measured reason: it is package-qualified, so `buildStrategy` carries 79
     * paths under its scoped name and 3 through the umbrella FOR ONE DECLARATION OF ONE FUNCTION.
     * Keeping it here would assert the opposite of the ruling and fail on 34 genuine twins. What the
     * index is used for is pooled instead (`poolFieldIndex`), so the group is measured through the
     * richest one rather than through whichever member sorted first.
     */
    const contracts = JSON.parse(
      readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
    ) as { contracts: ContractRecord[] };
    const byContractId = new Map(contracts.contracts.map((record) => [record.id, record]));
    const crossed: string[] = [];
    for (const row of rows) {
      if (!row.fixtureSource) continue;
      if (!sameCallShape(byContractId.get(row.id), byContractId.get(row.fixtureSource), true)) {
        crossed.push(`${row.id} <- ${row.fixtureSource}`);
      }
    }
    expect(crossed, 'a fixture was pooled across differing contracts').toEqual([]);
  });
});

describe('sharing evidence does not mean re-running it', () => {
  it('only records that MEASURED carry execution counts', () => {
    // The ruling's accounting: `mutationsExecuted` is physical probes, never fan-out. An inherited
    // record borrows coverage and must not claim executions it never performed.
    const wrong = rows.filter((row) => row.inheritedFrom && row.mutationsExecuted).map((r) => r.id);
    expect(wrong, 'inherited records are claiming physical executions').toEqual([]);
  });

  it('every physical execution is accounted for once, at a measurement root', () => {
    expect(aliasProbeAccountingErrors(artifact)).toEqual([]);
  });

  it('PLANT: detects an inherited alias claiming its own physical probes', () => {
    const alias = rows.find((row) => row.inheritedFrom)!;
    const subject = {
      ...artifact,
      enforcement: rows.map((row) =>
        row === alias ? { ...row, mutationsExecuted: { 'wrong-type': 1 } } : row,
      ),
    };
    expect(aliasProbeAccountingErrors(subject)).toContain(`${alias.id}: alias claims executions`);
  });

  it('PLANT: detects an alias losing attribution even when its summary count is adjusted', () => {
    const alias = rows.find((row) => row.inheritedFrom)!;
    const { inheritedFrom: _inherited, measurementSource: _source, ...withoutAttribution } = alias;
    const subject = {
      ...artifact,
      summary: { ...artifact.summary, inherited: artifact.summary.inherited - 1 },
      enforcement: rows.map((row) => (row === alias ? withoutAttribution : row)),
    };
    expect(aliasProbeAccountingErrors(subject)).toContain('inherited alias population regressed');
  });

  it('PLANT: detects duplicate executions claimed only in the global total', () => {
    const subject = {
      ...artifact,
      summary: {
        ...artifact.summary,
        mutationsExecuted: {
          ...artifact.summary.mutationsExecuted,
          'wrong-type': artifact.summary.mutationsExecuted['wrong-type']! + 1,
        },
      },
    };
    expect(aliasProbeAccountingErrors(subject)).toContain(
      'wrong-type: total differs from physical roots',
    );
  });
});

describe('a group is measured once, at a deterministic canonical path', () => {
  it('every attributed record names a source that MEASURED', () => {
    // A chain of attributions would mean nobody ran anything. The source must be a root: a record
    // that did the work itself.
    const byId = new Map(rows.map((row) => [row.id, row]));
    const chained: string[] = [];
    for (const row of rows) {
      if (!row.measurementSource) continue;
      const source = byId.get(row.measurementSource);
      expect(source, `${row.id} names a missing measurement source`).toBeDefined();
      if (source!.measurementSource) chained.push(`${row.id} -> ${row.measurementSource}`);
    }
    expect(chained, 'evidence was attributed from a record that was itself attributed').toEqual([]);
  });

  it('the canonical path is the lowest id in its group — not whichever ran first', () => {
    /**
     * This is the order-independence property in the form the artifact can show.
     *
     * Before grouping, which name became canonical depended on iteration order, and a fixture-less
     * name reaching the callable first left its worse result on every twin permanently. Choosing the
     * lowest id makes the canonical a property of the SET.
     */
    const members = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.measurementSource) continue;
      const list = members.get(row.measurementSource) ?? [];
      list.push(row.id);
      members.set(row.measurementSource, list);
    }
    expect(
      members.size,
      'nothing was fanned out — the group measurement is not running',
    ).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const [source, ids] of members) {
      for (const id of ids) if (id < source) wrong.push(`${id} < ${source}`);
    }
    expect(wrong, 'a group was measured at something other than its lowest id').toEqual([]);
  });

  it('attributed records carry coverage but never execution', () => {
    // The ruling's accounting, at the record level: `mutationsCovered` travels with the evidence,
    // `mutationsExecuted` stays with the measurement.
    const offenders = rows
      .filter((row) => row.measurementSource && row.mutationsExecuted)
      .map((row) => row.id);
    expect(offenders, 'an attributed record claims probes it never ran').toEqual([]);
  });
});
