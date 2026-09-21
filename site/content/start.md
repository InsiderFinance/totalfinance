# Start small, keep the raw API

You do not need to construct a portfolio, register an operation, start a server, or connect a data provider to calculate an option price. Install one domain package and call the function that answers your question.

TotalFinance is an unpublished preview. The examples describe its supported imports; they do not
claim that an npm installation has been verified. Use the version page to check release availability.

## Small input, direct answer

```ts
import { blackScholes } from '@totalfinance/options';

const price = blackScholes.price({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  volatility: 0.2,
  riskFreeRate: 0.04,
});
console.log(price); // About 2.3909 USD per share; a number, not a wrapper.
```

For a series, supply the observations you actually have:

```ts
import { sma } from '@totalfinance/technical-analysis';

const closingPrices = [100, 102, 104, 106, 108];
const averages = sma(closingPrices, { period: 3 });
console.log(averages); // [NaN, NaN, 102, 104, 106]
```

That is already an ordinary array. The first two entries are warmup values, not zeros or signals.
No `Array.from` is needed to use it. Creating a sample series is different from converting an output.

## What comes back?

| Task                                 | Return shape                                       | Use it directly                                   |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------- |
| Price one option                     | `number`                                           | `price`                                           |
| Compute Greeks                       | Named `Greeks` object                              | `greeks.delta`, `greeks.vega`                     |
| Calculate a moving average           | Ordinary `number[]`                                | `averages[index]`                                 |
| Analyze a strategy payoff            | Report with summary fields and a points array      | `report.maxLoss`, `report.points`                 |
| Track portfolio P&L                  | Report separating investment return and cash flows | `report.investmentReturn`, `report.externalFlows` |
| Run an expert columnar options batch | Object containing `Float64Array` columns           | `batch.price[index]`                              |

In TypeScript, `SomeType[]` means an ordinary array with typed elements. `Float64Array` is a
specialized numeric buffer, intentionally used by expert batch APIs. Both support indexing and
iteration. Convert a buffer only when a consumer explicitly requires an ordinary array; you do not
need to convert it just to read a price. Do not assume JSON serialization preserves typed buffers,
`NaN` or infinity: use the documented transport/artifact contract when saving or sending results.

A chart may need `{ x, y }` points. Mapping a report's named fields into those coordinates is chart
integration, not a repair to the financial answer. The task pages separate the first useful call
from the code needed to reproduce a whole chart.

## Custom legs without strategy-name constraints

Use `legs.call({ strike: 100, premium: 6, quantity: 2 })` for two long calls, or the same
constructor with `quantity: -2` for two short calls. `legs.put` follows the same rule;
`legs.stock({ price: 100, quantity: -50 })` means 50 short shares. Quantity is required and
nonzero. The constructors return ordinary leg records accepted by `strategy([...])`, so your app
can also supply raw records and rebuild a position after edits. Named whole-position presets
remain available; their names do not constrain a custom combination of legs.

## Pick your level

- **Raw function:** direct formula or numerical primitive, with its documented input contract.
- **Facade:** a small named request and a plain answer. Add `.explain()` to inspect assumptions and diagnostics.
- **Analysis:** a rich result when uncertainty, convergence, warnings, or multiple outputs are integral to the answer.
- **Artifact:** reusable, versioned state such as a curve, market snapshot, portfolio ledger, or research run.
- **Batch:** rows or typed columns for throughput; do not wrap thousands of scalar calls in a transport loop.
- **Workflow:** a useful composition over the same functions, exposed through SDK, CLI, HTTP, or MCP where supported.

These layers are additive. A workflow never replaces the underlying small functions, and a deep import does not excuse ambiguous positional financial arguments.

## Conventions worth knowing first

Rates and ordinary volatility are decimals, not percentages. Timestamps ending in `Ms` are epoch milliseconds; durations ending in `Years` are year fractions. Calendar labels and instants are different concepts. Read the assumptions for day count, compounding, option exercise, expiration resolution, currency, and contract multiplier.

No professional discount rate, investment objective, or exercise style should be inferred from an unlabeled demo default. Playground values are explicit sample assumptions. They are not recommended market inputs.

## Read the whole answer

A facade's plain value is useful when you already know its contract. Its explained answer carries assumptions and diagnostics. Analysis results carry those details directly. Invalid inputs produce typed errors. Non-convergence and undefined quantities must not be presented as successful invented numbers.

Technical indicators have aligned warmup periods. Leading warmup values are not signals or zero observations. A backtest must not use a future observation to trade earlier. A portfolio deposit changes account value but is not P&L. A firm-basis DCF produces enterprise value, not automatically equity or per-share value.

## Choose imports deliberately

For portable browser tree shaking, use named imports from `totalfinance/<domain>` or
`@totalfinance/<domain>`, as above, or supported feature subpaths such as `@totalfinance/math/normal`.
The umbrella keeps domain namespaces and the five flagship option exports (`blackScholes`, `option`,
`market`, `engines`, `impliedVolatility`) for convenience.

The tradeoff is bundler-dependent: `import { math } from 'totalfinance'` followed by
`math.normalCdf(0)` retains the whole math namespace in esbuild
([issue #1420](https://github.com/evanw/esbuild/issues/1420)); Rollup shakes this static use.
Direct `import * as math from 'totalfinance/math'` with static member use also shakes. Dynamic
namespace access and registries retain the implementations they can reach.

Installation size is not final bundle size, and plain Node ESM performs no automatic dead-code
elimination. Facades include validation and `.explain()` services; indicators also carry streaming
support. Type-only imports add no runtime code. Browser-safe calculations remain separate from
Node-only CLI, HTTP, MCP, and filesystem helpers. Read
[Imports and bundles](../../docs/guides/imports-and-bundles.md) for examples and measured budgets.

## Reproduce before extending

Run a task page with the sample inputs, read **Use it in your project** and its output, then change
one assumption. Small sample arrays show literal values. Larger sample ledgers and synthetic
backtest data have a preview and expandable setup; **Copy setup + call** includes that setup with
the calculation, so no hidden variables or data downloads are required. Expand **Reproduce this
entire playground** only when you want the complete charts and all their sample points. Both copies
are tested against installed package artifacts at default and edited inputs. These are illustrative
datasets, not real quotes, historical feeds or recommendations.

Keep the exact package version with saved results. Use the version page to distinguish an unreleased
source build from verified preview or stable registry artifacts.
