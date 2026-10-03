/**
 * A HAND-WRITTEN FIXTURE IS STILL A CLAIM ABOUT THE DECLARATION, and it was never checked.
 *
 * `measureBoundary` validates a baseline against its contract only when the baseline was SYNTHESIZED,
 * on the reasoning that "a hand-written fixture is a deliberate choice, including where it
 * deliberately omits something". That reasoning is sound for the omission and wrong as a blanket
 * exemption: it makes a STALE fixture and a legitimate behavioural object indistinguishable, and both
 * are silently exempt from the check the synthesized path treats as load-bearing.
 *
 * The distinction matters because the two want opposite responses. A stale fixture — one that drifted
 * from a renamed or re-required field — produces a measurement of a call no caller would write, and
 * every verdict downstream of it describes something else. A behavioural object (a live `YieldCurve`,
 * an async iterable) legitimately cannot be described by a static field tree, and demanding one would
 * be the harness misreading the contract rather than the fixture being wrong.
 *
 * So this validates all of them and NAMES the residual. The residual is now EMPTY: every one of the
 * eight it started with was a real defect with a real repair (see `KNOWN` below for each). An
 * allowlist fails the moment anything else appears, which a blanket exemption cannot do — and an
 * empty one means the check is carrying no debt while it does that.
 */

import { describe, expect, it } from 'vitest';
import { allFixtures } from '../first-touch/fixtures.js';
import {
  baselineGap,
  baselineGapFingerprint,
  expandedCoordinates,
  type SynthesisParameter,
} from './contract-synthesis.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface ContractRecord {
  id: string;
  /** Per-ARGUMENT-INDEX key policy: `closed` (default), `open`, `passthrough`. */
  inputPolicies?: Record<string, string>;
  signatures?: { parameters?: SynthesisParameter[] }[];
}

/** The same key shape `contract-enforcement.ts` uses to join a fixture to a public id. */
const fixtureKey = (id: string): string => id.replace('@totalfinance/', '').replace(':', '.');

