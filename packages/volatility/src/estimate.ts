/**
 * The scalar-tier estimate envelope (spec §7.4 / WS2.3 / DX1).
 *
 * Event-vol probabilities, expected moves, IV rank/percentile, and the variance-swap fair vol used to
 * return bare scalars or plain objects — so a serialized `probabilityInTheMoney` payload carried no hint that
 * it is a RISK-NEUTRAL model probability, not a real-world forecast. That caveat lived only in a doc
 * comment. Each such analytic now returns the standard `Computed<T, Extra>` envelope: the value it
 * always returned, plus the conventions/model it assumed (`assumptions`) and any estimate-quality
 * caveat (`diagnostics.warnings`) — uniform with every other rich result in the library.
 */

import type { QuantWarning } from '@totalfinance/core';
import { WarningCode } from '@totalfinance/core';

/** The standard "this is a risk-neutral model estimate, not a real-world forecast" caveat. */
export const RISK_NEUTRAL_ESTIMATE: QuantWarning = {
  code: WarningCode.EstimateRiskNeutral,
  message:
    'Risk-neutral model estimate — a model-implied level/probability, not a real-world forecast.',
  severity: 'info',
};
