import type { DataQuery, DataQueryOptions } from '../src/data-types.js';
import {
  fixtureProbe,
  defineFixtureProvider,
  queryFixture,
  fixtureSourceOf,
} from './data-fixture-migration.js';
import { it, expect } from 'vitest';

import { createDataView, connect, createPriceBarsWindowView } from '../src/data.js';
import {
  bar,
  chain,
  page,
  barCapability,
  dailyRequest,
} from '../../../docs/examples/community-connector-facts.js';
function provider(value: any) {
  return defineFixtureProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [barCapability],
      };
    },
    async query() {
      return value;
    },
  });
}
for (const basis of ['unadjusted', 'split', 'split-and-dividend'] as const) {
  it('refuses contradictory ' + basis + ' at every price door', async () => {
    const raw = {
      ...page(),
      metadata: { ...page().metadata, adjustment: basis },
      data: [{ ...bar(), bar: { ...bar().bar, adjusted: basis === 'unadjusted' } }],
    };
    expect(() => createDataView(raw)).toThrowError(
      expect.objectContaining({ code: 'data.invalid_response' }),
    );
    await expect(queryFixture(provider(raw), dailyRequest)).rejects.toMatchObject({
      code: 'data.invalid_response',
    });
    await expect(
      connect(fixtureSourceOf(provider(raw))).priceBars({
        symbol: 'TEST',
        interval: '1d',
        from: dailyRequest.from,
        to: dailyRequest.to,
      }),
    ).rejects.toMatchObject({ code: 'data.invalid_response' });
  });
}
for (const basis of ['unknown', 'unadjusted', 'split', 'split-and-dividend'] as const)
  for (const flag of [true, false, undefined]) {
    if (basis !== 'unknown' && flag !== undefined && flag !== (basis !== 'unadjusted')) continue;
    it('preserves ' + basis + '/' + flag, () => {
      const b = { ...bar().bar };
      delete b.adjusted;
      if (flag !== undefined) b.adjusted = flag;
      const raw = {
        ...page(),
        metadata: { ...page().metadata, adjustment: basis },
        data: [{ ...bar(), bar: b }],
      };
      expect(createDataView(raw).page.data).toEqual(raw.data);
    });
  }
it('distinguishes scanner-first NaN and undefined metadata safely', async () => {
  await expect(
    queryFixture(
      provider({ ...page(), data: [{ ...bar(), bar: { ...bar().bar, close: NaN } }] }),
      dailyRequest,
    ),
  ).rejects.toMatchObject({
    code: 'data.invalid_response',
    context: { path: 'data[].bar.close', reason: 'not_finite', rowIndex: 0 },
  });
  await expect(
    queryFixture(
      provider({ ...page(), metadata: { ...page().metadata, datasetId: undefined } }),
      dailyRequest,
    ),
  ).rejects.toMatchObject({
    code: 'data.invalid_response',
    context: { path: 'metadata.datasetId', reason: 'missing_field' },
  });
});
it('orders real same-term identities without changing their roots', () => {
  const a = { ...chain(), sourceContractId: 'a', terms: { ...chain().terms, root: 'TEST' } },
    b = { ...chain(), sourceContractId: 'b', terms: { ...chain().terms, root: 'TEST1' } };
  expect(createDataView({ ...page('option-chain-research'), data: [a, b] }).page.data).toEqual([
    a,
    b,
  ]);
  expect(() => createDataView({ ...page('option-chain-research'), data: [b, a] })).toThrow();
  expect(() => createDataView({ ...page('option-chain-research'), data: [a, a] })).toThrow();
});
for (const field of ['bid', 'ask', 'mid', 'last', 'mark', 'theoreticalPrice'])
  for (const value of [-1, 0])
    it(field + ' ' + value, () => {
      const r = {
        ...chain(),
        ...(field === 'theoreticalPrice'
          ? { theoreticalPrice: value }
          : { quote: { [field]: value } }),
      };
      const run = () => createDataView({ ...page('option-chain-research'), data: [r] });
      if (value < 0)
        expect(run).toThrowError(expect.objectContaining({ code: 'data.invalid_response' }));
      else expect(run().page.data).toEqual([r]);
    });

