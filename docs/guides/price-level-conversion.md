# Convert futures/index and ETF reference price levels

Use `convertPriceLevel` when you have a comparable pair of reference prices and want an
approximate target level under the same proportional mapping. ES/SPY and NQ/QQQ use the same
calculation. These numbers are illustrative inputs, not current market quotes.

```ts
import { convertPriceLevel } from '@insiderfinance/totalfinance/valuation/price-levels';

const estimatedSpy = convertPriceLevel({
  method: 'reference-prices',
  sourcePriceLevel: 6030,
  referenceSourcePrice: 6000,
  referenceTargetPrice: 596,
  sourcePriceUnit: 'ES index points',
  targetPriceUnit: 'USD per SPY share',
}); // approximately 598.98 USD per SPY share

const estimatedEs = convertPriceLevel({
  method: 'reference-prices',
  sourcePriceLevel: estimatedSpy,
  referenceSourcePrice: 596,
  referenceTargetPrice: 6000,
  sourcePriceUnit: 'USD per SPY share',
  targetPriceUnit: 'ES index points',
}); // approximately 6030 ES index points

const explainedQqq = convertPriceLevel.explain({
  method: 'reference-prices',
  sourcePriceLevel: 20250,
  referenceSourcePrice: 20000,
  referenceTargetPrice: 500,
  sourcePriceUnit: 'NQ index points',
  targetPriceUnit: 'USD per QQQ share',
}); // value: 506.25; assumptions echo the inputs; diagnostics disclose the limitations

const estimatedQqqFromRatio = convertPriceLevel({
  method: 'ratio',
  sourcePriceLevel: 20250,
  targetPricePerSourcePrice: 0.025,
  sourcePriceUnit: 'NQ index points',
  targetPriceUnit: 'USD per QQQ share',
}); // 506.25 USD per QQQ share

const estimatedNqFromRatio = convertPriceLevel({
  method: 'ratio',
  sourcePriceLevel: 506.25,
  targetPricePerSourcePrice: 40,
  sourcePriceUnit: 'USD per QQQ share',
  targetPriceUnit: 'NQ index points',
}); // 20250 NQ index points
```

Reference mode applies `sourcePriceLevel * referenceTargetPrice / referenceSourcePrice`.
To reverse direction, swap the unit labels and references, and pass a level in the new source
unit. Ratio mode takes **target price units per one source price unit**; supply the reciprocal
ratio for the reverse call. The library never infers the method or direction.

All fields shown are required for their chosen method. References and ratios must be positive
finite numbers; the requested source level must be nonnegative and finite. Unit labels must be
nonblank strings. Unknown fields and mixing the methods are typed errors, including a forbidden
field whose value is `undefined`. `input.out_of_range` also refuses output overflow and positive
underflow that rounds to zero. Nonzero subnormal results retain double-precision limits; no
rounding to cents or ticks occurs.

The domain import `@insiderfinance/totalfinance/valuation` exposes the same function; the root
package exposes `valuation.convertPriceLevel`. For form validation or JSON Schema, import
`ConvertPriceLevelInputSchema` from `@insiderfinance/totalfinance/valuation/schemas`. The schema
validates the request; the calculator additionally enforces representable results.

The mapping assumes that the supplied proportional relationship remains valid at the requested
level. It is not a live quote, predicted ETF open, arbitrage/fair-value result, option premium or
notional/delta hedge equivalence. Your application owns instrument presets, quote acquisition,
reference timestamps, market-session comparability, contract selection, currency/unit consistency
and freshness policy. Unit labels document your inputs; they do not authenticate those facts.
