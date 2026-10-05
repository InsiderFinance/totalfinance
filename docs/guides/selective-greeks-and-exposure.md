# Compute only what you need: selective Greeks and exposure

A dashboard that charts gamma exposure needs gamma. It does not need option prices, theta or rho,
and it does not need them 7,800 times on every refresh. TotalFinance lets every Black–Scholes and
exposure call say what it wants, and then computes exactly that — the requested outputs and the
intermediate terms they depend on, nothing else. A selected value is bit-for-bit the value the full
calculation returns; only the unrequested work disappears. Every block below runs in CI
(`docs/examples/guides.test.ts`).

| Need                               | Call                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| One Black–Scholes result           | `blackScholes.delta(input)`, `.gamma`, `.theta`, `.vega`, `.rho`   |
| Several Black–Scholes results      | `blackScholes.evaluate({ ...input, outputs: ['price', 'gamma'] })` |
| A chain of rows                    | `blackScholesEvaluateMany(columns, { outputs })`                   |
| Reusable output buffers (advanced) | `blackScholesEvaluateManyInto(columns, { gamma: buffer })`         |
| One exposure                       | `gammaExposure(...)`, `deltaExposure(...)`, … one per metric       |
| Several exposures                  | `exposure({ quotes, market, config, metrics: ['gex', 'dex'] })`    |
| Supplied (vendor) Greeks           | `exposureFromGreeks({ quotes, market, config, metrics: ['gex'] })` |

## One Greek

Each named method takes the ordinary Black–Scholes input and returns one number in the library's
display units: delta per $1 of spot, gamma per $1², theta per calendar day, vega and rho per 1%.
`.explain` returns the same number with its assumptions and diagnostics. `blackScholes.gamma`
evaluates `d1`, the dividend discount and one normal density — no cumulative normal at all.

```ts
import { blackScholes } from '@insiderfinance/totalfinance/options/black-scholes';

const option = {
  type: 'call' as const,
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
};
const gamma = blackScholes.gamma(option);
if (gamma !== blackScholes.greeks(option).gamma) throw new Error('one formula, one answer');
const theta = blackScholes.theta.explain(option);
if (!(theta.value < 0) || theta.assumptions.conventionsVersion === undefined)
  throw new Error('a long call decays, and the envelope says how it was computed');
```

## Several outputs

`blackScholes.evaluate` takes the same input plus an explicit `outputs` list, and returns exactly
those keys, in that order. The selection can be any of `price`, `delta`, `gamma`, `theta`, `vega`,
`rho` and the higher-order `vanna`, `charm`, `vomma`, `speed`, `color` (in the raw units of
`blackScholes.extendedGreeks`). Shared terms are computed once.

```ts
const selected = blackScholes.evaluate({ ...option, outputs: ['price', 'delta', 'gamma'] });
if (Object.keys(selected).join() !== 'price,delta,gamma') throw new Error('only what was asked');
if (selected.price !== blackScholes.price(option)) throw new Error('same price, bit for bit');
```

A literal list types the result exactly: `selected.vega` is a compile error because vega was not
requested. A list held in a variable (`BlackScholesOutput[]`) types every output as optional, since
the compiler cannot know which ones it holds. The same goes for a choice between lists: with
`c ? ['gamma'] : ['delta']`, both are optional, and only a name every branch requests stays
required. An empty, repeated or misspelled entry is refused with
a typed error (`input.out_of_range`, `input.duplicate_entry`, `input.invalid_enum` with a
did-you-mean).

## A chain of rows

`blackScholesEvaluateMany` runs the same selection over struct-of-arrays columns and returns one
`Float64Array` per selected output. Every column and every row's values are validated once, before
anything is computed; the rows then run without per-row validation or per-row objects.

```ts
import { blackScholesEvaluateMany } from '@insiderfinance/totalfinance/options/batch';

const columns = {
  spot: new Float64Array([100, 100, 100]),
  strike: new Float64Array([95, 100, 105]),
  volatility: new Float64Array([0.22, 0.21, 0.2]),
  riskFreeRate: new Float64Array([0.04, 0.04, 0.04]),
  timeToExpiryYears: new Float64Array([0.25, 0.25, 0.25]),
  // A positive entry is a call.
  type: new Int8Array([1, 1, 1]),
};
const { gamma: gammas } = blackScholesEvaluateMany(columns, { outputs: ['gamma'] });
if (gammas[2] !== gamma) throw new Error('the 105 strike row is the option above');
```

## Reusing buffers (advanced)

A hot loop that re-evaluates the same chain — a spot sweep, a per-tick refresh — can write into
storage it owns. The property names of the buffer object _are_ the selection. Reusable storage is
not unchecked input: the call validates the columns, every row and every buffer (a `Float64Array`
with at least one element per row) before the first write, so a refused call never half-updates a
buffer. It writes rows `[0, rows)` and leaves anything past them untouched. A buffer may not share
memory with an input column or with another output buffer.

```ts
import { blackScholesEvaluateManyInto } from '@insiderfinance/totalfinance/options/batch';

const sweep = new Float64Array(8); // capacity, reused across calls
const profile: number[] = [];
for (const spot of [95, 100, 105]) {
  columns.spot.fill(spot);
  blackScholesEvaluateManyInto(columns, { gamma: sweep });
  profile.push(sweep[0]! + sweep[1]! + sweep[2]!);
}
if (profile.length !== 3 || sweep[3] !== 0) throw new Error('rows past the chain are untouched');
```

