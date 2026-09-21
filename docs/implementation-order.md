# TotalFinance implementation order

> **Status: authoritative sequence for remaining work.** This document owns only ordering and
> completion dependencies. Detailed API and acceptance requirements stay in the linked specifications.
> If another document calls a different phase "current," this sequence wins until that document is
> synchronized.

**September review repairs — locally verified complete:**
[`R01–R14 and their evidence`](./specs/review-september-2026-repairs.md) passed the local source,
static/API, and full-coverage gates on `dccfce53` plus the repair changes. This records local
verification of the repair revision, not a hosted-matrix result or publication authority.
**MCP and the task-first public developer site — implemented; local automated gates green.** Follow
[`mcp-and-public-docs-experience.md`](./specs/mcp-and-public-docs-experience.md) for this bounded
pre-publication experience slice and its acceptance evidence (initial local verification on
`94fb7f5f`; committed and integrated over release refresh `b978b767` in `768393eb`). It improves discovery, worker jobs,
public reference, runnable learning journeys, release-matched examples, and agent evaluation;
it does not reopen the completed core stages or authorize data-provider/live-broker work.

**Core handoff: dogfooding-driven library value is implemented and locally green.**
[The completed follow-on tracker](./specs/dogfooding-library-value.md) records supplied-Greek
exposure, chain health, semantic metric comparison/replay and the repaired sector-performance APIs.
Full CI and byte-stable regeneration passed on `c993367d` (11,488 library tests) and the combined
sector revision `d81a0db5` (11,897), plus 38 site tests each. The closeout changes only tracking prose.
PR #336 is integrated into PR #303 at merge commit `fc46353b` (2026-09-08), preserving the
search repair at `cec30b61`. The maintainer explicitly authorized this integration while hosted
checks remained red; that decision does not waive the hosted matrix for release.

### Preview launch queue (2026-09-07)

**Current handoff (2026-09-21): standalone TotalFinance source PUSHED; local verification COMPLETE;
hosted diagnostic portability fix in verification.** `InsiderFinance/totalfinance:main` is now the library's source of truth,
with all 25 packages, imports, runtime namespaces, transports, documentation and root-layout CI
migrated without old-name aliases. The code revision is `6eeb459064062511a3889562b64333b6b8c07e10`.
The [migration acceptance record](./specs/standalone-totalfinance-migration.md) owns its verification:
full CI passes independently on minimum Node 22.13.0 and Node 24.21.0, each with 12,088 library
tests and 79 site tests. Hosted generation identified only last-digit noise in diagnostic return
previews; the renderer repair preserves library outputs and awaits its hosted rerun.
Future library changes belong here, not in the private app's
library copy. **Next: the remaining organization and website acceptance in steps 2–3, then the exact
versioned release rehearsal in step 4.** Npm publication, release versions, credentials and website
deployment remain separately approved steps.

