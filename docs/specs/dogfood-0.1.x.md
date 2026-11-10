# Compatible dogfood improvements and the next 0.1.x candidate

Status: implementation and focused verification complete, 2026-11-10. Exact-commit release
verification is an external post-commit gate recorded in the single review PR. The maintainer authorized one review PR, including release preparation,
and explicitly selected the 0.1.x line. This does not authorize merging or publishing.

## Outcome and boundaries

A cold SDK or agent consumer can compute a ratio from its actual statement, create an explicitly
funded or empty portfolio, inspect its handle, recover an order's current state, and repair an
ordinary input error using public discovery. Existing 0.1.2 calls, numerical conventions and
immutable artifacts remain supported. The release includes the already merged additive price-level
and holdings-partition capabilities with honest release notes under the user-selected 0.1.x policy.

Authority: the maintainer's delegated request, `AGENTS.md`, `CONTRIBUTING.md`, the alignment laws,
FC2/FC3/FC7, the local-operation and trade-lifecycle contracts, and the release runbook. The
original dogfood report was read from its feedback worktree (after its AGENTS.md). Its statements
that LIB-01/02/03 remain unfixed describe that older checkout: main d50b401 includes all three.
Private evidence is read-only and never becomes test or PR data; all new examples are synthetic.

No provider/data infrastructure from draft #26, performance dependency on #12, live execution,
paper-store changes, new persistence system, implicit cash, silent financial defaults, coercion,
permissive unknown keys, cumulative-period reinterpretation or fill-engine change belongs here.

## Decisions

1. Single-statement ratios accept an additive direct named input (`{ income }` or `{ balance }`),
   alongside their supported `{ statements }` input. Exactly one source is allowed. Direct inputs
   reuse the existing canonical statement field/period validators with per-formula required facts,
   without requiring unrelated monetary lines, and use the shared ratio implementation/report; complete inputs
   retain complete-set/correspondence validation. Income-only margins, interest/debt-service
   coverage and income-only per-share ratios, and balance-only liquidity/debt ratios form the
   bounded family. EBITDA, cross-statement ratios, average-balance ratios and market multiples
   retain their existing complete inputs. Periods, scales, availability and null reasons survive.
2. Two operations complete bootstrap and opening: `portfolio.create` in the opt-in trade pack
   delegates to `createPortfolioLedger` and the existing writable artifact store; it requires
   portfolioId, baseCurrency, explicit initial events (possibly empty), caller timestamp and
   portfolio:write. `portfolio.inspect` in the portfolio pack opens inline or handled ledgers
   through `readPortfolioLedgerSnapshot`; summary and bounded event/position/cash pages use
   explicit section/offset/limit. No filesystem catalog or new durable identity is invented.
3. `trade.submit` adds `currentOrders` from the existing journal fold, scoped to the immutable
   receipt's order IDs. Receipt bytes and current-call deltas retain their meanings; recovery
   remains cumulative. Restarts, partial/terminal orders, cancellation and replay are tested.
4. `technicalAnalysis.ohlcvFromBars` explicitly validates core Bar records and projects financial
   OHLCV fields into indicator rows. It never alters source records or timestamps. Discovery
   teaches this path and the existing column path. Transport schema errors retain exact counts
   and a bounded set of representative indexed issues. All rows still undergo validation.
5. Mark-age warnings retain direct SDK string compatibility, disclose actual age/instants and
   teach obtaining a fresh observation. The operation layer assigns a registered stable warning
   code and deduplicates identical warnings; it never advises relabelling observations.
6. Screen discovery states the complete finite predicate grammar and links executable synthetic
   examples. TA discovery makes category filtering evident while preserving name-search meaning.
7. maximumEstimatedCost and maximumSlippageBps accept finite nonnegative ceilings consistently
   in domain and wire validation. Zero is a binding zero ceiling; positive estimates fail it.
   Other positive bounds and missing/unverifiable handling retain their contracts.
8. Persisted instrument terms remain authoritative. Guidance teaches omission to reuse them and
   rejects real term changes. This patch does not canonicalize or migrate persisted terms.
9. Calendar discovery exposes the existing historical floor (2001-01-01), dataset version and
   rule-projection limitations; a range before that floor gets a registered diagnostic. No
   historical session answers or Calendar method/result roles change. Future ad-hoc closures
   cannot be certified by rules; do not invent a verified future endpoint.
