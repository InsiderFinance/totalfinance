# Quant library developer-experience assessment

> **Historical review at `490ee0c1`–`dc30c347`.** Current statuses and decisions live in
> [`library-alignment-spec.md`](./library-alignment-spec.md); statuses are not tracked here.
> **Erratum (2026-07-21):** the kernel row in the role table and Decisions 3/11 incorrectly allow
> long positional numeric signatures on expert subpaths and assert an unmeasured speed benefit.
> That exception is retracted. Alignment Law 14 / D13 and Phase 3A required named objects for
> financially confusable scalars at every public layer and inside financial-domain code by default;
> the correction completed on 2026-07-22. See the alignment spec for current generated evidence.
> **Naming erratum (2026-07-28):** Decision 5 and reconciliation Decision 4 still endorse compact
> public `bs`/`vol`/`iv`/`t`/`rate` grammar. The complete public-identity audit retracted that
> recommendation; the
> [Phase 3B.N naming specification](./specs/phase-3b-public-naming-normalization.md) now owns public
> vocabulary across every layer.

## Review status

This is a library-first review of PR #303, head
`insiderfinance/287-open-source-quant-library` into `develop`. The original
review was refreshed after the branch advanced by 42 commits. The full
architecture and numerical-contract review was performed against `490ee0c1`
(`feat(math): Ledoit-Wolf single-index (market-model) shrinkage target`),
reviewed on 2026-07-18.

On 2026-07-19, this assessment was reconciled with the independent
[lovability review](./library-lovability-review.md), including that review's
adversarial cross-review at commit `12e74abd`. That commit changes only the
companion document, not library source, so the code findings below remain
against `490ee0c1`. The reconciliation adopts its verified first-use defects,
corrects one factual overstatement about error serialization, and records the
remaining product-philosophy decisions explicitly.

While that reconciliation was being prepared, the branch advanced again to
`dc30c347` (`fix(totalfinance): burn down 6 DX P0 landmines (F1–F6)`). I reviewed
that complete difference, ran its seven directly affected suites (**956 tests
passed**), and then ran the full library validation (**292 test files and 5,979
tests passed**). The final assessment and priorities below incorporate those
fixes; the open source findings are therefore current through `dc30c347`.

The review covers the public TypeScript API, function signatures, contracts,
defaults, results, errors, package boundaries, import paths, extensibility,
runtime compatibility, numerical trust, SDK shape, and MCP shape. Data
acquisition and public documentation are acknowledged as known gaps and are
intentionally placed at the end.

## Executive conclusion

The library has an unusually strong implementation foundation, but it has not
yet reached a 10/10 public developer experience. My library-only assessment is
approximately **7.5/10 today** after the first-touch fixes in `dc30c347`: good
enough for a serious private beta, not yet ready for a stable public API
promise.

The central issue is not missing quantitative breadth. The branch already has
more breadth than most new libraries and the latest additions make that even
clearer. The issue is that users are exposed to several overlapping API
philosophies:

- simple object-input facades with `.explain`;
- positional pro APIs;
- raw positional numerical kernels;
- direct structured analyses with embedded metadata;
- `Computed<T>` envelopes;
- mutable-looking namespace objects, registries, factories, and classes;
- a flat options surface alongside namespaced surfaces for every other domain.

Each pattern can be justified locally. Together they make the library harder to
predict globally. A lovable library teaches one grammar and then rewards the
user for reusing it everywhere. This one currently teaches several grammars.

The recommendation is to pause net-new domain expansion long enough to perform
one deliberate pre-1.0 API-coherence pass. That pass should:

1. define the small number of public API roles and classify every export;
2. make high-level calls object-based and keep positional kernels behind expert
   entry points;
3. redesign option contracts and expiration conventions so invalid or
   misleading states are not the default;
4. enforce one result/error/non-convergence policy;
5. make engine capabilities and per-call options substitutable;
6. make the umbrella package and domain subpaths symmetrical;
7. standardize vocabulary and units.

This is the highest-leverage work available. It is much cheaper to do now, at
`0.0.1`, than after examples and dependent applications lock in the current
surface.

### Scorecard

| Area                               | Current assessment | What keeps it from 10/10                                                                                      |
| ---------------------------------- | -----------------: | ------------------------------------------------------------------------------------------------------------- |
| Implementation discipline          |               9/10 | Purity checks are not yet workspace-wide; some edge contracts escape the suite                                |
| Test and correctness evidence      |               8/10 | Excellent internal cross-validation, but limited independent reference certification and edge-domain policy   |
| First-touch errors and diagnostics |               9/10 | Strong teaching errors and method-level ratchets; non-finite successful results and a few guards remain       |
| Public API coherence               |             5.5/10 | Too many shapes and aliases; facade, pro, kernel, artifact, and analysis roles are not consistently separated |
| Arguments and defaults             |             5.5/10 | Good object facades, but positional discriminators, unsafe option defaults, and invalid builders remain       |
| Imports and package topology       |               6/10 | Good scoped packages and some lean subpaths; asymmetric umbrella and duplicated namespaces                    |
| Extensibility and artifacts        |               8/10 | Strong engines, registries, and serialization; capabilities and public manifests need formalization           |
| Runtime/consumer compatibility     |               6/10 | ESM packaging works and tree-shakes; compatibility matrix, CJS decision, and source debugging need work       |
| Overall library experience         |         **7.5/10** | Strong engine room and repaired opening path; the controls are not yet uniform enough to feel inevitable      |

The overall score is not a numerical average. API coherence is a multiplier:
users experience the library through the surface, not through its coverage
report.

## What changed in the latest code

The feature refresh through `490ee0c1` contained **42 additional commits**,
touching **141 files** with **16,722 insertions and 212 deletions**. Major
additions include:

- a new `@totalfinance/crypto` package;
- inverse and composite options;
- digital, touch, stochastic-engine, and numerical-engine extended Greeks;
- higher-order P&L explain;
- covariance conditioning, Ledoit-Wolf identity/constant-correlation/single-index
  targets, and EWMA covariance;
- SSVI/eSSVI, vanna-volga, risk-reversal/butterfly, SABR Bartlett Greeks,
  risk-neutral density, surface PCA scenarios, and vol/spot beta;
- fixed-income futures hedging and OAS analytics.

At `490ee0c1`, the complete repository gate passed:

- formatting, lint, type checking, build, API-report drift, and bundle budgets;
- **289 test files and 5,934 tests**;
- 96.50% statement, 88.99% branch, 97.99% function, and 97.26% line coverage;
- all 15 package API reports current.

This materially improves confidence in implementation quality. The new
first-touch test infrastructure is especially valuable:

- the garbage sweep exercises hundreds of public calls with malformed inputs
  and has an empty crash ledger;
- the deep sweep checks happy fixtures, later positional arguments, partial
  object deletion, and `.explain` behavior;
- export-map imports, generated examples, and the five-minute journey are
  tested.

### Follow-up: six first-use defects are now closed

Commit `dc30c347` resolves the companion review's F1–F6 cluster:

- README/getting-started RSI examples now produce a real RSI value, and tests
  assert the value rather than only output length;
- the strategy guide uses the current argument shape and runs in a new guide
  harness;
- every TA indicator rejects a primitive params argument through the common
  resolver;
- `Position` chart/scenario methods derive a shared strike-based range, accept
  explicit arrays, guard bad inputs, and are covered by an exhaustive
  method-level first-touch sweep;
- named-direction leg builders reject non-positive quantities with a teaching
  error;
