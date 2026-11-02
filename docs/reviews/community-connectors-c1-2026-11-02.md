# Community connector offline C1 implementation — 2026-11-02

Status: offline C1.1–C1.4 implemented and locally verified; feature remains in progress pending
hosted checks, technical implementation review and later connected acceptance. This record is updated from actual
receipts; unchecked live/agent/App acceptance is not certified by offline checks.

## Scope and review authority

The coordinating chat approved C0 at `9815f73567ddf235fca7e94d8ee560c1e6bed42a` in required request
`b08d8379-d256-8977-8958-f1a9e2248f9e`, after reviewing the full 643-line proposal, evidence, public
core types and actual REST mappings. This is the technical review required by CONTRIBUTING.md.
No additional generic maintainer permission was requested for the already authorized offline work.

SDK worktree: `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-093566`.
Branch: `totalfinance/build-community-connector-foundation`, based on fetched main
`d50b401ee237006c75c76ef90784e5dcde1439a3`. Independent provider local repository:
`/Users/agent/ri/.work/repos/totalfinance-insiderfinance-connector`, branch `main`, no remote.
No shared checkout branch was switched. The pre-existing untracked SDK `.env` was not opened,
modified or staged. The originating next-features checkout and active paper stores remain untouched.

The [approved spec](../specs/community-connector-foundation.md) and
[guide](../guides/community-connectors.md) own contract and usage details. Source evidence and
original hashes remain in the [C0 record](./community-connectors-c0-2026-11-02.md).

## Implemented boundaries

- `@insiderfinance/totalfinance/core/data`: `DATA_CONTRACT_VERSION`, `defineDataProvider`, typed
  object requests, capability descriptors, pages, explicit clocks, normalized bar records and
  incomplete option-chain research records. No root re-export, provider dependency, credential,
  clock read or network client enters ordinary compute.
- `@insiderfinance/totalfinance/core/data-conformance`: `validateDataProvider` and typed
  page/error/abort probes with explicit page/record/time bounds. The kit examines a supplied provider
  directly, checks exact expected facts and independently rejects invalid output and mutation.
- SDK-owned [fixture](../examples/community-connector-fixture.ts),
  [synthetic facts](../examples/community-connector-facts.ts), first-touch fixtures and fresh packed
  SDK NodeNext/Bundler/ESM consumer tests.
- Independent provisional `@insiderfinance/totalfinance-connector-insiderfinance@0.0.0` exposes
  `createInsiderFinanceProvider({ baseUrl, apiKey, fetch, now })`. It imports only public SDK modules,
  makes at most one HTTP request per query, performs no discovery/configuration reads, and uses
  synthetic injected HTTP fixtures. The package remains private/local-only and is not a third
  TotalFinance distribution or Changesets workspace.

Daily midnight UTC is a session-date label. Minute start, source observed/receive time, revision and
provisional state remain distinct. Public availability remains null when absent. Chains retain EOD
snapshot/session/storage facts, source quote/IV/Greek units, separate theoretical prices, null exact
valuation/expiry and incomplete terms. Roots/OCC symbols, verified multiplier, rates and volatility
are not fabricated. The reported 100 multiplier is source-assumed diagnostic context only. Every
v1 page is research-only and advertises no historical point-in-time safety or executable liquidity.

Continuations keep resource identity and original filters; chain REST calls repeat the symbol and
send only cursor/limit as query fields. Bars retain their upper bound and disclose best-effort
consistency. Cross-resource cursors, replaced pins, repeated/nonadvancing pages and malformed or
nonfinite rows refuse. Bounds never prove continuous coverage. API-01's separate server task and
API-02–05 source-qualified limitations remain separate.

Errors use the consumer's SDK QuantError identities. Authentication, entitlement, throttles,
exhausted allowance, snapshot expiry, cancellation, invalid request/response and unavailable service
remain distinct. Retry metadata never causes a retry. Context contains safe status/code/request IDs
and an explicit delay when provided; arbitrary upstream details, bodies, cursors, credentials and
causes are excluded. Pre-abort makes no transport call; fetch/body aborts and late success refuse.

## Integration corrections and unchanged gates

Initial integration found 22 existing byte-budget failures from the expanded shared error/warning
catalogs. No budget was raised. The error catalog now materializes its exact declared literal table
from compact names, avoiding duplicate retained PascalCase/snake_case spellings. The generated
public type stays an anonymous readonly literal object; a declaration-to-runtime test verifies
**every** key, value and enumeration position. There is no new public helper or financial computation.
All 33 existing bundle-budget checks subsequently passed under their original ceilings.

The initial enforcement generation also exposed an actual tooling bug: the synchronous producer
pre-pass accepted a Promise as an object and left a rejected Promise unobserved. Both producer
selection paths now reject thenables as synchronous artifacts while observing their rejection.
Awaited mutation measurement reuses the synchronous mutation planner and observes actual settled
outcomes only for an explicitly opted-in `boundedAsync` first-touch fixture. The kit fixture bounds
its work with its own timeout; synthesized async inputs and legacy streams retain their existing
unmeasured status. A deliberately broken unknown-key implementation is caught by the async probe.
A separate regression observes rejected producer Promises at an actual event-loop turn.

An exploratory unrestricted async measurement also reached legacy `collectAsync`: omission of its
unconstrained generic sentinel is accepted. This is outside the connector work and requires its own
contract interpretation (a generic `Out` can include undefined). No unrelated TA behavior was
changed or declared repaired. Final generation keeps the six pre-existing async-unobserved paths
explicit, measures the new bounded kit fixture, and records **2,574 enforced / 2,702 partial /
0 defective / 187 unmeasured of 5,463 candidates**, with no ratchet increase. The kit is partial
because the global declaration synthesizer cannot build every provider/probe union alternative;
the dedicated kit and mapping suites test those behaviors explicitly.