10. A task-first executable guide covers vectorized executionLag/rebalance/cost/annualization/
    risk-free controls, researchProtocol and all-attempt selection hygiene, and estimates versus
    charged execution costs. Thin declarative vectorized controls may delegate to the SDK with
    parity tests. A wire paper-cost redesign is excluded: its SDK handoff must be explicit.
11. Recheck npm before versioning. Use existing Changesets/release tooling's patch override to
    reconcile pending minor intents with explicit maintainer policy; preserve all notes and name
    additive capabilities as additions. Synchronize both public artifacts and runtime/private
    metadata with publication:update and the documented lockfile process. Do not run the release
    shell path that pushes main or publishes. No #26 changeset is consumed.

## Ordered slices and acceptance checklist

- [x] S1: synthetic before/after single-statement reproductions; old complete calls, direct
      families, typed errors/unknowns/nonfinite values, scaling, periods and nulls; first-touch,
      public types and packed consumer coverage.
- [x] S2: create → inspect → record events → reopen journey with memory and fresh file-store
      instances; explicit empty/funded input, no capability/store, tampered handles, bounded
      reads and all registry/CLI/HTTP/MCP schema/parity coverage.
- [x] S3: current order view from journal; immutable receipt and cumulative recovery survive
      restart/retry and partial/cancelled/filled states; existing LIB repair tests stay green.
- [x] S4: explicit bar projection, bounded row errors, stable/deduplicated mark-age warnings,
      finite screen grammar, category discovery and historical calendar disclosure, each with
      executable repair/discovery examples and unchanged valid calculations.
- [x] S5: zero ceilings consistently enforce positive versus zero costs/slippage, missing and
      invalid values; task-first instrument/research/cost/lag examples execute.
- [x] S6: full DX-01…20/API-01…05/LIB-01…03 disposition with actual evidence and precise
      reasons; hand-classified exports, ordered generated artifacts and bundle budgets.
- [x] S7: rechecked next unused 0.1.x version, retained changeset notes and synchronized
      metadata/changelog/lockfile; no publication/deployment.
- S8 (external post-commit gate, recorded in the PR): independent review of original request versus implementation, packed consumers,
  pnpm run ci, standalone api:check and second test:coverage; full hosted matrix,
  deterministic generations, clean regen and registry rehearsal at EXACT final candidate
  commit. Record exits, run URLs, artifacts and any failed/skipped checks truthfully.
- [x] S9: one pushed branch and one reviewable PR against current main. Record #26 head/draft
      before/after, actual file/public-contract overlap, textual conflicts separately from
      semantic risks, and concrete owner retests. No merge/publication or #26 modification.

## Explicit dispositions outside implementation

- LIB-01/02/03: already fixed by PR25/8a8c8f8, merged d50b401; preserve/retest, do not reimplement.
- API-01: externally repaired instructions and successful continuation in dogfood evidence;
  no new API regression claim. API-02…05: external coverage, timing, freshness and methodology.
- DX-06: deferred intraday P&L requires explicit instant marks in the shared engine.
- DX-14: deferred availability-aware research needs interval/arrival/revision contracts.
- DX-20: deferred interim/YTD vocabulary and quarter derivation need period compatibility rules.
- DX-17/18: external service availability/dependencies; do not spend staging budgets.
- #26: contradictory adjustments, distinct-root ordering, connector mapping diagnostics and
  no-key author onboarding remain on that draft PR, outside this release.

## Contract review before implementation (2026-11-10)

Self-review against the original request and alignment laws found three pitfalls and resolved
them before code: narrow ratios must not forge missing statements; inspection must not dump an
unbounded ledger or enumerate a filesystem; a current order view must fold the authoritative
journal rather than modify a content-addressed receipt. Direct named statement inputs, bounded
sections and the existing journal fold satisfy these constraints. A patch override is authorized
policy, not a claim that the queued additive features are bug fixes. No consequential maintainer
decision remains open within this scope; final approval is review of the concrete PR.

## Source closeout and external release receipt

