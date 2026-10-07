# Regeneration performance (PR #8 follow-up)

## Contract

Optimize the measured regeneration bottleneck without changing public APIs, financial results,
fixtures, probe selection, timeout budgets, generated evidence, or the fast/full CI policy.
The controlling request is the maintainer-approved profiling and optimization pass of 2026-10-06.
The profile may justify a behavior-preserving internal runtime optimization; it does not authorize
an API change, merge, release, or publication.

## Decisions

1. Profile the actual generator process on the pinned `.nvmrc` runtime, not its package-manager
   launcher. Separate profiling overhead from uninstrumented before/after timings.
2. Optimize proven repeated work first. Do not cache validation verdicts, reuse mutable fixtures,
   reduce financial problem sizes, skip probes, or tighten timeouts to obtain a faster pass.
3. Preserve calculation/API artifact bytes and all measurement evidence. Two fresh processes must
   agree independently, and clean-checkout regeneration must still produce no tracked changes.
   The documentation inventory may add this tracking note through its generator; that is not changed
   calculation evidence. Bundle budgets are unchanged; their report is regenerated for the changed
   implementation's actual size, never hand-edited.
4. Do not parallelize generation unless measurements justify it and input/output dependencies and
   state isolation are established. More workers are not an acceptance criterion.
5. Verify focused regression tests, types, lint, formatting, clean regeneration, and the complete
   hosted Node/coverage/determinism matrix on the final code revision before declaring it ready.

## Checklist

- [x] Capture the current generator CPU profile and baseline output.
- [x] Implement the measured optimization with regression coverage.
- [x] Compare independent output digests and uninstrumented before/after timings.
- [ ] Pass focused/static checks and clean regeneration.
- [ ] Record current-head fast and full hosted CI results.

## Starting evidence

Baseline: `b26113ee0325f121ba79b9c2fc792baaf5ac8a1d`.
The [successful fast run](https://github.com/InsiderFinance/totalfinance/actions/runs/37539079999)
spent 358 seconds in `regen:check`: approximately 205.5 seconds in `enforcement:update`,
42.4 in signatures/build, 24.2 in contracts, 19.8 in API reports, 17.3 in agent documentation,
28.6 in bundles/build, and the remainder in the smaller generators. Those are one hosted run's
observations, not a machine-independent benchmark or a promised speedup.

## Results

### Profile and implementation

A fresh-process CPU profile on local Node 22.23.2 took 71.34 seconds. Approximately 37.9 sampled
seconds were below `runAgentBench`; grouped self samples included 12.8 seconds in canonical JSON
serialization, 5.1 in the recursive decoder, 3.0 in `fromCanonicalJson` (including parsing), and
3.0 in the general-purpose non-finite wrapper predicate. This locates runtime copying/serialization
work, not another quadratic declaration-enumeration bottleneck. Sampling time is not a benchmark.

The decoder optimization operates only on the fresh, private `JSON.parse` result. It decodes that
tree in place instead of constructing a second copy and validating data descriptors already
guaranteed by parsing. The public serializer and public wrapper predicate retain their hostile-input
validation. Own `__proto__` properties, wrapper grammar, negative zero, and independent calls are
covered explicitly, together with seeded comparison against an independent JSON reviver.

The API-report experiment rejected one shared all-package TypeScript program: it reordered fields
in two options declarations and therefore violated the byte-parity gate. The implementation instead
keeps isolated package roots and one batch-local compiler host that reuses parsed source files,
passing the preceding program through TypeScript's incremental `oldProgram` path. The host honors
explicit fresh-source requests. `oldProgram` without source-file reuse was slower and was not kept.
The cache is scoped to one invocation, not persistent. Committed reports and
independent single-entry compilation remain the parity oracles; an in-memory source edit tests that
the next invocation sees fresh code.

`regen:check` now prints elapsed time after every successful step. Its ordering and failure behavior
are unchanged. No additional workers, shared verification evidence, or skipped checks are introduced.

### Reproducing the profile

With the repository's pinned Node and pnpm, run the actual generator, not the launcher:

```sh
node --max-old-space-size=8192 --cpu-prof --cpu-prof-dir=/tmp \
  --import tsx tools/manifest/enforcement-run.ts /tmp/enforcement-profile.json
```

Open the resulting `.cpuprofile` in a CPU-profile viewer. For uninstrumented wall time, omit the
CPU-profile flags and time the same command on the before/after revisions sequentially. Never
compare overlapping runs or interpret a developer-machine result as a hosted-CI guarantee.
The printed digest covers the complete record, including evidence and summary, not just verdicts.

### Local measurements and parity

- An initial uninstrumented sequential enforcement pair took **86.29s before / 66.00s after** on local
  Node 22.23.2 (about 24% less wall time in that pair). Developer-machine scheduling varies; this is
  not a prediction for CI. Exploratory overlapping runs are excluded from that comparison.
  The final decoder uses one traversal for arrays and objects and took **64.15s** in a separate,
  uninstrumented run (about 26% less than the isolated baseline). It fits the unchanged bundle budgets;
  the generated bundle report changes only scenarios' rounded size (71.7 to 71.6 KiB).
- All six fresh-process enforcement outputs captured during investigation are byte-identical:
  SHA-256 `7dc1cb6b1344b38307a07a23aecf66b52dce703f44a4c25106ee7ca11801e658`.
- Generating all 25 API reports independently took **6.07s**, versus **1.14s** through the reused
  host, sequentially in one process. Every report matched its independent result byte for byte.
  This microbenchmark has warm-process effects; hosted verification measures the real job.

### Verification

- Focused portfolio, backtest, canonical-artifact, API-report, and bundle tests: **1,054 passed in 65 files**.
  The first broad pass found the portfolio bundle **six bytes** over its budget despite the rounded
  report looking unchanged. Removing an unnecessary temporary wrapper allocation fixed it;
  all 31 exact bundle budgets and all 30 canonical-JSON tests then passed. No budget was raised.
- TypeScript checking, changed-file ESLint/Prettier, the build, and all 25 API snapshot checks pass.
- The generated documentation inventory adds only this note (232 surfaces, 0 findings).
- Clean regeneration and current-head hosted verification are still required. No completion claim yet.
