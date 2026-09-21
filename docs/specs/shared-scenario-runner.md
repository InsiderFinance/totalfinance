# Spec — Stage 4.4b shared cross-domain scenario runner

> **Status:** `COMPLETE @ 3095cf91` — implemented and verified 2026-09-01. All four ordered slices,
> executable acceptance laws, generated artifacts, packed consumers, and the full repository gate
> are green at the named implementation commit. Stage 4.5 is the next queue row; this file remains
> the permanent Stage 4.4b contract and evidence record.
>
> **Queue authority:** [`../implementation-order.md`](../implementation-order.md) §4.4. This file
> owns the API, semantics, package placement, implementation slices, and exit evidence for Stage
> 4.4b. It does not reopen Gate B, Gate C, FC7, or any direct pricing API.
>
> **Permanent API authority:** [`../library-alignment-spec.md`](../library-alignment-spec.md),
> [`../platform-completeness-roadmap.md`](../platform-completeness-roadmap.md), and Decisions D1–D20
> in [`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md).
> Every new public identity enters the naming, runtime, field, result, finite-success, manifest,
> package-graph, packed-consumer, and bundle ratchets in its first implementation commit.

## Outcome

One `ScenarioSet` must run across a heterogeneous collection of directly priced instruments,
Taylor approximations, and positions derived from the durable portfolio ledger. The result must
answer, without guessing:

- what every target was worth at the base market and under each scenario;
- the scenario P&L at target, underlying, strategy, account, book, and grand-total levels;
- which observations and scenario instructions produced each value;
- which direct pricer or Taylor calculation ran, with its assumptions and diagnostics intact;
- which currency conversion made unlike targets additive;
- whether any cell failed and therefore made an aggregate incomplete; and
- how to save and replay the calculation through the existing Gate B artifact spine.

This is an additive composition. A developer pricing one option still calls `blackScholes(...)` or
`option.price(...)`; a developer stressing one Greeks vector still calls `taylorPnl(...)`; a
developer analyzing one strategy book still calls `analyzeBook(...)`. None of those calls acquires a
scenario-package dependency or a durable-object ceremony.

## Non-goals

Stage 4.4b does **not** add:

- a universal instrument superclass, mutable market registry, global pricer registry, or stringly
  mega-dispatch;
- pricing mathematics, a second Taylor engine, a second FX conversion formula, a second market or
  scenario grammar, or a second result/artifact envelope;
- asynchronous jobs, workers, WASM, Arrow, GPU execution, streaming, checkpoints, or distributed
  execution;
- provider calls, credentials, data normalization, databases, HTTP, CLI, MCP, broker access, order
  placement, or portfolio mutation;
- historical simulation, event-driven backtesting, path generation, calibration, or research-run
  artifacts; or
- automatic volatility-surface interpolation, forward derivation, curve construction, currency
  triangulation, or any other hidden market assumption.

Those exclusions keep the runner synchronous, browser-safe, BYOD, clock-free, deterministic, and
small enough to trust. Later layers consume this API; they do not become its implementation home.

## Decision 1 — package and import shape

Create a compute-only L4 package named **`@totalfinance/scenarios`**. The plural reads naturally at the
umbrella (`totalfinance.scenarios.runScenarios`) and describes a collection dimension rather than one
scenario record. It is not `@totalfinance/workflows`: workflows are the future L5 acquire/normalize/
compute/save layer and may depend on scenarios, never own their mathematics.

Runtime dependencies are exactly:

```text
@totalfinance/scenarios → @totalfinance/core
                    → @totalfinance/risk
                    → @totalfinance/portfolio
                    → @totalfinance/foreign-exchange
```

Manifest domain is `scenarios`, tier `facade`: it is a validated user-facing composition, not a
trusted numeric kernel or a transport integration.

The same-layer dependencies on `risk` and `portfolio` are deliberate composition edges. They avoid
the forbidden `risk ↔ portfolio` edges: the package above both owns their composition. Add this row
to the executable FC0/Gate A graph and place it at L4 in the layer model. The predeclared future
workflow/HTTP/CLI and current MCP allowlists must add both `@totalfinance/portfolio` (the FC7 package
those older lists never picked up) and `@totalfinance/scenarios`; a future workflow/transport must be
able to consume them, while neither package may reverse-depend on an edge layer.

Public discovery:

```ts
import {
  runScenarios,
  scenarioTarget,
  spotAssetPricer,
  scenarioPortfolioBinding,
  scenarioTargetsFromPortfolio,
} from '@totalfinance/scenarios';

import {
  scenarioPortfolioBinding,
  scenarioTargetsFromPortfolio,
} from '@totalfinance/scenarios/portfolio';
import { optionContractPricer } from '@totalfinance/options/pricer';
import { bondDiscountCurvePricer } from '@totalfinance/fixed-income/pricer';

import { scenarios } from 'totalfinance';
// scenarios.runScenarios(...)
```

The package root exports the five named values above and their public types. `./portfolio` is a real
lean subpath containing the binding builder plus adapter, not an empty barrel. The fixed-income
adapter lives beside the direct function it wraps at `@totalfinance/fixed-income/pricer`; the existing
option adapter stays at `@totalfinance/options/pricer`. The umbrella receives a `scenarios` namespace
and `totalfinance/scenarios` subpath, with **no root hoists** (D20).

Do not add speculative `./engine`, `./runtime`, `./worker`, or `./wasm` subpaths.

## Decision 2 — one obvious call and type-safe target builders

The primary call is one named request object:

```ts
const result = runScenarios({
  scenarioSet,
  market,
  targets,
  reportingCurrency: 'USD',
  currencyConversions,
  options: {
    failureMode: 'fail-fast',
    seed: 7,
  },
});
```

`runScenarios` accepts only:

```ts
interface RunScenariosInput {
  scenarioSet: ScenarioSet;
  market: MarketSnapshot;
  targets: readonly ScenarioTarget[];
  reportingCurrency?: string;
  currencyConversions?: readonly CurrencyPairQuote[];
  options?: RunScenariosOptions;
}
```

`ScenarioSet`, `MarketSnapshot`, `CurrencyPairQuote`, `Pricer`, `PricerValuationResult`,
`MarketRequirement`, and `MarketObservation` are the existing core/domain types. Do not copy their
grammars. `PricerValuationResult` is the structural Law-2 floor that permits a domain to retain a
richer assumptions vocabulary than core's default `Computed<number>` alias.

The closed options object is exactly:

```ts
interface RunScenariosOptions {
  failureMode?: 'fail-fast' | 'collect';
  seed?: number;
  maximumValuationCells?: number;
  maximumWorkUnits?: number;
  marketResolvers?: readonly ScenarioMarketResolver[];
  factorHandlers?: readonly ScenarioFactorHandler[];
}
```

Omission selects the documented defaults below; `null` is never omission.
`targets` must be a non-empty dense array of builder-produced values; an empty book answers no
question and cannot infer a reporting currency. Caller order is preserved.

TypeScript cannot directly express a heterogeneous array of arbitrary `Pricer<TInstrument>` pairs
without leaking `any`, unsafe casts, or a universal instrument type. Solve that once with a tiny,
inspectable builder namespace:

```ts
const optionTarget = scenarioTarget.fullRevaluation({
  id: 'AAPL-2027-200C',
  quantity: 4,
  contractMultiplier: 100,
  currency: 'USD',
  underlying: 'AAPL',
  instrument: callContract({ ... }),
  pricer: optionContractPricer(),
});

const approximation = scenarioTarget.taylor({
  id: 'desk-approximation',
  quantity: 1,
  contractMultiplier: 1,
  currency: 'USD',
  underlying: 'AAPL',
  baseValuePerUnit: 42.5,
  greeks: { delta: 0.55, gamma: 0.018, vega: 31, theta: -8, rho: 12 },
  factors: {
    spot: { subject: 'AAPL', level: 195 },
    volatility: { subject: 'AAPL', level: 0.24 },
    riskFreeRate: { subject: 'USD', level: 0.045 },
    valuationInstant: { level: 1_786_915_200_000 },
  },
});
```

The builders return `ScenarioTarget` values whose public data—identity, scaling, grouping,
descriptor, valuation method, and pricer identity/capabilities—is inspectable and deeply frozen.
Internal type erasure binds the caller-owned instrument and pricer in a non-enumerable per-target
closure. It never freezes, clones, mutates, or serializes those behavior objects, and it never uses a
global registry. Generated declarations must not expose `any`, require a consumer cast, hide the
public target data, or introduce a base class. `scenarioTargetsFromPortfolio` returns the same target
type.

`scenarioTarget` has exactly three builders:

- `fullRevaluation({ ...base, instrument, pricer, instrumentDescriptor? })`;
- `taylor({ ...base, baseValuePerUnit, greeks, factors })`; and
- `spot({ id, symbol, quantity, currency, ...grouping })`, the common convenience that binds
  `spotAssetPricer()`, sets and echoes `contractMultiplier: 1`, and records a plain spot-asset
  descriptor. Anything with a non-unit multiplier uses `fullRevaluation` explicitly.

The shared base fields are:

```ts
interface ScenarioTargetBaseInput {
  id: string;
  quantity: number;
  contractMultiplier: number;
  currency: string;
  underlying?: string;
  strategy?: string;
  account?: string;
  book?: string;
  tags?: readonly string[];
}
```

The exported target grammar is settled rather than left to implementation inference. The builder
inputs and the stored public descriptor are different types: behavior enters through the input and
never leaks into the descriptor.

```ts
interface FullRevaluationScenarioTargetInput<TInstrument> extends ScenarioTargetBaseInput {
  instrument: TInstrument;
  instrumentDescriptor?: unknown;
  pricer: Pricer<NoInfer<TInstrument>, PricerValuationResult>;
}

interface TaylorFactorLevel {
  readonly subject: string;
  readonly level: number;
}

interface TaylorValuationInstantLevel {
  readonly level: EpochMs;
}

interface TaylorFactors {
  readonly spot?: TaylorFactorLevel;
  readonly volatility?: TaylorFactorLevel;
  readonly riskFreeRate?: TaylorFactorLevel;
  readonly dividend?: TaylorFactorLevel;
  readonly valuationInstant?: TaylorValuationInstantLevel;
}

interface TaylorScenarioTargetInput extends ScenarioTargetBaseInput {
  baseValuePerUnit: number;
  greeks: TaylorSensitivities;
  factors: TaylorFactors;
}

interface SpotScenarioTargetInput {
  id: string;
  symbol: string;
  quantity: number;
  currency: string;
  strategy?: string;
  account?: string;
  book?: string;
  tags?: readonly string[];
}

interface ScenarioPricerDescriptor {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Readonly<PricerCapabilities>;
}

interface ScenarioTargetDescriptorBase {
  readonly id: string;
  readonly quantity: number;
  readonly contractMultiplier: number;
  readonly currency: string;
  readonly underlying?: string;
  readonly strategy?: string;
  readonly account?: string;
  readonly book?: string;
  readonly tags: readonly string[];
  readonly targetDescriptorHash: string;
}

interface FullRevaluationScenarioTargetDescriptor extends ScenarioTargetDescriptorBase {
  readonly valuationMethod: 'full-revaluation';
  readonly instrumentDescriptor: unknown;
  readonly instrumentDescriptorHash: string;
  readonly pricer: ScenarioPricerDescriptor;
}

interface TaylorScenarioTargetDescriptor extends ScenarioTargetDescriptorBase {
  readonly valuationMethod: 'taylor';
  readonly taylor: {
    readonly baseValuePerUnit: number;
    readonly sensitivities: Readonly<TaylorSensitivities>;
    readonly factors: TaylorFactors;
  };
  readonly taylorDescriptorHash: string;
}

type ScenarioTargetDescriptor =
  | FullRevaluationScenarioTargetDescriptor
  | TaylorScenarioTargetDescriptor;

declare const scenarioTargetBrand: unique symbol;
type ScenarioTarget = ScenarioTargetDescriptor & {
  readonly [scenarioTargetBrand]: true;
};
```

`scenarioTargetBrand` is declaration-private: consumers receive an opaque builder-owned value but
cannot import a brand or hand-construct a target accidentally. At runtime the brand and the
full-revaluation `{ instrument, pricer }` binding are non-enumerable own data behind two distinct
implementation-private symbols: the brand symbol stores `true`, and the binding symbol stores the
behavior pair. They are never included in `Reflect.ownKeys` validation of the public descriptor
because that validator removes exactly these recognized private symbols before enforcing the
closed public key set; every other symbol still refuses. They never cross serialization.
Deep-freeze the public descriptor **before** attaching the binding, then `Object.freeze` only the
target shell; never pass the behavior-bearing target through a generic recursive freezer that could
freeze the caller's instrument or pricer.
`targetDescriptorHash` covers the complete public descriptor except
itself; the method-specific hash covers exactly `instrumentDescriptor` or `taylor`. Every interface
and union above is exported except the brand constant itself. The namespace signatures are exactly
the generic full-revaluation builder, the Taylor builder, and the spot builder shown above.
`NoInfer` makes the instrument the source of generic inference; compile fixtures must reject an
option instrument paired with a bond/spot pricer without relying on runtime `supports`.
`scenarioTarget.spot` always records `underlying: symbol`; it does not accept a second underlying
field that could contradict the asset being priced.

Rules:

- `id` and every supplied grouping string are non-empty; IDs are unique for the run.
- `quantity` is finite, signed, and non-zero. Long is positive; short is negative.
- `contractMultiplier` is finite and strictly positive. It is required on the general builders—an
  option's `100`, a future's contract size, and an adjusted contract are never guessed.
- `currency` uses the existing uppercase currency-code guard.
- tags are non-empty, duplicate-free strings, capped at 128 per target. Preserve caller order on the
  target axis; group rows sort by key for deterministic output.
- target metadata and Taylor data are closed stored-data objects: reject unknown keys, accessors,
  coercion hooks, malformed containers, and non-finite leaves before any pricing.
- a full-revaluation instrument may be a behavior-bearing domain object. The runner never mutates or
  serializes it blindly. `instrumentDescriptor` is a canonical JSON-safe replay descriptor. When it
  is omitted, the builder derives it only if the instrument itself is canonical JSON-safe (for
  example, an `OptionContract`); otherwise it teaches the caller to supply the descriptor.
- the pricer is validated through the Gate C structural door. The builder stores the binding but
  does **not** call `supports`, `requirements`, or `price`; `runScenarios` calls `supports` exactly
  once and, only after a `true` result, `requirements` exactly once during Barrier B. False becomes
  `scenario.target_unsupported`. Behavioral conformance remains the adapter author's
  `validatePricer(...)` responsibility, not an expensive per-run probe suite.

## Decision 3 — valuation methods and units

### Full revaluation is primary

For a full-revaluation target the runner resolves the pricer's declared requirements at the base
snapshot, transforms those observations under each scenario, and calls the **same pricer** for base
and scenario values. It never falls back to Taylor and never routes by instrument name.

Every `Pricer` value used here has one additional composition contract:

```text
positionValue = pricerResult.value × quantity × contractMultiplier
```

`pricerResult.value` is therefore a currency amount per valuation unit. The target states that
currency and scaling explicitly. Each first-party adapter documents its valuation unit, and the
result echoes all three coordinates. A custom whole-position pricer uses `quantity: 1` and
`contractMultiplier: 1`; it never relies on an implicit exception.

### Taylor is an explicit approximation

A Taylor target never pretends to be repriced. Its `baseValuePerUnit` has the same economic role as
a full pricer's `value`: current market/liquidation value in the target currency per valuation unit,
not cost basis or P&L since entry. It accepts:

- `baseValuePerUnit`, finite;
- the existing `PositionGreeks` sensitivity fields except its ambiguous internal `value` and `spot`
  coordinates, exposed as a clearly named `TaylorSensitivities` shape; and
- explicit base-factor records `{ subject, level }` for `spot`, `volatility`, `riskFreeRate`, and
  `dividend`, plus `{ level: EpochMs }` for `valuationInstant`.

`TaylorSensitivities` lists the existing raw, per-unit `PositionGreeks` derivatives verbatim and
requires at least one finite field:

```ts
interface TaylorSensitivities {
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  rho?: number;
  vanna?: number;
  vomma?: number;
  charm?: number;
  veta?: number;
  vera?: number;
  deltaRate?: number;
  thetaRate?: number;
  rhoConvexity?: number;
  thetaConvexity?: number;
  epsilon?: number;
}
```

Units are exactly `taylorPnl`'s raw derivatives: volatility/rate/dividend moves are decimals and
time is years. Do not introduce display-scaled vega-per-1%, rho-per-basis-point, or theta-per-day
coordinates at this boundary.

Every meaningful coordinate is required. For example, delta/gamma require `factors.spot`, vega/
vomma require `factors.volatility`, rho/rho-convexity require `factors.riskFreeRate`, theta/time
crosses require `factors.valuationInstant`, epsilon requires `factors.dividend`, and cross-Greeks
require both factors. Extra factor records with no sensitivity or scenario use are rejected rather
than silently ignored.

Taylor factors must describe the same base market as the rest of the run. A supplied
`factors.valuationInstant.level` must equal `market.asOf`. When the market snapshot contains a flat
spot, volatility, rate, or dividend observation for a Taylor factor's subject, its value must equal
the explicit Taylor level exactly; a mismatch is a typed incoherent-base error that tells the caller
to rebuild the Greeks at this snapshot or run it separately. A flat rate or dividend is comparable
only under the continuously-compounded ACT/365F law below. If a matching quote uses another
convention, refuse the Taylor binding instead of comparing unlike numbers. When no such flat
observation exists, the explicit Taylor factor remains authoritative and is preserved on the target
axis. A custom resolver never silently replaces an explicit Taylor base level.

The runner resolves overrides and ordered shocks against those levels, converts the net moves into
the existing risk `Scenario`/`Shock` grammar, and calls `taylorPnl(...)` once per scenario. Scenario
unit value is `baseValuePerUnit + taylorPnl(...).total`. The complete Taylor attribution result is
preserved in the cell. Result rows state `valuationMethod: 'taylor'`; full cells state
`'full-revaluation'`. There is no automatic method switch.

The direct call mapping is exact:

```ts
taylorPnl(
  {
    value: baseValuePerUnit,
    ...(factors.spot !== undefined ? { spot: factors.spot.level } : {}),
    ...sensitivities,
  },
  resolvedScenario,
);
```

`value` is supplied because it is required by the existing `PositionGreeks` contract even though
the attribution kernel does not reinterpret it as P&L; `spot` comes only from the explicit spot
factor. A parity test compiles and compares this direct call field-for-field.

This path also gives existing option strategies a first-party scenario route without a dishonest
strategy pricer. From `const marked = position.value(market)`, compute the current liquidation value
as `marked.perLeg.reduce((sum, leg) => sum + leg.value, 0)`—do **not** use `marked.value`, which that
API intentionally defines as P&L since entry. Pass the liquidation value, `marked.greeks`, and spot
through the existing `rawGreeksFromDisplay(...)`, then bind the returned raw derivatives and explicit
factor levels as one Taylor target with quantity/multiplier 1. This keeps base/scenario value and
cross-target aggregates economically coherent. A future strategy `Pricer` may add exact full
revaluation after its per-leg volatility requirements can be declared faithfully.

## Decision 4 — market requirement resolution

The runner validates and snapshots `scenarioSet` through `readScenarioSet` and `market` through
`readMarketSnapshot`. It projects Gate B market state into Gate C observations with this exact
built-in table:

| `MarketRequirement`           | Built-in source                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `valuationInstant`            | `market.asOf`                                                                                                |
| `spot(symbol)`                | `market.observations.spots[symbol].price`                                                                    |
| `forward(symbol, expiresAt)`  | none; requires one explicit per-call resolver                                                                |
| `impliedVolatility(...)`      | `market.observations.volatilities[symbol]` only (the explicitly flat quote)                                  |
| `riskFreeRate(currency)`      | the matching flat rate only when snapshot conventions are continuous + ACT/365F                              |
| `dividendYield(symbol)`       | the matching flat yield only when snapshot conventions are continuous + ACT/365F                             |
| `discountCurve(curveId, ...)` | `market.observations.curves[curveId]`, with the curve's currency required to equal the descriptor's currency |

Gate C's scalar `riskFreeRate` and `dividendYield` observations are continuously compounded annual
rates, while the snapshot deliberately supports several quote conventions. The runner therefore
uses a flat snapshot quote directly **only** when
`market.conventions.compounding === 'continuous'` and
`market.conventions.dayCount === 'ACT/365F'`. It never relabels annual, periodic, simple, ACT/360,
or 30/360 numbers as Gate C values. There is no honest generic conversion for a simple quote without
a tenor, and choosing a one-year tenor would be hidden economics.

An incompatible matching flat quote makes the built-in source unavailable. A per-call resolver may
return an explicitly normalized Gate C observation; its name/version then records who owned that
conversion. Without one, required observations fail with `pricer.requirement_unsatisfied` and a
minimal correction: provide a continuous ACT/365F snapshot quote or a resolver. The result echoes
both the input snapshot conventions and the resolved scalar-rate convention. Scenario
`riskFreeRate`/`dividend` instructions act on the resolved continuous ACT/365F level, never on an
incompatible raw snapshot quote. The same eligibility rule governs Taylor base-level coherence.

Present-but-incompatible data is never treated as absent. If the snapshot contains the exact flat
rate/dividend subject a target requests under an incompatible convention, exactly one resolver must
normalize it; otherwise preflight refuses even when that `MarketRequirement` is optional. Optional
defaulting is allowed only when the subject is genuinely absent from the snapshot and no resolver
answers. In particular, a supplied nonzero annual/ACT-360 dividend yield can never disappear into an
option pricer's disclosed zero-dividend default.

For a target built by `scenarioTarget.spot` (and therefore bound to `spotAssetPricer()`), a snapshot
spot observation that states a currency must equal the target's valuation currency. Omission means
that target's explicit currency is authoritative; mismatch is never ignored. Other full-revaluation
pricers and Taylor targets may legitimately consume a spot factor while valuing in another currency,
so the runner does not impose this spot-asset identity law on them.

The runner does **not** derive a forward from spot/rates, interpolate a surface, choose a chain row,
or convert a curve. Those require economics not present in the descriptor. An unresolved required
observation is the existing `pricer.requirement_unsatisfied` teaching; an unresolved optional
observation is omitted so the pricer's disclosed default applies.

Custom resolution is per call:

```ts
type ScenarioReadonlyData<T> = T extends object
  ? { readonly [K in keyof T]: ScenarioReadonlyData<T[K]> }
  : T;

type ScenarioReadonlyMarketObservation =
  | {
      readonly requirement: Readonly<ValuationInstantRequirement>;
      readonly value: ObservationValueByKind['valuationInstant'];
    }
  | {
      readonly requirement: Readonly<SpotRequirement>;
      readonly value: ObservationValueByKind['spot'];
    }
  | {
      readonly requirement: Readonly<ForwardRequirement>;
      readonly value: ObservationValueByKind['forward'];
    }
  | {
      readonly requirement: Readonly<ImpliedVolatilityRequirement>;
      readonly value: ObservationValueByKind['impliedVolatility'];
    }
  | {
      readonly requirement: Readonly<RiskFreeRateRequirement>;
      readonly value: ObservationValueByKind['riskFreeRate'];
    }
  | {
      readonly requirement: Readonly<DividendYieldRequirement>;
      readonly value: ObservationValueByKind['dividendYield'];
    }
  | {
      readonly requirement: Readonly<DiscountCurveRequirement>;
      readonly value: ScenarioReadonlyRateCurve;
    };

interface ScenarioMarketResolverInput {
  readonly requirement: ScenarioReadonlyData<MarketRequirement>;
  readonly market: ScenarioReadonlyData<MarketSnapshot>;
  readonly target: ScenarioReadonlyData<ScenarioTargetDescriptor>;
}

interface ScenarioMarketResolver {
  name: string;
  version: string;
  resolve(
    this: undefined,
    input: ScenarioMarketResolverInput,
  ): ScenarioReadonlyMarketObservation | undefined;
}
```

Resolvers run only for a requirement the built-in table cannot satisfy. All supplied resolvers are
asked so ambiguity is detectable: zero answers means missing, one answer is accepted, and two
answers are a typed conflict. A returned observation must carry the exact requested descriptor and
pass the core observation validator. Thenables are rejected; Stage 4.4b is synchronous. Names and
versions are non-empty, unique, and echoed for replay. Resolver definitions are closed objects with
own data properties for identity and one callable `resolve`; accessors/coercion hooks are rejected.
At preflight the runner snapshots those three own descriptors and invokes the snapshotted function
with deeply frozen, detached, behavior-free inputs and `this === undefined`. The exported named
readonly projection makes that guarantee visible to TypeScript and tool walkers without copying or
widening core's underlying union. After every call it verifies the resolver object's name, version,
and callable descriptors are unchanged; self-mutation is a typed request failure. There is no
module-global registration or precedence number.

## Decision 5 — scenario application semantics

The existing `ScenarioSet` remains the one serializable definition. No schema bump is required:
its factor field is already open for named factors. Update its docs to identify the runner's
first-party factors, but do not create a second type.

For every scenario:

1. apply `overrides` first in array order;
2. apply `shocks` afterward in array order;
3. for a percent shock, replace the current level with `current × (1 + value)`;
4. for an absolute shock, replace it with `current + value`; and
5. validate the transformed value after **each** instruction—never clamp or wait for a later shock
   to repair an invalid intermediate state.

An override is an exact level, not a move. Repeated shocks compose. Duplicate overrides for one
factor/target are already refused by `createScenarioSet`/`readScenarioSet`.

### First-party factor and target meanings

| Factor                | Observation/value changed                                    | `target` means                               |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `spot`                | `spot`                                                       | symbol                                       |
| `forward`             | `forward`                                                    | symbol                                       |
| `volatility`          | `impliedVolatility`                                          | symbol                                       |
| `riskFreeRate`        | flat `riskFreeRate`                                          | currency                                     |
| `dividend`            | `dividendYield`                                              | symbol                                       |
| `time`                | `valuationInstant`                                           | forbidden; time is global                    |
| `discountCurve`       | every `zeroRate` pillar of a `discountCurve` observation     | `curveId`                                    |
| `foreignExchangeRate` | `quotePerBase` on a used reporting-currency conversion quote | exact `BASE/QUOTE` orientation of that quote |

An absent target applies to every matching coordinate used by the run. A present target is exact and
case-sensitive. `riskFreeRate` never also moves curves; use `discountCurve` explicitly. A
`discountCurve` override makes every pillar equal the override; an absolute shock is a parallel
zero-rate shift; a percent shock scales each current zero rate. Revalidate the complete core
`RateCurve` after each instruction so an impossible discount factor refuses.

Volatility must remain non-negative. Foreign-exchange quote rates must remain strictly positive.
Rates and dividend yields may be negative when their existing contracts permit it. Spot and forward
retain the requirement's existing finite-value domain; a concrete pricer may impose a stricter
instrument domain and teach at its own boundary.

### Time law

- an absolute `time` shock shifts the valuation instant by signed `value` **ACT/365F years**
  (positive advances, negative rewinds):
  `value × 365 × 86_400_000` milliseconds;
- a percent time shock is rejected;
- a time override is an exact integer epoch-millisecond valuation instant;
- `target` is rejected on either form; and
- the resulting instant must remain inside the core epoch/date range.

The result echoes `timeShockDayCount: 'ACT/365F'` and `millisecondsPerYear: 31_536_000_000`. This
matches the direct `shock.time(years)` convention while removing any ambiguity about how a year
changes an epoch value. No calendar or system clock is consulted.

### Unmatched instructions and custom factors

Every override and shock must match at least one used observation, Taylor factor, used currency
conversion, or custom handler **across the entire run**. Otherwise `runScenarios` throws a typed
`scenario.instruction_unmatched` error naming scenario, phase, index, factor, and target before any
pricer is called. A typo never produces a confident zero-P&L row.

An explicit per-call custom handler may transform observations for one non-reserved factor:

```ts
interface ScenarioFactorHandlerInput {
  readonly instruction: ScenarioReadonlyData<ScenarioShock | ScenarioOverride>;
  readonly observations: readonly ScenarioReadonlyMarketObservation[];
  readonly target: ScenarioReadonlyData<ScenarioTargetDescriptor>;
}

interface ScenarioFactorHandler {
  factor: string;
  name: string;
  version: string;
  apply(
    this: undefined,
    input: ScenarioFactorHandlerInput,
  ): readonly ScenarioReadonlyMarketObservation[] | undefined;
}
```

Only one handler may own a factor. Reserved factors in the table above cannot be overridden. A
handler returning `undefined` did not match that target; a returned list must have exactly the same
requirement identities as its input and pass full observation validation. Custom factors do not
apply to Taylor targets until a future reviewed sensitivity vocabulary names them. Handler identity
and each use are echoed. Handler definitions follow the same closed-own-data-property law as
resolvers, including descriptor snapshot/recheck around every call and `this === undefined`. No
handler may mutate the supplied list: it receives deeply frozen, detached, behavior-free inputs,
and the observation-list canonical hash is rechecked after the call before any returned value is
accepted.

## Decision 6 — currency and aggregation coherence

Every target states its valuation currency. `reportingCurrency` may be omitted only when every
target has the same currency; that currency is inferred and echoed. A multi-currency run requires an
explicit reporting currency and one direct-or-inverted `CurrencyPairQuote` connecting each foreign
target currency to it.

Rules:

- call the existing `convertCurrency(...)` for every non-identity conversion; never copy its
  multiply/divide arithmetic;
- do not triangulate, select a vendor, or use a market-snapshot spot as an FX quote;
- refuse duplicate or ambiguous quotes for a required pair;
- preserve and echo the exact quote and direct/inverted orientation used;
- extra valid quotes are allowed as a reusable caller-supplied set but produce a named
  `diagnostics.unusedCurrencyConversions` entry plus
  `scenario.unused_currency_conversion` warning—they are never silently ignored; and
- `foreignExchangeRate` scenario instructions transform only quotes actually used by at least one
  target. Scenario conversion runs at the transformed quote; base conversion uses the base quote.

Target value and P&L formulas are exact:

```text
basePositionValue       = baseValuePerUnit × quantity × contractMultiplier
scenarioPositionValue   = scenarioValuePerUnit × quantity × contractMultiplier
pnl                     = scenarioPositionValue − basePositionValue
reporting-currency value = convertCurrency(position value)
reporting-currency P&L   = scenario converted value − base converted value
```

Compute reporting-currency P&L from the two converted values, not by converting local P&L at only
one quote; otherwise an FX-only scenario would disappear.

Aggregate in reporting currency only. Produce deterministic rows for:

- each target/position;
- `underlying`;
- `strategy`;
- `account`;
- `book`;
- each tag; and
- grand total.

Missing optional grouping fields simply omit that target from that grouping family, never from the
grand total. Tag groups may overlap and are explicitly labeled non-additive; the grand total is not
derived by summing tags.

Aggregate row order is fixed by family—`target`, `underlying`, `strategy`, `account`, `book`, `tag`,
then `grand-total`—and lexicographic `key` inside a family. Target-row keys are target IDs;
`grand-total.key` is the literal `'all'`. Every `targetIds`/`failedTargetIds` list follows target-axis
order, never object or set insertion order.

## Decision 7 — result grammar

`runScenarios` returns one deeply frozen, canonical-JSON-safe Law-2 analysis report. It is not a
class and has no methods.

The principal exported result types are exact and discriminated. They must ship with these fields
(readonly in declarations), not as unnamed bags or implementation-private aliases:

```ts
type ScenarioValuationMethod = 'full-revaluation' | 'taylor';

interface ScenarioAxisRow {
  readonly scenarioIndex: number;
  readonly name: string;
  readonly scenarioHash: string;
  readonly overrideCount: number;
  readonly shockCount: number;
}

type ScenarioTargetAxisRow = ScenarioTargetDescriptor & {
  readonly targetIndex: number;
};

interface ScenarioBehaviorIdentity {
  readonly name: string;
  readonly version: string;
}

interface ScenarioCurrencyConversionUse {
  readonly sourceQuoteIndex: number;
  readonly orientation: 'direct' | 'inverted';
  readonly quote: Readonly<CurrencyPairQuote>;
}

interface ScenarioAppliedInstructionBase {
  readonly phase: 'override' | 'shock';
  readonly instructionIndex: number;
  readonly factor: string;
  readonly target?: string;
  readonly subject: string;
}

interface ScenarioAppliedScalarInstruction extends ScenarioAppliedInstructionBase {
  readonly detail: 'scalar' | 'foreign-exchange-rate';
  readonly before: number;
  readonly after: number;
}

interface ScenarioAppliedCurveInstruction extends ScenarioAppliedInstructionBase {
  readonly detail: 'discount-curve';
  readonly pillarCount: number;
  readonly beforeCurveHash: string;
  readonly afterCurveHash: string;
}

interface ScenarioAppliedCustomInstruction extends ScenarioAppliedInstructionBase {
  readonly detail: 'custom';
  readonly handler: ScenarioBehaviorIdentity;
  readonly beforeObservationsHash: string;
  readonly afterObservationsHash: string;
}

type ScenarioAppliedInstruction =
  | ScenarioAppliedScalarInstruction
  | ScenarioAppliedCurveInstruction
  | ScenarioAppliedCustomInstruction;

type ScenarioPricingResult = Readonly<Record<string, unknown>> & {
  readonly value: number;
  readonly assumptions: Readonly<Record<string, unknown>>;
  readonly diagnostics: Readonly<Diagnostics> & {
    readonly warnings: readonly QuantWarning[];
  };
};

interface ScenarioSuccessfulValueFields {
  readonly targetIndex: number;
  readonly targetId: string;
  readonly quantity: number;
  readonly contractMultiplier: number;
  readonly valuationCurrency: string;
  readonly reportingCurrency: string;
  readonly valuePerUnit: number;
  readonly positionValue: number;
  readonly reportingPositionValue: number;
  readonly currencyConversion: ScenarioCurrencyConversionUse | null;
  readonly observationOrFactorSetHash: string;
  readonly appliedInstructions: readonly ScenarioAppliedInstruction[];
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
  readonly effectiveSeed: number | null;
}

type ScenarioFullRevaluationValue = ScenarioSuccessfulValueFields & {
  readonly valuationMethod: 'full-revaluation';
  readonly pricer: ScenarioPricerDescriptor;
  readonly pricingResult: ScenarioPricingResult;
};

type ScenarioTaylorValue = ScenarioSuccessfulValueFields & {
  readonly valuationMethod: 'taylor';
  readonly taylorResult: Readonly<TaylorPnlResult>;
};

interface ScenarioExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly contextStatus: 'absent' | 'preserved' | 'omitted-unsafe';
  readonly targetIndex: number;
  readonly targetId: string;
  readonly scenarioIndex: number | null;
  readonly scenarioName: string | null;
  readonly valuationMethod: ScenarioValuationMethod;
}

