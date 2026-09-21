# TotalFinance 10/10 Alignment — Spec & Task List

**Status: the current public-contract decision and completion record. Phase 3A function-shape
remediation, Wave 6, Phase 3B.N public naming normalization (N0–N9), and the Phase 3B
runtime/semantic closeout are ALL COMPLETE (closeout closed 2026-08-19 at `af99ee107`, hardened by
the 2026-08-23 external-review waves).
[`implementation-order.md`](./implementation-order.md) is the single controlling status for phase
state; this file records the contract decisions, not the sequence.**
This document supersedes the two review documents as the statement of where the library is going. It
was produced by three rounds of adversarial review between two independent assessments — the
[lovability review](./library-lovability-review.md) (tactical/first-touch, findings F1–F42)
and the [developer-experience assessment](./library-developer-experience-assessment.md)
(architecture/contracts) — whose positions converged. That convergence was useful, but it was not
proof: both reviews shared the same incorrect exception for positional expert kernels. Those
documents remain as history and evidence; when they disagree with this spec, this spec wins.

**Core-library status correction (2026-07-21):** compute phases 0–6 and the implementation work
recorded in alignment Phases 0–3 remain complete and verified at `e1e846e7`: 308 test files / 6,284
tests, strict typecheck, build, lint, API-report drift, Node ESM, `require(ESM)`, esbuild, and
TypeScript `NodeNext` + `Bundler` all pass. The broader claim that the core API was therefore closed
was premature. The review taxonomy explicitly allowed long positional expert-kernel signatures, and
the conformance manifest could not inspect or reject unsafe parameter shapes. Phase 3A reopened that
single P0 across the entire callable surface.

**Phase 3A closeout (2026-07-22):** the declaration-backed inventory now governs 3,310 public
callables across exports, namespace members, constructors, class/interface methods, and returned
artifacts. Financially confusable public and internal signatures were migrated to named requests;
all retained nontrivial positional protocols have source-controlled rationale; removed positional
forms are compile-fail contracts; first-touch fixtures follow the declared grammar; and raw,
facade, professional, row-batch, and columnar BSM layers have semantic parity. The installed-tarball
matrix and full repository gates pass. The data layer and roadmap depth remain later product
expansion, not hidden core-completion work.

**Post-3A scope clarification:** there is no known object-versus-positional migration left to perform.
A repository-wide naming audit subsequently proved that safe objects still carried abbreviations and
ambiguous field vocabulary. Phase 3B.N corrects those names first. Phase 3B then closes the different
question that declarations cannot answer by themselves: whether every runtime object boundary,
public field, default, unit, optional value, result, and error behaves exactly as a cold JavaScript
or TypeScript user would infer.

---

## 1. The current laws

1. **Every public export is classified in a source-controlled manifest** — role, domain,
   subpaths, input/result types, units, determinism, stability, MCP eligibility — and the
   exports maps, API reports, doc indices, and MCP registration are _generated_ from it.
   The manifest _references_ human-authored first-touch and semantic fixtures (a manifest
   can generate the exhaustive test matrix and enforce fixture completeness; it cannot
   author meaningful financial inputs and expected behavior). A CI conformance gate fails
   on any unclassified export, unbound alias, role violation, or classified export lacking
   its required fixture.
2. **One result grammar per role.**
   - _Facade_: plain value; the same call exposed via `.explain()` → `{ value, assumptions,
diagnostics }`.
   - _Analysis/report_: rich result on the primary call (diagnostics are inseparable from a
     responsible answer — calibration, optimization, backtests, covariance).
   - _Artifact/factory_: immutable domain object with versioned serialization.
   - _Kernel_: lean numeric output, documented IEEE-754 behavior, expert subpaths only.
3. **Umbrella = domain namespaces + a tiny manifest-declared flagship hoist.** Never
   wildcard-hoist a domain. Kernels, constants, and schemas live behind explicit subpaths.
   One eponymous namespace level (no `technical_analysis.ta`). All domains get symmetrical umbrella subpaths.
4. **Public vocabulary is explicit at the point of use.** Public fields, exports, declaration
   labels, package/subpath identities, schemas, serialized artifacts, and MCP contracts name the
   concept and any otherwise-hidden unit: `volatility`, `impliedVolatility`,
   `timeToExpiryYears`, `timestampMs`, and `riskFreeRate`, not `vol`, `iv`, `t`, `ts`, or a generic
   option-pricing `rate`. Canonical searchable domain terms and model notation remain only through
   the source-controlled, scope-aware allowlist in the
   [public naming normalization spec](./specs/phase-3b-public-naming-normalization.md). Private
   formula locals may stay compact. Never two meanings or units under one field name.
5. **Contracts are valid by construction.** Builders reject invalid values; meaning-changing
   fields (exercise `style`) are required, never defaulted; unsupported states (Bermudan
   without exercise dates) are unrepresentable; date _labels_ resolve to exact instants only
   through a named instrument convention.
6. **No silent economics.** No timeless rate defaults in professional paths; simplified
   helpers are explicitly named and echo their assumptions with a diagnostic.
7. **Success is finite — scoped by role.** Successful _facade, analysis, and artifact_
   results are JSON-safe and contain no undisclosed NaN/Infinity; undefined quantities are
   `null`/omitted with a disclosed reason. Warnings never license a non-finite success value.
   Runtime postconditions (`assertFiniteResult` for envelopes and `assertFiniteValue` /
   `finalizeResult` for plain/report results) walk the FULL result — value, assumptions, and
   diagnostics. Degenerate performance/risk metrics report `null` with field-naming diagnostics,
   and a singular covariance reports `conditionNumber: null`.
   RATIFIED EXCEPTIONS (the aligned-series contracts, disclosed by construction): leading
   NaN warmup slots in TA batch output when `diagnostics.warmup` reports them, and
   zone/divergence elements whose `direction: 0` / `code: 0` discriminant documents their numeric
   fields as NaN-when-none. Everything else non-finite is `null`-with-reason or a defect. _Expert
   kernels_ may expose documented IEEE-754 behavior (an infinite condition number for a singular
   matrix is a truthful kernel result) but never return an envelope falsely claiming convergence.
   Invalid input throws typed
   `QuantError`; a valid problem that can't converge reports `converged: false` and
   fabricates nothing.
8. **Engines are mechanically substitutable** — machine-readable capabilities and shared options
   (`greeks: false`) mean the same thing everywhere. Registration is structural, frozen, and
   side-effect-free: `defineOptionPricingEngine` never guesses a universal market fixture or calls
   user code. Built-ins pass the shared behavioral contract suite; custom engines opt into explicit
   `validateOptionPricingEngine(engine, probes)` verification with caller-supplied probes for every
   claimed exercise style.
9. **No pre-release compatibility clutter.** There are no released consumers; renames delete
   the old name. Adapters (`barsFrom(...)`) over input aliases. Post-1.0, aliases exist only
   via the manifest with a deliberate migration path.
10. **ESM-first, honestly stated.** One ESM build + `default` condition; `require(ESM)`
    described as interop, not a CommonJS build; compatibility proven by packed-tarball
    fixtures on supported runtimes, not workspace imports.
11. **MCP is a curated, manifest-backed allowlist.** `packs` are exact selections. Tool
    schemas, counts, and docs are generated; date inputs (`expiry`+`asOf`) accepted wherever
    humans and agents think in dates; every numeric field's schema states its unit.