## Exposure: start with GEX and DEX

Model exposure takes an option chain, a market snapshot and a sign convention. The common case —
gamma exposure — has its own function, and it computes gamma alone. Delta exposure has its own too.
Need both? Select them together and they share one pass.

```ts
import { resolvedExpiry } from '@insiderfinance/totalfinance/core';
import { deltaExposure, exposure, gammaExposure } from '@insiderfinance/totalfinance/structure';

const asOf = Date.parse('2026-06-15T18:30:00Z');
const quotes = [95, 100, 105].flatMap((strike) =>
  (['call', 'put'] as const).map((type) => ({
    contract: {
      underlying: 'SPX',
      type,
      style: 'european' as const,
      strike,
      expiry: '2026-07-17',
      ...resolvedExpiry('2026-07-17'),
      multiplier: 100,
    },
    timestampMs: asOf,
    impliedVolatility: 0.2,
    openInterest: 1000,
  })),
);
const chain = {
  quotes,
  market: { spot: 100, riskFreeRate: 0.04, asOf },
  config: { convention: 'dealerShortGamma' as const },
};

const gex = gammaExposure(chain);
const full = exposure(chain);
if (gex.aggregate.gex !== full.aggregate.gex) throw new Error('the same GEX, bit for bit');
if ('dex' in gex.aggregate) throw new Error('an uncomputed metric is absent, never zero');
// The per-tick path re-evaluates only what was selected.
if (!(gex.atSpot(101).gex < 0)) throw new Error('dealer-short gamma stays negative');

const both = exposure({ ...chain, metrics: ['gex', 'dex'] });
if (both.aggregate.dex !== deltaExposure(chain).aggregate.dex) throw new Error('one formula');
```

A selective profile still answers every analysis: `levels()`, `netDrift()` and `scenarioMap()`
compute the inputs they need when you call them, and return what the full profile returns.
`byStrike()` and `byExpiry()` default to the selected metrics and refuse one that was not computed.
`atSpot` re-evaluates the selected `gex` and/or `dex`; a profile that selected neither refuses it.

## Higher-order exposures

The rest of the exposure family follows the same pattern, one descriptive function per metric:
`vegaExposure` and `thetaExposure` (dollar value per 1% of volatility and per calendar day), then
the higher-order `vannaExposure` (dollar delta per +1% volatility), `charmExposure` (dollar delta as
a day elapses), `vommaExposure` (vega exposure per +1% volatility), `speedExposure` (the change in
GEX for a +1% spot move, in the GEX unit) and `colorExposure` (the change in GEX as a day elapses,
also in the GEX unit). Each is the corresponding one-metric `exposure(...)` selection; combinations
belong in `metrics`.

```ts
import { charmExposure, vannaExposure } from '@insiderfinance/totalfinance/structure';

const vanna = vannaExposure(chain);
if (vanna.aggregate.vanna !== full.aggregate.vanna) throw new Error('the same vanna exposure');
const flows = exposure({ ...chain, metrics: ['vanna', 'charm'] });
if (flows.aggregate.charm !== charmExposure(chain).aggregate.charm)
  throw new Error('a combination is a selection, not a new function');
```

## Supplied Greeks

`exposureFromGreeks` accounts for Greeks a vendor already supplied, without recomputing anything.
A GEX-only report needs only the supplied gamma, the GEX sign convention and the GEX unit — a feed
without delta is fine. A DEX-only report needs only delta and the DEX convention. Omitting
`metrics` keeps today's report, which requires both Greeks on every row that supplies Greeks so the
two metrics always cover the same rows.

```ts
import { exposureFromGreeks } from '@insiderfinance/totalfinance/structure';

const supplied = exposureFromGreeks({
  quotes: quotes.map((quote) => ({
    ...quote,
    source: 'chain-feed',
    greeks: { gamma: 0.02, provenance: { source: 'greek-feed', timestampMs: asOf } },
  })),
  market: { underlying: 'SPX', spot: 100, source: 'spot-feed', timestampMs: asOf, asOf },
  config: {
    gexConvention: { calls: 1, puts: -1 },
    gammaUnit: 'per1PercentMove',
    maximumObservationAgeMs: 60_000,
  },
  metrics: ['gex'],
});
if (supplied.aggregate.gex !== 0) throw new Error('equal call and put gamma nets to zero here');
if ('dex' in supplied.aggregate) throw new Error('DEX was not selected');
```

The report also totals every metric per strike (`byStrike`) and per expiry (`byExpiry`). A caller
that builds its own strike and expiry views from `contributions` can pass `breakdowns: false` to
leave both out. That skips the grouping and two thirds of the exact summation; every other field is
unchanged, and `assumptions.breakdowns` records the choice. The report's type follows the flag, so
reading `byStrike` from a `breakdowns: false` report is a compile error.

## What does not change

Selection removes work, never meaning. Pricing model, units, sign conventions, time conventions,
exclusions, assumptions and diagnostics are those of the full calculation, and every selected
number equals the full calculation's number exactly. Omitting `metrics` returns exactly what it
always has.