type ScenarioBaseCell =
  | (ScenarioFullRevaluationValue & {
      readonly kind: 'base';
      readonly status: 'complete';
    })
  | (ScenarioSuccessfulValueFields & {
      readonly kind: 'base';
      readonly status: 'complete';
      readonly valuationMethod: 'taylor';
      readonly baseValueSource: 'supplied-base-value-per-unit';
    })
  | {
      readonly kind: 'base';
      readonly status: 'failed';
      readonly targetIndex: number;
      readonly targetId: string;
      readonly valuationMethod: ScenarioValuationMethod;
      readonly valuePerUnit: null;
      readonly positionValue: null;
      readonly reportingPositionValue: null;
      readonly failure: ScenarioExecutionFailure;
    };

type ScenarioCell =
  | ((ScenarioFullRevaluationValue | ScenarioTaylorValue) & {
      readonly kind: 'scenario';
      readonly status: 'complete';
      readonly scenarioIndex: number;
      readonly scenarioName: string;
      readonly localPnl: number;
      readonly reportingPnl: number;
    })
  | {
      readonly kind: 'scenario';
      readonly status: 'failed';
      readonly targetIndex: number;
      readonly targetId: string;
      readonly scenarioIndex: number;
      readonly scenarioName: string;
      readonly valuationMethod: ScenarioValuationMethod;
      readonly valuePerUnit: null;
      readonly positionValue: null;
      readonly reportingPositionValue: null;
      readonly localPnl: null;
      readonly reportingPnl: null;
      readonly failure: ScenarioExecutionFailure;
    }
  | {
      readonly kind: 'scenario';
      readonly status: 'blocked';
      readonly targetIndex: number;
      readonly targetId: string;
      readonly scenarioIndex: number;
      readonly scenarioName: string;
      readonly valuationMethod: ScenarioValuationMethod;
      readonly valuePerUnit: null;
      readonly positionValue: null;
      readonly reportingPositionValue: null;
      readonly localPnl: null;
      readonly reportingPnl: null;
      readonly blockedByBaseFailure: ScenarioExecutionFailure;
    };

