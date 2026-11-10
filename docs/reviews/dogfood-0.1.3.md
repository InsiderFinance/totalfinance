# Dogfood follow-up and 0.1.3 review record

Status: implementation and focused verification complete; generated contracts are synchronized. Exact-commit release verification receipts are maintained
in the single review PR, which is the release gate of record. This record must not be read as approval
to merge, publish, promote a tag, deploy, or change a paper experiment.

The maintainer selected one compatible review PR and continued 0.1.x releases. The controlling
[scoped spec](../specs/dogfood-0.1.x.md) and [queue](../implementation-order.md) own this batch.
The original [dogfood report](./agent-dogfood-2026-10-28.md), including its later follow-ups supplied
for this review, describes an older feedback checkout. Its LIB findings are already repaired on
main by PR25/8a8c8f8, merged d50b401 on November 2. No private observations, account results or
identities are copied into this PR; every new reproduction/example is synthetic. Supporting paper
files were read only. No staging/provider calls or paper-store changes were made.

## Complete finding disposition

“Docs only” means executable teaching/discovery improvements, with the underlying calculation or
persisted identity unchanged. “Deferred” is a scope/design decision, not a claim of resolution.

| Finding | Disposition        | Result, reason and verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DX-01   | Implemented        | `portfolio.create` delegates explicit identity/currency/events to the existing ledger/store. `portfolio-bootstrap.test.ts` covers unfunded creation, explicit event writes, idempotency and reopened file stores; transport parity includes creation. No new catalog/persistence system.                                                                                                                                                                                                                                                                                                |
| DX-02   | Implemented        | `portfolio.inspect` opens inline/handled ledgers and returns bounded section previews with counts/continuation. Same bootstrap/parity tests; guide names this path instead of resources/read.                                                                                                                                                                                                                                                                                                                                                                                           |
| DX-03   | Implemented        | `ohlcvFromBars` validates consumed source fields and OHLCV semantics, preserving original observations. Projection tests independently assert VWAP 68/6, source immutability, absent volume and invalid last rows. Repair/discovery tests verify a corrected 200-row call.                                                                                                                                                                                                                                                                                                              |
| DX-04   | Implemented        | Thin vectorized wire delegation for lag, sampling, slippage, annualization, risk-free rate and leverage; old calls remain supported. Recovery/discovery tests compare the SDK result and independently expected trade date/value.                                                                                                                                                                                                                                                                                                                                                       |
| DX-05   | Docs only          | The executable guide puts researchProtocol, untouched holdout evaluation and all-attempt accounting beside backtesting. A no-trade rule counts as a trial; undefined Sharpe is not fabricated. A separately declared synthetic null-model variance uses the existing count-based path. No new wire verdict operation.                                                                                                                                                                                                                                                                   |
| DX-06   | Deferred           | Intraday P&L needs an instant-mark contract in the shared P&L engine. Date-only marks and financial/time semantics are preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DX-07   | Implemented        | `currentOrders` comes from the existing authoritative journal fold, scoped to receipt orders. Recovery tests prove partial/completed/cancelled states after reopen, immutable receipts, cumulative recovery and isolation from other plans.                                                                                                                                                                                                                                                                                                                                             |
| DX-08   | Docs only          | Prominent omit-and-reuse guidance; recovery test verifies omission and exact receipt identity, then refuses reintroduced terms and preserves subsequent recovery. No persisted-term normalization or migration.                                                                                                                                                                                                                                                                                                                                                                         |
| DX-09   | Implemented        | Domain and wire validators accept binding zero cost/slippage ceilings. Trade/recovery-discovery tests show zero-cost success, positive-estimate denial, strict policy merging, and invalid values; zero-ceiling preflight joins the complete transport matrix.                                                                                                                                                                                                                                                                                                                          |
| DX-10   | Implemented        | Registered `portfolio.market_mark_age`, identical-warning deduplication, exact observed/valuation clocks and age, and fresh-observation teaching. Direct string-array grammar remains compatible. Recovery/discovery test preserves source time and checks the one stable warning.                                                                                                                                                                                                                                                                                                      |
| DX-11   | Implemented        | Recursive finite JSON Schema mirrors the existing SDK predicate grammar, with exact operator names and executable guidance. Tests compile it with the MCP validator, refuse `gt`, accept nested filters, and run the corrected screen.                                                                                                                                                                                                                                                                                                                                                  |
| DX-12   | Docs only          | Discovery explicitly distinguishes category browsing from name/alias search, with a momentum example and a test that category browsing returns more rows. Existing search meaning/order is preserved.                                                                                                                                                                                                                                                                                                                                                                                   |
| DX-13   | Implemented        | Calendar metadata exposes the documented 2001 floor, data version and rule-projection limits; earlier operation ranges warn. No invented certified endpoint (`verifiedThrough: null`). Tests preserve historical session answers, a known closure and crypto behavior.                                                                                                                                                                                                                                                                                                                  |
| DX-14   | Deferred           | Availability-aware composition needs interval/arrival/revision contracts. The guide distinguishes lag/completion from actual availability; no relabelled timestamps or permissive validation.                                                                                                                                                                                                                                                                                                                                                                                           |
| DX-15   | Docs only          | Task-first SDK execution-policy handoff; proposal/preflight estimates are distinguished from actual fill/cost events. Executable lifecycle test asserts estimated cost 15 while simplified paper execution charges zero and leaves cash 80,000 from synthetic facts. No new paper wire cost-policy loophole.                                                                                                                                                                                                                                                                            |
| DX-16   | Docs only          | Executable five-session monthly/lag example: lag 1 first trades February 2, lag 2 March 2, retaining the engine's sampling/fill law. Packed guide and SDK/wire parity test verify it.                                                                                                                                                                                                                                                                                                                                                                                                   |
| DX-17   | External           | Coverage/unavailability/query-size behavior belongs to the provider/API owner. No staging budgets spent; historical observations do not establish a deterministic limit.                                                                                                                                                                                                                                                                                                                                                                                                                |
| DX-18   | External           | The original internal error's cause remains unknown and an identical retry recovered. Provider dependency/terminal-payoff resolution belongs to that owner. No speculative library fix or fresh remote claim.                                                                                                                                                                                                                                                                                                                                                                           |
| DX-19   | Implemented        | Additive direct income/balance ratio inputs use existing canonical field/period validators and formulas, requiring only the lines the formula consumes. The new reproduction failed 5/6 tests before repair; all six and 22 existing ratio/score tests pass afterward. Complete inputs still validate fully; cross-statement paths remain strict. Scale, period/availability, nulls, ambiguity, invalid values and unsupported YTD are covered. Minimum-line fixtures, existing interface extension and derived-debt overflow are also regression-tested (53 total fundamentals tests). |
| DX-20   | Deferred           | Cumulative interim/YTD periods and compatible quarter derivation need separate financial/time design. The unsupported vocabulary still refuses rather than mislabelling or fabricating flows.                                                                                                                                                                                                                                                                                                                                                                                           |
| LIB-01  | Already fixed      | Preserve main's supplied held-instrument classification repair and authoritative economic terms. Existing trade regression plus the release-wide suite retest it.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| LIB-02  | Already fixed      | Preserve actual newly applied event counts and economic deduplication. Existing trade-pack retry/mixed-batch regressions remain in the affected suite.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| LIB-03  | Already fixed      | Preserve plan-scoped joins and source-wide orphan detection. Existing trade-lifecycle regression remains in the release-wide suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API-01  | External, repaired | The supplied November dogfood evidence records corrected cursor instructions and successful continuation. No new conflicting-symbol/pagination regression is claimed here.                                                                                                                                                                                                                                                                                                                                                                                                              |
| API-02  | External           | Historical coverage intervals and gap disclosure belong to the data owner. Row validity is not continuity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| API-03  | External           | Historical model-rate availability and valuation-time pins belong to the provider. No point-in-time certification is inferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| API-04  | External           | Snapshot freshness/contract eligibility/identity disclosure belongs to the provider. Research data is not promoted to executable quotes.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| API-05  | External           | Classified-side premium methodology/discovery belongs to the API owner. No arithmetic correction is asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Version and release policy