import { validateDataProvider } from '../src/data-conformance.js';
import { InputError, ErrorCode } from '../src/errors.js';
import { dataSequence } from '../src/data-sequence-validation.js';
it('same-term contracts work across pages; duplicates and tie reversal do not', async () => {
  const a = { ...chain(), sourceContractId: 'a' },
    b = { ...chain(), sourceContractId: 'b' };
  const first = { ...page('option-chain-research'), data: [a], nextCursor: 'next' },
    last = { ...page('option-chain-research'), data: [b] };
  const sequence = dataSequence();
  sequence(first);
  sequence(last);
  const reverse = dataSequence();
  reverse(last);
  expect(() => reverse(first)).toThrow();
  const duplicate = dataSequence();
  duplicate(first);
  expect(() => duplicate({ ...last, data: [a] })).toThrow();
  const source = defineFixtureProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [{ ...barCapability, kind: 'option-chain-research', intervals: [] }],
      };
    },
    async query(r) {
      return 'cursor' in r ? last : first;
    },
  });
  await validateDataProvider({
    provider: source,
    maxPages: 2,
    maxRecords: 2,
    timeoutMs: 1000,
    probes: [
      fixtureProbe({
        name: 'real IDs',
        kind: 'pages',
        request: {
          kind: 'option-chain-research',
          symbol: 'TEST',
          snapshot: { kind: 'latest' },
          limit: 1,
        },
        expectedPages: [first, last],
      }),
    ],
  });
});
it('all restoration paths refuse contradictory later rows with safe indices', async () => {
  const good = {
    ...page(),
    metadata: { ...page().metadata, adjustment: 'unadjusted' as const },
    data: [{ ...bar(), bar: { ...bar().bar, adjusted: false } }],
  };
  const { limit: _limit, kind: _kind, ...req } = dailyRequest;
  const prices = await connect(fixtureSourceOf(provider(good))).priceBars(req);
  const saved = JSON.parse(JSON.stringify(prices.window));
  saved.pages[0].data[0].bar.adjusted = true;
  expect(() => createPriceBarsWindowView(saved)).toThrowError(
    expect.objectContaining({
      code: 'data.invalid_response',
      context: expect.objectContaining({ path: 'data[].bar.adjusted', pageIndex: 0, rowIndex: 0 }),
    }),
  );
  saved.pages[0].data[0].bar.close = NaN;
  expect(() => createPriceBarsWindowView(saved)).toThrowError(
    expect.objectContaining({
      context: expect.objectContaining({
        path: 'data[].bar.close',
        pageIndex: 0,
        rowIndex: 0,
        reason: 'not_finite',
      }),
    }),
  );
});
it('kit retains the actual SDK validation detail and rejects expected invalid pages', async () => {
  const expected = { ...page(), data: [bar()] };
  const bad = { ...expected, data: [{ ...bar(), bar: { ...bar().bar, close: NaN } }] };
  await expect(
    validateDataProvider({
      provider: provider(bad),
      maxPages: 1,
      maxRecords: 2,
      timeoutMs: 1000,
      probes: [
        fixtureProbe({
          name: 'mapping',
          kind: 'pages',
          request: dailyRequest,
          expectedPages: [expected],
        }),
      ],
    }),
  ).rejects.toMatchObject({
    code: 'data.nonconformant',
    context: { validation: { path: 'data[].bar.close', reason: 'not_finite', rowIndex: 0 } },
  });
});
it('unknown scanner paths, accessors and forged provider context never become schema facts', async () => {
  for (const bad of [
    { ...page(), 'data[0].bar.close': NaN },
    { ...page(), secret_url_payload: NaN },
  ]) {
    try {
      createDataView(bad);
      throw Error('accepted');
    } catch (e: any) {
      expect(e.context.path).toBe('page');
      expect(JSON.stringify(e)).not.toMatch(/secret_url_payload|https|NaN/);
    }
  }
  let reads = 0;
  const bad = {
    ...page(),
    data: [
      {
        ...bar(),
        bar: {
          ...bar().bar,
          get close() {
            reads++;
            return 101;
          },
        },
      },
    ],
  };
  expect(() => createDataView(bad)).toThrow();
  expect(reads).toBe(0);
  const p = defineFixtureProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      throw Error('unused');
    },
    async query() {
      throw new InputError('secret URL', {
        code: ErrorCode.InputWrongType,
        context: { path: 'secret', reason: 'not_finite', validationCode: 'input.not_finite' },
      });
    },
  });
  try {
    await queryFixture(p, dailyRequest);
    throw Error('accepted');
  } catch (e: any) {
    expect(e).toBeInstanceOf(InputError);
    expect(e.code).toBe('input.wrong_type');
    expect(JSON.stringify(e)).not.toMatch(/secret|URL|validationCode/);
  }
});
it('negative Greeks and general underlying prices retain their existing meaning', () => {
  const r = {
    ...chain(),
    quote: { underlyingPrice: -1 },
    greeks: { delta: -0.5, gamma: -0.1, theta: -1, vega: -1, rho: -1 },
  };
  expect(createDataView({ ...page('option-chain-research'), data: [r] }).page.data).toEqual([r]);
});

