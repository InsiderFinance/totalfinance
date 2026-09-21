/**
 * Reviewed exceptions to Phase 3A's internal named-object rule.
 *
 * Keys are stable IDs emitted by `internal-signature-inventory.ts`. Only conventional mathematical,
 * calendar, validation, and callback protocols belong here. Financial model state, pricing requests,
 * risk coordinates, and execution requests must migrate to one named object instead.
 */
export const INTERNAL_SIGNATURE_POLICIES: Readonly<Record<string, string>> = {
  'packages/fixed-income/src/inflation.ts#shiftMonthKey':
    'File-private calendar arithmetic in universal year/month/delta order; these are coordinates, not interchangeable financial state.',
  'packages/fixed-income/src/models.ts#rollback.atNodeCallback':
    'Numerical tree traversal callback in conventional step/node/continuation order; it is a typed protocol whose coordinates are not a pricing request.',
  'packages/fixed-income/src/models.ts#ShortRateTree.rollback.atNodeCallback':
    'Public numerical tree traversal callback in conventional step/node/continuation order; its three roles are fixed by the rollback protocol.',
  'packages/technical-analysis/src/signal.ts#between':
    'Expression-builder predicate in the conventional subject/lower/upper order; the subject type is distinct from its bounds.',
  'packages/technical-analysis/src/validate.ts#requireInRange':
    'Internal validation protocol in value/context/lower/upper order; it constructs diagnostics and carries no financial model state.',
  'packages/volatility/src/svi.ts#clamp':
    'File-private universal clamp(value, lower, upper) mathematical primitive.',
  'packages/volatility/src/sabr.ts#clampToRange':
    'File-private universal clamp(value, lower, upper) mathematical primitive — the same shape as ' +
    "svi.ts#clamp above. It bounds the calibrator's rho reparameterization away from the ±1 " +
    'saturation that made the pricer reject the calibrator’s own iterate; the three coordinates are ' +
    'a value and its bounds, not financial state.',
  'packages/volatility/src/arbitrage.ts#densityScaledPoints':
    'File-private scan-resolution arithmetic in log-moneyness: (lowerBound, upperBound, gap, ' +
    'floorPoints) is a range plus a step and a floor, not interchangeable financial coordinates — ' +
    'transposing the bounds yields a non-positive span that the caller already rejects, and the ' +
    'last two have distinct units (log-moneyness vs a point count). It computes how densely the ' +
    'arbitrage checks sample a strike ladder, which is why its defaults now scale with strike ' +
    'density rather than being fixed.',
};
