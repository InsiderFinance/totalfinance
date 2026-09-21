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

  it('execution total stays far below the record count — aliases do not each re-probe', () => {
    // 4,400+ public paths against ~2,400 inherited ones: if every alias re-ran its probes, the
    // executed totals would scale with paths rather than with distinct callables.
    const executed = Object.values(artifact.summary.mutationsExecuted).reduce((a, b) => a + b, 0);
    const measuredRows = rows.filter((row) => !row.inheritedFrom).length;
    expect(artifact.summary.inherited, 'inheritance collapsed').toBeGreaterThan(1000);
    /**
     * Re-seated 12 → 17 on 2026-08-14, and the rise is a new probe running, not fan-out returning.
     * `null-when-nonnullable` fires once per declared non-nullable field (9,205 executions), which
     * raises probes PER MEASUREMENT — the numerator this ratio was never meant to police. What it
     * exists to catch is executions scaling with PATHS, and that invariant is held by the two
     * assertions beside it: inherited rows stay >1000 and carry no `mutationsExecuted` at all.
     * Measured 16.27 at re-seat; the ceiling sits snug so the next real fan-out regression is
     * visible, per the gate-closeout rule that slack is what stops a bound seeing the next jump.
     *
     * Re-seated 17 → 18 on 2026-08-19 (FC1, measured 17.40): the valuation package's heads carry
     * closed many-field contracts, so each MEASUREMENT runs more probes — the same numerator class
     * as the 12 → 17 re-seat. Verified against the invariant this ratio exists to hold before
     * moving it: all 56 umbrella spellings of the valuation family inherit; only the 29 package
     * spellings carry `mutationsExecuted`.
     *
     * Re-seated 18 → 33 on 2026-08-19 (FC2, measured 32.32 after the declaration-built forecast
     * baselines landed): the typed statement contracts carry ~45 nested non-nullable fields
     * across three statements, and every fundamentals head is probed per FIELD — thousands of
     * physical probes per measurement, the deepest contracts in the library. Same verification
     * before moving: all 231 umbrella spellings of the fundamentals/valuation family inherit;
     * only the 143 package spellings execute probes.
     *
     * Re-seated 33 → 34 on 2026-09-04 (Stage 4.6 slice 6, measured 33.03): the two out-of-sample
     * verbs carry the whole grid request (the cross-sectional request one level deeper), so each
     * MEASUREMENT runs the deepest backtest contracts' probes once more — the same numerator class.
     * Verified before moving: the umbrella spellings of both verbs inherit; only the package
     * spellings execute probes.
     *
     * Re-seated 34 → 35 on 2026-09-21 (pre-publish repairs B1–B7 + C, measured 34.55): the MCP
     * envelope doors (`operationResultSchema` 1,307 executions, `spilledResultSchema` 603) are
     * probed per field of the full OperationResult envelope, and the new chain, contract and
     * combo doors carry closed many-field requests — the same numerator class as every re-seat
     * above. Verified before moving: every umbrella spelling of the new doors (chainGreeks,
     * usEquityOption, portfolioVaR, isTrustworthy, sideOf, signOf) inherits with zero executions;
     * only the package spellings execute probes.
     */
    expect(executed / Math.max(measuredRows, 1)).toBeLessThan(35);
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
