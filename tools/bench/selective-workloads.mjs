/**
 * The SG8 workloads (docs/specs/selective-greeks-and-exposure.md), shared by the Node runner
 * (`selective-greeks-and-exposure.mjs`) and the browser runner (`selective-browser.mjs`) so both time
 * identical code. `lib` is one installed `@insiderfinance/totalfinance` version's modules.
 */
export function createBench({ blackScholes, batch, structure, resolvedExpiry }, now, runs = 25) {
  // Warm up by count AND time, so a sub-millisecond workload reaches optimized code before it is
  // timed or its allocation is read (35 calls of 0.24 ms still ran partly unoptimized).
  const WARMUP = 5;
  const WARMUP_MS = 500;
  const RUNS = runs;
  const SPOT = 6500;

  // ── workloads ──────────────────────────────────────────────────────────────────────────────────
  // The GEX workload the spec names: a 7,800-contract index chain (30 expiries × 130 strikes × call/put)
  // swept across 73 spot levels on every refresh.
  const EXPIRY_COUNT = 30;
  const STRIKE_COUNT = 130;
  const ROWS = EXPIRY_COUNT * STRIKE_COUNT * 2;
  const LEVELS = Array.from({ length: 73 }, (_, i) => SPOT * (0.88 + (0.24 * i) / 72));
  const asOf = Date.parse('2026-06-15T18:30:00Z');
  const expiries = Array.from({ length: EXPIRY_COUNT }, (_, i) =>
    new Date(Date.parse('2026-06-16T00:00:00Z') + i * 7 * 86_400_000).toISOString().slice(0, 10),
  );

  const columns = {
    spot: new Float64Array(ROWS),
    strike: new Float64Array(ROWS),
    volatility: new Float64Array(ROWS),
    riskFreeRate: new Float64Array(ROWS).fill(0.043),
    timeToExpiryYears: new Float64Array(ROWS),
    type: new Int8Array(ROWS),
    dividendYield: new Float64Array(ROWS).fill(0.013),
  };
  const weight = new Float64Array(ROWS);
  const quotes = [];
  let row = 0;
  for (let e = 0; e < EXPIRY_COUNT; e++) {
    for (let k = 0; k < STRIKE_COUNT; k++) {
      const strike = 5200 + k * 20;
      for (const type of ['call', 'put']) {
        const moneyness = Math.log(strike / SPOT);
        const iv = 0.15 - 0.3 * moneyness + 1.2 * moneyness * moneyness;
        const openInterest = 100 + ((row * 7919) % 4000);
        columns.spot[row] = SPOT;
        columns.strike[row] = strike;
        columns.volatility[row] = iv;
        columns.timeToExpiryYears[row] = (1 + e * 7) / 365;
        columns.type[row] = type === 'call' ? 1 : -1;
        weight[row] = openInterest * 100 * (type === 'call' ? 1 : -1);
        quotes.push({
          contract: {
            underlying: 'SPX',
            type,
            style: 'european',
            strike,
            expiry: expiries[e],
            ...resolvedExpiry(expiries[e]),
            multiplier: 100,
          },
          timestampMs: asOf,
          impliedVolatility: iv,
          openInterest,
        });
        row++;
      }
    }
  }
  const chain = {
    quotes,
    market: { spot: SPOT, riskFreeRate: 0.043, dividendYield: 0.013, asOf },
    config: { convention: 'callsPositivePutsNegative' },
  };
  const supplied = {
    quotes: quotes.map((quote, i) => ({
      ...quote,
      source: 'chain-feed',
      greeks: {
        delta: quote.contract.type === 'call' ? 0.5 : -0.5,
        gamma: 0.001 + (i % 13) * 1e-4,
        provenance: { source: 'greek-feed', timestampMs: asOf },
      },
    })),
    market: { underlying: 'SPX', spot: SPOT, source: 'spot-feed', timestampMs: asOf, asOf },
    config: {
      gexConvention: { calls: 1, puts: -1 },
      dexConvention: { calls: 1, puts: 1 },
      gammaUnit: 'per1PercentMove',
      maximumObservationAgeMs: 60_000,
    },
  };
  const scalarInput = {
    type: 'call',
    spot: 100,
    strike: 105,
    timeToExpiryYears: 0.25,
    riskFreeRate: 0.04,
    dividendYield: 0.01,
    volatility: 0.2,
  };
  const SCALAR_CALLS = 100_000;

  const has = {
    named: typeof blackScholes.gamma === 'function',
    evaluateMany: typeof batch.blackScholesEvaluateMany === 'function',
    shortcuts: typeof structure.gammaExposure === 'function',
  };
  const gammaBuffer = new Float64Array(ROWS);
  let sink = 0;

  /** Net GEX per level from a gamma column — the arithmetic every sweep variant shares. */
  function netGex(gamma, S) {
    let total = 0;
    for (let i = 0; i < ROWS; i++) total += gamma[i] * weight[i] * S * S * 0.01;
    return total;
  }

  const WORKLOADS = [
    {
      id: 'scalar-gamma',
      label: `scalar gamma × ${SCALAR_CALLS.toLocaleString('en-US')} calls`,
      before: () => {
        for (let i = 0; i < SCALAR_CALLS; i++) sink += blackScholes.greeks(scalarInput).gamma;
      },
      after: has.named
        ? () => {
            for (let i = 0; i < SCALAR_CALLS; i++) sink += blackScholes.gamma(scalarInput);
          }
        : null,
    },
    {
      id: 'batch-gamma',
      label: `batch gamma, ${ROWS.toLocaleString('en-US')} rows`,
      before: () => {
        sink += batch.blackScholesPriceMany(columns, { greeks: true }).gamma[0];
      },
      after: has.evaluateMany
        ? () => {
            sink += batch.blackScholesEvaluateMany(columns, { outputs: ['gamma'] }).gamma[0];
          }
        : null,
    },
    {
      id: 'batch-delta-gamma',
      label: `batch delta + gamma, ${ROWS.toLocaleString('en-US')} rows`,
      before: () => {
        sink += batch.blackScholesPriceMany(columns, { greeks: true }).delta[0];
      },
      after: has.evaluateMany
        ? () => {
            sink += batch.blackScholesEvaluateMany(columns, { outputs: ['delta', 'gamma'] })
              .delta[0];
          }
        : null,
    },
    {
      id: 'batch-price-gamma',
      label: `batch price + gamma, ${ROWS.toLocaleString('en-US')} rows`,
      before: () => {
        sink += batch.blackScholesPriceMany(columns, { greeks: true }).price[0];
      },
      after: has.evaluateMany
        ? () => {
            sink += batch.blackScholesEvaluateMany(columns, { outputs: ['price', 'gamma'] })
              .price[0];
          }
        : null,
    },
    {
      id: 'batch-basic-greeks',
      label: `batch price + five Greeks (blackScholesPriceMany greeks: true), ${ROWS.toLocaleString('en-US')} rows`,
      before: () => {
        sink += batch.blackScholesPriceMany(columns, { greeks: true }).rho[0];
      },
      after: () => {
        sink += batch.blackScholesPriceMany(columns, { greeks: true }).rho[0];
      },
    },
    {
      id: 'batch-gamma-reused-buffer',
      label: `batch gamma into a reused buffer, ${ROWS.toLocaleString('en-US')} rows`,
      before: null,
      after: has.evaluateMany
        ? () => {
            batch.blackScholesEvaluateManyInto(columns, { gamma: gammaBuffer });
            sink += gammaBuffer[0];
          }
        : null,
    },
    {
      id: 'gex-sweep-73',
      label: `73-level GEX sweep over ${ROWS.toLocaleString('en-US')} contracts (columnar)`,
      before: () => {
        for (const S of LEVELS) {
          columns.spot.fill(S);
          sink += netGex(batch.blackScholesPriceMany(columns, { greeks: true }).gamma, S);
        }
        columns.spot.fill(SPOT);
      },
      after: has.evaluateMany
        ? () => {
            for (const S of LEVELS) {
              columns.spot.fill(S);
              batch.blackScholesEvaluateManyInto(columns, { gamma: gammaBuffer });
              sink += netGex(gammaBuffer, S);
            }
            columns.spot.fill(SPOT);
          }
        : null,
    },
    {
      id: 'exposure-construct',
      label: `exposure() construction, ${ROWS.toLocaleString('en-US')} quotes (full profile)`,
      before: () => {
        sink += structure.exposure(chain).aggregate.gex;
      },
      after: () => {
        sink += structure.exposure(chain).aggregate.gex;
      },
    },
    {
      id: 'exposure-construct-gex',
      label: `gamma-exposure construction, ${ROWS.toLocaleString('en-US')} quotes (before: full exposure())`,
      before: () => {
        sink += structure.exposure(chain).aggregate.gex;
      },
      after: has.shortcuts
        ? () => {
            sink += structure.gammaExposure(chain).aggregate.gex;
          }
        : null,
    },
    {
      id: 'exposure-spot-updates-73',
      label: `73 atSpot updates on a ${ROWS.toLocaleString('en-US')}-contract profile (before: gex+dex, after: gex only)`,
      setup: () => ({
        before: structure.exposure(chain),
        after: has.shortcuts ? structure.gammaExposure(chain) : null,
      }),
      before: (state) => {
        for (const S of LEVELS) sink += state.before.atSpot(S).gex;
      },
      after: has.shortcuts
        ? (state) => {
            for (const S of LEVELS) sink += state.after.atSpot(S).gex;
          }
        : null,
    },
    {
      id: 'exposure-levels',
      label: `levels() on a ${ROWS.toLocaleString('en-US')}-contract profile (zero-gamma sweep)`,
      setup: () => ({ profile: structure.exposure(chain) }),
      before: (state) => {
        sink += state.profile.levels().zeroGamma ?? 0;
      },
      after: (state) => {
        sink += state.profile.levels().zeroGamma ?? 0;
      },
    },
    {
      id: 'supplied-exposure',
      label: `exposureFromGreeks, ${ROWS.toLocaleString('en-US')} supplied quotes`,
      before: () => {
        sink += structure.exposureFromGreeks(supplied).aggregate.gex;
      },
      after: () => {
        sink += structure.exposureFromGreeks(supplied).aggregate.gex;
      },
    },
  ];

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function measure(run, state, heapUsed) {
    const warmStart = now();
    for (let i = 0; i < WARMUP || now() - warmStart < WARMUP_MS; i++) run(state);
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const start = now();
      run(state);
      times.push(now() - start);
    }
    let allocatedBytes = null;
    if (heapUsed !== undefined && typeof globalThis.gc === 'function') {
      // Averaged over several steady-state runs: the first call after a forced GC can run in a
      // lower tier and box numbers that optimized code keeps unboxed.
      const ALLOCATION_RUNS = 5;
      globalThis.gc();
      const before = heapUsed();
      for (let i = 0; i < ALLOCATION_RUNS; i++) run(state);
      allocatedBytes = Math.round(Math.max(0, heapUsed() - before) / ALLOCATION_RUNS);
    }
    return {
      medianMs: Number(median(times).toFixed(3)),
      minMs: Number(Math.min(...times).toFixed(3)),
      allocatedBytes,
    };
  }

  /**
   * Run the workloads (all, or the ids in `only`) for the side this library version supports;
   * `heapUsed` enables the allocation estimate.
   */
  function run(heapUsed, only) {
    // A 0.1.0 install has no selective APIs and runs `before`; this branch runs `after`.
    const side = has.evaluateMany ? 'after' : 'before';
    const results = [];
    for (const workload of WORKLOADS) {
      if (only !== undefined && !only.includes(workload.id)) continue;
      const fn = workload[side];
      const state = workload.setup ? workload.setup() : undefined;
      results.push({
        id: workload.id,
        label: workload.label,
        ...(fn === null
          ? { medianMs: null, minMs: null, allocatedBytes: null }
          : measure(fn, state, heapUsed)),
      });
    }
    return {
      side,
      method: { warmup: `${WARMUP} runs and ${WARMUP_MS} ms`, runs: RUNS, statistic: 'median' },
      workload: {
        rows: ROWS,
        expiries: EXPIRY_COUNT,
        strikes: STRIKE_COUNT,
        levels: LEVELS.length,
      },
      results,
      sinkFinite: Number.isFinite(sink),
    };
  }

  return { run };
}
