# C4 approved; upstream integration budget checkpoint

Coordinator a55531a4 approved d6cc42b with starter project-boundary and scanner diagnostic
precision corrections. Those corrections are recorded in the spec before any C4 runtime work.
Feature/execution unchanged, in_progress. No public source signature or C4 runtime repair yet.

C4 tree /Users/agent/ri/.work/worktrees/totalfinance/totalfinance-c4-review, branch
totalfinance/community-connector-review-updates. Merge of freshly fetched main ca122ab3115ea08cc8789fd7d1be8380382fdc6c
into d6cc42b is IN PROGRESS, common base d50b401. Authored conflicts are reconciled: both warning
families, upstream0.1.3 metadata/TA/runtime/release tooling and connector additions retained. Root
cap stays703KiB; upstream root rationale retained without adding cap increments. Generated conflicts
remain explicitly unresolved for generators after final source. Count prose and fixture join are
not final measurements. No old inventory has been selected or committed as combined proof.

## Actual pre-repair measurement

Node22.23.2/pnpm10.32.0 frozen install passes (usual not-yet-built CLI bin-link warnings).
The main baseline is a git archive of exact ca122ab, with no source mutations. The integrated
candidate is this authored source, before any C4 signature/semantic/diagnostic/starter change.
Every entry is measured twice with exact byte and retained-graph equality. No cache/retry/compiler/
bundler option or shared helper/registry optimization. Same whole-entrypoint browser esbuild/gzip
settings as the actual budget gates; all structural sentinel checks pass.

| Whole root            |         Minified bytes | Gzip bytes |               Relevant cap | Result            |
| --------------------- | ---------------------: | ---------: | -------------------------: | ----------------- |
| Main ca122ab          |                2640870 |     714320 |     714496 (main697.75KiB) | pass              |
| Historical final C3   | recorded in C3 receipt |     719201 |                     719872 | pass (historical) |
| Integrated pre-repair |                2662676 |     720687 | 719872 (C3 retained703KiB) | **815B over**     |

Integrated /data is unchanged13589B against13824B. Whole-budget test reports33 passed/1 failed
(root only). All other narrow whole caps pass. This is not installed/guard/browser consumer or C4
acceptance; no new packed/provider/starter/hosted tests claimed. Main-only and integrated root have
377 and384 retained modules respectively; all module IDs, rendered contributions, repeat measurements
and per-source SHA256s are in community-connectors-c4-integration-measurements.json. Main root
retained-graph SHA256 fb3a9a08227ae8ce72b84b37455c93f55bcc284721a7c1ac00be328e1363dd41;
integrated f7cce51cdd9d01e196a3eb3f6212d685304f77ce0456ec1979f6fc5e02f39986.

The combined source adds6367B over current main; upstream integration adds1486B relative to the
old C3 measurement. These are measured totals, not additive cap permissions. C4 has no incremental
runtime cost measured yet. There is no basis to claim a final C4 allowance now. No threshold change
is proposed or made. Technical disposition is needed for the integration-only overage before
claiming unchanged budgets can accept the remaining repairs. A reasonable next disposition is to
continue approved repairs under measurement, then review the final source's total root cost; any
actual cap change still requires concrete final evidence and separate approval.

Reproduce from repository root:

```sh
pnpm exec tsx tools/community-connectors-c4-measure.ts /tmp/tf-c4-main-baseline "$PWD" /tmp/tf-c4-integrated-budgets.json
pnpm exec vitest run tools/bundle-size/budgets.test.ts
```

Receipt inputs name this machine's independent baseline path; it is generated with
`git archive ca122ab3115ea08cc8789fd7d1be8380382fdc6c` extracted to that directory, not a maintainer
SDK artifact dependency in the planned public starter guide. Log /tmp/tf-c4-integrated-budget-tests.log.
No integration commit/generated-zero-defect/current-head hosted proof is claimed. PR26 remains
unchanged/draft at e5; original C1/C2/C3/originating/shared checkouts untouched. No staging/secrets/
allowance/account/paper/API-server/version/publication/deployment/provider remote/automation/live action.
