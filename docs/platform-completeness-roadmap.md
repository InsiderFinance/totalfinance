# TotalFinance platform-completeness roadmap

> **Status:** proposed north-star product and architecture direction, written against `8a29ed21`
> on 2026-07-21. This document describes how TotalFinance grows from an unusually broad compute library
> into a complete quantitative platform without burying the formulas that made it useful in the
> first place. Core-function status was refreshed after the Phase 3A closeout on 2026-07-22.
>
> This is deliberately a different document from the existing trackers:
>
> - [`implementation-order.md`](./implementation-order.md) is the authoritative global execution
>   sequence. This document supplies the architecture and dependency order inside its platform-core
>   stage; it is not a second “current phase” tracker.
> - [`library-alignment-spec.md`](./library-alignment-spec.md) is the authoritative contract and
>   Phase 3A/3B status record; its Phase 3A function-shape correction completed on 2026-07-22 and is
>   protected by generated declaration gates. The
>   [Phase 3B.N naming spec](./specs/phase-3b-public-naming-normalization.md) owns the final public
>   vocabulary used by this roadmap's target examples.
> - [`specs/finance-portfolio-backtesting-completeness.md`](./specs/finance-portfolio-backtesting-completeness.md)
>   is the accepted feature-completeness contract for the missing finance/research foundations,
>   durable portfolio implementation, and portfolio-scale backtesting. Where this north-star roadmap
>   is broad, FC0–FC9 supplies the concrete package owners, public capabilities, semantics, sequence,
>   and acceptance gates.
> - [`roadmap.md`](./roadmap.md) is the broad inventory of individual models, analytics, and feature
>   follow-ups.
> - this document is the **platform spine**: the permanent layering rules, the major product
>   programs, and the release gates that turn those capabilities into complete user journeys;
> - [`mcp-acceleration-data-growth-strategy.md`](./mcp-acceleration-data-growth-strategy.md) is the
>   detailed execution strategy for MCP, WASM/acceleration, data connections, and the
>   InsiderFinance subscription flywheel;
> - [`agent-native-portfolio-and-trading-platform.md`](./agent-native-portfolio-and-trading-platform.md)
>   is the focused strategy for durable portfolio truth, protocol-neutral operations, trading-agent
>   simulation/evaluation, safe proposals, and the separate boundary to broker execution;
> - [`data-layer.md`](./data-layer.md) is the earlier provider design. Where the later MCP/data
>   strategy deliberately revises it—especially provider capabilities, query results, handles, and
>   first-party data—the later strategy controls.

## Executive decision

TotalFinance should become more complete by **adding a continuous ladder of capability**, not by
replacing small functions with a mandatory framework.

The north star is:

> A developer can get one trustworthy number in one line, inspect or replace the exact mathematical
> kernel, scale the same semantics to a chain or portfolio, connect data, run research, monitor the
> result live, and ask an agent to explain it—without changing libraries or discovering a second
> implementation of the math.

That implies three permanent decisions:

1. **Every layer is a first-class product.** Math functions, model kernels, facades, domain objects,
   compositions, workflows, and transports remain independently usable. A higher layer is an
   option, not a toll booth.
2. **Higher layers call lower public layers.** They may optimize through a proven equivalent batch
   kernel, but they do not hide, fork, or privately reimplement the calculation.
3. **Completeness is measured by journeys, not export count.** TotalFinance already has extraordinary
   model breadth. The biggest remaining opportunity is making the path from a formula to a real
   analysis feel continuous, inspectable, reproducible, and fast.

The current code is already pointed in this direction. It has a friendly Black–Scholes facade, a
direct expert kernel, a professional contract/market API, columnar batch functions, and direct
position payoff methods. Those layers are not transitional APIs to be pushed down and forgotten.
Their availability is the foundation to preserve; this document separately recommends correcting
the expert kernel's former long positional signature. Phase 3A has now implemented that correction
without removing raw access.

## Price and payoff are different operations

It is worth being precise because the distinction shapes the API:

- **Black–Scholes–Merton price** is a model value before expiration. It uses spot, strike, time,
  rates, dividends, and volatility.
- **Expiration payoff** is the contract's terminal cash value. A vanilla call's gross payoff is
  `max(S_T - K, 0)`; no Black–Scholes model is required.
- **Expiration P&L** subtracts the premium and applies side, quantity, and multiplier. A strategy
  payoff adds those values across legs.

All three should be easy, but they should not be collapsed into one ambiguous function.

### Raw Black–Scholes is public and now named-object safe

The direct kernel remains available from the model subpath. Before Phase 3A it took seven positional
arguments, which allowed multiple plausible financial transpositions to type-check. It now takes one
required named object:

```ts
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const price = blackScholesPrice({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  dividendYield: 0,
  volatility: 0.22,
});
```

Keeping a direct expert kernel was right. Keeping the former positional shape was not.

The six financial coordinates are all numbers. In the former positional call, transposing spot and
strike, risk-free rate and dividend yield, or time and volatility still type-checked and often
returned a plausible number. The expert import path reduced autocomplete clutter, but it could not
make TypeScript catch that silent economic error. Phase 3B.N also replaces the baseline `t`/`rate`/
`vol` object keys with the explicit names shown above.

The raw object requires every financially meaningful field, including `dividendYield`. Phase 3B
requires its public boundary to enforce the closed object, required fields, primitive types, and
finite-input contract at runtime. It may still omit facade conveniences, plausibility warnings,
defaults, envelopes, and `.explain()`. **Raw means direct and assumption-light; it does not mean
positional or malformed-input tolerant.**

Phase 3A applied the same named-object rule to the Black-Scholes Greeks, extended Greeks, price
bounds, and raw implied-volatility solver, with each operation requiring only the fields it actually
consumes. Phase 3B.N gives those exports their final `blackScholes*` names. The object rule extended
to public financial kernels with long homogeneous scalar lists, including Black-76 and Bachelier. It
did not mechanically convert ordinary mathematical calls whose positions are unmistakable, such as
`normalCdf(x)`, `dot(a, b)`, or a one-subject method such as `position.pnlAtExpiry(spot)`.

Internal financial call sites migrated to named objects too. Internal code is written and changed
by humans, and it can swap two numbers just as easily as user code. There is no reason to preserve a
positional implementation preemptively. Tight loops should use the existing columnar
`blackScholesPriceMany`/`blackScholesPriceManyInto` contracts after the naming migration.

A local alternating-order scalar sanity benchmark while reviewing this decision put both the
positional call and a named-object wrapper in roughly the same 17–18 million-calls/second range, with
no stable material difference. That is not a release benchmark and should not become a performance
claim. It is sufficient to reject the unmeasured assumption that a cross-module positional API must
be retained for speed.

The closeout adds a committed 100,000-row mixed-contract benchmark for the named scalar kernel, the
allocating columnar batch API, and the caller-owned-buffer batch API, plus semantic parity across the
raw, facade, professional, and batch layers. It is executable evidence, not a universal throughput
claim.

Only a reproducible profile may justify a file-private scalar inner loop. If one is ever necessary,
it must sit behind the object-shaped function in the same module, have no cross-module call sites,
and pass scalar/object/batch parity tests. It is a local compiler-level optimization, not part of the
architecture or API. Do not publish both shapes as overloads: the project is pre-1.0, so migrate once
instead of preserving ambiguity as compatibility clutter.

This changed argument safety, not mathematical accessibility. The same model subpath remains the
stable expert home, and the function still returns the direct scalar result.

### Why the positional signature passed the prior review

It did not escape notice. Both independent reviews explicitly converged on this taxonomy:

- user-facing facades and analyses use object inputs;
- long positional signatures are removed from general roots;
- positional numeric signatures are allowed for exports classified as expert kernels;
- expert kernels live only on explicit model or `/kernel` subpaths.

Moving expert kernels off general roots was a real topology improvement. Using that location to
excuse an unsafe argument shape was not defensible against the stated P0, and it is why the alignment
spec incorrectly classified the current BSM signature as compliant. A subpath is an organization and
intent signal; it is not protection against six same-typed financial inputs being swapped.

The review-method failure had four parts:

1. it conflated **raw/expert** with **positional/low-ceremony**, even though named fields do not add
   model semantics, validation, or defaults;
2. it repeated a performance justification without a benchmark, while TotalFinance's actual throughput
   contract is already the columnar batch API;
3. it accepted root curation as evidence of call safety even though import location cannot prevent a
   scalar transposition; and
4. it treated convergence between two reviews as confidence, although both reviews inherited the
   same premise and the mechanical gate was blind to declarations.

The tightened rule should be:

> Positional arguments are acceptable when their roles are naturally unmistakable. Public financial
> kernels with several interchangeable scalar inputs use one flat named object. Financial-domain
> internals follow the same rule by default, and public high-throughput paths use columnar inputs.

This is a focused correction to the earlier review philosophy with a surface-wide implementation
blast radius. It does not reverse root curation, facade/pro layering, or raw-kernel access.

### This was a surface-wide P0, not a BSM-only patch

An initial TypeScript-compiler inventory run while preparing this correction found:

- **53 financial-kernel callable surfaces with three or more arguments** across options,
  fixed-income, and volatility. This count includes multiple public paths to the same implementation,
  but every path is still part of the user-visible API.
- **26 facade/analysis/artifact callable surfaces with three or more arguments** in the non-TA
  domain packages.
- **54 signatures with at least three primitive arguments** across all scoped packages. That set
  includes legitimate natural mathematics and date helpers, so it is an audit candidate set—not a
  claim that all 54 should become objects.

The completed financial migration audit included:

- BSM, Black-76, and Bachelier price/Greeks/bounds/IV;
- GBM paths/terminals and Monte Carlo pricing;
- Heston, SABR, and local-volatility public scalar/MC entrypoints;
- fixed-income Black/Bachelier rate-option kernels;
- strategy probability helpers with `S0/K/mu/sigma/t` lists;
- volatility evaluators whose scalar coordinates can be confused;
- high-level operations such as engine comparison, parity analysis, portfolio optimizers, exposure,
  and surface construction that still split one conceptual request across several arguments.

Not every positional function is defective. `clamp(value, minimum, maximum)`, `normalCdf(value)`, a
root solver with `(functionToSolve, lowerBound, upperBound, options)`, and
`position.pnlAtExpiry(spotPrice)` have conventional, structurally distinct roles. The mistake was
granting an exception by **role label** (`kernel`) instead of reviewing whether each signature is
safely readable and type-checkable.

The P0 remediation inventoried and classified every declaration-backed exported function, namespace
member, class/interface method, constructor, and method on a returned public artifact: 3,310
callables in total. BSM was the most visible proof that the prior audit boundary was inadequate; it
was not the boundary of the fix.

### Why the conformance system failed to catch it

The completed manifest and conformance work was real, but it enforced the wrong subset of function
shape:

- the runtime manifest records role, kind, entrypoints, result grammar, and per-argument unknown-key
  policy, but not TypeScript parameter names, types, arity, or approved calling grammar;
- the topology gate proves that kernels are absent from general roots, not that their signatures are
  safe;
- API reports snapshot type changes, but do not evaluate a signature against a design rule;
- first-touch fixtures prove selected calls execute and selected wrong calls teach, but do not
  mechanically reject an unreviewed positional signature;
- `kernel`, `helper`, and `trusted` classifications became exemptions through which financially
  meaningful calls could avoid the object-input rule.

The permanent replacement is a generated signature manifest. Every public callable must declare one
of a small set of grammars, for example:

- `object`;
- `series-options`;
- `single-subject`;
- `natural-positional`;
- `columnar`.

Parameter names, types, optionality, and arity come from the TypeScript compiler. A
`natural-positional` entry with multiple same-primitive parameters requires a reviewed rationale;
financial semantics are not enough by themselves. CI fails new or changed signatures until they are
classified, and it fails any callable whose declaration drifts from its approved grammar. The gate
must include namespace members and artifact methods, not only flat runtime exports.

The friendly version is equally public:

```ts
import { blackScholes } from '@totalfinance/options';

const price = blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});
```

The facade supplies named arguments, validation, a default zero dividend yield, and an `.explain()`
companion. It is not a replacement implementation. It routes to the kernel.

The professional contract/market API is another additive level:

```ts
import { market, option } from '@totalfinance/options';

const contract = option.usEquityCall({
  underlying: 'SPY',
  strike: 105,
  expiry: '2026-09-18',
});

const result = option.price({
  contract,
  market: market({
    spot: 100,
    riskFreeRate: 0.045,
    volatility: 0.22,
    asOf: '2026-08-19',
  }),
});
```

This level earns its extra structure by carrying instrument conventions, dates, engine choice,
Greeks, assumptions, and diagnostics. It does not make the one-line or raw paths obsolete.

### Raw strategy payoff is public today and must stay public

The direct position-level expiration P&L primitive is also already available:

```ts
import { legs, strategy } from '@totalfinance/strategy';

const spread = strategy([
  legs.call({ strike: 100, premium: 4.25, quantity: 1 }),
  legs.call({ strike: 110, premium: 1.4, quantity: -1 }),
]);

const pnlAt105 = spread.pnlAtExpiry(105);
const curve = spread.payoff();
```

`pnlAtExpiry` is the raw scalar answer. `payoff` is the chart-ready grid plus metrics. Named strategy
builders, market-aware valuation, probability, scenario tables, optimization, SVG rendering, and
agent explanation all compose above those primitives.

### One small primitive gap is worth closing

TotalFinance does not currently expose a standalone vanilla intrinsic-value function, even though that
same tiny formula appears in option engines, strategy P&L, backtest settlement, structure analytics,
and risk code.

Before 1.0, add one unambiguous expert primitive, tentatively:

```ts
import { vanillaIntrinsic } from '@totalfinance/options/payoff';

vanillaIntrinsic({ type: 'call', underlyingPrice: 112, strike: 100 }); // 12
vanillaIntrinsic({ type: 'put', underlyingPrice: 88, strike: 100 }); // 12
```

The exact name should be settled once, but its semantics should not be overloaded:

- it returns **gross intrinsic value per unit**, not P&L;
- it does not accept premium, quantity, multiplier, probability, volatility, or time;
- a single-contract or multi-leg P&L continues to use `Position.pnlAtExpiry` and `Position.payoff`;
- internal vanilla-expiry calculations should converge on this source of truth where package
  dependency direction permits.

This is a good primitive because it closes a genuine conceptual and implementation seam. It is not
an invitation to publish every private three-line helper.

## The permanent layer model

TotalFinance should have seven independently usable levels. Dependencies point down; data enters through
an edge package and is normalized before compute.

```text
L6  Experiences     MCP tools/resources/Apps, HTTP, notebooks, product UI
                         │
L5  Workflows       connected analyses, research runs, live monitors, reports
                         │
L4  Compositions    chains, surfaces, strategies, books, scenarios, backtests
                         │
L3  Domain API      facades, contracts, market states, pricers, typed artifacts
                         │
L2  Model kernels   BSM, Black-76, SVI, Heston, VaR, optimizers, indicators
                         │
L1  Numerical core  distributions, solvers, interpolation, linear algebra, RNG
                         │
L0  Language data   numbers, arrays, typed arrays, plain serializable objects

Data providers ──normalize + provenance──▶ L3/L4 inputs
Acceleration ──same contract + parity────▶ selected L2/L4 implementations
```

This is a dependency diagram, not an accessibility diagram. Lower layers do **not** become internal
because something is built above them.

### What each layer promises

| Layer                   | Primary user        | Promise                                                  | Typical import or call                         |
| ----------------------- | ------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| Numerical core          | quant implementer   | small, deterministic numerical building blocks           | `@totalfinance/math`                           |
| Model kernel            | expert/hot path     | direct formula, explicit units, minimal ceremony         | `@totalfinance/options/black-scholes`          |
| Domain facade           | most developers     | named inputs, defaults, validation, teaching errors      | `blackScholes.call({...})`                     |
| Professional domain API | application author  | instruments, conventions, market state, rich results     | `option.price({...})`                          |
| Composition             | analyst/team        | many related calculations with one coherent state        | `position.whatIfCube(...)`, `analyzeBook(...)` |
| Workflow                | researcher/operator | acquire, normalize, compute, save, compare, monitor      | provider-bound TotalFinance client             |
| Experience              | human/agent/product | discover and execute workflows through another transport | MCP, visual artifacts, HTTP                    |