interface ScenarioAggregateRow {
  readonly group: 'target' | 'underlying' | 'strategy' | 'account' | 'book' | 'tag' | 'grand-total';
  readonly key: string;
  readonly reportingCurrency: string;
  readonly status: 'complete' | 'incomplete';
  readonly baseValue: number | null;
  readonly scenarioValue: number | null;
  readonly pnl: number | null;
  readonly targetIds: readonly string[];
  readonly failedTargetIds: readonly string[];
  readonly reason?: string;
}

interface ScenarioBaseAggregateSet {
  readonly kind: 'base';
  readonly scenarioIndex: null;
  readonly scenarioName: null;
  readonly rows: readonly ScenarioAggregateRow[];
}

interface ScenarioOutcomeAggregateSet {
  readonly kind: 'scenario';
  readonly scenarioIndex: number;
  readonly scenarioName: string;
  readonly rows: readonly ScenarioAggregateRow[];
}

interface ScenarioReplayParameters {
  readonly reportingCurrency: string;
  readonly currencyConversions: readonly Readonly<CurrencyPairQuote>[];
  readonly failureMode: 'fail-fast' | 'collect';
  readonly seed: number | null;
  readonly maximumValuationCells: number;
  readonly maximumWorkUnits: number;
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
  readonly timeShockDayCount: 'ACT/365F';
  readonly millisecondsPerYear: 31_536_000_000;
  readonly resultLayout: 'scenario-major-v1';
}

