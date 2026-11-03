import { it, expect } from 'vitest';
import {
  defineDataProvider,
  createDataView,
  connect,
  createPriceBarsWindowView,
} from '@insiderfinance/totalfinance/core/data';
import { validateDataProvider } from '@insiderfinance/totalfinance/core/data-conformance';
import { QuantError } from '@insiderfinance/totalfinance/core';
import { CORE_DATA_FIXTURES } from './core-data.js';
it('first-touch connector fixtures execute public heads and returned methods', async () => {
  const input = CORE_DATA_FIXTURES['core.defineDataProvider']!()[0] as Parameters<
    typeof defineDataProvider
  >[0];
  const provider = defineDataProvider(input);
  await expect(provider.capabilities()).resolves.toMatchObject({ contractVersion: 1 });
  await expect(
    validateDataProvider(
      CORE_DATA_FIXTURES['core.validateDataProvider']!()[0] as Parameters<
        typeof validateDataProvider
      >[0],
    ),
  ).resolves.toBeUndefined();
  expect(createDataView(CORE_DATA_FIXTURES['core.createDataView']!()[0]).kind).toBe('price-bars');
  for (const value of [undefined, null, [], {}, 42]) {
    if (
      value !== undefined &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      await expect(provider.capabilities({ unexpected: true } as never)).rejects.toBeInstanceOf(
        QuantError,
      );
    } else if (value !== undefined)
      await expect(provider.capabilities(value as never)).rejects.toBeInstanceOf(QuantError);
    await expect(provider.query(value as never)).rejects.toBeInstanceOf(QuantError);
    await expect(validateDataProvider(value as never)).rejects.toBeInstanceOf(QuantError);
  }
});

it('C3 first-touch reaches both public constructors and the returned window method', async () => {
  const data = connect(CORE_DATA_FIXTURES['core.connect']!()[0] as Parameters<typeof connect>[0], {
    pageSize: 2,
  });
  const prices = await data.priceBars({
    symbol: 'TEST',
    interval: '1d',
    from: '2026-10-26',
    to: '2026-10-28',
  });
  expect(prices.closePrices).toEqual([]);
  expect(
    createPriceBarsWindowView(CORE_DATA_FIXTURES['core.createPriceBarsWindowView']!()[0]).window,
  ).toEqual(prices.window);
  expect(() => connect({ provider: CORE_DATA_FIXTURES['core.connect']!()[0] } as never)).toThrow(
    QuantError,
  );
  await expect(
    data.priceBars({
      symbol: 'TEST',
      interval: '1d',
      from: '2026-10-26',
      to: '2026-10-28',
      limit: 2,
    } as never),
  ).rejects.toBeInstanceOf(QuantError);
});
