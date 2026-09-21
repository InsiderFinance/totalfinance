import { bench, describe } from 'vitest';
import {
  blackScholesImpliedVolatilityMany,
  blackScholesPriceMany,
  blackScholesPriceManyInto,
} from '@totalfinance/options/batch';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
// Package-private on purpose: the unchecked kernel is not on the exports map. A benchmark inside the
// package is exactly where the guarded/unchecked pair may be compared.
import { blackScholesPriceUnchecked } from '../src/bsm.js';
import { blackScholesImpliedVolatility } from '../src/bsm.js';
import { impliedVolatility } from '../src/iv.js';

/**
 * BSM throughput evidence (spec 3B.1b): object ergonomics coexist with explicit columnar hot paths,
 * and boundary validation is paid ONCE per call — never per row inside a validated columnar loop.
 *
 * This file was silently measuring nothing until 3B.1b. It still used the pre-rename field names
 * (`t`, `rate`, `vol`), so every scalar call omitted `volatility`/`timeToExpiryYears`/`riskFreeRate`
 * and priced `NaN`, while the columnar cases were handed columns under names the kernel never reads.
 * The summary printed `NaNx faster`, which is the tell, and nothing failed: benchmarks are outside
 * `pnpm run ci` and outside typecheck, so a stale name here is invisible in both directions.
 *
 * The rename landed in Phase 3B.N; this is the first run since that could have caught it.
 */
const ROWS = 100_000;
const spot = new Float64Array(ROWS);
const strike = new Float64Array(ROWS);
const timeToExpiryYears = new Float64Array(ROWS);
const riskFreeRate = new Float64Array(ROWS);
const dividendYield = new Float64Array(ROWS);
const volatility = new Float64Array(ROWS);
const type = new Int8Array(ROWS);
for (let i = 0; i < ROWS; i++) {
  spot[i] = 80 + (i % 41);
  strike[i] = 85 + (i % 31);
  timeToExpiryYears[i] = 7 / 365 + (i % 720) / 365;
  riskFreeRate[i] = 0.02 + (i % 6) * 0.005;
  dividendYield[i] = (i % 4) * 0.005;
  volatility[i] = 0.12 + (i % 25) * 0.01;
  type[i] = i % 2 === 0 ? 1 : -1;
}
const columns = {
  spot,
  strike,
  timeToExpiryYears,
  riskFreeRate,
  dividendYield,
  volatility,
  type,
};
const out = new Float64Array(ROWS);
let sink = 0;

describe(`BSM throughput (${ROWS.toLocaleString()} realistic mixed rows)`, () => {
  /**
   * The scalar path pays full boundary validation per call — one object, six declared fields, a Law
   * 12 key scan. That is the cost the spec permits and this benchmark exists to keep honest.
   */
  bench('scalar named-object kernel (validated per call)', () => {
    let total = 0;
    for (let i = 0; i < ROWS; i++) {
      total += blackScholesPrice({
        type: type[i]! > 0 ? 'call' : 'put',
        spot: spot[i]!,
        strike: strike[i]!,
        timeToExpiryYears: timeToExpiryYears[i]!,
        riskFreeRate: riskFreeRate[i]!,
        dividendYield: dividendYield[i]!,
        volatility: volatility[i]!,
      });
    }
    sink = total;
  });

  /**
   * The columnar paths validate their COLUMNS once and then run the unchecked kernel per row.
   *
   * MEASURED, with the caveat that matters: on a quiet machine the caller-owned-buffer path runs
   * ~2.7x the validated scalar path (80.1 vs 29.3 ops/s, ±2.9% rme on the faster side). Three runs of
   * this same file produced 5.05x, 1.32x and 2.73x — the first under heavy load with ±51% rme, which
   * is noise, not signal. Quote the quiet-machine number and re-measure before quoting any of them.
   *
   * And read the gap for what it is: the scalar path also allocates one request object per row and
   * pays call overhead, so this margin is validation PLUS allocation PLUS dispatch — not the cost of
   * validation alone. It is evidence that keeping all three out of a 100,000-row loop is worth doing,
   * which is the claim spec 3B.1b actually makes; it is not a measurement of `requireFiniteFields`.
   */
  bench('columnar batch (allocating result)', () => {
    sink = blackScholesPriceMany(columns).price[ROWS - 1]!;
  });

  bench('columnar batch into caller-owned Float64Array', () => {
    blackScholesPriceManyInto(columns, out);
    sink = out[ROWS - 1]!;
  });
});

