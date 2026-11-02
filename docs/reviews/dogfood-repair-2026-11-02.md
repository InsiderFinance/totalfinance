# Dogfood repair verification — 2026-11-02

This is the bounded LIB-01 → LIB-03 → LIB-02 repair batch authorized by the maintainer.
The [original public feedback](./agent-dogfood-2026-10-28.md) is retained with its historical
observations and November 2 updates. API-01 remains owned by the separate InsiderFinance API task.
Broader DX/data suggestions and the connected-connector/MCP-App milestone remain open.

## Baseline and reproductions

Worktree: `/Users/agent/ri/.work/worktrees/totalfinance/totalfinance-3b8f6e`.
Branch: `totalfinance/repair-confirmed-total-finance-dogfood-bugs`.
Fetched `origin/main`: `b678363441c80a0c84be58791ec3df2bd03cf1c0` (unchanged at fetch).
No finding was already repaired upstream. Node **22.23.2** from `.nvmrc`, pnpm **10.32.0**
from `package.json`; `pnpm install --frozen-lockfile` and `pnpm build` exited 0.
Install reported existing cyclic workspace dependencies and missing pre-build distribution bins;
the subsequent build assembled the distribution successfully. No dependency metadata changed.

Before calculation source changed:

- `pnpm exec vitest run packages/portfolio/test/trade.test.ts packages/portfolio/test/trade-lifecycle.test.ts packages/workflows/test/trade-pack.test.ts`
  exited 1: **5 failed, 41 passed**. Failures were the supplied ETF/disallowed classification,
  classification with conflicting caller economic terms, plan scoping, and duplicate batch counts.
- After building the unchanged base,
  `pnpm exec vitest run tools/packed-consumer.test.ts -t 'dogfood repair:'`
  exited 1: **all three selected tests failed** against freshly packed and installed public
  packages. LIB-01 returned `null` instead of `etf`; LIB-03 falsely listed the other plan's entry
  fill in `ledgerNotJournaled`; LIB-02 returned `applied: 1` instead of zero on identical replay.
  The permanent synthetic fixture is `tools/fixtures/dogfood-trade-repairs.mjs`.

All facts are synthetic. No API credentials, licensed responses or private artifacts were read or
copied. The existing untracked `.env` was left untouched. The source feedback checkout, shared
main checkout, linked application repositories, and active paper ledger/journal/artifact stores
were not modified.

## Resulting behavior

- **LIB-01:** the held-position resolver takes classification from the validated caller instrument
  description. Currency and multiplier still come from the ledger; the existing preflight path
  retains held contract terms. `instrumentSources` discloses the mixed source. Missing
  classification remains unverifiable, and a disallowed supplied class fails. There is no inferred
  ETF identity or weakened policy.
- **LIB-03:** when `planHash` is present, fills attributed by the complete journal to other plans
  are excluded from both ledger and delivered-fill joins. Report fill counts describe the judged
  fills. Warnings and `matchConvention` disclose the scope. Unattributed source fills remain
  discrepancies even in a scoped check; source-wide reconciliation still detects every orphan.
  Selected-plan missing fills and quantity mismatches still fail. External snapshots continue to
  judge the whole portfolio, independently of the plan filter.
- **LIB-02:** `applied` and the summary use the reducer's event-count delta. Identical replay reports
  zero; mixed old/new events and within-batch duplicates count only newly folded events. The
  existing output shape, ledger content identity, economic deduplication and changed-body conflict
  refusal are preserved.

## Verification receipts

All commands below use the pinned Node/pnpm runtime. These are local targeted checks, not full CI.

- **207 tests / 13 files**, exit 0:
  `pnpm exec vitest run packages/portfolio/test/trade.test.ts packages/portfolio/test/trade-lifecycle.test.ts packages/portfolio/test/trade-combos.test.ts packages/portfolio/test/ledger.test.ts packages/portfolio/test/apply.test.ts packages/portfolio/test/fills.test.ts packages/workflows/test/trade-pack.test.ts packages/workflows/test/trade-recovery.test.ts packages/workflows/test/trade-transactions.test.ts packages/workflows/test/trade-pack-schema.test.ts packages/workflows/test/trade-schema-compaction.test.ts packages/backtest/test/paper-broker.test.ts tools/bundle-size/budgets.test.ts`.
  Includes multiprocess economic idempotency, recovery, public schema projection and unchanged bundle budgets.