interface ScenarioRunAssumptions {
  readonly conventionsVersion: string;
  readonly scenarioSetName: string;
  readonly scenarioSetHash: string;
  readonly marketSnapshotHash: string;
  readonly marketAsOf: EpochMs;
  readonly inputRateDayCount: DayCount | null;
  readonly inputRateCompounding: InterestCompounding | null;
  readonly resolvedScalarRateDayCount: 'ACT/365F';
  readonly resolvedScalarRateCompounding: 'continuous';
  readonly reportingCurrency: string;
  readonly currencyConversionPolicy: 'direct-or-inverse-only';
  readonly valuationUnitScaling: 'valuePerUnit * quantity * contractMultiplier';
  readonly timeShockDayCount: 'ACT/365F';
  readonly millisecondsPerYear: 31_536_000_000;
  readonly failureMode: 'fail-fast' | 'collect';
  readonly baseSeed: number | null;
  readonly seedDerivation: 'seed + targetIndex; common across base and scenarios' | null;
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
  readonly resultLayout: 'scenario-major-v1';
  readonly workBudgets: {
    readonly valuationCells: {
      readonly configured: number;
      readonly default: 10_000;
      readonly hardMaximum: 50_000;
    };
    readonly workUnits: {
      readonly configured: number;
      readonly default: 20_000_000;
      readonly hardMaximum: 100_000_000;
    };
  };
  readonly replayParameters: ScenarioReplayParameters;
}

