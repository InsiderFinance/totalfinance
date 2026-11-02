# Community connector C2 implementation — 2026-11-02

Status: **offline source and installed-package checks pass; fresh hosted checks pending**.
Feature `01a19da0-2a6f-7450-89a4-2e51047b05b5` remains in progress. No merge is authorized.

## Result and ownership

The [primary example](../examples/community-connector-sdk.ts) has two imports: the external
InsiderFinance factory and the existing TotalFinance SMA. `createInsiderFinanceProvider(apiKey)`
returns a provider whose direct query returns the SDK-owned consumer view. `prices.closePrices`
is a frozen native numeric array; existing SMA and SMA.explain accept it unchanged. The complete
validated source stays at `prices.page`. Strict lazy `ohlcvBars` refuses missing first/later volume
without blocking known closes. Source quality alone creates no blanket field ban.

`defineDataProvider(source)` binds the separate raw `DataProviderSource` protocol. The common SDK
validates/freeze-copies raw pages and owns views; external packages implement no projection or
calculation. `createDataView(rawPage)` validates persisted raw pages and restores the same view.
Getters are non-enumerable, cached and local; serializing the view does not select OHLCV. Canonical
identity belongs to `.page`. Pagination stays explicit and each selection is its own page sample.

The private provider preview uses the documented staging origin, native fetch and receipt clock
by default. Explicit overrides remain injectable and invalid overrides refuse. Receipt time is read
when receiving a response, never substituted for unknown source observation/availability/valuation.
Construction/discovery make no HTTP or clock reads. No fallback origin or environment guessing.
Ordinary compute imports, indicators and financial defaults are unchanged. MCP is not required.

## Review and isolation

The [approved spec](../specs/community-connector-c2-integration.md) at `e1e5a910` was approved through
request `754a6ffa-2218-8bba-9767-5c98b322390c`, including the direct-source correction. The earlier
rejection remains in the [spec review history](./community-connectors-c2-spec-2026-11-02.md).
The implementation execution reached model capacity mid-run; the coordinator continued the same
preserved isolated trees, with no competing implementation or new scope.

SDK worktree: `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c2-addendum`, branch
`totalfinance/community-connector-c2-spec`, based on historical C1 `b5c3c83`.
Provider worktree: `/Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view`,
branch `connector/sdk-consumer-view`, based on historical C1 `c492d2d`. The reviewed C1 worktrees,
shared checkouts and linked application source remain untouched.

## Measured verification

Node **22.23.2**, pnpm **10.32.0**. Frozen installs, build, TypeScript, scoped ESLint/Prettier and
all 25 API reports pass. No dependency graph or release version changes in the SDK.

- **530 distinct SDK tests across 19 files**, counting the corrected naming tracker rerun
  once: 303 focused/source/generated/docs/bundle tests and 227 packed SDK/fixture tests.
- **83/83 provider tests locally and all 83 again through a fresh installed package**, none skipped.
- Exact two-import, API-key-only example runs with independently supplied synthetic HTTP facts;
  closes `[100,101,102]` give last period-2 SMA **101.5**, with original partial quality/null source
  clocks retained. Existing SMA.explain and VWAP parity, missing-volume refusal, zero/empty data,
  immutability, page restoration/identity and independent one-defect view mutants pass.
- Fixture and HTTP provider pass the same shared compatibility corpus: original bounds/filters,
  requested nextFrom, resource/snapshot pins, ordering/identity, typed safe failures and pre/in-flight/
  body cancellation. Missing pricing terms still refuse rather than being fabricated.
- Clean NodeNext/Bundler/ESM consumers accept readonly/generic/narrowed types and reject removed
  envelopes. Browser compute remains provider-free. All **33 original whole-entrypoint limits**,
  installed-consumer budgets and guard-only retention tests pass without changing ceilings.