- After adding external-snapshot and output-schema assertions, **27 tests / 2 files**, exit 0:
  `pnpm exec vitest run packages/workflows/test/trade-pack.test.ts packages/portfolio/test/trade-lifecycle.test.ts --reporter=dot`.
- **16 selected tests / 2 files**, exit 0:
  `pnpm exec vitest run tools/packed-consumer.test.ts tools/transport-parity.test.ts -t 'dogfood repair:|Stage 7B.2:|trade\.|portfolio.record_events' --reporter=dot`.
  Includes the three installed public SDK regressions, the packed SDK/CLI trade lifecycle and the
  selected trade/record-events transport parity cases. The remaining 303 cases were not selected.
- **5 relevant first-touch deep-sweep tests**, exit 0:
  `pnpm exec vitest run tools/first-touch/deep-sweep.test.ts tools/first-touch/unknown-keys.test.ts -t 'portfolio\.(normalizeTradePlan|preflightTradePlan|reconcileExecution)|workflows\.(tradePack|createOperationRegistry)' --reporter=dot`.
  The unknown-key file had no matching selected cases and was skipped; no whole-file unknown-key
  result is claimed.
- **66 generated-contract tests / 2 files**, exit 0:
  `pnpm exec vitest run tools/manifest/contract-conformance.test.ts tools/manifest/contract-probe.test.ts -t '^(?!.*generation is deterministic)' --reporter=dot`.
  Includes fresh-inventory drift. The separate second-generation determinism case was skipped
  under the ordinary fast-PR policy; hosted CI retains its own gates.
- `pnpm typecheck`, `pnpm build` and ESLint on the changed TypeScript/JavaScript files exited 0.
  The new `.mjs` fixture initially failed lint for implicit Node globals; explicit imports fixed it.

The documented regeneration sequence completed on final calculation source:
`signature:update → naming:update → contract:update → enforcement:update → validation:update →
api:update → readme-gen → llms-docs → public-reference --typedoc → bundle:update → openapi:update →
docs:update`. Each step exited 0. An earlier enforcement attempt was deliberately interrupted
(exit 130) to correct the external-snapshot wording before final generation; it is not counted as
successful evidence. Only the affected remaining chain was resumed. Enforcement reports
**5,461 candidates, 2,573 enforced, 2,701 partial, 187 unmeasured, 0 defective**.
Signature, naming, contract, enforcement, validation and API artifacts regenerate without a diff.
OpenAPI operation descriptions, generated LLM docs, the bundle report and docs inventory changed.
All 33 bundle budgets remain unchanged (trade 77.3 / 77.5 KB, workflows 502.7 / 502.75 KB).
The final documentation inventory is regenerated after adding this record: **238 surfaces,
4,600 executable fences, 0 findings**.

Final documentation/budget checks passed **56 tests / 2 files**:
`pnpm exec vitest run tools/docs-conformance.test.ts tools/bundle-size/budgets.test.ts --reporter=dot`.
The preceding documentation check caught the newly created repair record missing from the inventory;
`docs:update` regenerated that entry before this passing run. The public-reference suite separately
passed its **24 tests** during that preceding run. Standalone `pnpm api:check` reported all **25**
package API reports current. Prettier on changed supported files, changed-file ESLint and
`git diff --check` passed. A first explicit Prettier invocation included generated `docs/llms-full.txt`,
which has no inferred parser; the corrected supported-file check passed. The text artifact remains
in its generator's exact form.

## Remaining acceptance

Current-head hosted PR checks and maintainer review remain landing gates. No local full CI,
coverage repeat or clean-tree `regen:check` is claimed. No merge, release version bump,
publication, deployment, live execution, recurring automation or paper-store mutation occurred.
The real connected agent still needs a separate rerun against the repaired build, using its own
unchanged paper store and authority; synthetic/transport tests do not close that milestone.