interface ScenarioMetric {
  readonly estimated: number;
  readonly actual: number | null;
  readonly unavailableReason: string | null;
}

interface ScenarioRunMetrics {
  readonly valuationCells: ScenarioMetric;
  readonly pricerCalls: ScenarioMetric;
  readonly taylorCalls: ScenarioMetric;
  readonly supportsCalls: ScenarioMetric;
  readonly requirements: ScenarioMetric;
  readonly resolverCalls: ScenarioMetric;
  readonly factorHandlerCalls: ScenarioMetric;
  readonly inputDataWorkUnits: ScenarioMetric;
  readonly transformationWorkUnits: ScenarioMetric;
  readonly valuationResultWorkUnits: ScenarioMetric;
  readonly resultEnvelopeWorkUnits: ScenarioMetric;
  readonly failureSnapshotWorkUnits: ScenarioMetric;
  readonly totalWorkUnits: ScenarioMetric;
  readonly successfulCells: ScenarioMetric;
  readonly failedCells: ScenarioMetric;
  readonly blockedCells: ScenarioMetric;
}

interface ScenarioRunDiagnostics {
  readonly warnings: readonly QuantWarning[];
  readonly failures: readonly ScenarioExecutionFailure[];
  readonly unusedCurrencyConversions: readonly Readonly<CurrencyPairQuote>[];
  readonly metrics: ScenarioRunMetrics;
}

interface ScenarioResultLayout {
  readonly order: 'scenario-major-v1';
  readonly targetCount: number;
  readonly scenarioCount: number;
  readonly cellsPerScenario: number;
  readonly cellCount: number;
  readonly indexFormula: 'scenarioIndex * targetCount + targetIndex';
}

type ScenarioRunResult = Readonly<Record<string, unknown>> & {
  readonly layout: ScenarioResultLayout;
  readonly scenarioAxis: readonly ScenarioAxisRow[];
  readonly targetAxis: readonly ScenarioTargetAxisRow[];
  readonly base: readonly ScenarioBaseCell[];
  readonly cells: readonly ScenarioCell[];
  readonly aggregates: {
    readonly base: ScenarioBaseAggregateSet;
    readonly scenarios: readonly ScenarioOutcomeAggregateSet[];
  };
  readonly assumptions: ScenarioRunAssumptions;
  readonly diagnostics: ScenarioRunDiagnostics;
};
```

The `Readonly<Record<string, unknown>>` intersection is deliberate: it makes the returned value
directly assignable to Gate B's existing `createAnalysisArtifact({ result })` parameter without a
cast or spread, while the intersection's named fields preserve full IntelliSense. A compile fixture
must prove the artifact example below and exhaustively narrow every cell/status/method union. Every
named type in this grammar is exported from `@totalfinance/scenarios`.

Axes are stable in caller order. `cells` is flat scenario-major row order:

```text
cells[scenarioIndex × targetCount + targetIndex]
```

The formula and counts are echoed so a detached table is self-describing.
`base.length === targetCount`, `cellsPerScenario === targetCount`, and
`cellCount === cells.length === targetCount * scenarioCount` are construction postconditions.

Each target-axis row records index, ID, signed quantity, multiplier, currency, grouping metadata,
valuation method, canonical instrument/factor descriptor and its content hash, and—when applicable—
pricer name/version/capabilities. It never stores executable functions.

Each successful base/cell row records:

- `valuePerUnit`, `positionValue`, and reporting-currency position value;
- for scenario cells, local and reporting-currency `pnl`;
- valuation currency and reporting currency;
- method (`full-revaluation` or `taylor`), quantity, and multiplier;
- full-revaluation's complete original `PricerValuationResult` (including every richer domain
  field); each Taylor scenario cell's complete `TaylorPnlResult` attribution; and the Taylor base row's explicit
  `baseValueSource: 'supplied-base-value-per-unit'` (no fabricated zero-shock attribution call);
- the canonical content hash of the exact observation/factor set used;
- every applied instruction with phase/index, factor, subject, and resolved before/after identity;
- pricer and resolver/handler identity used; and
- the effective per-target seed when applicable.

Resolved instruction detail is compact but lossless for identity: scalar and FX instructions record
finite `before`/`after` numbers; discount-curve instructions record pillar count plus canonical
before/after curve hashes; custom handlers record before/after observation-list hashes. Do not copy a
whole curve or observation list into every cell. The saved market/scenario inputs plus these hashes
make replay verifiable without turning one shared curve into thousands of duplicate result rows.

Every aggregate row uses the one `ScenarioAggregateRow` shape above.

Base aggregate rows set `scenarioValue = baseValue` and `pnl = 0`; scenario aggregate rows carry the
actual comparison. A complete row has finite numbers and no failure IDs/reason. An incomplete row has
all three numbers `null`, at least one failed target ID, and a reason.

Do not discard a direct pricer's assumptions, diagnostics, selection report, provenance, or extra
domain result fields to make a smaller cell. If a future measured workload needs a summary/table
mode, it receives a separate reviewed contract and Gate B `TableHandle`; Stage 4.4b has one truthful
result mode.

Assumptions include at minimum:

- conventions version;
- scenario-set name and content hash;
- market-snapshot content hash and `asOf`;
- reporting currency and conversion policy;
- valuation-unit scaling law;
- time-shock basis;
- failure mode;
- base seed and seed derivation, when used;
- resolver and custom-handler names/versions;
- row-major indexing law; and
- configured/default/hard work budgets.

`assumptions.replayParameters` is the canonical JSON-safe subset a rerun needs: reporting currency,
base currency-conversion quotes, failure mode, seed, configured limits, resolver identities, handler
identities, time basis, and `resultLayout: 'scenario-major-v1'`. It contains no functions and
duplicates no market, scenario, or target payload already named by hash/axis.

Diagnostics include warnings, collected failures, unused conversion quotes, and estimated/actual
counts for valuation cells, pricer calls, Taylor calls, requirements, resolver calls, transformation
work, and successful/failed cells. Every successful numeric leaf is finite. Undefined metrics are
`null` with a reason, never `NaN` or an omitted ambiguity.

## Decision 8 — failure behavior

`options.failureMode` is `'fail-fast' | 'collect'`, default `'fail-fast'`.

Malformed requests always throw before pricing, in either mode: unknown keys, missing observations,
duplicate IDs, unsupported instruments, unresolved/ambiguous resolvers, incoherent currency,
unmatched instructions, unsafe work, malformed scenario transforms, and non-serializable target
descriptors are request defects, not scenario outcomes.

Error objects are behavior, not artifact payloads. Both modes use one internal
`snapshotScenarioFailure` law that reads only own data descriptors—never a getter, `toJSON`,
`toString`, coercion hook, prototype field, or arbitrary enumerable member:

- an own non-empty string `code` of at most 128 UTF-16 code units on a real `QuantError` is
  preserved; otherwise the code is `scenario.cell_failed`;
- an own string `message` of at most 4,096 UTF-16 code units on an `Error` is preserved; an
  oversized message uses a fixed size-limit message, and any other unsafe/missing message uses the fixed
  `'Scenario cell execution failed without a safe error message.'`;
- an absent own `context` becomes `context: null, contextStatus: 'absent'`;
- an own data `context` is preserved only when the Barrier-A descriptor scanner proves it is an
  acyclic plain record within 32 levels and 256 data-work units and `canonicalJsonOf` accepts it,
  with no enumerable `undefined` member that detachment would erase, then detached through
  `fromCanonicalJson`; otherwise it becomes
  `context: null, contextStatus: 'omitted-unsafe'`; and
- target/scenario coordinates and valuation method come from runner state, never from the thrown
  object.

The resulting `ScenarioExecutionFailure` is validated again, deeply frozen, and is the **only**
failure form stored in a result. It never carries `cause`, stack, name, class instances, accessors,
functions, symbols, or the thrown value itself.

In `fail-fast`, the runner throws a new `QuantError` whose code is the snapshotted original code,
whose safe context contains the runner coordinates plus the snapshotted context/status, and whose
`cause` is the original thrown value. Thus a real `QuantError` keeps its stable code and its exact
original class/cause chain remains inspectable at `error.cause`, without mutating it or serializing
unsafe context. For an unknown thrown value the wrapper code is `scenario.cell_failed`. A raw
`TypeError` or thrown primitive never escapes without coordinates.

`collect` stores the same behavior-free snapshot for per-base/per-scenario execution failures. It
does not capture request defects.
Rules against plausible partial answers:

- if a target's base valuation fails, its scenario cells are marked blocked by that base failure and
  are not priced;
- a failed scenario cell has all value/P&L fields `null` with the failure beside them;
- any aggregate containing a failed constituent has
  `{ status: 'incomplete', baseValue: null, scenarioValue: null, pnl: null, failedTargetIds, reason }`;
- unaffected groups remain complete; and
- grand total is incomplete if any target in that scenario failed.

Never sum only the successful subset into a plausible-looking total.

Register `scenario.instruction_unmatched`, `scenario.target_unsupported`, and
`scenario.cell_failed` in the one core error-code registry with code-conformance tests. Reuse
existing `input.*`, `pricer.*`, serialization, and postcondition codes everywhere they already state
the failure accurately.
Register `scenario.unused_currency_conversion` in the one warning-code registry in the same change.

## Decision 9 — seeds and deterministic execution

If any target pricer declares `randomness: 'seeded'`, `options.seed` is required and must be a safe
integer **greater than or equal to zero**, exactly matching `PricerValuationRequest.seed`. Target `i`
uses `seed + i`, matching the Gate C batch derivation law. Preflight refuses a negative seed and
`seed + targets.length - 1` outside the non-negative safe-integer range before any pricer behavior
is invoked.

Use **common random numbers** for scenario differences: one target receives the same derived target
seed for its base valuation and every scenario valuation. This isolates the scenario move from a new
random draw. Deterministic (`randomness: 'none'`) pricers receive no seed; supplying a run seed is
still allowed for a mixed book and is simply irrelevant to those targets, as their protocol law
requires.

Execution order is deterministic:

1. targets in caller order for base;
2. scenarios in caller order; and
3. targets in caller order within each scenario.

Stage 4.4b uses the scalar `price` path. Do not claim batching merely because a lower package has a
columnar kernel: Gate C batch parity requires one coherent observation set and exact per-item seed
semantics, while option-chain batches do not yet represent per-contract volatility requirements.
A measured later acceleration may add a verified batch plan without changing this result contract.

## Decision 10 — bounded synchronous work

The runner is synchronous and returns its full result, so it must refuse unsafe work before
allocation or pricing.

Public option defaults and fixed protocol limits:

| Limit                    | Default      | Hard maximum  | Meaning                                                                |
| ------------------------ | ------------ | ------------- | ---------------------------------------------------------------------- |
| `maximumValuationCells`  | `10_000`     | `50_000`      | `targets × (scenarios + 1)` output valuation cells                     |
| `maximumWorkUnits`       | `20_000_000` | `100_000_000` | conservative full-input, transform, callback, and retained-result work |
| requirements per target  | n/a          | `256`         | maximum descriptors one pricer may return for one instrument           |
| market resolvers per run | n/a          | `32`          | prevents an unresolved requirement from dispatching an unbounded panel |
| factor handlers per run  | n/a          | `32`          | one owner per custom factor, with a bounded behavior panel             |
| currency quotes per run  | n/a          | `256`         | validates a useful reusable quote set without an unbounded pair scan   |
| resolver curve pillars   | n/a          | `4_096`       | maximum pillars in one resolver-returned discount-curve observation    |
| valuation result work    | n/a          | `1_024`       | maximum canonical-data work preserved from one pricer/Taylor result    |

`maximumValuationCells` and `maximumWorkUnits` may lower the defaults or opt up to their hard maxima;
they must be positive safe integers. The runner computes with checked products/sums.

Failure snapshots, result envelopes, applied-instruction details, aggregate rows, result axes, and
top-level metadata deliberately have no guessed fixed row constant. Barrier B scans the exact closed
shape it may retain, including real target/scenario identifier lengths and behavior identities, and
reserves the larger legal success/failure branch where applicable. A preserved failure context is
still bounded to 256 canonical-data work units and 32 levels; a retained code is capped at 128 UTF-16
code units and a retained message at 4,096. Resolver-returned curves remain capped at 4,096 pillars.

Work enforcement has two explicit barriers. It does not claim that a library can prevent arbitrary
code inside a caller's `supports`/`requirements`/resolver/handler callback from doing expensive
work; it bounds every traversal, allocation, dispatch, and pricing call that the runner itself
controls.

### Barrier A — bounded stored-data preflight, before behavior

First validate the outer request/options with own-property descriptors and read the raw array
lengths without invoking accessors. Compute `valuationCells` and enforce its configured/hard limit.
Before calling `readScenarioSet`, `readMarketSnapshot`, a pricer, resolver, or handler, run a
stop-at-limit canonical-data scanner over the **complete** scenario-set envelope, market-snapshot
envelope (including unused surfaces/chains/provenance), currency quotes, public target descriptors
(including instrument/Taylor descriptors), and stored option/behavior identities. It excludes only
the recognized private target binding and the resolver/handler function values themselves.

The scanner is iterative (no caller-controlled recursion), tracks object identity, and refuses
cycles, nesting deeper than 64 containers, custom prototypes, sparse arrays, symbols, hidden
members, accessors, functions in data, and coercion hooks. It reads own data descriptors only under
the same canonical-data law. Its deterministic cost is:

```text
primitiveDataCost(null | boolean | number) = 1
stringDataCost(value) = 1 + ceil(value.length / 64)
arrayDataCost(value) = 1 + value.length + sum(elementDataCost)
objectDataCost(value) = 1
  + ownKeyCount * ceil(log2(ownKeyCount + 1))
  + sum(stringDataCost(key) + memberDataCost)
