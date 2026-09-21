# FC9 integration and the core freeze — the Stage 4.7 contract

**Status: `CURRENT` — authored 2026-09-04 from the FC9 rows of
[`finance-portfolio-backtesting-completeness.md`](./finance-portfolio-backtesting-completeness.md)
and §4.7 of [`implementation-order.md`](../implementation-order.md); accepted 2026-09-04 after the
review record below; slices land in the order listed.**

This is the one true integration-and-freeze stage of the platform programme. Everything the
programme built — FC0–FC8, Gates 4.1–4.6, the Phase 3B ratchets, the preview transports — is
re-proven here over the EXPANDED surface at one exact commit, and the rows the earlier stages left
open by design (the end-to-end journey, the documentation levels, the remaining workflow
operations, the evidence matrix, clean-repository generation) are closed with executable evidence.
When this contract's exit gate is ticked the core is frozen in fact; the stable label itself advances
in Stage 5B, not here.

## Outcome

A cold TypeScript developer, with nothing but the packed tarballs and this repository's docs, can:

1. discover every domain as an umbrella namespace or a scoped subpath, read one runnable example
   per package, and follow ONE runnable journey that crosses fundamentals → valuation → screen /
   factor → portfolio → backtest → performance without a provider, a network, a credential, a
   clock, a database, an MCP server, or a UI;
2. choose the level that fits — raw primitives, the facade with `.explain()`, the analysis reports,
   the artifacts, the batch runners, the workflow operations — from a guide that never presents the
   highest abstraction as the only route;
3. run the five flagship workflow operations the completeness spec names (company valuation,
   universe research, event study, portfolio analysis / rebalance proposal, backtest run) on the
   SDK, the registry, the CLI, the HTTP server, and the MCP adapter with the same schema, result,
   and teaching errors;
4. read a generated field reference — every public field with its kind, optionality, and the unit
   its name carries — beside the API reports, READMEs, formula references, `llms.txt`, and the
   manifest, all regenerated from source-controlled declarations by one command whose output is
   byte-stable from a clean checkout;
5. trust the numbers: an evidence matrix names the golden corpus, the property/metamorphic suite,
   the differential (composition-versus-primitive) test, and the mutation harness behind every
   workstream's listed identity, and a gate proves no compute package reaches for a clock, the
   environment, the network, or the filesystem;
6. see every FC0–FC9 checklist row and every workstream exit gate closed with the test that closes
   it, and the "one exact commit" evidence — local CI, the packed-tarball consumers, the bundle
   budgets, clean-repository generation — recorded at that commit, with the hosted matrix's status
   stated truthfully.

## Non-goals

- **No new compute.** This stage composes, documents, measures, and proves; it adds no formula. A
  gap that turns out to need new quant math is recorded as a follow-up row, never patched here.
- **No stable label.** Stage 5B advances `STABILITY.md`; this contract records readiness.
- **No acceleration.** The performance-budget row of FC8 stays open by the maintainer's
  standing deferral (TotalFinance §1.4): bundle budgets are measured at every commit; runtime budgets,
  WASM/SIMD, Arrow paths ship with that deferred work.
- **No data adapters, connected agents, paper/live edges** (separately gated per the roadmap).
- **No second engine, second schema, or second registry.** Every new operation composes a public
  verb verbatim; every generated document reads the committed declarations.
- **No hosted-CI workaround.** The hosted matrix row closes when the organization's GitHub Actions
  billing is restored and the workflow runs; this contract does not substitute a local run for it.

## Decision 1 — package placement and dependency edges

No new package. New operations live in `@totalfinance/workflows` (`operations-journey.ts`), new
guides and examples under `docs/guides` and `docs/examples`, new generators and gates under
`tools/`. The dependency graph is unchanged: `@totalfinance/workflows` already depends on
`@totalfinance/valuation`, `@totalfinance/fundamentals`, and `@totalfinance/portfolio`; the end-to-end journey
imports packages the way a consumer does (scoped subpaths, never relative paths).

## Decision 2 — the end-to-end journey is one runnable file and one guide

