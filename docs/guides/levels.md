# Levels: raw, facade, analysis, artifact, batch, workflow

TotalFinance is one library at six levels, and no level is the only route. The same instrument — a
three-month call struck at 105 on a 100 spot, 20% volatility, 4% rate — is priced below at every
level so the reader sees the same number move up the stack. Every block runs in CI
(`docs/examples/guides.test.ts`); pick the level that fits the job and drop down whenever a
higher level hides something you need.

| Level        | You get                                                    | Reach for it when                                   |
| ------------ | ---------------------------------------------------------- | --------------------------------------------------- |
| **raw**      | a kernel: numbers in, a number out, nothing else           | hot paths, your own composition, audits             |
| **facade**   | a flat call plus `.explain()` with assumptions/diagnostics | notebooks, dashboards, a quick answer with its why  |
| **analysis** | a contract + a market snapshot → a rich envelope           | pricing engines, Greeks, conventions you must name  |
| **artifact** | a saved, restorable, replayable, content-addressed result  | anything you keep, compare, or hand to someone      |
| **batch**    | ordinary result rows or expert typed-array columns         | many contracts at once                              |
| **workflow** | an operation with a schema, a budget, and a teaching error | agents, CLIs, HTTP, MCP — the same call over a wire |

## Raw

The kernel takes the inputs and returns the price. `normalCdf` beneath it is a plain function too.

```ts
import { normalCdf } from '@insiderfinance/totalfinance/math';
import { blackScholesPrice } from '@insiderfinance/totalfinance/options/black-scholes';

const contract = {
  type: 'call' as const,
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  dividendYield: 0,
  volatility: 0.2,
};
const rawPrice = blackScholesPrice(contract);
if (!(rawPrice > 0 && rawPrice < 10)) throw new Error(`raw price drifted: ${rawPrice}`);
if (Math.abs(normalCdf(0) - 0.5) > 1e-12) throw new Error('the kernel beneath the kernel drifted');
```

## Facade

The facade is the same number behind a flat call, and `.explain()` is the same number with the
conventions it applied and the diagnostics it observed.

```ts
import { blackScholes } from '@insiderfinance/totalfinance/options';

const facadePrice = blackScholes.call({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
});
if (Math.abs(facadePrice - rawPrice) > 1e-12) throw new Error('the facade is not the kernel');

const explained = blackScholes.call.explain({
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
});
if (explained.value !== facadePrice) throw new Error('explain changed the value');
if (typeof explained.assumptions.dayCount !== 'string')
  throw new Error('explain names no day count');
```

## Analysis

The analysis level separates the contract from the market and returns an envelope: the value, the
Greeks, the assumptions (exercise style, conventions, engine), and the diagnostics. Nothing is
defaulted silently — an exercise style is required.

```ts
import { engines, market, option } from '@insiderfinance/totalfinance/options';

const analysis = option.price({
  contract: option.call({
    underlying: 'XYZ',
    strike: 105,
    expiry: '2026-06-19T16:00:00-04:00', // an INSTANT — a date alone does not name the close
    style: 'european',
  }),
  market: market({
    spot: 100,
    riskFreeRate: 0.04,
    dividendYield: 0,
    volatility: 0.2,
    asOf: Date.UTC(2026, 2, 20),
  }),
  engine: engines.blackScholes(),
});
if (!(analysis.value > 0)) throw new Error('the analysis priced nothing');
if (!(analysis.greeks.delta > 0 && analysis.greeks.delta < 1))
  throw new Error('delta out of range');
if (analysis.assumptions === undefined || analysis.diagnostics === undefined) {
  throw new Error('an analysis carries its assumptions and diagnostics');
}
```

## Artifact

An artifact is a result you keep: content-addressed, serializable, restorable, replayable, and
comparable. Here a volatility smile around the same strike is calibrated and saved; the restore
reproduces the report byte for byte and the replay reproduces the fit.

