# C3 measured budget checkpoint

Status: **technical budget review required; no threshold edited, no complete C3 acceptance**.
Approval/request: `3fa03c0a-dcc3-8e42-a19a-63e21bc53649`; approved spec
`f6c99cfed38dc44c6ca0cc6279cf5a703014f04e`. Feature remains in progress.

## Candidate and isolation

Worktree `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c3-connection`, branch
`totalfinance/community-connector-c3-connection`, based exactly on green C2
`71da9d1fb674932f5fc21a780039aeccd9186d6b`. Candidate source implements the approved connection,
window/restore and shared lazy selector checks, curated /data/root exports and public metadata.
The source commit containing this checkpoint is returned through Ri rather than embedded in itself.
No PR push/edit or hosted C3 run. C2 SDK/provider trees and prior green heads remain untouched.

The root/key/connect/priceBars/period20 SMA file is
[community-connector-connection.ts](../examples/community-connector-connection.ts), with the exact
approved calls. Existing provider factory/runtime remains unchanged; no provider worktree or lock
change was needed for these intermediate proofs. All HTTP facts and keys below are synthetic.

## Repeated pinned source measurements

Node22.23.2, pnpm10.32.0, esbuild0.25.12; browser/ES2022/minified ESM/gzip, existing workspace aliases.
Each baseline and candidate entry was measured twice with byte-identical bytes and retained-module
contributions. Baseline used the read-only C2 tree; candidate used this C3 tree. No pure annotation,
external, alternate minifier setting, registry optimization or threshold modification.

| Whole entry              | C2 min / gzip bytes | C3 min / gzip bytes | Existing ceiling bytes | Result                          |
| ------------------------ | ------------------- | ------------------- | ---------------------- | ------------------------------- |
| Root                     | 2,636,332 / 712,661 | 2,656,881 / 719,087 | 712,960                | +6,426 gzip; 6,127 over ceiling |
| Advanced core/data       | 34,832 / 11,515     | 41,885 / 13,681     | No existing gate       | Wider protocol plus workflow    |
| New consumer /data       | absent              | 41,347 / 13,475     | No initial gate yet    | Initial gate needs review       |
| math/montecarlo          | 20,856 / 7,546      | 20,911 / 7,570      | 7,552                  | 18 over ceiling                 |
| calendars/crypto         | 14,396 / 4,984      | 14,451 / 5,007      | 4,992                  | 15 over ceiling                 |
| fixed-income/convertible | 26,292 / 8,958      | 26,347 / 8,981      | 8,960                  | 21 over ceiling                 |

The unchanged whole-entrypoint suite reports **29 passed, 4 failed /33**. These four failures are
not waived. All structural assertions in that suite passed before its byte assertions.

Root's newly retained modules and minified contributions: data-call722B, data-connection4013B,
data-sequence-validation637B, data-validation11842B, data-view-validation1954B, data-view1168B,
consumer facade69B. Common helpers were already root-reachable; separate gzip sizes cannot be added
as the marginal cost. No external provider, credentials, network implementation, TA engine copy or
conformance runner entered this branch.

For all three narrow failures, retained module sets are **identical** before/after; the only changed
module contribution is core/errors.ts, +55 minified bytes. The single registered
DataWindowBudgetExceeded entry adds the required key/string to the existing retained ErrorCode
registry. No data workflow module enters those narrow graphs. No shared errors/helpers were
optimized to hide this taxonomy cost. The exact graph/byte receipts are
`/tmp/tf-c3-source-measurements.json`; the tracked measurement tool reproduces them.

## Fresh installed measurements and exact example

Fresh application outside both repositories installs explicit local SDK/provider packs; no workspace
alias, source import, remote plugin or registry-SDK compatibility claim. Repeated esbuild0.25.12 and
Rollup4.62.2 installed browser measurements are identical, with module contributions retained in
`/tmp/tf-c3-installed-measurements.json`.

| Installed used import                 | esbuild min / gzip bytes | Rollup min / gzip bytes |
| ------------------------------------- | ------------------------ | ----------------------- |
| Named /data connect                   | 39,511 / 12,977          | 32,746 / 10,820         |
| Root data.connect                     | 41,502 / 13,589          | 32,746 / 10,839         |
| Named /data createPriceBarsWindowView | 35,903 / 11,823          | 36,105 / 11,833         |

All six measurements have no retained conformance runner, provider/HTTP/MCP/CLI package, or TA
implementation. Root namespace esbuild retains the curated two-function data facade; Rollup
removes the unused restore function. These are costs of explicit acquisition, not ordinary compute.
The **226 existing packed-consumer cases all pass**, including unchanged installed/guard-only/
browser budgets and structural checks; no new /data ceiling is asserted by a measurement fixture.

The primary file runs unchanged twice under a fake native fetch and a child-process synthetic key:
30 independent literal-form OHLCV rows, closes100..129 within the explicit September/October query,
once as one source page, once as three pages. Both print **119.5**, the final20 mean of110..129.
Only the external harness injects fake infrastructure; the teaching file has no such ceremony.
NodeNext/Bundler compile the exact primary file plus readonly/type/nameability/misuse cases; root
namespace identity equals /data connect, with **no flat root connect value**.

The existing external/public-fixture rehearsal repeats **83 installed provider cases, 0 skipped**,
shared capability/HTTP/page corpus, original daily/minute/chain continuation bounds/exact nextFrom/
filters/pins, errors and pre/in-flight/body cancellation. Existing SMA101.5, missing-input refusal,
C2 primary, NodeNext/Bundler and provider-free ordinary browser compute pass. It uses the same new
SDK artifact and unchanged C2 provider artifact. Receipt `/tmp/tf-c3-provider-consumer-receipt.json`.

