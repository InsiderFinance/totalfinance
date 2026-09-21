# September 2026 review repairs

Status: **COMPLETE — locally verified 2026-09-07**. This is the repair/verification gate for the review of PR #303 at
`dccfce53` (2026-09-06). It does not reopen the completed Phase 3B API-alignment work or add a new
feature stage. The affected Stage 4.6/7B surfaces have the permanent regressions and integrated
correctness evidence below. Publication remains a separate maintainer-held decision.

## Decisions

- Portfolio decisions observe completed data and execute no earlier than the next observation.
  The environment already advances that way; retain exactly one observation of delay there.
  Pre-open entitlements and external flows precede queued fills; close-derived derivative
  settlement follows them. A closing gain cannot finance an earlier opening purchase, and an
  instrument acquired at the open still participates in that observation's closing settlement.
- Entry buying power is a pre-fill gate against the projected ledger account, including costs,
  existing positions and unsettled obligations. Reject over-budget orders explicitly; never
  silently borrow under the cash-account default or silently resize an order.
- Lifecycle events are signed obligations. Long/short dividends, coupons, redemption and FX
  maturity must have opposing economic effects. Coupon schedules/day counts reuse their existing
  owner rather than introduce another approximate financial formula.
- A paper journal must retain everything required to resume outstanding orders. Workflow calls
  transact over the journal so restoration, idempotency, ID allocation and append are serialized.
- An inline grant is a representation, not proof of authority: the runtime must verify that it
  was approved in the trusted authorization store. Pure domain functions remain pure.
- HTTP checks Host, Origin, JSON content type, and a server-owned credential for enabled writes.
  Invalid URLs are structured refusals, never unhandled promise rejections.
- Machine-facing trade schemas describe the actual closed/discriminated domain grammar. Truly
  open provenance stays open. Content hashes cover actual declarative configuration.

## Individually verifiable checklist

- [x] R01 Causal portfolio timing: market, limit/stop and declarative rebalances; no double delay in the environment.
- [x] R02 Buying power: cash/margin, costs, sequential orders, settlement and reduction of existing risk.
- [x] R03 Signed dividends on both data paths; short bond coupon/redemption coverage.
- [x] R04 Signed FX-forward maturity and independently reconciled currency balances.
- [x] R05 Calendar-based bond accrual, coupon boundaries, month ends, leap years and stubs.
- [x] R06 Resumable open/partial paper orders, expiry, cancel and honest open-order reporting across calls.
- [x] R07 Durable fill/event identities across multiple plans, partial fills and restarts.
- [x] R08 Transactional persistence: concurrent append and submit, retries/conflicts, crash recovery; audit other file stores.
- [x] R09 Collision-free journal filenames, original-ID listings and safe legacy-file handling.
- [x] R10 Trusted grant verification rejects rehashed self-issued authority without approval.
- [x] R11 HTTP origin/host/content-type/credential protection and truthful capabilities.
- [x] R12 Malformed HTTP targets return 4xx and the server survives.
- [x] R13 Distinct declarative strategies/configurations have distinct run identities.
- [x] R14 Complete trade input/output schemas and schema-to-domain parity tests.
- [x] Update affected specs, guides, generated evidence and stale implementation handoffs.
- [x] Targeted regressions, build/typecheck/lint/format, packed/transport/full-suite/API/generated-evidence gates.

## Acceptance

Every R-row closes with a permanent regression at its owner. Reconciliation/parity is necessary but
not sufficient: financial tests need independently expected cash/P&L, persistence tests need
separate processes and restarts, and authority tests need an unprivileged caller. Existing
maintainer-held publish and hosted-matrix gates remain separate; these repairs cannot authorize
publication, live execution or a change to the deferred acceleration scope.

## Completion evidence

Owner-level evidence:

- R01/R02: `backtest/test/portfolio-entry-safety.test.ts` (14 regressions) and
  `backtest/test/portfolio-lifecycle-phases.test.ts` (21 regressions), plus the standalone/stepper/
  environment parity journeys. Independent expiry-gain controls prove closing collateral cannot
  fund an earlier opening fill; tests also cover same-day acquisitions, carried option marks,
  signed maturity, funding, rolls, and reinvestment only after sale proceeds settle. Goldens now
  include acquisition-day derivative settlement: the crypto journey additionally pays
  `2 × 30,110 × 0.0001 = 6.022` funding on the day it acquires the perpetual, not just later dates.
- R03–R05: `backtest/test/{signed-lifecycle-economics,bond-calendar-accrual}.test.ts` and
  `portfolio/test/{signed-income,short-redemption,lifecycle-corporate}.test.ts`; independently
  expected signed cash/FX balances, coupon/day-count arithmetic, reversals, and settlement.
- R06/R07: `backtest/test/paper-restart.test.ts` (22 new regressions), including separate-process
  restores, partial-fill observation deduplication, changed-context refusals, expiry/cancel and
  normalized-fill recovery. `workflows/test/trade-recovery.test.ts` adds five regressions proving
  receipt-scoped cumulative recovery after a committed response is lost, exact costs/settlement
  facts, partial fills, other-plan exclusion, and idempotent replay through `record_events`.
  Top-level fills/events remain current-call deltas and submission receipts stay immutable.
