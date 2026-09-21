# Adopt TotalFinance without guessing why the numbers changed

Keep the old result, the new result, and their actual assumptions together. A close price is not
proof that two calculations used the same dividend treatment, expiry instant, day count, contract
multiplier, price source, or Greek source.

Raw functions still take ordinary named inputs. Saved artifacts are optional tools for comparisons
and replay, not a prerequisite for calculating a price.

## Record, replay, and compare a calculation

This self-contained example uses hypothetical inputs and reruns the same calculator. It demonstrates
the adoption workflow, not an independent numerical oracle. When integrating another library,
record that producer's real input parameters and assumptions instead of copying TotalFinance's labels.

```ts
import { blackScholes } from '@totalfinance/options';
import {
  artifactReplayParity,
  canonicalJsonOf,
  compareCalculationArtifacts,
  createAnalysisArtifact,
  fromCanonicalJson,
  readAnalysisArtifact,
} from '@totalfinance/core/artifacts';

const parameters = {
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  volatility: 0.2,
  riskFreeRate: 0.04,
  dividendYield: 0.01,
};
const saved = createAnalysisArtifact({
  artifactType: 'options.price-comparison',
  producedBy: { operation: 'blackScholes.call.explain' },
  inputs: { parameters },
  result: blackScholes.call.explain(parameters),
});

// Store these bytes wherever you choose; the library does no I/O.
const bytes = canonicalJsonOf(saved);
const restored = readAnalysisArtifact({ artifact: fromCanonicalJson(bytes) }).artifact;
const recomputed = blackScholes.call.explain(parameters);
const replay = artifactReplayParity({ saved: restored.result, recomputed });
if (!replay.identical)
  throw new Error('The deterministic replay changed; inspect replay.differences.');

const candidate = createAnalysisArtifact({
  artifactType: 'options.price-comparison',
  producedBy: { operation: 'blackScholes.call.explain' },
  inputs: { parameters },
  result: recomputed,
});
const comparison = compareCalculationArtifacts({
  baseline: restored,
  candidate,
  metrics: [
    {
      name: 'premium',
      baseline: { path: ['value'], unit: 'USD/share' },
      candidate: { path: ['value'], unit: 'USD/share' },
      tolerance: { absolute: 0.0001, relative: 0 },
    },
  ],
});
if (comparison.status !== 'match')
  throw new Error('Inspect comparison.reasons and comparison.context.');
```

The metric paths are explicit own-property components relative to each saved result. Different result
schemas can use different paths. A literal dotted key is one string component; array positions are
numeric components. Give premiums, P&L and each Greek their own tolerance and unit. Units are
caller-declared labels, not a currency-conversion or dimensional-analysis engine. Normalize deliberately
before saving when one producer returns dollars per share and another returns dollars per contract.

The status is deliberately conservative:

- `match`: the selected metrics meet their stated tolerances under matching recorded context.
- `mismatch`: context matches, but at least one selected value exceeds its tolerance.
- `not-comparable`: recorded inputs, assumptions, conventions or units differ. The report still
  shows numeric agreement separately, so a definition difference is not hidden as a formula bug.
- `insufficient-evidence`: input identity/assumptions or a selected value is unavailable, or retained
  context differences were truncated, or a producer reported non-convergence/error diagnostics.
  Two null values are not a successful numeric match.

Producer operations must match by default. An intentional comparison of different operations uses
`operationPolicy: 'compare-declared-metrics'`; the report still discloses both operation identities,
all source diagnostics and any input/assumption differences. This opt-in never waives failed source
calculations, unavailable data or mismatched units. Inspect `context.sourceDiagnostics` even when
numeric agreement is true.

Exact replay has no tolerance. Migration comparison has explicit tolerances. Neither operation
executes an engine, fetches a snapshot, attributes causality, certifies a vendor, or proves that the
caller recorded every economically meaningful assumption.

## Use observed data as observed data

`observedSkew` uses supplied quotes and deltas rather than silently substituting fitted wings.
`optionFlowDrift` accounts for trading premium within a supplied session; it is not the dealer
gamma/charm/vanna hedging estimate. Check coverage and exclusions before interpreting either result.