describe('hand-written fixtures satisfy the declarations they are measured against', () => {
  const artifact = JSON.parse(
    readFileSync(fileURLToPath(new URL('./public-contracts.json', import.meta.url)), 'utf8'),
  ) as { contracts?: ContractRecord[] };
  const fixtures = allFixtures();

  const mismatches = new Map<string, string>();
  const unbuildable: string[] = [];
  let matched = 0;
  for (const record of artifact.contracts ?? []) {
    const thunk = fixtures.get(fixtureKey(record.id)) as (() => unknown[]) | undefined;
    if (!thunk) continue;
    matched += 1;
    let args: unknown[];
    try {
      args = thunk();
    } catch (error) {
      // A fixture that cannot be BUILT was skipped here, so the one failure mode that guarantees no
      // measurement at all was the one this gate ignored. It is a harness gap, never a library
      // defect — and it is still a gap, so it is reported rather than passed over.
      unbuildable.push(`${record.id}: ${(error as Error).message.slice(0, 120)}`);
      continue;
    }
    // Hand fixtures have no synthesis walk to borrow alignment from, so expand the signature and
    // align from the left — optional parameters are trailing in TypeScript, so that is exact.
    /**
     * The coordinates carry their argument's KEY POLICY, so a legitimately decorated OPEN argument is
     * not called malformed. Without this the three `calendars` boundaries were listed as mismatches
     * for passing a `TradingCalendar` — correct usage on an argument the manifest declares `open`.
     */
    const coordinates = expandedCoordinates(record.signatures?.[0]?.parameters ?? []).map(
      (coordinate, index) => {
        const policy = record.inputPolicies?.[String(index)];
        return policy === undefined ? coordinate : { ...coordinate, policy };
      },
    );
    const gap = baselineGap(coordinates, args);
    if (gap !== null) {
      mismatches.set(`${record.id} :: ${baselineGapFingerprint(gap)}`, gap.detail);
    }
  }

  it('matches a meaningful number of fixtures to contracts', () => {
    // Without this the gate below passes by joining nothing — the same vacuity that has hidden in
    // every other population in this directory.
    /**
     * EXACT, not a floor. `>= 700` passed while 784 fixtures actually joined, so 84 could stop
     * joining without moving it — a bound that sits 12% below the number it guards is not guarding it.
     */
    // 784 → 786 (FC0, 2026-08-19): the two @totalfinance/fundamentals fixtures joined their contracts.
    // 786 → 790 (FC1, 2026-08-19): the four @totalfinance/valuation fixtures — the two solver heads
    // (internalRateOfReturn, datedInternalRateOfReturn) and the two shared when-present validators
    // (requireCompoundingWhenPresent, requireDayCountWhenPresent) — joined their contracts.
    // 790 → 858 (FC2, 2026-08-19): the fundamentals ratio/score/guard fixtures and the valuation
    // analysis fixtures joined their contracts.
    // 858 → 881 (FC3) → 903 (FC4+FC5) → 917 (FC6) → 918 (Gate A) → 926 (Gate B) → 938 (Gate C) →
    // 937 (correction wave, 2026-08-23): requirePathLabel went internal with its fixture.
    // 967 (third-review harvest, 2026-08-23): the 30 single-object valuation primitives gained
    // fixtures for the overflow mutant's completeness law, and each joins its contract here.
    // 1010 (fourth-review harvest, 2026-08-23): the 49 constructor/factory heads of the legacy
    // packages gained fixtures for the library-wide count gate, and each joins its contract here.
    // 1023 (resource-safety closeout, 2026-08-27): factory, method, paging, and narrowed-options
    // fixtures added by the exact resource-coordinate gate joined their public contracts.
    // 1057 (trusted-tier resource closeout, 2026-08-27): every declaration-proven workload control
    // in @totalfinance/math gained a valid, low-cost baseline rather than inheriting the old tier skip.
    // 1060 (exact public-head closeout, 2026-08-27): the three resource-bearing subpath-only kernels
    // that were absent from the root-export sweep gained valid direct fixtures.
    // 1062 (adversarial first-touch closeout, 2026-08-27): KstStream's source-compatible `number[]`
    // constructor and its valid restorer snapshot use explicit exact-four baselines.
    // 1062 → 1072 (FC7 slice 1, 2026-08-28): the ten portfolio heads gained fixtures and each joins its
    // contract here.
    // 1072 → 1074 (FC7 slice 2, 2026-08-28): portfolioPnl and portfolioTimeline join their contracts.
    // 1074 → 1075 (FC7 slice 3, 2026-08-28): reconcilePortfolio joins its contract.
    // 1075 → 1083 (FC7 slice 4, 2026-08-29): the policy heads (createModelPortfolio, isModelPortfolio,
    // resolveModelTargets, allocatePortfolio, proposePortfolioRebalance, monitorPortfolio) and the
    // risk-side estimateExpectedReturns/efficientFrontier join their contracts.
    // 1083 → 1092 (Stage 4.4b): runScenarios, three target builders, spotAssetPricer, two durable
    // portfolio-binding builders, scenarioTargetsFromPortfolio, and the bond pricer adapter join.
    // 1092 → 1093 (Stage 4.4b closeout): adjustPValues burns down pre-existing measurement debt
    // instead of raising the global unmeasured ceiling for the new structural callback surfaces.
    // 1093 → 1099 (Stage 4.5 slice 1): the core comparison/parity/scanner/summary/row-handle fixtures;
    // 1099 → 1103 (Stage 4.5 slice 2): eventVolatilityAtExpiry, the two curve mappers, requireRateCurveData.
    // 1103 → 1111 (Stage 4.5 slice 3): the eight @totalfinance/volatility/artifacts verbs.
    // 1111 → 1123 (Stage 4.5 slice 4): the six @totalfinance/fixed-income/artifacts verbs and the six
    // fitted-model kit helpers in @totalfinance/core/artifacts.
    // 1123 → 1127 (Stage 4.5 slice 5): the four @totalfinance/research/artifacts verbs.
    // 1127 → 1137 (Stage 7A slice 1, 2026-09-03): the @totalfinance/workflows doors — defineOperation,
    // describeOperation, operationAnnotations, requireOperation, runOperation, toOperationError,
    // createOperationRegistry, jsonSafe, capRows, extendObjectSchema — join their contracts.
    // 1137 → 1142 (Stage 7A slice 1): @totalfinance/mcp's first hand baselines (createTotalFinanceMcpServer,
    // toolFromOperation, defineTool), core's requireJSONSchema, and OperationRegistry#run.
    // 1142 → 1168 (Stage 7A slice 3): the handle/store guards and memory-store methods in
    // @totalfinance/workflows, @totalfinance/cli's stores, profiles, and runner, math's luSolve / qrSolve /
    // matrixVectorProduct and core's scenarioSetContentHash (older baseline-rejected debt burned down).
    // 1168 → 1175 (Stage 7A slice 5): @totalfinance/http's three doors, the runner binding, and the
    // JobRunner contract's methods.
    // 1175 → 1203 (Stage 4.6 slice 1): the execution vocabulary's heads and closed guards on
    // @totalfinance/backtest/execution, the portfolio normalized-fill bridge, the research universe verbs.
    // 1203 → 1205 (Stage 4.6 slice 2): crossSectionalBacktest and its request guard.
    // 1205 → 1211 (Stage 4.6 slice 3): the grid, its guard, and the four run-artifact verbs.
    // 1211 → 1212 (Stage 4.6 slice 4): the options-backtest request guard.
    // 1212 → 1221 (Stage 4.6 slice 5): portfolioBacktest, its four guards, the conformance suite,
    // adapterFor, accruedFromTerms, splitShares — nine new fixture/contract joins.
    // 1221 → 1225 (Stage 4.6 slice 6): crossSectionalWalkForward, crossSectionalPurgedFolds, and their
    // two request guards.
    // 1225 → 1231 (Stage 7B.1 slice 1, 2026-09-05): createPortfolioStepper, createTradingEnvironment,
    // and the four environment guards join with their first-touch fixtures.
    // 1231 → 1234 (Stage 7B.1 slice 2, 2026-09-05): the limits, reward, and feature guards join with
    // their first-touch fixtures.
    // 1234 → 1238 (Stage 7B.1 slice 3, 2026-09-05): runEnvironmentEpisode, its input guard,
    // environmentEpisode, and listEnvironmentEpisodes join with their first-touch fixtures.
    // 1238 → 1240 (Stage 7B.1 slice 4, 2026-09-05): runAgentBench and scoreAgentTranscript join with
    // their first-touch fixtures.
    // 1240 → 1246 (Stage 7B.1 slice 4, 2026-09-05): the six agentBaselines.* members join with their
    // first-touch fixtures.
    // 1246 → 1257 (Stage 7B.2 slice 1, 2026-09-06): the trade-lifecycle callables (normalizeTradePlan and
    // its proposal branch, preflightTradePlan with its proposal and monitor-state branches, mergeTradePolicies,
    // decideFromChecks, referencePriceOf, the six require* guards) gained first-touch fixtures.
    // 1257 → 1268 (Stage 7B.2 slice 2, 2026-09-06): the grant, journal, and reconciliation callables
    // (createAuthorizationGrant, verifyAuthorizationGrant, applyJournalEvents, journalOrderStates,
    // reconcileExecution, the six require* guards) gained first-touch fixtures.
    // 1268 → 1272 (Stage 7B.2 slice 3, 2026-09-06): createPaperBroker, fillOrderWithPolicy, and the two
    // paper guards gained first-touch fixtures.
    // 1272 → 1286 (Stage 7B.2 slice 4, 2026-09-06): tradePack, the capability helpers, and the
    // authorization and journal stores (memory and file) gained first-touch fixtures.
    // 1286 → 1288: the file-backed authorization and journal stores (fixtured beside the artifact store).
    // 1288 → 1290: observedSkew and optionFlowDrift each add a public first-touch contract.
    // 1290 → 1291: observedSkew's real umbrella alias contributes the supported ISO asOf branch.
    // 1291 → 1295: saved calculation comparison, supplied exposure, and both chain-health branches.
    // 1295 → 1297: distinct simple sector returns and audited snapshot first calls.
    // 1297 → 1294 (2026-09-09): six direction-specific leg fixtures become the three signed
    // instrument-first constructors. All three join their new contracts; no live fixture is lost.
    // 1294 → 1295 (2026-09-16): the market-snapshot option-pricing guard (`requireInstantMarketSnapshot`)
    // is fixtured with an explicit-instant snapshot so it measures instead of being baseline-rejected.
    // 1295 → 1294 (2026-09-18): the risk package's raw-Greek adapter (`rawGreeksFromDisplay`) is
    // deleted with its fixture — TotalFinance Greeks are display units everywhere, so the adapter and
    // the contract it joined no longer exist.
    // 1294 → 1295 (2026-09-21, pre-publish repairs B and C): `options.chainGreeks` joins its
    // contract; `usEquityOption` and `portfolioVaR` replace the retired doors' fixtures one for one.
    // 1295 → 1314 (selective Greeks and exposure, 2026-10-01): blackScholes.delta/gamma/theta/vega/rho,
    // blackScholes.evaluate and its .explain, blackScholesEvaluateMany/Into, the nine exposure
    // shortcuts and core's requireSelection join their contracts with first-touch fixtures.
    expect(matched, 'the fixture/contract join moved — update this number deliberately').toBe(1314);
  });

  it('every matched fixture can be BUILT', () => {
    expect(
      unbuildable,
      `${unbuildable.length} fixtures throw on construction, so they measure nothing:\n${unbuildable.join('\n')}`,
    ).toEqual([]);
  });

  it('every matched fixture validates, except a NAMED residual', () => {
    /**
     * EMPTY, AND THAT IS THE POINT — every fixture measured here is a call its declaration accepts.
     *
     * It was eight. Each one turned out to be a real defect with a real repair, not a case the rule
     * was too crude to express:
     *
     *   - `options.dk` → `logMoneynessStep`. Renamed in 272d09cf, which updated one fixture shard
     *     and missed two. `0.01` was already the implementation's default, so the repair changed no
     *     result — it changed the call from one no caller could write to one they could.
     *   - `market.expiry` deleted. `OptionMarket` declares no expiry; it belongs to the CONTRACT,
     *     which is why `priceMany` prices many contracts, each with its own, against one market.
     *     The key was inert — every engine reads `contract.expiry`.
     *   - GARCH and HAR fits now come from `fitGarch`/`fitHarRv`. Both hand-rolled literals omitted
     *     the required `assumptions`/`diagnostics`, and HAR still carried `n` after it became
     *     `observationCount`. A fixture sourced from its producer cannot drift again.
     *   - `collectAsync`/`streamAsync` argument 0 is curated `open`. An `IndicatorStream` is a
     *     structural collaborator, not a request bag: `requireIndicatorStream` duck-types `next` and
     *     never enumerates keys, which is Law 12's definition of `open` verbatim.
     *
     * That last one was nearly a rule instead of a curation — "an argument whose members are
     * predominantly functions is a protocol". Measured before believed: that rule would reclassify
     * 32 parameters, including three `Schema<…>` arguments (the validation machinery's own inputs)
     * and `YieldCurve#addSpread`, a genuinely closed request. It would have bought two honest
     * classifications by silently opening thirty that should stay shut.
     *
     * A new entry is not forbidden, but it now costs a written reason that survives the question
     * "what makes this different from the eight that were simply wrong?".
     *
     * Keyed by ID **and a machine-comparable fingerprint** — `category@path`. Keyed by id alone, a
     * DIFFERENT mismatch under a listed id would stay green: the entry would say "we know about this
     * fixture" when it meant "we know about this defect in it". Keyed by prose, the gate would be
     * classifying a defect by parsing its own error text — the pattern this phase keeps removing.
     * `baselineGap` returns category and path as data, so the key is derived rather than described.
     */
    const KNOWN: Record<string, string> = {};
    const unexpected = [...mismatches.entries()]
      .filter(([id]) => !(id in KNOWN))
      .map(([id, gap]) => `${id}: ${gap}`)
      .sort();
    expect(
      unexpected,
      `${unexpected.length} hand-written fixtures do not satisfy the declaration they are measured ` +
        `against, and are not in the recorded residual:\n${unexpected.join('\n')}`,
    ).toEqual([]);
    // The residual may only shrink; a stale entry means the list stopped describing reality.
    expect(
      Object.keys(KNOWN).filter((id) => !mismatches.has(id)),
      'a recorded fixture mismatch no longer occurs — remove it from KNOWN',
    ).toEqual([]);
  });
});