12. **Unknown-key policy is explicit per object argument.** Control/config objects are `closed` by
    default and reject unknown keys with a typed did-you-mean error. Structural artifacts are `open`:
    they validate every field TotalFinance consumes while preserving harmless domain metadata and
    decoration. True foreign-schema ownership is the rare explicit `passthrough` policy. The public
    manifest records `closed | open | passthrough` per argument, and CI proves both directions —
    closed inputs reject the exact unknown-field error while open artifacts accept decoration.
13. **Numerical trust is certified per-domain, and the evidence is stated precisely.**
    Independent validation maturity varies by domain: TA has systematic cross-implementation
    golden certification for its TA-Lib-compatible surface (139/139 value-bearing functions,
    plus selected pandas-ta and tulipy extensions) — which does not by itself certify every
    one of the ~335 registered indicators, every mode, or every edge regime; options has
    meaningful but less uniformly packaged external evidence (literature benchmarks, external
    oracles, analytic-vs-independent-numerical comparisons); other domains have varying
    mixtures of literature benchmarks, independent-method checks, and internal consistency
    tests. TotalFinance publishes a versioned corpus that makes this evidence explicit and
    reproducible per-domain, extended by property/metamorphic tests and generated edge
    grids. Validation claims are never broader than the corpus behind them.
14. **Argument safety is a compile-time contract, not a facade-only convention.** Every public
    callable is assigned an approved calling grammar in a generated signature manifest. A financial
    operation with several interchangeable scalar inputs uses one flat named object, regardless of
    whether it is classified as a facade, analysis, helper, trusted function, or expert kernel.
    Positional signatures remain valid only when roles are naturally unmistakable — for example a
    unary transform, conventional algebraic operation, callback plus bounds, series plus options, or
    one-subject method — and nontrivial exceptions carry a reviewed rationale. Financial-domain
    internals follow the named-object rule too; only a benchmark-proven, file-private inner loop may
    use positional scalars behind one object boundary. Columnar object-of-arrays APIs are the public
    throughput contract. Parameter names, types, optionality, arity, grammar, and rationale drift all
    fail CI.
15. **Public object and field contracts are runtime truth.** TypeScript declarations are not runtime
    validation. Every closed public request—including an expert kernel—rejects unknown keys, missing
    required fields, wrong primitive/container types, and invalid non-finite inputs with a typed
    teaching error before calculation. A generated, source-controlled field inventory records names,
    meanings, units/bases, defaults, requiredness, nullability, result behavior, aliases, errors, and
    validator ownership; semantic or enforcement drift fails CI. Public raw calls may omit policy and
    convenience, but only file-private internals may trust a previously validated object. Enforcement
    follows contract shape, not package or manifest tier: `core` and `math` object/options/
    configuration boundaries receive the same identity-based policy as every package. Conventional
    positional scalar mathematical primitives retain their documented mathematical/IEEE contracts
    without universal parser wrappers; malformed arrays, matrices, dimensions, options, and callback
    results do not inherit that exception. Every exception belongs to a stable contract identity with
    a rationale—never to an entire package.

## 2. Settled decisions (with the concession trail)

**Signed-leg amendment (2026-09-09):** instrument-first `legs.call`, `legs.put` and `legs.stock`
require signed, nonzero quantities and replace all six direction-specific leg helpers before
release. Raw leg records remain first-class, and named whole-Position presets remain available
with positive structure counts. The historical F6 rejection patch below is preserved as history,
not a requirement to retain those helper names. See the complete
[contract and acceptance checklist](./specs/signed-leg-constructors.md).

