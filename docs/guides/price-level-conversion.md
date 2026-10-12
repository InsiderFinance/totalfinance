# Convert futures/index levels to ETF levels

Start with a named helper when your pair is listed below. Supply the level to translate and
comparable reference prices for both instruments; the helper supplies the method and unit labels.
These examples use illustrative prices, not current quotes.

```ts
import {
  esToSpyLevel,
  spyToEsLevel,
  nqToQqqLevel,
} from '@insiderfinance/totalfinance/valuation/price-levels';

const estimatedSpy = esToSpyLevel({
  esPriceLevel: 6030,
  referenceEsPrice: 6000,
  referenceSpyPrice: 596,
}); // approximately 598.98 USD per SPY share

const estimatedEs = spyToEsLevel({
  spyPriceLevel: estimatedSpy,
  referenceSpyPrice: 596,
  referenceEsPrice: 6000,
}); // approximately 6030 ES index points

const explainedQqq = nqToQqqLevel.explain({
  nqPriceLevel: 20250,
  referenceNqPrice: 20000,
  referenceQqqPrice: 500,
}); // value: 506.25
// assumptions.input echoes these three named prices.
// assumptions.conversion contains the canonical reference mapping and descriptive units.
// assumptions.resultUnit is 'USD per QQQ share'; diagnostics disclose the approximation.
```

## Named pairs, both directions

| Pair       | To ETF           | From ETF         |
| ---------- | ---------------- | ---------------- |
| ES ↔ SPY   | `esToSpyLevel`   | `spyToEsLevel`   |
| NQ ↔ QQQ   | `nqToQqqLevel`   | `qqqToNqLevel`   |
| YM ↔ DIA   | `ymToDiaLevel`   | `diaToYmLevel`   |
| RTY ↔ IWM  | `rtyToIwmLevel`  | `iwmToRtyLevel`  |
| SPX ↔ SPY  | `spxToSpyLevel`  | `spyToSpxLevel`  |
| NDX ↔ QQQ  | `ndxToQqqLevel`  | `qqqToNdxLevel`  |
| RUT ↔ IWM  | `rutToIwmLevel`  | `iwmToRutLevel`  |
| DJIA ↔ DIA | `djiaToDiaLevel` | `diaToDjiaLevel` |

Every helper takes exactly three fields with the same naming pattern:
`<source>PriceLevel`, `reference<Source>Price`, and `reference<Target>Price`.
For example, `ymToDiaLevel` takes `ymPriceLevel`, `referenceYmPrice`, and
`referenceDiaPrice`. Autocomplete and the generated reference show each exact input type.

Futures and cash-index levels are different inputs: ES is not SPX, NQ is not NDX, RTY is not
RUT, and YM is not DJIA. **DJIA here means the full Dow Jones Industrial Average, not DJX.**
Reference contract selection and provider ticker normalization belong to your application.
Contract multipliers and micro-contract size differences do not enter this price-level math.
These helpers do not calculate option premiums, contract exposure or position size.

## How the math works

The same proportional calculation powers every named helper and the generic primitive:

```text
target level = source level × reference target price / reference source price
598.98       = 6030         × 596                    / 6000
```

A source level 0.5% above its reference maps to a target level 0.5% above its reference.
There are no fixed ES/SPY, SPX/SPY, or other ticker ratios. Changing either reference changes
the mapping. Always supply comparable reference prices—for example, references from the same
chosen valuation instant—and decide their freshness policy in your application.

## Any other pair, or an explicit ratio

Use `convertPriceLevel` for arbitrary instruments. `method` remains required; descriptive
unit labels are independently optional and never change the arithmetic.

```ts
import { convertPriceLevel } from '@insiderfinance/totalfinance/valuation/price-levels';

const genericSpyLevel = convertPriceLevel({
  method: 'reference-prices',
  sourcePriceLevel: 6030,
  referenceSourcePrice: 6000,
  referenceTargetPrice: 596,
}); // approximately 598.98, in the units of referenceTargetPrice

const estimatedQqqFromRatio = convertPriceLevel({
  method: 'ratio',
  sourcePriceLevel: 20250,
  targetPricePerSourcePrice: 0.025,
}); // 506.25

const estimatedNqFromRatio = convertPriceLevel({
  method: 'ratio',
  sourcePriceLevel: 506.25,
  targetPricePerSourcePrice: 40,
}); // 20250

const explainedCustomLevel = convertPriceLevel.explain({
  method: 'reference-prices',
  sourcePriceLevel: 6030,
  referenceSourcePrice: 6000,
  referenceTargetPrice: 596,
  sourcePriceUnit: 'ES index points',
  targetPriceUnit: 'USD per SPY share',
}); // assumptions.resultUnit: 'USD per SPY share'
```

Ratio mode takes **target price units per one source price unit**. Reverse reference mode by
swapping the two references and passing a level in the new source unit, or supply the reciprocal
ratio for a reverse ratio call. The generic function never infers the method or direction.

For generic `.explain()`, `resultUnit: null` means the caller did not supply a target unit label;
the calculation still uses the units of the supplied target reference (or directed ratio).
Omitted/undefined optional labels are omitted from the echoed request. Provided labels must be
nonblank strings; they document your inputs but do not authenticate instruments or convert units.

## Validation and imports

All three numeric coordinates of a named helper are required. References and ratios must be
positive finite numbers; requested levels must be nonnegative and finite. Zero maps to zero.
Both the plain call and `.explain()` reject malformed inputs and unknown fields. Named helpers
do not accept `method`, unit labels, ratios or contract multipliers; use the generic primitive
for other mappings. Errors identify the function and coordinate that need correction.

`input.out_of_range` refuses output overflow and positive underflow that rounds to zero.
Nonzero subnormal results are supported; range-boundary arithmetic rounds the supplied binary
inputs correctly. No cents or tick rounding occurs.

The domain import `@insiderfinance/totalfinance/valuation` exposes the same functions; the root
package exposes them under `valuation`. Prefer the focused `valuation/price-levels` import for
a single helper. Unused siblings can be removed by tree shaking.

For form validation/JSON Schema, import `EsToSpyLevelInputSchema`, `SpyToEsLevelInputSchema`,
etc. from `@insiderfinance/totalfinance/valuation/schemas`. Each helper has a matching named
input type, such as `EsToSpyLevelInput`, exported alongside the function. The generic schema is
`ConvertPriceLevelInputSchema`. Schemas validate requests; calculators also enforce representable
results. Compute imports do not include schema machinery.

## What this does not promise

The supplied proportional relationship is assumed to remain valid at the requested level.
This is not a live quote, predicted ETF open, arbitrage/fair value, option premium or
notional/delta hedge. Futures basis, dividends, ETF tracking differences and market sessions can
change the relationship. Your application owns comparability, timestamps, contract selection,
currency/unit consistency and freshness. No fixed ratios, data acquisition or provider calls
are hidden in the library.

The pair identities follow [CME's equity-index products](https://www.cmegroup.com/markets/products)
and issuer benchmark descriptions for [SPY](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy),
[QQQ](https://www.invesco.com/qqq-etf/en/home.html),
[DIA](https://www.ssga.com/us/en/individual/capabilities/spdr-core-equity-etfs/dia-djia) and
[IWM](https://www.ishares.com/us/products/239710/ishares-russell-2000-etf).
These identities are not promises of an exact price ratio or identical returns.