Reproduction commands (from the SDK worktree unless stated otherwise):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm api:check
pnpm exec vitest run packages/core/test/data.test.ts packages/core/test/data-view.test.ts packages/core/test/data-conformance.test.ts tools/first-touch/fixtures/core-data.test.ts tools/first-touch/unknown-keys.test.ts tools/bundle-size/budgets.test.ts tools/bundle-size/public-artifacts.test.ts tools/bundle-size/consumer-measure.test.ts tools/bundle-size-doc.test.ts tools/manifest/contract-conformance.test.ts tools/manifest/fixture-validation.test.ts tools/manifest/naming-conformance.test.ts tools/manifest/signature-conformance.test.ts tools/manifest/signature-fixture-conformance.test.ts tools/manifest/public-text-naming.test.ts tools/docs-conformance.test.ts tools/public-reference.test.ts
pnpm exec vitest run tools/packed-consumer.test.ts tools/community-connectors-consumer.test.ts
# Provider worktree:
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm pack --pack-destination .sdk
```

The provider's file dependency integrity is refreshed only for the newly packed local SDK, then
frozen installation is repeated. A new clean application explicitly installs both tarballs; no
workspace aliases or registry SDK compatibility are assumed. Installed rehearsal:

```sh
pnpm exec tsx tools/community-connectors-provider-smoke.ts /Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view/.sdk/totalfinance.tgz /Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view/.sdk/insiderfinance-totalfinance-connector-insiderfinance-0.0.0.tgz /Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view/test /tmp/totalfinance-community-c2-final-consumer-receipt.json
```

| Locally tested artifact                                                        | SHA-256                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| SDK `.sdk/totalfinance.tgz`                                                    | `a705cdfdf966444f42b4a2afd31ca4cab6104f98c29262eba1ed4196f2a4995f` |
| Provider `.sdk/insiderfinance-totalfinance-connector-insiderfinance-0.0.0.tgz` | `442ae93eeee5f48284918f83c4f16ac9b9ca5cb99ebeceaec650da1074ba5b9e` |

Paths are in the isolated provider C2 worktree above. SDK pack was assembled by `pnpm build` and
packed from `distribution/totalfinance`, then copied into that ignored `.sdk` directory. SDK source commit: `73dc804a139bb95eb98a0650c91fa436701b62aa`. Provider source/receipt commit:
`47c2883aeac51a355d8f8097d30a7068379766c3`. The final SDK documentation receipt is attached to PR26
and the Ri handoff. Package
versions remain SDK 0.1.2/provider 0.0.0; **registry SDK 0.1.2 lacks these unreleased subpaths**.
The artifact hashes, not matching version labels, identify this tested compatibility.

## Generator and check corrections

Affected generation ran in order: signature → naming → contract → enforcement → validation → API →
README → llms → bundle → OpenAPI → documentation. No derived evidence was hand-edited. Direct-source
migration initially left the old nested-provider policy attached to a removed envelope. Moving its
existing open structural-source policy to argument zero restored truthful classification; vendor
state remains allowed and consumed identity/methods remain validated. Requests/options remain
closed. Final enforcement has **0 defects**, 2,574 enforced, 2,702 partial and the unchanged
187 unmeasured ceiling. Naming walks 43,656 identities with zero unresolved; documentation inventory has 245 surfaces and
zero findings.

Generation exposed stale human tracker totals and the new raw-page first-touch fixture count;
these were synchronized to measured artifacts (1,336 fixtures), with their gates retained. The
external factory import in the guide has an exact path/owner/import-line disposition, tested to
reject an invented SDK-root import. No documentation walker or gate behavior was loosened.
The first targeted run reported the stale naming counters; the corrected 32-test naming file passes.
This is focused verification, not a claim of full local CI or another coverage run.

## Remaining acceptance

- [ ] Fresh exact-head fast and full hosted checks for the combined PR26 C1/C2 implementation.
- [ ] Maintainer consumer acceptance; an approved design and synthetic tests do not establish 10/10.
- [ ] Separately authorized staging access/allowance, real installed-agent/paper journey and MCP App.

No merge, publication, version bump, deployment, provider remote, live execution, recurring automation,
secret access, staging reads, allowance/key/grant changes or active paper/account/store mutation.