/**
 * BATCH IMPLIED VOL — the path the review found uncovered.
 *
 * Every row runs a Brent solve, and each solve evaluates the pricing kernel once per iteration. Before
 * 3B.1b's routing fix that objective called the fully guarded kernel, so a single batch-IV call paid
 * the whole field-validation set (rows x iterations) times. The solver now validates once at its own
 * boundary and iterates on the unchecked kernel. Benchmarked at a smaller row count than pricing
 * because each row is a root-find, not a closed form.
 */
/**
 * Prices are GENERATED from known volatilities, not invented.
 *
 * The first version made prices up (`4 + (i % 20) * 0.1`), and 959 of the 5,000 rows landed below
 * intrinsic — those return `below_intrinsic` in O(1) without running a solve at all. So a benchmark
 * labelled "one Brent solve each" was measuring 4,041 solves and 959 early returns, and would have
 * drifted further with any change to the bounds logic. Round-tripping a known sigma guarantees every
 * row is inside the bracket, and the assertion below makes that a property rather than a hope.
 */
const IV_ROWS = 5_000;
const ivPrice = new Float64Array(IV_ROWS);
const ivSpot = new Float64Array(IV_ROWS);
const ivStrike = new Float64Array(IV_ROWS);
const ivT = new Float64Array(IV_ROWS);
const ivRate = new Float64Array(IV_ROWS);
const ivType = new Int8Array(IV_ROWS);
for (let i = 0; i < IV_ROWS; i++) {
  const spot = 100;
  const strike = 90 + (i % 40);
  const t = 0.1 + (i % 12) / 12;
  const rate = 0.03;
  const sigma = 0.12 + (i % 25) * 0.01;
  ivSpot[i] = spot;
  ivStrike[i] = strike;
  ivT[i] = t;
  ivRate[i] = rate;
  ivType[i] = 1;
  ivPrice[i] = blackScholesPrice({
    type: 'call',
    spot,
    strike,
    timeToExpiryYears: t,
    riskFreeRate: rate,
    dividendYield: 0,
    volatility: sigma,
  });
}

// Fail loudly rather than silently benchmarking early returns.
{
  const check = blackScholesImpliedVolatilityMany({
    price: ivPrice,
    spot: ivSpot,
    strike: ivStrike,
    timeToExpiryYears: ivT,
    riskFreeRate: ivRate,
    type: ivType,
  });
  let converged = 0;
  for (let i = 0; i < IV_ROWS; i++) if (check.converged[i] === 1) converged += 1;
  if (converged !== IV_ROWS) {
    throw new Error(
      `IV benchmark must solve every row: ${converged}/${IV_ROWS} converged — the timing would ` +
        `include early returns and would not measure the solver.`,
    );
  }
}

describe(`BSM implied vol (${IV_ROWS.toLocaleString()} rows, one Brent solve each)`, () => {
  bench('columnar batch implied vol', () => {
    const result = blackScholesImpliedVolatilityMany({
      price: ivPrice,
      spot: ivSpot,
      strike: ivStrike,
      timeToExpiryYears: ivT,
      riskFreeRate: ivRate,
      type: ivType,
    });
    sink = result.impliedVolatility[IV_ROWS - 1]!;
  });
});

void sink;

