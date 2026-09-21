import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InputError, isComputed } from '@totalfinance/core';
import { observedSkew, type ObservedSkewInput } from '@totalfinance/volatility';
import { volatility } from 'totalfinance';
import {
  planVariants,
  poolFieldIndex,
  type ContractRecord,
} from '../../manifest/contract-enforcement.js';
import { expandedCoordinates } from '../../manifest/contract-synthesis.js';
import { OBSERVED_SKEW_FIXTURES } from './observed-skew.js';

describe('observed-skew first-touch fixture shard', () => {
  const keys = ['volatility.observedSkew', 'totalfinance.volatility.observedSkew'] as const;
  const fresh = (key: (typeof keys)[number] = keys[0]): ObservedSkewInput =>
    OBSERVED_SKEW_FIXTURES[key]!()[0] as ObservedSkewInput;

  it.each(keys)('%s supplies fresh canonical input and a successful Computed result', (key) => {
    const input = fresh(key);
    const result = observedSkew(input);
    expect(isComputed(result)).toBe(true);
    expect(result.value.unavailableReason).toBeNull();
    expect(result.value.call10Delta.selected).not.toBeNull();
    expect(result.value.put10Delta.selected).not.toBeNull();
    input.quotes[0]!.contract.strike = 1;
    expect(fresh(key).quotes[0]!.contract.strike).toBe(90);
  });

  it('pools numeric and ISO asOf under real aliases with otherwise identical, independent inputs', () => {
    expect(volatility.observedSkew).toBe(observedSkew);
    expect(Object.keys(OBSERVED_SKEW_FIXTURES)).toEqual([...keys]);
    const numeric = fresh(keys[0]);
    const iso = fresh(keys[1]);
    expect(typeof numeric.market.asOf).toBe('number');
    expect(iso.market.asOf).toBe('2026-06-01T20:00:00Z');
    expect(Date.parse(iso.market.asOf as string)).toBe(numeric.market.asOf);
    expect(iso.quotes).toEqual(numeric.quotes);
    expect(iso.config).toEqual(numeric.config);
    expect(iso.quotes).not.toBe(numeric.quotes);
    expect(iso.quotes[0]!.contract).not.toBe(numeric.quotes[0]!.contract);
    expect(volatility.observedSkew(iso)).toEqual(observedSkew(numeric));
    iso.quotes[0]!.contract.expiresAt = 1;
    iso.config.expiry = 'invalid';
    expect(fresh(keys[0])).toEqual(numeric);
    expect(fresh(keys[1]).quotes).toEqual(numeric.quotes);
    expect(fresh(keys[1]).config).toEqual(numeric.config);
  });

  it('provides valid hand fixtures for every declared asOf alternative in the real callable group', () => {
    const graph = JSON.parse(
      readFileSync(new URL('../../manifest/public-contracts.json', import.meta.url), 'utf8'),
    ) as { contracts: ContractRecord[] };
    const members = graph.contracts.filter((row) =>
      [
        '@totalfinance/volatility:observedSkew',
        'totalfinance:observedSkew',
        'totalfinance:volatility.observedSkew',
      ].includes(row.id),
    );
    expect(members.map((row) => row.id)).toContain('totalfinance:volatility.observedSkew');
    const record = members.find((row) => row.id === '@totalfinance/volatility:observedSkew')!;
    const parameters = record.signatures[0]!.parameters;
    const plan = planVariants({
      parameters,
      fields: poolFieldIndex(members),
      producers: undefined,
      declaredCoordinates: expandedCoordinates(parameters),
      hand: [
        { source: '@totalfinance/volatility:observedSkew', call: OBSERVED_SKEW_FIXTURES[keys[0]]! },
        { source: 'totalfinance:volatility.observedSkew', call: OBSERVED_SKEW_FIXTURES[keys[1]]! },
      ],
    });
    expect(plan.truncated).toBe(false);
    expect(plan.variants).toHaveLength(2);
    expect(plan.variants.every((variant) => variant.hand)).toBe(true);
    expect(new Set(plan.variants.map((variant) => variant.fixtureSource))).toEqual(
      new Set(['@totalfinance/volatility:observedSkew', 'totalfinance:volatility.observedSkew']),
    );
    const kinds = plan.variants.map((variant) => {
      const input = plan.fixtureFor(0, variant)!.call()[0] as ObservedSkewInput;
      expect(observedSkew(input).value.unavailableReason).toBeNull();
      return typeof input.market.asOf;
    });
    expect(kinds.sort()).toEqual(['number', 'string']);
  });

  it.each(keys)('%s rejects every absent consumed required field with a teaching error', (key) => {
    for (const path of [
      ['quotes'],
      ['market'],
      ['config'],
      ['market', 'spot'],
      ['market', 'asOf'],
      ['config', 'expiry'],
      ['quotes', '0', 'contract'],
      ['quotes', '0', 'timestampMs'],
      ...['underlying', 'type', 'style', 'strike', 'expiry', 'expiresAt', 'expiryConvention'].map(
        (key) => ['quotes', '0', 'contract', key],
      ),
    ]) {
      const input = fresh(key);
      let target = input as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      delete target[path.at(-1)!];
      expect(() => observedSkew(input)).toThrow(InputError);
      expect(() => observedSkew(input)).toThrow(
        expect.objectContaining({ code: 'input.missing_field' }),
      );
    }
  });

  it.each(keys)('%s applies the numeric type/finite ladder to consumed fields', (key) => {
    for (const path of [
      ['market', 'spot'],
      ['market', 'asOf'],
      ['quotes', '0', 'timestampMs'],
      ['quotes', '0', 'contract', 'strike'],
      ['quotes', '0', 'contract', 'expiresAt'],
    ]) {
      for (const [bad, code] of [
        [null, 'input.wrong_type'],
        [NaN, 'input.nan'],
        [Infinity, 'input.not_finite'],
      ] as const) {
        const input = fresh(key);
        let target = input as unknown as Record<string, unknown>;
        for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
        target[path.at(-1)!] = bad;
        expect(() => observedSkew(input)).toThrow(expect.objectContaining({ code }));
      }
    }
  });
});