The library is lovable only if every row works well on its own and moving down one row remains
possible when a developer needs more control.

## Architecture laws

These laws extend the alignment spec to future platform work. The argument-safety law is now an
executable core invariant established by alignment Phase 3A.

### 1. Directness law

A caller who wants one formula must not construct a client, session, portfolio, provider, market-data
graph, or calculation runner. Direct kernels and facades remain stable public entrypoints.

### 2. Argument-safety law

Public raw financial kernels use flat named objects when several scalar arguments share the same
primitive type and a transposition can produce a plausible answer. Positional calls remain suitable
for unmistakable mathematical signatures and one-subject methods. Financial-domain internals follow
the named-object rule too; a file-private positional inner loop requires profiling evidence and a
single audited object-shaped boundary. Batch throughput uses columnar arrays rather than an unsafe
scalar calling convention.

### 3. Downward-only dependency law

Workflows may depend on compositions; compositions may depend on domain APIs and kernels; transports
may depend on all of them. Compute packages never depend on providers, MCP, hosted services, UI, or
credentials.

### 4. No second engine law

A workflow cannot reproduce BSM, payoff, Greeks, VaR, surface fitting, or indicator math in its own
package. It calls the public primitive or a batch implementation proven equivalent to it.

### 5. No abstraction tax law

Every abstraction must remove decisions, enforce a convention, preserve state, batch work, or add
provenance. If it only renames a function and adds objects, it should not exist.

### 6. Escape-hatch law

The escape hatch is a supported API, not an undocumented internal import. Advanced users can choose
the engine, supply a custom engine, pass raw normalized data, call a kernel, use typed arrays, and
inspect assumptions and diagnostics.

### 7. Explicit-effects law

Pure calculation never silently fetches, reads the clock, mutates a portfolio, writes a cache, or
chooses a credentialed service. Data retrieval, persistence, live subscriptions, and hosted jobs are
visible in the call and package boundary.

### 8. Structural-extension law

TypeScript extension points should prefer small structural interfaces and factory functions over a
mandatory inheritance hierarchy. A custom pricer should not need to subclass a universal
`InstrumentBase` or adopt unrelated lifecycle methods.

### 9. Provenance law

When data or a calibrated artifact has source metadata, every composition and workflow preserves it.
Higher-level convenience must increase—not erase—inspectability.

### 10. Semantic-parity law

Scalar, facade, pro, batch, worker, WASM, MCP, and cross-language paths must agree within a declared
tolerance and share units, defaults, errors, and model identifiers.

### 11. Curated-discovery law

Keeping kernels public does not mean hoisting hundreds of expert names onto `totalfinance` or a package
root. The existing pattern is correct:

- curated roots for canonical first moves;
- domain namespaces from the umbrella;
- documented expert subpaths for raw kernels and specialized batches;
- optional packages for data, acceleration, visualization, and transports.

### 12. Serializable-boundary law

Anything that crosses a worker, process, cache, MCP, HTTP, or language boundary has a versioned,
JSON-safe or Arrow-safe representation. Runtime-rich objects may wrap that representation, but may
not be the only form.

### 13. Same-engine-from-research-to-live law

Research, backtest, paper/live monitoring, and agent analysis should differ in data source and clock,
not in financial semantics. A strategy should not acquire a new payoff, fill convention, or risk
definition merely because it moved to another runtime.

## The abstraction test

Before adding a new high-level object or workflow, answer five questions:

1. Which repeated decisions does it remove?
2. Which invalid states or convention mismatches does it prevent?
3. Which existing public primitives does it compose?
4. How does a caller inspect or override each consequential choice?
5. Can the raw task still be performed without it?

Reject the abstraction if questions 1–3 have weak answers. Redesign it if questions 4 or 5 have weak
answers.

A universal `Instrument` class, for example, is not automatically valuable. Small structural
protocols for “can be valued,” “declares market-data requirements,” or “can serialize” may be useful;
forcing every TA series, option, bond, crypto perp, strategy, and portfolio through one object model
would not be.

## The API ladder in practice

The same domain should offer a smooth progression. Black–Scholes is the clearest example.

### Level A — trusted scalar kernel

```ts
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const value = blackScholesPrice({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  dividendYield: 0,
  volatility: 0.22,
});
```

Use when the caller owns input validation, knows the units, and wants the smallest direct path. The
object labels economically interchangeable numbers; it does not add a provider, artifact, envelope,
or professional-domain ceremony.

### Level B — friendly validated facade

```ts
import { blackScholes } from '@totalfinance/options';

const value = blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 30 / 365,
  riskFreeRate: 0.045,
  volatility: 0.22,
});
```

Use for the canonical application call. Named arguments, sensible defaults, teaching errors, and
`.explain()` earn this layer.

### Level C — professional contract valuation

```ts
import { engines, market, option } from '@totalfinance/options';

const result = option.price({
  contract: option.usEquityCall({
    underlying: 'SPY',
    strike: 105,
    expiry: '2026-09-18',
  }),
  market: market({
    spot: 100,
    riskFreeRate: 0.045,
    volatility: 0.22,
    asOf: '2026-08-19',
  }),
  engine: engines.auto(),
});
```

Use when conventions, exercise style, expiry time, engine choice, assumptions, diagnostics, and
Greeks matter.

### Level D — scalar position payoff

```ts
import { legs, strategy } from '@totalfinance/strategy';

const position = strategy([
  legs.call({ strike: 100, premium: 4.25, quantity: 1 }),
  legs.call({ strike: 110, premium: 1.4, quantity: -1 }),
]);

const pnl = position.pnlAtExpiry(105);
```

Use when the task is exactly “what does this position make or lose at this expiration spot?” No
model, provider, or scenario abstraction is required.

### Level E — batch and composition

```ts
import { blackScholesPriceMany } from '@totalfinance/options/batch';

const result = blackScholesPriceMany(columns, { greeks: true });
```

Or use a strategy, surface, scenario map, book, or backtest that composes many lower-level calls.

### Level F — connected workflow

The future provider-bound client should make a complete chain analysis concise:

```ts
const totalfinanceClient = createTotalFinance({ data: provider });

const analysis = await totalfinanceClient.options
  .chain({ underlying: 'SPY', expiry: '2026-09-18' })
  .quality()
  .impliedVolatility()
  .greeks()
  .exposure()
  .run();
```

This is an illustrative target, not a frozen spelling. Its important properties are:

- retrieval is explicit and asynchronous;
- each stage corresponds to public compute;
- the normalized chain remains accessible;
- provenance and diagnostics survive every stage;
- a user can provide rows directly and skip the provider;
- the result can be serialized, visualized, or passed by handle to MCP.

### Level G — agent or product experience

An MCP workflow or product UI may request the same chain analysis and return a compact narrative,
table, and heatmap. It must cite the same model, assumptions, inputs, and artifact identity as the
TypeScript call. MCP is a transport over the engine, not a new quant library.

## Primitive permanence contract

Raw access should be protected mechanically, not just promised in prose.

### Public kernel manifest

Maintain a generated manifest for expert kernels with:

- canonical import path;
- signature and units;
- stability tier;
- scalar/batch equivalents;
- backing facade and composition consumers;
- accepted accelerated implementations;
- parity tolerance and reference evidence.

The manifest should fail CI if a stable kernel disappears, moves without a compatibility export, or
loses its parity mapping.

### Cross-layer conformance suites

For representative golden and property cases, prove:

```text
kernel ≈ facade.value
kernel ≈ pro API value under equivalent conventions
scalar loop ≈ batch result
JavaScript batch ≈ worker result ≈ WASM result
SDK result ≡ MCP content payload
serialized artifact → restored artifact preserves meaning
```

The comparison is exact where possible and tolerance-declared where implementation order changes
floating-point rounding.

### Raw examples are release-gated

The docs and packed-consumer suite should always include at least:

- one direct mathematical primitive;
- one model kernel;
- one facade call;
- one professional contract valuation;
- one scalar payoff;
- one columnar batch call;
- one custom-engine or custom-provider extension;
- one workflow with a raw-data escape hatch.