A read-only npm registry recheck on November 10 returned SDK versions 0.1.0/0.1.1/0.1.2 and
`latest: 0.1.2`, whose timestamp is 2026-10-05T23:08:00.466Z. The optional MCP name returned 404;
that does not establish ownership or publishing rights. Version 0.1.3 is unused. Both prepared
artifacts and private/runtime metadata now name 0.1.3; publication:update and the documented
lockfile refresh followed Changesets versioning.

The existing release tool's patch-override transformation was applied to pending intents before
Changesets versioning. All queued prose survives in the generated changelogs. Reference-price
helpers and reported holding partitions are explicitly described as additive capabilities, not
bug fixes; the override follows maintainer policy for pre-1.0 compatible releases. No #26
changeset was imported. The release shell's main-push/publication path was not run.

## Verification record

Canonical local toolchain: Node 22.23.2 (`.nvmrc`), pnpm 10.32.0, frozen installation. All checks
record their direct exit codes; no piped test command supplies a false success.

| Check                                                                       | Observed result                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| New ratio reproduction before repair                                        | Exit 1: 5 failed, 1 passed, as expected                                                                                                         |
| Ratio reproduction + existing ratios/scores after repair                    | Exit 0: 28 tests                                                                                                                                |
| Five new/extended focused suites                                            | Exit 0: 26 tests                                                                                                                                |
| Broad affected financial/workflow/calendar/schema run + budgets, first pass | Exit 1: 219 non-budget tests pass; six measured budget crossings, subsequently corrected from measurements                                      |
| Budget + lifecycle cost example + recovery/discovery follow-up              | Exit 0: 42 tests, including all 33 bundle-budget checks                                                                                         |
| Complete registry/CLI/HTTP/MCP parity matrix                                | Exit 0: 97 tests (48 operations plus fixture-set check); later zero-ceiling fixture is included in final verification                           |
| Exact public guide from installed tarballs, strict NodeNext and Bundler     | Exit 0: one selected packed-consumer test; 226 deliberately unselected tests are not claimed here                                               |
| Initial guide checks                                                        | Refused missing Node assertion types, then caught two remaining assertion calls; corrected to ordinary JavaScript checks and reran successfully |
| TypeScript source checks                                                    | Exit 0 before final generator review; final release check still required                                                                        |
| Naming generation                                                           | 43,342 identities, 0 unresolved after rebuilding the prose-metadata type; generated artifacts were not edited by hand                           |
| Full local release repeat and exact final-head hosted matrix                | Pending; final receipts belong to the PR description and must name its exact candidate SHA                                                      |

