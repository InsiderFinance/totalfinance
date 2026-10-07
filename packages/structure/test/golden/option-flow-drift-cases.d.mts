export interface OptionFlowDriftCase {
  name: string;
  input: unknown;
}
export function optionFlowDriftCases(
  resolvedExpiry: (expiry: string) => object,
): OptionFlowDriftCase[];
export function optionFlowDriftOutcome(run: (input: never) => unknown, input: unknown): string;
