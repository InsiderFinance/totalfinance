/**
 * Stage 4.5 slice 5 compile-only evidence: `@totalfinance/research` may not import `@totalfinance/risk`
 * (the FC0 layer graph), so the hygiene block's member shapes are declared structurally in
 * research. This file proves the two declarations are MUTUALLY ASSIGNABLE — a risk result is a
 * hygiene member and a hygiene member is a risk result — so a field risk adds or renames turns
 * into a type error here, never a silent drift between the two packages.
 *
 * Included by the workspace typecheck, never executed.
 */

import type {
  BacktestOverfittingProbabilityResult,
  DeflatedSharpeResult,
  LeakageReport,
  MultipleTestResult,
  ParameterSweepResult,
  ResearchVerdict,
} from '@totalfinance/risk';
import type {
  HygieneBacktestOverfitting,
  HygieneDeflatedSharpe,
  HygieneLeakageReport,
  HygieneMultipleTest,
  HygieneParameterSweep,
  HygieneResearchVerdict,
  ResearchHygieneBlock,
} from '@totalfinance/research/artifacts';

/** `T` and `U` are mutually assignable: each is the other's subtype. */
type MutuallyAssignable<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;

const protocolParity: MutuallyAssignable<ResearchVerdict, HygieneResearchVerdict> = true;
const deflatedSharpeParity: MutuallyAssignable<DeflatedSharpeResult, HygieneDeflatedSharpe> = true;
const backtestOverfittingParity: MutuallyAssignable<
  BacktestOverfittingProbabilityResult,
  HygieneBacktestOverfitting
> = true;
const leakageParity: MutuallyAssignable<LeakageReport, HygieneLeakageReport> = true;
const parameterSweepParity: MutuallyAssignable<ParameterSweepResult, HygieneParameterSweep> = true;
const multipleTestParity: MutuallyAssignable<MultipleTestResult, HygieneMultipleTest> = true;

/** A block assembled from risk's own results type-checks without a cast. */
function assembleFromRisk(
  protocol: ResearchVerdict,
  deflatedSharpe: DeflatedSharpeResult,
  backtestOverfitting: BacktestOverfittingProbabilityResult,
  leakage: LeakageReport,
  parameterSweep: ParameterSweepResult,
  multipleTesting: MultipleTestResult,
): ResearchHygieneBlock {
  return {
    protocol,
    deflatedSharpe,
    backtestOverfitting,
    leakage,
    parameterSweep,
    multipleTesting,
  };
}

export {
  assembleFromRisk,
  backtestOverfittingParity,
  deflatedSharpeParity,
  leakageParity,
  multipleTestParity,
  parameterSweepParity,
  protocolParity,
};