`docs/examples/end-to-end-journey.test.ts` runs, in order and on committed fixtures:
`analyzeFundamentals` over typed statements → `discountedCashFlowFromStatements` → a
`scoreUniverse` / `screenUniverse` step whose observations carry the valuation outputs as declared
fields → `proposePortfolioRebalance` over a ledger built from the screen → `crossSectionalBacktest`
over the same universe → `analyze` of the backtest's equity. Each step's output feeds the next
through the public types only; every step asserts a reconciliation the primitives already prove
(the DCF equals the direct `discountedCashFlow` of the projected flows; the backtest's final value
equals its ledger's NAV; the performance summary equals `analyze` of the returns). The journey is
deterministic (no seed, no clock) and stays under the five-minute journey's step budget. The guide
`docs/guides/end-to-end.md` is the same journey in prose with its ```ts blocks executed by
`docs/examples/guides.test.ts`.

## Decision 3 — the levels guide

`docs/guides/levels.md` documents the six levels with one runnable snippet each, all over the
same instrument so the reader sees the same number move up the stack: **raw** (a `@totalfinance/math`
or `@totalfinance/core` primitive), **facade** (a domain verb and its `.explain()` companion), **analysis**
(a report verb with `assumptions` and `diagnostics`), **artifact** (an `./artifacts` subpath: save,
restore, replay), **batch** (a grid or batch runner), **workflow** (an operation through the registry).
The guide states the rule the FC9 row demands — no guide presents the highest abstraction as the
only route — and `docs/README.md` indexes it under "Start here". `docs/examples/guides.test.ts`
executes it.

## Decision 4 — the generated field reference

`tools/fields-doc.ts` generates `docs/reference/fields.md` from `tools/manifest/public-contracts.json`:
for every public callable, every declared field with its kind (numeric / string / boolean / enum
with its literal domain / object / array / callback), optional and nullable flags, and the UNIT
its name carries under the naming law (the `…TimestampMs`, `…Ms`, `…Years`, `…Days`, `…Sessions`,
`…PerUnit`, `…Rate`, `…Fraction`, `…Weight`, `…Bps`, `…Percent`, and currency-amount suffix
conventions recorded in `tools/manifest/naming-policy.ts`), grouped by package and entrypoint. It
is a generated file with the same law as `docs/bundle-size.md`: `tools/fields-doc.test.ts` fails when
the committed document drifts from the declarations, and `pnpm docs:update` regenerates it. No unit
metadata is invented: a field whose name carries no unit suffix is listed as "unitless by name"; the
suffix table is the naming policy's, cited by rule id. The formula references remain the authored
`docs/formulas/*` documents (the options family today) plus the manifest notes; this decision
closes the field/unit half of the FC9 row and states the formula half as authored, not generated.

## Decision 5 — the two remaining flagship operations

Five flagship operations are named by the completeness spec. Three exist (universe research:
`totalfinance.research.screen` / `rank` / `score`; event study: `totalfinance.research.event_study`;
backtest run: the four `totalfinance.backtest.*_run`), one is half there (`totalfinance.portfolio.analyze`
carries the snapshot, the timeline, and the monitor but not the rebalance proposal), and one is
missing (company valuation). This stage adds exactly two operations, both read-only, both thin:

- **`totalfinance.valuation.company`** in a new opt-in journey pack `valuationPack()` — the input is
  `discountedCashFlowFromStatements`'s own request (typed statements, the projection assumptions,
  the valuation conventions with the REQUIRED explicit discount rate — the FC0 defaults table says
  a DCF convention is never defaulted) plus an optional `sensitivity` (the
  `discountedCashFlowSensitivityTable` axes); the result is the verb's result verbatim, with the
  sensitivity table beside it when requested. Cost class `medium`; no handle fields; no seed.
- **`totalfinance.portfolio.rebalance_proposal`** in the existing `portfolioPack()` — the input is
  `proposePortfolioRebalance`'s request over a ledger SNAPSHOT (a handle field, like
  `portfolio.analyze`) and a market snapshot; the result is the proposal verbatim. It is a proposal,
  not a write: `sideEffect: 'none'` like every operation, and the read-only default set is unchanged
  (the journey packs stay opt-in).

Both join the registry test's id lists, the count pins (registry/CLI/HTTP 37 → 39, MCP 27 → 29 when
the pack is expanded), the transport-parity fixtures (one valid, one malformed each), the guides, the
manifest `mcpTools` on their verbs, the OpenAPI document, and the packed-consumer CLI/HTTP journeys.
`journeyPacks()` becomes five packs.

## Decision 6 — the evidence matrix is a gate, not a table in prose

`tools/evidence-matrix.test.ts` reads the completeness spec's FC1–FC8 checklists and, for every
ticked row whose CLOSED sentence names a test (the `CLOSED <date>: <test>` convention every
workstream used), asserts that the named test file or test title exists in the repository. It then
asserts the four evidence CLASSES the FC9 row demands, each by a named, existing test: **golden
corpora** for FC1–FC6 (the evidence plan's per-domain corpora, one fixture suite per domain,
citations in the fixture comments), **property / metamorphic** suites (one per workstream:
scaling, parity, reconciliation, permutation, no-look-ahead), **differential** tests (the
composition equals its primitives: DCF-from-statements versus `discountedCashFlow`, the engines
versus their ledgers, the grid versus direct runs, the operations versus the SDK), and **mutation**
harnesses (the enforcement mutations for signs / units / dates / types / null, the count-safety
sweep, the hardening waves). A class with no named test fails the gate. This is the executable form
of rows 1443–1447; nothing is claimed by prose.

## Decision 7 — no side effects, as a source scan

`tools/no-side-effects.test.ts` scans every compute package's `src` (every package except the
transports `cli`, `http`, `mcp`, `workflows`' local stores) for `Date.now(`, `new Date()` without
an argument, `process.env`, `process.hrtime`, `performance.now(`, `fetch(`, `XMLHttpRequest`,
`require('node:fs')` / `from 'node:fs'`, `node:child_process`, `node:net`, `node:http(s)`, and
`Math.random(` outside the seeded-generator module. Every hit must be on a frozen allowlist with a
reason (today's expected members: the core time module's teaching string that names the clock, a
docs example string in the volatility package). The list is shrink-only.

## Decision 8 — deferred exceptions are zero, as a gate

`tools/deferred-exceptions.test.ts` asserts, in one place: no `it.skip` / `it.todo` / `test.skip` /
`describe.skip` / `.only` in any test; the count-safety pending-harvest map empty; the legacy
unregistered-codes list empty; the naming queue's unresolved count zero (read from
`public-naming.json`); enforcement `defective` zero and every unmeasured row carrying a reason
(read from `public-enforcement.json`); the declared-coverage residual list and the union-parity
allowlists carrying a dated reason on every entry (a source scan of the comment above each block).
The allowlists themselves are measured facts with reasons, not deferrals; this gate makes the
distinction executable and closes the "zero deferred exceptions" clause of row 1449.

## Decision 9 — clean-repository generation is a CI step

`pnpm regen:check` runs the whole regeneration chain (`signature:update` → `naming:update` →
`contract:update` → `enforcement:update` → `validation:update` → `api:update` → the README and
`llms.txt` generators → `bundle:update` → `openapi:update` → `docs:update` → the field reference)
and fails when `git status --porcelain` is non-empty afterwards. It joins the hosted workflow as a
job beside the matrix and the release rehearsal, and the exit gate quotes its local run at the
closeout commit. The chain's ordering law (contract before validation; api before the README and
`llms.txt` generators) is the script's, not the operator's memory.

## Decision 10 — the hosted matrix is a maintainer-held row, stated truthfully

Since 2026-09-03 every hosted "TotalFinance CI" run on this branch has failed in two seconds with
"the job was not started because recent account payments have failed or your spending limit needs
to be increased" — GitHub Actions billing on the organization, not code. The last hosted run that
executed was green at `f42dfee97`. This contract's exit gate carries the hosted-matrix row OPEN
with that sentence until billing is restored and the workflow runs green at the closeout commit
(or a later commit whose diff to the closeout commit is docs-only); nothing else in the stage waits
on it, and no local run is recorded as the hosted one.

## Decision 11 — the FC0–FC9 sweep and the core-freeze gate

The closeout slice walks every `- [ ]` row of the completeness spec and every workstream exit
gate: each is ticked with the test and commit that close it, or left open with the standing
decision that holds it (today: the performance-budget row, the hosted matrix). The
"Complete core-freeze gate" rows are then ticked one by one with evidence: the checklists (the
sweep), the direct APIs public / tested / documented (the API reports, the packed README
journeys, the roster gate), the cold TypeScript developer (the end-to-end journey and the
per-package journeys), the JavaScript caller's teaching errors (enforcement `defective 0`, the
misuse journeys of the packed consumer), inspectable conventions (the assumptions gates), exact
reconciliation (the differential class of the evidence matrix), immutable / versioned /
serializable / replayable / provenance-preserving results (the artifact spine gates), one source
of truth (the ledger law and the fill-shape gate), no side effects (Decision 7), and a manifest with
no unresolved debt (Decision 8). The trackers move Stage 4.7 to `COMPLETE @ <commit>` with the
hosted-matrix row named as the single maintainer-held item; Stage 5B stays behind it and the
Stage 5A publish.

## Decision 12 — determinism, immutability, provenance

Unchanged laws: no operation, generator, or gate reads a clock or the network; every generated
document is byte-stable from a clean checkout; every result the new operations return is the
verb's own immutable, serializable result with its `assumptions` and `diagnostics`; provenance is
the caller's, never fetched.

## Ordered implementation slices

1. **The gates first** — `tools/deferred-exceptions.test.ts`, `tools/no-side-effects.test.ts`,
   `tools/evidence-matrix.test.ts` (Decisions 6–8), each green at landing or naming exactly what
   it found; the FC9 rows they close are ticked in the tracker with the gate's name.
2. **Workflow readiness** — `totalfinance.valuation.company` (`valuationPack()`) and
   `totalfinance.portfolio.rebalance_proposal` on all five surfaces with parity, counts, guides,
   manifest, OpenAPI, and the packed-consumer journeys (Decision 5).
3. **Documentation** — the end-to-end journey and its guide (Decision 2), the levels guide
   (Decision 3), the generated field reference with its generator and gate (Decision 4), the README
   index, `llms.txt`.
4. **Clean-repository generation and the hosted workflow** — `pnpm regen:check`, its CI job, and the
   "one exact commit" evidence recorded locally (Decisions 9–10).
5. **Closeout** — the FC0–FC9 sweep, the core-freeze gate, the trackers, the completion record
   (Decision 11).

Every slice lands with the full regeneration chain, the tools gates, `pnpm run ci` and
`pnpm api:check` green, a second all-green pass, a slice record in this document, and the trackers
moved; the packed consumers run at every slice that touches a package.

## Acceptance and exit gate

The FC9 rows of the completeness spec, verbatim, each closed by a named test at a named commit:

- [x] Add symmetric `fundamentals`, `valuation`, `research`, `foreignExchange`, `commodities`, and
      `portfolio` namespaces to the umbrella without wildcard root hoists —
      `tools/preview-surface-audit.test.ts` "FC9 row 1 — discovery" @ `530eb6de8`.
- [x] Provide one executable cold-user journey per package and one end-to-end journey across
      fundamentals → valuation → screen/factor → portfolio → backtest → performance — the packed
      README journeys (`tools/packed-consumer.test.ts`, one per package) and
      `docs/examples/end-to-end-journey.test.ts` @ `00980d725`.
- [x] Generate API reports, package READMEs, formula references, field/unit tables, `llms.txt`, and
      manifest discovery from source-controlled declarations — the API reports (`api:check`), the
      READMEs (`readme-gen.test.ts`), `llms.txt` (`llms-docs.test.ts`), the manifest (the tools
      gates), and the field reference (`fields-doc.test.ts`) @ `00980d725`; the formula references are
      the authored `docs/formulas/*` (Decision 4).
- [x] Document raw, facade, analysis, artifact, batch, and workflow levels; no guide presents the
      highest abstraction as the only route — `docs/guides/levels.md`, executed by `guides.test.ts` @ `00980d725`.
- [x] Add workflow operations only after that registry exists: company valuation, universe
      research, event study, portfolio analysis/rebalance proposal, and backtest run —
      `totalfinance.valuation.company` and `totalfinance.portfolio.rebalance_proposal` @ `c4aa2b2cd` beside the
      research, portfolio, and backtest operations of Stage 7A and Stage 4.6.
- [x] Every operation uses the same public SDK schema/result and carries effect classification,
      budgets, seed policy, handles, assumptions, diagnostics, provenance, and artifact identity —
      `packages/workflows/test/registry.test.ts`, `runtime.test.ts`, `journey.test.ts` (Stage 7A) @ `530eb6de8`.
- [x] Read-only defaults exclude portfolio writes and all broker orders — every operation is
      `sideEffect: 'none'` (`registry.test.ts`, `journey.test.ts`); the rebalance proposal is a proposal @ `530eb6de8`.
- [x] SDK/MCP/CLI/OpenAPI parity fixtures compare normalized outputs and teaching errors —
      `tools/transport-parity.test.ts` over every operation @ `530eb6de8`.
- [x] Every Stage 4.6 flagship operation joins those transports through a separate adapter/parity
      slice as it lands, and Stage 4.7 reruns the complete expanded-surface matrix — the Stage 4.6
      records; the whole `tools/` suite and the transport suites at `530eb6de8`.
- [x] Independent golden corpora cover FC1–FC6; literature/source citations and formula variants are
      versioned — `tools/evidence-matrix.test.ts` "golden corpora cover FC1–FC6" @ `926404166`.
- [x] Property/metamorphic suites cover identities listed in every workstream — `tools/evidence-matrix.test.ts` "a property / metamorphic suite is named for every workstream" @ `926404166`.
- [x] Differential tests compare direct primitives with composed analyses and workflows — `tools/evidence-matrix.test.ts` "differential tests" @ `926404166`.
- [x] Mutation tests target signs, units, dates, cash-flow timing, root selection, terminal basis,
      statement periods, point-in-time availability, quote direction, and portfolio accounting —
      `tools/evidence-matrix.test.ts` "mutation harnesses" @ `926404166`.
- [x] Full Phase 3A/3B naming/signature/runtime/field/result gates rerun against the expanded surface
      with zero deferred exceptions — the `tools/` suite and `tools/deferred-exceptions.test.ts` @ `530eb6de8`.
- [ ] Full local CI, hosted matrix, packed-tarball consumers, bundle budgets, and clean-repository
      generation are green at one exact commit — local CI, the packed consumers, the budgets, and
      `pnpm regen:check` green @ `530eb6de8`; the hosted matrix OPEN — every hosted "TotalFinance CI" run since 2026-09-03 has failed to start on the organization's GitHub Actions billing ("recent account payments have failed or your spending limit needs to be increased"); the last hosted run that executed was green at `f42dfee97`. The job definitions (the matrix, the release rehearsal, clean-repository generation) are committed; the row closes when billing is restored and the workflow runs green at this commit or a docs-only successor.

Contract-specific rows:

- [x] `docs/examples/end-to-end-journey.test.ts` runs the six-step journey on committed fixtures with
      a reconciliation assertion at every step, and `docs/guides/end-to-end.md` executes (Decision 2) @ `00980d725`.
- [x] `docs/guides/levels.md` shows the six levels over one instrument and executes (Decision 3) @ `00980d725`.
- [x] `docs/reference/fields.md` is generated, gated, and byte-stable (Decision 4) — `tools/fields-doc.test.ts` @ `00980d725`.
- [x] `totalfinance.valuation.company` and `totalfinance.portfolio.rebalance_proposal` pass transport parity
      on all five surfaces and the packed-consumer cases; the read-only default set is unchanged
      (Decision 5) — `tools/transport-parity.test.ts`, the journey suite @ `c4aa2b2cd`.
- [x] `tools/evidence-matrix.test.ts`, `tools/no-side-effects.test.ts`, and
      `tools/deferred-exceptions.test.ts` are green with shrink-only allowlists (Decisions 6–8) @ `926404166`.
- [x] `pnpm regen:check` is green locally at the closeout commit and is a job of the hosted workflow
      (Decision 9) — the script and the job @ `530eb6de8`; the closeout quotes the local run.
- [x] The completeness spec's core-freeze gate is ticked row by row with evidence; the only open rows
      are the performance-budget row (the maintainer's standing deferral) and the hosted matrix
      (Decision 10), each stating what holds it @ `530eb6de8`.

## Review record (self-review against the laws, 2026-09-04)

- **No second engine** — the two operations call `discountedCashFlowFromStatements`,
  `discountedCashFlowSensitivityTable`, and `proposePortfolioRebalance` verbatim; the journey and the
  guides call public verbs only; the generators read committed declarations.
- **One obvious first call** — the levels guide starts at the facade, not the registry; the end-to-end
  guide's first block is `analyzeFundamentals` over a typed statement.
- **Direct APIs preserved** — nothing is renamed or removed; the operations add surface only.
- **Every bound traced to its cause** — the count pins, the budgets, and the allowlists each carry a
  dated reason; the hosted-matrix row carries the billing sentence rather than a tick.
- **Nothing claimed by prose** — every FC9 row is closed by a gate or a test named in this document;
  the field reference states "unitless by name" rather than inventing units.
- **Truthful status** — the stage cannot declare the core frozen while the hosted matrix has not run;
  the completion record will say so in those words.

## Slice records

### Slice 1 (landed 2026-09-04, `926404166`) — the gates

**What landed.** Three gates under `tools/`, each reading committed artifacts and sources rather
than prose: `no-side-effects.test.ts` (Decision 7) scans every compute package's `src` for the
process clock, the environment, the network, the filesystem / child processes / worker threads,
and unseeded randomness — fifteen hits, every one on a shrink-only allowlist with its reason
(two teaching strings that name the clock, the declared local layer of the workflows package, the
runtime's injectable deadline clock); `deferred-exceptions.test.ts` (Decision 8) asserts no skipped,
todo, or focused test, an empty pending-harvest map, an empty legacy-codes list, zero unresolved
naming identities, zero defective enforcement rows with a reason on every unmeasured row and
alternative, and a reason on every entry of the other gates' allowlists (the 775 declared-coverage
residuals under dated comments, the 47 undescribed-parameter tuples, the generic routes, the
side-effect routes); `evidence-matrix.test.ts` (Decision 6) asserts every test path a `CLOSED`
sentence of the tracker cites still exists and names the four evidence classes by file and token —
golden corpora for FC1–FC6 with the citation each evidence plan names, a property / metamorphic
suite per workstream FC1–FC8, seven differential tests (a composition against its primitives),
and six mutation harnesses.

**Decisions at landing.**

1. **Allowlists are facts with reasons, not deferrals** — the gate distinguishes them by checking
   the reason, never by counting entries; a count floor exists only so a gate cannot pass vacuously.
2. **The evidence classes are named by file AND token** — a file cited as a golden corpus must carry
   its citation word; a differential test must name the primitive it compares against; a mutation
   harness must name the mutation. A rename or a rewrite that drops the class fails here.
3. **The backtest "hardening wave" is a fill-rule suite, not a mutation harness** — the matrix cites
   the first-touch garbage and finite-results sweeps for the non-finite class instead.

**Evidence.** `tools/no-side-effects.test.ts` (five tests), `tools/deferred-exceptions.test.ts`
(six), `tools/evidence-matrix.test.ts` (five); `pnpm run ci`: 489 test files, 10,375 tests green; `pnpm api:check` exit 0; the three gates and the
union-parity gate together 54 tests green; enforcement unchanged at 5,244 candidates (2,412
enforced · 0 defective · 182 unmeasured, every one with a reason).

**Gate findings at landing.** Four iterations before green, each a gate teaching its author: the pending-harvest map keeps a
comment that explains its last harvest, so "empty" means no ENTRY, not no text; the undescribed
allowlist holds 47 tuples (an earlier count read every quoted line as an entry — the gate now
parses tuples and asserts every one parsed); the first five generic routes carried their reason
only in the declaration's leading paragraph — they now carry it in the block too, so the rule
"every entry under a reason" holds without a special case; the side-effect reasons contain
backticks and apostrophes, so the reason regex now matches to the closing quote of the same kind.
The backtest "hardening wave" suite turned out to be a stop / stop-limit fill grid, not a non-finite
mutation harness, and the matrix cites the first-touch garbage and finite-results sweeps instead
(Decision 3 above).

### Slice 2 (landed 2026-09-04, `c4aa2b2cd`) — the two remaining flagship operations

**What landed.** `totalfinance.valuation.company` in the new opt-in `valuationPack()`: the wire form of
`discountedCashFlowFromStatements`'s request — the typed three statements with their
`FundamentalPeriod`s, the explicit projection drivers (amount or growth / fraction-of-revenue
drivers, margins, tax, interest, borrowing, dividends), and the valuation conventions (basis, date,
currency, the REQUIRED discount rate, compounding as the six names or the periodic object, day
count, the terminal value method, the enterprise-to-equity bridge, diluted shares, provenance) —
plus an optional `sensitivity` whose table discounts the SAME projected flows the composition
used, rebuilt as the acceptance law rebuilds them. `totalfinance.portfolio.rebalance_proposal` in
`portfolioPack()`: a ledger snapshot (a handle field), the valuation instant, a market snapshot,
the policy, the scope, an optional external flow, and the sizing inputs; the result is
`proposePortfolioRebalance` over the folded ledger's state, verbatim. Both are `sideEffect: 'none'`
and opt-in; the read-only default set is unchanged. Parity fixtures (a valid input and a malformed
twin each: a missing discount rate → `input.missing_field`, a foreign scope → `input.invalid_enum`),
the journey id list (twelve operations in five packs), the count pins (39 on the full profile), the
MCP guide, `mcpTools` on the three verbs the operations compose, the OpenAPI document, and the
journey suite's direct-call parity tests.

**Decisions at landing.**

1. **The sensitivity table's flows are rebuilt from the projection, not read from the valuation** —
   the result carries no projected-flow schedule of its own, and the acceptance law's construction
   (period index + 1 years, the basis's free cash flow) is the only one that provably discounts the
   same numbers.
2. **The summary names the basis's headline** — enterprise value for a firm valuation, equity value
   for an equity valuation; the structured result is the verb's discriminated union verbatim.
3. **Decision 1 amended: `@totalfinance/workflows` gains the `@totalfinance/valuation` edge** — the contract
   assumed the edge existed; it did not (the registry composed research, portfolio, and backtest
   verbs but no valuation verb). The edge runs downward (L5 → L3), is declared in the package-graph
   gate's matrix, and carries the valuation package into the workflows bundle, measured.
4. **Numeric enumerations on the wire are literal unions** (`fiscalQuarter`, `monetaryScale`): the
   wire grammar's `enum` is string-only by design, and a literal union carries the same domain.

**Evidence.** `packages/workflows/test/journey.test.ts` (the five packs and twelve journey operations; the
rebalance proposal equals `proposePortfolioRebalance` over the folded ledger; the company
valuation equals `discountedCashFlowFromStatements` with the sensitivity table over the same flows
and a null table when none is requested), the transport suites (workflows, MCP, HTTP, CLI, parity,
the doc-conformance gates — 217 tests), the packed-consumer journeys. `pnpm run ci`: 489 test
files, 10,382 tests green; `pnpm api:check` exit 0; enforcement 5,244 candidates (2,412 enforced ·
0 defective · 182 unmeasured); the tools gates 58 files, 3101 tests green after the findings below;
`@totalfinance/workflows` 405 → 415 KB (420,525 B).

**Gate findings at landing.** The apply script's malformed-fixture anchor did not match the committed text (the
`portfolio.analyze` malformed twin is a one-line `wire(...)`, not a block), so the remaining steps
ran from a second script against the real anchor; `OperationPack` carries no `description` (the
pack is `{ name, operations }`); `SensitivityTableResult` publishes `rowValues` / `columnValues`
/ `cells`, not rows and columns; the MCP package re-exports the journey packs through its own
`ToolPack` wrappers in `packages/mcp/src/tools.ts`, so the valuation pack needed a wrapper there
(the MCP guide conformance gate caught the missing export); the CLI's full profile pin moved
15 → 16 packs; `@totalfinance/workflows` 405 → 415 KB (420,525 B) for the valuation edge. The tools gates then named two manifest findings: the new `valuationPack` export is a public identity of both the workflows and the MCP packages and needed its hand-classified manifest row (Manifest Law 1), and an MCP tool may be declared by ONE verb — the composition verb `discountedCashFlowFromStatements` owns `totalfinance.valuation.company`; the sensitivity table it also composes does not declare it.

### Slice 3 (landed 2026-09-04, `00980d725`) — the journey, the levels, the field reference

**What landed.** `docs/examples/end-to-end-journey.test.ts` (Decision 2): three companies' typed
statements → `analyzeFundamentals` at an instant → `discountedCashFlowFromStatements` under explicit
conventions, equal to the direct `discountedCashFlow` of its projected flows → `scoreUniverse` over
the ratios and the valuation as declared fields → a ledger with cash and `proposePortfolioRebalance`
buying the two best names to weight → `crossSectionalBacktest` on the same score, its equity its
ledger's NAV, its execution policy named → `analyze` of the run's equity curve, byte-equal to the
run's performance block; `docs/guides/end-to-end.md` is the same journey in prose, executed by
`guides.test.ts`. `docs/guides/levels.md` (Decision 3) prices one contract at the six levels and
proves they agree: the kernel, the facade and its `.explain()`, the pro envelope, a fitted-model
artifact saved / restored / replayed, the batch columns, and the registry operation — with the rule
that no guide presents the highest abstraction as the only route. `tools/fields-doc.ts` (Decision 4)
generates `docs/reference/fields.md` and one page per package from the committed declaration walk —
every public callable's parameters and members with kind, literal domain, optionality,
nullability, and the unit the name carries under the naming law's suffix conventions (printed in
the index, first match wins, "unitless by name" otherwise); `tools/fields-doc.test.ts` holds every
page byte for byte, `pnpm docs:update` regenerates them, the generated-docs registry declares them,
and prettier leaves them alone.

**Decisions at landing.**

1. **One page per package, not one file** — the declaration walk carries tens of thousands of
   field rows; a single document would be unreadable and would make every regeneration a
   multi-megabyte diff. The index carries the unit table and the per-package counts; Decision 4's
   "one generated file" is refined to "one generated index and one page per package".
2. **The umbrella's spellings are counted, not listed** — `totalfinance.<domain>.<callable>` repeats the
   domain package's declaration; the index states the count and the rule.
3. **Named object types are expanded once per page** — a `→ FundamentalPeriod` in a callable's row
   refers to the page's "Named types" table, where the type's fields appear once; the first draft
   expanded every nested type inline at every site (3.1 MB, 32,912 rows) and the reference is now
   1.2 MB with every declared field still present exactly once per package.
4. **The levels guide's artifact level is the fitted-model artifact**, not a market snapshot: the
   `./artifacts` subpaths are the level's own grammar (save, restore, replay, compare), and the
   volatility smile around the same strike keeps the guide on one instrument.

**Evidence.** `docs/examples/end-to-end-journey.test.ts` (the six-step journey), `docs/examples/guides.test.ts`
(the levels and end-to-end guides executed beside the strategies and backtesting guides),
`tools/fields-doc.test.ts` (four tests: byte-for-byte pages, no stale page, the whole library, the
unit table), `tools/generated-docs.test.ts` (82 generated surfaces registered). `pnpm run ci`:
491 test files, 10,389 tests green; `pnpm api:check` exit 0; the tools gates 59 files, 3,105 tests
green; the field reference 24 pages, 1.2 MB, 14,678 declared fields with named types expanded once.

**Gate findings at landing.** Five findings from the isolated-worktree rehearsal before the slice touched the main tree: the
unit table's regex sources are pipe-escaped in the markdown, so the gate compares the escaped
form; the generated-docs count pin moved 57 → 82 (the index and the 24 pages); the run's
performance block is `analyze` of its EQUITY curve, not of its returns (the two differ at the last
digit, and the engine holds the curve); a date-only expiry is refused by `option.call` — the guide
passes the 16:00 ET instant; the docs inventory reads object keys and property accesses inside a
fence as identities, so the guides build their companies from arrays and index by name; and the
batch API takes typed columns (`Int8Array` for the type, positive = call), which the guide now
does — the first draft's plain arrays priced a put. The reference itself was cut from 3.1 MB to
1.2 MB by expanding named types once (Decision 3 above).

### Slice 4 (landed 2026-09-04, `530eb6de8`) — clean-repository generation

**What landed.** `tools/regen-check.ts` and the `pnpm regen:check` script (Decision 9): the
regeneration chain in its lawful order — the signature and naming inventories, the contracts, the
enforcement record, the validation projector, the API reports, the READMEs, `llms.txt`, the bundle
report, the OpenAPI document, the docs inventory and the field reference — followed by a
working-tree check that fails, naming the paths, when any generated artifact differs from what is
committed; a tree that is dirty BEFORE the chain refuses too, so the verdict is never mixed with
uncommitted work. The hosted workflow gains the `clean-repository generation` job beside the test
matrix and the release rehearsal (Decision 10 keeps the hosted rows truthful: the job is defined
and will run when the organization's Actions billing is restored).

**Decisions at landing.**

1. **The chain is a script, not a runbook** — every earlier slice re-derived the order by hand and
   twice paid for a step run out of order; the order is now data in `REGENERATION_STEPS`.
2. **A dirty tree before the chain is a refusal, not a warning** — the check must attribute every
   change to the chain.

**Evidence.** `pnpm regen:check` on the clean main tree at this commit: the eleven steps ran in order and the
tree came back byte-identical — "the regeneration chain is byte-stable — nothing changed" — the
first time the whole chain's stability has been proven rather than assumed. `tools/preview-surface-audit.test.ts`
(54 tests) green with the new script in place; `pnpm run ci`: 491 test files, 10,389 tests green; `pnpm api:check` exit 0; the tools gates 59 files, 3,105 tests green.

**Gate findings at landing.** A rehearsal in an isolated worktree whose `node_modules` were symlinked
from the main checkout exercised both paths of the script — the dirty-tree refusal (exit 2, the
paths named) and the drift report (exit 1) — but its drift was an artifact of the rehearsal: the
workspace symlinks resolved cross-package declarations from the OTHER tree, so the contract walk
lost the members that reference another package's types (1,533 lines of `public-contracts.json`,
and the two field pages derived from it). The verdict the record quotes is the main tree's own run
at this commit.

### Slice 5 (landed 2026-09-04, `530eb6de8`) — the closeout

**What landed.** The FC0–FC9 sweep: every remaining open row of the completeness spec's FC9
checklist is ticked with the test that already closed it — the umbrella's symmetric namespaces
and subpaths (`tools/preview-surface-audit.test.ts`, FC9 row 1), the operation contract's effect
classification, budgets, seed policy, handles, assumptions, diagnostics, provenance, and artifact
identity (`packages/workflows/test/registry.test.ts` and the runtime suite, Stage 7A), the
read-only default set (every operation `sideEffect: 'none'`, the journey and backtest packs opt-in),
the parity fixtures (`tools/transport-parity.test.ts`), the Phase 3A/3B gates rerun with zero
deferred exceptions (`tools/deferred-exceptions.test.ts` and the whole `tools/` suite at this
commit), and the "one exact commit" row with its evidence recorded — local CI, the packed-tarball
consumers, the bundle budgets, and `pnpm regen:check` green here; the hosted matrix OPEN — every hosted "TotalFinance CI" run since 2026-09-03 has failed to start on the organization's GitHub Actions billing ("recent account payments have failed or your spending limit needs to be increased"); the last hosted run that executed was green at `f42dfee97`. The job definitions (the matrix, the release rehearsal, clean-repository generation) are committed; the row closes when billing is restored and the workflow runs green at this commit or a docs-only successor.
Then the core-freeze gate, row by row, and the trackers.

**Evidence at this commit.** `pnpm run ci` 491 test files, 10,389 tests green;
`pnpm api:check` exit 0; the tools gates 59 files, 3,105 tests green; the
packed-tarball consumers (`tools/packed-consumer.test.ts`, 41 tests) and the bundle budgets
(`tools/bundle-size/budgets.test.ts`) green inside that run; `pnpm regen:check` byte-stable on the
clean tree; enforcement 5,244 candidates (2,412 enforced · 2,650 partial · 0 defective · 182
unmeasured, every one with a reason); naming 37,279 identities, 0 unresolved; the hosted "TotalFinance
CI" run for the previous push (`83a30293c`) failed to start on billing in two seconds, as every run
since 2026-09-03.

**Gate findings at landing.** The closeout added no code. The docs gates, the evidence matrix, the
deferred-exceptions gate, and the field-reference gate ran green over the ticked trackers; nothing
new was named. The one thing the stage could not close — the hosted matrix — is stated in the row
that carries it, with the sentence GitHub prints, rather than ticked on a local run's strength.

### Completion record (2026-09-04, `530eb6de8`)

Stage 4.7 closed at `530eb6de8` after its five ordered slices landed from the accepted contract and
the full repository gate, `api:check`, the packed consumers, the bundle budgets, and
`pnpm regen:check` passed at that commit. Every FC0–FC9 checklist row and every workstream exit
gate is ticked with executable evidence except two rows held by standing decisions, each stated
where it sits: the performance-budget row (the maintainer's deferral of acceleration work) and the
hosted matrix (the organization's GitHub Actions billing). The core is frozen in fact —
the direct APIs, the compositions, the artifacts, the operations, and the transports are proven
over the expanded surface at one commit — and the stable label waits on Stage 5B behind the
Stage 5A publish and the hosted-matrix row. The next dependency-ready row is the Stage 5A publish
(maintainer-held) and, behind it, Stage 5B.
