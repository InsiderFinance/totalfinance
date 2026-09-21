/**
 * Internal (not an entrypoint): the shared SSVI / eSSVI warm-start validator (Stage 4.5).
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import type { SSVIPhi } from './ssvi.js';

/**
 * Validate an SSVI/eSSVI warm start against the φ family being fitted (Stage 4.5): a start in the
 * other family cannot be honored, so it is refused rather than silently ignored.
 */
export function requireSsviStart(
  functionName: string,
  start: { rho: number | readonly number[]; phi: SSVIPhi },
  phiKind: 'power-law' | 'heston',
  knots?: number,
): void {
  const rhos = Array.isArray(start.rho) ? start.rho : [start.rho as number];
  if (Array.isArray(start.rho) && knots !== undefined && start.rho.length !== knots) {
    throw new InputError(
      `${functionName}: initialParameters.rho has ${start.rho.length} entries but the surface has ${knots} maturity knots — pass one ρ per knot or a single ρ to broadcast.`,
      {
        code: ErrorCode.InputLengthMismatch,
        context: { function: functionName, field: 'initialParameters.rho', knots },
      },
    );
  }
  rhos.forEach((rho, index) => {
    const field = Array.isArray(start.rho)
      ? `initialParameters.rho[${index}]`
      : 'initialParameters.rho';
    if (typeof rho !== 'number' || !Number.isFinite(rho) || !(Math.abs(rho) < 1)) {
      throw new InputError(
        `${functionName}: ${field} must be a finite correlation in (−1, 1). Received ${String(rho)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field },
        },
      );
    }
  });
  if (start.phi.kind !== phiKind) {
    throw new InputError(
      `${functionName}: initialParameters.phi.kind is '${start.phi.kind}' but the calibration fits the '${phiKind}' φ family — a warm start must be in the family being fitted. Pass options.phi: '${start.phi.kind}' or a '${phiKind}' start.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: 'initialParameters.phi.kind', phi: phiKind },
      },
    );
  }
  if (start.phi.kind === 'power-law') {
    if (!(start.phi.eta > 0) || !Number.isFinite(start.phi.eta)) {
      throw new InputError(
        `${functionName}: initialParameters.phi.eta must be a finite positive number. Received ${String(start.phi.eta)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: 'initialParameters.phi.eta' },
        },
      );
    }
    if (!(start.phi.gamma > 0 && start.phi.gamma < 1)) {
      throw new InputError(
        `${functionName}: initialParameters.phi.gamma must lie in (0, 1). Received ${String(start.phi.gamma)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: 'initialParameters.phi.gamma' },
        },
      );
    }
  } else if (!(start.phi.lambda > 0) || !Number.isFinite(start.phi.lambda)) {
    throw new InputError(
      `${functionName}: initialParameters.phi.lambda must be a finite positive number. Received ${String(start.phi.lambda)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'initialParameters.phi.lambda' },
      },
    );
  }
}
