# Disclosed holdings comparison

Status: DH1–DH7 implementation and review verification complete, October 2, 2026, at
`69b9ef92094f16b5f4fa881229b586ecb1c3f67e`. The final PR head's hosted checks remain the merge gate.
This bounded consumer-requested
compute addition follows the FMP rebuild's SEC-125 handoff; it does not authorize release,
publication, deployment, or reopening the existing portfolio ledger. The library alignment laws
remain controlling. API semantics are settled here; the FMP repository owns provider facts and order.

## Outcome and non-goals

`compareDisclosedHoldings` compares two caller-supplied disclosure snapshots without fabricating
trades, cash, cost basis, returns, or ownership percentages. It preserves every supplied holding,
reports exact disclosed quantity/value changes where evidence supports them, classifies presence,
and calculates weights and concentration in an explicitly complete supported reported universe.

No network, database, credentials, process clock, filing/amendment selection, price lookup, corporate
adjustment, sector classification, cross-manager overlap deduction or outstanding-share inference.
The Python integration owns publication/source/system cutoffs, receipt hashes and evidence retrieval.

## Decisions

1. One direct analysis function in `@insiderfinance/totalfinance/portfolio`, also available through
   `@insiderfinance/totalfinance/portfolio/disclosed-holdings` and root `portfolio` namespace. No new
   MCP tool or operation-registry transport. It returns an artifact-compatible report with
   `assumptions` and `diagnostics.warnings`. Policy version is `disclosed-holdings-v1`.
2. Top-level input is closed: `{ baseline, current, comparisonMode, policy }`. `comparisonMode` is
   required: `reported-period-change` requires strictly increasing valid YYYY-MM-DD report periods;
   `same-period-revision` requires equal periods and distinct selected report sets. Both managers
   must be identical. This labels revised disclosure differences, never trades. Report IDs and
   evidence IDs are explicit nonempty unique lists. The library does not select amendment ancestry.
3. Each snapshot supplies `managerId`, `periodEnd`, `reportIds`, `evidenceIds`, `reportComplete`,
   `mappingComplete`, `comparisonEligible`, `reviewReasons`, `holdings`. Completeness flags are
   independent explicit booleans. A false flag or supplied review reason withholds absence inference
   and whole-universe weights, while all observations remain visible. Contradictory `mappingComplete`
   with unresolved rows is handled as review, never silently trusted. Structural snapshots and
   holding observations accept harmless decoration but validate and copy only consumed fields.
4. Each holding supplies `holdingId`, nullable `issuerId`, `securityId`, `classId`, `mappingStatus`
   (`mapped` or `unresolved`), `instrumentType`, `quantity`, `quantityUnit`, `reportedValue`,
   `valueCurrency`, `valueScale`, `putCall` (`none`, `put`, `call`), `investmentDiscretion`,
   `otherManagerIds`, `evidenceIds`, and `reviewReasons`. Original details of mapping failures stay in
   `reviewReasons`. Distinct holding IDs are mandatory within each snapshot. IDs are opaque,
   nonblank, at most 512 characters; arrays are dense, string lists are unique and bounded.
5. Supported policy is explicitly selected with
   `{ supportedProfile: 'common-stock-shares-v1', discretionPolicy: 'sole-without-other-managers',
ratioDecimalPlaces: number }`. Ratio precision is an integer 0–18. The profile requires resolved
   issuer/security/class IDs, `instrumentType: 'common_stock'`, `quantityUnit: 'SH'`, `putCall: 'none'`,
   `investmentDiscretion: 'SOLE'`, no other-manager IDs and no row reviews. Every other row remains
   present with explicit review reasons. Other-manager references need not be global identifiers:
   this conservative profile never combines shared discretion. Multiple supported rows with the same
   security/class are reviewed as possible duplicated disclosure, not summed. Multiple classes are
   separate positions; contradictory issuer/class identity for one security is reviewed.