The runtime inventory now uses the existing public specifier mapping for source imports, allowing
new public subpaths without a new private alias. Only the two new provider-valued config fields
receive the established structural-artifact policy; their outer controls remain closed and owned
identity/version/method fields are validated. Tests prove both the open structural state and closed
configuration. No existing policy row, exception, budget, supported runtime, coverage floor, test
selection, or CI job was loosened. Because enforcement tooling changed, a full hosted run at the exact
PR head is required before landing; a fast PR pass alone is insufficient. No merge is authorized.

## Verification record

Runtime: Node 22.23.2, pnpm 10.32.0 selected explicitly. SDK frozen install passed without changing
the existing dependency graph. The provider has its own new pinned lockfile and frozen install.

Already observed during integration:

- 106 focused SDK checks across eight files passed: data contract/kit, first-touch, clean installed
  SDK consumer, code-catalog values, error-code conformance, manifest and unchanged bundle budgets.
- Independent provider synthetic suite passed 50 checks, including exact daily/minute/EOD mappings,
  the shared fixture/HTTP corpus, typed error matrix/redaction, cursor pins, zero/null, malformed
  source facts, fetch/body cancellation and absence of transport calls before abort.
- TypeScript build/typecheck and scoped source/tool lint passed during integration. Final
  generated naming/contract/enforcement checks passed 73 tests across three files; the unchanged
  unmeasured ratchet passes. Naming has 43,607 identities and zero unresolved entries.

These are bounded automated checks, not a full local CI/coverage run, real staging data or a real
connected-agent replay. Final packed artifacts, final-head focused checks and hosted status are
recorded in the completion section when observed.

## Remaining acceptance

- [x] Final affected generation, targeted generated-contract/public-reference and fresh packed
      SDK/provider checks pass. Commits and draft PR are recorded in the handoff below.
- [ ] Current-head hosted fast and full enforcement-change workflow outcomes.
- [ ] Separately configured credential access and a confirmed new staging request allowance.
- [ ] Actual staging read verification, agent-glue replacement/pinned-input parity, real-agent
      journey and subsequent paper/MCP App acceptance.

The exhausted staging allowance was not reset or reused. No real-data response, private application
implementation, credential access, key/grant mutation, active paper policy/store/journal action,
release version change, publication, remote-repository creation, deployment, recurring automation
or live execution occurred.

## External clean-consumer receipt

The explicit rehearsal installed fresh SDK and standalone provider tarballs outside both source
repositories, then repeated a frozen install. All 50 provider HTTP/mapping/error/cancellation tests
passed against the installed package (zero skipped). The SDK-owned public fixture and external
HTTP provider both passed the same `validateDataProvider` kit and pinned daily/minute/EOD corpus.
An unchanged SMA workflow produced 101.5 for each and the existing market builder refused missing
pricing inputs. NodeNext and Bundler compilation, ESM, SDK QuantError identity and provider-free
ordinary browser compute passed. No aliases or absolute/private source paths entered the provider.

Command: `pnpm exec tsx tools/community-connectors-provider-smoke.ts <sdk.tgz> <provider.tgz>
<provider-test-directory> /tmp/totalfinance-community-external-consumer-receipt.json`.
Inputs under the provider repository's ignored `.sdk/` directory:

- `totalfinance.tgz` SHA-256 `ae5ffcff444cd56cab062753acf65bbf8d653d3f7d582673b12cc95e1ded6cd2`.
- `insiderfinance-totalfinance-connector-insiderfinance-0.0.0.tgz` SHA-256
  `825f93ac4120d5aef4b4c6129992010353a54fbc096c1e78c2e7db2fb5f642a7`.
- Provider implementation commit `92b8737` (full hash recorded with final handoff).

These are local unreleased artifacts, not registry 0.1.2 compatibility or a publication receipt.
The provider lockfile pins the exact SDK file artifact integrity. Real staging deployment,
entitlements and historical coverage were not queried.

## Final local checks

- `pnpm exec vitest run` over 18 focused source, first-touch, clean SDK consumer, unchanged bundle,
  public-reference, docs, signatures, catalog, manifest, package/layer, README/llms and probe files:
  **246 tests / 18 files passed** (`/tmp/tf-final-focused.log`).
- Final contract/naming/async-regression run: **73 tests / 3 files passed**
  (`/tmp/tf-final-conformance.log`). The two async tests overlap the run above: **317 distinct SDK
  tests / 20 files**, not 319 distinct assertions.
- `pnpm typecheck`, `pnpm api:check` (all 25 reports), scoped ESLint, scoped pinned Prettier and
  `git diff --check` pass. Provider frozen install, build, typecheck and 50 Node tests pass.
- Ordered generation ran from final public source through signatures, naming, contracts,
  enforcement, validation, API, README/llms, public reference/TypeDoc, bundle, OpenAPI and docs.
  The final tooling-only bounded-async change reran enforcement; its counts refreshed the required
  human trackers, then README/llms/docs. Public runtime/type inputs, validation, bundle and OpenAPI
  inputs had not changed, so those unchanged generators were not repeated. Final docs inventory:
  **242 surfaces, 4,626 executable fences, zero findings**. All 33 original bundle gates pass.

Main was freshly fetched while preparing this handoff: `origin/main` remains
`d50b401ee237006c75c76ef90784e5dcde1439a3`. Its latest full scheduled run
[41511802199](https://github.com/InsiderFinance/totalfinance/actions/runs/41511802199) and post-merge
full run [41504979418](https://github.com/InsiderFinance/totalfinance/actions/runs/41504979418) both
completed successfully. Those base receipts do not certify the feature head.
