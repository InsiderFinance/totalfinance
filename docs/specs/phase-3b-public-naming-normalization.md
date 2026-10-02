# Spec — Phase 3B.N: public naming normalization

> **Status: COMPLETE (N0–N9, re-closed after RV9).** Historical baseline:
> `45d08493` on 2026-07-28. This specification owns public naming across every TotalFinance package,
> import path, SDK layer, schema, MCP surface, serialized artifact, and generated consumer contract.
> [`implementation-order.md`](../implementation-order.md) owns global ordering. The runtime and
> semantic closeout is also complete; the generated naming inventory and zero-unresolved gate remain
> permanent requirements for every new Stage 4 API. The body below preserves the execution record.

## Executive decision

The earlier object-versus-positional correction crossed the entire repository, but it did not
perform an identifier-by-identifier naming disposition of the entire public graph. This review did.
The problem is not limited to the options package:

- exact public `vol` fields occur in `core`, `fixed-income`, `options`, `risk`, `strategy`, and
  `vol`;
- truncated volatility-family names occur in nine domain packages;
- exact public `t` fields occur in seven packages and exact `ts` fields in four;
- `iv`, `markToMarket`, `dte`, `ev`/`pop`, `Mc`, `Params`, `Spec`, `Fn`, `avg`, `std`, `tol`, and similar
  families cross package boundaries; and
- MCP currently repeats the same shorthand in tool IDs, pack names, schemas, output keys, and
  descriptions.

TotalFinance will use explicit semantic names at every public boundary. Brevity remains valid for
canonical domain terms, equations, model parameters, and genuinely local implementation details; it
is not a justification for making a caller translate library-specific shorthand.

The intended flagship grammar is:

```ts
import { blackScholes, technicalAnalysis, volatility } from 'totalfinance';

blackScholes.price({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});

technicalAnalysis.rsi(closes, { period: 14 });

volatility.expectedMoveFromImpliedVolatility({
  spot: 100,
  impliedVolatility: 0.22,
  timeToExpiryYears: 30 / 365,
});
```

The raw layer remains equally public:

```ts
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

blackScholesPrice({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
  dividendYield: 0,
});
```

This is a naming correction, not a retreat from the permanent layer model. Facades, raw kernels,
professional APIs, batches, artifacts, and MCP continue to expose the same calculations and compose
the same engines.

## Why this phase exists

The previous alignment decision D3 explicitly ratified `vol`, `rate`, and `t` as compact
model-facade vocabulary. That was wrong.

`vol` is especially poor in this library because it has two plausible meanings: volatility and
trading volume. The technical-analysis package already contains volume calculations and an existing
public `volumeCutoff` that means **volume** cutoff. A caller should never need package lore to decide
whether `vol` means volatility, volume, a volatility point, or a standard deviation.

`t` hides both meaning and unit. Depending on the current contract it means time to expiry, maturity,
tenor, a curve coordinate, or an observation index, usually in years but not always. `ts` hides the
fact that a number is an epoch-millisecond timestamp. `rate` is a full word but is still too generic
where a request could plausibly contain risk-free, discount, funding, dividend, forward, coupon, or
borrow rates.

Phase 3A correctly changed confusable financial coordinates from positional lists to named objects.
Named objects are only as safe as their names. Phase 3B was about to generate runtime validators and
semantic ratchets around the old vocabulary. The naming correction therefore must happen first.

## Design basis

This policy follows a consistent cross-language principle:

- Swift puts clarity at the point of use above brevity and advises against nonstandard
  abbreviations.
- Google's TypeScript guidance requires descriptive exported names and reserves very short names for
  small, non-exported scopes.
- Go ties name length to scope: the farther a name travels, the more descriptive it should be.
- .NET naming guidance prioritizes readability and limits abbreviations to widely accepted terms.

Sources:

- [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [Go Code Review Comments — variable names](https://go.dev/wiki/CodeReviewComments)
- [.NET general naming conventions](https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/general-naming-conventions)

The conclusion is not “longer is always better.” It is “the caller should not perform a translation
the library could have performed once.”

## Scope

### In scope

The audit and migration cover all user-observable naming surfaces:

1. npm package names and package export subpaths;
2. umbrella exports, namespaces, and subpaths;
3. exported functions, classes, constants, enums, type aliases, interfaces, and schemas;
4. public constructor, method, callback, and positional-parameter labels visible in declarations,
   IntelliSense, TypeDoc, and generated signatures;
5. recursive request, options, configuration, result, assumption, diagnostic, and artifact fields;
6. discriminant values, error/warning code names, and stable serialized code strings;
7. `toJSON()` output, snapshots, replay artifacts, and schema versions;
8. batch row and column names;
9. MCP tool IDs, pack IDs, input schemas, output schemas, resources, prompts, and descriptions;
10. runtime teaching errors and did-you-mean suggestions;
11. manifests, API reports, generated docs, package READMEs, `llms*.txt`, examples, tests, benchmarks,
    and packed consumers; and
12. future data, worker, WASM, and cross-language contracts, which must start with this policy rather
    than receive a later cleanup.

### Out of scope

This phase does not:

- rename the project itself;
- change mathematical results, algorithms, defaults, result grammar, package dependencies, or
  object-versus-positional decisions except where a naming defect exposes a distinct semantic
  contract;
- expand symbols in equations, literature citations, or formula derivations;
- rewrite file-private loop variables and model notation merely to satisfy a length rule;
- rename exact, canonical technical-indicator identities away from the names users search for; or
- add compatibility aliases for removed pre-1.0 names.

## Reproducible audit baseline

The scan was declaration-backed and export-aware rather than a sample of option-pricing files.

| Audited surface                               | Baseline count |
| --------------------------------------------- | -------------: |
| Package directories including the umbrella    |             17 |
| Package source files                          |            261 |
| Package test files                            |            291 |
| Markdown documents before this specification  |            107 |
| Repository tool files                         |             72 |
| Public package entrypoints                    |            156 |
| Public callable paths                         |          3,313 |
| Signature parameter occurrences               |          4,434 |
| Unique public field declarations              |          7,210 |
| Unique public method declarations             |            632 |
| Unique public parameter declarations          |          1,657 |
| Public export paths, including re-export fans |          6,108 |
| Source object-literal keys reviewed           |         20,890 |
| Package-source identifier occurrences         |        164,279 |

The public type graph began at every `package.json` export and recursively followed exported
functions, classes, interfaces, returned artifacts, methods, and nested fields. It was joined to the
3,313-callable signature manifest. A source AST scan then found object keys and internal identifiers
that declarations alone cannot distinguish, including MCP schemas and serialized-state builders.
Finally, tracked tests, docs, tools, package metadata, and build configuration were scanned for
consumer reach.

Counts do not equal rename tasks:

- one declaration can fan out through many package and umbrella paths;
- generated TA aliases inflate parameter and export-path counts;
- an object-literal key can be private state rather than a public contract; and
- a short name can be a correct model symbol or canonical indicator.

The implementation inventory must preserve declaration identity, public path fan-out, and semantic
classification separately.

### High-signal family findings

| Family                      | Public fields | Public methods | Signature labels | Export paths | Object keys reviewed |
| --------------------------- | ------------: | -------------: | ---------------: | -----------: | -------------------: |
| truncated `Vol` / `vol`     |           200 |              3 |                3 |          187 |                  419 |
| `Iv` / `iv`                 |            21 |              3 |                0 |           27 |                   27 |
| `Rv` / `rv`                 |             2 |              0 |                0 |           15 |                    0 |
| `Bsm` / `bsm` and `bs`      |             9 |              0 |                0 |           41 |                    4 |
| `Mc` / `mc`                 |             9 |              0 |                0 |           71 |                   24 |
| `Mtm` / `markToMarket`      |             2 |              0 |                0 |            8 |                    3 |
| `Dte` / `dte`               |             9 |              0 |                0 |            1 |                    9 |
| `Ts` / `ts`                 |            22 |              0 |                1 |            0 |                   42 |
| `Params` / `params`         |            27 |              0 |            1,088 |          391 |                   71 |
| `opts`                      |             0 |              0 |              239 |            0 |                    1 |
| `Ctx` / `ctx`               |             4 |              0 |               16 |            0 |                    0 |
| `Spec` / `spec`             |             0 |              0 |               25 |           59 |                    3 |
| `Fn` / `fn`                 |             1 |              0 |               19 |           18 |                   34 |
| `Avg` / `avg`               |            24 |              0 |                0 |            0 |                   26 |
| `Std` / `standardDeviation` |            14 |              1 |                0 |           12 |                   25 |
| `Tol` / `tol`               |            23 |              0 |                0 |            0 |                   40 |
| `Iter` / `maxIter`          |            16 |              0 |                0 |            0 |                   35 |
| `Pct` / `pct`               |            12 |              0 |                0 |            7 |                    8 |
| `Rng` / `rng`               |             3 |              0 |                3 |           12 |                    1 |

Additional exact-name findings:

- `t`: 84 unique public fields, 23 signature labels, and 201 object keys;
- `vol`: 51 unique public fields;
- `ts`: 18 unique public fields;
- `iv`: nine unique public fields;
- bare `var` and `cvar`: twelve unique public fields;
- `rho`: 19 public fields, some correct model parameters and some requiring semantic review; and
- generic one-letter signature labels remain in math, TA callbacks, and lower-level protocols and
  require scope-aware classification rather than automatic deletion.

The cross-package distribution makes the scope explicit:

| Package              | Exact `vol` fields | Truncated volatility-family fields | Exact `t` fields | Exact `ts` fields | Exact `iv` fields |
| -------------------- | -----------------: | ---------------------------------: | ---------------: | ----------------: | ----------------: |
| `backtest`           |                  0 |                                  0 |                0 |                 4 |                 0 |
| `core`               |                  1 |                                 30 |                1 |                11 |                 0 |
| `crypto`             |                  0 |                                  0 |                6 |                 0 |                 0 |
| `fixed-income`       |                  6 |                                  7 |                6 |                 0 |                 0 |
| `options`            |                 24 |                                 46 |               38 |                 0 |                 1 |
| `performance`        |                  0 |                                  1 |                0 |                 0 |                 0 |
| `risk`               |                  3 |                                  9 |                0 |                 0 |                 1 |
| `strategy`           |                 12 |                                 31 |                2 |                 0 |                 1 |
| `structure`          |                  0 |                                  4 |                1 |                 1 |                 1 |
| `technical-analysis` |                  0 |                                  1 |                0 |                 2 |                 0 |
| `volatility`         |                  5 |                                 71 |               30 |                 0 |                 5 |
| **Total**            |             **86** |                            **200** |           **84** |            **18** |             **9** |

This table is the PRE-MIGRATION survey; its rows and totals describe the surface as N0 found it. The
`vol` total read **0** while its own rows still summed to 51 — one cell had been updated to the
post-migration answer while the eleven rows above it were left describing the original. A total that
disagrees with the column it totals is worse than either number alone, because each looks
authoritative. The current count for every family here is zero, which the closeout table below
states; this one is history and is left as history.

Packages omitted from this table have zero declaration fields in these exact families. MCP still
contains corresponding abbreviated schema and object keys, which the source/object scan captures
rather than the exported-field column.

The exhaustive token pass also surfaced secondary families that a volatility-centered search would
have missed. Their disposition is settled here rather than deferred:

| Current examples                                                                | Canonical direction                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ArbSlice`, `ArbCheckExtra`, `carryArb`                                         | `ArbitrageSlice`, `ArbitrageCheckDetails`, `carryArbitrage`                                        |
| `priceApprox`, `fairVolApprox`, `VannaVolgaApprox*`                             | `approximatePrice`, `approximateFairVolatility`, `VannaVolgaApproximation*`                        |
| `SimBroker`, `SimOptions`, facade `sim`                                         | **`SimulatedBroker`** (ratified, see below), `MonteCarloSamplingOptions`, facade `simulation`      |
| `PerpFunding*`, `perpFunding`                                                   | `PerpetualFunding*`, `perpetualFunding`                                                            |
| `ReturnStats`, `TradeStats`, `McStats`, `IvStats`, `winLossStats`               | `ReturnStatistics`, `TradeStatistics`, `MonteCarloStatistics`, `ImpliedVolatilityStatistics`, etc. |
| `IndicatorMeta`, `IndicatorOutputMeta`, generic `info`                          | `IndicatorMetadata`, `IndicatorOutputMetadata`, or a stronger role noun                            |
| public `Args`/`args`, `arg`, `dim`, `len`, `prev`, `num`, `idx`, `desc`, `ref`  | `Arguments`/`arguments`, `argument`, `dimension`, `length`, `previous`, `number`, `index`, etc.    |
| statistical `df`; fixed-income `df`                                             | `degreesOfFreedom`; `discountFactor`                                                               |
| `ci95`, `r2`, `adjR2`, `tStats`, `*Sq`                                          | `confidenceInterval95`, `rSquared`, `adjustedRSquared`, `tStatistics`, `*Squared`                  |
| math `mad`; TA `mad`                                                            | `medianAbsoluteDeviation`; `rollingMeanAbsoluteDeviation`; never retain the mean/median ambiguity  |
| distribution `inv`, `sf`, `logSf`                                               | `inverseCdf`, `survivalFunction`, `logSurvivalFunction`                                            |
| `ppy`                                                                           | `periodsPerYear`                                                                                   |
| semantic `*Pv`/`pv`                                                             | `*PresentValue`/`presentValue`; canonical `PV01` remains                                           |
| library-authored `cum`, `diff`, `pctChange`, `Hist*`, and `prev*` TA vocabulary | `cumulativeSum`, `difference`, `fractionalChange`, `Historical*`/`Histogram*`, `previous*`         |

This table is not a finite denylist. It records concrete findings from the current baseline. The
generated inventory still requires a disposition for every public token, including a future short
form that no current heuristic anticipates.

### Change-reach estimate

This lexical reach is intentionally broader than the migration set. It shows why the work must be
generated and sequenced rather than performed as an options-only search-and-replace.

| Exact token | Source files | Test files | Authored docs | Tool files |
| ----------- | -----------: | ---------: | ------------: | ---------: |
| `vol`       |           93 |        147 |            75 |         29 |
| `iv`        |           48 |         43 |            32 |          4 |
| `t`         |          134 |        157 |            85 |         19 |
| `opts`      |           96 |         32 |            35 |          5 |
| `params`    |           34 |         68 |            21 |         15 |
| `ctx`       |           10 |         10 |             1 |          2 |

Formula prose, private locals, and historical documents account for many of these matches. The
permanent naming report, not a text replacement count, owns completion.

## Permanent naming laws

### N1 — Clarity at the call site

A public name states the concept a caller supplies or receives. The cost of typing is paid once by
autocomplete; the cost of interpreting an abbreviation is paid on every read.

### N2 — Ambiguity veto

If a short term has two plausible meanings anywhere in TotalFinance's domain, it cannot be a public
canonical name. `vol` fails because it can mean volatility or volume. `t` fails because it can mean
time, tenor, maturity, an observation index, or a model coordinate.

### N3 — Semantic expansion, not string expansion

The replacement must name the actual role:

- a `volCutoff` would have to become `volatilityCutoff` or `volumeCutoff` depending on which it
  is — and the ONE that exists, the TA VFI parameter, becomes `volumeCutoff`;
- P&L `pnlVol` becomes `pnlStandardDeviation`, not `pnlVolatility`;
- a solver's `fTol` becomes `residualTolerance`, not `functionTolerance`;
- `dVol` becomes `volatilityChange`; and
- a `t` on a carry-curve point becomes `timeToExpiryYears`, while a key-rate-duration coordinate
  becomes `tenorYears`.

No global regex may choose semantics.

### N4 — Units belong in otherwise ambiguous numeric names

Use a unit suffix when the primitive type cannot communicate the basis:

- `timeToExpiryYears`;
- `timeStepYears`;
- `timestampMs`;
- `timingMs`;
- `daysToExpiry`;
- `spreadBps` when the value is basis points; and
- `oneSigmaFraction` when the value is in `[0, 1]`.

Equations may use `t`, `T`, `σ`, and `r`; API snippets may not substitute those symbols for public
field names.

### N5 — One concept, one canonical name

The SDK, raw layer, batch columns, professional market objects, assumptions, artifacts, MCP schemas,
and generated docs use the same field name. A transport may change case convention for an operation
ID, but not vocabulary or meaning.

### N6 — Public parameter labels count

Positional signatures retained by Phase 3A keep their arity and order, but their declaration labels
must teach:

```ts
// Before
brent(f, a0, b0, opts);

// After
brent(objective, lowerBound, upperBound, options);
```

Labels do not affect JavaScript invocation, but they affect IntelliSense, TypeDoc, generated
signatures, error messages, and every reader of a callback type.

### N7 — Canonical terms require an allowlist

A shortened public term is retained only when all of these are true:

1. it is the dominant term users search for in the relevant discipline;
2. it has one clear meaning in the owning API;
3. expanding it would reduce recognition or conflict with established notation;
4. its casing and scope are consistent; and
5. it is present in the source-controlled naming policy with a rationale.

“Quant developers know it,” “it is shorter,” and “the code already uses it” are not rationales.

### N8 — Private scope earns brevity

File-private formula implementations may keep `S`, `K`, `T`, `r`, `q`, `sigma`, loop indices, and
small callback-local names. Public model parameter records may keep literature-standard symbols when
the owning type identifies the model and the documentation defines the symbol. A local name is not
renamed merely because the public contract changed.

Private shorthand becomes in scope if it leaks through:

- a public callback label;
- a thrown error or diagnostic context;
- serialized state;
- generated source or declarations; or
- a public object literal inferred into an exported result.

### N9 — Pre-1.0 corrections are clean

Delete old package names, exports, fields, methods, tool IDs, and discriminants. Do not add overloads,
deprecated aliases, dual schema keys, fallback parsing, or compatibility branches. Add compile-fail
and runtime rejection evidence for the important old forms.

Search metadata and docs may include old abbreviations as discovery synonyms. A synonym is not an
executable alias.

### N10 — Naming and runtime enforcement land together

Each renamed closed object updates its allowlist/schema and teaching errors in the same commit.
Passing `vol` after the migration must reject with a suggestion for `volatility`; it may not be
silently ignored or accepted as a transitional alias.

## Settled vocabulary

### Mandatory semantic replacements

| Current public family                         | Canonical direction                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `vol`, `*Vol`, `Vol*` for volatility          | `volatility`, `*Volatility`, `Volatility*`                                                                                           |
| `iv`, `*Iv`, `Iv*`, `impliedVol`              | `impliedVolatility`, `*ImpliedVolatility`, `ImpliedVolatility*`                                                                      |
| `rv`, `*Rv`, `Rv*`, `realizedVol`             | `realizedVolatility`, `*RealizedVolatility`, `RealizedVolatility*`                                                                   |
| `volCutoff` in TA volume calculations         | `volumeCutoff`                                                                                                                       |
| `t` for an option or future expiry            | `timeToExpiryYears`                                                                                                                  |
| `t` for maturity/tenor                        | `timeToMaturityYears`, `tenorYears`, or a more exact owning-domain name                                                              |
| `dt` for a public simulation/numerical step   | `timeStepYears` or the exact step basis                                                                                              |
| `ts`, `startTs`, `submittedTs`                | `timestampMs`, `startTimestampMs`, `submittedTimestampMs`                                                                            |
| `dte`, `Dte`                                  | `daysToExpiry`, `DaysToExpiry`                                                                                                       |
| option-pricing `rate`                         | `riskFreeRate`                                                                                                                       |
| `bs`, `Bsm`, `bsm`                            | `blackScholes`, `BlackScholes`, `blackScholes`                                                                                       |
| `mc`, `Mc`                                    | `monteCarlo`, `MonteCarlo`                                                                                                           |
| `qmc`, `Qmc` in executable API names          | `quasiMonteCarlo`, `QuasiMonteCarlo`                                                                                                 |
| `priceMC`, `priceApprox`                      | `monteCarloPrice`, `approximatePrice`                                                                                                |
| `fdm`, `Fdm`                                  | `finiteDifference`, `FiniteDifference`                                                                                               |
| Heston `cos`, `Cos`                           | `cosineExpansion`, `CosineExpansion`                                                                                                 |
| `mtm`, `Mtm`                                  | `markToMarket`, `MarkToMarket`                                                                                                       |
| bare `var` result fields                      | `valueAtRisk`                                                                                                                        |
| `seed` for a calibration starting point       | `initialParameters` (a Heston partial pin; the surface knob is `hestonInitialParameters`) — the retired word names randomness only   |
| bare `cvar` result fields                     | `conditionalValueAtRisk`                                                                                                             |
| `ev`, `thesisEv`                              | `expectedValue`, `thesisExpectedValue`                                                                                               |
| `pop`, `thesisPop`                            | `probabilityOfProfit`, `thesisProbabilityOfProfit`                                                                                   |
| `opts`                                        | `options`                                                                                                                            |
| `params`, `*Params`                           | `parameters`, `*Parameters`                                                                                                          |
| `ctx`                                         | `context` or a more exact domain noun                                                                                                |
| `spec`, `*Spec`                               | `specification`, `*Specification`; prefer a stronger noun such as `contract` or `definition` when it is semantically exact           |
| `fn`, `*Fn`                                   | a role name such as `objective`, `predicate`, `evaluator`, `ScalarFunction`, `FunctionWithDerivatives`, or `LocalVolatilityFunction` |
| `req`, `res` on a public boundary             | `request`, `result`, or a stronger role noun                                                                                         |
| `avg`, `Avg`                                  | `average`, `Average`                                                                                                                 |
| `std`, `stddev`, `StdDev`, `stdErrors`        | `standardDeviation`, `StandardDeviation`, `standardErrors`                                                                           |
| `tol`, `xTol`, `fTol`, `maxIter`              | semantic `tolerance`, `stepTolerance`, `residualTolerance`, `maximumIterations`                                                      |
| `pct`, `Pct`                                  | `fraction`, `percentage`, or `percent` only after verifying the numeric basis                                                        |
| `qty`, `px`, `cov`, `corr`, `coef`            | `quantity`, `price`, `covariance`, `correlation`, `coefficient`                                                                      |
| `rng`, `Rng`                                  | `randomNumberGenerator`, `RandomNumberGenerator`                                                                                     |
| `arb`, `Arb`                                  | `arbitrage`, `Arbitrage`                                                                                                             |
| `approx`, `Approx`                            | `approximation`, `Approximation`, or the verb `approximate*`                                                                         |
| `sim`, `Sim`                                  | `simulation`, `Simulation`; use `MonteCarlo*` when that is the exact method                                                          |
| `perp`, `Perp`                                | `perpetual`, `Perpetual`                                                                                                             |
| `evt`, `Evt`, `GPD`, `Gpd`, `PBO`, `Pbo`      | `extremeValue`, `ExtremeValue`, `GeneralizedParetoDistribution`, `backtestOverfittingProbability`                                    |
| `adfTest`, `Adf*`                             | `augmentedDickeyFullerTest`, `AugmentedDickeyFuller*`                                                                                |
| `stats`, `Stats`, `stat`                      | `statistics`, `Statistics`, or the exact statistic name                                                                              |
| `meta`, `Meta`                                | `metadata`, `Metadata`                                                                                                               |
| generic `info`, `Info`                        | `information`, `Information`, or a stronger semantic noun                                                                            |
| `args`, `Args`, `arg`                         | `arguments`, `Arguments`, `argument`                                                                                                 |
| `dim`, `len`, `prev`, `num`, `idx`            | `dimension`, `length`, `previous`, `number`/`count`, `index`                                                                         |
| `df`                                          | `degreesOfFreedom` or `discountFactor`, selected by meaning                                                                          |
| `ci`, `ci95`                                  | `confidenceInterval`, `confidenceInterval95`                                                                                         |
| `r2`, `adjR2`, `*Sq`                          | `rSquared`, `adjustedRSquared`, `*Squared`                                                                                           |
| `tStats`                                      | `tStatistics`                                                                                                                        |
| ambiguous `mad`                               | math `medianAbsoluteDeviation`; TA `rollingMeanAbsoluteDeviation`                                                                    |
| `stderr`, `stdError`                          | `standardError` or the exact rolling/estimate role                                                                                   |
| distribution `inv`, `sf`, `logSf`             | `inverseCdf`, `survivalFunction`, `logSurvivalFunction`                                                                              |
| `ppy`                                         | `periodsPerYear`                                                                                                                     |
| semantic `pv`, `*Pv`                          | `presentValue`, `*PresentValue`; do not expand canonical `PV01`                                                                      |
| count-like public `n`                         | `count`, `observations`, `sampleSize`, `numberOfPaths`, or the exact role                                                            |
| `pnlVol`                                      | `pnlStandardDeviation`                                                                                                               |
| `spotVol` / `volOfVol`                        | `spotReturnVolatility` / `volatilityOfVolatility`                                                                                    |
| `dVol`, `volShock`, `volShocks`               | `volatilityChange`, `volatilityShock`, `volatilityShocks`                                                                            |
| `oneSigmaPercent` when represented as `0.22`  | `oneSigmaFraction`                                                                                                                   |
| `basisPercent` when represented as a fraction | `basisFraction`                                                                                                                      |
| `fdBumps`, `hS`, `hSig`, `hT`, `hR`, `hQ`     | `finiteDifferenceBumps` with `spotStep` / `volatilityStep` / `timeStepYears` / `rateStep` / `dividendYieldStep`                      |
| `betaVolSpot`, `volSpotBeta`                  | `volatilitySpotBeta` (ratified below); `estimateVolatilitySpotBeta` for the operation                                                |
| `slopeStdErr`, `slopeTStat`                   | `slopeStandardError`, `slopeTStatistic`                                                                                              |
| `deEarnedVol`                                 | `eventStrippedVolatility` (ratified below)                                                                                           |

### Retained canonical terms

The following are not blanket exceptions; they are approved in their established contexts:

- universal technology/protocol terms: API, ID, URL, URI, JSON, HTML, ISO, UTC, SDK, MCP, ESM, WASM,
  IEEE-754, and NaN;
- market/exchange/security identifiers: OCC, CBOE, NYSE, ISO currency codes, CUSIP, and ISIN;
- finance terms: PnL, VaR, CVaR, ATM, ITM, OTM, OHLC/OHLCV, VWAP, FX, DV01, PV01, CDS, FRA, OIS,
  CMS, OAS, XVA, CVA, DVA, FVA, CTD, GEX, DEX, TIPS, CAGR, NPV, IRR, and NAV;
- named models/methods: SABR, SVI, SSVI, eSSVI, GARCH, HAR-RV, CIR, G2++, PCA, OLS, BFGS, SVD, LU,
  QR, CDF, PDF, PDE, RMSE, MSE, MAE, KPSS, HAC, and EWMA; and
- exact technical-indicator names backed by a dominant industry identity or an explicit
  compatibility contract, including RSI, MACD, ATR, ADX, OBV, VWAP, and their
  TA-Lib-compatible spellings.

Rules for retained terms:

- PnL stays `pnl`/`Pnl` in symbols because it is the dominant readable finance term.
- VaR/CVaR may stay in operation and type names (`bookVaR`, `VaRResult`), but result fields are
  `valueAtRisk` and `conditionalValueAtRisk`; lowercase `var` is never the canonical field.
- ATM/ITM/OTM may stay inside otherwise descriptive names, but avoid awkward hybrids when a full
  phrase reads better. For example, `probabilityInTheMoney` is preferred to `probabilityInTheMoney`.
- model acronyms stay only where they identify the model. `params`, `vol`, and `t` inside the same
  model API still expand.
- A generated registry entry does not automatically earn an abbreviation exception. Library-authored
  names such as `cum` and `mad` follow the normal policy; compatibility aliases remain discovery
  metadata unless the policy records an executable interoperability requirement.
- `config`, `min`, `max`, `bid`, `ask`, `mid`, `spot`, `type`, `kind`, `side`, and `asOf` remain
  ordinary, widely understood public vocabulary. This policy does not expand words merely because
  they are short.

### Context-scoped mathematical symbols

These symbols may remain only where the owning public type or operation makes the literature meaning
unambiguous:

- SABR `alpha`, `beta`, `rho`, `nu`;
- Heston `kappa`, `theta`, `sigma`, `rho`, `v0`;
- SVI/SSVI/eSSVI canonical parameters such as `a`, `b`, `m`, `rho`, `sigma`, `theta`, and `phi`;
- distribution coordinates such as `x` and probability `p` on a dedicated CDF/inverse-CDF method;
- conventional matrix coordinates and generic type parameters; and
- `n`/`k` in a dedicated combinatorics formula where those are the standard mathematical arguments.

The same symbol outside that scope expands. A generic risk field named `rho` means correlation only
if its owning type makes that fact explicit; otherwise use `correlation`. A public model time
coordinate still uses `timeToExpiryYears` because its hidden unit is a recurring user footgun.

## Package and import decisions

These decisions are settled for pre-1.0:

| Current identity                         | Canonical identity                              |
| ---------------------------------------- | ----------------------------------------------- |
| `@totalfinance/vol`                      | `@totalfinance/volatility`                      |
| `totalfinance/vol`                       | `totalfinance/volatility`                       |
| umbrella `vol`                           | umbrella `volatility`                           |
| `@totalfinance/vol/local-volatility`     | `@totalfinance/volatility/local-volatility`     |
| `@totalfinance/options/local-vol`        | `@totalfinance/options/local-volatility`        |
| `@totalfinance/vol/volatility-spot-beta` | `@totalfinance/volatility/volatility-spot-beta` |
| `@totalfinance/ta`                       | `@totalfinance/technical-analysis`              |
| `totalfinance/ta`                        | `totalfinance/technical-analysis`               |
| umbrella `ta`                            | umbrella `technicalAnalysis`                    |
| MCP domain/pack `vol`                    | MCP domain/pack `volatility`                    |
| MCP domain/pack `ta`                     | MCP domain/pack `technical_analysis`            |
| `totalfinance.vol.*` tool IDs            | `totalfinance.volatility.*`                     |
| `totalfinance.ta.*` tool IDs             | `totalfinance.technical_analysis.*`             |

`@totalfinance/mcp` remains unchanged because MCP is the protocol's official name. `@totalfinance/math`
remains unchanged because `math` is universal package vocabulary, not domain-specific shorthand.
No old package or subpath is published as an alias.

The `technical-analysis` decision survives explicit adversarial review. `TA` is established
practitioner vocabulary and remains essential discovery metadata—especially for TA-Lib and
pandas-ta compatibility—but it is a category abbreviation, not an exact indicator/model operation
name like RSI, MACD, or ATR. Package names, dependency listings, stack traces, umbrella autocomplete,
and MCP identities are also read by newcomers and agents outside an already-established trading
context; the full phrase is immediately interpretable there. Import-path length is paid once, while
fragmented package/SDK/MCP vocabulary is paid repeatedly. Therefore:

- preserve `TA`, `TA-Lib`, `pandas-ta`, and familiar indicator terms in package keywords, docs,
  compatibility metadata, and search/discovery synonyms;
- keep exact TA-Lib-compatible indicator identities where interoperability requires them;
- use `technical-analysis`, `technicalAnalysis`, and `technical_analysis` for executable package,
  umbrella, and MCP category identities; and
- publish no executable `ta` compatibility alias.

The source directories should follow the published identities (`packages/volatility` and
`packages/technical-analysis`) so repository navigation, package metadata, build references, and npm
names tell one story.

## Flagship Black-Scholes decision

The most popular model must also be the most discoverable API:

| Current                   | Canonical                                   |
| ------------------------- | ------------------------------------------- |
| `bs`                      | `blackScholes`                              |
| `bsmPrice`                | `blackScholesPrice`                         |
| `bsmGreeks`               | `blackScholesGreeks`                        |
| `bsmExtendedGreeks`       | `blackScholesExtendedGreeks`                |
| `bsmImpliedVol`           | `blackScholesImpliedVolatility`             |
| `bsmPriceBounds`          | `blackScholesPriceBounds`                   |
| `BsmInput`                | `BlackScholesInput`                         |
| `BsmTypedInput`           | `BlackScholesOptionInput`                   |
| `BsmImpliedVolInput`      | `BlackScholesImpliedVolatilityInput`        |
| `BsmKernelInput`          | `BlackScholesKernelInput`                   |
| `BsmImpliedVolOptions`    | `BlackScholesImpliedVolatilityOptions`      |
| `bs.impliedVolatility`    | `blackScholes.impliedVolatility`            |
| `Bsm*Schema` / `bsmShape` | `BlackScholes*Schema` / `blackScholesShape` |
| `OptionIvBatch*`          | `OptionImpliedVolatilityBatch*`             |

The public common name is Black-Scholes. Documentation and the engine identifier continue to state
that the implementation is Black-Scholes-Merton with continuous dividend yield. Requiring every
caller to type `BlackScholesMerton` would be technically precise but less aligned with how users
search for and discuss the model.

The facade remains:

```ts
blackScholes.call(request);
blackScholes.put(request);
blackScholes.price({ ...request, type: 'call' });
blackScholes.greeks({ ...request, type: 'call' });
blackScholes.extendedGreeks({ ...request, type: 'call' });
blackScholes.impliedVolatility({ ...marketCoordinates, price, type: 'call' });
```

Black-76, Bachelier, Heston, SABR, and other named models keep their established model names while
their generic fields become explicit.

## Time, rate, percentage, and timestamp decisions

### Time

- Every numeric option/future horizonPeriods is `timeToExpiryYears`.
- A maturity coordinate is `timeToMaturityYears` or `tenorYears`, selected by domain meaning.
- Date-aware requests continue to use `expiry` and `asOf`; resolved assumptions expose
  `timeToExpiryYears`.
- Simulation steps use `timeStepYears`.
- Calendar-day counts use `days`, `daysForward`, or `daysToExpiry`, not a year-fraction name.
- Formula internals and documentation equations may use `t`/`T`.

### Rates

- Option, volatility, and risk-neutral probability requests use `riskFreeRate`.
- `MarketInputs.rate` and every extension become `riskFreeRate`.
- Domestic/foreign, financing, funding, borrow, coupon, forward, discount, hazard, recovery, and
  dividend rates retain or gain their exact role name.
- A generic `rate` is allowed only when the owning object itself supplies the missing role, such as a
  `DepositInstrument`, or when the operation is mathematically generic and the basis is explicit.
  (`RateCurvePoint` was the original example here; it renamed its pillar to `zeroRate` on
  2026-08-23 — the pillar is explicitly zero-rate-quoted (`curves.fromZeroRates` semantics), so
  the exact role name became available and the exception stopped being justified for it.)

### Percentages and fractions

- A decimal such as `0.22` is a `fraction`, `rate`, `yield`, or `volatility`, never a `percent`
  merely because documentation renders it as 22%.
- A number such as `22` may use `percent`/`percentage`.
- Existing `Pct` fields receive semantic review; they are not mechanically expanded.
- Probability, rank, contribution, and value-area fields state whether they use `[0,1]` or `[0,100]`.

### Timestamps

- Numeric epoch-millisecond fields use `timestampMs`.
- Bounds use `startTimestampMs` and `endTimestampMs`.
- Event fields use role-specific names such as `submittedTimestampMs`.
- ISO date labels remain `date`, `expiry`, `asOf`, or another role-specific string.
- A bare numeric `timestamp` is not accepted unless its branded type makes the unit unrepresentable.

## Serialized contracts and stable codes

Serialized names are public names.

### Error and warning codes

Rename both enum members and stable strings:

- `iv.*` → `implied_volatility.*`;
- `vol.*` → `volatility.*`;
- `mc.*` → `monte_carlo.*`;
- `ta.*` → `technical_analysis.*`;
- suffixes such as `data_duplicate_ts` → `data_duplicate_timestamp`; and
- enum members such as `ImpliedVolatilityBelowIntrinsic` and `VolatilitySurfaceSparse` → full semantic names.

Every changed code is covered by a fixture that asserts the final string. Pre-1.0 code strings do not
receive aliases.

### TA streaming snapshots

The current flat `Snapshot` places an abbreviated `v` and arbitrary stream state at the same level.
Replace it with an explicit versioned envelope:

```ts
interface TechnicalAnalysisSnapshot {
  kind: string;
  schemaVersion: number;
  state: Record<string, JsonValue>;
}
```

`state` is explicitly opaque: consumers may persist and round-trip it but may not branch on
indicator-private keys. Private state keys may therefore stay compact where size matters. Envelope
fields, errors, schema documentation, and cross-language fixtures remain explicit. This migration
bumps the snapshot schema and updates every restore fixture; no legacy parser is retained before
1.0.

Other snapshots and artifacts follow the same rule: readable public envelope, explicitly opaque
payload only where opacity is a deliberate contract.

## MCP decisions

MCP is not an excuse for shorter names. Agents have less context than an SDK user and benefit more
from self-describing fields.

Required changes include:

- `totalfinance.vol.*` → `totalfinance.volatility.*`;
- `totalfinance.ta.*` → `totalfinance.technical_analysis.*`;
- `volPack()` → `volatilityPack()`;
- `taPack()` → `technicalAnalysisPack()`;
- schema `vol` → the exact volatility role;
- schema `iv` → `impliedVolatility`;
- schema `t` → `timeToExpiryYears` or the exact time role;
- schema `ts` → `timestampMs`;
- TA `params` and discovery output `params` → `parameters`;
- result `var`/`cvar` → `valueAtRisk`/`conditionalValueAtRisk`;
- event fields `atmVol`, `baseVol`, and `realizedVol` → full volatility names; and
- descriptions, examples, required arrays, error contexts, and summaries generated from the same
  canonical contract identity.

Tool count and calculation coverage do not change merely because IDs change. MCP discovery metadata
should include `vol`, `IV`, `TA`, `BSM`, `DTE`, and similar familiar search terms so agents can find
the full canonical operation without executable aliases.

## Package-by-package disposition

The “candidate” counts below are heuristic exact-name hits from the declaration scan, not final
rename counts. Compound families and generated re-exports are handled by the permanent inventory.

| Package                 | Candidate fields | Candidate signature labels | Main public work                                                                                                            |
| ----------------------- | ---------------: | -------------------------: | --------------------------------------------------------------------------------------------------------------------------- |
| `core`                  |               14 |                         58 | market vocabulary, timestamps, diagnostics, warning/error codes, schemas, finite-difference disclosure                      |
| `math`                  |               12 |                        123 | solver labels/results/options, function types, RNG, standard deviation, covariance terminology                              |
| `calendars`             |                0 |                          6 | expand public `opts` labels; preserve canonical calendar/exchange terms                                                     |
| `crypto`                |                6 |                          0 | expiry/maturity time fields, fractional `Pct` fields, rate roles                                                            |
| `technical-analysis`    |               17 |                      1,258 | package identity, parameter types/labels/metadata, timestamps, averages/deviations, volume-vs-volatility, snapshot envelope |
| `options`               |               89 |                         38 | Black-Scholes surface, volatility/time/rate fields, Monte Carlo/QMC, local volatility, schemas and batch columns            |
| `performance`           |                0 |                          2 | `ppy` label, rolling standard deviation/volatility compounds, average fields                                                |
| `risk`                  |               28 |                         41 | VaR/CVaR fields, covariance labels, P&L move names, volatility shocks, mark-to-market and statistical terms                 |
| `structure`             |                3 |                          5 | contract implied volatility, timestamps, volatility shocks, namespace error context                                         |
| `volatility`            |               64 |                         67 | package identity, full volatility family, surfaces/rows/methods, model parameters, time coordinates, estimation terminology |
| `fixed-income`          |               20 |                         56 | specification/parameter/context labels, volatility fields, maturity/tenor fields, role-specific rates                       |
| `strategy`              |               23 |                         11 | implied volatility, mark-to-market, expected value/probability of profit, volatility shock/cube fields                      |
| `backtest`              |                7 |                         12 | timestamps, days to expiry, mark-to-market, averages/standard deviation, option contract specification                      |
| `mcp`                   |                0 |                          0 | tool/pack IDs and runtime schema/object keys that are not represented as exported TypeScript fields                         |
| `totalfinance` umbrella |                0 |                          0 | package subpaths, namespaces, flagship `blackScholes`, dependency names, curated exports                                    |

### `core`

Required vertical contract changes:

- `MarketInputs.rate` → `riskFreeRate`;
- `Bar`, `Quote`, `Trade`, `OptionQuote`, and `OrderBook` `ts` → `timestampMs`;
- `OptionQuote.impliedVol` → `impliedVolatility`;
- schema payload keys follow the type changes;
- `plausibilityWarnings({ vol, t, rate })` → explicit semantic fields;
- finite-difference diagnostics replace `finiteDifferenceBumps` and `h*` keys with explicit coordinate names;
- public `Args`/`args` scaffolding becomes `Arguments`/`arguments`;
- code registries and stable strings expand `Iv`, `Vol`, `Mc`, `Ts`, and `Ta` families; and
- diagnostic context keys and messages use the same canonical vocabulary.

Because these contracts are shared, update all consumers in the same green vertical slice.

### `math`

Required changes:

- public `opts` → `options`;
- `ScalarFn` → `ScalarFunction`;
- `DerivFn` → `FunctionWithDerivatives`;
- `MultivariateFn` → `MultivariateFunction`;
- callback labels become `objective`, `functionWithDerivatives`, `values`, `matrix`, or another exact
  role rather than generic `f`/`fn` where the role is knowable;
- solver bounds become `lowerBound`/`upperBound`;
- `tol`, `xTol`, `fTol`, and `maxIter` become `tolerance`, `stepTolerance`,
  `residualTolerance`, and `maximumIterations`; remove the duplicate pre-release tolerance alias;
- derivative result fields become `value`, `firstDerivative`, `secondDerivative`, and
  `thirdDerivative`;
- optimization result `x`/`fx` become `argument` or `parameters` and `objectiveValue`;
- `params`/`stdErrors` become `parameters`/`standardErrors`;
- `stddev`/`rollingStd` become `standardDeviation`/`rollingStandardDeviation`;
- `mad` becomes `medianAbsoluteDeviation`;
- `normal.inv`/`normalInv` become `normal.inverseCdf`/`normalInverseCdf`;
- `normal.survivalFunction`, `studentT.survivalFunction`, and `logSf` families become survival-function names;
- statistical `df`, sequence `dimensions`, regression `rSquared`/`adjustedRSquared`, and `tStats` become
  `degreesOfFreedom`, `dimension`, `rSquared`/`adjustedRSquared`, and `tStatistics`;
- `StatOptions` becomes `StatisticsOptions`, and `adfTest`/`AdfOptions` become full
  augmented-Dickey-Fuller names;
- public Sobol dimension constants and labels spell out `dimensions`;
- `Rng`, `RngState`, `restoreRng`, and `rng` become full random-number-generator names; and
- `cov`, `covOrCorr`, `dimensions`, and `ppy` labels expand according to role.

Canonical coordinates on CDF/PDF and matrix kernels remain eligible for scoped approval.

### `calendars`

No public field abbreviation family was found. Expand public `opts` labels to `options`, keep NYSE,
CBOE, ISO, and UTC terms, and prove the package has zero unclassified naming tokens.

### `crypto`

Required changes:

- futures `t` → `timeToExpiryYears`;
- curve point `t` → `timeToExpiryYears`;
- forward-window `fromT`/`toT` → `startTenorYears`/`endTenorYears`;
- interpolated point `t` → `tenorYears`;
- `basisPct` → `basisFraction` because the implementation returns `future / spot - 1`;
- abbreviated arbitrage names expand when public;
- generic `rate` becomes `riskFreeRate`, `financingRate`, `fundingRate`, or another exact role; and
- `perpFunding` and `PerpFunding*` become `perpetualFunding` and `PerpetualFunding*`.

### `options`

Required changes:

- execute the full Black-Scholes table above;
- `OptionMarket.vol` → `volatility` and inherited `rate` → `riskFreeRate`;
- every option/model input `t` → `timeToExpiryYears`;
- `normalVol` → `normalVolatility`;
- `impliedVol`/`iv` → `impliedVolatility`;
- `LocalVol*`/`localVol*` → `LocalVolatility*`/`localVolatility*`;
- `@totalfinance/options/local-vol` → `@totalfinance/options/local-volatility`;
- `Mc*`, `mc*`, and `Qmc*` public names expand to Monte Carlo and quasi-Monte Carlo;
- `priceMC`/`priceApprox` families become `monteCarloPrice`/`approximatePrice`, with model-qualified
  raw names such as `hestonMonteCarloPrice`;
- `SimOptions` and `McStats` become `MonteCarloSamplingOptions` (ratified: see “Ratified
  divergences”) and `MonteCarloStatistics`;
- `engines.finiteDifference`/`Fdm*` become finite-difference names;
- `heston.cosineExpansion`/`HestonCos*` become cosine-expansion names while COS remains a search synonym;
- random-number-generator fields expand;
- `HestonParameters`, `SabrParameters`, and other public parameter types use `Parameters`;
- public function/callback types use semantic `Function`/`Evaluator` names;
- `loVol`/`hiVol` use semantic volatility-bracket names;
- batch columns and results use full time/volatility names;
- schemas, engine capabilities, diagnostics, and assumptions match; and
- internal `S`, `K`, `T`, `r`, `q`, and `sigma` may remain behind the public validated object.

### `performance`

Expand `ppy` to `periodsPerYear`, `avg*` to `average*`, `*Stats` to `*Statistics`, and
standard-deviation compounds. Keep canonical metric names such as Sharpe, Sortino, Calmar, CAGR, and
PnL where applicable.

### `risk`

Required changes:

- bare result fields `var`/`cvar` → `valueAtRisk`/`conditionalValueAtRisk`;
- retain canonical operation/type terms such as `bookVaR` and `VaRResult`;
- `cov` and `posteriorCov` → `covariance` and `posteriorCovariance`;
- public `opts`, `ctx`, `spec`, and `scn` labels expand;
- `PnlMove.dVol` → `volatilityChange`;
- `PnlMarket.vol` → `volatility`;
- scenario factor `'vol'` and `shock.vol` → `'volatility'` and `shock.volatility`;
- `volShock(s)` → `volatilityShock(s)`;
- `spotVol` → `spotReturnVolatility`;
- `volOfVol` → `volatilityOfVolatility`;
- `pnlVol` → `pnlStandardDeviation`;
- structural `StrategyMtm*` names expand to `StrategyMarkToMarket*`;
- tolerance/iteration/statistical fields expand;
- `evtTailRisk`, `GeneralizedParetoFit*`, and `Pbo*` become explicit extreme-value,
  generalized-Pareto-distribution, and backtest-overfitting names while EVT/GPD/PBO remain discovery
  synonyms; and
- PnL and VaR/CVaR remain approved canonical finance terms in symbol names.

### `strategy`

Required changes:

- per-leg `iv` → `impliedVolatility`;
- market `vol` → `volatility`;
- `MtmInput`/`MtmResult` and `markToMarket` → full mark-to-market names;
- `expectedValuePerRisk`, `thesisExpectedValue*`, and related fields → expected-value names;
- `minProbabilityOfProfit`, `thesisProbabilityOfProfit`, and related fields → probability-of-profit names;
- `volShock(s)` and cube axes → `volatilityShock(s)`;
- `expectedPnlByVolAndDay` → `expectedPnlByVolatilityAndDay`;
- `firstNonNegativeDayByPriceAndVol` → `firstNonNegativeDayByPriceAndVolatility`;
- `params`/`opts`/`ctx` labels expand; and
- PnL remains canonical.

### `structure`

Required changes:

- `ContractExposure.iv` → `impliedVolatility`;
- flow `ts`, `startTs`, and `endTs` → explicit epoch-millisecond timestamp names;
- `volShock` → `volatilityShock`;
- `vannaFlowPerVol` → `vannaFlowPerVolatilityPoint` with its exact unit verified; and
- diagnostic and MCP contexts follow the same names.

### `volatility`

Required changes:

- package, directory, umbrella, and MCP identity become `volatility`;
- `VolSurface`, `volSurface`, and snapshots become `VolatilitySurface`,
  `volatilitySurface`, and `VolatilitySurfaceSnapshot`;
- surface methods `iv`, `ivByDelta`, and `ivByMoneyness` become full implied-volatility names;
- surface rows and calibration targets replace `iv` and `t`;
- every semantic `*Vol` family expands, including ATM, local, implied, realized, forward, event,
  rolling, range, swaption-cube, and annualized volatility;
- SVI/SABR/Heston evaluators use names such as `sviVolatility`;
- `Params` fields/types become `Parameters`;
- `ArbSlice`/`ArbCheckExtra` become explicit arbitrage names;
- `IvStats` becomes `ImpliedVolatilityStatistics`;
- approximation exports use `Approximation` or an `approximate*` verb;
- `fitHarRv`/`harRvForecast` become HAR realized-volatility names while HAR-RV remains a search term;
- `expectedMoveFromIv` becomes `expectedMoveFromImpliedVolatility`;
- `probabilityItm` becomes `probabilityInTheMoney`;
- `deEarnedVol` becomes `eventStrippedVolatility` (ratified: see “Ratified divergences”);
- `volSpotBeta`/`betaVolSpot` become the single canonical `volatilitySpotBeta`, and the estimator
  becomes `estimateVolatilitySpotBeta` (ratified: see “Ratified divergences”);
- `slopeStandardError`, `slopeTStatistic`, and public count `n` expand;
- error/warning code domains become `volatility.*`; and
- `Volga` in “vanna-volga” remains untouched: it is a Greek/name, not the `Vol` truncation.

### `fixed-income`

Required changes:

- every public `*Spec` and `spec` becomes `*Specification`/`specification` unless a stronger exact
  noun is chosen;
- every public `*Params` and `params` becomes `*Parameters`/`parameters`;
- public `ctx` becomes `context` or an exact valuation-context name;
- Black/Bachelier volatility fields become `volatility`/`normalVolatility`;
- `t` fields become `timeToMaturityYears`, `tenorYears`, or another exact coordinate;
- `mtm` becomes `markToMarket`;
- `stdDev` becomes `standardDeviation`;
- semantic `pv`/`*Pv` result fields become `presentValue`/`*PresentValue` while PV01 remains
  canonical; and
- rate fields keep or gain exact fixed, floating, forward, discount, short-rate, or yield roles.

### `backtest`

Required changes:

- `ts` and `submittedTs` become explicit timestamp-millisecond names;
- `DteTarget` and `dte` fields become days-to-expiry names;
- `OptionContractSpec` becomes `OptionContractSpecification`;
- `mtm` becomes `markToMarket`;
- `avg*` and `stddev` expand;
- `SimulatedBroker`/`brokers.simulated` are RETAINED (ratified: see “Ratified divergences”);
- return/trade/win-loss `*Stats` names become `*Statistics`;
- `ci95` becomes `confidenceInterval95`;
- public `fees.bps`/`slippage.bps` methods become `basisPoints` while `*Bps` unit suffixes remain;
- public `opts`/`ctx` labels expand; and
- PnL remains canonical in trade and tear-sheet names.

### `technical-analysis`

Required changes:

- package, directory, umbrella, and MCP identity become `technical-analysis`/`technicalAnalysis`;
- every exported `*Params` type and public `params` label/key becomes `*Parameters`/`parameters`;
- registry metadata, discovery output, assumptions, MCP schemas, and generated indicator docs use
  `parameters`;
- `ts` → `timestampMs` on time bars and resampling output;
- `avg*`, `stddev`, `stdDev`, `coef`, `len`, and similar public state/result fields expand;
- `IndicatorMeta`/`IndicatorOutputMeta` become `IndicatorMetadata`/`IndicatorOutputMetadata`;
- `WarmupInfo` and other generic `Info*` names become role-specific nouns;
- library-authored `cum`, `diff`, `pctChange`, and `mad` become `cumulativeSum`, `difference`,
  `fractionalChange`, and `rollingMeanAbsoluteDeviation`; `standardError` becomes
  `rollingStandardError`; `zscore` becomes `zScore`; and `Hist*`/`prev*` expand by meaning;
- the VFI `volCutoff` becomes `volumeCutoff`;
- public indicator volatility compounds use `Volatility`, while private arrays named `vol` that
  store trading volume may remain private;
- dominant indicator names and required TA-Lib/pandas-ta compatibility identities remain canonical;
  merely appearing in the registry does not exempt a library-authored abbreviation; and
- snapshots move to the explicit versioned opaque-state envelope.

The generated registry should supply the indicator identity and compatibility provenance inventory
so hundreds of names are not duplicated by hand. The naming policy records which provenance classes
earn canonical-term status and requires an explicit disposition for library-authored names.

### `mcp`

MCP receives the SDK's canonical contract names, the tool/pack identity changes above, full
output-field names, regenerated schemas/resources/prompts, and parity fixtures. It may expose fewer
operations, but it may not maintain a shorter vocabulary.

### `totalfinance` umbrella

Required changes:

- flagship `bs` → `blackScholes`;
- namespace `vol` → `volatility`;
- namespace `ta` → `technicalAnalysis`;
- subpaths `totalfinance/vol` and `totalfinance/ta` → full names;
- workspace dependency names and export-map targets update;
- no old umbrella alias remains; and
- curated-root size and tree-shaking gates stay unchanged in intent.

## Ratified divergences

Five names in this spec were overruled during 3B.N8. Each is recorded here rather than left as a
silent difference between the spec and the surface, because a spec that quietly disagrees with the
code is worse than no spec: the next reader cannot tell a decision from a miss.

**`SimulatedBroker` / `brokers.simulated` are retained.** The spec proposed `SimulationBroker` /
`brokers.simulation`. `SimulatedBroker` is an adjective modifying a noun — a broker that is
simulated — while `SimulationBroker` reads as "a broker belonging to a simulation," which is vaguer
about the thing itself. At the call site `brokers.simulated({ … })` says what you get. The
abbreviated `SimBroker`/`SimOptions` forms this row was really about are gone; the expansion landed,
and only the proposed spelling was overruled.

**`volatilitySpotBeta`, not `volatilitySpotSensitivity`.** β = ∂σ/∂S is the leverage effect, and
"vol-spot beta" is the term of art — it is what the docstrings, `docs/specs/vol-spot-beta.md`, and
the literature all call it, and `beta` is on the canonical-term allowlist for exactly this reason.
Replacing it with `sensitivity` would spell out a word that was never the problem while discarding
the word users search for. What WAS a real defect, and is fixed, is that the quantity had two public
names: `betaVolatilitySpot` on `VolatilitySpotBeta` and `MinimumVarianceDeltaOptions`,
`volatilitySpotBeta` on `StickyRegime`. Law N5 allows one. The estimator becomes
`estimateVolatilitySpotBeta`, matching the package's existing `calibrate*` grammar and freeing the
noun for the quantity.

**`PnlMove.dVolatility`, not `volatilityChange`.** The spec asked for `dVol` to become
`volatilityChange`, and taken alone that is the better name. `PnlMove` is not alone: it is a
coordinated differential set — `{ dSpot, dVolatility, dTimeYears, dRate, dDividendYield }` — handed
straight to `taylorPnl` as the perturbations of a Taylor expansion, where `d` is the differential
operator and not an abbreviation of anything. Renaming one member yields
`{ dSpot, volatilityChange, dTimeYears, … }`, which is strictly harder to read than either
convention applied consistently. The set is a `scoped-symbol` approval on `PnlMove`, with the same
justification the model kernels use for `k` and `w`.

What the row DID correctly identify is a unit hazard, and that is fixed: `dTime` became
`dTimeYears`. Greeks in this library report theta per DAY, so a caller reading theta and then
filling `dTime` in the same unit was out by a factor of 365, with nothing in the name to warn them.

**`MonteCarloSamplingOptions`, not `MonteCarloOptions`.** The spec named `MonteCarloOptions` as
the target for the abbreviated `SimOptions` — but `@totalfinance/math` already publishes a
`MonteCarloOptions` for its generic estimator, so following the spec would have replaced an
abbreviation with a cross-package collision, and the umbrella would re-export two different types
under one name. The options package's two shapes are now named for what they configure:
`MonteCarloSamplingOptions` (paths, seed, sampling method, antithetic, Brownian-bridge ordering) and
`MonteCarloPriceOptions` (the pricing call that extends it). `@totalfinance/math` keeps
`MonteCarloOptions`, which is what makes the collision disappear rather than move.

**`eventStrippedVolatility`, not `eventAdjustedVolatility`.** Both fix the opaque `deEarnedVol`.
"Adjusted" does not say in which direction, and the direction is the entire content of the function:
it REMOVES a known event jump from an event-spanning ATM vol, leaving the continuous vol. "Stripped"
is the verb the docstring already used to describe it.

## Required permanent tooling

Implement a checked-in naming inventory under the existing `tools/manifest` system. Exact filenames
may follow repository conventions, but responsibilities are fixed.

### Generated public naming inventory

For every public identity, record:

- package and subpath;
- public path and canonical declaration identity;
- symbol kind;
- complete camel/Pascal/snake-case tokenization;
- request/result/artifact position;
- serialized and MCP linkage;
- source location for diagnostics only, never as stable identity;
- disposition: `explicit`, `canonical-term`, `scoped-symbol`, or `opaque-state`;
- policy/rationale ID for every non-explicit term; and
- all re-export and alias fan-out.

### Source-controlled policy

The curated policy contains:

- approved universal and domain terms;
- scope restrictions for model/math symbols;
- generated TA registry terms;
- forbidden truncation tokens and compounds;
- semantic rename mappings;
- package/subpath decisions;
- serialized-code namespace decisions; and
- owner/rationale for any exceptional public short name.

A generator may discover names; it may not infer financial meaning.

### CI gates

CI fails when:

- a new public token has no disposition;
- a forbidden token appears in a public name;
- a scoped symbol escapes its approved type/operation;
- a package, SDK, schema, artifact, or MCP name diverges for the same contract;
- an opaque-state exception appears outside an explicitly opaque envelope;
- generated reports drift;
- the denylist grows without a reviewed policy change; or
- the unresolved migration count increases.

Private-local lint is deliberately not part of this gate.

## Ordered implementation

All commits must be independently green. Shared type renames are vertical contract slices: update
the owner and every in-repository consumer atomically rather than adding temporary aliases.

After the atomic package-identity migration, shared vocabulary follows the package graph:

| Dependency tier | Packages                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| 0               | `core`                                                                       |
| 1               | `math`, `calendars`, `crypto`, `technical-analysis`                          |
| 2               | `options`, `performance`                                                     |
| 3               | `fixed-income`, `risk`, `structure`, `volatility`                            |
| 4               | `strategy`                                                                   |
| 5               | `backtest`                                                                   |
| 6               | `mcp`, `totalfinance` umbrella, generated docs, and packed-consumer fixtures |

Packages in one tier may migrate in parallel only when they do not share the contract being renamed.
An upstream field rename includes every downstream compile/runtime consumer in its own vertical
commit even when that crosses several tiers.

### 3B.N0 — Inventory and policy foundation

- [x] Convert the review scanner into a deterministic checked-in manifest tool
      (`tools/manifest/naming-inventory.ts`, `pnpm naming:update`).
- [x] Generate the full public naming inventory and re-export graph
      (`tools/manifest/public-naming.json`: 20,918 public identities; 1,610 exports carry
      multi-entrypoint fan-out).
- [x] Land the allowlist, scoped-symbol rules, forbidden families, and unresolved baseline
      (`tools/manifest/naming-policy.ts`).
- [x] Add drift tests and prove deterministic output
      (`tools/manifest/naming-conformance.test.ts`, 14 gates).
- [x] Record old flagship/package/field compile-fail fixtures, but land executable rejection tests
      with the corresponding migration (`COMPILE_FAIL_FIXTURES`: 19 entries recorded as DATA, each
      naming the phase that lands its executable evidence — no red gate committed here).

**Commit boundary:** tooling, policy, generated baseline, and tests only; no broad API rename.

**Closed.** Baseline: 20,918 public identities — 13,816 `explicit`, 980 `canonical-term`, 22
`scoped-symbol`, **3,353 `unresolved`**. The unresolved set is the N1–N8 migration queue and the N9
exit condition; `summary.byForbiddenToken` ranks it (`params` 620, `vol` 420, `rate` 294, `opts` 293,
`t` 157) and `summary.directions` carries each token's canonical replacement. Identity is
`package|kind|path` with source locations deliberately excluded, per ledger C02.

### 3B.N1 — Package and domain identity

- [x] Rename `@totalfinance/vol` and its directory to `@totalfinance/volatility`.
- [x] Rename `@totalfinance/ta` and its directory to `@totalfinance/technical-analysis`.
- [x] Update workspace references, package manifests, tsconfig paths/references, lockfile, build
      order, export maps, repository metadata, and dependency tests.
- [x] Rename umbrella subpaths/namespaces (`totalfinance/volatility`, `totalfinance/technical-analysis`,
      namespaces `volatility` / `technicalAnalysis`) and MCP tool/pack domains
      (`totalfinance.volatility.*`, `totalfinance.technical_analysis.*`, `volatilityPack`,
      `technicalAnalysisPack`).
- [x] Prove old package/subpath imports fail and new packed imports work
      (`tools/naming-removals.test.ts` — the executable evidence for the eight `3B.N1`
      compile-fail fixtures; `tools/packed-consumer.test.ts` exercises the new identities from real
      tarballs across Node ESM, `require(ESM)`, esbuild, `NodeNext`, and `Bundler`).

**Commit boundary:** package/import identities plus all repository consumers.

**Closed.** Unresolved naming identities: 3,353 → **3,332**. Four classes of reference could not be
reached by a specifier rewrite and are worth knowing about for N2–N8: relative tsconfig project
references (`../vol/tsconfig.build.json`), pnpm lockfile `link:` targets, sweep `PACKAGES` maps keyed
by bare identifiers, and — the subtlest — a package identity embedded in TEST LOGIC
(`domain === 'ta'` gated the discriminated-sentinel allowance in `finite-results.test.ts`, so
renaming the directory silently withdrew a legitimate NaN exemption).

### 3B.N2 — Shared core vocabulary

- [x] Migrate timestamps, `MarketInputs`, option-quote implied volatility, schemas, diagnostics,
      finite-difference disclosure, and stable code registries.
- [x] Update every downstream consumer in the same vertical slices.
- [x] Add exact runtime did-you-mean and serialized-code fixtures.
- [x] Burn core's naming inventory to zero unresolved entries.

**Closed 3B.N6.** Note on ordering: N2–N6 were executed by TOKEN FAMILY across all packages rather
than package-by-package. A family (`iv`, `spec`, `var`/`cvar`, `fn`, …) crosses every package it
appears in, so migrating it in one commit keeps the repository green at every step, whereas a
package-at-a-time order would leave the same contract spelled two ways across a package boundary
mid-phase. The acceptance condition is identical and is what the gate measures: every package's
inventory is at zero.

**Commit boundary:** one shared contract family at a time, repository green after each.

### 3B.N3 — Math and numerical protocols

- [x] Migrate solver/optimizer function types, labels, options, results, random generators,
      standard deviation, covariance, and statistical terminology.
- [x] Ratify only the scoped mathematical symbols that pass the policy.
- [x] Update all package consumers and benchmark signatures.
- [x] Burn math and calendars to zero unresolved entries.

### 3B.N4 — Options and model front doors

- [x] Migrate Black-Scholes facade, raw exports, types, schemas, batches, assumptions, diagnostics,
      package docs, and consumers.
- [x] Migrate generic option/model time, risk-free-rate, volatility, implied-volatility, local-
      volatility, normal-volatility, Monte Carlo, quasi-Monte-Carlo, parameter, and random-generator
      families.
- [x] Update fixed-income, risk, strategy, structure, volatility, backtest, MCP, and umbrella
      consumers atomically by contract family.
- [x] Prove facade/raw/pro/batch/professional/MCP numerical parity.
- [x] Burn options to zero unresolved entries.

### 3B.N5 — Volatility, fixed income, and crypto

- [x] Migrate the full volatility-surface/model/forecast/event vocabulary and serialized artifacts.
- [x] Migrate fixed-income specifications, parameters, contexts, rates, volatility, and time roles.
- [x] Migrate crypto expiry/tenor, rate-role, and fraction fields.
- [x] Update all downstream consumers and generated outputs.
- [x] Burn all three packages to zero unresolved entries.

### 3B.N6 — Risk, strategy, structure, performance, and backtest

- [x] Migrate VaR/CVaR fields, covariance, mark-to-market, P&L moves, volatility shocks, expected
      value, probability of profit, timestamp, days-to-expiry, average, and standard-deviation
      families.
- [x] Preserve canonical PnL and VaR/CVaR symbol terms under the allowlist.
- [x] Keep cross-package structural mirrors exactly assignable after their shared rename.
- [x] Burn each package to zero unresolved entries.

### 3B.N7 — Technical analysis and snapshots

- [x] Migrate parameter types/labels/metadata exhaustively from the registry.
- [x] Migrate timestamps, averages, standard deviations, and volume/volatility semantics.
- [x] Introduce the explicit snapshot envelope and bump its schema — landed in 1ead7793:
      `Snapshot` → `TechnicalAnalysisSnapshot { kind; schemaVersion; state }`, `SCHEMA_VERSION` 2,
      `snapshotOf`/`snapshotState` at the boundary, and a v1 (flat) snapshot now REJECTED rather than
      restored with every field undefined. `OPAQUE_STATE_ENVELOPES` is keyed on the new type name.
- [x] Regenerate all 335-indicator discovery, output metadata, docs, and MCP surfaces.
- [x] Prove batch/stream/restore parity for every registered indicator.
- [x] Burn technical analysis to zero unresolved entries.

### 3B.N8 — MCP, umbrella, generated consumers, and docs

- [x] Regenerate MCP schemas, output schemas, resources, prompts, packs, IDs, and docs.
- [x] Verify MCP and SDK field parity from shared contract identities.
- [x] Regenerate API reports, runtime/signature manifests, package READMEs, `llms*.txt`, TypeDoc
      inputs, examples, and authored guides.
- [x] Update formulas only where they show API code; preserve conventional equation notation.
- [x] Add discovery synonyms for removed abbreviations without executable aliases — the alias table
      in `packages/technical-analysis/src/aliases.ts` carries them; no executable alias was added.
- [x] Complete the `3B.N8-DOCS` atomic documentation-migration task below. Closed: runnable examples execute against packed tarballs, internal links and
      anchors are gated, no retired executable name survives in a guide or README, the `t: 1` in
      `docs/guides/errors.md` is gone, and — as of the docs inventory — every surface is classified
      with an owner, held to the rule its class prescribes, and carries zero stale executable names.
      Generated output is owned by a declared registry and proved regenerable, the MCP guide's wire
      identities are proved against the live server, and the bundle table is generated from the
      budgets CI enforces. All eleven children below are now closed. This box was previously ticked
      while every one of them sat unchecked; that was wrong and a reviewer caught it twice.
- [x] Run cold packed ESM, `require(ESM)`, esbuild, TypeScript `NodeNext`, and TypeScript `Bundler`
      consumers.

#### 3B.N8-DOCS — migrate every user-facing name atomically

This is the implementation task for fixing the vocabulary everywhere a developer, generator, agent,
or executing contributor can consume it. It is not a prose cleanup pass. Documentation is part of
the public contract, and a runnable example that teaches an old field is the same class of defect as
an old schema field.

The baseline scan at `45d08493` found legacy naming families in 68 Markdown files under `docs/`, five
package READMEs, `docs/llms.txt`, and `docs/llms-full.txt`. Those are seed counts, not an acceptance
target: generated inventory, not a fixed grep count, owns completeness.

Classify every documentation surface before changing it:

| Class                        | Required treatment                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Future target/active design  | Use final Phase 3B.N vocabulary immediately. This includes `data-layer.md`, `platform-completeness-roadmap.md`, `mcp-acceleration-data-growth-strategy.md`, active roadmap work, and any new spec. A legacy token is allowed only in an explicit before→after explanation.                                          |
| Current runnable guidance    | Keep it truthful against the current executable baseline until the owning code slice lands, then migrate it in that same commit. This includes the root README, `docs/getting-started.md`, active guides, examples, and snippets. Never publish a canonical-looking example that cannot run.                        |
| Generated consumer material  | Fix the source template/generator first, then regenerate. This includes package READMEs, `llms.txt`, `llms-full.txt`, API reports, runtime/signature manifests, TypeDoc inputs/output, schema references, MCP resources/prompts, TA discovery/reference pages, compatibility pages, and generated example indexes.  |
| Historical completion record | Preserve the exact old identity when it is evidence about what shipped. Milestones and completed feature specs are not silently rewritten. Their status or controlling index must identify them as historical and point to this naming specification; copied examples entering active guidance use canonical names. |
| Formula/reference notation   | Preserve conventional symbols in equations and derivations. Migrate imports, callable names, object fields, schema fragments, and executable code fences. A mathematical `σ`, `t`, or `r` is not an executable API exception.                                                                                       |
| Migration/discovery evidence | Old terms may appear in explicit before→after tables, compile-fail fixtures, release notes, and search synonyms. They may not become callable aliases, accepted request keys, package paths, tool IDs, or undocumented compatibility branches.                                                                      |

Implementation checklist:

- [x] Extend the naming inventory across root/package READMEs, `docs/**/*.md`, `docs/**/*.txt`,
      code examples, package metadata/descriptions, generated API material, MCP documentation, and
      the templates or registries that produce them — `tools/manifest/docs-inventory.ts`, artifact
      `tools/manifest/public-docs.json`, regenerated by `pnpm run docs:update`. 141 surfaces, 142
      executable fences.
- [x] Assign every inventoried surface one class from the table above and record its generator or
      human owner. Unclassified files and code fences fail the gate. Classes are DERIVED — from
      location, from the `<!-- Generated by … -->` marker, and from each spec's own declared status —
      so a new document is classified the moment it exists rather than when someone remembers to add
      it to a list. 76 current-runnable, 37 generated, 17 future-target, 8 historical, 2
      migration-evidence, 1 formula-notation.
- [x] Add a context-aware documentation policy to the checked-in naming tool. Active/future,
      current-runnable after cutover, and generated surfaces reject legacy executable names.
      Historical, before→after, search-synonym, conventional-formula, and opaque-state uses require
      an explicit machine-readable disposition rather than a broad file allowlist. TWO rules, by
      class: current-runnable and generated surfaces are held to TRUTHFULNESS (every identifier a
      fence presents as API must exist in the naming baseline), future-target surfaces to VOCABULARY
      (the naming policy itself, since there is no baseline for unbuilt work yet). Truthfulness is
      strictly stronger than a token rule in both directions — it convicts `var`/`iv`/`vols`, which
      tokenize innocently but do not exist, and acquits `k`/`w` in the SSVI fences, which a token rule
      flags and which are really shipped. Dispositions are per-finding (`<path>#<name>`), and one that
      stops matching anything fails the gate, so the escape hatch cannot rot into the allowlist this
      item forbids.
- [x] Update generators and templates before generated output. Hand-editing generated package
      READMEs, TA references, API reports, TypeDoc output, schemas, or `llms*.txt` is not a closeout.
      Generated ownership is DECLARED in `tools/generated-docs.ts` (37 surfaces) and gated in both
      directions, because inferring it had failed: three TA references emit no marker,
      `talib-coverage.md` writes `GENERATED` in capitals, and the 15 API reports were never walked —
      four generated documents unaccounted for. The TA generators wrote raw markdown that
      `prettier --write` then reformatted, so the committed file never matched the generator
      (`ta-indicators.md` 44,258 B on disk against 18,227 B generated, all table padding) and no
      drift guard was possible; they now format their own output via `tools/write-generated.ts`.
      That immediately exposed real staleness: `rollingQuantile`'s parameter was renamed
      `q` → `quantile` in 3B.N and both `ta-indicators.md` and `ta-warmup.md` had gone on teaching
      `q` ever since.
- [x] Migrate runnable docs and examples with the contract slice they demonstrate. Every package
      README example is extracted verbatim, typechecked and EXECUTED against the packed tarballs
      (`tools/packed-consumer.test.ts`).
- [x] Regenerate MCP guides/resources/prompts and prove tool IDs, pack IDs, required arrays,
      descriptions, examples, error contexts, and output fields use the same canonical identities
      as the SDK and shared schemas — `tools/mcp-doc-conformance.test.ts`, exact in both directions
      because a tool id is a WIRE identity an agent types verbatim. It found the guide naming
      `totalfinance.crypto.perp_funding` when the tool is `perpetual_funding` (the 3B.N `perp` →
      `perpetual` rename never reached the guide, so an agent following the docs called a tool that
      does not exist), never mentioning `totalfinance.technical_analysis.describe` at all, writing the
      pack id as `technical-analysis` for `technical_analysis`, and claiming a "standard 20" against
      a default of 23. A count gate would have missed the first two: 23 was correct the whole time
      the guide named the wrong 23.
- [x] Regenerate package/deep-entrypoint bundle measurements and the stability table only after the
      new packed imports exist; retain the capability's budget and stability intent across a rename.
      Budgets, intents, rationales and structural guarantees are declared once in
      `tools/bundle-size/budgets.ts`; `budgets.test.ts` enforces them and `docs/bundle-size.md` is
      generated from the same record by `pnpm run bundle:update`, so intent travels with a rename
      because they are one object. The page had drifted badly while calling bundle size "a public
      contract": it published `@totalfinance/math` at "< 14 KB" against the 33 KB budget CI enforced
      (2.4x low), `black-scholes` at "< 8 KB" against 8.5, and omitted six budgeted entrypoints
      including the umbrella — the largest number in the library. Its measured column was worse:
      `performance/sharpe` published at 0.9 KB measures 5.7 KB, `technical-analysis/rsi` at 0.6 KB
      measures 4.6 KB. `bundle-size-doc.test.ts` is exact on the contract and tolerant on the
      measurements, which move with every commit.
- [x] Audit future-target docs after every implementation slice. They may describe not-yet-built
      APIs, but they must never prescribe a pre-normalization abbreviation. MECHANIZED rather than
      scheduled: the vocabulary rule runs the naming policy over every future-target fence on every
      CI run, so the audit cannot be forgotten between slices.
- [x] Preserve historical records and conventional equations; add or retain clear baseline/
      supersession context instead of rewriting evidence. Enforced by CLASS: `historical`,
      `formula-notation` and `migration-evidence` surfaces are exempt from both rules, so the
      milestones, the equation notation, and the before→after tables that ARE the removal evidence
      keep their exact old identities. Prose is never scanned under either rule — a sentence may say
      "VaR" or "the ATM vol"; 3B.N normalized executable identities, not English.
- [x] Validate every internal documentation link and generated index after package-directory,
      subpath, heading, and anchor changes — `tools/docs-conformance.test.ts`. It found a dead link on
      its first run: a rename sweep had rewritten `specs/vol-spot-beta.md` into a path that does not
      exist.
- [x] Finish with zero stale legacy executable names in active, current-runnable, or generated
      surfaces. Every remaining old token must resolve to an explicit permitted disposition, and
      the generated unresolved count must be zero. **0 findings, 0 dispositions needed.** Reaching
      that took 51 repairs the earlier grep-shaped gates could not see: 48 identifiers across 23
      SHIPPED specs named fields the library does not have (`var`, `cvar`, `iv`, `vols`, `tenor`,
      `t`, `dte`, `params`, `n`, `vol`) and 3 more in specs whose `Status:` marker wrapped across a
      blockquote line, which had silently held live API documentation to the weaker rule.

**Commit boundary:** migration of an active runnable example belongs to the same vertical commit as
its code/schema contract. Final full regeneration and the zero-stale-name report land in the Phase
3B.N8 closeout commit; they are never deferred to launch documentation.

### 3B.N9 — Closeout

- [x] Zero unresolved public naming identities. **19,698 public identities: 18,230 explicit,
      1,332 canonical-term, 133 scoped-symbol, 3 opaque-state, 0 unresolved.** (Counts refreshed
      after the 2026-08-02 defect-fix wave, which added validation, disclosures and two
      fixed-income deep entrypoints; unresolved stayed at zero throughout.)
- [x] Zero forbidden package/subpath/tool identities. `PACKAGE_IDENTITIES` is empty.
- [x] Zero unapproved abbreviated public fields, methods, labels, exports, discriminants, or stable
      code namespaces.
- [x] Zero SDK/schema/MCP/serialization vocabulary mismatches.
- [x] Zero old-name runtime aliases or compatibility branches.
- [x] Old flagship fields and imports fail with compile/runtime evidence.
- [x] Full format, lint, typecheck, test, coverage, build, API-report, runtime/signature/naming
      manifest, generated-doc, benchmark, bundle, and packed-tarball gates pass.
- [x] Update the alignment spec, Phase 3B trackers, roadmap, and implementation order with final
      counts and the closeout commit. See “Closeout state (3B.N9)”, which is itself gated: every
      figure in that table is parsed back out of this file and compared to the generated baseline.

Only then does Phase 3B.0 generate the runtime/semantic inventory on the final names.

## Commit sequence

Recommended boundaries:

1. `phase3b-naming: inventory the complete public vocabulary`
2. `phase3b-naming: normalize package and domain identities`
3. `phase3b-naming(core): normalize shared market and diagnostic contracts`
4. `phase3b-naming(math): normalize numerical protocols`
5. `phase3b-naming(options): make model APIs self-describing`
6. `phase3b-naming(volatility): normalize surfaces and forecasts`
7. `phase3b-naming(fixed-income): normalize specifications and model inputs`
8. `phase3b-naming(crypto): normalize carry time and fraction fields`
9. `phase3b-naming(risk-strategy): normalize book and strategy vocabulary`
10. `phase3b-naming(structure-backtest-performance): close dependent domains`
11. `phase3b-naming(technical-analysis): normalize registry and snapshots`
12. `phase3b-naming(mcp): align agent contracts`
13. `phase3b-naming: regenerate consumers and close the gate`

Fewer commits are acceptable when a shared contract cannot remain green separately. One repository-
wide unreviewable replacement commit is not.

## Required acceptance journeys

At minimum, packed consumers must prove:

1. `blackScholes.price(...)` and `blackScholesPrice(...)` use identical explicit request fields and
   agree numerically.
2. Old `{ vol, t, rate }` requests fail; the runtime names
   `{ volatility, timeToExpiryYears, riskFreeRate }` in one correction round trip.
3. The TA volume calculation accepts `volumeCutoff` and rejects the retired `volCutoff` with a
   typed `input.unknown_field`; no calculation accepts a bare `volCutoff`.
4. Option quote rows, batch columns, professional markets, surface rows, and MCP schemas use
   `impliedVolatility`.
5. Numeric timestamps state milliseconds at SDK, schema, artifact, and MCP layers.
6. `valueAtRisk` and `conditionalValueAtRisk` agree across direct risk results and MCP output while
   `bookVaR` remains discoverable.
7. TA snapshot serialization and restore round-trip through the new versioned envelope for every
   registered stream.
8. Search/discovery for `BSM`, `IV`, `vol`, `TA`, and `DTE` leads to canonical APIs without exposing
   old executable aliases.
9. New package and deep-subpath imports work from installed tarballs; old package identities fail.
10. Formula internals retain benchmark parity and no batch throughput regression is attributable to
    renaming.

## Closeout state (3B.N9) — reopened by RV7, re-closed, reopened again by RV9

**Reopened again by RV9 — the queue rose 0 -> 86, which is the rule starting to work.** `explicit` was the default for any name carrying no denylisted token, so 203 one-to-three-character tokens had never been reviewed, only unrecognized. All 203 are now dispositioned (77 ordinary words, 111 published identities each with a written reason, 15 truncations) and a permanent gate requires every short token in an `explicit` name to be one of those four things. The 86 were the `ma`, `vrp`, `oi`, `lw`, `adv`, `zcb` and `dk` families the review named.

**86 -> 0 — and this is the THIRD zero this phase has reported.** The first measured "no token the denylist recognized"; the second measured a corrected tokenizer while `explicit` was still the default for any short token no rule had an opinion about. This one measures that every short token in an `explicit` name is an ordinary word, an approved canonical term with a written reason, an approved scoped symbol, or in the queue — there is no fifth bucket and no default. Seven batches: `oi` 7, `vrp` 10, `zcb` 3, `lw`+`adv` 8, `ma`+`agg` 38, the parameter families 7, and the last thirteen bare tokens on math, volatility and TA.

Four things that would make the zero false again are now gated (an undeclared pardon, an excuse naming a token the name does not contain, a rationale swept into comparing a term with itself, a tracker drifting from the artifact) — each proved by planting the defect it exists for. Two are NOT gated and are recorded as known holes: a pardon written for one meaning that lands on another (found twice, `ar` and `tc`, both deleted), and a public spelling the inventory cannot see (string-LITERAL union members are not walked; `RankByKey` moved only because the compiler forced it).

**86 -> 79: the `oi` family is spelled out.** `callOi`/`putOi` on `GexSplit`, `largestCallOi`/`largestPutOi` on `Levels`, `volumeOiRatio` on `FlowGroup` and `minVolumeOiRatio` on `RankOptions` all say `openInterest` now. Two things came out of the batch that the renames alone would not have:

- **`rank` had no Law 12 guard.** It read its options by property and rejected no unknown key, so a caller still passing the retired `minVolumeOiRatio` would have had the filter silently not applied and received a longer list than they asked for. `ensureKnownKeys` landed on that boundary in the same commit, which is what lets the removal be proved by a runtime throw instead of only by the baseline.
- **A public spelling this inventory cannot see.** `RankByKey` is a string union whose members must be keys of `FlowGroup` (`rank` sorts with `b[by]`), so the retired field name was also a VALUE callers pass as data. The inventory walks declared identifiers and TypeScript `enum` members, not string-LITERAL union members — that value moved only because the compiler forced it. A union whose members are not keys of some walked type would have gone unnoticed. The hole is recorded in `naming-conformance.test.ts`, its executable evidence lives in `naming-removals.test.ts`, and widening the walk is its own batch.

**Reopened by RV7 and re-closed at 0 — but this zero is not the old zero.** The gate that first reported an empty queue was measuring "no token the denylist recognized". Corrected (it now sees through numeric suffixes, embedded single letters and short truncations) the queue was 199. Burning it down took four batches: the volatility bracket and two-asset spread, the skew desk vocabulary and candle bodies, the Bollinger/Keltner/multiplier families, and finally 66 individually-reasoned NAME entries for published notation (VaR/CVaR, R², p-value, %K/%D, Senkou spans, %B, greeks partials, Gatheral's g, SSVI's w, G2++, z-score, k-fold). Every allowlisted name carries a written rationale, and a gate now fails if any is blank. 94 retired forms are covered by executable removal fixtures (see the table row below).

Regenerate with `pnpm naming:update`; `pnpm run ci` fails on any drift from the committed baseline.
The live counts below include the 2026-09-09 [signed-leg simplification](./signed-leg-constructors.md),
the standalone TotalFinance namespace migration and the 2026-10-01
[selective Greeks and exposure APIs](./selective-greeks-and-exposure.md). The canonical brand token reclassifies 116
identities without adding or removing a public identity; the historical naming phase stays closed.

| Final measure                                            |      Count |
| -------------------------------------------------------- | ---------: |
| Public naming identities walked                          |     42,256 |
| **Unresolved (the migration queue)**                     |      **0** |
| `explicit`                                               |     38,310 |
| `canonical-term` (allowlisted, each with a rationale)    |      3,784 |
| `scoped-symbol` (approved notation inside a named scope) |        159 |
| `opaque-state` (round-trip payload interiors)            |          3 |
| Retired forms with executable removal evidence           | 115 of 115 |
| Packages, including the umbrella                         |         25 |

Identity kinds walked: 22,387 fields, 7,289 exports, 4,088 parameters, 4,470 string-literal values, 1,688 methods, 1,520 MCP schema
fields, 273 stable codes, 273 enum members, 188 subpaths, 55 MCP tools, 25 packages. The MCP schema
fields and the array-element and method-signature walks were added during N7 after the inventory was
found to be reporting zero unresolved over an incomplete traversal — 18,077 identities became 19,209
without a single name changing, which is the reason the count is quoted with the walk that produced
it.

### What the gates cover, and what they cannot

Eight tests hold this surface: `naming-conformance`, `naming-removals`, `spec-mapping-conformance`,
`signature-conformance`, `conformance` (manifest), `codes-conformance`, `readme-gen`, `llms-docs`.
Together they catch a forbidden token, an unclassified export, a drifted declaration, an unregistered
error code, a stale generated document, a retired form that returns, a removal fixture rewritten into
a tautology, and a spec row whose stated target never landed.

They cannot catch a fully spelled-out name that is simply false. `oneSigmaPercent` returning a
fraction, `volumeOf` renamed to `volatilityOf`, `vannaFlowPerVolatility` holding a per-vol-POINT
number, `pnlVolatility` where the spec had written `pnlStandardDeviation`, `dTime` in years beside
greeks reported per day — every one passed every mechanical gate, and every one was caught by a human
or an AI reading the code. Six were found by external review and five more by the spec gate written
in response to it.

The lesson is recorded here because it is the phase's most transferable result: a naming ratchet
proves that no name contains a banned string. It cannot prove that a name is TRUE. Budget review time
for the second question, especially after any bulk rename — and prefer, where the shape allows,
naming that a test can falsify: a unit in the name, a rejected retired spelling, a spec row a gate can
read.

### The 69 contracts that still refuse a synthesized baseline

`unmeasured` fell from 1,011 to 285 by making each opaque bucket explain itself; the same discipline
applies to what is left. These 69 are not one backlog. Grouping them by what the library actually
said splits them into three kinds of thing, and only the first is harness debt:

**Harness input gaps (≈31).** Synthesis can build a valid input and does not yet.

| n   | example                                 | what it wants                                                |
| --- | --------------------------------------- | ------------------------------------------------------------ |
| 8   | `BarAggregator#restore`                 | a snapshot from a producer that is not a `.fromJSON` sibling |
| 6   | `curves.bootstrapMultiCurve`            | a date in a string field the name table does not cover       |
| 6   | `credit.survivalFromHazards`            | pillars after the curve's reference date                     |
| 3   | `dividendTermStructure`                 | an ISO expiry where the alternatives ran out                 |
| 3   | `adjustPValues`                         | a series in [0, 1] — it is handed a price path               |
| 3   | `FlowAnalysis#groupBy`                  | trade prints for a constructor argument                      |
| 1   | `bonds.fixedRate`, `calibrationWeights` | an anonymous inline element contract                         |

**Constraints the declaration does not carry (≈36).** These are FINDINGS for 3B.2, not harness debt.
The type checks; the runtime refuses; a consumer gets no compile-time help.

| n   | example                          | the unstated rule                                                         |
| --- | -------------------------------- | ------------------------------------------------------------------------- |
| 9   | `kalmanFilter`                   | observation width must match the model's `m`, set by another argument     |
| 5   | `Position#chartData`             | `premium` is declared optional and is required in this mode               |
| 3   | `tipsIndexRatio`                 | _exactly one_ of `baseReferenceCpi` / `datedDate`, both declared optional |
| 3   | `barsFromColumns`                | _at least one_ of open/high/low/close/volume, all declared optional       |
| 3   | `restoreRandomNumberGenerator`   | `algorithm: string`, closed at runtime                                    |
| 3   | `ols`, `engleGranger`            | a design matrix needs n > k and non-collinear regressors                  |
| 3   | `swaptionCube`                   | node count must equal expiries × tenors                                   |
| 1   | `SimulatedBroker#submit`         | _exactly one_ of `quantity` / `notional`                                  |
| 1   | `prepareSlices`                  | each slice must provide `w` **or** `impliedVolatility`                    |
| 1   | `SimulatedBroker#exerciseOption` | depends on the broker's `assignment` policy, not on the input             |

The recurring shape is worth naming: **"exactly one of" and "at least one of" are expressed as
several optional fields**, which is precisely the constraint a discriminated union can state and an
options bag cannot. Nine boundaries across four packages, and each one is a call a consumer can write,
compile, ship, and have refused at runtime.

Three were verified by hand rather than taken from the harness:

- `barsFromColumns({})` refuses; `barsFromColumns({ close: [1, 2, 3] })` returns bars. All five
  columns are declared optional and the runtime requires at least one.
- `tipsIndexRatio` refuses with NEITHER `baseReferenceCpi` nor `datedDate`, refuses with BOTH, and
  accepts exactly one. Both are declared `?`. The declaration's own doc comment states the rule the
  type cannot — "supply this OR `datedDate`, exactly one" — which is the finding in one line.
- `restoreRandomNumberGenerator({ algorithm: 'x', … })` refuses with `unknown algorithm "x"`, against
  a field declared `algorithm: string`.

**Numerically incoherent input (2).** `vannaVolgaApproximation` and `vannaVolgaDensity` receive
shape-valid numbers that are not a coherent smile, and say so. Not a defect on either side.

### Callback synthesis is ON, and the reason it was off was wrong

Callbacks had been unsynthesizable on a documented, twice-tested conclusion: a stub answering the
same thing forever drives numerical routines into non-termination, `0` is the worst possible default
because it is the sentinel numerical code tests against, `0.5` fixed one case and broke another — so
no constant is safe, and enabling this needs per-boundary process isolation first.

Every sentence of that is true. The conclusion drawn from it was not. The two known hangs want
OPPOSITE things, and once that is seen the fix is a stub rather than an isolation mechanism:

    normalSample      `while (u1 === 0) u1 = rng.next()` on a NULLARY callback. Nothing but per-call
                      variation ever leaves that loop, and per-call variation is what an RNG is.
    adaptiveSimpson   `integrand(x)` on a UNARY callback. A value that varies per call is the worst
                      possible integrand: adaptive quadrature reads the disagreement between coarse
                      and fine panels as roughness and subdivides. It wants a SMOOTH function.

So arity decides. Zero arguments get a deterministic sequence in (0, 1); one or more get a smooth
bounded function of the first numeric argument. Both are pure, so the artifact stays deterministic.
The run has zero hangs and takes 106 seconds.

Two things had to be recorded past the type TEXT for this to work, both the same lesson as the
literal unions: `adaptiveSimpson(integrand: ScalarFunction, …)` renders with no `=>` in it at all, so
the inventory now records the RESOLVED arity and return type for every callable parameter and field.
Without that, 69 boundaries stayed unbuildable while the checker had known the answer all along.

Result: `callback-input-required` 90 → 45, and 69 boundaries moved from unmeasured to a verdict —
39 of them straight to `defective`. Spot-checked by hand:

- `bonds.fixedRate({ couponRate: NaN, … })` — ACCEPTED, and builds a bond whose every price is NaN.
- `bonds.fixedRate({ couponRate: '5%', … })` — ACCEPTED, a string where a number is declared.
- `adaptiveSimpson(f, 0, 1, { maxDepth: 'nope' })` — ACCEPTED.
- `bisection(f, 0, 1, { stepTolerance: {} })` — ACCEPTED.

The 45 that remain need a stub returning a domain OBJECT — `IndicatorDefinition.stream` returns an
`IndicatorStream` — which is a real limit rather than a decision, and the honest place to stop.

### A non-termination defect, found by the harness and fixed at the source

Turning callbacks on made `adaptiveSimpson` reachable, and it hung. Reproduced by hand:
`adaptiveSimpsonSafe(f, NaN, 1)` never returns, while `[1, 1]` and `[0, 1]` both answer in under a
millisecond.

A NaN bound makes the error estimate NaN. Every comparison with NaN is false, so
`Math.abs(err) <= 15 * tolerance` can never be taken and the only remaining exit is depth
exhaustion — and the recursion is BINARY, so reaching depth 50 that way costs 2^50 evaluations. Not
an infinite loop: a finite one no one will outlive. A caller who let a NaN propagate into a bound got
a hung process rather than an error, which is the worst failure mode in this library — silent,
unattributable, and indistinguishable from a deadlock.

Two defects, and the second is the more interesting: **`maxDepth: 50` reads like a safety bound and
is not one**, because it bounds the height of the tree rather than the work under it. Both fixed in
`packages/math/src/integration.ts` — bounds are guarded with `ensureFinite`, and `maxEvaluations`
(default 100,000) bounds the work, reported through the `converged: false` contract that already
existed. Regression tests assert TERMINATION as much as the error, because an unguarded regression
here does not fail, it hangs.

This is the outcome to aim for from a measurement harness: not a skip list, not a workaround, but a
defect fixed where it lives.

### A receiver can be PRODUCED as well as constructed

`external-callback-contract` meant "a callback the LIBRARY calls, with no implementation here to
probe" — and 9 of its 28 members were nothing of the kind. `Bond#accrued`, `HullWhiteModel#caplet`,
`YieldCurve#addSpread`: the library implements every one. They landed there because the reason was
chosen by whether the owner resolves as a runtime EXPORT, and a `Bond` is not exported. It is
returned, by `bonds.fixedRate(...)`.

The inventory had already recorded the answer on every callable — its `resultContract` — so finding
the factory is a lookup rather than a guess. Same shape of mistake as the retired `not-callable`
reason, which also declared work impossible when it was merely undone.

Hand-verified afterwards, on a boundary that had been recorded as having nothing to measure:

- `bond.accrued('2024-06-03', { qzxBogusKey: 1 })` returns `2.111…`. The undeclared key is ignored.
- `bond.accrued('2024-06-03', { forecastCurve: 'nope' })` returns the same. A string is accepted
  where a `YieldCurve` is declared.

`external-callback-contract` is 17, and those 17 are the real thing: `StrategyContext#buy`,
`CostModel#commission` and friends, whose contract is enforced where the library INVOKES them — a
different measurement, not a missing one.

The same pass corrected a THIRD instance of one mistake. The receiver branch fell through to
`receiver-unresolved` whenever a measurement did not happen, and for all 12 of those the receiver was
fine: `SimulatedBroker#equity(marks)`, `ExposureProfile#levels(options)`,
`VolatilitySurface#shock(shifts, …)` each have an obtainable receiver and an argument synthesis could
not build. Reporting that as an unreachable receiver sends a reader to construct something that
already constructs.

Three times now the reason has been chosen by WHICH BRANCH GAVE UP rather than by what was missing —
`not-callable` claiming instance methods held nothing to measure, `external-callback-contract`
claiming `Bond#accrued` had no implementation to probe, and this. The label named the harness's own
last step instead of the gap. It is worth stating as a rule: a diagnostic that reports where the code
stopped is describing the code, not the problem.

### "2,096 implementations" is not a workload count

Three declaration identities — `Indicator.explain`, `.stream`, `.fromJSON` — cover 1,875 public
paths between them, because `Indicator` is a generic interface all 625 indicators implement. So the
identity count answers "how many declarations are there to fix" and not "how many functions are
there to measure", and publishing only the first invites the second reading.
`maxPathsPerImplementation` (625) now sits beside it so the two questions stay apart.

The measurement itself is sound, and this was worth checking rather than assuming: 1,302 of the
1,323 records under those identities are measured DIRECTLY, and their verdicts disagree — 628
enforced, 542 partial, 138 defective. A spread inheritance could not produce. Only 6 are inherited,
and a gate now holds that, because inheriting a verdict across 625 distinct closures would assert
behaviour for 624 functions nobody called.

Inheritance along an ALIAS remains correct: `options:gbmPath` and `options:gbm.path` are two names
for one function object. The distinction is whether the paths denote the same runtime function.

### A false `enforced`, and what it was hiding

`register(entry)` scored `enforced` and had earned none of it.

It writes into the process-global indicator registry, and registering a name twice is correctly
refused. Synthesis used a constant `name: 'Test'`, so the baseline succeeded and then EVERY probe was
refused — as a duplicate. A clean sweep of rejections that had nothing to do with the mutations, read
as a boundary that rejects everything.

Minting a fresh identity per call removed the confound, and the boundary is `defective`. Verified by
hand against the harness's own synthesized entry, each call with its own name:

- `register({ …, qzxBogusKey: 1 })` — ACCEPTED.
- `register({ … })` with the required `category` omitted — ACCEPTED.
- `register({ …, category: 42 })` where a string is declared — ACCEPTED.

Three defects behind one false pass. It is the exact failure this phase was opened to remove —
enforcement inferred from a signal that correlates with rejection instead of measured against the
contract — and it survived this long because nothing could call `register` at all until callback
synthesis let it run.

Two consequences worth keeping. `enforced` FELL from 1,023 to 1,020, so a ratchet that only ever
rises would have made the correction unlandable; the gate records why the number went down. And a
boundary that mutates global state cannot be measured twice in one process, which is a fact about the
library — `GLOBAL_STATE_BOUNDARIES` names the three affected paths with a rationale each, and the
in-process determinism check excludes exactly those. The committed artifact comes from a single pass
and still reproduces byte-for-byte across processes.

**A correction: one of the findings above was fabricated.** An earlier version of this section claimed
a failed `register` is not rolled back and therefore cannot be retried. That is false. `registry.ts`
validates the whole entry and then performs a single `REGISTRY.set`, so a rejected entry leaves the
registry untouched and a corrected retry succeeds. I never opened the function — I inferred a library
defect from the harness's own duplicate-name confusion and wrote it down as a finding.

It is recorded rather than deleted because it is the same failure as the one this section is about,
committed by me instead of by the harness: a claim about the library derived from something that
merely correlates with it. Everything else here was verified by running it.

### Non-termination is DECLARED, not discovered

A hang detected by a wall-clock budget is a timing fact: which boundary is in flight when the budget
expires depends on how fast the machine is, so a slower CI box could skip a different one and fail
the drift gate for a reason unrelated to any change. Two runs agreeing on one laptop is not
reproducibility.

So `NON_TERMINATING_BOUNDARIES` seeds the skip list, and detection becomes a tripwire:
`contract-conformance.test.ts` FAILS on any `probe-timeout` not named there. The generator reads the
list itself rather than trusting an environment variable, because a generator that behaves
differently depending on its caller cannot be checked for drift at all.

One entry today — `swapXva`, whose baseline returns in ~620 ms while some deeper probe does not
finish inside 20 s. Recorded with what was measured rather than with a guess, including the separate
finding that `stepsPerYear: NaN` is accepted and returns instantly. The list is meant to shrink:
`adaptiveSimpson` would have been on it and was fixed at the source instead.

### What ran only on my laptop

There were no GitHub workflows. Thirty-five contract-conformance gates, the naming gates, the drift and
determinism checks, and a packed-consumer suite that installs real tarballs — all of them ran when
somebody typed `pnpm run ci`, and never otherwise. A PR could go green in review having exercised none
of them. `.github/workflows/totalfinance-ci.yml` now runs the whole suite on every push and pull request
touching `totalfinance/`, across three Node versions.

The matrix earned its place immediately, twice.

**A caret range was rewriting a generated artifact.** A reviewer hit `public-signatures.json has
drifted` and I could not reproduce it on Node 22, 24 or 26 — because Node was never the variable.
`typescript` was declared `^5.7.3`, and every `type` string in that artifact is
`checker.typeToString(...)` output, so the file's bytes are a function of the compiler that wrote them.
Two checkouts installed on different days resolve different patches and disagree about a file neither
has edited. TypeScript is now pinned exactly, the artifact RECORDS the version that produced it, and
the gate checks the compiler before the contents — so the failure says "generated with 5.9.3, you are
running 5.10.0" instead of printing a thousand lines of near-identical type strings.

**Neither edge of the supported range could run the test suite, for different reasons.** `engines`
claims `>=22.13.0` and nothing had ever tested it.

On **Node 22.15.1** the drift gate failed with `Test timed out`. It ran two full in-process enforcement
generations under one 600-second budget, and each is about 190 seconds now that callback synthesis is
on — just under the bound on the development machine, well over it on the oldest supported version.
That is the identical mistake corrected in `measure-supervisor.ts` a day earlier (a fixed time budget
over a workload that grows every time the measurement improves), left in place one file away. Split so
each test owns a known number of generations.

Fixing that exposed a second Node 22 failure underneath it: all 6,604 tests passed and the run still
exited non-zero, on `[vitest-worker]: Timeout calling "onTaskUpdate"`. The measurement loop `await`s a
MEMOIZED resolver, so after the first pass almost every await settles on the microtask queue — which
never yields to timers or I/O. Fourteen minutes of that starves the reporter's heartbeat. Fixed in the
generator with a periodic `setImmediate`, because a generator that monopolises the event loop is a bad
citizen in any host, not just under vitest.

On **Node 26.5.1** the suite exhausts Node's default 4 GB heap — `FATAL ERROR: Ineffective
mark-compacts near heap limit`, exactly as reported. Peak retention was reduced first (the determinism
check reduces each record to a comparable string and releases it before generating the next), and that
was not enough: the requirement is real, since each generation imports the whole library, resolves
~4,000 callables and constructs receivers, with istanbul instrumenting all of it. Declared in
`vitest.config.ts` via `poolOptions.*.execArgv`, which is the only setting that reaches the pooled
child that actually runs out — deliberately NOT as `NODE_OPTIONS` in the workflow, since that would
make `pnpm run ci` pass in CI and fail on a contributor's machine, which is how it was hit in the first
place.

Three defects, one environmental cause each, none of them visible to a single machine on a single
toolchain. That is the whole argument for the matrix.

### I ran a bulk rename and it produced false names

The naming gate found thirty-three leaks and I fixed them with a scripted pass that mapped each banned
token to a canonical one. That was the wrong tool, and it did the exact thing this document's own N9
section warns about: **a ratchet proves no name contains a banned string; it cannot prove a name is
TRUE.** Eight of my replacements were false.

| what it was                        | what I named it      | what it actually is        |
| ---------------------------------- | -------------------- | -------------------------- |
| `inst.rate` (bootstrap instrument) | `riskFreeRate`       | a par / quoted rate        |
| `t` in `snapshots[t]`              | `timeToExpiryYears`  | a snapshot INDEX           |
| `t` in `periods[t]`                | `timeYears`          | a period INDEX             |
| `model.x0.length`                  | `observations`       | the Kalman STATE DIMENSION |
| two array lengths                  | `spot`, `volatility` | lengths                    |

The first is the sharpest. `naming-policy.ts` says, in words, about these exact fields: _"These are par /
quoted rates, NOT risk-free rates: expanding them to `riskFreeRate` would be a lie, which is the trap
law N3 (semantic, never string, expansion) exists to catch."_ The policy file predicted my mistake and
I made it anyway, because a script does not read policy files. Every one of the others is refuted by
the message sitting beside it — `snapshots[${t}]`, `periods[${t}]`, "state dimension ≥ 1", "must have
the same length".

A related casualty from an earlier sweep, still in the tree: `resample.ts` computed a bucket width in
milliseconds and called it `impliedVolatility`, because `iv` there meant INTERVAL. Nine occurrences.

All corrected by hand, each against the code around it.

### The gate that permitted it, replaced

The gate that was supposed to catch this read LINES — lines containing a backtick, and flat
`context: { … }` matches. It passed while a message split across lines, built by concatenation, or
written as a plain quoted string went unread. A reviewer listed five it had missed; replacing it with a
TypeScript AST scan over the actual error and warning construction sites found six immediately,
including `explain.ts` teaching `{ spot, vol, rate, asOf }` for a type that declares `volatility` and
`riskFreeRate` — the same false example as `position.ts`, in a different file, invisible to the regex.

Two lessons, and the second is the one that generalizes. A line is not a unit of meaning, so a scanner
that reads lines will always be one formatting choice away from blind. And a mechanical fix to a
naming problem is a contradiction in terms: the whole reason these names are wrong is that a machine
cannot tell which expansion is true.

## Exit statement

After this phase, a caller never has to remember that TotalFinance spells volatility `vol`, implied
volatility `iv`, time-to-expiry-in-years `t`, an epoch-millisecond timestamp `ts`, options `opts`, or
parameters `params`. The remaining short terms are deliberate, searchable domain language or
scoped mathematical notation with a recorded rationale.

That is the vocabulary Phase 3B may safely validate and freeze.