it('raw union typing still rejects a response of the wrong request kind', async () => {
  const p = provider({ ...page('option-chain-research'), data: [chain()] });
  await expect(queryFixture(p, dailyRequest)).rejects.toMatchObject({
    code: 'data.invalid_response',
    context: { phase: 'page' },
  });
});
it('ID uniqueness is independent of term ordering', () => {
  const a = { ...chain(), sourceContractId: 'same' };
  const b = { ...chain(), sourceContractId: 'same', terms: { ...chain().terms, strike: 101 } };
  const s = dataSequence();
  s({ ...page('option-chain-research'), data: [a] });
  expect(() => s({ ...page('option-chain-research'), data: [b] })).toThrowError(
    expect.objectContaining({
      context: expect.objectContaining({ reason: 'duplicate_identity', rowIndex: 0, pageIndex: 1 }),
    }),
  );
});
for (const field of ['bid', 'ask', 'mid', 'last', 'mark', 'theoreticalPrice'])
  it('refuses nonfinite ' + field + ' with safe field detail', () => {
    const r = {
      ...chain(),
      ...(field === 'theoreticalPrice' ? { theoreticalPrice: NaN } : { quote: { [field]: NaN } }),
    };
    expect(() => createDataView({ ...page('option-chain-research'), data: [r] })).toThrowError(
      expect.objectContaining({
        code: 'data.invalid_response',
        context: expect.objectContaining({
          path: 'data[].' + (field === 'theoreticalPrice' ? field : 'quote.' + field),
          reason: 'not_finite',
          rowIndex: 0,
        }),
      }),
    );
  });

it('kit reports the actual failed page index', async () => {
  const first = { ...page(), data: [bar()], nextCursor: 'next' },
    last = {
      ...page(),
      data: [{ ...bar('2026-10-28'), bar: { ...bar('2026-10-28').bar, close: NaN } }],
    };
  const p = defineFixtureProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [barCapability],
      };
    },
    async query(r) {
      return 'cursor' in r ? last : first;
    },
  });
  await expect(
    validateDataProvider({
      provider: p,
      maxPages: 2,
      maxRecords: 2,
      timeoutMs: 1000,
      probes: [
        fixtureProbe({
          name: 'later page',
          kind: 'pages',
          request: { ...dailyRequest, limit: 1 },
          expectedPages: [first, { ...page(), data: [bar('2026-10-28')] }],
        }),
      ],
    }),
  ).rejects.toMatchObject({
    code: 'data.nonconformant',
    context: { validation: { pageIndex: 1, rowIndex: 0, path: 'data[].bar.close' } },
  });
});

for (const explicit of [false, true])
  for (const field of ['terms.strike', 'bar.timestampMs', 'metadata.freshness.status'])
    it('known guard ' + field + ' explicit=' + explicit, () => {
      const raw: any = field.startsWith('terms')
        ? { ...page('option-chain-research'), data: [chain()] }
        : { ...page(), data: [bar()] };
      const parent = field.startsWith('metadata')
        ? raw.metadata.freshness
        : field.startsWith('terms')
          ? raw.data[0].terms
          : raw.data[0].bar;
      const key = field.split('.').at(-1)!;
      if (field.startsWith('metadata')) parent[key] = 'garbage';
      else if (explicit) parent[key] = undefined;
      else delete parent[key];
      expect(() => createDataView(raw)).toThrowError(
        expect.objectContaining({
          code: 'data.invalid_response',
          context: expect.objectContaining({
            phase: 'page',
            path: field.startsWith('metadata') ? field : 'data[].' + field,
            reason: field.startsWith('metadata') ? 'invalid_enum' : 'missing_field',
            ...(field.startsWith('metadata') ? {} : { rowIndex: 0 }),
          }),
        }),
      );
    });