/**
 * THE ROUTING DECISION, measured — the claim RV1 rests on.
 *
 * RV1 asserted a 2.34x solver improvement and a 3.98x kernel gap, and neither number was reproducible
 * from this repository: both came from one-off scripts that were never committed. A performance claim
 * whose evidence cannot be re-run is the same shape of defect as a gate that no longer gates — it
 * looks settled and asserts nothing. These suites put the numbers where anyone can check them.
 *
 * The first pair isolates what the routing actually changed: identical arithmetic, one call paying
 * field validation and one not, at the rate a Brent solve calls its objective (~10-40x per solve).
 * The second measures the shipped solver end to end, so the solver-level figure and the kernel-level
 * figure are read from the same run rather than stitched together across machines.
 *
 * READ THE RME BEFORE QUOTING A NUMBER. The same kernel A/B on the same machine measured 6.09x with a
 * CI run in the background (rme ±59.6%) and 3.00x idle (rme ±8.8% / ±15.3%) — a 2x spread produced by
 * load alone, which is larger than most differences anyone would report. Roughly 3x is the honest
 * figure for the routing; anything quoted from a wide-margin sample has already been wrong here twice.
 */
const KERNEL_CALLS = 200_000;
const KERNEL_INPUT = {
  type: 'call' as const,
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  dividendYield: 0,
  volatility: 0.2,
};

describe(`pricing kernel: guarded vs unchecked (${KERNEL_CALLS.toLocaleString()} calls)`, () => {
  bench('guarded — validates every field on every call (pre-RV1 objective routing)', () => {
    let acc = 0;
    for (let i = 0; i < KERNEL_CALLS; i++) acc += blackScholesPrice(KERNEL_INPUT);
    sink = acc;
  });

  bench('unchecked — validated once at the boundary (shipped objective routing)', () => {
    let acc = 0;
    for (let i = 0; i < KERNEL_CALLS; i++) acc += blackScholesPriceUnchecked(KERNEL_INPUT);
    sink = acc;
  });
});

const SCALAR_SOLVES = 20_000;

describe(`scalar implied-vol solver (${SCALAR_SOLVES.toLocaleString()} solves)`, () => {
  bench('blackScholesImpliedVolatility — boundary-validated, unchecked objective', () => {
    let acc = 0;
    for (let i = 0; i < SCALAR_SOLVES; i++) {
      acc += blackScholesImpliedVolatility({
        type: 'call',
        price: 4 + (i % 7) * 0.25,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        dividendYield: 0,
      }).value;
    }
    sink = acc;
  });
});

/**
 * THE METHOD SUITE — the derivative solvers, which the RV1 tracker claimed and never measured.
 *
 * `impliedVolatility` is the robust public entry point: Newton/Halley/Householder with a Brent
 * fallback. Its derivative helper evaluates the price once per ITERATION and acceptance evaluates it
 * again per candidate root, and both ran through the guarded facade until RV6 — so the one solver
 * family with the highest kernel-calls-per-solve ratio was the one still paying per-call validation,
 * while the tracker said "every solver objective" was routed.
 */
const METHOD_SOLVES = 20_000;
const METHOD_INPUT = {
  type: 'call' as const,
  price: 4,
  spot: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  dividendYield: 0,
};

const METHODS = ['newton', 'halley', 'householder', 'brent'] as const;

// Every method must actually SOLVE this fixture. A benchmark over non-converging inputs times the
// failure path and reports it as throughput.
for (const method of METHODS) {
  for (let i = 0; i < 7; i++) {
    // `converged` lives on `diagnostics`, not the top level — reading it off the result object
    // yields `undefined`, and `!undefined` makes every method look broken.
    const probe = impliedVolatility({ ...METHOD_INPUT, price: 4 + i * 0.25 }, { method });
    if (!probe.diagnostics.converged) {
      throw new Error(
        `method benchmark fixture does not converge under ${method} at price ${4 + i * 0.25} — ` +
          `the timing would measure the fallback path, not the method.`,
      );
    }
  }
}

describe(`implied-vol method suite (${METHOD_SOLVES.toLocaleString()} solves)`, () => {
  for (const method of METHODS) {
    bench(`impliedVolatility — ${method}`, () => {
      let acc = 0;
      for (let i = 0; i < METHOD_SOLVES; i++) {
        acc +=
          impliedVolatility({ ...METHOD_INPUT, price: 4 + (i % 7) * 0.25 }, { method }).value ?? 0;
      }
      sink = acc;
    });
  }
});
