# MCP and public documentation experience — implementation contract

**Status: IMPLEMENTED — LOCAL AUTOMATED GATES GREEN (2026-09-07).** Authorized after the September repairs at `94fb7f5f`.
This pre-publication experience slice does not reopen the completed core stages.
`implementation-order.md` remains the global queue.
Browser/host verification and actual publication remain explicitly separate below.

## Outcome

A cold developer or agent can discover the right capability, run a real calculation, understand its
assumptions and limits, and reproduce the result with the documented package version. Public learning
pages lead with tasks, not internal execution trackers. No new calculation implementation belongs in
a transport or website.

## Decisions

- Keep the 23-tool compute default and exact pack-selection law. Add useful task-oriented profiles
  without silently granting writes. Profile names and descriptions come from one registry.
- Prompts must only refer to tools actually available. Capabilities and doctor output must describe
  the effective configuration, including writable stores and required grants.
- Large catalogs support bounded discovery. Preserve schemas and machine-readable errors rather
  than hiding constraints to save context. Document every registered operation and explicitly mark
  SDK-only model families and callback-based APIs; do not imply universal MCP coverage.
- Reuse local worker jobs for heavy MCP execution, with explicit attachment, progress/cancellation,
  and a discoverable fetch-later path. No process-wide jobs, implicit authorization, or experimental
  wire-only financial contract.
- The public site lives under `totalfinance/site/`, outside the published package group. It is static-first,
  uses the existing TypeScript build ecosystem, and has browser-only interactive calculations. No
  authentication, live quotes, brokerage connection, API keys, database, or hosted computation.
- Visual direction: a precise developer workbench — ink/navy navigation, crisp white reading surfaces,
  cobalt interaction accents, generous readable type, and genuine financial charts. No decorative
  stock imagery or marketing wall before the calculators.
- Generate reference and search from package export maps, TypeScript declarations/JSDoc, existing
  contract/field inventories, stability files, and operation metadata. Do not maintain a second API
  catalog. Cover all supported entry points, including subpaths and type-only exports.
- All six task pages have a concrete first call. Playground inputs, displayed outputs, assumptions,
  diagnostics, and copied examples describe the same calculation. Sample data is conspicuously labeled.
- Show the actual package version and preview/stable status. Never imply unpublished packages have
  been released or invent a stable version. Release jobs validate the site's examples against the
  exact packed/published artifacts; local rehearsal is not registry-publish evidence.
- Public publication, npm rights, public repository, domain, and release approvals remain with the
  maintainer. The code and deployable site must be ready without them. WASM, data providers, remote
  hosted MCP, and live orders are outside this slice.

## Ordered tasks and acceptance

- [x] MCP discovery: profile-aware prompts; truthful capabilities/doctor; task profiles; bounded
      catalog discovery and tests for reduced profiles, malformed paging, grants, and unavailable tools.
- [x] Heavy MCP work: attach the existing job runner; prove submit/read/cancel, progress, no inline
      event-loop blocking on the job path, and parity with the direct operation result.
- [x] Agent documentation: generated full operation coverage, profiles, setup, handles, errors,
      permissions, paper/live boundaries, and SDK-only limitations; update both `llms` documents.
- [x] Task-first site: six routes for options, strategies, portfolio P&L, company valuation,
      backtesting, and connecting an agent; accessible responsive navigation, search, copy actions,
      honest empty/error/loading states, version labels, and no internal tracker in the learning path.
- [x] Complete reference: enumerate every public entry point mechanically; generate searchable
      signatures/types plus units, defaults, examples, warning/convention guidance, and stability.
      Links resolve and a gate fails when an export/entry point is missing.
- [x] Runnable playgrounds: option price/Greeks, strategy payoff, portfolio P&L, DCF sensitivity,
      backtest equity/drawdown, and scenario exploration, all delegating to package functions with
      reproducible sample inputs and copyable executable code.
- [x] Versioned evidence: package-version manifest, preview/stable routing without fabricated
      releases, packed-example execution, and post-publish smoke integration for released artifacts.
