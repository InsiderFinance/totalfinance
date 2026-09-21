/**
 * The Standard Schema v1 interface (https://standardschema.dev).
 *
 * TotalFinance schemas implement this so users can plug them into any Standard-Schema-aware tool
 * (form libraries, RPC frameworks, etc.) without TotalFinance taking a dependency on a validator.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input, Output> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardSchemaV1Result<Output>;
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined;
}

export type StandardSchemaV1Result<Output> =
  | StandardSchemaV1SuccessResult<Output>
  | StandardSchemaV1FailureResult;

export interface StandardSchemaV1SuccessResult<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardSchemaV1FailureResult {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey> | undefined;
}

export interface StandardSchemaV1Types<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}