That prevents adoption materials from accidentally presenting the orchestration layer as the only
way to use the library.

### Root curation and primitive availability are separate concerns

The completed decision to remove expert kernels from general roots was correct. The additional
argument-safety correction does not undo it. A raw kernel is still first-class when its path is
short, documented, stable, tree-shakeable, and discoverable:

```ts
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
```

This is more lovable than putting `blackScholesPrice`, `blackScholesGreeks`,
`blackScholesPriceManyInto`, hundreds of indicators, every optimizer, and every exotic engine into
one autocomplete list.

## What “utterly complete” should mean

No library can contain every quantitative paper, data vendor, asset convention, or trading venue.
Trying would create a museum of unrelated exports. TotalFinance can nevertheless feel complete if it
owns the following loop end to end:

```text
define → source → normalize → validate → calibrate → value → risk → decide
   → simulate → compare → explain → visualize → save → replay → monitor
```

The user must be able to enter and exit that loop at any stage. A developer with their own data and
models can use only normalize/value/risk. A trader can use a connected chain workflow. A quant can
replace a pricer. An agent can operate over saved artifacts. Completeness comes from the shared spine,
not compulsory use of the entire loop.

## Program 0 — preserve and finish the primitive layer

This is mostly shipped, but it becomes a standing program because every later feature depends on it.

### Deliverables

- Preserve every current expert model capability, expert subpath, and curated facade; preserving
  access does not require preserving unsafe pre-1.0 signatures.
- Replace public long homogeneous financial-parameter lists with one flat, required object. Start
  with BSM, Black-76, and Bachelier price/Greeks/bounds/IV kernels.
- Migrate financial-domain internals to named objects too. Do not retain a parallel positional
  implementation without a benchmark proving that a file-private inner loop is necessary.
- Do not add positional/object overloads or deprecated aliases before 1.0.
- Add the standalone vanilla intrinsic primitive described above.
- Generate the public-kernel manifest and parity map.
- Extend installed-tarball tests across raw, facade, pro, and batch paths.
- Benchmark object-wrapper overhead, but judge real throughput through the columnar batch APIs; an
  assumed micro-optimization is not sufficient reason for a silently swappable public signature.
- Publish explicit scalar/batch/WASM tolerance policy.
- Keep raw kernels free of provider, clock, credential, cache, and transport dependencies.
- Keep the numerical and model kernels independently benchmarkable.

### Exit gate

A developer can find and run the direct formula from API reference or search in under two minutes;
all higher forms are demonstrably backed by the same semantics.

## Program 1 — a coherent market-state and convention substrate

TotalFinance has domain-specific market builders and assumptions today. The next platform layer needs a
coherent way to represent a dated market snapshot without forcing simple calls to use it.

### Capabilities

- Explicit `asOf`, timezone, calendar, and valuation-date semantics.
- Spots, forwards, FX, rates/curves, dividends/borrow, volatility inputs/surfaces, and reference data.
- Immutable snapshots with stable serialization.
- Source, dataset, entitlement, freshness, and quality provenance.
- Market-data requirements that a valuation can declare before execution.
- A single-scenario view and a compact multi-scenario representation.
- Deterministic overrides and shocks that return a new snapshot.

### API posture

Do not replace direct named scalar requests. `blackScholes.call({...})` should still take `spot`,
`riskFreeRate`, and `volatility`. The market-state object is for calculations where sharing,
calibration, consistency, or scenarios justify it.

Do not introduce a process-wide evaluation date. Time remains injected. This retains TotalFinance's
browser/server/worker determinism and avoids hidden cross-request state.

### Why this matters

A coherent snapshot is the seam joining options, fixed income, crypto, risk, books, data providers,
saved analyses, and MCP handles. Without it, every high-level workflow invents a slightly different
bag of market fields.

### Exit gate

Equivalent scalar and snapshot-backed valuations agree, every consequential convention is
inspectable, and a snapshot can be serialized and replayed without reading the system clock or a
provider.

## Program 2 — instruments, pricers, and extension contracts

TotalFinance should support broader cross-asset composition without forcing all domains into one class
hierarchy.

### Recommended shape

Use small structural contracts around existing APIs, conceptually:

```ts
interface Pricer<TTarget, TMarket, TResult> {
  readonly id: string;
  requirements(target: TTarget): readonly MarketRequirement[];
  price(target: TTarget, market: TMarket): TResult;
}
```

The actual interfaces should be narrower and domain-appropriate where needed. Important properties:

- existing functions can be adapted without being rewritten as classes;
- built-in and third-party pricers use the same registration and conformance path;
- contracts remain plain, serializable values;
- the caller can choose a pricer explicitly;
- automatic selection reports why an engine was chosen;
- custom engines can be validated against domain probes before use.

### Do not build

- a mandatory `InstrumentBase` superclass;
- a universal object with dozens of optional fields;
- mutable instruments that secretly retain live market handles;
- one stringly typed `price('option', {...})` switch;
- a plugin interface so broad that correctness cannot be tested.

### Exit gate

A third party can add one instrument or pricer in a small package, pass a published conformance kit,
and have it participate in valuation, scenario, book, and MCP workflows without patching TotalFinance.
Raw model functions remain usable without the extension system.

## Program 3 — the book and portfolio as a durable domain object

