# First success: synthetic data to ordinary calculations

No key, market-data request or npm SDK release is needed. This source-checkout preview supports
**daily/minute price bars and incomplete option-chain research**. It is not a universal provider
registry. Pure calculations stay ordinary; provider packages translate source facts once.

Use Node22.23.2 and pnpm10.32.0 (the versions in .nvmrc and package.json). Install that toolchain
first if missing. From a clean checkout of this feature branch at repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p .local-connector-artifacts
(cd distribution/totalfinance && pnpm pack --pack-destination ../../.local-connector-artifacts)
node examples/community-connectors/starter/prepare-sdk.mjs .local-connector-artifacts/insiderfinance-totalfinance-0.1.3.tgz
(cd examples/community-connectors/starter && pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm pack --pack-destination ../../../.local-connector-artifacts)
node examples/community-connectors/starter/run-consumer.mjs .local-connector-artifacts
```

The preparation step copies the exact local SDK tarball and refreshes its file integrity in the
starter's lock before frozen installation. The starter is an independent pnpm project at
[examples/community-connectors/starter](../../examples/community-connectors/starter), outside the
SDK's workspace glob, with its own project boundary and lock. It uses public SDK imports only.
Packing an independently installable example is not npm publication. No SDK binary is committed.
Registry0.1.3 does not supply the unreleased connector contract; do not substitute it for this pack.

The runner installs both packs into a new temporary consumer and repeats frozen installation.
Its synthetic JSON has cents-based OHLC fields, session labels and actual share volume. The source
maps cents to dollars/share once, retains actual source identity and unknown clocks, then the
consumer uses the same path as any provider:

```ts
const prices = await data.connect(createStarterProvider(rows, receipt)).priceBars(request);
const average = technicalAnalysis.sma(prices.closePrices, { period: 2 }).at(-1);
const weighted = technicalAnalysis.vwap(prices.ohlcvBars).at(-1);
console.log({ average, weighted, source: prices.window.pages });
```

Expected values are **103** and **102**. The retained pages contain the observed-only/gapped
coverage warning, provenance, original time facts and limitations. They are not automatically
copied into a pure indicator result. Keep that context beside any displayed number.

For SMA(20), three rows are insufficient even when pagination is terminal:

```ts
const last = technicalAnalysis.sma(prices.closePrices, { period: 20 }).at(-1);
if (last === undefined || !Number.isFinite(last)) {
  console.log('Insufficient history for SMA(20): 3 observed rows; no additional read.');
}
```

No bang assertion, fake warmup row, automatic extra request or filled gap. Missing actual volume
blocks OHLCV/VWAP selection only; known closes can still support SMA. Partial quality alone does
not forbid valid closes. Zero is a real value. Midnight daily timestamps label sessions, not source
observation instants. Terminal pagination proves neither continuous history nor trade eligibility.

## Write and repair one mapping

Read the small independent [source](../../examples/community-connectors/starter/src/index.ts) and
its [expected-page test](../../examples/community-connectors/starter/test.mjs). A daily-only raw
query returns Promise<DataPage<PriceBarRecord>> naturally, without conditional return assertions.
It explicitly refuses unsupported kinds/intervals; the consumer retains generic request inference.

The runner copies this author package, intentionally changes only `close: row.closeCents / 100`
to `close: Number.NaN`, and rebuilds. Its actual refusal is:

```text
data.invalid_response data[].bar.close not_finite
```

The error also carries phase=page, validationCode=input.not_finite and rowIndex=0. Repair that
one line to `close: row.closeCents / 100`; the expected pages and ordinary calculations pass again.
The error identifies the field and rule; it never echoes the broken value or arbitrary source text.
The runner separately omits cents scaling from all OHLC fields. Those prices are finite and
internally consistent, so schema validation cannot infer the unit mistake: the independently
expected literal pages reject it under the kit's expected-facts law. Both proofs matter.

## Use compatible real data later

After separately configuring access and an allowance, replace only the provider binding with
`createInsiderFinanceProvider(apiKey)` from the independently installed reference connector.
The same `data.connect(provider).priceBars(request)` and existing calculations remain. Follow the
[connector guide](./community-connectors.md) for explicit symbol/interval/dates and the exact root
example. Never treat the preview staging origin as an access grant. No real request is part of
this recipe. The reference chain remains EOD research with incomplete terms and unknown clocks;
there is no automatic conversion into pricing or fills.