**Previous handoff (2026-09-21): freeze repairs COMPLETE (local); source-freeze ready.** The
[September 21 checklist](./specs/pre-publish-interface-repairs.md#september-21-freeze-repair-checklist-takes-precedence-over-historical-completion-claims)
closes the composition/persistence findings from `f4b0e4b65`: hedge capacity, complete authorized
plans, combo lifecycle and scaled net limits, single-charge execution costs, and durable single-use
authorization recovery. Final source `af0d7cd2a` passed complete CI on **Node 22.23.2 and 24.21.0**
(each: **551 files / 12,080 library tests, 79 site tests, all 25 API reports**) and byte-stable
regeneration on Node 22. The linked spec records the full acceptance evidence.
Repository selection and extraction are superseded by the current handoff above. The remaining
organization, production-site and exact-release gates are still required; this older freeze record
does not certify hosted CI or authorize version changes, npm publication, or deployment.

**Previous handoff (2026-09-21):** A1 (valuation
instants) LANDED at `be14108d3`; A2–A8 (one Greek unit system, required volatility scale,
leg-volatility premiums and the position's own horizon, agent-boundary assumptions, contract
multipliers that never default, the options grammar corrections) LANDED at `a750f1cd4`; B1–B7 (MCP
tool names and the envelope, bounded metrics and the stock leg, combo orders, one order vocabulary,
one chain row with `chainGreeks` and `usEquityOption`) and C (hygiene: `isTrustworthy`, null-with-
diagnostic Kelly and Sharpe, the message-prefix and code-registry gates, one name per ratio, one
portfolio VaR door) LANDED at `36cbd5352`. The fresh review above supersedes that revision's
completion claim.
[`pre-publish-interface-repairs.md`](./specs/pre-publish-interface-repairs.md) is the contract for
the fresh-eyes review of head `01a352fdd`: silent financial assumptions (date-only valuation
instants, two Greek unit systems under one name, per-bar volatility feeding annualized consumers,
model premiums ignoring leg volatility, agent-boundary defaults, multiplier fallbacks, the batch
pricer's engine default) and wire contracts that freeze at publish (tool names, the MCP envelope,
unbounded metrics, the stock leg, combo orders, the order vocabulary, the chain row). It lands
before step 4 below; every item changes user numbers or a frozen shape.

**Previous handoff (2026-09-09): signed leg constructors COMPLETE (local).**
[`signed-leg-constructors.md`](./specs/signed-leg-constructors.md) records the three instrument-first
constructors with required signed quantity, full caller/docs migration, removal of the six old leg
helpers, and preserved named Position presets. Source revision `d2da915c` passes full CI
(545 files / 11,968 library tests, 79 site tests, coverage floors, typechecks, lint, builds and all
25 API reports) and clean byte-stable regeneration. This bounded pre-release simplification does
not reopen completed core phases or certify hosted checks. **Next: step 2's organization/hosted-CI
prerequisites and step 3's remaining domain/browser/hosting acceptance below.**

This is the current execution order, not a new core feature phase. Detailed search acceptance lives
in the [site contract's launch-search amendment](./specs/mcp-and-public-docs-experience.md#launch-search-amendment-2026-09-07).
Historical closeout counts above do not certify later source changes.

**Earlier integration evidence: search repair and #336 integration are locally complete.** Merge commit
`fc46353b` passes full CI (544 files / 11,897 library tests, 63 site tests, all coverage floors,
typechecks, lint/format, builds and 25 API reports) and clean byte-stable regeneration. Sector search
is verified on the combined index. These are local Node 26.5.0 results, not a hosted matrix or a
publication certificate. The subsequent introductory-example repair in step 3 is now locally
complete; its separate [acceptance record](./specs/mcp-and-public-docs-experience.md#first-call-examples-amendment-2026-09-08)
covers 24 installed-artifact copies, 79 site tests and the updated public return-shape guidance.
Next: step 2's organization/hosted-CI prerequisites and the remaining domain/browser/hosting
acceptance in step 3. This documentation repair does not reopen core implementation.

1. **Search quality — COMPLETE (local).** Normalize human phrases and API identifiers;
   rank exact names first and useful matching functions/tasks before incidental types; retain all
   import paths and explicit type discovery. Share an in-flight index load, retry failures safely,
   and prevent stale responses. Lock both ranking and loading into CI regression tests.
2. **Release prerequisites — integration COMPLETE; organization gates OPEN.**
   [PR #336](https://github.com/InsiderFinance/insiderfinance-app/pull/336) is integrated into #303
   and locally verified, including sector-performance search. The public source home is now
   `InsiderFinance/totalfinance:main`; standalone Actions jobs actually start. Obtain a passing
   latest supported-Node matrix and release rehearsal before release. Confirm scope/package
   publishing rights, approval-environment reviewers, rollback owner, and website domain/hosting
   destination with the maintainer. No private app source or Git history was imported. These
   organization decisions can run in parallel with website acceptance; they cannot be assumed or
   replaced by local tests.
3. **Production website polish and acceptance — examples COMPLETE (local); deployment acceptance OPEN.**
   Introductory examples now lead with explicit sample inputs, a useful call and its actual output;
   full-playground reproduction and large sample setup are separately expandable. Both copy surfaces
   are installed-artifact tested. This resolves documentation noise without redesigning core outputs
   or replacing `Array.from` with disguised loops. With the domain chosen, implement canonical URLs,
   sitemap, social-sharing metadata, and an explicit staging/development/version-archive indexing
   policy. Verify directory-index routing, real 404s, HTTPS, compression, cache and security headers.
   Complete desktop/mobile/keyboard review of search, navigation, copy actions and every playground;
   check WebMCP in a supported host without treating mocks as real-host evidence. Finish the existing
   app browser and captured-data checks below as well. Provider acquisition/projection, cache
   freshness and rollout remain app-owned; do not silently enable a production engine. The private
   app's installed artifacts, imports and opt-in flags were not renamed by this standalone move;
   migrate and verify those separately when adopting the TotalFinance packages.
   3b. **Pre-publish interface repairs — COMPLETE (local), source-freeze ready.**
   [`pre-publish-interface-repairs.md`](./specs/pre-publish-interface-repairs.md) records the landed interfaces
   (A: assumptions and units at `be14108d3` and `a750f1cd4`; B: wire contracts and C: hygiene at
   `36cbd5352`) and the September 21 composition/persistence closeout at `af0d7cd2a`. Both supported
   Node full gates and clean-tree regeneration pass; no implementation item remains in this repair.
   After step 4, contract changes require the published compatibility/versioning policy.
4. **Freeze and rehearse the exact release revision.** After the preceding source changes, review
   the fixed-group version bump to `0.1.0-preview.0`, regenerate evidence, run the full gates and
   release rehearsal on the committed release tree, and retain the artifact hashes. Use the
   [Stage 5A contract](./specs/preview-integration-and-shipping.md) and
   [release runbook](./runbooks/release.md); historical `0.0.1` manifests are not approval evidence.
5. **Publish the preview after approval, then verify the registry.** Publish only the approved
   tarballs for all twenty-five packages under `preview`, with provenance. Install from the public
   registry in a clean consumer and retain the successful smoke receipt, including site-example
   verification. A partial publish follows the rollback runbook, not a blind retry.
6. **Deploy matching documentation, then announce.** Import the actual registry receipt, build/test
   release-matched pages, retain the immutable version archive and deploy only `site/dist/` after
   separate approval. Smoke the real public domain (including search and versioned pages). Announce
   only after both registry smoke and website checks pass. Stage 5B is a later, separate stable
   cutover; do not label this preview 1.0 or `latest`.

WASM, new data adapters, additional features and hosted/live trading do not postpone this bounded
preview queue. Search implementation is not permission to publish, deploy, merge or switch engines.

No new core feature phase is being opened. The freeze-repair checklist is locally complete;
the remaining work in this queue is release integration and acceptance, not another library build phase.

For PR #336 specifically, use the
[`sector-performance readiness checklist`](./reviews/sector-performance-readiness.md): it owns
the simple/audited SDK distinction, final gates and app-owned follow-up. No production data endpoint
is implemented by that PR.

**Previous handoff: app dogfooding implementation is complete and locally green; browser/data review and shipping gates remain.**
On 2026-09-07 the maintainer requested comparison against current develop's OPC, GEX/DEX and
volatility/skew, plus the separate net-drift PR. The
[`app dogfooding comparison`](./reviews/app-dogfooding-comparison.md) records the numerical evidence,
reproduced app/library defects, convention differences and proposed ordered implementation checklist.
The user approved its repairs and all subsequent migrations. The
[`implementation tracker`](./reviews/app-dogfooding-implementation.md) owns completion evidence,
rollout switches and the remaining acceptance gates for OPC, GEX/DEX, observed skew and PR #286's
premium-drift workflow. The settled-state repeat passes 11,262 library tests, 38 site tests, 2,127
app tests, typechecks, packed-consumer checks and all-opt-in app compilation. Legacy calculations
remain the default; preview modes do not authorize a
production switch or publication. Do not treat the original comparison's historical findings as
current implementation status. Real browser/keyboard/mobile review remains required: the local
browser permission prompt was declined, so visual and supported-host WebMCP checks are not claimed.
Use [`site/README.md`](../site/README.md) to preview/build and the
[`release runbook`](./runbooks/release.md) to import an actual registry-smoke receipt, preserve version
archives, and deploy after approval. Local tarball examples are green; actual public npm verification
and real external-model evaluations are not replaced by local tests.

After the additional changes and browser review, rerun the exact-revision shipping gates and release
rehearsal. The historical `0.0.1` rehearsal does not certify the integrated MCP/site revision; see the
latest amendment in [`preview-integration-and-shipping.md`](./specs/preview-integration-and-shipping.md).

**Stage 5A publication and Stage 5B stable cutover remain maintainer-held.** Their
release decisions and shipping gates still apply; the completed Phase 3B/Stage 4/7B slices and
review repairs must not be restarted. No commit or push is authorized by this handoff.

## How the documents fit together

| Document                                                                                                       | Authority                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`library-alignment-spec.md`](./library-alignment-spec.md)                                                     | Permanent public-API laws, completed Phase 3A evidence, and the release-blocking Phase 3B surface closeout.                                                                                                                                              |
| [`specs/wave6-quant-moats.md`](./specs/wave6-quant-moats.md)                                                   | The completed finite feature batch and its corrected APIs, mathematics, and per-item verification.                                                                                                                                                       |
| [`specs/phase-3b-public-naming-normalization.md`](./specs/phase-3b-public-naming-normalization.md)             | Whole-repository public naming policy, settled replacements, package/MCP decisions, migration slices, and executable closeout gates.                                                                                                                     |
| [`specs/phase-3b-runtime-semantic-closeout.md`](./specs/phase-3b-runtime-semantic-closeout.md)                 | Ordered Phase 3B implementation, generated artifacts, commit slices, and executable exit evidence.                                                                                                                                                       |
| [`specs/phase-3b-decision-ledger.md`](./specs/phase-3b-decision-ledger.md)                                     | Settled helper-result, positional-pair, runtime, field-semantic, and execution-policy answers for Phase 3B.                                                                                                                                              |
| [`specs/finance-portfolio-backtesting-completeness.md`](./specs/finance-portfolio-backtesting-completeness.md) | Accepted specification and per-slice execution tracker for core finance, valuation, research, performance, foreign-exchange, commodities, durable portfolio, and portfolio-scale simulation. Backtesting is one workstream, not the document's umbrella. |
| [`specs/shared-scenario-runner.md`](./specs/shared-scenario-runner.md)                                         | Completed Stage 4.4b shared cross-domain scenario-runner contract and exact-commit evidence record.                                                                                                                                                      |
| [`platform-completeness-roadmap.md`](./platform-completeness-roadmap.md)                                       | The long-lived layer model and the compute-platform programs: artifacts, market state, extension contracts, durable books, scenarios, and workflows.                                                                                                     |
| [`agent-native-portfolio-and-trading-platform.md`](./agent-native-portfolio-and-trading-platform.md)           | Focused direction for durable portfolio state, the pre-preview local operation/CLI/OpenAPI/MCP slice, later agent simulation/evaluation, safe trade proposals, and execution edges.                                                                      |
| [`roadmap.md`](./roadmap.md)                                                                                   | Broad inventory of shipped and possible quant features; it does not choose the next task.                                                                                                                                                                |
| [`mcp-acceleration-data-growth-strategy.md`](./mcp-acceleration-data-growth-strategy.md)                       | Split execution strategy: exemplary local MCP before preview; data, first-party growth, handles/Apps, hosted MCP, workers, WASM, and wider interop later.                                                                                                |
| Per-feature files under [`specs/`](./specs/)                                                                   | Detailed behavior for one implemented or proposed feature. They do not override this sequence or the alignment laws.                                                                                                                                     |
| [`specs/mcp-and-public-docs-experience.md`](./specs/mcp-and-public-docs-experience.md)                         | Authorized pre-publication MCP/discovery/jobs and complete public developer-site implementation, including installed-example evidence and the agent-evaluation corpus. Public release/deployment remains separately approved.                            |

The historical lovability and developer-experience reviews, and the
[2026-08-01 full implementation review](./library-implementation-review.md), remain evidence, not
active trackers.

## Latest-review findings and their owners

These are incorporated into the controlling stages below; they are not an additional queue.

| Finding                                                                                                                                                                                                                                                                                                                                                            | Required correction                                                                                                                                                                                                   | Owner             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| The complete public graph still uses ambiguous or opaque shorthand across package identities, SDK fields, declarations, artifacts, stable codes, and MCP—not only inside options.                                                                                                                                                                                  | Execute Phase 3B.N first: normalize names semantically, preserve only allowlisted canonical terms, and install a permanent declaration-backed naming ratchet before runtime contracts freeze.                         | Phase 3B.N — DONE |
| Public `blackScholesPrice`/`black76Price` object kernels can ignore an unknown key and return `NaN` for a missing required field at JavaScript runtime.                                                                                                                                                                                                            | Execute the dedicated, identity-deduplicated Phase 3B spec: generate field/runtime ownership, fix the shared boundary, then migrate in independently green package slices—not 3,313 handwritten path fixes.           | Phase 3B          |
| The result-grammar and high-level positional-pair reports contained unresolved decisions.                                                                                                                                                                                                                                                                          | Implement the settled 27-operation helper ledger and ratify the settled 30-operation positional ledger against regenerated identities.                                                                                | Phase 3B          |
| The original CTD proposal conflated a switching grid with delivery-option valuation and could accept a pairwise root that was not on the global frontier.                                                                                                                                                                                                          | The ceteris-paribus globally verified frontier and delivery-date DV01 shipped in `f555b11f`.                                                                                                                          | Closed            |
| The original optimizer proposal treated margin like maximum loss and fed dollar P&L to Kelly; the package direction was also stated backward.                                                                                                                                                                                                                      | Graph decoupling, capital normalization, finite Kelly, and admissibility shipped in `b2888eb4` through `9356745f`.                                                                                                    | Closed            |
| The cube proposal used point density as probability, collapsed the vol dimension, described grid columns like paths, and defaulted drift inconsistently.                                                                                                                                                                                                           | Probability mass, vol/day expectations, conditional break-even, and measure/drift parity shipped in `67034ce1`.                                                                                                       | Closed            |
| Representative-only TA metadata and chart-shaped output types would leave much of the 335-indicator registry ambiguous.                                                                                                                                                                                                                                            | Fuzzy discovery and exhaustive recursive output metadata shipped in `3c3a1d8f` and `8e59ca96`.                                                                                                                        | Closed            |
| The 2026-08-01 implementation review confirmed silent-wrong-number defects that pass every current gate: dealer-convention call walls take a signed max, lattice risk-neutral probabilities are unbounded, seven crypto facades skip the finite postcondition, near-singular covariance passes optimizers unwarned, and strategy builder slot order is unenforced. | Burn down the confirmed-defect list in [`library-implementation-review.md`](./library-implementation-review.md) §3; per the global stop conditions, none may survive the Phase 3B gate.                               | Phase 3B          |
| The 3B.N bulk renames minted spelled-out names that are false: a public `MonteCarloGinleyStream` (McGinley), "MonteCarloNeil–Frey" citations (McNeil), resample interval locals named `impliedVolatility`, and golden-vector generators writing to the retired package path.                                                                                       | Mechanical sweep for the rename-artifact classes with fixes at the source; add the review's affected files to the sweep fixture.                                                                                      | Phase 3B          |
| Defects cluster on public artifact methods (`atSpot`, `scenarioMap`, `levels`, surface lookups) that sit outside the facade wrapper's first-touch guards, Law-12 key checks, and Law-7 finite walk.                                                                                                                                                                | Route rich-class methods through the shared guard/postcondition machinery and add a conformance sweep so method boundaries obey C20 like every other contract.                                                        | Phase 3B          |
| The root README described Phase 3B.N as current and its spellings as non-final after N9 closed; the PR description still names retired package identities and stale counts; install/MCP quickstarts reference unpublished packages.                                                                                                                                | README corrected alongside this row (status paragraph + unpublished-package note); refresh outward PR/launch descriptions from generated counts in Phase 4.                                                           | Phase 4           |
| A blank-sheet finance inventory found category-level gaps hidden by the depth of the existing options/risk surface: no general time-value-of-money layer, DCF/fundamentals, general screening/style factors/event studies, cash-flow-aware returns, coherent FX/commodity front doors, implemented durable portfolio, or portfolio-scale ledger-backed backtest.   | Execute FC0–FC9 in the accepted [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md). These are pure core capabilities, not data-layer or documentation follow-ups. | Stage 4           |

## Execution sequence

### 0. Phase 3A argument safety — complete

Phase 3A is not outstanding implementation work. It closed against 3,310 public callables; the
regenerated post-Wave-6 manifest now governs 3,313. Financially confusable coordinates use named
requests, retained positional protocols are limited to structurally unmistakable roles, and
signature drift fails CI.

Do not reopen object-versus-positional design without a reproduced counterexample. Phase 3B.N now
corrects the names on those settled shapes; the following Phase 3B work concerns runtime object
boundaries, field semantics, and result contracts—not another argument-style migration.

### 1. Wave 6 quant moats — complete

Every checkbox in the [`Wave 6 spec`](./specs/wave6-quant-moats.md) is closed. The batch shipped the
CTD frontier, optimizer capital/Kelly work, probability-aware what-if cube, and exhaustive TA
discovery/output metadata in independently green commits through `8e59ca96`.

The defined-risk scanner's explicit opt-in expansion for naked/ratio structures is a separately
governed pre-core-freeze feature recorded in the Phase 3B decision ledger. It does not reopen Wave 6
or block Phase 3B.

### 2. Phase 3B.N public naming normalization — COMPLETE (N0–N9, re-closed after RV7)

Execute the
[`whole-repository naming specification`](./specs/phase-3b-public-naming-normalization.md) before
generating the runtime/semantic baseline. It covers all package/import identities, exports,
declaration labels, recursive fields, schemas, stable codes, serialized artifacts, MCP, generated
outputs, and packed consumers.

The phase:

1. installs a declaration-backed public naming inventory and scope-aware allowlist;
2. replaces ambiguous or opaque public shorthand with semantic names and explicit units;
3. renames the volatility and technical-analysis package/domain identities;
4. makes Black-Scholes the discoverable flagship and raw model vocabulary;
5. preserves canonical terms and private formula notation where brevity improves recognition;
6. burns every unresolved naming identity to zero without pre-1.0 compatibility aliases; and
7. executes the spec's `3B.N8-DOCS` task: future designs use final vocabulary now, runnable guidance
   migrates with its executable contract, generators change before outputs, and historical evidence
   remains explicitly historical.

This phase is complete only when SDK, raw, batch, artifact, schema, MCP, docs, and stable wire
contracts use one canonical vocabulary and naming drift fails CI.

**Done — reopened by RV7 and re-closed, and this zero is not the previous zero.** The gate that
first reported an empty queue was measuring "no token the denylist recognized", which is not the same
claim as "reviewed": a digit ended scrutiny (`vol1`, `iv10Put`, `rangeAvg5` — `avg` had been
denylisted since N0 and still passed), an embedded single letter was never checked, and short
truncations (`lo`, `hi`, `mult`, `bb`, `kc`, `rr`, `bf`) were never on the list. Corrected, the queue
was 199. Four batches burned it to 0: the volatility bracket and two-asset spread; the skew desk
vocabulary and candle bodies; the Bollinger/Keltner/multiplier families; and 66 individually-reasoned
NAME entries for published notation (VaR/CVaR, R², p-value, stochastic %K/%D, Ichimoku Senkou spans,
Bollinger %B, greeks partials, Gatheral's `g`, SSVI's `w`, G2++, z-score/Z-spread, k-fold) — names,
never tokens, since one `r` or `k` token entry would exempt every compound containing that letter.

41,983 public naming identities are walked and 0 are unresolved; 38,051 are `explicit`,
3,770 allowlisted canonical terms each carry a written rationale — a gate now fails if any is
blank — 159 are scoped notation and 3 are opaque payload interiors. All 115 retired forms have
executable removal evidence (`tools/naming-removals.test.ts`),
behind a gate that fails if a fixture is recorded without an assertion. Eight tests hold the surface;
see “Closeout state (3B.N9)” in the naming spec for the full table, the gate inventory, and — more
useful than either — the list of defects that passed every one of those gates and had to be caught by
reading. The N8 addition worth carrying forward is `tools/spec-mapping-conformance.test.ts`: it reads
the spec’s own mapping rows and fails when a stated target never landed, which is how a written
decision stops being advisory.

### 3. Phase 3B runtime and semantic surface closeout — COMPLETE 2026-08-19 (`af99ee107`)

**Phase 3B is complete.** Every subphase (3B.0–3B.6) closed at green commits: enforcement at
defective ZERO of 5,047 measured candidates, both decision ledgers implemented in full (H 27/27,
P 34 retained / 0 migrated), the packed misuse matrix with the one-round-trip law, and the nine
3B.6 exit conditions each carrying gate-bound evidence — final counts published in the
[alignment closeout](./library-alignment-spec.md). **Stage 4's FC0–FC9 and platform gates have
landed, and the September review repairs are locally verified complete.** The core capability
tracker records the completed slices and maintainer-held release gates; it does not reopen Stage 4
or authorize publication. The historical section below records what Phase 3B required.

#### (historical) Phase 3B runtime and semantic surface closeout — after Phase 3B.N, release-blocking

Execute the dedicated
[`Phase 3B implementation spec`](./specs/phase-3b-runtime-semantic-closeout.md) under the permanent
laws and concise ledger in the
[`library alignment spec`](./library-alignment-spec.md#phase-3b-runtime-semantic-closeout), using the
settled answers in the
[`Phase 3B decision ledger`](./specs/phase-3b-decision-ledger.md). It is a hardening phase, not an
API-philosophy or naming rewrite:

Finishing **3B.0 does not finish Phase 3B or activate Stage 4**. It closes the measurement baseline.
Stage 4 remains blocked until 3B.1–3B.6 and the complete Phase 3B exit gate close at one green commit.
The subphase sequence is:

1. **3B.0 — measure (CLOSED 2026-08-14, RV31):** generate and ratchet the public runtime/field contract inventory—names,
   meanings, types, units, defaults, requiredness, nullability, result behavior, errors, and validator
   ownership;
2. **3B.1 — install enforcement (NEXT):** validate required fields, primitive types, and unknown keys at
   every public object boundary,
   including expert kernels and `core`/`math` object/options/configuration contracts, while retaining
   conventional positional scalar mathematical contracts, private unchecked inner loops, and batch
   throughput—no package or manifest tier receives a blanket exemption;
3. **3B.2 — migrate the surface:** close runtime and field contracts package by package in dependency
   order, with generated artifacts and affected packed-package proof in every slice;
4. **3B.3–3B.4 — finish result and call contracts:** implement H01–H27, remove every resolved
   `HELPER_QUANT_ANSWER_BACKLOG` entry, and bind/prove P01–P30 without object-wrapping retained natural
   calls;
5. **3B.5 — prove real consumers:** run a real clean pack/install smoke with every package/contract
   slice, then the cumulative cold packed-tarball TypeScript and JavaScript matrix, including common
   misspellings and malformed runtime objects; and
6. **3B.6 — close and ratchet:** remove stale tracker notes, drive every unresolved population to its
   declared exit state, run the full evidence suite, and make every completion claim mechanically
   truthful.

Phase 3B is complete only when malformed public objects cannot silently produce `NaN` or a plausible
wrong answer, no user-visible result decision remains labeled pending, and the semantic contract
ratchets are active for all future APIs. The 3,313 callable paths are coverage input, not 3,313
handwritten migrations: the implementation spec deduplicates path, implementation, contract, and
validator identities.

### 4. Core capability completion and platform spine — after Phase 3B

Implement the accepted
[`core capability completion spec and execution tracker`](./specs/finance-portfolio-backtesting-completeness.md)
and the compute-only portions of the
[`platform-completeness roadmap`](./platform-completeness-roadmap.md) in the dependency order below.
This stage fills the missing foundational finance categories first, then builds the tight
abstractions for books, scenarios, market state, reproducible analysis, and portfolio-scale
simulation over them.

#### Stage 4 activation protocol

Phase 3B, FC0–FC6, platform Gates 4.1–4.3, FC7 / Stage 4.4a, and the shared scenario runner / Stage
4.4b are complete. FC7 closed at `a6f9842b`; Stage 4.4b closed at `3095cf91` after its full package,
packed-consumer, generated-evidence, and 9,749-test repository gate passed. Stage 4.5 calibration
and research artifacts closed at `795dd999f` (2026-09-03) after its six slices landed in order from the
accepted contract and the full repository gate, `api:check`, and the packed consumers passed.
Preview P1 closed at `db2df2451` and Stage 7A at `c7bdb260d` (2026-09-03). Stages 4.6, 4.7,
7B.1, and 7B.2 have also landed; their exact evidence is in the core capability tracker.
**The September review repairs above are locally verified complete.** Stage 5A publication remains a
maintainer decision; no already-completed implementation stage should be restarted from this paragraph.
Each reviewed slice closes with code, tests, generated artifacts, and executable evidence before the
tracker activates the next globally ordered dependency-ready row.

This is how the roadmap enters the library: compute semantics land in exported domain packages, never
inside a transport. After Stage 4.5 freezes the shared artifact/research contracts, a narrow preview
lane deliberately pulls forward options-marking truthfulness, protocol-neutral read-only operations,
the local CLI/OpenAPI/MCP adapters, and preview shipping. Those adapters expose the then-current
surface and are extended as Stage 4.6 lands; they may not become a hidden implementation home or
claim the final FC9 freeze early. The Stage 4 tracker owns compute progress; this file owns the global
queue and both release cutovers.

#### 4.0 Complete the missing finance and research foundation

- execute FC0 first: install the settled package graph, shared financial contracts, architecture
  tests, manifest ownership, and evidence plans;
- execute FC1 and FC2: time-value-of-money, cash-flow solvers, loans/capital budgeting, typed
  statements and ratios, cost of capital, DCF, reverse DCF, sensitivities, and comparables;
- execute FC3: declarative screening/ranking, economic style factors, and point-in-time event studies;
- execute FC4: TWR, MWR, Modified Dietz, flow-aware timelines, and reconciled contribution;
- execute FC5 and FC6: coherent foreign-exchange and commodity carry/term-structure front doors; and
- keep every raw/direct calculation independently public and put every new identity under the Phase
  3B naming, runtime, field, result, manifest, finite-success, and packed-consumer ratchets in its
  first commit.

The detailed API names, semantics, acceptance laws, package ownership, and commit slices are fixed by
FC0–FC6. This is implementation work, not another design phase.

#### 4.1 Finish platform Gate A

- ratify the permanent layer and dependency laws;
- add the direct vanilla-intrinsic primitive;
- add an architectural dependency test that prevents upward or cyclic package edges; and
- keep raw functions, facades, compositions, and workflows independently usable.

#### 4.2 Build the shared artifact spine

- immutable, versioned market snapshots with explicit conventions and provenance;
- versioned analysis artifacts and large-table references;
- serializable scenario sets, hashes, replay, and migration policy; and
- JSON-safe representations first, with Arrow mappings added when a measured consumer needs them.

#### 4.3 Add narrow structural extension contracts

- small `Pricer`/requirements protocols and conformance kits;
- no universal instrument superclass or stringly typed mega-dispatch;
- explicit engine choice and inspectable automatic selection; and
- adapters around existing public functions rather than a second pricing implementation.

#### 4.4 Complete durable books and shared scenarios

- **Stage 4.4a / FC7 is `COMPLETE @ a6f9842b` (reviewed 2026-08-29).** It executed the
  [`core capability completion spec and tracker`](./specs/finance-portfolio-backtesting-completeness.md)
  and the ledger, economic-event, P&L-reconciliation, replay, and package-boundary decisions in
  [`agent-native-portfolio-and-trading-platform.md`](./agent-native-portfolio-and-trading-platform.md)
  as the accepted durable-portfolio contract. Its immutable ledger, identity, events, transactions,
  lots, settled/unsettled cash, financing, income, lifecycle, grouping, multi-currency valuation,
  policy, reconciliation, serialization, migration, replay, and flow-aware performance laws are
  closed; its transport, authorization, agent evaluation, and broker stages remain later edge work.
- **Stage 4.4b is `COMPLETE @ 3095cf91` (verified 2026-09-01).** The
  [`shared-scenario-runner contract`](./specs/shared-scenario-runner.md) closed with the independent
  `@totalfinance/scenarios` package, cross-domain full/Taylor valuation, exact aggregation/replay,
  first-party spot/options/bond adapters, bounded extension callbacks, and all package/runtime/
  generated-evidence gates green.
- Preserve `analyzeBook(...)`, `stressTest(...)`, `taylorPnl(...)`, every direct pricer, and every
  raw calculation as independent small calls. The runner is additive, never a mandatory framework.

#### 4.5 Complete calibration and research artifacts

- **`COMPLETE @ 795dd999f` (2026-09-03).** The decision-complete
  [`docs/specs/calibration-research-artifacts.md`](./specs/calibration-research-artifacts.md) was
  authored, adversarially reviewed, revised, and accepted before any code. It settles package and
  import placement (subpath-only `./artifacts` adapters, core structural contracts), the
  fitted-model/calibration artifact grammar and sixteen families, FC3 research-run inputs and
  comparisons, Gate B save/restore/migration/replay at two levels, provenance and diagnostics
  preservation, bounded-work policy, direct-function parity, six ordered implementation slices,
  and exact exit evidence. All six slices landed (core contracts `d99391536`, warm starts and
  mappers `13b31f096`, `@totalfinance/volatility/artifacts` `1029515ff`,
  `@totalfinance/fixed-income/artifacts` `a655d0c01`, `@totalfinance/research/artifacts` `cebe2c046`,
  packed consumers / README snippets / cast-free read doors `795dd999f`); the completion record and
  the ticked exit gate live in the contract. Stage 4.6 stays behind the preview lane.
- make fitted models serializable, comparable, replayable, and diagnostics-preserving;
- add reproducible research-run artifacts and comparisons over FC3 screening, factors, event studies,
  and the existing statistical-hygiene functions; and
- keep every direct calibration, backtest, performance, and risk function independently callable.

#### Preview lane — local repairs complete; publication maintainer-held

The first public release is an explicitly pre-1.0 preview, not the stable-core declaration. Its
three original gates are recorded below. P1 and Stage 7A landed; Stage 5A slices 1–3 landed, while
publication remains held. Stages 4.6/4.7 subsequently landed ahead of publication; the September
repairs are locally verified complete. Release work still requires the maintainer's authorization
and the separate shipping gates.

1. **Preview P1 — options marking truthfulness (`COMPLETE @ db2df2451`, 2026-09-03).** Amended and implemented the
   [`options-backtest contract`](./specs/options-backtest.md) so current-contract implied volatility,
   missing/stale mark policy, assumptions, provenance, and direct-pricer parity are truthful. The
   function remains `optionsBacktest`; no versioned API fork or compatibility alias is created.
2. **Stage 7A — local operations and transports (`COMPLETE @ c7bdb260d` — contract [`local-operations-and-transports.md`](./specs/local-operations-and-transports.md) accepted 2026-09-03; all seven slices landed 2026-09-03: `@totalfinance/workflows` (the registry, the runtime, the twenty-four operations re-homed, ten journey operations, handles / stores / the worker-terminated job runner under `./local`), the `totalfinance` binary, `@totalfinance/http` with its generated OpenAPI document, the MCP preview gate, and transport parity proven across SDK / registry / CLI / HTTP / MCP plus the packed consumers; historical next row = Stage 5A).** Originally executed AT2 and the local/read-only part of AT3
   from the agent-platform spec, plus the local-MCP preview gate: one protocol-neutral operation
   registry, machine-first CLI, generated OpenAPI/local HTTP, and protocol-correct local MCP over the
   same public schemas and results. No provider, remote tenancy, portfolio mutation, proposal/order,
   or broker capability enters this slice.
3. **Stage 5A — preview integration and shipping (`MAINTAINER-HELD; LOCAL REPAIRS COMPLETE` — contract [`preview-integration-and-shipping.md`](./specs/preview-integration-and-shipping.md) accepted 2026-09-03; slices 1–3 landed @ 80650531d — every package to the metadata table, `STABILITY.md` shipped in all twenty-five, changesets in `preview` pre-mode, the preview-surface audit in CI, the community and security files, the rollback and release runbooks, `release:dry-run` hash manifest, the approval-gated `totalfinance-release.yml`, the registry smoke rehearsed against a local registry in CI; slice 4 (the publish) BLOCKED on the maintainer's Decision 8 — the public repository, npm scope rights, the `npm-publish` environment; Stage 7A closed @ c7bdb260d).** After maintainer authorization, run the relevant FC9 discovery, cold-user,
   semantic-parity, generated-evidence, and packed-consumer checks over the preview surface; finish
   public metadata/docs/CI/source maps/security/release automation; publish an explicitly pre-1.0
   fixed package group; and smoke the actual registry artifacts with rollback ownership in place.

Historically, P1 and Stage 7A could proceed in parallel after Stage 4.5; `optionsBacktest` entered
the operation registry only after P1. Both are complete, and Stage 4.6 added its flagship operations'
registry/CLI/OpenAPI/MCP adapters and parity in their own slices. Do not replay this prerequisite
sequence as new work.

The preview cutover does **not** itself certify FC8/FC9 or the stable API. Those stages have separate
historical completion records and the September repairs are locally verified complete. Preview
publication remains explicitly pre-1.0 and requires the maintainer's release decisions.

#### 4.6 Complete portfolio-scale and cross-asset backtesting

**`COMPLETE @ 839a955e7` — contract [`portfolio-scale-backtesting.md`](./specs/portfolio-scale-backtesting.md) accepted 2026-09-03; six slices landed in order (the shared contracts; `crossSectionalBacktest`; the grid, the run artifacts, `cross_sectional_run`; `optionsBacktest` over a position book; `portfolioBacktest` with the eight adapters; `portfolio_run`, the out-of-sample verbs, the property suites, the guide) and the exit gate ticked in the contract, one row held open by the maintainer's standing performance deferral. Begun and completed ahead of the Stage 5A publish by the maintainer's decision (2026-09-03); the publish slice is untouched. Historical next row: Stage 4.7, now also landed; the September review repairs are locally verified complete.**

- execute FC8 only after FC3, FC4, FC7, and the shared artifact/extension contracts are green;
- preserve the shipped `vectorized`, `eventDriven`, and `optionsBacktest` calls;
- add point-in-time cross-sectional/factor simulation, portfolio-grade options backtesting, multiple
  concurrent positions, portfolio cash/margin/risk, and ledger-backed cross-asset lifecycle handling;
- make execution reality explicit through fill, cost, slippage, latency, liquidity, borrow, margin,
  settlement, session, and ambiguity policies; and
- emit the same economic events FC7 reduces so backtest, replay, paper, and later live paths share
  accounting rather than merely similar-looking reports.

#### 4.7 Integrate and freeze the expanded core

**`COMPLETE @ 530eb6de8` — contract [`fc9-integration-and-core-freeze.md`](./specs/fc9-integration-and-core-freeze.md) accepted 2026-09-04; five slices landed in order (the three gates; the two remaining flagship operations; the end-to-end and levels guides with the generated field reference; `pnpm regen:check` and its hosted job; the FC0–FC9 sweep and the core-freeze gate) and the exit gate ticked in the contract. That was the original core-freeze sign-off; the September review repairs are now locally verified complete. Independently, two rows stay open by standing decisions — the performance budget (the maintainer's deferral of acceleration work) and the hosted matrix (GitHub Actions billing has kept every hosted run from starting since 2026-09-03). Next handoff: the Stage 5A publish (maintainer-held) and, behind it, Stage 5B.**

- execute FC9: umbrella/subpath discovery, executable cold-user journeys, workflow readiness,
  generated references, numerical evidence, semantic parity, and packed-consumer proof;
- run the full Phase 3A/3B and platform gates against the expanded surface at one exact commit; and
- close every FC0–FC9 checklist and exit gate before declaring the core frozen.

This is the one true final integration/freeze stage. Stage 5A's preview audit is deliberately rerun
over the expanded Stage 4.6 surface; it is not recorded as an earlier completion of Stage 4.7.

This stage is complete when the compute library has a coherent professional composition layer without
requiring a provider, network, credential, process-wide clock, database, MCP server, or UI.
Every public surface added in this stage must satisfy the Phase 3B runtime and field-level ratchets in
its first commit. Re-run the complete Phase 3B gate against the final platform surface before the
core freeze; do not create a second deferred semantic-audit backlog.

### 5. Phase 4 lovable shipping — preview and stable cutovers

Stage 5A is pulled into the preview lane after Stage 4.5, Preview P1, and Stage 7A. Stage 5B runs after
the Stage 4.7 stable-core freeze. Both cutovers require:

- canonical public repository and package metadata;
- hosted Node 22/24 CI and publish dry-runs;
- contributor-clean bundle-report generation across supported toolchains: retain exact byte budgets
  and structural gates while using either a canonical generation environment or a coarser stable
  displayed measurement so `pnpm artifacts:update` does not oscillate by platform;
- docs site, executable public examples, source-map verification, migration/release guidance;
- CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, governance, and support paths; and
- cold-user adoption tests against packed packages.

**Every-public-publish gate:** neither cutover closes at a successful dry-run. Before publishing:

- every release-blocking gate passes at one exact commit;
- the release version and fixed package group are selected explicitly;
- metadata, hosted CI, public docs/examples, source maps, provenance, dry-run hashes, changesets/
  release notes, and security/community files are complete;
- an authorized maintainer approves the exact artifacts;
- the package group publishes atomically with the matching Git tag and GitHub release;
- clean consumers install and smoke-test the actual public-registry artifacts; and
- rollback/yank ownership and response steps already exist.

The preview additionally requires a visibly pre-1.0 version, an explicit stability/experimental
surface statement, Preview P1, Stage 7A, and the Stage 5A launch-surface audit. The stable release
additionally requires every FC0–FC9/Stage 4.7 gate, complete expanded SDK/CLI/OpenAPI/MCP parity, final
release guidance, and explicit stable-version authorization. A preview registry smoke never
substitutes for the stable artifacts' own post-publish smoke.

Shipping work may reveal defects, but it may not casually redesign the settled core contracts. A
reproduced correctness or misuse-resistance failure returns to the alignment process.

### 6. Data and the first-party growth loop

Implement the provider/data contracts and first-party InsiderFinance path from
[`data-layer.md`](./data-layer.md) and
[`mcp-acceleration-data-growth-strategy.md`](./mcp-acceleration-data-growth-strategy.md): capability
discovery, normalized query results, provenance/quality/freshness, reference adapters, first-party
chains/flow/history, entitlement-aware errors, caching, and dataset handles.

Compute packages remain provider-free. Data enters through explicit edge packages and normalizes into
the already-frozen market/artifact contracts.

### 7. Agent workflows, transports, Apps, remote operation, and live state

Stage 7 is split by dependency rather than postponed as one block. **Stage 7A** is pulled forward
after Stage 4.5 and before preview; **Stage 7B** remains after the stable compute freeze and, where
required, Stage 6 data. The early slice is local, read-only, provider-free, and transport-focused.

The focused requirements and acceptance journeys in
[`agent-native-portfolio-and-trading-platform.md`](./agent-native-portfolio-and-trading-platform.md)
are part of this queue, not an independent someday-roadmap. Its `AT0`–`AT8` labels span several
global stages because agent readiness starts with durable financial truth rather than with a
transport. This crosswalk is controlling:

| Focused slice                                              | Global placement                           | Dependency decision                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AT0` contract/package ratification                        | Stage 4.0, before 4.4 implementation       | Install the ownership, versioning, and dependency direction settled by FC0 before durable portfolio types freeze.                         |
| `AT1` durable portfolio ledger                             | Stage 4.4                                  | Build the event-derived ledger, replay, and P&L reconciliation as compute-only platform foundations; do not defer them to the agent edge. |
| `AT2` operation registry and read-only workflows           | Stage 7A, before preview                   | Extract the protocol-neutral contract after Stage 4.5; expose only the then-green compute surface and extend it alongside later slices.   |
| `AT3` local artifacts/jobs, CLI, OpenAPI, and MCP adapters | Stage 7A, after `AT2`, before preview      | Reuse Stage 4 artifacts; add local durable jobs and transports without duplicating calculations or schemas.                               |
| `AT4` trading environment and Agent Bench                  | Stage 7B, after Stage 4.6 and `AT1`–`AT3`  | Evaluate agents over the complete deterministic ledger, simulator, operations, and artifacts users receive.                               |
| `AT5` proposal, policy, authorization, and paper execution | Stage 7B, after `AT4`                      | Paper execution and reconciliation close before any live-order edge is considered.                                                        |
| `AT6` connected data and live monitoring                   | Stage 6 foundations, then Stage 7B         | Provider/data contracts land first; monitoring remains a distinct capability from order placement.                                        |
| `AT7` Agent2Agent and hosted operation                     | Stage 7B, after durable jobs and artifacts | Adapt the shared operations; do not create Agent2Agent-only financial semantics.                                                          |
| `AT8` optional live broker adapters                        | Separately authorized after Stage 7B       | Not part of the default library/MCP release and never enabled without the complete venue-specific safety and operational gate.            |

Within Stage 7, preserve that dependency order even when independent adapters can be developed in
parallel:

- extract a protocol-neutral, effect-aware workflow registry before adding transport-specific state
  or write operations;
- preserve the curated local compute tools;
- add local market, book, scenario, result, and job handles before preview; dataset and
  entitlement-bearing handles wait for Stage 6/7B;
- add only the high-value chain, strategy, book, and research workflows;
- add machine-first CLI, generated OpenAPI/local HTTP, and local MCP in Stage 7A; attach MCP Apps to
  shared workflows later rather than creating UI-only duplicate tools; add Agent2Agent only after
  shared artifacts and durable jobs are stable;
- implement the seeded trading-agent environment, Agent Bench, and proposal/preflight/policy/paper
  lifecycle before considering a live broker adapter;
- add auth, tenancy, budgets, jobs, history, and entitlements before remote hosting; and
- add live incremental analytics only with a concrete consumer and record/replay parity.

#### 7B.1 Trading-agent environment and Agent Bench (`AT4`)

**`COMPLETE @ f7677ebcb` — contract [`trading-agent-environment.md`](./specs/trading-agent-environment.md)
accepted 2026-09-05; five slices landed in order (1 @ `83ee0c64d` the stepper seam and the environment core;
2 @ `35dd160e4` limits, the mask, the reward, features; 3 @ `5680655fa` the episode verb, the `environment`
run kind, the twenty-scenario library; 4 @ `2fe238e27` Agent Bench and the guide; 5 @ `f7677ebcb` the
`environment_episode` operation and the closeout); every exit-gate row ticked and the completion record
written.** `AT4` is the first dependency-ready row after the Stage 4.7
freeze that needs no provider, host, broker, or maintainer decision, so it executes while the Stage 5A
publish waits on the maintainer:

- drive `portfolioBacktest`'s own per-instant loop from outside through a stepper seam — one loop,
  two callers, byte-identical results for the existing verb;
- keep the next-observation law (an order decided on observation `k` meets the market at `k + 1`)
  and the no-leak observation contract as executable gates;
- declare the reward as a composition whose components are always returned separately and never
  change the accounting;
- maintain a seeded synthetic episode library with executable expectations, save/replay/compare
  episodes as run artifacts, and publish Agent Bench with operational conformance reported apart
  from strategy quality; and
- expose one declarative operation (`environment_episode`) across the five transports; stateful
  stepping over a transport, paper execution, and any live edge stay in `AT5`–`AT8`.

#### 7B.2 The safe trade lifecycle and paper execution (`AT5`)

**`COMPLETE @ 44cd9d72e` — contract [`trade-lifecycle-and-paper-execution.md`](./specs/trade-lifecycle-and-paper-execution.md)
accepted 2026-09-05; five slices landed (`b25e28573`, `f3ef2b2ce`, `834a11758`, `ac3e00885`, `44cd9d72e`): the artifacts, normalization, the policy, preflight · the grant, the journal, reconciliation · the paper broker over the engines' own fill path and the hazard suite · capabilities, stores, `tradePack`, the transports, parity, the packed consumer · the guide, the example, the agent-native amendment, the closeout.** `AT5` follows 7B.1 directly: it composes the environment's grammar, FC7's
ledger and monitor, and FC8's execution policy into the one lifecycle through which a decision may
become an order — on paper only; live adapters stay `AT8`:

- every stage is an explicit, content-addressed artifact and every write an explicit effect;
- preflight never upgrades missing information into an allow;
- authorization binds an exact plan hash, both snapshot hashes, an expiry, and a bounded key set;
- the paper broker fills through the declared execution policy and reaches the ledger through the
  same normalized fills the engines emit; every hazard the live boundary would face is proven here;
- the runtime gains explicit capabilities, and the trade operations refuse without them.

### 8. Measured acceleration and wider interop

- publish repeatable workload benchmarks first;
- use workers and transferable/Arrow data for large workloads;
- pilot fused scenario-map WASM and retain it only when cold and warm end-to-end results win;
- require scalar/facade/batch/worker/WASM parity; and
- build cross-language clients around stable schemas and artifacts in response to actual demand.

## Global stop conditions

Do not advance to the next row or cutover in the authoritative sequence while the current row has:

- an unchecked status item in its controlling spec;
- a raw crash, silent ignored field, non-finite successful result, or plausible wrong-number path
  introduced or touched by that stage;
- any known pre-existing defect without an explicit owner in the immediately following
  release-blocking gate (the current raw-kernel seed defects are owned by Phase 3B, and no release is
  allowed before that gate closes);
- a Stage 4 FC workstream begun before its declared dependencies or with an unchecked prerequisite
  contract from the core capability completion spec and tracker;
- Stage 4.4 or 4.6 implemented with a private ledger, P&L, event, fill, or accounting engine instead
  of the shared FC7 semantics;
- Preview P1 begun before Stage 4.5 closes, or a preview published before P1, Stage 7A, and Stage 5A
  close with executable evidence;
- `optionsBacktest` presented as production-ready while current market volatility can be silently
  replaced by entry volatility or the marking policy is absent from its result assumptions;
- a Stage 7A adapter that owns finance logic, changes a domain schema, permits writes/orders, depends
  on provider credentials, or lacks SDK/CLI/OpenAPI/MCP parity evidence;
- Stage 5B stable shipping begun while any FC0–FC9 checklist, workstream exit gate, or complete
  Stage 4.7 core-freeze item is unchecked;
- unresolved API-report, manifest, generated-doc, packed-consumer, or full-CI drift;
- a public publish attempted without its preview-or-stable release gate and post-publish registry
  smoke;
- a new package dependency cycle or an abstraction that fails the platform roadmap's five-question
  abstraction test; or
- prose claiming completion that is not backed by executable evidence.

Within a stage, independent tasks may run in parallel only when they do not settle the same public
types, package edges, or semantic vocabulary.