it('capability range failure identifies capabilities door and phase', async () => {
  const p = defineFixtureProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [{ ...barCapability, maxPageSize: 0 }],
      };
    },
    async query() {
      return page();
    },
  });
  await expect(p.capabilities()).rejects.toMatchObject({
    code: 'data.invalid_response',
    message: expect.stringMatching(/^defineDataProvider.capabilities:/),
    context: {
      phase: 'capabilities',
      path: 'capabilities[].maxPageSize',
      reason: 'out_of_range',
      validationCode: 'input.out_of_range',
    },
  });
});
it('invalid expected pages are caller input errors with zero provider calls', async () => {
  let calls = 0;
  const base = provider(page());
  const p = {
    ...base,
    capabilities: async () => {
      calls++;
      return base.capabilities();
    },
    query: async <R extends DataQuery>(r: R, o: DataQueryOptions) => {
      calls++;
      return base.query(r, o);
    },
  };
  await expect(
    validateDataProvider({
      provider: p,
      maxPages: 1,
      maxRecords: 2,
      timeoutMs: 1000,
      probes: [
        fixtureProbe({
          name: 'bad expectation',
          kind: 'pages',
          request: dailyRequest,
          expectedPages: [{ ...page(), data: [{ ...bar(), bar: { ...bar().bar, close: NaN } }] }],
        }),
      ],
    }),
  ).rejects.toMatchObject({
    name: 'InputError',
    code: 'input.not_finite',
    context: { path: 'data[].bar.close', rowIndex: 0 },
  });
  expect(calls).toBe(0);
});

for (const [path, value, reason] of [
  ['metadata.times.availableTimestampMs', undefined, 'missing_field'],
  ['metadata.coverage.status', 'garbage', 'invalid_enum'],
  ['assumptions.conventionsVersion', undefined, 'missing_field'],
] as const)
  it('known page schema ' + path, () => {
    const raw: any = { ...page(), data: [bar()] };
    const keys = path.split('.');
    let target = raw;
    for (const k of keys.slice(0, -1)) target = target[k];
    delete target[keys.at(-1)!];
    if (value !== undefined) target[keys.at(-1)!] = value;
    expect(() => createDataView(raw)).toThrowError(
      expect.objectContaining({
        context: expect.objectContaining({ phase: 'page', path, reason }),
      }),
    );
  });
it('SDK date guard retains terms path without the raw invalid value', () => {
  const raw = {
    ...page('option-chain-research'),
    data: [{ ...chain(), terms: { ...chain().terms, expiry: '2026-02-30' } }],
  };
  try {
    createDataView(raw);
    throw Error('accepted invalid date');
  } catch (error: any) {
    expect(error.context).toMatchObject({
      path: 'data[].terms.expiry',
      reason: 'out_of_range',
      rowIndex: 0,
    });
    expect(JSON.stringify(error)).not.toContain('2026-02-30');
  }
});

it('scanner uses the schema of its actual phase, not lookalike aliases', async () => {
  for (const raw of [
    { ...page(), bar: { close: NaN } },
    { ...page(), terms: { strike: NaN } },
    { ...page(), capabilities: [{ maxPageSize: NaN }] },
  ]) {
    expect(() => createDataView(raw)).toThrowError(
      expect.objectContaining({
        context: expect.objectContaining({
          phase: 'page',
          path: 'page',
          reason: 'invalid_structure',
        }),
      }),
    );
  }
  const p = defineFixtureProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [barCapability],
        metadata: { datasetId: NaN },
      };
    },
    async query() {
      return page();
    },
  });
  await expect(p.capabilities()).rejects.toMatchObject({
    context: { phase: 'capabilities', path: 'capabilities', reason: 'invalid_structure' },
  });
});

for (const path of ['metadata', 'metadata.times', 'data[].bar'])
  it('omitted required object is a missing field at ' + path, () => {
    const raw: any = { ...page(), data: [bar()] };
    if (path === 'data[].bar') delete raw.data[0].bar;
    else if (path === 'metadata.times') delete raw.metadata.times;
    else delete raw.metadata;
    expect(() => createDataView(raw)).toThrowError(
      expect.objectContaining({
        context: expect.objectContaining({
          path,
          reason: 'missing_field',
          validationCode: 'input.missing_field',
        }),
      }),
    );
  });
it('missing request object retains its original input type boundary', async () => {
  await expect(queryFixture(provider(page()), undefined as any)).rejects.toMatchObject({
    name: 'InputError',
    code: 'input.wrong_type',
  });
});
