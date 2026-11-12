# C5 final scoped-source budget checkpoint — review requested

Task01a19da0-2a6f-7450-89a4-2e51047b05b5; request872db889. This is the single requested concrete
C5 budget checkpoint, not implementation acceptance. No thresholds, bundler settings, shared error
helpers/registries or financial math have been optimized or changed to conceal these overages.
PR26 remains draft at3bc356f; no C5 push or hosted pass is claimed. Feature remains in_progress.

## Exact candidate and integration state

SDK tree `totalfinance-c5-author-contract`, branch `totalfinance/community-connector-c5-author-contract`.
Authored checkpoint e0a6f381a2145c763a05e7bf8e0d227d886c006a precedes the in-progress merge of exact
main23fbf06bfe6d63387e8b45473fd064ff74d1d084 (merge-base ca122ab3115ea08cc8789fd7d1be8380382fdc6c).
The measured working source is newer than that checkpoint; its deterministic source-file fingerprint
is `ee0784bc8d9cbaa038298657f77e76e85beddb12cfb8f4953f50f7121b1a1913`. Full receipt lists each TypeScript file/hash.
Inherited versions are0.1.4, including private metadata/runtime/locks. No release-version operation ran.
Five generated merge entries remain unresolved: bundle-size, llms and public contracts/docs/naming.
They must be recreated by source-final ordered generators after this budget review, never selected
from either historical side. Combined generated/integration acceptance is explicitly pending.
An authored queue conflict in historical naming counts now states that combined counts are pending
rather than asserting either old run. Original C1–C4/reviewer observations remain unchanged.

The shared fetched origin/main subsequently advanced to3555f934275bb494855227ef27dd777022e7812e.
Its delta from23fbf06 is site/README/discovery/deployment-test work, with no packages source, root
lockfile, supported runtime or budget change. It is NOT merged into this candidate. Its latest
site/README behavior must be reconciled before final generation/PR closure; no site redesign is in C5.
This baseline is labeled23fbf06, not falsely described as latest-main integrated acceptance.

## Repeated whole-source attribution

Pinned Node22.23.2/pnpm10.32.0; each row was measured twice with identical bytes, code hash and graph.
Caps use gzip bytes with a strict less-than gate. Minified bytes are also retained in the JSON.
Baseline repository cap is recorded independently from the candidate enforcement cap.

| Root source     | Min bytes | Gzip bytes | Its repository cap | Candidate cap | Modules |
| --------------- | --------: | ---------: | -----------------: | ------------: | ------: |
| main            |   2650952 |     718019 |             718336 |        723200 |     378 |
| c4              |   2669729 |     722908 |             723200 |        723200 |     385 |
| integratedPreC5 |   2679813 |     726548 |             723200 |        723200 |     386 |
| c5              |   2699577 |     732244 |             723200 |        723200 |     392 |

Main→integrated pre-C5 grows8529B because the existing C4 connector workflow is added to current
upstream code. C4→integrated pre-C5 grows3640B from actual upstream integration. Final C5 adds5696B
gzip over that integrated baseline. Root adds only six C5 core modules: data-protocol, data-provider,
data-provider-error, data-selection, data-window-view and data-legacy-window. These implement source2
normalization, portable declarations, decisions/checkpoints and honest v1 restoration. No external
provider, HTTP client, fixture, credentials, retry/cache or worker module enters an ordinary graph.
Existing source/view/validation modules shrink as responsibilities move; retained byte deltas are
in the JSON. Tiny scenario identifier-size differences are bundler output changes, not scenario edits.

All seven narrow overages have IDENTICAL retained module sets versus integrated pre-C5; their only
changed module is errors.ts (+96 minified retained bytes for the two required registered safe codes,
data.provider_failure and data.suspect_observations). No acquisition module leaks into those graphs.
Upstream black-scholes15.375KiB, workflows509.5KiB and analytic-premium structural guards are preserved.

## Proposed exact limits (not applied)

| Whole entry                                    | Current cap B | Actual gzip B | Proposed cap B | Headroom B |
| ---------------------------------------------- | ------------: | ------------: | -------------: | ---------: |
| packages/math/src/montecarlo.ts                |          7584 |          7603 |           7616 |         13 |
| packages/calendars/src/crypto.ts               |          5024 |          5040 |           5056 |         16 |
| packages/performance/src/sector-performance.ts |         10752 |         10770 |          10784 |         14 |
| packages/fixed-income/src/lattice.ts           |         13184 |         13195 |          13216 |         21 |
| packages/fixed-income/src/convertible.ts       |          8992 |          9012 |           9024 |         12 |
| packages/portfolio/src/trade/index.ts          |         79360 |         79389 |          79424 |         35 |
| packages/backtest/src/paper/index.ts           |         38016 |         38035 |          38048 |         13 |
| packages/totalfinance/src/data.ts              |         15872 |         21338 |          21504 |        166 |
| packages/totalfinance/src/index.ts             |        723200 |        732244 |         732672 |        428 |

