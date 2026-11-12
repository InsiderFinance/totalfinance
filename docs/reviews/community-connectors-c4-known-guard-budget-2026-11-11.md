# Required known-schema diagnostics correction: changed measurements

Request c07bdbc9 approved ONLY the eight prior proposed caps and required broader known-guard
repair. Informational correction c3b94a18 requires malformed expected pages to be caller InputErrors
before any provider call. Both source corrections are implemented. Exactly the approved caps are
applied, without other threshold changes. They do NOT fit this corrected source. This is the
requested concrete changed-cost checkpoint, not a new allowance proposal or source acceptance.

## Corrected public behavior

Fresh installed SDK SHA256 `d6a20f1491631d5eee94ebfeac0089154534518af6858c99e1c099b87f279a46`:

| Supplied fault          | Controlled path            | Reason        | Phase / public door                            |
| ----------------------- | -------------------------- | ------------- | ---------------------------------------------- |
| deleted strike          | data[].terms.strike        | missing_field | page / createDataView                          |
| deleted timestamp       | data[].bar.timestampMs     | missing_field | page / createDataView                          |
| bad freshness enum      | metadata.freshness.status  | invalid_enum  | page / createDataView                          |
| capability maxPageSize0 | capabilities[].maxPageSize | out_of_range  | capabilities / defineDataProvider.capabilities |

Omitted metadata, metadata.times and row bar objects also report their known paths as missing_field;
explicit undefined follows the scanner's safe projection. Known SDK guards are marked at the actual
failure site. Pure request InputErrors retain their original class/code. The response boundary trusts
only that private SDK mark, not provider-forged context. The finite schema map covers normalized
page/row/capability guards, not only original examples. The canonical scan's finite/no-accessor/work
limits remain; known scanner paths use bounded own-descriptor lookup, never a second whole traversal.
Unknown/malicious/phase-inappropriate paths remain generic. No raw values, arbitrary paths/provider
text, global mutable walk context, logging framework or broad async acquisition catch is introduced.

Known row failures retain rowIndex; walks/kit attach actual pageIndex. Capability failures use the
capabilities phase/door. Kit expectation preflight returns an InputError with registered input code,
controlled detail and field=probes[].expectedPages; the installed closeNaN expectation proves calls0.
Actual provider failures stay DataErrors. See community-connectors-c4-installed-known-guards.json.

Meaningful correction regressions failed before repair. Latest focused result:215/215 across8files
(205 data cases plus10 error/first-touch), including omitted/explicit undefined, known page/date/row/
capability paths, enum/range/missing reasons, alias/phase redaction, forged context, accessor safety,
expectation blame and prior semantics. Build/types/scoped lint pass. Fresh installed reference provider
83/83, fixture/corpus/SMA101.5/refusal/TS/browser proofs pass. Exact root example returns119.5 on one
and three pages; installed NodeNext/Bundler and namespace identity pass.

## Actual cost after the correction

Repeated min/gzip/retained graphs match on pinned Node22.23.2/pnpm10.32.0 and unchanged compiler/
bundler settings. Main root714320B (actual repository cap714496B), pre-C4 integrated720687B,
prior scoped C4721811B, corrected C4722908B. Candidate cap722176B is labelled separately from main's
actual cap. No shared helper/registry/financial optimization or Rollup-option change.

| Gate                      | Previous measured | Corrected gzip | Approved cap | Overage |
| ------------------------- | ----------------: | -------------: | -----------: | ------: |
| whole root                |            721811 |         722908 |       722176 |     732 |
| whole /data               |             14598 |          15663 |        14848 |     815 |
| named connect esbuild     |             14040 |          15102 |        14336 |     766 |
| named connect Rollup      |             11906 |          13009 |        12288 |     721 |
| root data.connect esbuild |             14705 |          15759 |        14848 |     911 |
| root data.connect Rollup  |             11919 |          12990 |        12288 |     702 |
| restore esbuild           |             12841 |          13884 |        13056 |     828 |
| restore Rollup            |             12862 |          13897 |        13056 |     841 |

Root minified2669729B (previous2666345); /data48691B (previous45352). Root correction adds1097B gzip;
/data1065B. The full finite schema coverage, SDK guard provenance and phase/expected-input blame
replace the insufficient example-only whitelist. Cost remains in existing opt-in response-issue,
validation/call/view/connection modules. Retained module SETS are unchanged (root385 and every
installed case); no new provider/HTTP/credential/kit/unrelated-domain modules enter /data. Named/root
Rollup errors.js contribution is2595B versus2553B, still pruned (not the full10471B registry). Restore
already retains full errors.js; its graph is also unchanged. Whole tests:32pass/2sizefail. All other
whole caps/structural exclusions stay unchanged.

Measurements and source hashes: community-connectors-c4-known-guard-measurements.json. Raw final
receipts: /tmp/tf-c4-final-known-whole.json, /tmp/tf-c4-guard-latest-installed.json,
/tmp/tf-c4-guard-latest-provider.json, /tmp/tf-c4-installed-known-guards.json,
/tmp/tf-c4-final-known-laws.log, /tmp/tf-c4-final-known-budget-tests.log. SDK pack:
.local-connector-artifacts/insiderfinance-totalfinance-0.1.3.tgz. Provider pack remains SHA256
`9b788f10c0090c87ebdfc687e8856be8634e63d3e09306b47d5e478b9ee9295b`, used unchanged
with the new SDK in a clean consumer; its previous development-lock receipt is historical.

No larger cap is proposed. Technical disposition is required by c07bdbc9 for these changed bytes.
Same C4 merge-in-progress tree/branch, HEADd6cc42b, mainca122ab; derived conflicts/generation,
SDK integration commit, actual joined counters/public/API and fresh hosted closure remain pending.
PR26 is unchanged DRAFT/e5; feature in_progress. Reviewed/originating/shared trees are untouched.
No new offline acceptance, release/publication/version/deployment/provider remote/API-server/staging/
secrets/allowance/key/grant/account/paper/recurring/live action.

Historical precision: interim correction snapshots722865/15624 and722893/15653B are superseded by
the final values above. Retained sets are identical. The earlier full267-case run on the first interim
pack had259pass/8sizefail; latest215 source cases, final whole/installed repeats and public installed
probes certify the final source/artifact. No repeated final full267, generator or hosted pass is claimed.
