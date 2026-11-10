# Dogfood follow-up and 0.1.3 review record

Status: the initial batch is implemented. Authorized review follow-up F1–F6 is active; its generated contracts and exact-head release receipts must be refreshed. Exact-commit release verification receipts are maintained
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

| Finding | Disposition            | Result, reason and verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DX-01   | Implemented            | `portfolio.create` delegates explicit identity/currency/events to the existing ledger/store. `portfolio-bootstrap.test.ts` covers unfunded creation, explicit event writes, idempotency and reopened file stores; transport parity includes creation. No new catalog/persistence system.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DX-02   | Implemented            | `portfolio.inspect` opens inline/handled ledgers and returns bounded section previews with counts/continuation. Same bootstrap/parity tests; guide names this path instead of resources/read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DX-03   | Implemented            | `ohlcvFromBars` validates consumed source fields and OHLCV semantics, preserving original observations. Projection tests independently assert VWAP 68/6, source immutability, absent volume and invalid last rows. Review follow-up completes raw canonical bars in the existing tool: no preprocessing, single-symbol/increasing-time validation, closed metadata keys and source immutability, with full transport parity.                                                                                                                                                                                                                                                                                                                                                                         |
| DX-04   | Implemented            | Thin vectorized wire delegation for lag, sampling, slippage, annualization, risk-free rate and leverage; old calls remain supported. Recovery/discovery tests compare the SDK result and independently expected trade date/value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DX-05   | Docs only              | The executable guide puts researchProtocol, untouched holdout evaluation and all-attempt accounting beside backtesting. A no-trade rule counts as a trial; undefined Sharpe is not fabricated. A separately declared synthetic null-model variance uses the existing count-based path. No new wire verdict operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DX-06   | Deferred               | Intraday P&L needs an instant-mark contract in the shared P&L engine. Date-only marks and financial/time semantics are preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DX-07   | Implemented            | `currentOrders` comes from the existing authoritative journal fold, scoped to receipt orders. Recovery tests prove partial/completed/cancelled states after reopen, immutable receipts, cumulative recovery and isolation from other plans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DX-08   | Docs only              | Prominent omit-and-reuse guidance; recovery test verifies omission and exact receipt identity, then refuses reintroduced terms and preserves subsequent recovery. No persisted-term normalization or migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| DX-09   | Implemented            | Domain and wire validators accept binding zero cost/slippage ceilings. Trade/recovery-discovery tests show zero-cost success, positive-estimate denial, strict policy merging, and invalid values; zero-ceiling preflight joins the complete transport matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DX-10   | Implemented            | Registered `portfolio.market_mark_age`, identical-warning deduplication, exact observed/valuation clocks and age, and fresh-observation teaching. Direct string-array grammar remains compatible. Recovery/discovery test preserves source time and checks the one stable warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| DX-11   | Implemented            | Recursive finite JSON Schema mirrors the existing SDK predicate grammar, with exact operator names and executable guidance. Tests compile it with the MCP validator, refuse `gt`, accept nested filters, and run the corrected screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DX-12   | Docs only              | Discovery explicitly distinguishes category browsing from name/alias search, with a momentum example and a test that category browsing returns more rows. Existing search meaning/order is preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DX-13   | Implemented            | Calendar metadata exposes the documented 2001 floor, data version and rule-projection limits; earlier operation ranges warn. No invented certified endpoint (`verifiedThrough: null`). Tests preserve historical session answers, a known closure and crypto behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DX-14   | Deferred               | Availability-aware composition needs interval/arrival/revision contracts. The guide distinguishes lag/completion from actual availability; no relabelled timestamps or permissive validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DX-15   | Docs only              | Task-first SDK execution-policy handoff; proposal/preflight estimates are distinguished from actual fill/cost events. Executable lifecycle test asserts estimated cost 15 while simplified paper execution charges zero and leaves cash 80,000 from synthetic facts. No new paper wire cost-policy loophole.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DX-16   | Docs only              | Executable five-session monthly/lag example: lag 1 first trades February 2, lag 2 March 2, retaining the engine's sampling/fill law. Packed guide and SDK/wire parity test verify it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DX-17   | External               | Coverage/unavailability/query-size behavior belongs to the provider/API owner. No staging budgets spent; historical observations do not establish a deterministic limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DX-18   | External               | The original internal error's cause remains unknown and an identical retry recovered. Provider dependency/terminal-payoff resolution belongs to that owner. No speculative library fix or fresh remote claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DX-19   | Implemented / deferred | Twelve selected direct income/balance heads use existing canonical field/period validators and formulas. Other market-multiple, paired/average-balance and remaining statement-minimization paths remain separately queued; DX-19 as a broader request is not fully resolved. The new reproduction failed 5/6 tests before repair; all six and 22 existing ratio/score tests pass afterward. Complete inputs still validate fully; cross-statement paths remain strict. Scale, period/availability, nulls, ambiguity, invalid values and unsupported YTD are covered. Minimum-line fixtures, existing interface extension and derived-debt overflow are also regression-tested (initial candidate: 53 fundamentals tests; the review follow-up adds staggered availability and executable recovery). |
| DX-20   | Deferred               | Cumulative interim/YTD periods and compatible quarter derivation need separate financial/time design. The unsupported vocabulary still refuses rather than mislabelling or fabricating flows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| LIB-01  | Already fixed          | Preserve main's supplied held-instrument classification repair and authoritative economic terms. Existing trade regression plus the release-wide suite retest it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| LIB-02  | Already fixed          | Preserve actual newly applied event counts and economic deduplication. Existing trade-pack retry/mixed-batch regressions remain in the affected suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| LIB-03  | Already fixed          | Preserve plan-scoped joins and source-wide orphan detection. Existing trade-lifecycle regression remains in the release-wide suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| API-01  | External, repaired     | The supplied November dogfood evidence records corrected cursor instructions and successful continuation. No new conflicting-symbol/pagination regression is claimed here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| API-02  | External               | Historical coverage intervals and gap disclosure belong to the data owner. Row validity is not continuity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| API-03  | External               | Historical model-rate availability and valuation-time pins belong to the provider. No point-in-time certification is inferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| API-04  | External               | Snapshot freshness/contract eligibility/identity disclosure belongs to the provider. Research data is not promoted to executable quotes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| API-05  | External               | Classified-side premium methodology/discovery belongs to the API owner. No arithmetic correction is asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