| Installed case | Bundler | Current cap B | Actual gzip B | Proposed cap B | Headroom B |
| -------------- | ------- | ------------: | ------------: | -------------: | ---------: |
| data-named     | esbuild |         15360 |         20676 |          20992 |        316 |
| data-named     | rollup  |         13312 |         18631 |          18944 |        313 |
| data-root      | esbuild |         15872 |         21395 |          21760 |        365 |
| data-root      | rollup  |         13312 |         18596 |          18944 |        348 |
| data-restore   | esbuild |         14080 |         15985 |          16128 |        143 |
| data-restore   | rollup  |         14080 |         13754 |          14080 |        326 |

Restoration Rollup already passes14080B: no increase proposed. Whole root proposed715.5KiB, /data21KiB;
named esbuild20.5KiB/Rollup18.5KiB, root esbuild21.25KiB/Rollup18.5KiB, restore esbuild15.75KiB.
Narrow changes are32B increments except trade64B. Small explicit headroom is only for measured work.
Every other cap/settings/exclusion stays unchanged. All48 existing ordinary/guard/browser installed
cases pass their existing byte and module laws; all54 cases (including six data cases) pass structural
checks. Current whole gate truthfully reports25 passed/9 failed; installed reports five byte overages.

## Avoidable retention investigation (historical failed iteration)

An interim broad synchronous capture callback/catch-observable enum property access made installed
named Rollup retain the full errors catalog (10579B contribution,20740B gzip). Narrow source phases
now catch only actual reads/local validations, with view construction outside those catches. Three
registered enum values are bound locally outside catch-observable phases; shared registries/helpers
are unchanged. Final Rollup errors contribution is3086B and named gzip18631B. This is a feature-local
catch-placement correction preserving the C3/C4 pruning law, not a proposal to fund avoidable catalog
retention. Prior failed measurements remain in /tmp/tf-c5-\*-diagnostic.json and prior iteration receipts.

## Source and independently installed proof

- Root build and typecheck pass. Scoped ESLint22 files and scoped formatting pass.
  -403 source tests/17 files pass, including all C4 data controls,65 C5 cases,45 shared-kit cases,
  40k restore, first-touch and selected upstream numerical regressions. Public packed-consumer test1/1 passes.
- IF builds/typechecks against the actual file SDK0.1.4;86/86 cases pass locally and freshly installed
  (all83 migrated original behaviors plus three before-read private-cursor pin controls).
- Exact two-import primary gives119.5 on one/three HTTP pages; strict NodeNext/Bundler and namespace
  identity pass. Installed fixture/HTTP corpus gives101.5/SMA.explain/VWAP/refusal and browser compute proof.
- A REAL separate installed SDK error copy retains safe rate-limit code/status/retry hint; class copies
  differ, public JSON is redacted, local cause retained. Unknown network is provider_failure.
- Independently packed starter+copied Alpaca-style author pass7/7; strict natural source typing needs
  no return assertions. Source04Z/flags/immutable bars/unchanged engine parity and page3 throttle/manual
  resume with no refetch pass. Literal independent expected rows/unit scale remain external truth oracles.
- No-key runner passes independent project boundary,103/102, warnings/storage/warmup, NaN error repair
  and finite wrong-unit oracle. A clean committed-checkout verbatim full recipe remains a closure gate
  after generated merge resolution; this checkpoint does not claim that unfinished clean-tree proof.

Provider source/receipt commit is `10ee5242a7554f10966d34e55f16002ba0911a5a`, clean isolated provider tree,
with the same pack hash rechecked from committed source. No provider remote exists.

Candidate artifact hashes (local packs, not registry0.1.4 compatibility):

- sdk: `a3144664aaa3b01ffa350c2b9dafc6e6c186709f24674590b7bc73d63b6bcda1`.
- starter: `e56b775e0eaf7944a2c11418da6238e1775426c3947438e9bf457df192e18abb`.
- author: `8a8e43e767beb6a990654531130f958b3f6a0362431fb90aae05381ffedd1b12`.
- IF: `71bfad932410ed6d22e5eaebf98e827d754f9508cfe1d2ec2bae2af9fdee1c55`.

## Reproduce and remaining closure

All commands use the pinned runtime on PATH. Canonical scripts and full JSON/log receipts:
`/tmp/tf-c5-final-{whole,primary-installed,all-installed,provider-installed,authors-installed}.json`,
`/tmp/tf-c5-final-{integrated-tests,public-consumer,starter-installed,budget-tests,types,lint}.log`.
The machine-readable adjacent JSON retains proposals, min/gzip, source fingerprints and exact graphs.
`tools/community-connectors-c5-measure.ts` takes main/C4/integrated-pre-C5/C5 tree paths and a receipt.
`community-connectors-connection-consumer.ts` takes SDK/provider packs and a receipt; the installed
measure script takes that receipt and an output. Provider/author smoke scripts document exact arguments.

After technical budget disposition: apply ONLY approved limits; reconcile latest upstream site/docs
without losing its behavior; source-final ordered generation resolves five derived conflicts and
refreshes actual counters; public/API/reference/docs/full packed+ordinary gates; clean verbatim guide;
fresh committed-source packs/locks/hashes; reviewable combined SDK/provider commits; fast-forward SAME
draftPR26 only after local gates and run exact-head FAST+FULL. No hosted C5 jobs are queued or passed.
No merge/publication/new version/deployment/provider remote/private/live action occurred.