- backtest docs now distinguish regime signals from crossover events, and
  `latchSeries(entries, exits)` provides the missing held-position primitive.

The focused verification passed all 956 tests in the seven affected suites,
including 871 export first-touch probes and 31 public `Position` method probes.
The implementation choices are good: common choke points and completeness
guards make these permanent fixes rather than six isolated conditionals.

Full follow-up verification also passed lint, type checking, all 292 test files
and 5,979 tests, build, and all 15 API-report checks. Coverage is now 96.50%
statements, 89.02% branches, 97.99% functions, and 97.27% lines. The companion
review had Prettier drift; the documentation commit containing this
reconciliation normalizes it so the complete format gate can pass as well.

This raises the first-touch assessment materially. It does **not** settle the
central API decisions or the numerical-success edge cases below. The branch is
better, and the remaining work is now more clearly architectural rather than
basic polish.

### New findings from the refreshed head

Five concrete findings should be added to the pre-release blocker list:

1. **`greeks: false` is not substitutable across engines.** The public
   `PriceOptions` contract says the option can suppress Greeks. The auto/BSM and
   Black-76 engines still return Greeks with no warning, while the binomial and
   stochastic paths honor it. This was reproduced against the built latest
   head. The cause is visible in
   [the BSM contract adapter](../packages/options/src/engine-bsm.ts) and
   [Black-76 engine adapter](../packages/options/src/engines.ts).

2. **Extended Greeks can report success with non-finite output.** A valid,
   deeply out-of-the-money BSM call can underflow to a zero price. `lambda =
delta * spot / price` then becomes `NaN`, while `.explain` reports
   `converged: true` with no warning. JSON serialization silently turns that
   value into `null`. The same division appears in several analytic models and
   the numerical finite-difference helper.

3. **The new crypto analysis can produce non-finite output while reporting
   convergence.** `perpFunding` accepts any finite funding rate. With
   `fundingRate: -1.1` and a seven-hour interval, fractional compounding
   evaluates a negative base to a non-integer power, producing `NaN`. The
   result reports `converged: true` and only warns that simple annualized
   funding is extreme.

4. **The new covariance front door does not always deliver its stated
   conditioning promise.** Degenerate constant series sent to
   `estimateCovariance(..., { method: "auto" })` return a zero matrix,
   `conditionNumber: Infinity`, and `isPositiveDefinite: false` after resolving
   to Ledoit-Wolf. The diagnostics honestly report `converged: false`, which is
   good, but the API description says the front door produces a
   well-conditioned, usually invertible covariance and the Ledoit-Wolf path is
   described as always SPD. Either guarantee the fallback or weaken and
   formalize the result contract.