Initial implementation source: 56056dd8906849711e73ed8530df19c0ef05b1b5, followed by the
full-gate integration repairs recorded in the review. S1–S7 and S9 are backed by
the focused, generated-contract and installed-consumer receipts in the
[review record](../reviews/dogfood-0.1.3.md). The final reconciliation re-read the original delegated
request: all DX/API/LIB items have dispositions, all selected financial/usability slices are
implemented or explicitly docs-only as allowed, and the bounded deferrals remain unchanged.

S8 is a post-commit gate. [PR #27](https://github.com/InsiderFinance/totalfinance/pull/27) is its
authoritative live checklist and exact-final-head receipt; it records the full supported-Node
matrix and independent release repeat. Publication remains separately unauthorized regardless of
that gate's result. A later code commit invalidates earlier release receipts.

## Review follow-up contract (2026-11-10)

The maintainer authorized the necessary review repairs in the same PR. Review probes at 96a786c
confirmed early full-set availability, an undiscoverable direct repair for incomplete full inputs,
a direct-input example that supplied illegal top-level statements, and the wire schema still
rejecting canonical bars. The earlier release receipt attests only that old commit; S8 reopens.

Decisions reviewed before implementation:

- F1: each full statement-set period reports `availabilityOf(set)`; direct inputs report their
  own period availability. Paired current/prior periods independently use their set maximum.
  No timestamps are fabricated or changed; no availability-aware research framework is added.
- F2: full inputs retain all existing validation, error codes and field context. Single-statement
  heads add their supported direct repair route when full validation fails. Missing required
  direct facts get head-specific, executable examples including any required scalar controls.
- F3: direct facts may include other known canonical fields through partial statement types;
  required facts retain their types/requiredness. Unknown keys and invalid provided fields still fail.
- F4: the existing TA tool's closed row schema explicitly enumerates optional canonical metadata
  (symbol, timestampMs, vwap, adjusted). Supplying any source metadata requires complete canonical
  core Bars on every row; legacy OHLCV-only arrays remain valid. Keeping one closed row schema
  preserves existing unknown-field error codes and bounded issue counts.
  Canonical bars delegate to `ohlcvFromBars`, which validates single-symbol, strictly increasing
  timestamps, source field types and OHLCV invariants before projection. No sort, relabel, fill,
  price adjustment or calculation is implemented in the transport. SDK structural provenance
  remains in the retained source records. Legacy row/column calls retain their meanings.
- F5: create/inspect discovery explicitly names both opt-in packs and read/write capabilities.
  No catalog or new persistence identity is added. Save and reuse the returned handle.
- F6: record remaining narrow-fact ratio families as separately queued design work, without claiming
  them implemented. Keep the existing mark-age policy (including differing/future instants) honest;
  do not invent a freshness threshold or redesign all warning result contracts in this patch.

Checklist (verify before checking):

- [x] F1: staggered statement availability, all single-set heads and paired periods; direct
      availability stays exact; no finite-output or financial convention regressions.
- [x] F2: original failing full calls teach the direct path and retain typed context; every supplied
      direct missing-fact example executes successfully for its own head.
- [x] F3: inline extra valid income/balance lines compile and run from installed tarballs in strict
      NodeNext/Bundler; misspellings, wrong types and missing required facts remain refusals.
- [x] F4: raw canonical bars succeed through registry/CLI/HTTP/MCP without an SDK preprocessing step;
      legacy rows/columns remain compatible; mixed symbols, duplicate/reversed timestamps, partial
      metadata, malformed optional fields, unknown keys and invalid last rows fail repairably.
      Schema descriptions, SDK projection, source immutability and packed first-use all agree.
- [x] F5/F6: narrow pack discovery test, public guide and feedback disposition/queue are truthful.
- [x] Regenerate affected artifacts in order, classify schema/contract changes, and verify bundle
      measurements without weakening bounds. The same PR branch receives the repair commit.
- [ ] Repeat S8 at the exact final follow-up head: all current-head PR jobs, full hosted matrix,
      independent clean CI/API/second coverage, packed smoke and fresh #26 overlap/status assessment.

Scope review: these are compatible repairs to the selected family and existing operation. #26's
provider package/contracts and blockers remain outside this PR. Version remains prepared 0.1.3;
no new bump, merge, publication or deployment is authorized or required.