inputDataWorkUnits = 6 * sum(complete public input data cost)
```

The factor of six reserves the runner-controlled full walks for bounded preflight, Gate B
validation/restoration, detachment/freezing, and canonical hashing. Stop as soon as the configured
budget would be exceeded; never clone or hash the oversized value first. Thus a huge unused option
chain or vendor-decorated surface is charged, not treated as free because no pricer requested it.

Only after Barrier A passes may the runner call `readScenarioSet` and `readMarketSnapshot`. Those
reader costs are already reserved in `inputDataWorkUnits`. Seed domain/overflow, duplicate IDs,
target binding integrity, behavior-panel counts, quote counts, and static instruction rules are also
settled here before any pricer behavior. Barrier A also reserves one work unit for each known
full-revaluation `supports` dispatch and refuses if even those fixed calls cannot fit.

### Barrier B — exact execution plan, before resolution/transformation/pricing

For each full-revaluation target in caller order, call `pricer.supports(instrument)` exactly once.
Only a literal `true` proceeds; `false` becomes `scenario.target_unsupported`, and a throw or
non-boolean result is a Gate C preflight/request failure in both failure modes. Then call that
pricer's `requirements(instrument)` exactly once and snapshot its return. These are the only pricer
behaviors allowed between the barriers, in this required `supports`-then-`requirements` order. Walk
the returned dense list incrementally, refuse more than 256 entries before reading entry 257,
validate every descriptor, and charge its canonical-data cost. A throw or malformed requirement
list is likewise a preflight/request failure in both failure modes.

Then compute the conservative complete execution estimate:

```text
valuationCells = targetCount * (scenarioCount + 1)
supportsDispatches = fullRevaluationTargetCount
requirementsDispatches = fullRevaluationTargetCount
coordinates(target) = scalar requirements + curve objects + curve pillars
                    + Taylor factor coordinates + used FX quote coordinates
resolverDispatches = unresolvedRequirements * resolverCount
handlerDispatches = fullRevaluationTargetCount * customInstructionCount
aggregateMemberships = sum(1 target + 1 grand total + present grouping fields + tag count per target)
instructionApplications = targetCount * sum(over every scenario, overrideCount + shockCount)

failureSnapshotReserve = exact maximum legal retained failures for the selected failure mode,
  using each target/scenario's real coordinates; collect reserves the larger of base-failure-plus-
  blocked-scenarios or independently failing scenarios, while fail-fast reserves one largest failure
valuationResultReserve = valuationCells * 1024
resultEnvelopeReserve = exact canonical work for every possible success/failed cell envelope,
  including behavior identities, using the larger legal branch per cell
instructionDetailReserve = exact canonical work for every matched scalar, curve, FX, or custom row
aggregateResultReserve = exact estimateScenarioAggregateWork(...) output shape
axisReserve = exact canonical work for the complete target and scenario axes
resultMetadataReserve = inputDataWorkUnits
callbackReturnDataReserve = exact per-requirement resolver panel reserves
  + exact same-shape handler return reserves
transformationReserve = base coordinate total
  + sum over scenarios and targets(coordinates(target) * (2 + overrideCount + shockCount))
  + aggregateMemberships * (scenarioCount + 1)
  + callbackReturnDataReserve

workUnits = inputDataWorkUnits
          + requirementDescriptorWork
          + valuationCells
          + supportsDispatches
          + requirementsDispatches
          + resolverDispatches
          + handlerDispatches
          + failureSnapshotReserve
          + valuationResultReserve
          + resultEnvelopeReserve
          + instructionDetailReserve
          + aggregateResultReserve
          + axisReserve
          + resultMetadataReserve
          + transformationReserve