- [x] Validation and local automated closeout: focused regressions, typechecks, build, lint/format, generated-doc/API
      drift, full existing gates, site route/link/search tests, artifact hygiene, and explicit handoff.

## Evidence boundaries

Protocol/unit fixtures are not model-dependent tool-selection evaluations. A maintained natural-language
case set and scorer can ship without external model credentials, but no model pass rate may be claimed
without recorded real executions. Likewise, a locally verified deployable site is not a public release.
Interactive MCP-host Apps can reuse the same result views later; this slice's human UI is the public site.

The task-first interface, responsive styles, focus states, exact-value chart tables, and optional
page-scoped browser calculator tools are implemented. Browser access was declined during this slice:
real visual/mobile/keyboard review and supported-host WebMCP verification remain unperformed. Mock
browser-tool tests and static link/HTML tests do not substitute for those checks.

Complete reference means every supported export is discoverable, including type-only exports and
subpaths. Units/conventions and source annotations are displayed; an absent JSDoc default is labeled
“not declared,” never inferred. Source JSDoc examples may be excerpts. The complete playground examples
have installed-artifact execution evidence; this does not claim every source excerpt was executed.

## Initial local completion record (before integration)

Implementation delivered in the PR 303 worktree on top of `94fb7f5f`:

- MCP: nine task profiles, profile-grounded prompts, effective capability/doctor reporting, bounded
  signed discovery cursors, and opt-in worker jobs using the existing operation contracts. Default
  compute selection remains 23 tools; profiles never grant write authority.
- Job artifacts: terminal state handling, transitive report visibility, provenance ownership during
  persistence/cancellation, denial-wins shared ownership, and fail-closed orphan handling. The
  independent adversarial pass reproduced and verified the original completed and in-flight report
  visibility cases; 17 targeted visibility tests passed. Profiles are not a multi-tenant ACL.
- Public workbench: six task-first journeys, six SDK-powered playgrounds, payoff/equity/drawdown/
  sensitivity/scenario charts with exact-value tables, complete copied results, public guides,
  searchable reference, and a separate agent section. Generated coverage is 25 packages, 212 public
  entry points, 9,526 export paths, and 46 registered operations across 1,164 current/versioned routes.
- Release evidence: self-contained version snapshots, immutable historical archive restoration,
  strict public-registry receipt import, copied-example fingerprints, and retained release-workflow
  smoke receipts. No release is invented from a package version; the initial release ledger is empty.
- Agent evaluations: 110 maintained natural-language cases and a recording scorer with separate
  selection, argument validity, recovery, invented-data, and safety metrics. No live model run or
  resulting model-quality score is claimed.

Executed verification: 38 site tests passed; 52 packed-consumer tests passed, including all 12
default/edited copied playground examples in strict NodeNext and bundler modes against installed
tarballs and all 25 package README examples. Root/site typechecks, lint, format, build, and all 25 API
checks passed. All 12 ordered regeneration steps reproduced byte-identical files against the
uncommitted baseline. The clean-HEAD `regen:check` wrapper was not run because the requested changes
are not committed; its chain was executed without weakening or changing that wrapper.

The first full-coverage runs passed all 11,021 assertions and all coverage thresholds but exited 1
on a worker progress RPC timeout. Tracing tied it to the packed-consumer file retaining IPC replies
through its synchronous examples (34 seconds solo, 64 seconds under full coverage). An `afterEach`
event-loop yield preserves all tests/timeouts and reduced the observed longest acknowledgement wait
from 33.8 seconds to 6.7 seconds. The speculative declaration-sweep change was removed. The final normal
full-coverage rerun exited **0**: **527 files, 11,021 tests, no unhandled errors**, in 618.75 seconds.
Coverage: **93.99% statements, 83.35% branches, 96.82% functions, 94.55% lines**; all original thresholds
remain unchanged. Both independent enforcement generations matched. Temporary diagnostic
instrumentation was removed before that final run.