```ts
import { canonicalJsonOf, fromCanonicalJson } from '@insiderfinance/totalfinance/core/artifacts';
import { calibrateSvi } from '@insiderfinance/totalfinance/volatility';
import {
  fittedModelArtifact,
  readFittedModel,
  replayFittedModel,
} from '@insiderfinance/totalfinance/volatility/artifacts';

const k = [-0.3, -0.2, -0.1, -0.05, 0, 0.049, 0.1, 0.2, 0.3];
const w = k.map((x) => 0.01 + 0.1 * (-0.3 * (x - 0.02) + Math.sqrt((x - 0.02) ** 2 + 0.1 ** 2)));
const smile = { k, w };
const artifact = fittedModelArtifact({
  family: 'svi',
  fit: calibrateSvi(smile, { timeToExpiryYears: 0.25 }),
  calibration: { smile, options: { timeToExpiryYears: 0.25 } },
});
const restored = readFittedModel({ artifact: fromCanonicalJson(canonicalJsonOf(artifact)) });
if (canonicalJsonOf(restored.report) !== canonicalJsonOf(artifact.result))
  throw new Error('restore changed the report');
if (!replayFittedModel({ artifact }).parity.identical)
  throw new Error('replay did not reproduce the fit');
if (!artifact.id.startsWith('sha256:')) throw new Error('an artifact is content-addressed');
```

## Batch

For convenient row-based pricing, `priceMany({ contracts, market, engine })` returns an ordinary
`PriceResult[]`. Each entry is a named pricing report; no array conversion is needed. Choose that
surface when it matches your data. `SomeType[]` is TypeScript's notation for an ordinary array,
not a specialized numeric buffer.

The expert columnar kernel below accepts typed arrays and returns an object of typed-array columns.
It is useful when throughput and numeric memory layout matter. Five explicitly listed contracts
make each input visible; these buffers are not required preprocessing for every options call. The
first contract is the one above, so `price[0]` is the raw price. Read or iterate the output directly;
only convert it when a downstream consumer specifically requires an ordinary array.

```ts
import { blackScholesPriceMany } from '@insiderfinance/totalfinance/options/batch';

const strikes = [105, 100, 95, 110, 90];
// Columns are typed arrays; `type` is an Int8Array where a positive entry is a call.
const batch = blackScholesPriceMany(
  {
    spot: new Float64Array([100, 100, 100, 100, 100]),
    strike: new Float64Array(strikes),
    volatility: new Float64Array([0.2, 0.2, 0.2, 0.2, 0.2]),
    riskFreeRate: new Float64Array([0.04, 0.04, 0.04, 0.04, 0.04]),
    timeToExpiryYears: new Float64Array([0.25, 0.25, 0.25, 0.25, 0.25]),
    type: new Int8Array([1, 1, 1, 1, 1]),
    dividendYield: new Float64Array([0, 0, 0, 0, 0]),
  },
  { greeks: true },
);
if (Math.abs(batch.price[0]! - rawPrice) > 1e-12) throw new Error('the batch is not the kernel');
if (batch.delta === undefined || batch.delta.length !== strikes.length)
  throw new Error('greeks were requested');
```

When only some outputs matter — gamma alone for a spot sweep, price and delta for a hedge —
`blackScholesEvaluateMany(columns, { outputs: ['gamma'] })` on the same entrypoint computes just
those, with the same values bit for bit, and `blackScholesEvaluateManyInto` writes them into storage
you reuse. [Compute only what you need](./selective-greeks-and-exposure.md) walks through both.

## Workflow

An operation is the same call with a JSON schema, an effect class, a budget, a seed policy, and a
teaching error — the form an agent, the CLI, the HTTP server, and the MCP adapter all share. The
registry runs it locally; nothing leaves the process.

```ts
import {
  createOperationRegistry,
  defaultPacks,
  runOperation,
} from '@insiderfinance/totalfinance/workflows';

const registry = createOperationRegistry({ packs: defaultPacks() });
const operation = registry.get('totalfinance.option.price');
if (operation === null) throw new Error('the pricing operation is a default');
const result = runOperation({
  operation,
  input: {
    type: 'call',
    spot: 100,
    strike: 105,
    timeToExpiryYears: 0.25,
    riskFreeRate: 0.04,
    volatility: 0.2,
  },
});
const structured = result.structured as { value?: number; price?: number };
const workflowPrice = structured.value ?? structured.price;
if (workflowPrice === undefined || Math.abs(workflowPrice - rawPrice) > 1e-9) {
  throw new Error(
    `the workflow is not the kernel: ${JSON.stringify(result.structured).slice(0, 120)}`,
  );
}
```

## The rule

Every level above raw is a thin composition of the level below: the facade calls the kernel, the
analysis envelope wraps the facade's conventions, the artifact stores the analysis, the batch runs
the kernel over columns, the workflow validates and runs the facade. A guide that shows only the
workflow is incomplete; the direct call is always public, tested, and documented — the field
reference (`docs/reference/fields.md`) lists every one of its fields.