`analyzeBook`, portfolio P&L explain, margin, optimization, and book VaR are strong seeds. The complete
platform needs a durable, multi-asset book representation that those functions can share.
The focused ledger/event/P&L/reconciliation contract and its agent-facing continuation live in
[`agent-native-portfolio-and-trading-platform.md`](./agent-native-portfolio-and-trading-platform.md).
FC7 in the
[`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
turns the compute-only portion into accepted implementation scope and adds the complete lifecycle,
performance, policy, rebalancing, and reconciliation gate.

### Capabilities

- Positions, trades, tax lots, cash, financing, and fees as distinct concepts.
- Equities, options strategies, futures, rates instruments, crypto spot/perps/options, and custom
  targets through adapters.
- Stable instrument and position identity.
- Multi-currency valuation with explicit FX market data.
- Netting sets and margin groups without pretending all brokers use one rule.
- Aggregation by position, strategy, underlying, sector, asset class, currency, account, and tag.
- Value, P&L, Greeks/sensitivities, margin, concentration, liquidity, and factor exposures.
- Trade-to-trade and market-state-to-market-state P&L explain.
- Immutable snapshots and explicit transaction application.
- Serialization suitable for a file, database, worker, or MCP handle.

### Keep the small calls

`analyzeBook(items, options)` should remain useful. The durable `Book` artifact earns its existence
for identity, state transitions, grouping, reuse, and connected workflows; it does not replace the
function for a one-off array.

### Exit gate

The same book can be valued from raw supplied market data, a provider-backed snapshot, a scenario
set, a backtest timestamp, or a live feed, and produces reconciled totals at every aggregation level.

## Program 4 — scenarios as a first-class calculation dimension

Scenario analysis should become a shared platform capability rather than one custom grid per domain.
Current scenario maps, strategy tables/cubes, stress functions, surface shocks, and book VaR provide
the underlying analytics.

### Capabilities

- Declarative spot-price, volatility, curve, spread, FX, correlation, liquidity, and time shocks.
- Parallel, bucketed, historical, hypothetical, and cross-factor scenarios.
- Scenario composition with deterministic order and conflict detection.
- Full revaluation and approximation modes, labeled clearly.
- Single-target/many-scenario and many-target/many-scenario execution.
- Compact row-major or columnar result cubes.
- Scenario attribution: which shocks and positions caused the change.
- Historical event libraries as data, not hard-coded truth in compute.
- Saved, named, versioned scenario sets.

### A calculation plane, not the only API

A high-level calculation runner may eventually accept targets, measures, market state, and scenarios.
It is valuable for large books and reports. It must not become the required route for
`blackScholesPrice(...)`, `blackScholes.call(...)`, or `position.pnlAtExpiry(...)`.

### Exit gate

One scenario definition can run against an option, strategy, book, or supported cross-asset target;
the result traces each cell back to the target, measure, market snapshot, shock, engine, and units.

## Program 5 — calibration and model lifecycle

TotalFinance has sophisticated calibration across SVI/SSVI/eSSVI, SABR, Heston, local volatility, curves,
credit, and statistical models. The platform should make calibrated models durable and comparable.

### Capabilities

- A standard artifact grammar for parameters, objective, bounds, weights, convergence, residuals,
  warnings, input identity, and model version.
- Serialization and exact replay from normalized inputs.
- Holdout and out-of-sample calibration diagnostics where meaningful.
- Side-by-side model comparison under the same market snapshot.
- Stability diagnostics across time and nearby starting points.
- Warm starts and incremental recalibration.
- Model risk: fit quality, arbitrage checks, extrapolation regime, and sensitivity to assumptions.
- Registry metadata describing supported products, required data, outputs, and cost class.

### Keep the calibration kernels

`calibrateSvi`, `calibrateSsvi`, curve bootstrappers, and similar direct APIs remain public. A model
catalogue or workflow adds persistence, comparison, and provenance; it does not replace direct fitting.

### Exit gate

A saved calibrated artifact can be restored, evaluated directly, compared with another model, used
in a book/scenario calculation, and explained by an agent without losing diagnostics or provenance.

## Program 6 — the data plane and first-party growth loop

The data layer is not merely an adapter collection. It is how TotalFinance becomes immediately useful on
real markets and how the open-source library creates qualified InsiderFinance subscribers.

The detailed design and recommended revision are in
[`mcp-acceleration-data-growth-strategy.md`](./mcp-acceleration-data-growth-strategy.md). This roadmap
sets its role in the platform.

### Capabilities

- Canonical normalized rows and columnar forms for bars, quotes, trades, chains, option flow,
  reference data, dividends/actions, and curves.
- Provider capability discovery rather than assuming every vendor supports every query.
- Query results that include data, provenance, quality, freshness, pagination/continuation, and usage.
- Async iterable streaming with explicit cancellation and backpressure.
- Memory, JSON/CSV, and Arrow adapters as the contract-proof baseline.
- A first-party InsiderFinance provider for high-value chains, flow, exposure, and historical
  options datasets.
- User-connected adapters for vendors where licensing permits local or server-side access.
- Explicit caching with provider/version/as-of-aware keys.
- Local and hosted dataset handles so large inputs do not pass through an LLM context.
- Helpful capability and entitlement errors with a free path or exact next action.

### Permanent boundary

Providers return normalized data. They do not own pricing, Greeks, signals, risk, or backtests.
Compute accepts normalized data and never knows which vendor supplied it. This keeps bring-your-own
data real and prevents first-party product integration from becoming lock-in.

### Exit gate

The flagship journey—symbol to normalized chain to IV/Greeks/exposure to strategy candidates to a
saved, explainable result—works with direct rows, a local adapter, and the first-party provider. The
compute result is identical under equivalent inputs.

## Program 7 — research as a reproducible workflow

TotalFinance already contains vectorized and event-driven backtests, options backtesting, walk-forward
tools, performance/risk analytics, and research-hygiene statistics. The complete experience should
join them without inventing a DataFrame framework.

FC3 in the
[`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
owns the missing screening, cross-sectional factor, and event-study primitives. FC8 owns their
point-in-time, portfolio-scale, ledger-backed simulation. This program owns the durable research-run
artifact that records and compares those calculations; it is not a separate feature engine.

### Capabilities

- An explicit research run: hypothesis/metadata, universe, data snapshot, features, signal,
  portfolio construction, execution assumptions, evaluation, and artifacts.
- Time-aware feature pipelines with leakage checks.
- Train/validation/test and walk-forward splits with purge/embargo support.
- Parameter sweeps and optimization with trial accounting.
- Reproducible seeds and data versions.
- Baseline and benchmark comparisons.
- Backtest/live semantic reconciliation.
- Tear sheets, risk reports, trade logs, rejected-order logs, and implementation-risk diagnostics.
- Experiment comparison without pretending a statistically weak winner is significant.
- An escape hatch at every stage for user functions and precomputed arrays.

### API posture

The workflow should orchestrate existing `technicalAnalysis`, `backtest`, `performance`, and `risk`
functions. A user who only wants `technicalAnalysis.rsi(values)` or `sharpeRatio(returns)` should
never instantiate a research object.

### Exit gate

A saved run can be replayed from its artifact manifest; changing only data, a parameter, or an
execution assumption produces a difference that identifies exactly what changed.

## Program 8 — live and incremental analytics

“Live” should mean the same calculations updated through explicit streams, not a second codebase.

### Capabilities

- Quote, trade, chain, bar, and market-state streams with timestamps and sequence semantics.
- Incremental option/position/book valuation and Greeks.
- Incremental GEX/DEX/vanna/charm and flow aggregation.
- Streaming indicators with snapshot/resume, extending the strong TA precedent.
- Typed alerts with threshold, hysteresis, debounce, cooldown, and evidence payloads.
- Late, duplicate, corrected, and out-of-order event policy.
- Backpressure, cancellation, reconnect, and stale-data diagnostics.
- Deterministic record/replay into the same event-driven backtest path.
- Paper/live observation boundaries that remain separate from broker execution.

### Scope boundary

TotalFinance may expose execution-neutral signals, portfolio targets, and order-intent types. Broker
connectivity and credentialed order placement should remain separate adapters/products with a much
stronger safety and operational contract. The open compute core should not quietly become a trading
bot.

### Exit gate

A recorded live stream replay produces the same state transitions and analytics, subject only to
explicitly declared processing-time behavior. Disconnects and stale inputs are visible, never silent.

## Program 9 — agent-native and visual experiences

Agents need fewer, more capable workflows; developers still need all underlying tools. These are
compatible goals when every transport is treated as an experience layer over one protocol-neutral
operation registry.

### Capabilities

- Keep narrow compute tools for exact calculations and debugging.
- Extract shared workflow schemas, effect/authorization metadata, budgets, and execution from the MCP
  package before adding another transport.
- Add a small number of workflow tools for chain, strategy, book, and research analyses.
- Use explicit, scoped handles for datasets, market snapshots, books, scenarios, and saved results.
- Expose resources for schemas, conventions, model cards, indicators, strategies, artifacts, and
  saved analyses.
- Return compact summaries plus resource links for large tables and matrices.
- Add MCP Apps for payoff diagrams, scenario heatmaps, surfaces, exposure charts, and tear sheets.
- Ground every narrative claim in a machine-readable value or diagnostic.
- Publish server instructions, protocol annotations, cost classes, and executable prompts.
- Make local MCP exemplary before offering remote authenticated MCP.
- Add machine-first CLI and generated OpenAPI/HTTP access; add Agent2Agent task/artifact delegation
  only after workflows, handles, and jobs are durable.
- Add a deterministic trading-agent environment and public benchmark before any optional live broker
  edge, and keep proposal, preflight, authorization, execution, and reconciliation as explicit stages.
- Ensure SDK and MCP parity through generated manifests and contract tests.

### Keep the raw tools

A workflow tool such as “analyze this option chain” should call the same individual IV, Greeks,
surface, structure, and strategy operations exposed to developers. It must return enough trace data
to reproduce the result by SDK calls. Combined functionality is a shortcut, not a black box.

### Exit gate

A cold agent can discover and complete the flagship analyses without inventing data or exceeding
context limits, and an expert can drill from every conclusion to the exact tool, input artifact,
model, and diagnostic that produced it.

## Program 10 — acceleration and cross-language interop

Acceleration should preserve the API ladder. It is an implementation choice beneath existing batch
and composition contracts, not a new user model.

The detailed measured recommendation is in
[`mcp-acceleration-data-growth-strategy.md`](./mcp-acceleration-data-growth-strategy.md): begin with a
WASM pilot on a large fused scenario-map workload, not a library rewrite.

### Capability order

1. Stable typed-array batch contracts and fewer allocations.
2. Chunking, cancellation, and worker-pool execution.
3. Arrow-native ingestion and result exchange.
4. WASM/SIMD for measured, sufficiently large kernels.
5. Native/server acceleration only where deployment and demand justify it.
6. WebGPU experiments only for workloads that are genuinely parallel enough to pay transfer and
   setup cost.

### One contract, several executors

An accelerated API should make selection optional and inspectable:

```ts
const result = await scenarioMap(input, {
  executor: 'auto', // 'typescript' | 'worker' | 'wasm'
});

result.diagnostics.executor;
```

Small scalar calls should remain synchronous JavaScript. Initialization, transfer, and copy costs
can make WASM slower for them. Auto selection must be benchmark-driven and deterministic enough to
test.

### Cross-language path

Do not hand-maintain a second Python quant implementation. Generate schemas/types and expose stable
artifact and Arrow boundaries around the same engine. Viable paths include a WASM-backed Python
package, a local sidecar, or native bindings for selected kernels. Pick from measured user demand,
but preserve:

- identical conventions and model identifiers;
- serializable inputs/results;
- parity fixtures shared across languages;
- native Python ergonomics around the transport;
- direct access to raw kernels as well as workflows.

### Exit gate

Acceleration wins its benchmark after initialization and transfer costs, matches the JavaScript
reference within declared tolerances, falls back cleanly, and never changes result semantics.

## Program 11 — artifacts, replay, and auditability

The object that unifies the platform should not be a god client. It should be a durable analysis
artifact.

### Every meaningful run should be able to record

- artifact type and schema version;
- operation and library version;
- normalized input identity or embedded small inputs;
- source/provider/data version and `asOf`;
- conventions and units;
- model/engine and calibrated parameter identity;
- options, seed, and scenario identity;
- diagnostics, warnings, and approximation disclosures;
- result summary and links to large tabular artifacts;
- parent artifacts and transformations;
- content hash for replay and deduplication.

### Why artifacts are the spine

- TypeScript users can save and compare them.
- workers and hosted jobs can return them.
- MCP can pass handles instead of thousands of rows.
- apps can render them.
- reports can cite them.
- support can reproduce them.
- subscription workflows can preserve entitlement-safe references without copying licensed data.

### Exit gate

Given an artifact and access to its referenced data, TotalFinance can reproduce the calculation or
explain exactly why reproduction is impossible. A result never depends on hidden process state.

## Program 12 — an extension ecosystem with conformance kits

Being “complete” requires graceful coverage of what TotalFinance does not ship itself.

### Supported extension families

- data provider and cache;
- instrument/contract adapter;
- pricing engine;
- calibration model;
- scenario shock;
- indicator/signal;
- execution-cost or fill model;
- report/visual renderer;
- MCP workflow over public operations.

### Every extension contract needs

- a narrow interface;
- runtime schema or validation hook at the boundary;
- capability metadata;
- deterministic identity/versioning;
- conformance fixtures;
- failure and cancellation semantics;
- serialization rules where it crosses a boundary;
- an example package that uses only public APIs.

Built-ins must use the same extension path where practical. An extension system is not credible if
only internal code can access the real capabilities.

### Exit gate

A third-party extension can be installed independently, discovered without executing arbitrary
remote code, validated, used by direct SDK calls, and—when explicitly allowed—exposed through MCP.

## Signature journeys for the ambitious release

The release should be judged against complete stories, each with a direct entry and a path to more
power.

### Journey 1 — one option number

1. Import `blackScholesPrice` or `blackScholes`.
2. Get a number immediately.
3. Ask for Greeks or `.explain()` without learning a new package.
4. See units and assumptions.
5. Switch to a contract and another engine only if needed.

**Pass condition:** no provider, client, or portfolio required; raw and friendly calls are both
prominent and tested.

### Journey 2 — one payoff

1. Compute gross vanilla intrinsic directly, or build one/more legs.
2. Ask `pnlAtExpiry(spot)` for a scalar.
3. Ask `payoff()` for a sensible default curve.
4. Ask for metrics, probability, current value, scenarios, or an SVG as needed.

**Pass condition:** payoff, model value, and P&L terminology never blur.

### Journey 3 — an option chain

1. Supply rows directly or request a chain through a provider.
2. Normalize and quality-check it.
3. Solve IV, Greeks, surface, structure/exposure, and strategy candidates.
4. Inspect every stage or use a combined workflow.
5. Save/share a compact artifact or MCP handle.

**Pass condition:** direct rows and first-party data produce equivalent compute; no large chain must
travel through an LLM context.

### Journey 4 — a strategy and book

1. Build named or arbitrary legs.
2. Evaluate payoff, value, Greeks, margin, probability, and what-if cube.
3. Combine positions across underlyings/accounts.
4. Run scenarios, VaR, concentration, and P&L explain.
5. Drill every total into positions and legs.

**Pass condition:** all aggregates reconcile exactly and retain per-position assumptions and
provenance.

### Journey 5 — honest research

1. Bring bars/chains or connect a provider.
2. Define a feature/signal with raw functions or a pipeline.
3. Backtest with costs, fills, margin, and point-in-time data rules.
4. Walk forward and account for multiple trials.
5. Compare, explain, visualize, save, and replay.

**Pass condition:** the easy path is statistically honest; every workflow stage has a callback or
raw-data escape hatch.

### Journey 6 — live observation

1. Replace historical input with an explicit stream.
2. Reuse the same strategy and analytics.
3. Increment state and emit evidence-backed alerts.
4. Record the stream and replay it through the event engine.

**Pass condition:** live and replay reconcile; staleness, corrections, and disconnects are explicit.

### Journey 7 — agent analysis

1. Discover a workflow from MCP instructions/resources.
2. Select or create scoped data/book/scenario handles.
3. Run a budgeted analysis.
4. Receive a concise grounded answer and visual artifact.
5. Reproduce it through TypeScript or another supported language.

**Pass condition:** the agent does not invent missing market data, and every claim has a calculation
trace.

## Platform-program dependency sequence

This is the dependency order inside the platform direction, not the global work queue. Wave 6 is
complete. Execute the dedicated
[Phase 3B.N naming normalization](./specs/phase-3b-public-naming-normalization.md), then
[alignment Phase 3B](./specs/phase-3b-runtime-semantic-closeout.md) using its
[settled decision ledger](./specs/phase-3b-decision-ledger.md) before Gate A. Gates A–D are the
compute-only platform-core stage in [`implementation-order.md`](./implementation-order.md). Phase 4
shipping follows Gate D, then the edge/product programs continue with Gates E–G.

### Gate A — ratify the platform constitution

- ✅ Adopt the full platform layer model and remaining architecture laws in this document. CLOSED 2026-08-19 (Gate A landing): the seven-layer table is executable in `tools/layer-model.test.ts` — every package placed deliberately, every declared dependency proven same-or-lower-layer, exhaustive both directions and guard-proofed against a synthetic upward edge.
- ✅ Add the declaration-backed callable manifest and cross-layer BSM parity suite.
- ✅ Implement the named-object rule as the alignment spec's surface-wide Phase 3A correction to its
  former positional-kernel exception; preserve unrelated decisions only after verifying they are
  genuinely orthogonal.
- ✅ Migrate public and internal BSM/Black-76/Bachelier financial calls to required object inputs;
  preserve columnar batch paths for throughput.
- ✅ Add the direct vanilla intrinsic primitive. CLOSED 2026-08-19: `vanillaIntrinsic` at `@totalfinance/options/payoff` — gross intrinsic per unit, closed field set (premium/quantity/multiplier/probability/volatility/time all teach), zero legal on either leg; six in-package intrinsic sites converge on the package-private unchecked kernel with arithmetic unchanged.
- ✅ Add an architectural dependency test covering future data/workflow/transport packages. CLOSED 2026-08-19: `tools/package-graph.test.ts` Gate A block pre-declares `@totalfinance/data`/`workflows`/`http`/`cli` under the FC0 precedent and enforces the two named forbidden directions (compute never → provider/transport/UI/credential; nothing below workflows may import them), guard-proofed with synthetic edges.

**Why first:** it makes every later abstraction safe to build because raw accessibility and semantic
parity become executable constraints.

### Gate B — define the shared artifact spine

- Versioned market snapshot and provenance grammar.
- Versioned analysis artifact and large-table reference grammar.
- Explicit scenario-set representation.
- Serialization, hash, replay, and migration policy.
- Canonical JSON-safe forms first; reserve a lossless Arrow mapping contract and implement mappings
  only with a measured large-table consumer.

**Why second:** books, data, MCP handles, workers, cross-language calls, and saved research otherwise
invent incompatible containers.

### Gate C — add narrow structural extension contracts

- Small `Pricer`/requirements protocols with explicit capabilities.
- Conformance probes with caller-supplied fixtures.
- Explicit engine selection and inspectable automatic selection.
- Adapters around existing direct functions and batch paths; no second pricing implementation.
- No universal instrument superclass, mutable global evaluation date, or stringly typed mega-dispatch.

**Why third:** books and shared scenarios need a common way to ask heterogeneous positions what they
require and how they price, without making simple formula calls pay an abstraction tax.

### Gate D — complete durable book, scenario, calibration, and research artifacts

**Implementation status:** the durable portfolio portion is complete after review at `a6f9842b`
(Platform Stage 4.4a / FC7) under the accepted
[`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
and incorporated agent-platform contract. Do not re-specify that package, ledger, lifecycle,
performance, policy, or reconciliation direction. The shared scenario runner is complete at
`3095cf91` under its decision-complete
[`focused implementation contract`](./specs/shared-scenario-runner.md). Calibration/research
artifacts are complete at `795dd999f` as Stage 4.5 under the accepted
[`calibration-research-artifacts.md`](./specs/calibration-research-artifacts.md) contract
(reviewed and accepted 2026-09-02; six slices landed 2026-09-03).
Preserve direct one-off functions throughout; none of these artifacts may make a durable framework
mandatory for a small calculation.

- Durable immutable book snapshot and transaction model — **COMPLETE @ `a6f9842b`**.
- Identity, lots, cash, financing, grouping, netting, currency, serialization, and replay —
  **COMPLETE @ `a6f9842b`**.
- Shared scenario runner over existing domain analytics — **COMPLETE @ `3095cf91`**, governed by
  [`shared-scenario-runner.md`](./specs/shared-scenario-runner.md).
- Reconciled position/book aggregation with all inputs and intermediate artifacts preserved —
  **COMPLETE @ `3095cf91`**.
- Serializable fitted-model/calibration artifacts with diagnostics and comparison — **COMPLETE @
  `795dd999f`** ([`calibration-research-artifacts.md`](./specs/calibration-research-artifacts.md)).
- Reproducible research-run artifact and comparison — **COMPLETE @ `795dd999f`**, in the same
  contract.

**Why fourth:** this turns many excellent functions into a coherent professional compute workflow
while retaining every function independently. Every new surface must satisfy the Phase 3B runtime and
field-semantic ratchets immediately, and the complete gate is rerun before the core freeze.

### Preview checkpoint — make the current library adoptable and agent-accessible

After Stage 4.5, close the options-marking truthfulness gate, then pull forward Stage 7A: one
protocol-neutral read-only operation registry with machine-first CLI, generated OpenAPI/local HTTP,
local jobs/handles, and a protocol-correct local MCP over the same schemas and results. This is the
right early agent surface because market/artifact/portfolio/scenario foundations already exist; it
must remain provider-free, credential-free, and incapable of portfolio writes or orders.

**Status (2026-09-03): Stage 7A is complete at `c7bdb260d`** — the registry, the journey operations, the
local stores and job runner, the `totalfinance` CLI, `@totalfinance/http` with its OpenAPI document, the MCP
preview-gate items, and transport parity across every surface, per
[`local-operations-and-transports.md`](./specs/local-operations-and-transports.md). Stage 5A is the
current row.

Build the docs site, hosted CI, packed-example matrix, release automation, source maps, contribution
and security paths, and canonical public repository for an explicitly pre-1.0 preview. At one exact
green commit, deliberately select the preview version and fixed package group, verify metadata,
docs, security/community files, hosted CI, changesets/release notes, source maps, provenance, and
dry-run hashes, then obtain maintainer approval for the exact artifacts. Publish atomically, create
the matching tag/release, install and smoke the actual public-registry artifacts, and have rollback/
yank ownership ready.

This cutover is not the final core freeze. Stage 4.6 then completes portfolio-scale simulation while
each flagship operation extends the shared CLI/OpenAPI/MCP adapters. Stage 4.7 reruns whole-surface
integration once, after Stage 4.6, before the stable release. Shipping may expose a defect, but it
does not become an excuse for casual core-contract redesign. [`implementation-order.md`](./implementation-order.md)
owns both terminal checklists.

### Gate E — ship the flagship connected chain

- Revised provider contract and capability discovery.
- Memory/JSON/CSV/Arrow reference adapters.
- First-party InsiderFinance provider.
- Chain normalization and quality report.
- Direct and provider-backed chain analysis workflow.
- Saved artifacts and visual payoff/exposure/surface outputs.

**Why here:** it is the highest-value connected path for this audience, exercises almost every layer,
lands on frozen market/artifact contracts, and creates the open-source-to-subscription loop without
weakening bring-your-own data.

### Gate F — extend early agent access into connected and live operation

- Build the protocol-neutral operation registry and machine-first CLI/OpenAPI surfaces before preview
  under Stage 7A, then extend parity with every later flagship operation.
- Fix local MCP protocol/agent-experience gaps before preview under the dedicated Preview Gate.
- Add scoped handles, a few workflow tools, resources, and MCP Apps.
- Add the deterministic trading-agent environment, Agent Bench, and proposal/preflight/policy/paper
  lifecycle; live broker execution remains a separately authorized edge.
- Add Agent2Agent only over the same durable workflows, jobs, and artifacts.
- Add stream contracts, incremental structure/book analytics, alerts, and record/replay.
- Offer remote MCP only with auth, tenancy, limits, job control, and entitlement-safe data access.

### Gate G — accelerate measured bottlenecks and widen interop

- Publish repeatable workload benchmarks.
- Add workers and Arrow transfer paths.
- Run the fused scenario-map WASM pilot.
- Expand WASM only where the benchmark gate passes.
- Ship the first cross-language client around stable schemas/artifacts, guided by actual demand.

## Priority calls: what creates more value than another long feature list

TotalFinance should continue adding meaningful model depth, but these investments now have higher
leverage than another collection of isolated formulas:

| Priority | Investment                                  | Why it changes adoption                                                       |
| -------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| P0       | Primitive permanence and cross-layer parity | Advanced users trust that convenience will not trap them                      |
| P0       | Market/artifact/provenance spine            | Makes every package compose and every result replayable                       |
| P0       | Narrow extension contracts                  | Lets books and scenarios compose engines without a universal object model     |
| P0       | Durable book + shared scenarios             | Makes the library useful for professional multi-position work                 |
| P1       | Reproducible research workflow              | Joins existing backtest/risk/performance strengths into one journey           |
| P1       | Flagship first-party chain workflow         | Converts installation into immediate real-market value after contracts freeze |
| P1       | MCP handles/workflows/Apps                  | Makes agent use context-efficient, visual, and grounded                       |
| P1       | Live incremental analytics                  | Connects research and product use without a second engine                     |
| P2       | Arrow/workers/measured WASM                 | Makes scale feel native once workloads justify it                             |
| P2       | Provider and renderer adapter kits          | Lets the ecosystem cover data and presentation TotalFinance cannot ship       |
| P2       | Cross-language bridge                       | Expands reach after the engine and artifact contracts stabilize               |
| Ongoing  | Selective model/domain depth                | Preserves technical leadership where there is real user or product pull       |

The key product decision is not “abstractions versus raw functions.” It is “a coherent spine plus
raw functions” versus a pile of disconnected features. TotalFinance should choose the coherent spine
while protecting direct access as a constitutional requirement.

## Package and import posture

The existing package topology is a strength. Extend it carefully.

### Keep

- `totalfinance` as the curated one-install experience;
- independently installable domain packages;
- deep expert subpaths for kernels and specialized batches;
- browser-safe compute packages;
- a separate MCP package;
- optional adapters and acceleration packages.

### Add only when boundaries are earned

- the accepted `@totalfinance/fundamentals`, `@totalfinance/valuation`, `@totalfinance/research`,
  `@totalfinance/foreign-exchange`, `@totalfinance/commodities`, and `@totalfinance/portfolio` domain packages in
  FC0–FC7, with their exact downward-only graph;
- a small data contract/runtime package;
- provider adapters as separate packages;
- a live/streaming edge if its dependency/runtime needs differ materially;
- a visualization package once output expands beyond a few zero-dependency renderers;
- a WASM/worker package so scalar compute does not pay its cost;
- language clients around stable wire/artifact contracts.

### Avoid

- moving all workflows into the umbrella implementation;
- a required `createTotalFinance()` client for pure compute;
- importing every provider in the default install;
- exposing credentialed adapters in browser bundles;
- parallel “SDK math” and “MCP math” modules;
- a generic plugin loader in core;
- hidden dynamic network imports.

## Lovability scorecard for the platform direction

The following questions should be answered in every release review.

### Directness

- Can a beginner perform the canonical task in one obvious call?
- Can an expert import the raw kernel directly?
- Can either user avoid constructing irrelevant objects?

### Continuity

- Can the simple result grow into `.explain()`, batch, scenario, book, and workflow use without
  changing semantics?
- Can a workflow reveal and export its intermediate normalized data and artifacts?

### Honesty

- Are units, conventions, source, as-of, model, approximation, and failures explicit?
- Does automatic behavior explain its choice?
- Are undefined quantities null-with-reason rather than fabricated?

### Extensibility

- Can a developer supply data, a model, a pricer, a shock, or a renderer through a narrow public
  contract?
- Do built-ins pass the same conformance suite?

### Performance

- Is the scalar path fast and allocation-light?
- Is the batch path columnar and reusable?
- Are worker/WASM thresholds based on end-to-end measurements?
- Is cancellation real rather than a late timeout message?

### Portability

- Does pure compute work in the promised browser and Node runtimes?
- Are boundary artifacts versioned and serializable?
- Can another language reproduce the same golden fixtures?

### Agent experience

- Can an agent discover the right operation without seeing hundreds of raw exports as tools?
- Can large data stay behind handles?
- Can every narrative statement be traced to a typed result?

### Adoption

- Does the free/raw path remain genuinely useful?
- Does first-party data remove work rather than restrict compute?
- Is upgrading to connected data a natural next step with transparent capabilities and limits?

## Quantitative release gates

Set exact thresholds from measured baselines, but track at least:

- public-kernel import and signature compatibility;
- facade/pro/batch/worker/WASM parity fixtures;
- installed package and subpath resolution in supported runtimes;
- per-entrypoint bundle budgets;
- scalar and representative batch latency distributions;
- worker/WASM break-even sizes including initialization and transfer;
- provider normalization and quality-fixture coverage;
- artifact round-trip and migration coverage;
- book/scenario reconciliation invariants;
- deterministic replay under pinned seed/data/version;
- MCP protocol conformance, tool-selection success, retries, context bytes, and completion rate;
- cold-user time-to-first-number, time-to-first-error-recovery, and time-to-first-complete journey.

An impressive benchmark chart is not sufficient if the accelerated path changes units, swallows
diagnostics, or takes longer on the common workload. A broad API is not lovable if cold users cannot
find the first call.

## Decisions and non-goals

### Decisions

- Raw numerical and model primitives remain public and documented.
- Expert subpaths—not general-root floods—are the canonical location for raw model kernels.
- Public financial kernels with several interchangeable scalar inputs use one flat required object;
  rawness is not defined by positional arguments.
- Financial-domain internals use the same named-object rule by default; only benchmark-proven,
  file-private inner loops may be positional.
- Friendly facades, domain objects, compositions, workflows, and experiences are additive.
- High-level code composes public lower-level semantics.
- Market state is explicit and immutable; there is no process-global valuation date.
- Data access remains optional and outside compute packages.
- First-party data competes on convenience, proprietary value, and integration—not lock-in.
- Results preserve assumptions, diagnostics, provenance, and replay identity as they move upward.
- Scenarios, artifacts, and extension conformance are shared platform concepts.
- WASM is selected by measured workload, never by branding.
- MCP remains a transport/experience over the same engine.

### Non-goals

- One mandatory framework API.
- One universal mutable object graph.
- Hiding kernels as “internal implementation details.”
- Hoisting every kernel onto the umbrella root.
- Publishing long homogeneous financial parameter lists merely because an export is labeled
  “expert.”
- Preserving both positional and object overloads before 1.0.
- Reimplementing the library in every language.
- Building a DataFrame/query engine.
- Bundling all vendors, charts, WASM, and transports into core.
- Silent data fetching or automatic credential discovery in compute.
- Treating a combined workflow result as irreducible or unauditable.
- Claiming completeness by implementing every published model.
- Broker order execution inside the open compute core.

## Relationship to the existing roadmap

The two roadmaps serve different purposes:

- [`roadmap.md`](./roadmap.md) answers **“which additional quant capabilities could we build?”**
- this document answers **“what shared architecture and product journeys make all capabilities feel
  like one complete system?”**

Individual model follow-ups should continue to live in `roadmap.md`. Cross-cutting programs should
graduate from this document into dedicated, testable specs. The alignment spec remains the
authoritative constitution and Phase 3A/3B status record; Phase 3A closed the argument-grammar
correction while preserving root and result-grammar decisions that survived direct review. The
global order is intentionally centralized in `implementation-order.md`.

Recommended status ownership:

- global execution order: `implementation-order.md`;
- alignment/core API contract status: `library-alignment-spec.md` and executable manifests;
- individual feature inventory: `roadmap.md`;
- platform programs and release gates: this document;
- data/MCP/acceleration implementation decisions: the dedicated strategy document;
- accepted workstream implementation: a focused spec under `docs/specs/`.

## Research basis

This direction deliberately combines lessons without copying another library's ergonomics wholesale:

- [OpenGamma Strata's three API levels](https://strata.opengamma.io/features/) demonstrate that
  pricer-, measure-, and calculation-level APIs can coexist; its
  [market-data](https://strata.opengamma.io/market_data/) and
  [calculation-flow](https://strata.opengamma.io/calculation_flow/) designs show the value of explicit
  snapshots, requirements, scenarios, and report separation. TotalFinance should keep a much shorter
  direct path for JavaScript users.
- [QuantLib's instrument and pricing-engine model](https://www.quantlibguide.com/Instruments%20and%20pricing%20engines.html)
  demonstrates the power of separating contracts, market inputs, and engines. TotalFinance should retain
  explicit injected time and avoid requiring mutable handles or process-global settings.
- [OpenBB's provider and extension architecture](https://docs.openbb.co/platform/developer_guide)
  validates optional providers and separately installable extensions. TotalFinance's differentiator is
  that normalized data feeds a deep, browser-safe compute engine rather than becoming the product
  boundary.
- [Apache Arrow's columnar specification](https://arrow.apache.org/docs/format/Columnar.html) provides
  the language-neutral, SIMD-friendly, potentially zero-copy tabular boundary needed for data,
  workers, WASM, and cross-language interop.
- [QuantConnect LEAN's research-to-live continuity](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading)
  demonstrates the value of using the same strategy semantics across backtest and live modes, while
  its [research guidance](https://www.quantconnect.com/docs/v2/cloud-platform/backtesting/research-guide)
  reinforces TotalFinance's existing emphasis on hypothesis-driven, out-of-sample-aware research.
- [WebAssembly's portability model](https://webassembly.org/docs/portability/) supports a portable
  acceleration tier, but does not guarantee that every workload will be faster. TotalFinance therefore
  keeps JavaScript canonical and requires end-to-end benchmark wins before routing work to WASM.

## Final position

The ambitious direction is not “push the formulas down and expose only intelligent workflows.” That
would make TotalFinance easier for a demo and worse as a library.

The direction is:

> **Keep the formulas in reach. Build trustworthy ladders above them. Make every rung independently
> excellent, and prove that all rungs are the same engine.**

That gives TotalFinance both kinds of lovability:

- the immediate satisfaction of one import, one call, one correct number; and
- the long-term confidence that the same library can carry that number into a chain, surface,
  strategy, book, research run, live monitor, visual report, or agent conversation without becoming
  opaque.

That is how the library can feel utterly complete without becoming utterly complicated.