```

A scalar/factor/quote is one coordinate; a curve object is one plus one per pillar. Known snapshot
curves use their exact count. Each unresolved discount-curve requirement reserves 4,097 coordinates
(one curve + the 4,096-pillar hard maximum) before any resolver runs; other unresolved requirements
reserve one. Checked products/sums refuse overflow.

The callback return limit for one requirement is
`64 + 4 * requirementDescriptorWork + 128 * reservedCoordinates`; the resolver reserve multiplies
that exact limit by the resolver panel only for unavailable requirements, while a handler reserves
the complete same-shape observation list for every custom instruction it may receive.

Only after Barrier B passes may resolvers and handlers run. Validate their returned values with a
stop-at-reserved-cost walk before cloning/hashing them. A resolver-returned curve may not exceed
4,096 pillars. A custom handler must return the same observation identities, observation count,
and per-curve pillar counts as its input, so it cannot expand work beyond the estimate. All
instruction matching and transformed-domain validation complete before the first `price`/`taylorPnl`
call and before the flat result grid is allocated. Callback invocation counts and actual returned
coordinate costs are charged to a live counter; exceeding the reservation is a request failure,
never a partial result.

Every returned `PricerValuationResult`/`TaylorPnlResult` is likewise scanned before detachment,
hashing, or grid insertion and may consume at most its reserved 1,024 data-work units. First-party adapter fixtures must
prove their richest result is below that bound. An oversized third-party result is a cell execution
failure with code `scenario.cell_failed` in the selected failure mode; the runner
never truncates fields or silently drops diagnostics. Large tabular payloads belong behind Gate B's
existing `TableHandle`, not duplicated into every scenario cell. The external callback may already
have allocated its return—untrusted callback internals cannot be bounded—but all runner-owned work
and retention remain within the preflight reservation.

That scan uses the same iterative own-data/cycle/depth rules as Barrier A. The runner then enforces
Gate C's result floor (`value` is an own finite number, assumptions are present, and
`diagnostics.warnings` is an array), proves the complete payload with `canonicalJsonOf`, detaches it
through `fromCanonicalJson`, and deeply freezes only that behavior-free copy. Accessors, class
instances, functions, symbols, cycles, unsupported values, non-finite successful numbers, and
enumerable `undefined` members (which canonical JSON would otherwise omit), and post-detachment
drift are wrapped at this boundary in a `scenario.cell_failed` `QuantError` with
`stage: 'result-validation'` and the underlying validation error as cause. None is read, invoked,
or stored. The original returned object is never mutated or retained. This boundary wrapper is
created before Decision 8 snapshots the failure, so its stable code/classification is identical in
collect and fail-fast modes.

Errors name requested/default/hard values and show how to split the run. Diagnostics report Barrier
A cost, Barrier B estimate, callback dispatches, and actual controlled work. Async/chunked jobs
belong to later worker/workflow layers.

## Decision 11 — first-party adapters and honest support matrix

A generic protocol with only fake test pricers is not a usable feature. Stage 4.4b ships and proves
this matrix:

| Path                   | Public adapter/API                                                 | Required proof                                                                                   |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Spot asset             | `spotAssetPricer()` in `@totalfinance/scenarios`                   | requires one spot; result equals the observation exactly; multiplier remains target-owned        |
| Option contract        | existing `optionContractPricer()`                                  | runner result preserves direct `option.price` field-for-field with equal canonical bytes         |
| Discount-curve bond    | new `bondDiscountCurvePricer(...)`                                 | delegates to existing curve construction + `priceMultiCurve`; curve/time parity, no new math     |
| Greeks approximation   | `scenarioTarget.taylor(...)`                                       | complete attribution equals direct `taylorPnl`, field-for-field                                  |
| Durable portfolio      | `scenarioPortfolioBinding.*` + `scenarioTargetsFromPortfolio(...)` | target quantities/multipliers/currencies/grouping equal FC7 state and aggregate totals reconcile |
| Third-party instrument | any conformant `Pricer<T>` + optional resolver/handler             | one public conformance fixture proves no registry or TotalFinance patch is needed                |

`bondDiscountCurvePricer` lives in `@totalfinance/fixed-income/pricer` and takes one closed factory
object:

```ts
bondDiscountCurvePricer({
  curveId: 'USD.treasury',
  currency: 'USD',
  priceType: 'dirty', // required: 'clean' | 'dirty'
  interpolation: 'logLinearDiscount',
  extrapolation: 'flatForward',
});
```

It declares `valuationInstant` plus the `discountCurve(curveId, currency)` it consumes. Clean/dirty
basis, interpolation, and extrapolation are required factory economics and are echoed in every
result; settlement is scenario market state, not a factory constant. The adapter projects each
resolved epoch to the UTC calendar date containing it with the exact recipe
`new Date(valuationInstant).toISOString().slice(0, 10)` and passes that date as
`priceMultiCurve`'s `settlementDate`. Every result echoes the epoch, projected date, and
`settlementDateProjection: 'UTC calendar date containing valuationInstant'`. The direct API is
date-granular, so a sub-day time shock that stays inside one UTC date intentionally leaves this bond
mark unchanged and remains auditable rather than being represented as continuous-time bond decay.

If the stored `RateCurve` also names an interpolation, it must equal the factory choice. The adapter
converts core's plain `RateCurve` into fixed-income's existing curve object with the same as-of date,
pillar dates, zero rates, day count, compounding, and explicit policies, then calls
`priceMultiCurve`. Because the curve builder has a date-valued reference point, the adapter requires
`RateCurve.asOf` to be UTC midnight and uses that exact `YYYY-MM-DD`; it never silently changes the
curve's own reference date. A global `time` scenario changes the valuation/settlement date while
leaving the supplied curve anchored at its stated `asOf`, which is an explicit roll-down/carry
scenario over that curve.

`supports` is true only for fixed-rate, zero-coupon, and fixed amortizing bonds. Floating-rate and
inflation-linked bonds need forecast/index observations the current Gate C vocabulary does not
declare and are rejected honestly. The adapter's numeric `value` is the clean/dirty price of one
constructed bond at that bond's declared `faceValue`; target quantity counts those units and the
usual multiplier is 1. The result also preserves both clean and dirty prices, accrued interest,
assumptions, and diagnostics. Capabilities are `greeks: 'none'`, `randomness: 'none'`,
`batch: false`.

Do **not** ship a first-party strategy full-revaluation adapter in this slice. The current
`Position.value()` is P&L rather than a currency-per-unit asset value, and its position-level versus
per-leg volatility contract cannot yet be represented honestly by one declared IV requirement.
Taylor binding is truthful now; a future adapter must first settle those semantics. Do not disguise
the gap with a broad `custom` result or undeclared reads.

## Decision 12 — durable portfolio adapter

`scenarioTargetsFromPortfolio` is pure and accepts:

```ts
scenarioTargetsFromPortfolio({
  state,
  bindings: [
    scenarioPortfolioBinding.fullRevaluation({
      id: 'retirement:AAPL',
      accountId: 'retirement',
      instrumentId: 'AAPL',
      instrument: { symbol: 'AAPL' },
      instrumentDescriptor: { kind: 'spot-asset', symbol: 'AAPL' },
      pricer: spotAssetPricer(),
      strategy: 'core-equity',
      book: 'household',
      tags: ['long-term'],
    }),
  ],
});
```

The same heterogeneous-generic problem solved by `scenarioTarget.fullRevaluation` exists here, so a
raw object union is not accepted. `scenarioPortfolioBinding` has exactly two opaque builders and
captures each instrument/pricer pair in its own generic call:

```ts
interface ScenarioPortfolioBindingBaseInput {
  id: string;
  accountId: string;
  instrumentId: string;
  strategy?: string;
  book?: string;
  tags?: readonly string[];
}

interface FullRevaluationScenarioPortfolioBindingInput<
  TInstrument,
> extends ScenarioPortfolioBindingBaseInput {
  instrument: TInstrument;
  instrumentDescriptor?: unknown;
  pricer: Pricer<NoInfer<TInstrument>, PricerValuationResult>;
}

interface TaylorScenarioPortfolioBindingInput extends ScenarioPortfolioBindingBaseInput {
  baseValuePerUnit: number;
  greeks: TaylorSensitivities;
  factors: TaylorFactors;
}

interface ScenarioPortfolioBindingDescriptorBase {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly strategy?: string;
  readonly book?: string;
  readonly tags: readonly string[];
  readonly bindingDescriptorHash: string;
}

interface FullRevaluationScenarioPortfolioBindingDescriptor extends ScenarioPortfolioBindingDescriptorBase {
  readonly valuationMethod: 'full-revaluation';
  readonly instrumentDescriptor: unknown;
  readonly instrumentDescriptorHash: string;
  readonly pricer: ScenarioPricerDescriptor;
}

interface TaylorScenarioPortfolioBindingDescriptor extends ScenarioPortfolioBindingDescriptorBase {
  readonly valuationMethod: 'taylor';
  readonly taylor: {
    readonly baseValuePerUnit: number;
    readonly sensitivities: Readonly<TaylorSensitivities>;
    readonly factors: TaylorFactors;
  };
  readonly taylorDescriptorHash: string;
}

type ScenarioPortfolioBindingDescriptor =
  | FullRevaluationScenarioPortfolioBindingDescriptor
  | TaylorScenarioPortfolioBindingDescriptor;

declare const scenarioPortfolioBindingBrand: unique symbol;
type ScenarioPortfolioBinding = ScenarioPortfolioBindingDescriptor & {
  readonly [scenarioPortfolioBindingBrand]: true;
};