| Intermediate local artifact                                                                | SHA256                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| SDK `/tmp/tf-c3-pack/insiderfinance-totalfinance-0.1.2.tgz`                                | `7ce4c97acdec117451ee3e4288afd2aa131bc10080913fb40d8e3ec5eeea5671` |
| Existing provider C2 `.sdk/insiderfinance-totalfinance-connector-insiderfinance-0.0.0.tgz` | `442ae93eeee5f48284918f83c4f16ac9b9ca5cb99ebeceaec650da1074ba5b9e` |

Provider path is under `/Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view`;
source47c2883/final075d595. Read-only reuse does not edit that reviewed tree. The SDK artifact was
built/packed from this candidate before documentation receipts. Later source or regenerated package
contents require fresh hashes/proofs. Registry SDK0.1.2 lacks these unreleased APIs.

## Concrete proposal for review, not an edited gate

1. **Root only:** 696.25 -> **703 KiB** (719,872 bytes), for measured719,087; 785 bytes headroom.
   This covers the actual +6,426B acquisition branch. No unrelated root expansion or narrower raise
   is implied by approval of this line.
2. **Initial new consumer /data gates:** whole entry13.5KiB (13,824B,349B headroom); installed named
   connect13KiB esbuild/10.75KiB Rollup (335/188B headroom); root data.connect13.5KiB esbuild/
   10.75KiB Rollup (235/169B headroom); restore11.75KiB both bundlers (209/199B headroom).
   Retain the measured structural exclusions and ordinary-compute provider isolation.
3. **Separate narrow taxonomy decision required:** proposed +32 bytes each, solely for the measured
   new error registration: montecarlo7.40625KiB (7,584B,14B headroom), crypto calendar4.90625KiB
   (5,024B,17B headroom), convertible8.78125KiB (8,992B,11B headroom). These increases are **not**
   presumed authorized by the root/data proposal. Alternatively, revising the approved distinct
   error taxonomy needs explicit technical direction. No existing installed/guard-only/browser
   gate failed or is proposed to change. No shared registry/helper optimization is proposed.

These are bounded, measured recommendations for the coordinator; no budget file has been edited.
After review and any further source corrections, repeat measurements before adopting approved caps.

## Source verification and unfinished acceptance

Pinned frozen install, build, typecheck and scoped ESLint pass. Scoped Prettier/git diff checks pass.
Documentation/error/code checks pass38/38 (including24 documentation cases); documentation inventory
is248 surfaces/4641 executable fences/zero findings. The new connect structural-provider argument
gets the same narrowly open artifact policy as defineDataProvider; requests/options remain closed.
No existing policy or threshold was loosened. New source tests began with three
failures for missing connect; the candidate passes focused source/C2/fixture/assembly tests. **155 tests /6 files pass**, including55 new window cases. Documentation conformance and scoped
format checks are recorded with the Ri handoff. The source suite covers late original-bound escapes,
within/across-page ordering/identity and pin/basis changes, metering/defaults/overrides/shrinking
limits, empty/zero/partial/missing-first/later-volume facts, lying selectors under both query/window,
canonical restore mutants, ignoring-provider abort/late rejection, no continuation after body
abort, safe arbitrary-error refusal and typed allowance without retry. Existing engines unchanged.
New first-touch fixtures reach constructors and returned methods; kit accepts ConnectedData through
its unchanged one-page consumer contract. SDK-created arrays are frozen native arrays; no unsupported
portable arbitrary-Proxy detection claim.

This is the required **budget checkpoint**, not final C3 implementation acceptance. Affected ordered
signature/naming/contract/enforcement/API/documentation generation and final manifest/fixture counts,
expanded final C3 consumer/refusal cases and exact-head fast/full hosted checks remain outstanding.
No zero-defect/generated-current/hosted-green claim is made for C3. All29 passing whole budgets and
226 installed cases do not excuse the four explicit failures. No full local CI/coverage repeat.

Reproduction tools:

```sh
pnpm exec vitest run tools/bundle-size/budgets.test.ts
pnpm exec tsx tools/community-connectors-connection-measure.ts /Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c2-addendum "$PWD" /tmp/tf-c3-source-measurements.json
pnpm exec tsx tools/community-connectors-connection-consumer.ts /tmp/tf-c3-pack/insiderfinance-totalfinance-0.1.2.tgz /Users/agent/ri/.work/worktrees/totalfinance-insiderfinance-connector/connector-c2-view/.sdk/insiderfinance-totalfinance-connector-insiderfinance-0.0.0.tgz /tmp/tf-c3-installed-measurements.json
pnpm exec vitest run tools/packed-consumer.test.ts
```

No staging/secret/allowance/key/grant/account/paper operation, API-server edit, provider remote,
release/version/publication/deployment/merge, recurring automation or live execution. PR26 remains
draft at reviewed C2 head; feature/execution stays linked and in progress. Later maintainer10/10,
connected-agent/paper/App acceptance is separate.

## Disposition

Coordinator requeste2fef6ff-8d7a-8297-92b4-f50e5d6d8b0f approved the exact caps proposed above,
including the separately reviewed narrow taxonomy increases and initial data gates. Independent
source/installed graph/byte repeats match;94 source cases and exact119.5 primary example pass.
This resolves the budget checkpoint at b0fcbf3. Earlier failures remain historical evidence;
final source/packed measurements and fresh generated/hosted acceptance must still pass. The
required actual-door teaching correction is implemented/tested before final verification. No
merge authority or further threshold increase follows from this technical approval.
