/**
 * Package-private source of truth for boundary-validation codes. Keep these literals out of the
 * public domain registry's dependency path so tiny guards do not retain unrelated domain codes.
 * `ErrorCode` exposes these same values; this module is deliberately absent from public barrels.
 * Named constants also let static namespace imports discard individual unused codes without
 * allocating a second registry object when the public registry itself is retained.
 */
export const InputNaN = 'input.nan';
export const InputNotFinite = 'input.not_finite';
export const InputNegativeSpot = 'input.negative_spot';
export const InputNegativeStrike = 'input.negative_strike';
export const InputNegativeVolatility = 'input.negative_volatility';
export const InputNegativeTime = 'input.negative_time';
export const InputOutOfRange = 'input.out_of_range';
export const InputInvalidEnum = 'input.invalid_enum';
export const InputMissingField = 'input.missing_field';
export const InputUnknownField = 'input.unknown_field';
export const InputWrongType = 'input.wrong_type';
export const InputWrongShape = 'input.wrong_shape';
export const InputLengthMismatch = 'input.length_mismatch';
export const PostconditionNonFinite = 'postcondition.non_finite_result';
export const InputSuspiciousCouponRate = 'input.suspicious_coupon_rate';
export const InputSuspiciousYield = 'input.suspicious_yield';