interface ScenarioTargetsFromPortfolioInput {
  state: PortfolioState;
  bindings: readonly ScenarioPortfolioBinding[];
}
```

The declaration-private brand and separate full-revaluation behavior binding use the same two-symbol
storage/freeze law as `ScenarioTarget`. Both builders validate and hash their public stored data but
call no pricer behavior. `NoInfer` and negative compile fixtures enforce each instrument/pricer
pair before it enters the heterogeneous array. Every type above is exported except the brand
constant. The binding deliberately omits target quantity, multiplier, currency, account grouping,
and underlying because the ledger owns those facts. In particular:

- `bindings` is an array, never an identifier-keyed object; hostile keys stay data and duplicates
  are detectable;
- each open `(accountId, instrumentId)` position has exactly one binding;
- duplicate, unknown, and missing bindings are typed failures;
- target `quantity`, `contractMultiplier`, and `currency` always come from `PortfolioState` and
  cannot be overridden by a binding;
- account comes from the state key; underlying is
  `position.contract?.underlyingInstrumentId ?? instrumentId`;
- binding supplies unique target ID, valuation behavior/descriptor, and optional strategy/book/tags;
- state is validated and detached through FC7's existing public empty fold
  `applyPortfolioEvents({ previousState: state, events: [] })` before any nested key is read; and
- output order is account key then instrument key, each lexicographically sorted, independent of
  object insertion order.

`requirePortfolioStateShape` remains package-internal and must not be imported through a source path
or newly exported merely for this adapter. The empty fold is the curated public validation door: it
deeply validates the complete state and returns the detached canonical snapshot from which the
adapter derives targets. The adapter never reads the caller's original state after that call.

The adapter never imports risk into portfolio or portfolio into risk; it lives in scenarios above
both. It neither marks nor mutates the ledger.

## Decision 13 — artifact save and replay

The complete result is directly saveable through the existing spine:

```ts
const artifact = createAnalysisArtifact({
  artifactType: 'scenarios.run',
  producedBy: { operation: 'runScenarios' },
  inputs: {
    snapshotHash: result.assumptions.marketSnapshotHash,
    parameters: {
      scenarioSetHash: result.assumptions.scenarioSetHash,
      targets: result.targetAxis,
      run: result.assumptions.replayParameters,
    },
  },
  result,
});
```

Do not add `ScenarioArtifact`, a second hash, or a result method. Gate B already stamps, validates,
migrates, and identifies this report. `ScenarioRunResult`'s record intersection makes this exact call
compile; no `as Record<string, unknown>` or `{ ...result }` escape hatch is accepted.

The persisted target payload is complete stored data. Every `targetAxis` row contains scaling,
grouping, method, hashes, and either:

- full revaluation's canonical `instrumentDescriptor` plus pricer identity/capabilities; or
- Taylor's `baseValuePerUnit`, complete sensitivities, and complete factor levels under `taylor`.

The target axis never stores an instrument or pricer behavior object. A full-revaluation descriptor
is a replay recipe owned by that instrument's adapter; a Taylor descriptor is sufficient to call
`scenarioTarget.taylor` directly.

Replay is explicit and registry-free:

1. restore the `AnalysisArtifact`, `ScenarioSet`, and `MarketSnapshot` through their existing readers;
2. prove the stored scenario/market hashes match;
3. construct one fresh `ScenarioTarget` for every saved target-axis row, in saved order: rebuild a
   Taylor target from its stored `taylor` payload; for full revaluation, explicitly rehydrate the
   instrument from `instrumentDescriptor` and bind the matching pricer—functions and behavior
   objects are never serialized;
4. require the fresh target ID/method/scaling/grouping, method-specific descriptor/hash, pricer
   name/version/capabilities, and complete `targetDescriptorHash` to equal the saved row before any
   pricing;
5. rebind custom resolvers and custom factor handlers by the exact name/version arrays recorded in
   `replayParameters`, refusing missing, extra, duplicate, or reordered identities;
6. rerun with the stored currency quotes, options, and seed; and
7. compare `canonicalJsonOf(recomputed)` with `canonicalJsonOf(saved.result)`.

The executable fixture defines the behavior-only handoff as an ordered array, not a global registry
or identifier-keyed object:

```ts
interface ScenarioReplayTargetBinding {
  readonly targetId: string;
  readonly target: ScenarioTarget;
}
```

It requires exactly one binding per saved row and exact row order. This same fixture must include a
Taylor-only artifact and a third-party full-revaluation instrument whose behavior is reconstructed
from its descriptor, proving both replay paths rather than only first-party options.

Stage 4.4b must include an executable replay fixture proving byte identity. A dedicated replay helper
is not required: Gate B intentionally leaves execution to the producing operation, and one direct
rerun is clearer than another wrapper.

## Ordered implementation slices

Only one slice owns shared contracts at a time. Every slice formats only changed files, runs strict
typecheck/lint/build, regenerates all source-owned artifacts, updates API reports/manifests, runs the
affected package and architecture suites, runs its packed consumer, and ends with
`git diff --check`.

| Slice | Contents                                                                                                                                                                                                                                                                       | State                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| 1     | Package/graph/umbrella wiring; target builders and validation; result/error/work contracts; Gate B → Gate C built-in resolver; `spotAssetPricer`; full-revaluation base + spot/vol/rate/dividend/time scenarios; first packed TypeScript/JavaScript example                    | `COMPLETE @ 3095cf91` |
| 2     | Forward/curve/custom resolution and all ordered transformation semantics; unmatched-instruction preflight; reporting currency + FX scenarios via FC5; `bondDiscountCurvePricer`; option/bond/direct parity and heterogeneous stock + option + bond journey                     | `COMPLETE @ 3095cf91` |
| 3     | Taylor binding through direct `taylorPnl`; collect/fail-fast behavior; immutable row-major details; complete aggregation; `scenarioPortfolioBinding` + `scenarioTargetsFromPortfolio`; strategy-as-Taylor and multi-currency portfolio journeys                                | `COMPLETE @ 3095cf91` |
| 4     | Analysis-artifact save/replay identity; custom third-party pricer/resolver/handler fixture; browser + worker packed parity; hostile-input/mutation/work-cap probes; bundle measurement; all generated docs/API/manifests; full-library gates and exact-commit tracker closeout | `COMPLETE @ 3095cf91` |

The implementation landed atomically after every slice contract was green. No Stage 4.5 code is part
of `3095cf91`.

## Acceptance and exit gate

### API and directness

- [x] `blackScholes`, `option.price`, `taylorPnl`, `stressTest`, `analyzeBook`, portfolio APIs, and
      direct fixed-income/FX calls remain independently importable and behaviorally unchanged.
- [x] A cold TypeScript user can run the README's stock + option scenario in one obvious call with
      no cast, provider, registry, class hierarchy, or framework setup.
- [x] Exported target/result declarations contain every discriminated type in Decision 7; compile
      fixtures narrow every union and pass `ScenarioRunResult` directly to `createAnalysisArtifact`.
- [x] JavaScript receives the same teaching errors for malformed target/request objects.
- [x] The umbrella exposes only `totalfinance.scenarios` / `totalfinance/scenarios`; no scenario function is
      root-hoisted.

### Numerical and semantic parity

- [x] Spot adapter result equals the supplied spot exactly.
- [x] Option base and each scenario result preserve direct `option.price` field-for-field and have
      equal canonical bytes over the same resolved observations, including selection diagnostics.
- [x] Flat continuous ACT/365F rate/dividend quotes pass unchanged; annual, periodic, simple,
      ACT/360, and 30/360 quotes never pass as Gate C scalars and require an explicit resolver.
- [x] Bond base, curve-shock, and UTC-date-crossing time-shock values match direct
      `priceMultiCurve` under the adapter's stated settlement projection, clean/dirty basis, and
      curve conversion; a same-UTC-date sub-day shift has disclosed zero bond effect.
- [x] Every Taylor cell's attribution matches direct `taylorPnl` field-for-field, and
      `scenarioValuePerUnit = baseValuePerUnit + attribution.total`.
- [x] Overrides-first and shocks-in-order have hand-computed non-commutative fixtures.
- [x] Time uses exactly ACT/365F milliseconds; percent time and targeted time refuse.
- [x] Local and reporting-currency P&L match hand calculations and direct `convertCurrency`,
      including an FX-only scenario.

### Books, failures, and accounting

- [x] One scenario set runs across a spot asset, option, bond, and Taylor strategy target.
- [x] Portfolio-derived target quantity, multiplier, currency, account, underlying, and order match
      the detached public empty-fold result exactly; unknown/duplicate/missing bindings refuse.
- [x] Position, underlying, strategy, account, book, tag, and grand totals reconcile exactly to
      cells; tag overlap is disclosed.
- [x] In collect mode, one failed constituent makes only affected aggregates incomplete and never
      yields a partial numeric total; fail-fast preserves typed cause/context.
- [x] Hostile thrown contexts (accessors, `toJSON`, class instances, symbols, functions, and cycles)
      never execute or enter a result; collect snapshots them as `omitted-unsafe`, while fail-fast
      keeps the original thrown value only on the non-serialized cause chain.
- [x] Missing observations, ambiguous resolvers/quotes, unmatched instructions, negative volatility,
      non-positive FX, impossible curves, unsupported targets, and custom-handler identity drift all
      fail with stable codes and corrected minimal calls.

### Determinism, safety, and artifacts

- [x] Same inputs and seed produce byte-identical output in Node, a browser bundle, and a worker.
- [x] Seeded targets use `seed + targetIndex` and the same target seed for base and every scenario;
      negative seeds and overflow refuse before any pricer behavior.
- [x] Barrier A rejects oversized complete Gate B inputs before readers or behavior; Barrier B runs
      exactly one `supports` then one `requirements` call per full-revaluation target and rejects an
      oversized plan before resolver, handler, pricing, or result-grid allocation. Returned callback data cannot exceed its reserved
      observation/pillar shape, valuation results cannot exceed their per-cell retained-data
      reservation, and no `price` spy observes a call before all pre-price work checks pass.
- [x] Requests reject unknown keys, wrong containers, accessors, coercion hooks, non-finite values,
      duplicate IDs, and unsafe canonical descriptors with typed errors.
- [x] The runner does not mutate target arrays, instruments, observations, quotes, state, scenario
      sets, or market snapshots; its result is deeply frozen and detached.
- [x] `createAnalysisArtifact` saves the result unchanged; restore + explicit behavior rebind + rerun
      is canonical-byte-identical for both Taylor-only and third-party full-revaluation artifacts.
- [x] No package reads a clock, network, credential, database, provider, or process-global registry.

### Repository evidence

- [x] New package and adapters are hand-classified in manifests on their first commit; naming,
      signature, runtime, field, result, finite-success, realization, declared-coverage, and
      spec-mapping ratchets have zero new debt.
- [x] API reports, generated README/llms references, package inventories, root/umbrella symmetry,
      layer/package graph, codes, export map, and generated-output drift gates are green.
- [x] Packed Node/TypeScript/JavaScript/browser/worker consumers use tarballs, not workspace aliases.
- [x] Measured package/root/umbrella gzip budgets are updated from evidence, with headroom and no
      unrelated reformatting.
- [x] Full affected tests and full repository typecheck/lint/build are green at one exact commit.

Stage 4.4b is closed at `3095cf91`: every box above is executable, the full repository gate reports
443 passing test files / 9,749 passing tests, all 35 packed-consumer tests pass, measured enforcement
reports 2,360 enforced / 2,584 partial / 0 defective / 181 reasoned-unmeasured paths, and all 20
bundle budgets are measured and green.

## Completion record and next handoff

Stage 4.4b added the independently installable `@totalfinance/scenarios` package, the
`bondDiscountCurvePricer` Gate-C adapter, umbrella/deep-import symmetry, exact replay, and all
runtime/evidence machinery specified above. Every raw/direct API remains independently callable.

The authoritative queue now activates **Stage 4.5 calibration and research artifacts**. Its first
task is contract authoring: create and review a decision-complete
`docs/specs/calibration-research-artifacts.md` that reconciles Gate B's artifact grammar, FC3's
screening/factor/event-study surfaces, existing calibration outputs, comparison/replay semantics,
package placement, bounded work, and executable slices. Do not begin Stage 4.5 implementation until
that focused contract is accepted. After Stage 4.5, the authoritative preview lane closes options
marking truthfulness, local operation/CLI/OpenAPI/MCP access, and pre-1.0 shipping before the remaining
Stage 4.6 surface. Data, connected/hosted agents, live operation, and acceleration remain later.