5. **The latest single-index target creates another counterexample to the SPD
   guarantee.** With nonconstant but perfectly collinear return series, the
   equal-weight market variance is positive, so the new target accepts the
   input. The target equals the singular sample matrix, the estimated
   shrinkage is `0`, Cholesky fails, and `estimateCovariance` returns
   `isPositiveDefinite: false` and `converged: false` with an empty warning
   list. This was reproduced against commit `490ee0c1`. The implementation is
   useful and its option shape is clean, but “always SPD” is not currently a
   valid postcondition. Add a ridge/eigenvalue floor or a guaranteed fallback,
   and emit a warning whenever the returned covariance is not SPD. Also make
   the factor source explicit: the Ledoit-Wolf paper models returns against an
   observed market series, while this API silently constructs an equal-weight
   proxy from the supplied assets. Accept an explicit market series/weights or
   name and disclose the proxy as part of the method:
   [Ledoit and Wolf (2003)](https://www.ledoit.net/Improved_JEF2003.pdf).

The builders also remain permissive on the latest head: empty underlyings,
negative strikes, invalid expiry strings, and negative market spots can all be
constructed without an error. They fail later during pricing, which defeats
the expectation that a named builder produces a valid value.

## The standard for a lovable quantitative library

A 10/10 library should satisfy five properties simultaneously.

### One obvious first move

A developer should be able to install one package, import one obvious domain,
perform a useful calculation in under five minutes, and understand the result
without reading architecture documentation.

### Progressive disclosure

The beginner and expert APIs should be layers of the same model:

- a simple front door with safe defaults;
- an explained result when assumptions matter;
- explicit model/engine selection when needed;
- low-level kernels for performance and research.

Expert power should not make the beginner surface noisy.

### A reusable grammar

After learning one domain, users should correctly predict another:

- where inputs go;
- what fields are called;
- how dates and units work;
- what errors throw;
- what non-convergence looks like;
- how to request diagnostics;
- how single and batch operations are named;
- how imports are structured.

### A pit of success

The easiest code to write should also be financially defensible. Dangerous
assumptions may be available, but they must be explicit. Valid TypeScript
should not casually represent a Bermudan option with no exercise schedule, a
US equity option defaulting to European exercise, or a historical backtest
with a timeless hard-coded risk-free rate.

### Trust without ceremony

Users need transparent assumptions, deterministic computations, stable
serialization, and honest convergence without having to inspect implementation
details. The current diagnostics system is a strong foundation for this.

## What the branch already gets right

The following decisions should be preserved.

### Determinism and purity

Explicit `asOf` values, seeded stochastic methods, browser-safe compute
packages, and no hidden system-clock reads are exactly right. This makes
research reproducible and allows the same code to run in a browser, worker,
server, test, or MCP tool.

### Typed teaching errors

The error hierarchy, stable codes, contextual messages, first-touch guards, and
“teach the correct gesture” philosophy are excellent. The garbage and deep
sweeps turn that philosophy into a measurable contract rather than relying on
handwritten happy-path tests.

### Assumptions and diagnostics

Explicit model, engine, day-count, compounding, unit, convergence, iteration,
and warning metadata is a genuine differentiator. Most numerical libraries
make users reconstruct this information from documentation or source code.

### Plain facades plus explanation

Calls such as:

    bs.call({
      spot: 100,
      strike: 105,
      t: 30 / 365,
      rate: 0.04,
      vol: 0.22,
    })

are compact, readable, and difficult to misuse. Attaching `.explain` to the
same function is elegant because it keeps the casual path simple while making
the trustworthy path discoverable.

### Numerical honesty

Solver diagnostics, no fabricated zero values on failure, explicit fallback
reporting, analytical-versus-finite-difference comparisons, and Monte Carlo
cross-checks are all strong. The branch shows unusual care around negative
rates, dividends, early exercise, no-arbitrage conditions, and stochastic
reproducibility.

### Batch and streaming primitives

`ArrayLike<number>` support, typed arrays, columnar BSM batches, TA streaming
state, serializable indicators, and versioned artifacts are good choices for
both browser and research workloads. These are better foundations than
prematurely introducing data-frame or WebAssembly dependencies.

### API and bundle drift gates

API Extractor reports, package export-map tests, consumer-style import tests,
and bundle budgets are exactly the right kind of automation. The next step is
to broaden what those gates define as public, not replace them.

### Extension points

Pricing engines, registries, strategy builders, curves, surfaces, and
serializable artifacts establish a credible composability story. The
architecture is not a pile of isolated formulas.

### The new crypto package

The seven new crypto functions are cohesive, use object inputs, validate
first-touch boundaries, and expose assumptions and diagnostics. The package is
a good example of domain grouping. Its envelope and compounding edge cases
need correction, but its overall shape is cleaner than several older roots.

## Decision 1: define the canonical public-surface taxonomy

The repository currently says there are “two API shapes only,” but the runtime
has more than two. That statement should be replaced with an enforceable
taxonomy.

### Recommended public roles

Every runtime export should be classified as exactly one of these:

| Role             | Intended user                         | Signature and result                                                                                                 |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Facade           | Most users                            | One object input (or one series plus one options object), plain output, and `.explain(input) -> QuantResult<output>` |
| Analysis         | Users who inherently need provenance  | One object input and a consistent `QuantResult<T>`                                                                   |
| Artifact/factory | Reusable calibrated or stateful value | One object config; immutable public behavior; versioned serialization when persisted                                 |
| Kernel           | Experts and internal composition      | Positional numeric arguments allowed; available only from an explicit expert subpath                                 |

“Namespace” is organization, not a fifth behavior. A namespace contains the
roles above.

### Use one rich-result law per public role

The core type says that every pro API returns `Computed<T>`, but the current
surface includes several variations:

- `Computed<T>` with `value`, `assumptions`, and `diagnostics`;
- `PriceResult` with `value` plus sibling `greeks`;
- direct records such as `PerpFunding` with business fields plus assumptions
  and diagnostics but no `value`;
- `CovarianceEstimate` in the same direct-record style;
- calibrated artifacts and backtest reports with their own metadata layouts.

Choose one universal metadata carrier for explained and analytical operation
results. A practical design is:

    interface QuantResult<T> {
      value: T;
      assumptions: Assumptions;
      diagnostics: Diagnostics;
    }

Domain-specific result types may extend this when adjacent fields are
essential:

    interface OptionPriceResult extends QuantResult<number> {
      greeks?: Greeks;
      errorEstimate?: number;
    }

Structured analyses should put their domain payload in `value`:

    QuantResult<{
      annualizedSimple: number;
      annualizedCompounded: number | null;
      premium: number;
      longCarry: number;
      shortCarry: number;
    }>

This introduces one extra `.value` access in pro code, but buys global
predictability and makes `isComputed` truthful. If direct enriched records are
preferred, then formalize a second named type and stop claiming that every pro
result is `Computed<T>`. The current undocumented mixture is the worst option.

This is a role rule, not a demand to bolt `.explain()` onto every export.
Compact scalar facades should keep the excellent plain-value plus
`.explain()` gesture. Calibrations, optimizations, scenario reports, and
backtests inherently need diagnostics and should return rich results directly.
Artifacts such as curves, surfaces, and streaming indicators should expose
their own immutable domain methods and versioned serialization. Predictability
comes from knowing the role before calling the function, not from forcing
every kind of value through the same gesture.

### Create a public-surface manifest

The manifest should be source-controlled and machine-readable. Each public
operation should declare:

- canonical name and aliases;
- domain and role;
- package root and supported subpaths;
- input schema or type identifier;
- result type;
- units and conventions;
- sync/async behavior;
- deterministic or seeded behavior;
- browser/server support;
- stability level;
- MCP eligibility;
- examples and reference-validation fixture.

Generate package exports, API inventory checks, first-touch fixtures,
documentation indices, and MCP registration from this manifest. This prevents
the current state in which the code, API reports, subpaths, docs, and MCP each
describe a slightly different library.

### Add a conformance gate

CI should fail if a runtime export is unclassified, if an alias is not tied to
a canonical operation, or if a high-level API violates its role. This makes
“one grammar” an invariant.

## Decision 2: simplify package and import topology

There are now 15 package directories: 14 scoped packages plus the unscoped
umbrella. Package boundaries are generally reasonable; import presentation is
not yet symmetrical.

### Current friction

- Options exports are hoisted flat from the umbrella while every other domain
  is namespaced.
- Several package roots export both individual functions and an eponymous
  namespace. The umbrella consequently exposes paths such as
  `technical_analysis.ta`, `performance.performance`, `backtest.backtest`, and
  `strategy.strategy`. Risk also contains a nested `performance` namespace.
- The umbrella has no domain subpaths such as `totalfinance/options` or
  `totalfinance/vol`.
- The options package has useful feature subpaths, while crypto has only a root
  and the newest vol features are root-only even though older vol features
  have subpaths.
- Large roots expose high-level operations, schemas, engine factories,
  aliases, and raw numerical kernels together.

The root sizes make this material: `@totalfinance/options` currently exposes 89
runtime keys, `@totalfinance/vol` 69, and `@totalfinance/ta` 394. API Extractor reports
include still more type exports.

### Recommended topology

Use domain namespaces as the stable grammar, with a deliberately tiny
flagship front porch at the umbrella root:

    import { bs, options, risk, ta } from "totalfinance";

    const price = bs.call({
      spot: 100,
      strike: 105,
      t: 30 / 365,
      rate: 0.04,
      vol: 0.22,
    });

    options.price({ contract, market });
    risk.valueAtRisk(returns, { confidence: 0.99 });
    ta.rsi(closes, { period: 14 });

And make the one-install package support focused imports:

    import { options } from "totalfinance/options";
    import { vol } from "totalfinance/vol";
    import { rsi } from "totalfinance/ta/rsi";

Scoped packages remain available to users who want explicit dependencies:

    import { option, bs } from "@totalfinance/options";
    import { bsmPrice } from "@totalfinance/options/kernel";

The exact namespace names can vary, but the laws should not:

1. the umbrella root exposes every domain through one namespace and may hoist
   only a small, manifest-declared set of category-defining facades such as
   `bs`;
2. the umbrella must never wildcard-hoist an entire domain;
3. all domains have equivalent umbrella subpaths;
4. package roots expose curated user-facing APIs;
5. raw kernels live behind explicit `/kernel` or model-specific expert
   subpaths;
6. there is only one eponymous namespace level;
7. every documented feature has a stable export-map entry.

A namespace-only root would be maximally regular, but `import { bs } from
"totalfinance"` is a genuinely excellent opening move. Preserve that advantage
without treating the current 94-export options hoist as precedent. Root
promotion should be exceptional, collision-free, budgeted in CI, and frozen
through the public manifest.

Node's official package guidance describes `exports` as the mechanism for
declaring and encapsulating a package's public interface and recommends a
single consistent specifier for each subpath:
[Node package entry points](https://nodejs.org/api/packages.html#package-entry-points).
The current export-map test is a good foundation; generate its cases from the
manifest.

### Do not create more packages by default

The current package count is defensible because the domains have meaningful
dependency and usage boundaries. Add another npm package only when it can be
versioned, consumed, and reasoned about independently. Prefer feature subpaths
inside vol, risk, fixed income, and options over fragmenting every model into a
package.

## Decision 3: object inputs for user-facing operations

Positional numeric kernels are concise and fast. They are also the easiest
calls to misuse. Swapping `strike` and `spot` or `rate` and `dividendYield`
still produces a valid number.

The branch already has the right pattern in `bs.call({ ... })`. Apply it
consistently.

### High-level rule

- Facades and analyses take one object.
- Series functions may take `(series, options?)` when the series is the obvious
  subject.
- Factories take one config object.
- Positional discriminators and long numeric argument lists are kernel-only.

### Current examples to change

`option.price(contract, market, engine?, opts?)` creates an awkward hole. A
caller who wants the default engine plus options must write:

    option.price(contract, market, undefined, { greeks: false });

Comments elsewhere already drift into showing the options object as the third
argument. `compareEngines` accepts multiple shapes across its third and fourth
arguments. Exotics use mixed signatures such as:

    digital.price(type, kind, input);
    barrier.price(type, barrierType, input);
    touch.price(kind, input);

These signatures make autocomplete less useful and create many first-touch
branches.

Prefer:

    option.price({
      contract,
      market,
      engine: engines.auto(),
      greeks: false,
    });

    option.compareEngines({
      contract,
      market,
      engines: [engines.blackScholes(), engines.binomial()],
      reference: "black-scholes-merton",
    });

    digital.price({
      type: "call",
      kind: "cash-or-nothing",
      spot: 100,
      strike: 105,
      t: 30 / 365,
      rate: 0.04,
      vol: 0.22,
      cash: 10,
    });

Discriminated unions then guide the user to fields required for each option
kind. The raw kernels can retain compact positional signatures under expert
subpaths.

### Keep options objects flat until nesting earns its keep

Do not build a ceremony-heavy configuration DSL. Use nested objects for
meaningful value objects—contract, market, curve, engine—not for every three
fields. The best current facades are concise because they follow this rule.

## Decision 4: make financial contracts valid by construction

This is the most important correctness-and-lovability change.

### Do not default a generic option contract to European

> **Resolved (2026-09):** `style` is required on the generic builders (`option.call`/`option.put`/`european` refuse to default it), and `usEquityCall`/`usEquityPut` name the American convention. The paragraph below is the historical finding.

`option.call({ underlying: "AAPL", ... })` currently defaults to
`style: "european"`. That is an unsafe default for the most obvious US-equity
example. Standardized US equity options use American-style exercise, while
many index options use European style:
[Options Industry Council exercise overview](https://www.optionseducation.org/referencelibrary/faq/options-exercise).

There are two safe choices:

1. require `style` in the generic builder; or
2. offer instrument-specific convenience builders whose conventions are
   encoded in the name.

The second is more lovable:

    const contract = option.contract.usEquityCall({
      symbol: "AAPL",
      strike: 200,
      expiryDate: "2026-09-18",
    });

    const contract = option.contract.european({
      type: "call",
      underlying: "SPX",
      strike: 6000,
      expiresAt: "2026-09-18T13:00:00-04:00",
      settlement: "cash",
    });

The generic builder should require every meaning-changing field.

### Validate in builders, not only calculators

`option.call` and `market` currently normalize objects but do not establish
validity. A builder should reject:

- blank identifiers;
- non-finite or non-positive strike, spot, forward, volatility, and
  multiplier where applicable;
- invalid expiry;
- invalid currency/root formats when supplied;
- inconsistent deliverables;
- contract-specific missing fields.

If permissive normalization is useful internally, name it `normalizeContract`
or `normalizeMarket`. “Build” should imply valid-by-construction.

### Make exercise style a discriminated union

The core type allows `style: "bermudan"` but has no exercise dates, and current
engines reject Bermudan pricing. That is an invalid representable state.

Use:

    type OptionExercise =
      | { style: "european" }
      | { style: "american" }
      | {
          style: "bermudan";
          exerciseDates: readonly [ExpiryInstant, ...ExpiryInstant[]];
        };

Then either support the third case or keep it out of the public vanilla
contract until an engine does.

### Separate a date label from an expiration instant

A bare `YYYY-MM-DD` is a calendar date without a time or time zone; this
distinction is explicit in modern JavaScript time modeling:
[Temporal.PlainDate](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/PlainDate).

The current generic option path resolves every date-only expiry to 16:00
America/New_York. That is a good convention inside a **US equity helper**, but
it is not generic across index options, futures options, rates, FX, crypto, or
international exchanges. The contract already carries `exerciseTime` but the
pricing path does not use it.

The compute contract should contain an exact `expiresAt` instant, represented
as branded epoch milliseconds or a zoned ISO string. Instrument helpers should
resolve exchange-specific date labels into that instant. Preserve the label as
metadata when useful.

### Clarify metadata-only fields

`settlement`, `exerciseTime`, `deliverable`, `adjusted`, `currency`, and
`multiplier` appear on the contract, but vanilla pricing mostly ignores them.
That can be reasonable—the theoretical per-unit price may not depend on
settlement plumbing—but it must be explicit.

Split fields into:

- fields that affect pricing and engine support;
- metadata used for portfolio accounting, settlement, and display.

An engine should never appear to honor a field it silently ignores.

### Remove timeless market defaults from historical backtests

The options backtest currently defaults `rate` to `0.04` for every date. A
default can be convenient in an interactive calculator, but it is not a
defensible hidden assumption for a historical research engine.

Accept:

- a per-snapshot rate;
- a function of `asOf` and maturity;
- a curve artifact;
- an explicit constant supplied by the user.

If zero costs, no assignment, or a constant rate remain available, echo them
prominently in assumptions and emit an informational warning. A backtest can
be frictionless by choice; it should not look realistic by accident.

## Decision 5: formalize units and vocabulary

Quantitative APIs fail when semantically different numbers share the same
unqualified field name.

### Canonical vocabulary by API role

Use explicit names in contracts, market objects, and cross-model analyses
while preserving compact practitioner grammar in model-specific facades:

| Meaning                         | Domain/pro object                                       | Compact facade or kernel          |
| ------------------------------- | ------------------------------------------------------- | --------------------------------- |
| Spot price                      | `spot`                                                  | `spot` (or `S` in kernels)        |
| Forward price                   | `forward`                                               | `forward`                         |
| Strike                          | `strike`                                                | `strike` (or `K` in kernels)      |
| Lognormal volatility            | `lognormalVolatility`, or `volatility` when unambiguous | `vol`                             |
| Normal/Bachelier volatility     | `normalVolatility`                                      | `normalVol`                       |
| Risk-free rate                  | `riskFreeRate`                                          | `rate`                            |
| Continuous dividend yield       | `dividendYield`                                         | `dividendYield`                   |
| Valuation instant               | `asOf`                                                  | derived or explicit `t`           |
| Exact expiration instant        | `expiresAt`                                             | derived or explicit `t`           |
| Market implied volatility quote | `impliedVolatility`                                     | `iv` when the context is explicit |

Do not mechanically rename the compact `bs.call({ spot, strike, t, rate, vol
})` facade. Its brevity is part of its quality, and those names are
unambiguous inside a Black-Scholes-specific entry point. The longer names
matter when values cross models or enter reusable domain objects. The naming
law should eliminate semantic collisions, not maximize character count.

Compact symbols such as `S`, `K`, `T`, `r`, `q`, and `sigma` are appropriate
inside formulas and kernels. They should not leak into unrelated high-level
domains.

### Normal and lognormal volatility must not look interchangeable

The Bachelier model's volatility is in price units; BSM volatility is a
dimensionless annualized fraction. Calling both `vol` creates a catastrophic
footgun because both are numbers and both can be positive.

Use explicit field names and include the volatility convention in assumptions.
Selective opaque TypeScript brands can help at expert boundaries:

    type LognormalVolatility = number & { readonly __unit: "lognormal-vol" };
    type NormalVolatility = number & { readonly __unit: "price-per-sqrt-year" };

Do not require users to wrap every scalar in a heavyweight numeric object.
Good names, runtime validation, and metadata do most of the work.

### Expand Greek convention metadata

`DEFAULT_GREEK_UNITS` currently explains first-order theta, vega, and rho. The
new extended set adds vanna, charm, vomma, speed, color, phi, zomma, veta,
vera, ultima, and lambda with mixed scale and time-sign conventions.

Add explicit derivative definitions and units to runtime assumptions. In
particular:

- whether time Greeks mean calendar-time decay or derivative with respect to
  time-to-expiry;
- whether volatility/rate derivatives are per 1.00 or per 1%;
- what underlying delta means for spot, forward, inverse, and coin-settled
  products;
- when elasticity is undefined because price is zero.

The implementation comments are detailed; the runtime contract needs the same
precision.

## Decision 6: one policy for errors, non-convergence, and non-finite values

The existing policy is close. Finish it.

### Recommended outcome semantics

1. Invalid input throws a typed `QuantError` with a stable code and context.
2. A valid problem that cannot converge returns a rich result with
   `diagnostics.converged: false` and no fabricated finite answer.
3. A mathematically undefined output is represented as `null` or omitted with
   a warning and explicit reason—not as `NaN` or `Infinity` in a successful
   result.
4. Every successful result is recursively JSON-safe unless the API explicitly
   returns a non-serializable artifact.

Add a generic postcondition in explained/pro boundaries:

    assertFiniteResult(result, {
      allowNullFor: ["lambda"],
    });

It should inspect typed arrays and matrices as well as records. Kernels may
retain IEEE-754 behavior for speed, but high-level APIs should convert it into
the documented outcome model.

### Fix finite-difference boundary stencils

`finiteDifferenceExtendedGreeks` uses a default volatility bump of `1e-3`.
For a valid volatility below that value, the central stencil evaluates a
negative bumped volatility. Use adaptive bumps:

- cap the bump relative to the base value;
- switch to a higher-order one-sided stencil near a hard boundary;
- report actual bump sizes in diagnostics;
- test continuity across the switch.

Apply the same rule to time, spot, intensity, and any other non-negative model
parameter.

### Make error guards realm-safe

`isQuantError` should not rely only on `instanceof`. Duplicate dependency
versions, workers, VM contexts, or separately bundled copies can break identity
checks. Add a stable brand and structural fields such as error family, code,
and error schema version. Keep `instanceof` as a fast path.

## Decision 7: make engines genuinely substitutable

The `OptionPricingEngine` interface is a strong abstraction, but
`supports(contract)` is not enough to explain what an engine can return.

### Add capability metadata

An engine should expose machine-readable capabilities such as:

    interface OptionEngineCapabilities {
      styles: readonly OptionStyle[];
      value: true;
      firstOrderGreeks: "analytic" | "finite-difference" | "stochastic" | false;
      extendedGreeks: "analytic" | "finite-difference" | "stochastic" | false;
      errorEstimate: boolean;
      deterministic: boolean;
      discreteDividends: boolean;
    }

Then `option.price` can validate a request before spending compute and can
teach the user which engine to select.

### Enforce a parameterized engine contract suite

Every built-in and custom-engine fixture should run the same tests:

- supported/unsupported styles;
- `greeks: false`;
- `extendedGreeks: true`;
- deterministic results and seed behavior;
- discrete-dividend handling;
- non-finite postconditions;
- diagnostics and assumptions;
- direct engine calls versus `option.price`;
- serialization of results.

This would have caught the BSM and Black-76 behavior immediately.

### Validate and freeze custom definitions

`defineOptionPricingEngine` should be more than an identity helper. Validate
the shape, require a version and capabilities, and freeze the public definition
so registrations cannot mutate underneath a backtest.

### Simplify engine comparison

`compareEngines` should take one config object, report each engine's
capabilities and actual settings, and make the reference engine explicit.
Engine comparison is a report/analysis role, not a positional helper.

## Decision 8: preserve composability while reducing aliases

Aliases help users arrive from other ecosystems, but every alias is another
name to document, search, maintain, and preserve under semver.

Use aliases only for:

- an industry-standard spelling;
- a compatibility name with measurable adoption;
- a deliberate migration path.

Every alias should point to one canonical operation in the public manifest and
be excluded from primary autocomplete examples where possible. Avoid exporting
both a function and an eponymous namespace at the same level.

The TA registry is the right place to support broad compatibility names because
discovery is a first-class feature there. That does not mean all aliases need
to become root exports.

## Decision 9: standardize single, batch, streaming, and “into” APIs

The existing batch and streaming work is strong but should share vocabulary
across domains.

Recommended convention:

- `price(input)` — one item;
- `priceMany(batch)` — allocates and returns a batch result;
- `priceInto(batch, output)` — writes into caller-owned storage;
- `createPriceStream(config)` or a domain-specific artifact — incremental
  updates;
- `serialize`/`deserialize` or `toJSON`/`fromJSON` — one consistent persistence
  pair.

For batches, standardize:

- row-major versus columnar inputs;
- equal-length checks;
- scalar broadcasting;
- output allocation;
- per-row errors versus fail-fast behavior;
- typed-array preservation;
- missing-value policy.

Do not force a data-frame dependency into the compute core. Arrays, typed
arrays, iterables, and explicit columnar objects are a good portable base.

## Decision 10: raise numerical trust from strong internal testing to public certification

The branch has excellent test volume, coverage, golden vectors, analytic versus
finite-difference comparisons, and Monte Carlo checks. Those prove consistency
with the repository. They do not, by themselves, prove agreement with
independent implementations or published market conventions.

### Build a versioned validation corpus

For each domain, publish fixtures containing:

- inputs and units;
- expected output;
- tolerance and valid parameter range;
- reference implementation, paper, or exchange convention;
- known differences;
- library and conventions version.

Use independent references where practical—QuantLib or published formulas for
pricing and curves, TA-Lib for compatible indicators, canonical optimization
and risk papers, and exchange specifications for instrument conventions.
Cross-checking two functions that share a helper is not independent evidence.

### Add property and metamorphic tests

Examples:

- option bounds, put-call parity, monotonicity, homogeneity, and limiting
  behavior;
- convergence of trees/PDE/Monte Carlo toward closed form where assumptions
  overlap;
- no-arbitrage and calendar/butterfly conditions for surfaces;
- positive-semidefinite covariance postconditions;
- portfolio weights satisfying constraints;
- return aggregation and attribution conservation;
- round-trip serialization;
- scale and translation invariants where mathematically valid.

### Test edge grids, not only representative points

Every model should include generated grids near:

- zero time, volatility, rate, intensity, and variance;
- extreme moneyness;
- negative rates;
- singular/collinear matrices;
- underflow and overflow;
- boundary correlations and probabilities;
- discontinuities such as barriers and digital strikes.

The success criterion is not always “finite number.” It is the documented
outcome policy: finite value, typed invalid-input error, or honest
non-convergence/undefined result.

### Keep performance evidence separate

Bundle size and runtime benchmarks are useful, but they should not determine
the public API. Benchmark representative single calls, vector batches,
calibration, Monte Carlo, and streaming updates in Node and browsers. Add
WebAssembly or native acceleration only after profiles identify a bottleneck;
the current pure TypeScript base is a major adoption advantage.

## Decision 11: make runtime support a deliberate product decision

The packages currently publish ESM-only exports and require Node 18 or newer.
That combination needs revision before a broad launch.

As of this review, Node 18 and 20 are end-of-life, while Node 22 and 24 are LTS:
[official Node release schedule](https://nodejs.org/en/about/previous-releases).
Test supported LTS lines rather than advertising an old minimum without CI
coverage.

### Recommended launch decision: ESM-only, tested interop, evidence-gated CJS

Keep one ESM implementation initially. Add a `default` export target only after
packed-tarball fixtures prove that modern supported Node versions can
`require()` the synchronous ESM graph. Describe that accurately as
`require(ESM)` interoperability, not as a CommonJS build.

This is simpler than publishing two module graphs and is a reasonable choice
if the package raises or narrows its runtime promise to versions where
`require(ESM)` is available. It does **not** make `require()` work across the
currently advertised Node 18 range, and an export condition alone is not a
substitute for testing CommonJS-oriented TypeScript, test-runner, and bundler
consumers.

Ship a real CJS build only if the consumer matrix or adoption evidence shows
that important supported environments still need one. The decision should be
made from packed-package evidence, not from either “ESM is modern” or “maximum
adoption requires dual output” as an article of faith.

### Test real consumer matrices

Create packed-tarball fixtures for:

- Node ESM and, if supported, CommonJS;
- TypeScript `node16`/`nodenext` and `bundler` resolution;
- Next.js, Vite, and a no-bundler Node app;
- browser and Web Worker builds;
- Bun and Deno if claimed;
- Windows, macOS, and Linux;
- minimum and current supported TypeScript.

TypeScript's library guidance recommends checking code under strict,
Node-compatible settings and notes that source/declaration maps are useful only
when the source is also shipped:
[TypeScript library compiler guidance](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html#im-writing-a-library).

### Fix source debugging

The packages emit source maps that point at source files not present in the
packed tarball and do not embed `sourcesContent`. Either:

- ship the relevant `src` files;
- enable inline source content; or
- omit misleading maps.

For a library whose users may need to audit numerical implementation, working
Go to Definition and stack traces are worth the small package cost.

### Broaden purity and bundle gates

Purity lint currently protects only a subset of the browser-safe packages.
Apply it to every compute package except the explicitly server-only MCP/CLI
layer. Bundle budgets should include:

- umbrella root and domain subpaths;
- each large package root;
- the newest vol and options entry points;
- one representative application bundle.

The current selected deep-import budgets pass and tree-shaking is good. The
remaining concern is unbundled umbrella startup: static namespace exports
evaluate every imported domain.

## Reconciliation with the companion lovability review

The companion
[`library-lovability-review.md`](./library-lovability-review.md) is a strong,
independent review with a different center of gravity. Its hands-on,
first-time-user probes are better at finding immediate paper cuts; this
assessment is stricter about public-contract architecture, invalid financial
states, numerical postconditions, and long-term conformance. Neither replaces
the other.

The companion has now cross-reviewed this document as well. That exchange
materially improves the combined recommendation: it adopts the manifest,
contract, unit, engine, topology, and non-finite-result findings here, while
this assessment adopts its concrete first-use defects and relaxes two overly
rigid recommendations of its own. The remaining disagreements are product
choices and are settled below so implementation does not oscillate between
documents.

### Comparative verdict

The companion is the stronger tactical defect audit. This assessment is the
stronger pre-1.0 API constitution. Use the former as a verified bug and
first-journey backlog; use this one to decide what the repaired surface should
look like and how CI will keep it coherent.

I do not agree that the architecture itself is already 10/10. The internal
principles are exceptional, but public architecture includes type validity,
result laws, package topology, engine substitutability, unit semantics, and
runtime contracts. Those are precisely where the largest unresolved decisions
remain. The companion's revised cross-review narrows its overall estimate to
roughly 7.5–8; this assessment now lands at **approximately 7.5/10 against the
stated global, any-language ambition**. The numerical difference is mostly the
denominator, not a disagreement about the backlog.

Claims such as “best in any language” should remain an aspiration until backed
by reproducible comparative journeys and independent numerical validation.
The library has several genuinely best-in-class ideas; that is different from
having demonstrated best-in-class total experience.

### Verified findings adopted from the companion

These are not stylistic preferences. They were reproduced against the built
packages or confirmed directly in source. The current status matters:
`dc30c347` closes the first six, while the rest remain actionable.

| Finding                           | Status at `dc30c347` | Assessment                                                                                                                                                       |
| --------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README RSI example                | **Resolved**         | Examples use enough observations to produce a value, and tests assert the final RSI numerically.                                                                 |
| Strategy guide                    | **Resolved**         | The headline example uses current fields and executes in a dedicated guide harness.                                                                              |
| TA positional parameters          | **Resolved**         | The common resolver rejects every defined non-object params value with a typed teaching error.                                                                   |
| Position first touch              | **Resolved**         | Chart/scenario methods have shared sensible ranges or guards, accept arrays where natural, and all public methods are covered by a completeness-checked ratchet. |
| Named leg direction               | **Resolved**         | Named-direction builders require a positive quantity and direct users to the opposite or raw builder.                                                            |
| Backtest signal example           | **Resolved**         | The example uses a persistent regime, and `latchSeries` converts entry/exit events into a held position.                                                         |
| Time input                        | **Open**             | `resolveAsOf(NaN)` returns `NaN`. Every accepted time representation needs a finite-value postcondition.                                                         |
| MCP option journey                | **Open**             | Flagship pricing accepts `t` but not `expiry` plus `asOf`, forcing agents to perform calendar math. Accept both and echo the resolved year fraction.             |
| MCP drift                         | **Open**             | Tool counts, “packs” terminology, and the documented seed default drift from runtime behavior. Generate registry facts and align seed policy.                    |
| MCP IV schema                     | **Open**             | Critical fields lack unit descriptions and suspicious-unit diagnostics. Build from the canonical described shape.                                                |
| Error registry                    | **Open**             | Timezone, linear-algebra non-convergence, and wrong-shape paths do not consistently use the central registry. Add a source-wide conformance test.                |
| Fixed-income naming               | **Open**             | `zeroRate` both constructs and queries a curve. Deprecate the builder alias in favor of `fromZeroRates`.                                                         |
| Discoverability gaps              | **Open**             | Risk lacks a cohesive returns-to-covariance-to-optimizer path; flagship JSDoc is thin; bar ingestion needs a visible adapter.                                    |
| Plausibility and stream semantics | **Open**             | Rates lack the scale warning used for volatility/time, and TA `update()` means non-committing peek while `next()` commits. Make both behaviors explicit.         |

One factual correction matters. The companion originally characterized
`QuantError` as serializing to `{}`. In the current build it serializes
enumerable `name`, `code`, and `context` fields; the missing field is `message`.
The conclusion still stands in narrower form: add an intentional, versioned
`toJSON()` containing `name`, `message`, `code`, and JSON-safe context, and
test round trips. Do not carry the inaccurate `{}` claim into issues or
release notes.

### Final decisions where philosophy differs

#### 1. Fix trust breakers first, but do not confuse patches with the API pass

The companion is right that small, user-visible correctness bugs should not
wait behind an architecture program. `dc30c347` has already landed the TA
parameter guard, named-leg quantity guard, Position method repair/ratchet,
signal correction, and broken-example fixes. Invalid time handling,
engine-option drift, and non-finite success states should follow immediately.

It is too optimistic to characterize the entire pre-1.0 list as hours of work.
Individual patches are small; choosing the taxonomy, migrating exports and
result types, preserving compatibility, generating the manifest, and testing
packed consumers is a deliberate product pass. Treat first-journey defects as
urgent patches and the coherence work as the next focused milestone. Both are
P0 for different reasons.

Documentation defects are release blockers, but they do not need to dictate
the library architecture. The three broken opening examples are now corrected;
complete the broader documentation system after the surface stabilizes, as
described at the end of this document.

#### 2. Standardize gestures by role, not by forcing every function into a facade

The companion's “plain value plus `.explain()`” recommendation is right for
scalar convenience calls such as price, return, spread, or expected move. It
should not be imposed on calibration, optimization, scenario, attribution, or
backtest operations whose diagnostics are inseparable from a responsible
answer.

The final law is:

- facade: plain answer, with the same call exposed through `.explain()`;
- analysis/report: rich result on the primary call;
- artifact/factory: immutable domain object with explicit serialization;
- kernel: lean numeric result and documented IEEE-754 behavior.

That provides one predictable gesture **per role** and avoids both permanent
`.value` tax on simple calls and hidden diagnostics on professional analyses.

#### 3. Keep a curated flagship root, not a wildcard root

The companion makes the stronger case that `import { bs } from "totalfinance"` is
worth preserving. This assessment therefore changes its original
namespace-only recommendation.

The compromise is not the current flat options surface. The umbrella should
export domain namespaces plus a tiny manifest-declared flagship hoist, with
`bs` as the clearest candidate. Raw kernels, constants, schemas, and the long
tail remain in domain or expert subpaths. This preserves a memorable opening
move without making every future domain compete for root names.

#### 4. Vocabulary should encode semantics, not enforce verbosity

The companion is right to preserve `bs.call({ spot, strike, t, rate, vol })`.
Inside a model-specific facade those names are compact and clear. This
assessment remains stricter where a value crosses model boundaries:

- use `impliedVolatility` for a market IV quote in domain objects;
- use `lognormalVolatility` or unambiguous `volatility` for lognormal models;
- use `normalVolatility` in pro objects and `normalVol` in the compact
  Bachelier facade;
- use `riskFreeRate` in reusable market objects and `rate` in compact model
  facades;
- use `expiresAt`/`asOf` in contracts and markets, and `t` only where the
  model-specific context clearly means year fraction.

Do not standardize every public field to `vol`; that recreates the Bachelier
unit collision. Do not rename every compact field to its longest form either.

The same semantic approach resolves `fit` versus `calibrate`. Use `fit` for
historical/statistical estimation and `calibrate` for matching parameters to
market instruments or quotes. Fix current violations and acronym casing; do
not choose one verb globally when the distinction teaches something useful.

#### 5. Launch ESM-only, but call `require(ESM)` what it is

The companion's ESM-only recommendation is reasonable for current supported
Node lines, and this assessment adopts it as the initial launch choice. Adding
a `default` condition may let modern Node `require()` the ESM graph, but it
does not create CommonJS output and it does not solve the currently advertised
Node 18 range.

The release gate is a packed-tarball matrix, including synchronous graph
verification, Node/TypeScript module modes, test runners, and bundlers. Raise
or clarify the runtime floor, document ESM and `require(ESM)` separately, and
add true CJS only if real supported consumers require it. Avoid both a
speculative dual build and an untested compatibility claim.

#### 6. Generate MCP from a manifest without exposing the whole library

The companion is right that 20 curated tools are not inherently “small and
arbitrary.” Discovery tools are better than hundreds of one-indicator tools.
The correct design is a curated, manifest-backed allowlist:

- the manifest prevents schema, name, unit, and availability drift;
- the allowlist decides which operations make sense for agents;
- packs let hosts opt into coherent domain groups;
- capabilities/resources expose what is deliberately unavailable.

Generation is a consistency mechanism, not a command to publish every runtime
export as a tool.

#### 7. Expose cohesive domain journeys, not miscellaneous re-exports

The companion correctly identifies covariance discoverability as a real risk
package problem. Re-exporting the raw math helper from `@totalfinance/risk` would
improve today’s journey, but it blurs ownership.

Prefer a cohesive `risk.covariance(...)` or `risk.fromReturns(...)` operation
that delegates to the math implementation, uses risk-domain orientation and
diagnostics, and flows directly into optimizers. Keep
`math.estimateCovariance` available for numerical users. The implementation
can be shared without making the high-level risk API a miscellaneous barrel.

#### 8. Keep domain contracts complete; introduce smaller pricing specs

Do not make `OptionContract.underlying` optional merely because a closed-form
formula does not need it. A domain contract represents an instrument and
should retain identity, expiration, exercise, and settlement semantics.

Instead, define a smaller model-specific pricing input for pure formulas. This
separates “what the instrument is” from “the minimum scalars this kernel
needs” without weakening the domain type.

Likewise, a zero interest-rate default should not silently enter a quant-core
structure or historical engine. Require a rate/curve in the professional path,
or provide an explicitly named simplified helper that returns the assumption
and a diagnostic. Convenience is valuable; invisible economics are not.

#### 9. Prefer adapters to silent vocabulary proliferation

Accepting `time`, `timestamp`, and `ts` everywhere feels friendly initially but
creates ambiguous precedence and expands every schema. Keep one canonical bar
record and provide a visible `backtest.barsFrom(...)` adapter with mappings for
common ecosystems. Errors should link directly to that adapter.

The generic option expiry behavior is more severe than a naming issue. A
hard-coded US close for every date-only contract can change valuation and
exercise semantics; it belongs in P0 contract correctness, not a later polish
bucket.

## Recommended target experience

The exact names can evolve, but this is the level of predictability to target.

### Five-minute path

    import { options } from "totalfinance/options";

    const contract = options.contract.usEquityCall({
      symbol: "AAPL",
      strike: 200,
      expiryDate: "2026-09-18",
    });

    const result = options.price({
      contract,
      market: {
        asOf: "2026-07-17T20:00:00Z",
        spot: 195,
        riskFreeRate: 0.043,
        dividendYield: 0.005,
        volatility: 0.28,
      },
    });

    console.log(result.value, result.greeks?.delta);
    console.log(result.assumptions, result.diagnostics);

Expected behavior:

- the builder encodes American exercise and the exchange expiration instant;
- the default engine supports the contract;
- the result says which engine was selected;
- units and time conventions are explicit;
- no hidden clock or data request occurs.

### Compact model path

    import { bs } from "@totalfinance/options/black-scholes";

    const price = bs.call({
      spot: 195,
      strike: 200,
      t: 63 / 365,
      rate: 0.043,
      dividendYield: 0.005,
      vol: 0.28,
    });

    const explained = bs.call.explain({
      spot: 195,
      strike: 200,
      t: 63 / 365,
      rate: 0.043,
      dividendYield: 0.005,
      vol: 0.28,
    });

This existing pattern is already close to ideal.

### Expert kernel path

    import { bsmPrice } from "@totalfinance/options/kernel";

    const value = bsmPrice("call", 195, 200, 63 / 365, 0.043, 0.005, 0.28);

The import itself tells the reader that validation, metadata, and argument
safety are intentionally lower-level.

## Prioritized implementation plan

### Completed in the latest follow-up

Commit `dc30c347` closes the six highest-friction first-use items: semantic RSI
examples, the strategy guide, primitive TA params, public `Position` method
defaults/guards, named-leg direction validation, and crossover-to-position
semantics with `latchSeries`. Keep those tests as permanent gates.

### P0: before declaring the API stable

1. **Close the remaining boundary trust breaker.** Reject non-finite numeric
   time inputs such as `resolveAsOf(NaN)` through the shared time grammar.
2. **Enforce JSON-safe successful results.** Fix option lambda, crypto
   compounding, finite-difference boundaries, and every other valid-input path
   that returns non-finite output while claiming success.
3. **Enforce the covariance front-door postcondition.** Guarantee SPD via a
   documented fallback/eigenvalue floor, warn on every failed postcondition,
   and make the single-index market factor explicit.
4. **Fix engine substitutability.** Honor `greeks: false` everywhere and add a
   shared capability-aware engine contract suite.
5. **Redesign option contracts.** Require meaning-changing fields, add
   instrument-specific builders, use exact expiration instants, and remove
   representable unsupported Bermudan contracts.
6. **Make builders valid-by-construction.** Validate contract and market
   objects at creation.
7. **Create the public-surface manifest and classify every runtime export.**
   Generate API inventory, export-map tests, first-touch coverage, and MCP
   eligibility from it.
8. **Adopt the four public roles.** Standardize the result gesture by role,
   move raw positional functions behind expert subpaths, and make high-level
   operations object-based.
9. **Settle topology and semantic vocabulary.** Use domain namespaces plus a
   bounded flagship hoist, remove duplicate namespace levels, add symmetrical
   subpaths, and distinguish normal/lognormal/implied volatility.
10. **Remove the hard-coded historical rate default.** Require an explicit
    constant, snapshot rate, function, or curve.

### P1: before a broad public beta

1. Add the cohesive risk returns-to-covariance-to-optimizer journey while
   retaining `math.estimateCovariance` for numerical users.
2. Lock the error-code registry and add explicit, versioned
   `QuantError.toJSON()` behavior.
3. Clarify TA stream commit/peek naming, provide canonical bar adapters, add
   rate plausibility warnings, and complete flagship JSDoc.
4. Finish MCP's library contract: expiry/as-of inputs, canonical IV field
   descriptions, aligned seed defaults, generated registry facts, and
   coherent opt-in packs.
5. Add engine capabilities and validate/freeze custom engine definitions.
6. Generate complete feature subpaths from the public manifest.
7. Standardize single/many/into/stream/serialization conventions.
8. Build the independent validation corpus and edge-grid/property suites.
9. Test packed consumers across supported runtimes, module systems, operating
   systems, TypeScript modes, and bundlers.
10. Fix source-map/source publication.

### P2: before a 1.0 promise

1. Publish explicit stability levels by package and operation.
2. Run API usability studies with first-time users and measure time to first
   result, correction rate, and documentation lookups.
3. Publish performance baselines and numerical validation reports.
4. Lock semver, deprecation, compatibility, and conventions-version policies.

## Acceptance gates for a 10/10 library surface

The API-coherence pass is complete when all of these are true:

- every runtime export is classified in the manifest;
- every common task has exactly one canonical first move;
- no high-level operation has a long positional numeric signature or multiple
  positional discriminators;
- raw kernels are absent from general package and umbrella roots;
- package roots and umbrella subpaths follow one topology;
- no duplicate paths such as `technical_analysis.ta` exist;
- contract builders reject invalid values and do not choose an unsafe exercise
  style implicitly;
- date-only labels are resolved only through an explicit instrument convention;
- every engine passes the same request/result contract tests;
- `greeks: false` and other shared options mean the same thing for every
  engine;
- every successful public result is JSON-safe;
- every undefined or non-converged quantity carries an explicit reason;
- every Greek and volatility field has an unambiguous unit/convention;
- all public examples compile and run against packed tarballs;
- all supported runtime and module-resolution fixtures pass;
- each quantitative domain has independent reference fixtures and property
  tests.

If these gates pass, the library will not merely contain impressive
functionality. It will feel coherent, safe, and learnable.

## Later shipping layer

The following work matters for ultimate adoption, but it should follow the
library-surface decisions above. The SDK and MCP should be projections of the
same public manifest, not separate hand-curated products.

### SDK and MCP

The current MCP package has a good compute-first premise, strong tool
descriptions, structured output schemas, and unit-aware inputs. The default
registry currently exposes 20 deliberately curated tools with useful discovery
companions. That granularity is sound. Its selection and metadata are still
hand-maintained and have drifted, and the newest crypto, vol, risk,
fixed-income, and advanced options capabilities are not represented.

Recommended later work:

- generate tool registration from the public-surface manifest, with an explicit
  allowlist for operations that are useful and safe for agents;
- let option pricing accept `expiry` plus `asOf` as well as explicit `t`, and
  return the resolved year fraction and convention;
- generate tool counts and pack descriptions; align the schema's seed default
  with runtime policy;
- derive implied-volatility schemas from the canonical unit-described shape
  and run plausibility diagnostics on that path;
- preserve domain names and result semantics from TypeScript instead of
  inventing an MCP-only vocabulary;
- retain full input/output types in `ToolDefinition<I, O>` rather than erasing
  them to `unknown` and generic records;
- allow synchronous or asynchronous handlers and pass a context containing
  `AbortSignal`, deadline, logger/trace metadata, and request identity;
- enforce deadlines cooperatively, not only by checking elapsed time after a
  synchronous computation has finished;
- count input limits in UTF-8 bytes rather than JavaScript UTF-16 code units;
- make row/result limits operation-aware;
- expose engine/model discovery and conventions as resources;
- use data handles or resource links for large tables instead of placing every
  row in tool output;
- add standard read-only/idempotent/closed-world annotations;
- support Streamable HTTP in addition to stdio when remote deployment begins;
- provide CLI flags for transport, limits, tool allowlists, logging, and
  version/capabilities.

MCP tools support structured output schemas, annotations, and resource links,
and the standard transports include stdio and Streamable HTTP:
[MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
and
[MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

The SDK should remain a thin, typed composition layer. Avoid a second set of
calculation implementations. It may add configuration, provider registration,
data handles, caching, and orchestration, but all numerical behavior should
delegate to the same package operations and return the same result contracts.

## Known deferred gap: data layer

The compute library correctly avoids hard-wiring a market-data vendor. The
eventual data layer should be optional and protocol-driven:

- provider interfaces for historical bars, quotes, chains, curves, corporate
  actions, and reference data;
- normalized domain records with provenance, timezone, adjustment, and quality
  metadata;
- adapters in separate optional packages so compute users do not install
  vendor SDKs;
- lazy pagination/streaming and cancellation;
- cache keys that include provider, dataset version, adjustment rules, and
  query parameters;
- data handles for MCP and remote SDK use;
- explicit conversion to arrays, typed arrays, iterables, and Arrow-compatible
  tables;
- no provider network calls from compute functions;
- fixture providers for reproducible examples and tests.

The data layer should consume the same contract, time, unit, and error
conventions decided in the library pass. Building it first would fossilize the
current ambiguities.

## Known deferred gap: documentation and open-source shipping

Documentation is not the present focus, but the repository cannot yet be
presented as a finished public product. Commit `dc30c347` did close the three
most damaging opening-example failures: the README now produces a real RSI,
the strategy guide executes against current inputs, and the backtest example
teaches a held regime rather than a one-bar crossover event. The remaining
shipping drift is:

- top-level material still says phases 0–5 in places even though phase 6 and
  substantial later work exist;
- it still advertises 2,178 tests versus the current 5,979;
- package/tool counts are stale after the crypto package and MCP additions;
- the documented “two API shapes” law does not match runtime behavior;
- package repository/homepage links target a repository that is not currently
  available;
- source maps do not provide working source navigation in packed consumers.

After the API is settled:

- generate a searchable reference from the public manifest and TypeScript
  declarations;
- maintain one tested five-minute guide per domain;
- assert meaningful values and semantics in every executable example, not
  merely compilation and absence of exceptions;
- add task-oriented cookbooks, model-selection guides, convention pages, and
  “when not to use this” sections;
- compile and execute every code sample in CI against packed packages;
- publish validation reports and compatibility matrices;
- show result assumptions and diagnostics in examples, not only scalar output;
- explain simple, analysis, artifact, and kernel layers once and reuse that
  grammar everywhere;
- automate package/test/tool counts rather than writing them by hand;
- complete release provenance, package signing/attestations, changelogs,
  security policy, contribution workflow, governance, issue templates, and
  support expectations;
- ensure the umbrella participates in the same changeset/version policy as all
  scoped packages.

Documentation can make a coherent API easy to discover. It cannot make an
incoherent API predictable. The library decisions in this assessment should
therefore land first, and the shipping layer should be generated from them.