This is local Node 26.5 verification of the uncommitted PR 303 worktree based on `94fb7f5f`, not an
exact-commit hosted matrix, npm publication, deployed-site review, or a claimed model benchmark.
No commit/push/publication occurred during this implementation. The preview server and coding agents
were stopped; `site/dist` remains the generated, deployable local output and is not committed.

## PR integration record (2026-09-07)

- [x] Fetch PR 303 and preserve release refresh `b978b767` in full.
- [x] Commit the MCP/site implementation and replay it over that revision (`768393eb`); the
      integration is conflict-free, and the implementation now lives in shared Git history.
- [x] Align the release notes, public entry point, and implementation queue with the combined tree;
      retain the old rehearsal as historical evidence, not final-revision approval.
- [x] Run the combined CI gates: `pnpm run ci` exited 0 on the integrated implementation plus the
      handoff-document edits. All 527 library test files / 11,021 tests and all 38 site tests passed;
      root/site typechecks, lint, formatting, library/site builds, and all 25 API checks passed.
      Coverage remained 93.99% statements, 83.35% branches, 96.82% functions, and 94.55% lines,
      with no relaxed thresholds or unhandled errors. Local runtime: Node 26.5.
- [x] Refresh generated bundle measurements and the documentation inventory for the integrated tree.
      The upstream budget limits and rationales are unchanged; Node 26.5 gzip measurements are local
      observations, not evidence of a cross-toolchain size improvement.
- [x] `pnpm regen:check` exited 0 from clean commit `21d18adb`: all twelve ordered generation steps
      reproduced byte-identical files, with zero documentation findings and no changes to the tree.
      The post-integration documentation and bundle regression pass also passed all 140 tests.
      This completion-record update is documentation-only; it does not change the verified code.

The worktree directory is an execution location, not a separate project or a deployment. The source
paths are `totalfinance/site/`, `totalfinance/packages/mcp/`, and their shared tools. Checking out the integration
branch in another directory brings those sources with it; generated `site/dist/` is rebuilt locally.
The main application's unrelated working branch is unchanged. No package publication or deployment
is authorized by this integration.

### Explicit next handoff

Use `site/README.md` for build/preview, static hosting requirements, release-receipt import, and version
archive preservation. The maintainer requested additional pre-release work on 2026-09-07; take that
next scope before release. Complete the real browser/keyboard/mobile review and, where supported, the
WebMCP host check before deploying. Then return to the maintainer-held Stage 5A publication/Stage 5B
stable-cutover gates in `implementation-order.md`; do not restart completed core implementation.
Public repository/domain/branding, npm permissions, release approval, publication and deployment remain
maintainer-owned. Actual registry-release verification and real model evaluations require their real
external runs; local tarball tests and illustrative recordings cannot stand in for them.

## Launch-search amendment (2026-09-07)