The workflow bundle measured 518,270 B gzip and now has a 506.5 KiB limit; other crossed lines
were math 41,478 B, performance/sharpe 9,261 B, environment 145,681 B, portfolio 113,232 B and
umbrella 713,624 B. Only those six bounds moved, with exact measurements and reasons in
`tools/bundle-size/budgets.ts`. Structural exclusions remain unchanged. Generated signatures and
contracts expand the actual new union branches; they are generator outputs, not hand-written
review evidence.

## Draft #26 isolation

Before implementation, #26 was open/draft at e5e9e95433d798bbaa9378386f2f391568ce7fba. Its
provider/data exports, external provider package and four connector-only blockers were not
implemented or imported. The final PR records its unchanged head/draft status, exact intersecting
files, a textual merge-tree conflict check and semantic owner retests. Generated inventories,
version/distribution metadata and shared diagnostic registries may overlap textually even when
financial/provider semantics are separate. No rebase, branch update or merge of #26 is authorized.

The final contract record measures 5,463 candidates: 2,573 enforced, 2,704 partial, zero defective,
and 186 explicitly unmeasured. The unimplemented generic `RatioFacade#explain` interface no longer
pretends its generic object is the complete optional ratio bag; each concrete callable retains its
exact input and independent measurement. The three added OHLCV paths are measured. This is not a
loss of an executed concrete boundary test. The status-figure helper was repaired to emit zero for
an absent rejection bucket (the artifact's documented zero convention), and its current numeric
prose/table were refreshed from the actual generated records. No enforcement threshold was lowered.

## Concrete #26 overlap and owner retests

At source commit 56056dd8906849711e73ed8530df19c0ef05b1b5 against unchanged draft
#26 e5e9e95433d798bbaa9378386f2f391568ce7fba, the intersection is **24 files**.
A read-only `git merge-tree --write-tree` rehearsal exits **1** with **17 textual conflicts**;
no branch or worktree is merged or changed by that object-only rehearsal.

| Shared file                                          | Textual merge assessment     |
| ---------------------------------------------------- | ---------------------------- |
| `README.md`                                          | Conflict                     |
| `distribution/totalfinance/package.json`             | Auto-merges in the rehearsal |
| `docs/bundle-size.md`                                | Conflict                     |
| `docs/implementation-order.md`                       | Conflict                     |
| `docs/library-alignment-spec.md`                     | Conflict                     |
| `docs/llms-full.txt`                                 | Conflict                     |
| `docs/llms.txt`                                      | Conflict                     |
| `docs/reference/fields.md`                           | Conflict                     |
| `docs/specs/phase-3b-public-naming-normalization.md` | Conflict                     |
| `docs/specs/phase-3b-runtime-semantic-closeout.md`   | Conflict                     |
| `packages/core/README.md`                            | Auto-merges in the rehearsal |
| `packages/core/etc/core.api.md`                      | Conflict                     |
| `packages/core/package.json`                         | Auto-merges in the rehearsal |
| `packages/core/src/diagnostics.ts`                   | Conflict                     |
| `packages/totalfinance/README.md`                    | Auto-merges in the rehearsal |
| `packages/totalfinance/package.json`                 | Auto-merges in the rehearsal |
| `tools/bundle-size/budgets.ts`                       | Conflict                     |
| `tools/manifest/conformance.test.ts`                 | Auto-merges in the rehearsal |
| `tools/manifest/fixture-validation.test.ts`          | Conflict                     |
| `tools/manifest/public-contracts.json`               | Conflict                     |
| `tools/manifest/public-docs.json`                    | Conflict                     |
| `tools/manifest/public-enforcement.json`             | Conflict                     |
| `tools/manifest/public-naming.json`                  | Conflict                     |
| `tools/manifest/public-signatures.json`              | Auto-merges in the rehearsal |

The conflicts are rebase/integration work, not evidence that connector semantics were changed.
The shared source contract change is two additive warning codes in core diagnostics. Core Bar,
provider response/ordering, adjustment, window/pagination and connector mapping contracts are
unchanged by this PR. The new OHLCV projection is additive in technical-analysis and does not
replace #26's windows/close arrays. Bounded schema-error summaries live at the operation transport
edge; they do not repair #26's provider wrapper that discards mapping context. Existing complete
ratio calls and all broker/ledger conventions remain supported.

The owner should rebase #26 only when ready, keep its own unmerged changeset, retain the new
0.1.3 base metadata and its exact MCP dependency, and resolve source/curation changes before
regenerating inventories/docs/API reports. Do not choose one side of generated JSON or raise a
fixture count without deriving the combined value. Remeasure the combined bundle surface; these
limits do not certify new data infrastructure. No external provider package was modified here.

Concrete synthetic retests after that owner-managed integration:

1. Rebuild/pack on Node 22.23.2 with pnpm 10.32.0 and a frozen install. Install both prepared
   artifacts outside the monorepo; compile strict NodeNext/Bundler and execute existing 0.1.x calls.
2. Repeat #26's independently packaged provider/restore/pagination examples and the SMA(20)
   synthetic 100…129 close fixture (expected 119.5). Verify incomplete OHLCV, warmup and actual
   observation/availability/provenance remain explicit; do not relabel data to pass.
3. Keep #26's four review blockers as its own acceptance work: contradictory adjustment metadata,
   distinct-root option ordering within/across pages, safe mapping field/reason diagnostics, and
   no-key author onboarding. This patch claims none resolved.
4. Run the combined generated-contract gates, `tools/transport-parity.test.ts`, the trade recovery
   tests, bundle budgets and full packed consumers. Preserve both the new create/inspect tool
   bindings and #26's data exports/curation. Then run a new exact-head full hosted matrix and
   release verification under that future PR's own authorization.

[PR #27](https://github.com/InsiderFinance/totalfinance/pull/27) is the single review/release
receipt for this batch. Its verification section names the exact candidate SHA, full hosted run,
independent local repeat, artifact hashes and check outcomes. The source commit above identifies
the implementation used for this overlap assessment; subsequent documentation-only commits do not
change the overlap. #26 was rechecked open/draft at the same SHA after implementation; neither
its branch nor status has been changed by this work.