6. All quantities, reported amounts and value scales are decimal **strings**, never JS numbers.
   Amount grammar is `0` or a nonzero-leading integer, optionally followed by `.` and one or more
   digits; no signs, exponent, whitespace or leading zeroes. At most 100 total decimal digits and
   18 fractional places. Trailing fractional zeros are accepted. `valueScale` is exactly `1` or
   `1000`; multiplication belongs to TypeScript. Zero is valid. Inputs are preserved as supplied;
   normalized amounts, sums and signed differences are canonical decimal strings without trailing
   fractional zeros or negative zero. Private BigInt decimal arithmetic preserves every digit; no
   financial amount passes through IEEE-754. Overflow is bounded by input/row ceilings, not clipping.
7. Matched positions are keyed by `(securityId, classId)` with issuer identity checked. Position
   quantities/values are available only for exactly one supported row. Unsupported or ambiguous
   groups are retained with null calculations and reasons. Every raw row is represented exactly
   once, including unresolved rows lacking a position key. Missing issuer IDs never imply an issuer.
8. The declared denominator is the sum of **all supplied reported holdings**, available only if
   report/mapping/comparison flags are true, review reasons empty, all rows supported, all groups
   unambiguous, and one reported currency. There is no eligible-only substitute denominator.
   Empty or zero-value universes have exact total `0` but null ratios with an explicit reason.
   Mixed currencies withhold total/ratios; no FX is assumed. Weights are `value / total`, largest
   weight is maximum value / total, concentration is Herfindahl `sum(value²) / total²`. Compute
   ratios from exact operands, round once half away from zero at the requested precision, emit
   canonical decimal strings. Rounded weights need not sum exactly to one; this is disclosed.
9. Presence classifications are `still_disclosed` for a supported matched pair, `newly_disclosed`
   or `no_longer_disclosed` only if both complete supported snapshots establish absence, otherwise
   `unknown`. Report-level completeness gates also withhold deltas where missing rows could alter
   totals. For a justified absent side quantity/value are zero. Same-security changes in class or
   issuer withhold differences/presence for affected keys; no conversion ratio is inferred. Value
   differences additionally require matching currency. Quantity differences are reported changes,
   not purchases/sales; market movement and corporate actions can explain value/quantity changes.
10. Deterministic report ordering uses code-point lexical comparison, never locale. Evidence lists,
    report IDs and review reasons are normalized sorted copies. Holdings sort by holdingId,
    positions/changes by security/class. Input permutations and harmless decoration do not change
    the report. No mutation, I/O or system time. Resource ceilings: 25,000 holdings per snapshot,
    256 selected report IDs, 256 snapshot evidence IDs, 64 per-row evidence/manager/review strings,
    256 snapshot review strings; reject bounds before traversing/allocating. Consumed accessors,
    sparse arrays, wrong primitives and malformed decimals receive indexed typed `InputError` using
    registered core error codes. Aggregate warnings use a registered portfolio warning code.
11. Output records `policyVersion`, `comparisonMode`, `baseline`, `current`, `changes`, assumptions,
    diagnostics. Each snapshot report echoes selected facts and adds row outcomes, positions, and
    concentration. Every null calculated field has row/snapshot/change reasons. Root diagnostics
    report complete/review status plus baseline/current row and change counts. The report itself is
    directly assignable to `createAnalysisArtifact({ result })` and serializes without casts.
12. Public types describe the runtime domains: `valueScale` is `'1' | '1000'`, and library-generated
    `reasons` use exported finite code unions for holdings, snapshot eligibility, concentration and
    changes. Caller-supplied `reviewReasons` remain free-form strings. `assumptions.policy` echoes a
    detached, structured copy of all three validated policy fields; consumers never parse prose to
    recover precision or supported-profile choices. This does not introduce defaults, presets,
    alternate calling forms, or a change to the disclosed-holdings-v1 financial semantics.

## Ordered slices and exit gate

- [x] DH1: review this contract before code; register the bounded implementation-order row.
- [x] DH2: exact-decimal private arithmetic, strict boundary and all-row snapshot report, matching,
      presence/deltas, denominator, weights and concentration with non-mutating deterministic output.
