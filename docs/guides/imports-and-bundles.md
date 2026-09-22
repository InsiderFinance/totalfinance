# Imports and bundles

Use named imports from `@insiderfinance/totalfinance/<domain>` as the portable browser
default. The main package includes every domain and feature subpath with no runtime dependencies;
only `@insiderfinance/totalfinance-mcp` is a separate optional install. TotalFinance is an unpublished preview: these are supported import
shapes for a built checkout, not evidence of a completed npm installation.

## Start with a domain

With the umbrella installed:

```ts
import { normalCdf } from '@insiderfinance/totalfinance/math';

console.log(normalCdf(0)); // 0.5
```

Supported feature subpaths are another explicit choice:

```ts
import { normalCdf } from '@insiderfinance/totalfinance/math/normal';

console.log(normalCdf(0)); // 0.5
```

Other examples include `@insiderfinance/totalfinance/technical-analysis/rsi` and
`@insiderfinance/totalfinance/options/black-scholes`. Use the package's public export map, never private `dist`
paths. Domain and feature paths are exports of the same main package; they are not separate installs.
Domain named imports need no consumer-specific plugin.

## Namespace convenience has a tradeoff

Direct namespace imports with static member access can tree-shake in both esbuild and Rollup:

```ts
import * as math from '@insiderfinance/totalfinance/math';

console.log(math.normalCdf(0)); // 0.5
```

That is different from the root's namespace re-export:

```ts
import { math } from '@insiderfinance/totalfinance';

console.log(math.normalCdf(0)); // 0.5, but bundler-dependent retention
```

In the tested esbuild configuration, this second form retains the whole math namespace because of
[esbuild issue #1420](https://github.com/evanw/esbuild/issues/1420). Rollup shakes this static use.
The braces in `import { math }` select a namespace object, not a named calculation. Prefer named
domain imports when the same code must stay small across bundlers.

The root namespace API remains supported for convenience and discovery. It also hoists exactly five
option gestures: `blackScholes`, `option`, `market`, `engines`, and `impliedVolatility`. Other option
exports live under `options` or their supported domain/feature entrypoints, not flat on the root.

Runtime-selected access such as `math[name]`, namespace enumeration such as `Object.values(math)`,
and registries that dispatch to many calculations inherently retain the implementations they can
reach. Tree shaking cannot remove functionality your program may select at runtime. This applies
even to a direct namespace import; it is distinct from the esbuild re-export limitation.

## Three different sizes

- **Installation size:** package files and dependencies on disk. The main package includes all domains;
  MCP adds its SDK dependency and depends on the exact main version. Tree shaking does not shrink an install.
- **Final bundle size:** code retained by the production bundler for the imports and calls you use.
  ESM and `sideEffects: false` enable removal of unused code, but access patterns and bundler behavior
  still matter. Installing the umbrella does not require delivering every domain to the browser.
- **Plain Node ESM loading:** Node loads the imported module graph; it performs no automatic dead-code
  elimination. A named import from a broad barrel is not a promise to load only one function. Use a
  supported feature subpath when you want a narrower unbundled module graph.

Type-only imports, such as `import type { BlackScholesKernelInput } from
'@insiderfinance/totalfinance/options/black-scholes'`, are erased from emitted JavaScript and add no runtime code.
Browser-safe compute entrypoints remain separate from Node-only transports and filesystem helpers.

## A facade is more than a formula

`blackScholes` includes input validation, typed errors, and `.explain()` assumptions and diagnostics.
An indicator such as `rsi` also carries its streaming and serialization services. Importing one of
these public objects is not the cost of a bare formula, even when you call just one method.
The expert `blackScholesPrice` export on `@insiderfinance/totalfinance/options/black-scholes` offers a different,
documented contract; choose it for that contract, not to bypass validation.

See the generated [bundle size report](../bundle-size.md) for enforced measurements. Whole-entrypoint
budgets and used-function consumer budgets answer different questions: keeping an entire entrypoint
is not the cost of one selected calculation. Compare matching import forms and bundlers, and measure
your own production build; neither set of bundle measurements describes installation size or plain
Node loading.
