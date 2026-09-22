# @insiderfinance/totalfinance/research

> Point-in-time research primitives: universe screening, cross-sectional style factors, and event studies

Part of **[TotalFinance](https://github.com/InsiderFinance/totalfinance#readme)** — a TypeScript quant toolkit with browser-safe calculation entry points. The main package has no runtime dependencies; optional MCP adds the MCP SDK. On the pro API every result carries its `assumptions` and `diagnostics` (model, conventions, seed, convergence) so nothing is hidden.

## Install

Source version 0.1.0: this command describes the planned published experience, not a verified npm installation. Until publication, use a [source checkout](https://github.com/InsiderFinance/totalfinance#develop).

```sh
pnpm add @insiderfinance/totalfinance@0.1.0
```

## Example

```ts
import { screenUniverse, type ScreenUniverseInput } from '@insiderfinance/totalfinance/research';
const screen = screenUniverse({
  universeId: 'demo@2026-08-12',
  asOf: Date.UTC(2026, 7, 12, 20),
  observations: [
    {
      instrumentId: 'AAA',
      availableTimestampMs: Date.UTC(2026, 7, 1),
      fields: { returnOnInvestedCapital: 0.22, freeCashFlowYield: 0.06 },
    },
    {
      instrumentId: 'BBB',
      availableTimestampMs: Date.UTC(2026, 7, 1),
      fields: { returnOnInvestedCapital: 0.12, freeCashFlowYield: 0.08 },
    },
  ],
  fieldDefinitions: [
    { fieldName: 'returnOnInvestedCapital', kind: 'numeric', unit: 'decimal ratio' },
    { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
  ],
  filter: { field: 'returnOnInvestedCapital', operator: 'greaterThanOrEqual', value: 0.15 },
  missingValuePolicy: 'exclude',
  orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
});
// Every exclusion carries a reason; the screen is deterministic under input permutation.
```

_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._

## Imports and bundles

For portable browser tree shaking, use named imports from `@insiderfinance/totalfinance/<domain>` or supported feature subpaths such as `@insiderfinance/totalfinance/math/normal`. Use public exports, never private `dist` paths.

Installation size is not final bundle size: one main package contains all domains; a bundler removes unused code. The main package has no runtime dependencies. MCP is a separate optional package. Plain Node ESM performs no automatic dead-code elimination. Facades include validation and `.explain()` services; indicators also carry streaming support, not just a bare formula. Type-only imports add no runtime code.

See [Imports and bundles](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guides/imports-and-bundles.md) for examples, namespace tradeoffs, and the generated measurement report.

## Example — `@insiderfinance/totalfinance/research/artifacts`

```ts
import { screenUniverse, type ScreenUniverseInput } from '@insiderfinance/totalfinance/research';
import { researchRunArtifact, readResearchRun, replayResearchRun, compareResearchRuns } from '@insiderfinance/totalfinance/research/artifacts';
import { canonicalJsonOf, fromCanonicalJson } from '@insiderfinance/totalfinance/core/artifacts';
const observations = [
  {
    instrumentId: 'AAA',
    availableTimestampMs: Date.UTC(2026, 7, 1),
    fields: { freeCashFlowYield: 0.06 },
  },
  {
    instrumentId: 'BBB',
    availableTimestampMs: Date.UTC(2026, 7, 1),
    fields: { freeCashFlowYield: 0.08 },
  },
  {
    instrumentId: 'CCC',
    availableTimestampMs: Date.UTC(2026, 7, 1),
    fields: { freeCashFlowYield: 0.02 },
  },
];
const input: ScreenUniverseInput = {
  universeId: 'us-large-cap',
  asOf: Date.UTC(2026, 7, 12, 20),
  observations,
  fieldDefinitions: [
    { fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' },
  ],
  filter: { field: 'freeCashFlowYield', operator: 'greaterThan', value: 0.03 },
  missingValuePolicy: 'exclude',
  orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }],
};
const run = screenUniverse(input);
// Save the run verbatim; reference the bulk rows by content hash instead of embedding them.
const artifact = researchRunArtifact({
  kind: 'screen',
  run,
  input,
  referenceRowSets: ['observations'],
});
const json = canonicalJsonOf(artifact);
const { report } = readResearchRun({ artifact: fromCanonicalJson(json) });
// Replay needs the referenced rows back — they must hash to the stored handle.
const replay = replayResearchRun({ artifact, referencedData: { observations } }); // parity.identical === true
const looser: ScreenUniverseInput = {
  ...input,
  filter: { field: 'freeCashFlowYield', operator: 'greaterThan', value: 0.01 },
};
const comparison = compareResearchRuns({
  baseline: artifact,
  candidate: researchRunArtifact({
    kind: 'screen',
    run: screenUniverse(looser),
    input: looser,
  }),
});
```

_This example runs in CI (`docs/examples/readme-snippets.test.ts`) — it cannot rot._

## API

`@insiderfinance/totalfinance/research` exposes **26** runtime exports (**102** including types) across 5 entrypoints (`.`, `./artifacts`, `./events`, `./factors`, `./screening`). See the generated [`etc/research.api.md`](https://github.com/InsiderFinance/totalfinance/blob/main/packages/research/etc/research.api.md) for the full surface.

## License

Apache-2.0. Part of the [TotalFinance](https://github.com/InsiderFinance/totalfinance#readme) monorepo. Analytics only — not investment advice.

<!-- Generated by tools/readme-gen.ts from package.json + etc/*.api.md + docs/examples/readme-snippets.test.ts. Do not edit by hand; run `pnpm tsx tools/readme-gen.ts`. -->
