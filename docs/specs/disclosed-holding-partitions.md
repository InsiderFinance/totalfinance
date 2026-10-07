# Disclosed holding partitions

Status: HP1–HP5 implementation and independent local verification complete October 6, 2026
at `612fed23e094c7468d9398ebb1e9edb644af8904`. This consumer-requested additive feature follows
the completed disclosed-holdings comparison.
The FMP consumer owns source acquisition, authenticated mappings, report selection and handoff.
This specification owns the provider-free calculation. No release or publication is authorized.

## Outcome and non-goals

`compareDisclosedHoldingPartitions` preserves reported common-stock lines separated by investment
discretion and filing-local other-manager references. It computes reported-partition weights and
concentration for complete supported snapshots, and conservative changes on stable no-reference
partition bases. It does not infer ownership, trades, assets under management, security-level
concentration, net exposure, manager identity, amendment ancestry, prices or corporate actions.
It performs no I/O, source lookup or clock access. Existing v1 public types and output remain intact.

## Decisions

1. One direct analysis function under the portfolio domain, dedicated
   `@insiderfinance/totalfinance/portfolio/disclosed-holding-partitions` import and root `portfolio`
   namespace. Top-level request is closed `{ baseline, current, comparisonMode, policy }`.
   No new operation or MCP tool. Output is JSON-safe and accepted by `createAnalysisArtifact`.
2. Explicit closed policy is `supportedProfile: 'common-stock-reported-partitions-v1'`,
   `discretionPolicy: 'reported-partitions-without-cross-manager-netting'`, and integer
   `ratioDecimalPlaces` 0–18. Report policy version is `disclosed-holding-partitions-v1`.
   No policy defaults. The validated detached policy is echoed in assumptions.
3. Snapshots retain the current manager/date/report/evidence IDs, independent completeness flags,
   reviews and all observations. Managers must match; period changes strictly increase dates;
   same-period revisions require equal dates and distinct selected report sets. Structural
   snapshots/rows are open, but every consumed field is validated and copied. Each new row has
   required `sourceReportId` belonging to its snapshot's selected `reportIds`, and
   `otherManagerReferences: readonly string[]` replaces the old `otherManagerIds` only in these
   new types. Generic opaque reference strings are exact, unique, nonblank and at most 512
   characters; sorting never coerces numbers, whitespace, case or global identity. SEC sequence
   grammar/membership is the consumer's responsibility, expressed by row review reasons.
   An already-reviewed row may retain repeated opaque reference tokens solely as an unkeyed
   row outcome with `invalid_other_manager_references`. Unreviewed duplicates receive typed
   refusal. This narrow evidence-preservation rule never deduplicates or qualifies such rows.
4. Supported rows have mapped nonnull issuer/security/class IDs, `common_stock`, `SH`, no option,
   recognized `SOLE`/`DFND`/`OTR`, valid boundary fields and no row reviews. Unsupported or unresolved
   rows remain visible. A keyed row has nonnull security/class IDs; its structured `partitionKey`
   has securityId, classId, investmentDiscretion and sorted otherManagerReferences, with optional
   sourceReportId present only when references are nonempty. Empty-reference lines from separate
   selected reports thus encounter the same duplicate guard. The key's private canonical encoding
   is JSON, never delimiter concatenation. Multiple rows in one partition receive
   `duplicate_partition`; they are not summed. Contradictory issuer/class identity for a security
   receives `conflicting_security_identity`. Distinct security IDs with distinct classes remain
   separate. Already-reviewed repeated-reference rows have null keys and cannot supply a partition.
5. Snapshot `holdings` contain all row outcomes and nullable structured keys. `partitions` contain
   all keyed groups: key, issuerId, holdingIds, evidenceIds, exact quantity/reportedValue,
   valueCurrency, partitionWeight, status and reasons. Unsupported/ambiguous groups withhold amounts.
   The shared private BigInt base-ten arithmetic normalizes amounts, multiplies literal scales
   `1`/`1000`, adds values, subtracts differences and rounds ratios once half away from zero.
   Input decimal grammar and ceilings are unchanged: nonnegative plain strings, at most 100 digits
   and 18 fractional places. No formula is duplicated in transport or consumer.
6. Denominator is all supplied reported values. It is available only with all independent gates
   true, no snapshot/row review, supported unique groups and one currency. Never use a mapped subset.
   `concentration` has denominatorReportedValue, valueCurrency, largestPartitionWeight and
   partitionHerfindahlIndex; the latter uses exact unrounded operands. Empty/zero totals are exact
   zero with unavailable ratios. Zero observations remain disclosed. Mixed currencies withhold
   total/ratios, and no conversion is inferred. Rounded partition weights need not sum to one.
7. Cross-snapshot joins are only security/class/discretion with empty reference sets. Any reference-
   bearing row on either side withholds every group difference and inferred partition presence for
   that security/class, including a reviewed unkeyed row retaining repeated references.
   If the group is present on both sides but no-reference discretion sets
   differ, the same entire-group withholding applies. Distinct no-reference keys of an otherwise
   stable group compare independently; different authenticated classes stay distinct.
