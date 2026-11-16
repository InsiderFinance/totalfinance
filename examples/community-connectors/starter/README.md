# Independent synthetic connector starter

Follow [the complete no-key journey](../../../docs/guides/community-connector-first-success.md)
from repository root. This is a separate pnpm project, outside the SDK workspace, not a published
package. It maps explicit USD cents/share and actual shares from synthetic daily vendor JSON.

`prepare-sdk.mjs` prepares the exact local SDK integrity; then frozen install/build/test/pack and
`run-consumer.mjs` prove a fresh public consumer, the independent expected-page oracle, safe error
repair, SMA103/VWAP102, insufficient history and retained source warnings. No key or HTTP call.