## Initial implementation verification record (historical)

These incremental receipts precede the review follow-up. Candidate 96a786c subsequently passed
[full hosted verification](https://github.com/InsiderFinance/totalfinance/actions/runs/42900201240)
and the independent repeat, but review exposed missing cases. That historical result does not
approve a later candidate; PR #27 owns the new exact-head receipt.

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
| Full local release repeat and exact final-head hosted matrix                | Historical 96a786c receipt passed; follow-up requires new exact-head receipts on the PR                                                         |

The initial workflow bundle measured 518,270 B gzip and received a 506.5 KiB limit; other crossed lines
were math 41,478 B, performance/sharpe 9,261 B, environment 145,681 B, portfolio 113,232 B and
umbrella 713,624 B. Those six whole-entrypoint bounds moved, with exact measurements and reasons in
`tools/bundle-size/budgets.ts`. The full installed-consumer matrix additionally measured the coarse
esbuild root TA namespace at 105,586 B gzip against 105,472 B; its initial allowance moved from 103 to
103.25 KiB in `consumer-fixtures.ts`. Leaf RSI remains under 9 KiB, and every unrelated-domain
exclusion is retained. Structural exclusions remain unchanged. Generated signatures and
contracts expand the actual new union branches; they are generator outputs, not hand-written
review evidence.

## Draft #26 isolation

Before implementation, #26 was open/draft at e5e9e95433d798bbaa9378386f2f391568ce7fba. Its
provider/data exports, external provider package and four connector-only blockers were not
implemented or imported. The final PR records its unchanged head/draft status, exact intersecting
files, a textual merge-tree conflict check and semantic owner retests. Generated inventories,
version/distribution metadata and shared diagnostic registries may overlap textually even when
financial/provider semantics are separate. No rebase, branch update or merge of #26 is authorized.

The initial batch contract record measured 5,463 candidates: 2,573 enforced, 2,704 partial, zero defective,
and 186 explicitly unmeasured. The unimplemented generic `RatioFacade#explain` interface no longer
pretends its generic object is the complete optional ratio bag; each concrete callable retains its
exact input and independent measurement. The three added OHLCV paths are measured. This is not a
loss of an executed concrete boundary test. The status-figure helper was repaired to emit zero for
an absent rejection bucket (the artifact's documented zero convention), and its current numeric
prose/table were refreshed from the actual generated records. No enforcement threshold was lowered.

## Concrete #26 overlap and owner retests

The initial source assessment at 56056dd8906849711e73ed8530df19c0ef05b1b5 against unchanged draft
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
the initial implementation used for this overlap assessment. The final PR receipt repeats the
assessment after integration repairs and records its exact candidate SHA. #26 was rechecked open/draft at the same SHA after implementation; neither
its branch nor status has been changed by this work.

## Full-gate integration repair

The first exact-candidate full hosted run at `50c3575f4bb96d0e55ba7e395cdf6d374fed0e2d`
([run 42897358253](https://github.com/InsiderFinance/totalfinance/actions/runs/42897358253))
and the independent clean-checkout `pnpm run ci` both failed. The local suite reported eight failed
and 13,639 passed tests; it stopped before standalone `api:check` and the second coverage run.
Clean regeneration, all hosted static jobs and local-registry rehearsal passed, but do not turn
that failed candidate into a release receipt.

The integration repair updates the explicit HTTP/journey operation inventories, the MCP package
label in live documentation, and the measured coarse TA consumer bound above. The OHLCV missing-field
example now names its exact public boundary unambiguously to the AST inventory. Independent
contract verification now preserves the concrete generic input type: compound aliases join on both
declaration and instantiation, ignoring only identifier-literal union order, and the union checker
resolves a public generic method only when its declaration identity matches. Its cache keys on the
concrete checker parameter symbol. New defect plants prove missing income/balance ratio arms still
fail and a false implementation identity is still rejected. No residual allowlist or threshold was
relaxed to hide a contract gap. The repaired six-suite run passed 118 tests, including the additional identity plant. The final exact-head hosted matrix and clean independent
release repeat must be rerun; their authoritative results remain on PR #27.

## Maintainer-authorized review follow-up

Review at 96a786c found real gaps despite its green release gates. F1–F6 in the controlling spec
own the repairs: set-maximum availability (including separate prior periods), repair hints for
strict full calls, executable head-specific examples, canonical partial type parity, raw canonical
TA bars in the existing operation and honest cross-pack discovery. No further version bump is
needed: this corrects the same unreleased 0.1.3 feature batch already described by its release notes.
The earlier exact-head receipts remain historical; the final new-head receipt belongs to PR #27.

Before/after evidence so far: the new ratio reproduction failed all 14 initial cases before repair;
afterward the 59-test focused run passed. That run also covers the source projection and wire
repair cases; a later extra full-validator example regression brings the new ratio suite to 15.
The pre-repair bar/discovery run had four failures and ten passes. A selected installed-guide run
passed its assertions but exited with an unhandled Vitest `onTaskUpdate` timeout while another heavy
suite ran. It is not counted as green evidence and must pass again without that concurrency; no
RPC timeout or gate is relaxed. Full new-head release checks remain pending.

The warning findings are acknowledged as bounded limitations: cross-instant marks still warn at
any nonzero age, including future observations disclosed by their actual signed age; no freshness
tolerance is inferred. Legacy SDK warning strings remain compatible; broader typed-warning emission
needs separate result-contract work. The existing stable age code/deduplication remains in scope.
A portfolio-name filesystem catalog remains explicitly excluded: persist the returned handle and
enable the documented portfolio read pack, without introducing a second identity/persistence store.

Follow-up integration: all 138 transport/portfolio/whole-entrypoint budget tests pass. Raw canonical
bars and legacy rows have equal financial results across registry, CLI, HTTP and MCP; reversed/
duplicate times, mixed symbols, incomplete metadata and unknown fields have matching typed
refusals. The extra trade-only discovery fixture initially omitted the runtime request clock and
was corrected to supply it explicitly; the production clock requirement is unchanged. Measured
whole-workflow 519,313 B and umbrella 714,320 B require 507.5 and 697.75 KiB ceilings respectively.
The installed esbuild coarse TA namespace is 105,817 B (Rollup 8,688 B): 103.25 → 103.5 KiB leaves
167 B headroom, reflecting 231 B of source-series validation. No leaf import limit or structural
exclusion changes. Canonical typecheck passes. Regeneration and final installed/release receipts
remain pending until the exact-head gate is recorded on the PR.

The selected installed-consumer rerun passed cleanly (exit 0): 13 tests, 214 intentionally
unselected tests. It includes the exact guide, inline canonical extra statement lines and compile
refusals in strict NodeNext/Bundler, plus both bundlers' root-namespace checks. All 145 financial/
compound-contract/example-inventory tests pass, including the 68 fundamentals tests.

Initial regeneration correctly reported two formerly synthesized umbrella projection baselines as
rejected: their invented equal timestamps no longer satisfy the source-series contract. The
technical-analysis fixture was already chronological. Explicit fresh chronological fixtures now
cover both umbrella spellings, with a four-test alias fixture regression; fixture/contract joining
moves 1,334 → 1,336 from those actual added bindings. All seven fixture tests pass. No baseline
refusal is relabelled as success and no coverage/gate is removed: enforcement and its affected
downstream generators are rerun after this fixture integration; unchanged signature/naming/contract
inputs are reused from the completed preceding stages.

Final regeneration restores all original boundary classifications: 5,463 candidates, 2,573
enforced, 2,704 partial, zero defective and 186 explicitly unmeasured. Both umbrella source
projection spellings use valid hand fixtures; their existing partial classification is retained,
not hidden as a rejected baseline. Naming now records 43,370 identities with zero unresolved;
documentation generation reports zero findings. All ordered generation commands exited 0.
One final conformance pass caught the queue's old live naming totals; those human prose figures
were synchronized to the artifact, with no gate or generated evidence edited by hand. The other
135 conformance tests passed. The naming gate is rerun after that prose correction, and the
new-head full release receipt is still a post-commit requirement owned by PR #27.

The corrected naming gate passes all 32 tests. The six other final conformance suites already
passed; together all 136 checks are green. Final source typecheck, lint and format checks exit 0.
The exact follow-up candidate and release-repeat results are recorded externally in PR #27 to
avoid a self-referential commit receipt; any subsequent code commit requires fresh verification.
