/**
 * Deterministic `optionFlowDrift` cases, shared by `tools/golden/capture-option-flow-drift-baseline.mjs`
 * (which runs them against the PUBLISHED package) and `option-flow-drift-released-parity.test.ts`
 * (which runs them against this repository). Plain JavaScript so the capture script can import it
 * without a build. Every value comes from a seeded generator: the same cases on every machine.
 *
 * The cases cover what a drift consumer can vary — tape size, with and without IDs, every
 * classification policy, symbol scope, cutoff, bucket width, price overlay, a half day and a closed
 * day — and malformed input, so errors are pinned as well as results.
 */
export function optionFlowDriftCases(resolvedExpiry) {
  const DATE = '2026-06-04';
  const OPEN = Date.parse(`${DATE}T13:30:00Z`);
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const EXPIRIES = ['2026-06-04', '2026-06-05', '2026-06-12', '2026-07-17'];
  const SIDES = ['buy', 'sell', 'unknown', undefined];
  const SYMBOLS = ['SPY', 'QQQ'];

  const tape = (n, ids) =>
    Array.from({ length: n }, (_, i) => {
      const expiry = EXPIRIES[Math.floor(random() * EXPIRIES.length)];
      const price = Math.round((0.05 + random() * 20) * 100) / 100;
      const trade = {
        contract: {
          underlying: SYMBOLS[Math.floor(random() * SYMBOLS.length)],
          type: random() < 0.5 ? 'call' : 'put',
          strike: 500 + 5 * Math.floor(random() * 40),
          style: 'american',
          expiry,
          ...resolvedExpiry(expiry),
          ...(random() < 0.9 ? { multiplier: 100 } : {}),
        },
        // From 30 minutes before the open to past the close, so out-of-session prints are covered.
        timestampMs: OPEN - 30 * 60_000 + Math.floor(random() * 7.5 * 3_600_000),
        price,
        size: 1 + Math.floor(random() * 50),
      };
      if (ids) trade.id = `p${i}`;
      if (random() < 0.7) {
        trade.bid = Math.max(0, Math.round((price - 0.05) * 100) / 100);
        trade.ask = Math.round((price + 0.05) * 100) / 100;
      }
      const side = SIDES[Math.floor(random() * SIDES.length)];
      if (side !== undefined) trade.aggressorSide = side;
      if (random() < 0.3)
        trade.premium = Math.round(price * trade.size * 100 * (0.9 + random() * 0.2));
      if (random() < 0.5) trade.underlyingPrice = Math.round((600 + random()) * 100) / 100;
      if (random() < 0.2) trade.exchange = `X${Math.floor(random() * 5)}`;
      if (random() < 0.2) trade.sequence = i;
      return trade;
    });

  const configs = [
    undefined,
    { bucketMinutes: 1 },
    { symbol: 'SPY', bucketMinutes: 5 },
    {
      classificationSource: 'provided-only',
      multiplier: 100,
      bucketMinutes: 1,
      asOf: OPEN + 3 * 3_600_000,
    },
    { classificationSource: 'quotes-only' },
    { classificationSource: 'provided-or-quotes', minimumClassificationCoverage: 0.2 },
    {
      symbol: 'QQQ',
      priceOverlay: {
        symbol: 'QQQ',
        trades: [{ symbol: 'QQQ', timestampMs: OPEN + 1_000, price: 400, size: 1 }],
        quotes: [{ symbol: 'QQQ', timestampMs: OPEN + 61_000, bid: 399.5, ask: 400.5 }],
      },
    },
  ];
  const cases = [];
  for (const n of [0, 1, 50, 2_000]) {
    for (const ids of [true, false]) {
      const trades = tape(n, ids);
      configs.forEach((config, c) =>
        cases.push({
          name: `${n} prints, ${ids ? 'ids' : 'no ids'}, config ${c}`,
          input: { trades, session: { date: DATE }, ...(config === undefined ? {} : { config }) },
        }),
      );
    }
  }
  cases.push({
    name: 'half day',
    input: { trades: tape(300, true), session: { date: '2026-11-27' } },
  });
  cases.push({
    name: 'closed day',
    input: { trades: tape(30, true), session: { date: '2026-06-06' } },
  });

  const base = tape(30, true);
  const copy = () => base.map((t) => ({ ...t, contract: { ...t.contract } }));
  const malformed = [
    ['unparseable expiry', (t) => (t.contract.expiry = 'not-a-date')],
    ['negative size', (t) => (t.size = -1)],
    ['NaN price', (t) => (t.price = Number.NaN)],
    ['unknown side label', (t) => (t.aggressorSide = 'up')],
    ['contract type', (t) => (t.contract.type = 'future')],
    ['negative premium', (t) => (t.premium = -5)],
    ['fractional timestamp', (t) => (t.timestampMs += 0.5)],
    ['repeated id', (t, all) => (t.id = all[0].id)],
    [
      'overflowing premium',
      (t) => {
        t.price = 1e300;
        t.size = 1e300;
        delete t.premium;
      },
    ],
    ['negative sequence', (t) => (t.sequence = -1)],
  ];
  for (const [name, mutate] of malformed) {
    const trades = copy();
    mutate(trades[5], trades);
    cases.push({ name: `error: ${name}`, input: { trades, session: { date: DATE } } });
  }
  const withNull = copy();
  withNull[5] = null;
  cases.push({ name: 'error: null print', input: { trades: withNull, session: { date: DATE } } });
  cases.push({
    name: 'error: unknown classification source',
    input: { trades: base, session: { date: DATE }, config: { classificationSource: 'guess' } },
  });
  const twoBad = copy();
  twoBad[2].id = twoBad[0].id;
  twoBad[3].size = -1;
  cases.push({
    name: 'error: the first of two failures wins',
    input: { trades: twoBad, session: { date: DATE } },
  });
  return cases;
}

/**
 * The comparable form of an outcome: the full result, or the error's name, code and message. -0 is
 * written as "-0" because JSON would print it as 0.
 */
export function optionFlowDriftOutcome(run, input) {
  let outcome;
  try {
    outcome = { result: run(input) };
  } catch (error) {
    outcome = { error: `${error.name}|${error.code}|${error.message}` };
  }
  return JSON.stringify(outcome, (_key, value) => (Object.is(value, -0) ? '-0' : value));
}