| #   | Decision                  | Settled as                                                                                                                                                                                                                                                                        | Formerly contested by                                     |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| D1  | Result grammar            | Per-role (Law 2), not envelope-always, not facade-everywhere                                                                                                                                                                                                                      | Both (each conceded half)                                 |
| D2  | Umbrella root             | Curated flagship hoist + namespaces (Law 3)                                                                                                                                                                                                                                       | DX assessment (was namespace-only)                        |
| D3  | Public vocabulary         | Explicit semantic names at every public layer; canonical terms and private formula notation only through the scope-aware Phase 3B.N policy                                                                                                                                        | Supersedes the reviews' shared compact-vocabulary mistake |
| D4  | fit vs calibrate          | `fit` = statistical/historical; `calibrate` = matching market quotes. Implemented assignments: `calibrateSvi`/`calibrateSabrSmile`/`calibrateSsvi`/`calibrateEssvi`/`calibrateEventVolatility`/`calibrateEventMove` (+ vanna-volga, Heston-surface); `fit` stays for GARCH/HAR-RV | Lovability review (wanted one verb)                       |
| D5  | Aliases pre-release       | Delete, don't deprecate                                                                                                                                                                                                                                                           | Lovability review (wanted one-cycle aliases)              |
| D6  | Module format             | ESM-only + `default`; no dual build; packed-tarball gate                                                                                                                                                                                                                          | Assessment (wanted dual consideration)                    |
| D7  | MCP granularity           | The current 23-tool / 10-pack baseline is deliberate (not a permanent constant); discovery companions over micro-tools; grow via manifest allowlist                                                                                                                               | Assessment (called it arbitrary)                          |
| D8  | Ordering                  | Trust-breaker patches immediately; coherence pass as the next focused milestone; both P0                                                                                                                                                                                          | Both (reconciled framing)                                 |
| D9  | `underlying` on contracts | Stays required; smaller model-specific pricing specs serve pure formulas                                                                                                                                                                                                          | Lovability review (wanted it optional)                    |
| D10 | Bar inputs                | One canonical bar record + visible `barsFrom(...)` adapters; errors link the adapter                                                                                                                                                                                              | Lovability review (wanted key aliases)                    |
| D11 | Covariance on-ramp        | Cohesive `risk.covariance()`/`fromReturns()` delegating to math; not a barrel re-export                                                                                                                                                                                           | Lovability review (wanted re-export)                      |
| D12 | Rate defaults             | Only in explicitly named simplified helpers that echo `rateSource`                                                                                                                                                                                                                | Convergent (assessment's wording adopted)                 |
| D13 | Argument grammar          | One named object for financially confusable scalar inputs at every public layer; positional only for structurally unmistakable signatures; columnar APIs for throughput                                                                                                           | Both reviews (incorrectly exempted expert kernels)        |

**Retractions on the record** (so no stale claim survives): the lovability review's
`QuantError` "serializes to `{}`" claim is wrong (it serializes `name`/`code`/`context`;
only `message` is missing — fix is a versioned `toJSON()`); its "architecture is 10/10"
phrasing conflated the substrate (exceptional) with the public surface (the open work); its
"one-cycle deprecated aliases" advice is superseded by D5. The assessment's original
namespace-only umbrella, envelope-always grammar, and "somewhat arbitrary" MCP
characterization are likewise superseded above.

**Additional retraction (2026-07-21):** both reviews' positional-kernel exception is superseded by
Law 14 and D13. Moving kernels off general roots was correct topology work, but it did not make their
arguments safe. The reviews also repeated a speed rationale without a benchmark and treated mutual
agreement as confirmation. The original core-closeout claim was retracted until Phase 3A passed;
the 2026-07-22 evidence above closes that correction without weakening the verified correctness,
contract, result-grammar, topology, or packaging evidence.

**Additional retraction (2026-07-28):** the reviews and this spec's former D3 also treated
`vol`/`rate`/`t` as desirable compact facade vocabulary. The complete exported-type and serialized-
surface audit showed that this forces callers to translate meanings, hides units, and is actively
ambiguous with trading volume. The
[Phase 3B.N naming spec](./specs/phase-3b-public-naming-normalization.md) supersedes that decision
across every SDK, raw, batch, artifact, schema, and MCP layer.

## 3. Task list

Phases 0–3 below preserve completed work. Their numbered items retain the original problem statements
and acceptance intent; present-tense wording inside a completed phase is historical, not an open task.
Phase 3A is the completed P0 correction to the argument-shape premise those phases incorrectly
accepted.

### Phase 0 — Done and verified at `86326290`

| Task                                                                                                                             | Status      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| README/getting-started RSI produces real values; snippet tests assert numbers (F1)                                               | ✅ verified |
| Strategy guide runs under CI harness (F2)                                                                                        | ✅ verified |
| TA rejects positional params with teaching error (F3)                                                                            | ✅ verified |
| `Position` methods: default strike ranges, array inputs, class-method ratchet (F4; caught bonus `monteCarloProbability` crash)   | ✅ verified |
| `latchSeries` + corrected signals example (F5)                                                                                   | ✅ verified |
| Named-direction legs reject non-positive quantity (F6)                                                                           | ✅ verified |
| MCP accepts `expiry`+`asOf`, echoes resolved t (F7)                                                                              | ✅ verified |
| Per-family MCP packs exported; IV schema described (F8/F9 — P1.1 regression fixed and ratcheted)                                 | ✅ verified |
| `default` export condition; `src` shipped; changesets fixed group (F10 subset — publish-blocking launch work remains in Phase 4) | ✅ verified |
| Lower-acronym renames; `fromZeroRates` canonical; pre-release aliases removed (F13/F14, D5)                                      | ✅ verified |

**Implementation record (2026-07-20 batch):** Phase 1.1–1.6 and Phase 2.2/2.4 landed and were
verified per §6 — full `pnpm run ci` green (format/lint/typecheck/tests/build/api-report) plus a
17-probe behavioral battery against the BUILT artifacts (packs selection, `iv` rejection, alias
deletion, `resolveAsOf(NaN)`, `suspicious_rate`, `monteCarloProbability` seed teaching, `expiryConvention`
echo, lambda/perpetualFunding/covariance non-finite disclosures, `greeks: false` across engines) and the
packed-tarball consumer matrix (npm-installed tarballs: ESM import, `require(ESM)`, tsc `NodeNext` +
`Bundler` strict). Notes: the error-code registry gate froze 101 legacy unregistered codes as a
shrink-only ratchet (full registration is the Phase 3 manifest's job); the engine contract suite
caught and fixed three additional inconsistencies while being built (FD/MC engines' missing
`expiryConvention` echo, MC greek-default modeling); `assertFiniteResult`'s systematic sweep (Phase
2.1) and adaptive FD bumps (2.3) remain API-stability work — the three known violators are fixed
with `finiteOrNull` + disclosures.

**Correction pass (post-review, same day):** the reviewing agent's probes of the first batch
found five focused gaps, all confirmed and fixed: (1) `expiryConvention` now flows through the
stochastic adapters (heston/sabr/local-volatility) via `withTimeMetadata`, and the local-volatility engine accepts
`PriceOptions` — an unhonorable Greeks request gets the distinct registered
`greeks.unsupported_by_engine` disclosure, never a silent drop; (2) the engine contract suite is
registry-complete (15 cases; a completeness guard fails any future `engines.*` factory that skips
the suite; full machine-readable `engine.capabilities` metadata remains Phase 3); (3) MCP
date-aware option tools echo the resolved `asOf` and `expiryConvention` in assumptions; (4) the
15 remaining deprecated flat kernel aliases (heston*/sabr*/localVolatility*/gbm*) left the options ROOT
— the namespaces are the curated root surface, the model subpaths are the reclassified expert
kernel surface (no more fictional deprecations); (5) the packed-consumer suite gained a real
esbuild bundle-and-execute smoke plus an engines-floor assertion. **Runtime-matrix honesty:** the
local suite proves the CURRENT runner (≥ 22.13.0 enforced); a Node 22/24 CI matrix requires the
GitHub Actions pipeline, which is Phase 4 launch-ops work.

**Release gates.** _Original merge gate_: Phase 1 + Phase 2 items 2 and 4 (the three known
non-finite-success violators and `greeks: false` — known reproducible honesty violations do
not merge) — **✅ satisfied 2026-07-20**. _API-stability gate_: systematic finite-result
enforcement (Phase 2 item 3 and the full postcondition sweep) + Phase 3 — **✅ satisfied
2026-07-21 after the final closeout** (runtime postconditions, per-argument Law 12 enforcement,
executable analysis grammar, empty freeze-blocking ledgers, and explicit engine validation). That
gate did not cover Law 14. _Function-shape gate_: Phase 3A — **✅ satisfied 2026-07-22**.
_Publish gate_: Phase 4. _Core-library gate_: **✅ closed 2026-07-22**; the generated declaration
inventory and executable conformance gates, rather than the old role taxonomy, are now the
regression boundary.

### Phase 1 — Surgical fixes (merge gate) — **✅ COMPLETE, adversarially verified 2026-07-20**

1. **MCP `packs` = exact selection.** `createTotalFinanceMcpServer({ packs: [optionsPack()] })`
   currently throws `duplicate tool name` — defaults are installed first and packs appended
   (`server.ts:116-118` vs the guide's documented subset semantics). Omitted → defaults;
   provided → exactly those packs; expansion via `[...defaultPacks(), backtestPack()]`.
   Add a test that instantiates the guide's example. Align the `packs` JSDoc with the guide.
2. **Make `vol`/`iv` unambiguous by deletion (D5).** `ExpectedMoveImpliedVolatilityInput` accepts
   neither-or-both and `event.ts:71` silently prefers `vol`. Delete the deprecated `iv`
   field and explicitly reject the retired `iv` key with a teaching error (library-wide
   unknown-key rejection is Law 12, Phase 3).
3. **Delete all pre-release aliases (D5):** `fitSVI`, `fitSABRSmile`, `calibrateSSVI` (and
   casing twins), `curves.zeroRate` builder, plus any others the rename pass kept.
4. **Fix the error-code family + FREEZE the registry debt (F15):** QR eigensolver unified to
   `LinalgNoConvergence`; a monorepo-wide static gate now requires every `code:` literal to be
   registered OR in a frozen, shrink-only 101-entry legacy allowlist (new strays fail; stale
   entries fail), with the linalg family rule asserted. **Honest scope:** this freezes and
   contains the debt — it is NOT yet "every literal resolves to a registry entry with general
   family consistency." Full registration (or per-package registries) is the Phase 3 manifest's
   job and gates API stability, not merge.
5. **State the real runtime contract (D6):** raise `engines` to the ratified Node floor
   (§5.1), reword any "require works" claim as `require(ESM)` interop, and add packed-tarball
   fixtures (Node ESM + `require(ESM)` on the CURRENT runner — the engines floor is asserted;
   the Node 22/24 matrix itself ships with the Phase 4 GitHub Actions pipeline — tsc `NodeNext` +
   `Bundler` prioritized, a real esbuild bundle-and-execute smoke, one no-bundler app).
6. **Small guards:** `resolveAsOf(NaN)` → typed error; `input.suspicious_risk_free_rate` warning
   (|rate| > 0.5) in options + MCP; sharpen `monteCarloProbability()`'s bare-call error to name the
   seed requirement (a zero-argument stochastic call stays an error — the determinism law
   requires an explicit seed, so this must NOT be made to succeed); name and echo the
   date-only-expiry US-equity-close convention in assumptions (full fix in Phase 3
   contracts).

### Phase 2 — Correctness of success states — **✅ COMPLETE 2026-07-20 (correction pass): runtime `assertFiniteResult` in the core facade wrappers + the manifest-driven CI sweep; the probed violators (impliedVolatilityRank, probabilityInTheMoney, meanReturns, analyze) fixed to null-with-reason**

1. `assertFiniteResult`-style postcondition at every explained/pro boundary (arrays,
   typed arrays, matrices included); `null`-with-reason for undefined quantities (Law 7).
   **Done (P2.1):** the manifest-driven finite-result sweep
   (`tools/first-touch/finite-results.test.ts`) deep-walks every fixtured facade/analysis
   result — an undisclosed NaN/Infinity anywhere fails CI; the TA leading-warmup prefix and
   discriminated `direction: 0` zone sentinels are recognized as documented disclosures; the
   violation ledger shipped EMPTY (findings were fixture bugs, fixed at the source).
2. Fix the three known violators: BSM `lambda` underflow (`bsm.ts:144`); `perpetualFunding`
   fractional compounding of negative bases (`carry.ts:92`); `estimateCovariance` SPD
   postcondition (eigenvalue floor / guaranteed fallback + warning; make the single-index
   equal-weight market proxy explicit or accept a market series).
3. Adaptive finite-difference bumps near boundaries (vol/time/spot/intensity); actual bump
   sizes in diagnostics. **Done (P2.3):** `resolveFdSteps` is the single source of truth
   (`hSig` → σ/4 below the 4·10⁻³ boundary, `hT` → T/4 near expiry); the FD engines disclose
   the actually-used sizes via `diagnostics.finiteDifferenceBumps`; Heston/SABR shift-mode bumps scale to
   their own vol level; boundary + continuity tests in
   `packages/options/test/fd-adaptive-bumps.test.ts`.
4. Honor `greeks: false` in BSM/Black-76 or remove the flag; ship the parameterized engine
   contract suite (Law 8) so this class can't recur.

### Phase 3 — The coherence pass (pre-1.0) — **✅ COMPLETE at `e1e846e7`, adversarially verified 2026-07-21**

- **Law 12 (unknown keys)**: enforced centrally and swept in CI PER OBJECT ARGUMENT
  (`tools/first-touch/unknown-keys.test.ts`, including `.explain` twins). Manifest
  `inputPolicies` distinguish closed control/config inputs from open structural artifacts and rare
  passthrough schemas. Closed arguments must reject with the exact typed unknown-field error; open
  artifacts must accept decoration while still validating every consumed field. The original blanket
  strictness pass surfaced real bugs (`analyzeBook.regulationTRate`, wide `analyze` options), but its false
  positives on calendars, contracts, curves, handles, and result artifacts were removed rather than
  fossilized as hostile API behavior.
- **Analysis grammar (Law 2)**: `shape: envelope | report` stamped from OBSERVED runtime
  results; the conformance gate EXECUTES fixtured analysis exports with EXACT shape matching
  (envelope requires assumptions; a report may not smuggle an envelope), surfaced fixture
  errors, and a set-difference stale check. The FI rates/credit answers (fra/swap/swaption/
  cap-floor/CMS/CDS) now carry assumptions + diagnostics; hazard bootstrap reclassified
  artifact (curve factory, by behavior). E5 closed the rest: ANALYSIS_GRAMMAR_DEBT (19) is
  EMPTY — all conversions landed (risk 9, vol 4, ta 3, options 2, structure 1; method-bearing
  results — riskNeutralDistribution, surfaceLocalVolatility, risk.scenario, dupireLocalVolatility — were
  honestly reclassified artifact/kernel instead). The 122 analysis exports without fixtures
  (UNFIXTURED_ANALYSIS ratchet) were ALL fixtured in E5, so the executable envelope|report
  shape check now runs against EVERY analysis export; every export's `shape` is stamped in its
  manifest. The 36 helper-role "plain-value quant answer" notes now bind bidirectionally to a
  real shrink-only HELPER_QUANT_ANSWER_BACKLOG in the conformance gate (the recorded upgrade
  backlog those notes previously only claimed).
- **Law 7 tightened (E3, reviewer-ratified): warnings never license a non-finite value.**
  `assertFiniteResult` and the CI finite sweep walk the FULL result at FULL depth with no
  disclosure waiver — the only carve-outs are the ratified structural sentinels (declared
  warmup prefixes; discriminated `direction: 0` zone and `code: 0` divergence points). IV and
  solver failure envelopes report `value: null` (`Facade` gained a defaulted `ExplainValue`
  generic so plain calls still throw typed errors while `.explain` reports softly);
  `analyze({ returns: [] })` returns a degenerate all-null summary under
  `performance.empty_series`; `compareEngines` failed rows carry nulls, never NaN/Infinity;
  `optionsMargin.maxLoss`, `profitFactor`, `winRate`, `effectiveCount` and the other documented
  IEEE leaks are now null-with-reason. `requireSeries` (E4) validates EVERY element — a NaN
  mid-series throws `input.not_finite` instead of poisoning the metric.
- **Ledgers that block freeze are EMPTY**: facade-without-`.explain` (the four parity
  extractors were envelopes — reclassified analysis) and kernels-on-facade-roots (vol
  evaluators → feature subpaths; FI kernels → `/rates`).
- **Engine capabilities (Law 8)**: machine-readable `capabilities` on every engine, required and
  structurally checked by side-effect-free `defineOptionPricingEngine`, which returns a frozen copy
  with correctly bound methods. Behavioral verification is explicit through
  `validateOptionPricingEngine(engine, probes)` so each claimed style is tested with a caller-valid
  contract/market fixture; it checks support honesty, determinism, result shape, finite outputs, and
  Greek capability claims. Built-ins pass the shared registered contract suite, including dividend
  honoring and seeded MC/local-volatility reproducibility. FD bump disclosure is resolved ONCE and the same
  object is differenced with and reported (Heston first-order included; no phantom `hQ`).
- **Contracts / ONE expiry law**: frozen artifacts; a single STRICT component-verified
  datetime parser behind `optionExpiryToMs`/`resolveAsOf` (Feb-31, month-13, hour-25 and
  ±99:00 offsets all reject — `Date.parse` is never trusted); EVERY engine family (BSM, FD,
  MC, Black-76, Heston, SABR, local-volatility) prices from `expiresAt` with the expiry↔instant
  cross-check; `expiresAt` finiteness asserted at build; ALL builders (generic included)
  require an explicit convention for date-only labels; the runtime contract schema validates
  the RESOLVED artifact (`expiresAt` + convention required, zoned labels accepted).

**Final adversarial closeout (`e1e846e7`).** A second implementation review reproduced the remaining
edge cases and verified the corrections probe-by-probe:

- option cross-field validation is a real composable `TransformSchema` effect, not a `safeParse`
  override; it survives nesting, arrays, optional/describe/Standard-Schema composition, and freezing;
- plain values and reports use the same finite-success law as envelopes; degenerate performance
  metrics and overflow paths return `null` with a field-naming diagnostic, never NaN/Infinity;
- TA validates every bar/trade/quote/book element semantically, requires ordered footprint timestamps,
  and commits streaming state only after a finite postcondition succeeds;
- scalar helpers return the scalar/null directly with `.explain()` as the optional diagnostic gesture;
- decorated calendars, contracts, curves, handles, and artifacts remain composable while malformed
  consumed fields fail with typed, indexed errors; and
- the heuristic leading-NaN gate and “any exception counts as rejection” loophole are gone. Warmup must
  be declared, closed-key probes assert the exact error, open artifacts are probed for decoration, and
  typed arrays are walked.

Verification at closeout: **308 test files / 6,284 tests**, 96.47% statements / 88.91% branches /
98.15% functions / 97.21% lines, clean build/typecheck/lint/API reports, and six installed-tarball
consumer tests across Node ESM, `require(ESM)`, esbuild, and both TypeScript resolution modes.

1. **Manifest + conformance gate** (Law 1) — the spine; everything below is expressed in it.
   **Done (P3.1):** `tools/manifest/` — schema, runtime inventory (source under vitest, dist
   under node), curation-preserving generator (`pnpm manifest:update`), all 1,530+ runtime
   exports hand-classified, and the 9-check conformance gate (drift, roles, kernels-off-roots,
   entrypoint sync, MCP linkage, frozen hoist, fixture completeness) in CI. The 101-code
   registry ratchet burned to zero (P3.1c).
2. **Role classification and result-grammar migration** (Law 2): vol/structure scalar tier
   becomes facades with `.explain()`; crypto's inline-assumptions records become analysis
   results; optimizers/backtests stay rich; document the four roles once.
3. **Topology** (Law 3): curated flagship hoist (§5.2); kernels → `/kernel` subpaths;
   umbrella domain subpaths; de-dupe eponymous namespaces; complete vol/crypto feature
   subpaths; budget the umbrella root in CI.
4. **Contracts** (Law 5): require `style`; Bermudan discriminated union or removal;
   `expiresAt` instants with instrument-convention resolution of date labels;
   pricing-vs-metadata field split; instrument builders (`usEquityCall`) as the lovable
   layer; builder-level validation (blank identifiers, non-positive numerics, bad expiries).
5. **Historical vocabulary pass** (D4; public spellings now superseded by Phase 3B.N):
   `normalVolatility`; `calibrateSvi`/`calibrateSabrSmile`/
   `calibrateSsvi`/`calibrateEssvi`/`calibrateVannaVolga` per the ratified D4 assignments;
   exotics move to single-object discriminated-union inputs; `option.price` takes one
   options-bearing object shape (kill the `undefined`-hole).
6. **Journeys**: `risk.covariance()`/`fromReturns()` → optimizer flow (D11); flagship
   JSDoc with `@example` on every hoisted member; `tradingDaysToExpiry`; TA `peek`
   clarification for `update()`.
7. **MCP from the manifest** (Law 11): generated counts/descriptions; crypto/FI/advanced-vol
   tool additions via allowlist; UTF-8 byte budgets; operation-aware row limits.
   **Done (P3.7):** 23 tools / 10 packs (crypto funding+carry, FI bond analytics added);
   `Buffer.byteLength` input budget; `capRows` takes per-operation caps (optimizer covariance
   dimension ≤ 200, surface chain ≤ 2000); every count pinned to `defaultTools()` in CI; the
   manifest declares each tool's backing export and the gate enforces the linkage.

### Phase 3A — Public function-shape correction (pre-1.0) — **✅ COMPLETE 2026-07-22**

**Why this phase exists.** The prior reviews did inspect BSM and similar signatures. They made the
wrong design decision: object inputs were required for user-facing facades while positional numeric
arguments were explicitly allowed for expert kernels on deep subpaths. That conflated raw access
with unsafe argument passing, relied on an unmeasured speed assumption, and mistook import topology
for type safety. A developer can transpose spot/strike, time/volatility, or rate/dividend yield and
still receive a plausible number. The same risk exists in internal cross-module calls. This is the
exact P0 the alignment pass was supposed to prevent.

The mechanical gates could not challenge the premise. The runtime manifest records role, kind,
entrypoints, result shape, and per-object unknown-key policy, but not TypeScript parameter names,
types, optionality, arity, or an approved calling grammar. API reports preserve whatever signature
exists; they do not judge it. First-touch fixtures prove calls run, and the topology gate proves
kernels are off general roots, but neither rejects a financially ambiguous positional call.

**Initial inventory, not final classification.** A TypeScript-compiler pass over package entrypoints
found 53 financial-kernel callable surfaces with at least three arguments, 26 non-TA
facade/analysis/artifact callable surfaces with at least three arguments, and 54 signatures with at
least three primitive arguments across the broader scope. These counts include multiple public paths
to some implementations, and the final set includes legitimate positional mathematics. They are an
audit queue, not a blanket instruction to object-wrap every function.

Obvious migration families include BSM, Black-76, Bachelier, fixed-income Black/Bachelier kernels,
GBM and Monte Carlo entrypoints, Heston/SABR/local-volatility scalar surfaces, strategy probability helpers,
and volatility evaluators with confusable scalar coordinates. The high-level queue includes engine
comparison, parity analysis, portfolio optimization, exposure, and surface construction; each must
be judged by the same grammar rather than exempted by role.

#### Required work

1. **Generate the complete callable inventory.** Use the TypeScript compiler against built public
   declarations. Include every package export path, namespace member, class method, callable factory
   result, and method on a returned public artifact. Record aliases as public paths while linking
   them to one implementation identity so totals are honest.
2. **Classify every callable's grammar.** Add a source-controlled signature manifest with at least
   `object`, `series-options`, `single-subject`, `natural-positional`, and `columnar`. Record parameter
   names, types, optionality, and arity from declarations. Any nontrivial `natural-positional`
   signature with repeated primitive types requires a human-reviewed rationale. New, changed, or
   unclassified signatures fail CI.
3. **Migrate financially ambiguous scalar APIs once.** Use a flat required object at raw/kernel
   layers; require every financially meaningful input rather than adding silent defaults. Use one
   conceptual request object for higher-level operations when split arguments make composition or
   evolution harder. Do not add positional/object overloads or deprecated aliases before 1.0.
4. **Migrate internal financial call sites too.** Do not preserve a parallel positional architecture
   on the assumption that it is faster. A positional scalar inner loop is allowed only when a
   reproducible profile identifies it, it is file-private behind the object call in the same module,
   it has no cross-module consumers, and scalar/object/batch parity is tested.
5. **Preserve natural APIs.** Do not mechanically object-wrap `normalCdf(x)`, `dot(a, b)`,
   `clamp(value, min, max)`, a conventional root solver `(fn, lower, upper, options)`, a
   series-plus-options indicator, or `position.pnlAtExpiry(spot)`. The rule is misuse resistance and
   conceptual coherence, not an argument-count linter.
6. **Make throughput explicit.** Keep or improve typed-array/object-of-arrays batch contracts such as
   `blackScholesPriceMany`/`blackScholesPriceManyInto`; benchmark those paths at realistic sizes. Object construction
   in a scalar convenience call is not the performance architecture.
7. **Migrate all evidence with the API.** Update API reports, manifest fixtures, MCP linkages, docs,
   snippets, examples, tests, and internal consumers. Add compile-fail tests for removed positional
   calls and semantic parity tests across raw, facade, professional, batch, and any accelerated path.
8. **Repeat adversarial review from the user's priority, not the old taxonomy.** Review the generated
   inventory line by line, sample the built tarballs as a cold TypeScript user, and require an
   explicit rationale for every exception. Reviewer agreement is not an acceptance criterion;
   executable coverage and resistance to plausible argument transposition are.

#### Completion evidence

| Evidence                      | Closed state                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration inventory         | `tools/manifest/public-signatures.json` contains **3,310** callables: 2,500 exports, 166 constructors, 344 class methods, 49 interface methods, and 251 returned-artifact methods. Runtime namespace members backed by string-index declarations are expanded from concrete manifest paths. Aliased paths carry an implementation identity.                                   |
| Reviewed grammars             | 1,285 `object`, 765 `series-options`, 523 `single-subject`, 110 `subject-options`, 363 `natural-positional`, 260 `none`, and 4 `columnar`. The 135 nontrivial retained protocols that require rationale carry it in `signature-policy.ts`; stale policy IDs fail CI.                                                                                                          |
| Internal audit                | The compiler-backed financial-source scan has no unreviewed callable with three or more numeric coordinates. Its eight retained IDs are conventional calendar, validation, lattice-callback, clamp, or reviewed fixed-income primitives—not parallel positional pricing architecture.                                                                                         |
| Migration                     | BSM, Black-76, Bachelier, Heston, SABR, local-volatility, GBM/Monte Carlo, American analysis, parity, fixed-income pricing/curves/credit, risk/optimization/scenario/P&L, strategy, structure, volatility, TA, and backtest request families use named objects where coordinates were confusable. No positional/object compatibility overloads were added.                    |
| Compile and fixture contracts | `signature-compatibility.compile.ts` makes representative old financial calls fail typechecking and new object calls compile. `signature-fixture-conformance.test.ts` binds executable first-touch fixtures to the declaration grammar. Public and internal inventory drift fail their conformance suites.                                                                    |
| Semantics and throughput      | The BSM parity suite proves raw, facade, `.explain()`, engine, professional, row-batch, allocating columnar, and caller-owned-buffer paths agree. A reproducible 100,000-row mixed-contract benchmark covers the scalar named-object kernel and both columnar paths. No accelerated implementation ships yet, so accelerated parity is correctly N/A until one is introduced. |
| Shipped artifacts             | API reports, runtime manifests, package READMEs, `llms*.txt`, examples, MCP callers, tests, and installed-tarball consumers use the new grammar. The packed matrix executes ESM, `require(ESM)`, esbuild, and strict TypeScript `NodeNext`/`Bundler` consumers.                                                                                                               |
| Final verification            | Format, lint, strict typecheck, build, 315-file / 6,369-test suite and coverage, API-report drift, runtime-manifest drift, signature-manifest drift, generated-doc drift, benchmark execution, and installed-tarball gates pass on the closeout runner.                                                                                                                       |

#### Exit gate

- ✅ zero unclassified public callables across exports, namespaces, classes, and returned artifacts;
- ✅ zero public long homogeneous financial scalar signatures, independent of role or subpath;
- ✅ every retained nontrivial positional signature has an approved, source-controlled rationale;
- ✅ financial-domain internals use named objects; no positional financial inner-loop exception is
  currently needed;
- ✅ old positional financial calls fail typechecking, while object calls pass packed-consumer tests;
- ✅ scalar/facade/pro/batch parity and realistic throughput benchmarks pass; accelerated parity is
  N/A because no accelerated implementation ships; and
- ✅ full format, lint, typecheck, test, coverage, build, API-report, manifest, generated-doc, and
  installed-tarball gates pass.

No Phase 3A status flips from prose or reviewer confidence. The generated inventory and conformance
gate are the completion evidence.

### Phase 3B.N — Public naming normalization (pre-1.0)

**Sequence:** complete (N0–N9; permanent naming ratchets remain active). The
[complete naming specification](./specs/phase-3b-public-naming-normalization.md) records the
historical baseline, migration, and executable closeout evidence that preceded Phase 3B.

The Phase 3B.N closeout scan covered all 20 packages and 25,848 public naming identities—public
methods and parameter labels, object keys, package identities, schemas, serialized artifacts, MCP,
generated outputs, docs, and packed consumers—and closed with zero unresolved names. The permanent
inventory has continued to grow with Stage 4 APIs while retaining zero unresolved names.

Required outcome:

- explicit public names for volatility, implied/realized volatility, time and units, timestamps,
  rate roles, Monte Carlo, mark-to-market, parameters, specifications, callbacks, statistics, and
  other rejected shorthand;
- full `@totalfinance/volatility` and `@totalfinance/technical-analysis` package/domain identities;
- `blackScholes`/`blackScholesPrice` as the discoverable flagship and raw model names;
- a narrow source-controlled allowlist for canonical terms such as PnL, VaR/CVaR, SABR/SVI,
  ATM/ITM/OTM, DV01/PV01, MCP, and exact technical-indicator names;
- semantic—not regex—handling of collisions such as TA `volumeCutoff` meaning `volumeCutoff`;
- one vocabulary across SDK, raw, batch, artifacts, schemas, MCP, and stable code strings; and
- a permanent generated naming inventory with zero unresolved identities.

No old pre-1.0 package, export, field, tool, or wire alias remains. Formula notation and tight
private locals are not churned merely for length.

<a id="phase-3b-runtime-semantic-closeout"></a>

### Phase 3B — Runtime and semantic surface closeout (pre-1.0)

**Sequence:** complete (3B.0–3B.6, closed 2026-08-19). No version may bypass the permanent gates
installed by this closeout.
[`implementation-order.md`](./implementation-order.md) is authoritative if an older tracker describes
a different sequence. Ordered work and commit boundaries live in the
[`Phase 3B implementation spec`](./specs/phase-3b-runtime-semantic-closeout.md); settled result,
positional, runtime, and semantic answers live in the
[`Phase 3B decision ledger`](./specs/phase-3b-decision-ledger.md).

**Decision boundary:** Phase 3A settled which calls use objects and which retained positional calls
are natural, and Phase 3B.N settles the names on those shapes. Phase 3B does not mechanically wrap
more functions or reopen naming. It verifies that the settled shapes are truthful at runtime and that
their fields and answers communicate one unambiguous contract. Its unit of implementation is a
deduplicated contract/validator identity; aliases still receive complete path coverage without
becoming duplicate handwritten work.

#### Reproduced seed defects

The latest implementation review found that public raw object-input kernels such as `blackScholesPrice` and
`black76Price` can still accept a misspelled/unknown property, consume a missing required property,
and return `NaN` instead of a typed teaching error when called from JavaScript or through `any`. The
facade rejects the analogous mistake correctly. This is not an argument-shape failure; it is missing
runtime enforcement at a public object boundary, and it proves that declaration-only coverage is
insufficient.

#### Required work

1. **Generate the runtime/field contract inventory and ratchet.** Starting from built declarations and
   runtime manifests, enumerate every public object input and result plus the disposition of
   conventional positional scalar mathematics. Record field name, meaning, primitive/container type,
   units/basis, requiredness, default source, nullability, result role, error behavior, aliases, and
   the runtime validator/allowlist that enforces it. CI rejects a new or changed field or
   identity-scoped enforcement exception without source-controlled review.
2. **Enforce every public object boundary at runtime.** For each closed request object, reject unknown
   keys, missing required keys, wrong primitive/container types, and non-finite inputs where the
   contract requires finite values—including object/options/configuration boundaries in `core` and
   `math`. Public raw kernels may omit conveniences, defaults, diagnostics, and plausibility policy;
   they may not silently reinterpret malformed JavaScript. Do not wrap conventional positional
   scalar mathematical primitives in universal parsers; do validate malformed containers,
   dimensions, options, and callback results according to their consumed contracts. Keep a
   file-private unchecked numeric loop where profiling justifies one, and make batch paths the
   throughput architecture.
3. **Implement the settled quant-answer result ledger.** Regenerate
   `HELPER_QUANT_ANSWER_BACKLOG`, bind its current 36 paths / 27 operations to H01–H27, implement the
   nine facade and three report upgrades, ratify the 15 complete plain answers, and delist each path
   with its evidence. A genuinely new generated identity receives a decision before migration.
4. **Prove the settled high-level positional-pair ledger.** Regenerate and deduplicate the current
   33 paths / 30 operations, bind them to P01–P30, and preserve every listed call shape. A new pair is
   not covered by analogy and receives its own decision.
5. **Test cold built artifacts as JavaScript and TypeScript users.** Run packed-tarball journeys for
   flagship, raw, professional, batch, and returned-artifact layers. Include omitted fields,
   misspellings, extra keys, `undefined`, wrong primitive types, non-finite values, degenerate but
   valid cases, and plausible field transpositions. Assert the exact error code and one-round-trip
   correction where applicable—not merely that some exception occurred. Execute a minimal real
   pack/install smoke with every package/contract slice; the final exhaustive packed matrix is
   cumulative evidence, not the first packaging check.
6. **Make tracker truth mechanical.** Remove stale completion prose and TODO/backlog comments, bind
   generated counts to CI, and update API reports, manifests, docs, MCP schemas, examples, and
   packed-consumer fixtures in the same change as each contract.

#### Exit gate

- ⬜ every public closed-object request has generated runtime-shape evidence;
- ⬜ no package or manifest tier has a blanket validation exemption;
- ⬜ missing or misspelled required inputs cannot produce `NaN`, Infinity, or a plausible wrong answer;
- ⬜ the helper-answer backlog is empty or every plain result has an approved rationale;
- ⬜ every retained high-level positional pair has an approved rationale and drift fails CI;
- ⬜ every public field has a reviewed semantic contract and semantic drift fails CI;
- ⬜ cold packed JavaScript and TypeScript misuse journeys pass across the public layer ladder; and
- ⬜ the full format, lint, typecheck, test, coverage, build, API-report, manifest, generated-doc, and
  installed-tarball gates pass.

Phase 3B closes only from executable evidence. A clean declaration inventory does not waive runtime
behavior, and a full unit-test count does not waive untested public fields.

### Phase 4 — Launch ops (after the platform-core freeze)

| Workstream                                         | Status at `e1e846e7` | Remaining publish work                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical public repository + npm release metadata | ⬜ open              | Finalize the public location/scope, replace the single `TODO(repo-url)`, and run publish dry-runs.                                                                                                                                          |
| README front page                                  | ◐ partial            | The one-line → explain → professional ladder and package overview exist; finish the launch status/install treatment and keep all counts generated.                                                                                          |
| Guides and project docs                            | ◐ partial            | Four-role envelope guide, executable examples, generated `llms*.txt`, and historical-review banners exist; link the LLM files and add the docs site, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, and release guidance.                         |
| CI and packed consumers                            | ◐ partial            | Six real installed-tarball tests pass on the current runner (ESM, `require(ESM)`, esbuild, `NodeNext`, `Bundler`); add hosted Node 22/24 CI, run the complete public-example set against packed packages, and assert source-map navigation. |
| First public release authorization                 | ⬜ open              | Select the version deliberately, verify one exact release commit and fixed package group, authorize and execute atomic publication, create the tag/release, then install and smoke-test the public registry artifacts.                      |

#### First-public-release gate

Publish only when:

- every release-blocking gate is green at one exact commit;
- the version and fixed package group are selected deliberately rather than inferred from the
  development placeholder;
- canonical package/repository metadata, public docs, security/community files, hosted CI,
  changesets/release notes, source maps, provenance, and dry-run tarball hashes are complete;
- an authorized maintainer approves the exact artifacts;
- all packages publish atomically, followed by the matching Git tag and GitHub release;
- clean consumers install and smoke-test the actual public-registry artifacts; and
- rollback/yank ownership and response steps are documented before publication.

**Core-completion boundary.** Phase 3A closed argument grammar, not every runtime or field-level
semantic contract. Phase 3B is therefore release-blocking. After it closes, the compute-only platform
spine—shared artifacts, narrow pricer contracts, durable books, scenarios, and reproducible research
artifacts—lands in the order defined by [`implementation-order.md`](./implementation-order.md).
Phase 4 then changes how that frozen library is discovered, verified in hosted automation, and
published. Data, remote MCP, and measured acceleration remain later edge/product programs rather than
hidden prerequisites for the provider-free compute core.

## 4. Acceptance gates for 10/10

Merged from both reviews and corrected where their shared premise failed. The implementation evidence
at `e1e846e7` remains green for its stated scope, and the Law 14 function-shape gate is generated,
executable, and closed. The open Phase 3B rows are the remaining core-surface claims—not a reopening of
the completed argument migration:

- ✅ every runtime export is classified; CI fails on unclassified/role-violating exports;
- ✅ kernels are absent from general roots and the curated topology is enforced;
- ✅ every public callable has an approved grammar; no financially confusable positional signature
  survives merely because it is a kernel/helper/trusted export; namespace and artifact methods are
  included (Phase 3A);
- ✅ contract builders reject invalid values and never choose exercise style silently;
- ✅ every engine passes the shared contract suite; shared options mean one thing;
- ✅ every successful facade/analysis/artifact result is JSON-safe with no undisclosed non-finite values (`null`-with-reason for undefined quantities); kernels document their IEEE-754 behavior;
- ✅ every Greek/vol field has an unambiguous unit convention in runtime assumptions;
- ◐ facade, analysis, artifact, and schema boundaries reject malformed runtime objects; Phase 3B must
  extend generated shape evidence to public raw/expert object inputs and eliminate missing-field or
  unknown-field `NaN` paths;
- ◐ public answer grammar is role-classified and every current helper/pair decision is settled in the
  Phase 3B ledger; Phase 3B must implement H01–H27 and bind/prove P01–P30 against generated identities;
- ◐ Phase 3B must add a field-level semantic inventory for names, units, defaults, requiredness,
  optionality, nullability, result behavior, and errors, with drift enforcement;
- ◐ all public examples compile, run, and assert meaningful values; the flagship journey and
  runtime/module-resolution matrix pass against packed tarballs, while full example-against-tarball
  execution is Phase 4 release evidence;
- ✅ each quantitative domain has domain-appropriate reference, independent-method, golden,
  metamorphic, or property evidence; Law 13 prevents overstating the breadth of that evidence;
- ◐ the mechanically tested first five minutes work: a literal README copy-paste produces real
  numbers, their first wrong call teaches the fix in one round trip, and a cold agent can
  price an option, analyze a condor, and run an indicator without leaving the tool schemas. External
  first-time-user studies remain Phase 4 evidence of lovability, not an unimplemented core API.

## 5. Ratification and correction record

1. **Node floor — RATIFIED & IMPLEMENTED 2026-07-20.** `"engines": { "node": ">=22.13.0" }` — verified against Node's
   documented module history: `require(ESM)` unflagged in 22.12.0, experimental warning
   removed in 22.13.0; Node 22/24 are the supported LTS lines and 18/20 are EOL.
   (`>=20.19` is technically workable but knowingly advertises an EOL runtime.) Test packed
   consumers on Node 22 and 24.
2. **Flagship hoist membership — RATIFIED; SPELLINGS SUPERSEDED BY PHASE 3B.N.** The five
   CI-budgeted roles remain `blackScholes`, `option`, `market`, `engines`, and
   `impliedVolatility`. Everything else reaches the root as a domain namespace. The historical
   implementation used `bs`; Phase 3B.N replaces that identity before release.
3. **Date-only expiry convention naming — RATIFIED & IMPLEMENTED.**
   `expiryConvention: 'us-equity-close'` is echoed in assumptions; instrument builders own the
   convention and generic builders require an explicit opt-in.
4. **Public argument grammar — CORRECTED, RATIFIED & IMPLEMENTED 2026-07-22.** The former
   facade-object/kernel-positional split is rejected. Law 14 and D13 apply by confusion risk and
   conceptual shape, not role label or import depth. Phase 3A implemented the migration and installed
   the declaration-backed regression gate.

**Out of scope here, not forgotten:** the data layer and vendor adapters remain a
deliberately deferred later stage (see `docs/roadmap.md` and the assessment's deferred-gap
section); they consume this spec's contract/time/unit/error conventions rather than
preceding them.

---

## 6. Maintenance model

- **Contract and Phase 3A/3B statuses live here** (not in the review documents—those are frozen
  history plus their own errata). [`implementation-order.md`](./implementation-order.md) owns global
  sequencing; the completed Wave 6 spec owns that feature batch; the Phase 3B decision ledger owns
  its settled per-operation answers; `roadmap.md` owns feature inventory. Ongoing API status must be
  generated or mechanically checked from manifests and executable gates. The constitution says what
  must be true; executable gates say whether it is.
- **Convergence never makes philosophy immune to evidence.** Both regressions in the first
  remediation batch (`packs` selection, `vol ?? iv`) were introduced while implementing agreed
  findings, and the positional-kernel problem was an agreed finding that was wrong. Every
  implementation batch—including Wave 6, Phase 3B, and Phase 4—lands with adversarial verification
  against built artifacts before its statuses flip. A reproduced user-safety failure can reopen a
  settled premise; the correction and its blast radius must then be recorded explicitly rather than
  minimized as an isolated exception.

## Phase 3B closeout — final counts and package evidence (2026-08-19)

Published per the 3B.6 exit checklist; every number below is quoted from the committed generated
artifacts (`public-contracts.json`, `public-enforcement.json`, `public-naming.json`) and each is bound by an executable
gate — a manual checkbox cannot waive drift.

**Surface:** 7,791 public paths / 2,663 implementations / 1,546 input contracts / 1,898 result
contracts / 378 validator identities. **Enforcement:** 2,441 enforced · 2,674 partial (every open
dimension named) · 0 defective · 187 unmeasured (each with a recorded reason) of 5,302 measured
candidates. **Ledgers:** helper quant-answers 0 of an initial 36 (all 27 H-decisions implemented);
34 positional pairs retained with per-entry rationale, 0 migrated; unnameable parameter contracts 8
(all foreign, none unreachable, as recorded by the current contract inventory);
naming identities 41,983 with 0 unresolved. These live counts include the September MCP experience
surface, the public `optionFlowDrift` and `observedSkew` APIs, the September 9 signed-leg
simplification (six direction-specific helpers replaced by three instrument-first constructors),
the September 16 valuation-instant law (the strict `resolveValuationAsOf` door, the shared US session
table and market-day boundary, and the stamped market-snapshot `asOfConvention`) and the September
18 assumptions-and-units repairs (one Greek unit system, required volatility scale, leg-volatility
premiums, the position's own horizon, agent-boundary assumptions, contract multipliers that never
default, and the options grammar corrections);
the separate review repairs are locally verified complete on `dccfce53` plus the repair changes.
Stage 5A/5B remain maintainer-held; neither these counts nor local verification authorize publication
or claim hosted-matrix success. The additional unmeasured
row is the caller-implemented `ExecutionJournalStore#transact` interface, not lost measurement of
an existing implementation; its memory/file implementations have their own focused evidence.

Package-by-package measured records (total · enforced · partial · unmeasured): MCP 3·1·2·0 backtest 68·26·35·7 calendars 4·4·0·0 cli 12·4·3·5 commodities 14·14·0·0 core 51·29·11·11 crypto 9·9·0·0 fixed-income 100·36·47·17 foreign-exchange 13·12·1·0 fundamentals 97·96·0·1 http 3·0·3·0 math 89·30·51·8 options 174·149·18·7 performance 64·19·44·1 portfolio 31·6·22·3 research 30·23·6·1 risk 69·39·29·1 scenarios 6·0·2·4 strategy 82·6·68·8 structure 14·2·5·7 technical-analysis 1,287·575·687·25 valuation 50·41·9·0 volatility 107·69·20·18 workflows 32·8·13·11 and the umbrella 2,893·1,243·1,598·52. These totals reconcile exactly to 5,302 candidates; umbrella aliases inherit
evidence only when their implementation identity and input policy match.

Ownership closes by reconciliation, not erasure: statically-unattributed object contracts are
proven behaviorally by the enforcement artifact or belong to three named machinery classes (error
constructors, the schema machinery itself, per-tick open-bar stream receivers) — the 3B.6
ownership gate in `contract-conformance.test.ts` holds the remainder at exactly zero.

### Post-closeout ratchet hardening (2026-08-26)

The merge-readiness review did not reopen Phase 3B, but it strengthened the permanent evidence every
Stage 4 API inherits:

- `stableSum` now preserves representable cancellation and tiny residuals independent of input order,
  with an exact IEEE-754 superaccumulator fallback when floating partials overflow; NPV and additive
  financial canaries pin those answers;
- the overflow sweep materializes every declaration-visible union alternative instead of relying on
  a hand-written branch registry, so adding a new method arm cannot silently remove it from evidence;
- public resource controls use a path-aware, declaration-derived inventory that restores positional
  parameter names, distinguishes metadata/continuous coordinates from budgets, and requires typed
  refusal at the library-wide outer safety ceiling;
- volatility calibration iterations, Heston COS terms, fixed-income lattice density, technical-
  analysis lookbacks, paging controls, all declaration-proven math iteration budgets, and
  Gauss–Legendre node construction carry explicit operation-level bounds with no package-tier skip;
- the newly measurable OLS options boundary rejects unknown fields and malformed nested HAC options,
  while array-returning callbacks and objects containing callbacks are both pinned in the evidence
  parser; and
- technical-analysis eager-stream and persisted nested-stream cardinalities are refused from array
  length before element traversal or decode allocation; `KstStream` retains its source-compatible
  `number[]` constructor while enforcing exactly four periods at runtime, and SMA restore rejects a
  buffer longer than its period before reading element zero; and
- the remaining intentional `Number.isInteger` calls are ratcheted by TypeScript AST call-site
  identity and rationale, so comments or a same-file substitution cannot satisfy the inventory.

These are permanent conformance gates, not one-time review tests. FC7 and every later slice must
extend their declaration coverage and direct operation canaries in the same implementation commit.