The launch review found that natural queries buried calculations under supporting types, and
typing during the first index download started duplicate fetches. This bounded fix is authorized;
publication is not. The [preview launch queue](../implementation-order.md#preview-launch-queue-2026-09-07)
owns all remaining ordering. It does not reopen the core library phases.

Acceptance (local verification on the PR #303 worktree based on `92bfbe4d`):

- [x] Match spaced, camelCase, case-insensitive and punctuation-separated names, including
      `black scholes` / `Black–Scholes` and `portfolio P&L` / `portfolioPnl`.
- [x] Exact function **and type** names lead; task queries lead to runnable tasks. At comparable
      relevance, callable APIs precede supporting types. Use declaration-generated kinds, not a
      curated export ranking table. Keep exact package/import searches and distinct aliases.
- [x] Regression-test the real generated index: the Black–Scholes facade first, `blackScholesPrice`
      in the first five results for `black scholes`, `portfolioPnl` first for `portfolio P&L`,
      and all six task queries leading to their task/agent page. Exact type lookup stays first;
      `DCF` leads to `discountedCashFlow`. Every declared package import leads to its own entry page.
- [x] At the step-2 #336 integration (`fc46353b`, 2026-09-08), verify
      `sector performance` → `sectorPerformance` first on the combined generated index.
      The post-merge closeout makes this assertion unconditional: removal of the export is a
      failure, not a skipped assertion. All 63 site tests pass on the integrated source.
- [x] One lazy fetch and JSON parse shared across concurrent queries, successful result cached,
      network/HTTP/JSON or malformed-record failure retried on the next user action. No retry storm.
- [x] A new input invalidates pending results immediately, including within the debounce window;
      clearing search cannot be overwritten by late success/failure. Submit cancels a pending
      debounce. Preserve version-pinned index URLs, empty results, escaping and older indexes.
- [x] Site build, typecheck, lint, tests, link/coverage checks and existing size budgets pass.

Evidence: **63 site tests** (including 13 ranking cases, 12 mocked-client cases and full-index/import
checks), **85 focused docs/generated-docs/preview-audit tests**, root/site typechecks and changed-file
lint/format pass. Build: 1,169 routes, 9,647 export paths, 46 operations; search index: 7,464 records,
448,529 gzip bytes (budget 600,000), client: 9,795 bytes (budget 40,000). `blackScholesPrice` moved
from twentieth to fourth for `black scholes`; the exact facade occupies first place. No budget or
test threshold was relaxed. Package sources, versions and dependencies are unchanged.

Integration evidence (2026-09-08): `fc46353b` preserves this search implementation and adds #336's
sector surface. Full CI passes 11,897 library tests and 63 site tests; all twelve regeneration
steps are byte-stable. The integrated build has 1,174 routes and 9,731 export paths. Hosted checks
remain a separate release prerequisite. The introductory-example review requested afterward was
still open at integration; the following amendment records its subsequent completion.

These are algorithm, mocked-client and generated-artifact checks, not visual/browser signoff. No
new search service, tracking, dependencies, package exports, or public compute behavior is needed.

## First-call examples amendment (2026-09-08)

The maintainer requested clearer documentation after chart/sample generation obscured otherwise
small calls. This is a presentation repair, not evidence that every public return contract needs
redesign. Preserve scalar answers, named reports, ordinary arrays and intentional expert typed buffers.

- [x] Each calculator leads its code section with explicit sample inputs, the useful library call,
      and its actual output. Explain any selected report fields; do not portray chart coordinates
      or website wrappers as the library's return type.
- [x] Separate complete playground reproduction in an expandable, independently copyable section.
      Small datasets use literal values. Large backtest inputs have a labeled synthetic-data preview
      and complete inspectable/copyable setup; neither a feed nor market history is implied.
- [x] Keep first-call and full-playground examples synchronized with successful input changes,
      including the browser-tool path. Failed calculations retain the last successful examples.
- [x] Execute both copy surfaces at default and edited inputs against installed artifacts, including
      strict consumer typechecks and the release fingerprint. No hidden imports or skipped examples.
- [x] Explain return shapes and the distinction between sample generation, chart mapping and actual
      result conversion in the public start/levels guides. Preserve advanced batch documentation.
- [x] Pass focused example/client/render/release regressions, typechecks, formatting, lint and the
      complete site build/link/size gates. Browser signoff and publication remain separate.

Local evidence on the PR #303 worktree based on `7280f1f5`: 79 site tests; 58 packed-consumer
tests (including all 24 exact default/edited first-call/full copies under strict NodeNext and
bundler resolution); seven runnable-guide tests; and 85 documentation/generated-doc/preview-audit
tests pass. The new first-call surface participates in release fingerprints, and negative tests
reject its invalid TypeScript or incorrect displayed result. Root/site typechecks, lint, formatting
and the site build/link/size gates pass. The documentation inventory remains byte-identical with
zero findings. No package source, public API, package version or dependency changes are needed.

The first-call section explains selected report fields and smaller scenario grids explicitly.
Backtest and ledger setup are complete literal, inspectable inputs included in the combined copy;
the full reproduction retains the compact deterministic generators. A scan of public start guides,
task content, package READMEs and guide examples found no remaining `Array.from` sample generators
outside those expanded playground reproductions. Intentional expert buffers remain documented.
This is not a blanket certification of every public output's ergonomics, a full-library CI rerun,
browser/host certification, or publication evidence. Existing launch gates remain.