- [x] DH3: authored complete snapshots and independent integer/rational oracle cases; same-period
      revisions, added/removed/still positions, confidential/incomplete/mapping reviews, unsupported
      units/types/options/discretion, ambiguous/duplicate identities, multiple classes, missing/zero
      denominators, mixed scales/currencies, huge/fractional/zero decimals, invalid runtime inputs,
      resource bounds, permutation invariance and artifact save/replay.
- [x] DH4: root/domain/deep imports, curated manifest, first-touch fixtures, public types, registered
      warnings, API/signature/naming/contracts/enforcement/validation/reference artifacts, changeset,
      executable guide and installed consumer tests. Do not use manifest:update or edit generated
      files manually. Existing namespace/browser/package boundaries remain intact.
- [x] DH5: format only changed files; full local CI, separate API check and independent full coverage
      repeat; artifact regeneration stability; retain exact source/tarball verification evidence.
      Synchronize this spec, implementation order and completeness tracker truthfully. Local
      completion is not a published npm release or hosted CI claim.
- [x] DH6: literal value-scale types, typed reason codes and structured policy echo; compile-fail
      contracts and runtime copy/serialization tests, public guide, API and generated inventories.
- [x] DH7: integrate current main (including selective Greeks/exposure and the 0.1.1 release
      metadata), preserve both features' consumer tests, regenerate combined artifacts, run full
      CI, separate API check, independent coverage repeat and clean-commit regeneration, then
      synchronize these trackers. No npm publication.

**Landing gate:** the maintainer authorized merging PR #4 only after its final head's hosted checks
pass. The verified source below does not waive that gate for this documentation-only closeout.

The separately versioned offline Python/Node operator pins this reviewed artifact and all input
receipts. It contains no copy of these formulas. FMP integration acceptance is recorded in that
repository's SPEC; this library's completion does not itself activate any API.

Pre-code review accepted by independent holdings semantics reviewer September 25. Zero/empty
denominators withhold ratios without invalidating justified absence inference.

## October PR #4 review closeout

Verified implementation: `69b9ef92094f16b5f4fa881229b586ecb1c3f67e`. It includes the original PR
(`2d1c727`), current main's selective Greeks/exposure and 0.1.1 metadata (`b1edf16`), and DH6–DH7.
The closeout changes only the three tracking documents; it does not bump versions or publish npm.

The review preserves the original financial semantics and exact-decimal arithmetic. Its API repairs
make `valueScale` a truthful literal union, expose finite library reason-code types while retaining
free-form source review text, and echo a detached structured policy at `assumptions.policy`.
Compile-only contracts run both in the workspace and against installed tarballs; the guide is executed.

- Full local `pnpm run ci` passed on Node 22.23.2 / pnpm 10.32.0: **577 files / 12,788 tests**,
  plus **80 site tests**. Format, lint, both typechecks, library/site builds and all 25 API reports
  passed. Coverage: **94.21% statements / 84.10% branches / 97.01% functions / 94.76% lines**.