- R08/R09 store layer: `workflows/test/store-transactions.test.ts` (42 regressions), including
  400/400 cross-process appends, conflicts/retries, process death, terminated workers, atomic
  replacement failures, both indexes, immutable job IDs and competing terminal transitions.
  Corrupt legacy bodies/identities fail closed without running a write callback; only validated
  foreign-ID collisions are treated as absent for a different requested journal.
  `workflows/test/trade-transactions.test.ts` adds four actual cross-process workflow regressions:
  distinct plans retain distinct fills, identical retries fill once, conflicting retries lose
  without appended facts, and competing observations advance a restored limit order once.
- R10: `workflows/test/trade-pack.test.ts`: edited/rehashed grants refused, matching approved
  inline grants accepted, approve/paper capabilities separate, authoritative journal checks.
- R11/R12: `http/test/{security,bin,docs,server}.test.ts` and `tools/http-doc-conformance.test.ts`;
  hostile origins/hosts/targets, missing/wrong credentials, approval-only writes, job mutations,
  truthful capability disclosure, and executable authenticated examples.
- R13: `backtest/test/cross-sectional.test.ts`: changed directions, weights, cost models,
  same-label policy parameters, periods, risk-free rate and seed change identity; reordered
  observations do not. Dataset/result identity remains the stored artifact's separate `runHash`.
- R14: `workflows/test/trade-pack-schema.test.ts` checks compiler-declared fields and variant
  discriminators against the actual wire grammar. `trade-schema-compaction.test.ts` proves
  lossless expansion of all twelve trade input/output documents, recursive AJV acceptance,
  forbidden variant fields, authority restrictions, deterministic references, and bounded size
  (preflight input below 37 KB; the others below 35 KB). Compaction shares repeated definitions;
  it does not delete domain fields or turn typed inputs into opaque payloads.

Compatibility decisions: stop old-version writers before file-store migration. Legacy journal
files migrate only when their embedded identity matches the exact requested ID; incomplete old
paper-order contexts refuse rather than invent facts. The new file transactions require a coherent
local filesystem on one host; they are not a distributed lock. Custom callable execution models
remain identified by their declared labels/versions, not by unverifiable closure serialization.
Paper idempotency is scoped to one authoritative store and source journal, not an account-wide
consumption ledger across independent simulations. Approval expiry is checked on first submission;
it does not cancel an already accepted GTC order or prevent recovery of its receipt. Capabilities
and matching trusted approval still apply at the workflow boundary; live execution stays deferred.
The cash-account multi-currency demo now has explicit EUR funding; foreign opening balances count
as initial capital, not profit. Leverage and initial-margin caps apply independently.

Bundle growth is recorded at the specific affected subpaths in `tools/bundle-size/budgets.ts`:
the backtest reuses the fixed-income coupon/calendar owner, paper carries durable order context,
and workflows carries real wire schemas. Hot pricing entrypoint budgets/exclusions are unchanged.

## Integrated verification

Verified locally on Node `26.5.0`, from the repair worktree based on `dccfce53`:

- `pnpm test:coverage`: **520 files, 10,843 tests passed**. Statements 93.96%, branches 83.22%,
  functions 96.78%, lines 94.52%; all configured thresholds pass without lowering them.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm api:check`: pass.
  API reports are current across all 25 packages; packed consumers, all 93 transport-parity
  tests, and fresh declaration/contract/schema/documentation checks pass in the full suite.
- Refreshed naming: 39,845 public identities, zero unresolved. Enforcement has zero defective
  boundaries; the new caller-implemented `ExecutionJournalStore#transact` is honestly classified
  as an external callback contract, not claimed measured by picking one implementation. Its
  exact-identity allowance and six declaration-depth residuals are documented in the gates;
  memory/file transactions and persisted derivative terms have separate runtime regressions.
- Generated OpenAPI: 55 paths, 143 component schemas, 628,056 minified bytes. Complete domain
  grammar is retained; repeated structures are shared to keep agent discovery bounded.
- Full regeneration: executed every `REGENERATION_STEPS` entry from `tools/regen-check.ts` in
  order, comparing SHA-256 contents before/after for every tracked or unignored file:
  **all 1,498 files byte-identical**. This uses the same generation chain without the CLI's
  clean-working-tree prerequisite, because these repairs were not yet committed during verification.
- Closeout documentation: 58 targeted documentation/naming tests pass after synchronizing the
  handoffs; the next work is explicitly Stage 5A/5B under the maintainer's release decisions.

Hosted Node-matrix verification, registry publication/smoke, public-repository decisions, and the
standing acceleration/performance deferral remain separate. These local results do not claim a
hosted run, publication, live-broker safety, or unrestricted 10/10 completeness beyond the reviewed
surfaces. Consult `docs/implementation-order.md` for the next authorized work; do not restart
completed Phase 3B or Stage 4/7 slices.