### Calculate exposure from supplied Greeks

```ts
import { resolvedExpiry } from '@totalfinance/core';
import { exposureFromGreeks } from '@totalfinance/structure';

const timestampMs = Date.parse('2026-09-01T15:00:00Z');
const exposure = exposureFromGreeks({
  quotes: [
    {
      contract: {
        underlying: 'SPY',
        type: 'call',
        style: 'american',
        strike: 100,
        expiry: '2026-09-18',
        ...resolvedExpiry('2026-09-18'),
        multiplier: 100,
      },
      timestampMs,
      source: 'example-chain',
      openInterest: 5,
      greeks: {
        delta: 0.6,
        gamma: 0.03,
        provenance: { source: 'example-greek-feed', timestampMs },
      },
    },
  ],
  market: { underlying: 'SPY', spot: 100, source: 'example-spot', timestampMs, asOf: timestampMs },
  config: {
    gexConvention: { calls: 1, puts: -1 },
    dexConvention: { calls: 1, puts: 1 },
    gammaUnit: 'per1PercentMove',
    maximumObservationAgeMs: 60_000,
  },
});
if (exposure.diagnostics.warnings.some((warning) => warning.severity === 'error'))
  throw new Error('Inspect the supplied-Greek exposure before using it.');
```

Delta is signed delta per share; gamma is the supplied delta derivative per underlying-price point.
The selected gamma exposure unit above multiplies gamma × open interest × multiplier × spot² × 0.01.
Delta exposure multiplies signed delta × open interest × multiplier × spot. Both apply the explicitly
selected call/put convention. No dealer-position sign convention is inferred. Provenance and age
checks distinguish the spot, quote and Greeks. Inspect included/excluded contributions and coverage;
a missing or stale observation is not a zero exposure. This snapshot cannot reprice a spot or
volatility scenario: use a pricing model for that separate task.

### Inspect a chain without inventing model inputs

```ts
import { resolvedExpiry as resolveChainExpiry } from '@totalfinance/core';
import { optionChainHealth } from '@totalfinance/options';

const quoteTime = Date.parse('2026-09-01T15:00:00Z');
const health = optionChainHealth({
  quotes: [
    {
      contract: {
        underlying: 'SPY',
        type: 'call',
        style: 'american',
        strike: 100,
        expiry: '2026-09-18',
        ...resolveChainExpiry('2026-09-18'),
      },
      timestampMs: quoteTime,
      bid: 3.9,
      ask: 4.1,
    },
  ],
  market: { underlying: 'SPY', asOf: quoteTime },
  config: { priceSource: 'mid', maximumQuoteAgeMs: 60_000, maximumRelativeSpread: 0.1 },
});
if (health.rows[0]?.selectedPrice !== 4 || health.rows[0]?.model.status !== 'not-requested')
  throw new Error('Quote-only health must not run a hidden pricing model.');
```

Chain health reports staleness, missing timestamps, crossed/wide markets, selected-price availability,
duplicates and expiry/strike coverage. It does not mutate or filter your chain. An optional explicit
`expectedContracts` universe makes missing-contract coverage meaningful; the library does not infer
what an exchange lists. The default/hard quote budget is 10,000, and callers can request a smaller
`maximumQuotes`. Quote-only use needs no made-up spot, interest rate or dividend yield.

To request model bounds and IV diagnostics, explicitly select `config.model: 'black-scholes-merton'`
and supply `market.spot`, `riskFreeRate` and `dividendYield` (including an explicit zero yield when
appropriate). American exercise, nonempty discrete-dividend schedules and adjusted deliverables are
reported as unsupported, not silently treated as European vanilla contracts. A quote outside this
model's bounds is model-incompatible, not proof that the market observation is bad. Failed solves
retain their reason and never receive a guessed IV.

These are direct SDK capabilities. The CLI/OpenAPI/MCP operation list is deliberately curated;
an exported function is not automatically a transport operation.
