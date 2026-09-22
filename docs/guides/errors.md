# Errors and Diagnostics

TotalFinance separates programmer/input failures from quantitative failures.

## Facades

Facade functions return plain values and throw typed `QuantError` subclasses for invalid inputs or failed solves.

```ts
import { blackScholes } from '@insiderfinance/totalfinance/options';

blackScholes.call({
  spot: -1,
  strike: 100,
  timeToExpiryYears: 1,
  riskFreeRate: 0.05,
  volatility: 0.2,
});
// throws InputError with code "input.negative_spot"
```

For solver details without throwing on quantitative non-convergence, use `.explain()`.

```ts
const result = blackScholes.impliedVolatility.explain({
  price: 0.01,
  spot: 200,
  strike: 100,
  timeToExpiryYears: 1,
  riskFreeRate: 0.05,
  type: 'call',
});

result.diagnostics.converged; // false
result.diagnostics.warnings[0]?.code; // "implied_volatility.below_intrinsic"
```

## Pro APIs

Pro APIs already return explained results, so quantitative failures are reported through diagnostics instead of guessed values. Invalid inputs and unsupported contracts still throw typed errors.

## MCP

The MCP server converts validation and compute errors into structured tool errors. Quantitative non-convergence is returned as structured content with `converged: false` so agents can reason about the failed solve instead of treating it as infrastructure failure.