8. `changes` has structured key, issuerId, baseline/current holding IDs, classification,
   baseline/current quantity/value, exact differences, currency and typed reasons. Classifications
   are newly_disclosed/still_disclosed/no_longer_disclosed/unknown. Arithmetic and any classification
   require complete supported evidence on both sides; justified absence supplies zero only then.
   Identity conflicts/duplicate partitions/unsupported rows withhold affected results. A currency
   mismatch additionally withholds value differences, without converting values. Facts remain visible.
9. Reference-bearing and changed-basis groups produce side-specific `uncomparedPartitions`, each
   containing side, key, issuerId, holdingIds, evidenceIds, exact supported quantity/value, currency,
   classification unknown and explicit typed reasons. These groups produce no change records.
   Every keyed partition occurs exactly once on each present side through a change or an uncompared
   record. Unkeyed rows remain represented once among holding outcomes. No cross-filing reference
   match or absent zero is fabricated. Warnings use the existing registered portfolio disclosure
   review code. Reasons are finite exported unions; source reviewReasons remain free-form.
10. Deterministic code-point order, nonmutation and detached copies are required. Holdings sort by
    holdingId; partitions/changes sort by canonical structured identity; string lists use exact
    code-point order. Bound before
    traversal: 25,000 rows/snapshot, 256 reports/evidence IDs, 256 snapshot review reasons and 64
    row refs/evidence/reasons. Dense arrays, own data fields, malformed objects/decimals/accessors,
    duplicate IDs or unreviewed duplicate reference tokens and unknown request/policy fields receive indexed typed
    InputError with registered core codes. The private validator helpers are separate so old v1
    error labels/output do not change. Transport resource ceilings remain the consumer's contract.
    Already-reviewed reference duplicates follow only the evidence-preservation exception in Decision 3.

## Ordered slices and acceptance

- [x] HP1: register this bounded row and independently review this contract before semantic code.
- [x] HP2: new separate types/boundary/report and conservative grouping/basis/accounting; share
      private decimal arithmetic while preserving current v1 source, literals and output.
- [x] HP3: exact independent rational oracle, complete/incomplete gate matrix, SOLE/DFND/OTR mixed
      partitions, multiple reports, scoped references, basis redistribution, duplicate/identity
      conflict, authored addition/removal/revision/zero and rounded/unrounded cases, adversarial
      runtime bounds/accessors, nonmutation/permutation and full partition accounting.
- [x] HP4: public root/domain/deep exports, hand-curated manifest, first-touch/compile-fail tests,
      artifact serialization, executable guide, changeset and packed NodeNext/Bundler consumers.
- [x] HP5: canonical regeneration sequence, format changed files only, full CI, separate API check,
      independent full coverage repeat and clean-commit regeneration. Synchronize this spec,
      implementation order and completeness tracker against exact evidence; no release bump.
- [ ] HP6: review polish without changing calculations: document the three caller attestations,
      teach one calculation before optional storage/import variants, retain exact-oracle and
      exhaustive completeness/basis regression matrices in CI, and verify regenerated references
      and installed-guide consumers. Preserve HP1–HP5 semantics and all existing verification gates.

## Verification record

The verified revision is `612fed23e094c7468d9398ebb1e9edb644af8904`, integrated over main
`2dc1927cdab6051861ed32cc229e787acf783f84`. Calculation source is unchanged from
`acef3949303cae288588ac3c8ff21092c3517e0a`; this closeout changes tracking prose only.

- Literal full CI passed with 579 library test files / 12,852 tests, 8 site files / 80 tests,
  and 25 API reports. Coverage was 94.21% statements, 84.16% branches, 97.02% functions and
  94.77% lines. Separate API checking passed.
- An independent full coverage repeat passed all 579 files / 12,852 tests at the same revision.
  An isolated clean committed checkout completed the full canonical `regen:check` chain with no
  tracked changes; documentation inventory had 233 surfaces, 4,540 executable fences and no findings.
- The new profile has 51 authored tests; 154 focused tests include the existing disclosed-holdings
  regressions. All 218 packed-consumer tests passed, including NodeNext and Bundler imports.
- An independent exact rational oracle passed 120 cases / 19,166 assertions; boundary review passed
  486 assertions. Existing contracts, names, signatures and v1 calculation sources were preserved.
  Independent review has no open findings.

One earlier full-CI attempt passed every test but exited unsuccessfully with an unhandled Vitest
`onTaskUpdate` RPC timeout. Its cause was not established. The complete unchanged rerun passed;
no worker settings, timeouts, coverage floors or implementation were changed for that retry.

[PR #11](https://github.com/InsiderFinance/totalfinance/pull/11) carries the implementation.
Final-head hosted checks remain required before merge. Local verification does not authorize
npm publication, a version bump or production consumer cutover.