- The independent hosted Node 22.13.0 full-CI run repeated **577 files / 12,788 tests** and
  **80 site tests**, passing the unchanged coverage floors (functions 97.02% on that runner).
  [Exact hosted receipt](https://github.com/InsiderFinance/totalfinance/actions/runs/37094990799/job/111122988462).
  This is an actual second `pnpm test:coverage` execution within full CI, not a focused-test substitute.
- Standalone `pnpm api:check` passed all 25 reports. Clean-commit `pnpm regen:check` passed with
  byte-identical artifacts locally and in the
  [hosted generation job](https://github.com/InsiderFinance/totalfinance/actions/runs/37094990799/job/111122988317).
  The [isolated-registry release rehearsal](https://github.com/InsiderFinance/totalfinance/actions/runs/37094990799/job/111122988479)
  also passed; this is not publication to npmjs.org.
- Focused holdings tests: **103 passing**. Both holdings and selective-Greeks packed consumer
  journeys pass under strict NodeNext and Bundler resolution; the complete installed-consumer suite
  passes **216 tests**. Artifact serialization accepts the full typed report without a cast.
- The combined generated inventory has **7,863 public paths**, **42,477 naming identities with
  zero unresolved**, and **zero defective enforcement records**. All three holdings aliases are
  enforced. Narrow-import structural checks remain unchanged; measured bundle allowances are in
  `tools/bundle-size/budgets.ts`, not untracked exceptions.

Retained failed attempts found two integration/test defects, both repaired before the green runs:
the site's build test pinned the old 0.1.0 version instead of the distribution manifest, and an
inventory test incorrectly rejected every numeric-looking string literal. The replacement test
uses actual checker types to distinguish `1` from `'1'`, including a mixed domain; the independent
checker-to-artifact parity gate still covers every public declaration. No coverage floor, runtime
refusal, or packaging guarantee was weakened. No further code blocker was found in this review.

## Original September verification and source record (historical)

DH1–DH5 are complete on disposable verification commit
`79a48493869a3609af2e51b6f9fb11b694aad3d2`, based on
`009f22392832db4ac7047559cd333e53385ee2b9`, plus the reviewed documentary/inventory/bundle
contract overlays. The final three tracker closeouts are a separate prose-only overlay. No further
Git commit, package version change, publication, deployment, or hosted verification is claimed.

- Full local CI passed: **567 files, 12,598 tests**, plus **80 site tests**; formatting, lint,
  typechecks, build, site build and all 25 API reports passed. The separate API check also passed.
- An independent exact-source clone repeated the complete coverage suite: **567 files, 12,598
  tests**. Both runs passed the unchanged coverage floors: statements **94.15%**, branches
  **83.97%**, functions **96.98%**, lines **94.72%**. All 1,659 tracked source files matched
  before the final tracker closeout, and all 504 built JavaScript files matched byte for byte.
- The feature's focused suite passed **99 tests**. Independent review repaired code-point ordering
  and reject-before-traversal string bounds, then passed **300 exact numeric-oracle cases**, a
  **1,563-case completeness/presence/revision matrix**, and **25,000 rows per snapshot**.
- Literal `pnpm regen:check` passed on clean exact commit `79a4849`. After the reviewed eight-file
  overlay, all 12 unchanged canonical `REGENERATION_STEPS` passed in order and the complete
  1,659-file tracked/untracked-unignored inventory retained identical bytes and modes. This second
  check is final-overlay regeneration evidence, not a claim of a clean uncommitted Git tree.
- Installed local-tarball consumers compiled and ran the exact checked-in fixture through NodeNext
  and Bundler, plus the exact public guide: **six checks**. Tarball SHA-256:
  `707446886e275540dd76a18ca5418f87c952dd5dcc2ce60a386ae4afbfd2d5e2`.
- The frozen 1,988-file primary distribution remains identical. A separate cold build changed only
  declaration emission ordering in four existing workflows `.d.ts` files; runtime JavaScript and
  all disclosed-holdings/root/portfolio declarations stayed identical. Exact paths and both hashes
  are retained in the distribution-recheck evidence.

Interrupted attempts remain recorded. Their findings were stale human manifest-count ledgers,
new exact AST-count inventory, and expected bundle growth from the new public API and registered
warning code. Independent retained-module measurements found no tree-shaking leakage; narrow
measured whole-entry caps and a dedicated deep-import cap were reviewed before the final complete
runs. A transport watchdog overlapped a recorded 254-second host sleep; the unchanged case then
passed under coverage in 1.320 seconds. Both final complete runs used temporary `caffeinate -is`
assertions scoped to their process lifetimes. No test timeout, coverage floor, or structural bundle
canary was relaxed.

The evidence directory, relative to the adjacent FMP repository, is
`data/form13f-holdings-analytics-20260925/`. `library-proof.json` pins the final source, full-CI
receipt/log, independent repeat, clean-commit and final-overlay regeneration, local consumer checks,
independent reviews, retained failed attempts, and prose-only tracker closeout checks. These records
use pinned Node 22.23.2 and pnpm 10.32.0. The FMP repository separately owns operator integration
and actual sibling-application evidence.
