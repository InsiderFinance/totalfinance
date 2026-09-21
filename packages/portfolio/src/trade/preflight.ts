/**
 * `preflightTradePlan` (Decision 3): the plan against the ledger, the market, and the policy — the
 * portfolio before and after (hypothetical fills folded through the same events a real fill
 * emits), every check with its verdict, the estimated costs, the monitor's alerts on the
 * after-state, and one decision. Missing information never becomes an allow: what the inputs cannot
 * support is `unverifiable`, and the policy says whether that means approval or denial.
 */
import {
  CONVENTIONS_VERSION,
  ensureKnownKeys,
  requireArgumentObject,
  resolveAsOf,
  signOf,
} from '@totalfinance/core';
import type { EpochMs, QuantWarning } from '@totalfinance/core';
import { contentHash, readMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  portfolioEventsFromFill,
  type DerivativeContractTerms,
  type NormalizedFill,
  type OptionContractTerms,
  type PortfolioEventEnvelope,
} from '../events.js';
import { deepFreeze, requireIdentityString } from '../internal.js';
import type { CurrencyPairQuote } from '../internal.js';
import { monitorPortfolio, type MonitorAlert, type PortfolioMonitorState } from '../monitor.js';
import { portfolioSnapshot } from '../snapshot.js';
import { applyPortfolioEvents, requirePortfolioStateShape } from '../state.js';
import { resolveInstrument, spotPriceOf } from './plan.js';
import { decideFromChecks } from './policy.js';
import {
  PREFLIGHT_REPORT_KIND,
  PREFLIGHT_REPORT_SCHEMA_VERSION,
  type PolicyCheck,
  type PreflightCostRates,
  type PreflightReport,
  type PreflightTradePlanInput,
  type TradeOrder,
} from './types.js';
import {
  conversionsField,
  hasPresentKey,
  refuse,
  requireExecutionPlan,
  requirePreflightCostRates,
  requirePreflightInstrument,
  requireTradeOrder,
  requireTradePolicy,
} from './validate.js';

const FN = 'preflightTradePlan';
const INPUT_KEYS = [
  'plan',
  'portfolio',
  'market',
  'asOf',
  'policy',
  'instruments',
  'currencyConversions',
  'openOrders',
  'costs',
  'averageDailyVolumes',
  'session',
  'monitorState',
] as const;
const FILL_CONVENTION =
  'every order fills in full at its reference price (the market spot, or the limit price without a spot) plus the declared slippage, at the preflight instant; the after-state is the ledger fold of those fills';
const DECISION_CONVENTION =
  "allow only when every check passes; deny when any check fails (or any is unverifiable under onUnverifiable 'deny'); otherwise require-approval with the unverifiable evidence disclosed";

export function preflightTradePlan(input: PreflightTradePlanInput): PreflightReport {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, INPUT_KEYS);
  const plan = requireExecutionPlan(FN, 'input.plan', input.plan);
  requirePortfolioStateShape(FN, 'input.portfolio', input.portfolio);
  const { snapshot: market } = readMarketSnapshot({ snapshot: input.market });
  const asOf = resolveAsOf(input.asOf, FN);
  const policy = requireTradePolicy(FN, 'input.policy', input.policy);
  if (hasPresentKey(input, 'instruments')) {
    requireArgumentObject(FN, 'input.instruments', input.instruments);
    for (const [id, spec] of Object.entries(input.instruments!))
      requirePreflightInstrument(FN, `input.instruments.${id}`, spec);
  }
  const openOrders: TradeOrder[] = hasPresentKey(input, 'openOrders')
    ? (() => {
        if (!Array.isArray(input.openOrders))
          refuse(FN, 'input.openOrders', 'must be an array of orders.');
        return input.openOrders!.map((row, i) =>
          requireTradeOrder(FN, `input.openOrders[${i}]`, row),
        );
      })()
    : [];
  const rates: Required<PreflightCostRates> = {
    commissionBps: 0,
    commissionPerOrder: 0,
    spreadBps: 0,
    slippageBps: 0,
    ...(hasPresentKey(input, 'costs')
      ? requirePreflightCostRates(FN, 'input.costs', input.costs)
      : {}),
  };
  if (hasPresentKey(input, 'averageDailyVolumes')) {
    requireArgumentObject(FN, 'input.averageDailyVolumes', input.averageDailyVolumes);
    for (const [id, v] of Object.entries(input.averageDailyVolumes!))
      if (typeof v !== 'number' || !(v > 0))
        refuse(FN, `input.averageDailyVolumes.${id}`, 'must be a positive number.');
  }
  if (hasPresentKey(input, 'session')) {
    requireArgumentObject(FN, 'input.session', input.session);
    ensureKnownKeys(FN, 'input.session', input.session as object, ['open', 'halted']);
    if (typeof input.session!.open !== 'boolean')
      refuse(FN, 'input.session.open', 'must be a boolean.');
    if (hasPresentKey(input.session as object, 'halted')) {
      if (!Array.isArray(input.session!.halted))
        refuse(FN, 'input.session.halted', 'must be an array of instrument ids.');
      input.session!.halted!.forEach((id, i) =>
        requireIdentityString(FN, `input.session.halted[${i}]`, id),
      );
    }
  }
  const previousMonitorState: PortfolioMonitorState | null = hasPresentKey(input, 'monitorState')
    ? (input.monitorState as PortfolioMonitorState | null)
    : null;
  const conversions: CurrencyPairQuote[] = hasPresentKey(input, 'currencyConversions')
    ? conversionsField(FN, input.currencyConversions)
    : [];
  const portfolio = input.portfolio;
  const warnings: QuantWarning[] = [];
  const checks: PolicyCheck[] = [];
  const check = (
    name: string,
    verdict: PolicyCheck['verdict'],
    value: PolicyCheck['value'],
    limit: PolicyCheck['limit'],
    detail: string,
  ): void => {
    checks.push({ name, verdict, value, limit, detail });
  };

  // ---- the plan against the account and the policy's allow lists ----------------------------------
  if (policy.allowedAccounts !== undefined)
    check(
      'account',
      policy.allowedAccounts.includes(plan.accountId) ? 'pass' : 'fail',
      plan.accountId,
      policy.allowedAccounts.join(', '),
      `the plan trades account '${plan.accountId}'`,
    );
  const account = portfolio.accounts[plan.accountId];
  if (account === undefined)
    check(
      'account-known',
      'fail',
      plan.accountId,
      null,
      `the ledger has no account '${plan.accountId}'`,
    );
  else check('account-known', 'pass', plan.accountId, null, 'the ledger holds the account');

  // ---- market age ----------------------------------------------------------------------------------
  const ageMs = asOf - market.asOf;
  if (policy.marketMaximumAgeMs !== undefined)
    check(
      'market-age',
      ageMs <= policy.marketMaximumAgeMs ? 'pass' : 'fail',
      ageMs,
      policy.marketMaximumAgeMs,
      `the market snapshot is ${ageMs} ms old at the preflight instant`,
    );
  else
    check('market-age', 'pass', ageMs, null, 'no marketMaximumAgeMs declared; the age is reported');

  // ---- the orders, one by one ----------------------------------------------------------------------
  const before = portfolioSnapshot({
    portfolio,
    asOf,
    market,
    ...(conversions.length > 0 ? { currencyConversions: conversions } : {}),
  });
  const nav = before.netAssetValue;
  const fills: NormalizedFill[] = [];
  let tradedNotional = 0;
  let commission = 0;
  let spread = 0;
  let slippage = 0;
  const instrumentSources: Record<string, string> = {};
  const heldAfter = new Map<string, number>();
  for (const position of Object.values(account?.positions ?? {}))
    heldAfter.set(position.instrumentId, position.quantity);
  const openKeys = new Set(openOrders.map((o) => `${o.instrumentId}#${o.side}`));
  // ---- undefined risk (B5): judged on the after-state — of the order, or of its whole combo -------
  const contractOf = (id: string): DerivativeContractTerms | undefined =>
    account?.positions[id]?.contract ?? input.instruments?.[id]?.contract;
  const multiplierOf = (id: string): number =>
    account?.positions[id]?.contractMultiplier ?? input.instruments?.[id]?.contractMultiplier ?? 1;
  const judgeUndefinedRisk = (at: string, orders: readonly TradeOrder[]): void => {
    if (policy.allowUndefinedRiskOptions ?? false) return;
    const options: { id: string; held: number; contract: OptionContractTerms; units: number }[] =
      [];
    for (const [id, held] of heldAfter) {
      const contract = contractOf(id);
      if (contract?.kind === 'option' && held !== 0)
        options.push({ id, held, contract, units: Math.abs(held) * multiplierOf(id) });
    }
    const longs = options
      .filter((position) => position.held > 0)
      .sort(
        (a, b) =>
          a.contract.expiryTimestampMs - b.contract.expiryTimestampMs ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    // Longest-dated shorts have the fewest eligible hedges. Consume each long/stock unit once;
    // existing shorts compete for the same capacity as the proposed orders.
    const shorts = options
      .filter((position) => position.held < 0)
      .sort(
        (a, b) =>
          b.contract.expiryTimestampMs - a.contract.expiryTimestampMs ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const stock = new Map<string, number>();
    for (const short of shorts) {
      const { contract } = short;
      let remaining = short.units;
      for (const long of longs) {
        if (
          long.contract.type !== contract.type ||
          long.contract.underlyingInstrumentId !== contract.underlyingInstrumentId ||
          long.contract.expiryTimestampMs < contract.expiryTimestampMs
        )
          continue;
        const used = Math.min(remaining, long.units);
        remaining -= used;
        long.units -= used;
      }
      const longUnits = short.units - remaining;
      let stockUnits = 0;
      if (contract.type === 'call') {
        const id = contract.underlyingInstrumentId;
        const available = stock.get(id) ?? Math.max(0, heldAfter.get(id) ?? 0);
        stockUnits = Math.min(remaining, available);
        remaining -= stockUnits;
        stock.set(id, available - stockUnits);
      }
      const covered = remaining <= short.units * 1e-12;
      const order = orders.find((candidate) => candidate.instrumentId === short.id);
      // Also report newly uncovered existing shorts (e.g. selling their stock/option hedge).
      if (order === undefined && covered) continue;
      const scope = orders[0]?.comboId === undefined ? 'the order' : `combo ${orders[0].comboId}`;
      const label =
        order === undefined
          ? `${at}.positions[${JSON.stringify(short.id)}]`
          : `orders[${plan.orders.indexOf(order)}]`;
      check(
        `${label}.undefined-risk`,
        covered ? 'pass' : 'fail',
        short.held,
        0,
        covered
          ? `a short ${contract.type} covered by ${longUnits} units of same-or-later-dated long ${contract.type}s and ${stockUnits} underlying units after ${scope} (defined risk; each hedge allocated once)`
          : `${scope} leaves ${remaining} option units uncovered and the policy does not allow undefined risk`,
      );
    }
  };
  const comboLegsLeft = new Map(plan.combos.map((combo) => [combo.comboId, combo.orderIds.length]));
  const pendingRisk: TradeOrder[] = [];
  plan.orders.forEach((order, i) => {
    const at = `orders[${i}]`;
    const resolved = resolveInstrument(
      FN,
      portfolio,
      plan.accountId,
      input.instruments,
      market,
      order.instrumentId,
    );
    const reference = spotPriceOf(market, order.instrumentId);
    const price = reference?.price ?? order.limitPrice ?? null;
    if (resolved === null || price === null) {
      check(
        `${at}.instrument`,
        'fail',
        order.instrumentId,
        null,
        `'${order.instrumentId}' cannot be valued — no ledger position, no instruments entry, no spot`,
      );
      return;
    }
    check(
      `${at}.instrument`,
      'pass',
      order.instrumentId,
      null,
      `resolved from the ${resolved.source}`,
    );
    if (policy.allowedInstruments !== undefined)
      check(
        `${at}.allowed-instrument`,
        policy.allowedInstruments.includes(order.instrumentId) ? 'pass' : 'fail',
        order.instrumentId,
        policy.allowedInstruments.join(', '),
        "the policy's instrument allow list",
      );
    if (policy.allowedAssetClasses !== undefined) {
      const assetClass = resolved.assetClass;
      if (assetClass === null)
        check(
          `${at}.allowed-asset-class`,
          'unverifiable',
          null,
          policy.allowedAssetClasses.join(', '),
          `no asset class is known for '${order.instrumentId}' — describe it in input.instruments`,
        );
      else
        check(
          `${at}.allowed-asset-class`,
          policy.allowedAssetClasses.includes(assetClass) ? 'pass' : 'fail',
          assetClass,
          policy.allowedAssetClasses.join(', '),
          "the policy's asset-class allow list",
        );
    }
    if (policy.allowedOrderTypes !== undefined)
      check(
        `${at}.order-type`,
        policy.allowedOrderTypes.includes(order.type) ? 'pass' : 'fail',
        order.type,
        policy.allowedOrderTypes.join(', '),
        "the policy's order-type allow list",
      );
    if (openKeys.has(`${order.instrumentId}#${order.side}`))
      check(
        `${at}.duplicate`,
        'fail',
        `${order.side} ${order.instrumentId}`,
        null,
        'an open order already works this side of the instrument',
      );
    else
      check(
        `${at}.duplicate`,
        'pass',
        `${order.side} ${order.instrumentId}`,
        null,
        'no open order conflicts',
      );
    if (input.session !== undefined) {
      const halted = input.session.halted?.includes(order.instrumentId) ?? false;
      check(
        `${at}.session`,
        input.session.open && !halted ? 'pass' : 'fail',
        halted ? 'halted' : input.session.open ? 'open' : 'closed',
        'open',
        'the trading session at the instant',
      );
    }
    const multiplier = resolved.contractMultiplier;
    const notional = order.quantity * price * multiplier;
    if (policy.maximumOrderQuantity !== undefined)
      check(
        `${at}.quantity`,
        order.quantity <= policy.maximumOrderQuantity ? 'pass' : 'fail',
        order.quantity,
        policy.maximumOrderQuantity,
        'maximumOrderQuantity',
      );
    if (policy.maximumOrderNotional !== undefined)
      check(
        `${at}.notional`,
        notional <= policy.maximumOrderNotional ? 'pass' : 'fail',
        notional,
        policy.maximumOrderNotional,
        'maximumOrderNotional (instrument currency)',
      );
    if (policy.requireApprovalAbove !== undefined) {
      const above =
        (policy.requireApprovalAbove.notional !== undefined &&
          notional > policy.requireApprovalAbove.notional) ||
        (policy.requireApprovalAbove.quantity !== undefined &&
          order.quantity > policy.requireApprovalAbove.quantity);
      if (above)
        check(
          `${at}.approval`,
          'require-approval',
          notional,
          policy.requireApprovalAbove.notional ?? policy.requireApprovalAbove.quantity ?? null,
          'above the requireApprovalAbove threshold',
        );
    }
    if (policy.maximumParticipation !== undefined) {
      const volume = input.averageDailyVolumes?.[order.instrumentId];
      if (volume === undefined)
        check(
          `${at}.participation`,
          'unverifiable',
          null,
          policy.maximumParticipation,
          `no averageDailyVolumes entry for '${order.instrumentId}'`,
        );
      else
        check(
          `${at}.participation`,
          order.quantity / volume <= policy.maximumParticipation ? 'pass' : 'fail',
          order.quantity / volume,
          policy.maximumParticipation,
          'quantity ÷ average daily volume',
        );
    }
    // the hypothetical fill, at the reference price plus the declared slippage
    const direction = signOf(order.side);
    const fillPrice = price * (1 + (direction * (rates.slippageBps + rates.spreadBps)) / 10_000);
    const orderCommission = (notional * rates.commissionBps) / 10_000 + rates.commissionPerOrder;
    const orderSpread = (notional * rates.spreadBps) / 10_000;
    const orderSlippage = (notional * rates.slippageBps) / 10_000;
    tradedNotional += notional;
    commission += orderCommission;
    spread += orderSpread;
    slippage += orderSlippage;
    const contract = contractOf(order.instrumentId);
    let riskOrders: TradeOrder[] = [];
    if (order.comboId === undefined) riskOrders = [order];
    else {
      pendingRisk.push(order);
      const left = (comboLegsLeft.get(order.comboId) ?? 0) - 1;
      comboLegsLeft.set(order.comboId, left);
      if (left === 0)
        riskOrders = pendingRisk.filter((pending) => pending.comboId === order.comboId);
    }
    if (riskOrders.length > 0) {
      for (const pending of riskOrders)
        heldAfter.set(
          pending.instrumentId,
          (heldAfter.get(pending.instrumentId) ?? 0) + signOf(pending.side) * pending.quantity,
        );
      judgeUndefinedRisk(at, riskOrders);
    }
    instrumentSources[order.instrumentId] = resolved.source;
    fills.push({
      fillId: `preflight:${plan.contentHash}:${i + 1}`,
      accountId: plan.accountId,
      instrumentId: order.instrumentId,
      side: order.side,
      quantity: order.quantity,
      pricePerUnit: fillPrice,
      currency: resolved.currency,
      filledTimestampMs: asOf,
      orderId: order.orderId,
      ...(multiplier !== 1 ? { contractMultiplier: multiplier } : {}),
      ...(contract !== undefined ? { contract, contractMultiplier: multiplier } : {}),
      ...(orderCommission > 0 ? { costs: { commission: orderCommission } } : {}),
      ...(orderSlippage + orderSpread > 0
        ? { executionPriceAdjustment: orderSlippage + orderSpread }
        : {}),
    });
  });

  // ---- the plan as a whole -------------------------------------------------------------------------
  const totalCost = commission + spread + slippage;
  const turnover = nav > 0 ? tradedNotional / nav : 0;
  if (policy.maximumEstimatedCost !== undefined)
    check(
      'estimated-cost',
      totalCost <= policy.maximumEstimatedCost ? 'pass' : 'fail',
      totalCost,
      policy.maximumEstimatedCost,
      'commission + spread + slippage at the declared rates',
    );
  if (policy.maximumSlippageBps !== undefined)
    check(
      'slippage',
      rates.slippageBps <= policy.maximumSlippageBps ? 'pass' : 'fail',
      rates.slippageBps,
      policy.maximumSlippageBps,
      'the declared slippage rate',
    );
  if (policy.maximumTurnover !== undefined)
    check(
      'turnover',
      turnover <= policy.maximumTurnover ? 'pass' : 'fail',
      turnover,
      policy.maximumTurnover,
      'traded notional ÷ NAV before the plan',
    );

  // ---- the after-state: the ledger's own fold of the hypothetical fills --------------------------
  const sourceId = `preflight:${plan.contentHash}`;
  const events: PortfolioEventEnvelope[] = fills.flatMap((fill) =>
    portfolioEventsFromFill({ fill, sourceId, recordedTimestampMs: asOf }),
  );
  let afterState = portfolio;
  let afterSnapshot = before;
  let alerts: MonitorAlert[] = [];
  let monitorState: PortfolioMonitorState | null = previousMonitorState;
  const cashBefore = before.totalCashBaseCurrencyValue;
  if (
    events.length > 0 &&
    checks.every((c) => !c.name.endsWith('.instrument') || c.verdict === 'pass')
  ) {
    afterState = applyPortfolioEvents({ previousState: portfolio, events });
    afterSnapshot = portfolioSnapshot({
      portfolio: afterState,
      asOf,
      market,
      ...(conversions.length > 0 ? { currencyConversions: conversions } : {}),
    });
    if (afterSnapshot.totalCashBaseCurrencyValue < 0)
      check(
        'cash',
        'fail',
        afterSnapshot.totalCashBaseCurrencyValue,
        0,
        `the plan would leave base-currency cash at ${afterSnapshot.totalCashBaseCurrencyValue.toFixed(2)} (from ${cashBefore.toFixed(2)})`,
      );
    else
      check(
        'cash',
        'pass',
        afterSnapshot.totalCashBaseCurrencyValue,
        0,
        'cash stays non-negative after the plan',
      );
    if (policy.limits !== undefined && Object.keys(policy.limits).length > 0) {
      const monitor = monitorPortfolio({
        portfolio: afterState,
        market,
        asOf,
        ...(conversions.length > 0 ? { currencyConversions: conversions } : {}),
        policy: { limits: policy.limits },
        previousState: previousMonitorState,
        ...(policy.marketMaximumAgeMs !== undefined
          ? { marketStalenessLimitMs: policy.marketMaximumAgeMs }
          : {}),
        ...(input.averageDailyVolumes !== undefined
          ? { averageDailyVolumes: input.averageDailyVolumes }
          : {}),
      });
      alerts = monitor.alerts.filter((a) => a.state === 'raised' || a.state === 'active');
      monitorState = monitor.state;
      for (const alert of alerts)
        check(`limits.${alert.family}`, 'fail', alert.value, alert.threshold, alert.message);
      for (const family of monitor.evaluated.filter((e) => e.status === 'skipped')) {
        const declared =
          (family.family === 'liquidity' && policy.limits.maximumDaysToLiquidate !== undefined) ||
          (family.family === 'stale-market-data' && policy.marketMaximumAgeMs !== undefined);
        if (declared)
          check(
            `limits.${family.family}`,
            'unverifiable',
            null,
            null,
            family.reason ?? 'the monitor could not evaluate the family',
          );
      }
      if (alerts.length === 0)
        check(
          'limits',
          'pass',
          null,
          null,
          `the monitor raised no alert on the after-state (${monitor.evaluated.filter((e) => e.status === 'evaluated').length} families evaluated)`,
        );
    }
  }

  const decision = decideFromChecks(checks, policy.onUnverifiable ?? 'require-approval');
  const unverifiable = checks.filter((c) => c.verdict === 'unverifiable').map((c) => c.name);
  const body = {
    kind: PREFLIGHT_REPORT_KIND,
    schemaVersion: PREFLIGHT_REPORT_SCHEMA_VERSION,
    asOf,
    planHash: plan.contentHash,
    portfolioHash: contentHash(portfolio),
    marketHash: contentHash(market),
    marketAsOf: market.asOf as EpochMs,
    before,
    after: afterSnapshot,
    hypotheticalFills: fills,
    hypotheticalEvents: events,
    estimates: { tradedNotional, commission, spread, slippage, totalCost, turnover },
    checks,
    alerts,
    decision,
    unverifiable,
    monitorState,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      policyContentHash: contentHash(policy),
      mode: 'paper' as const,
      costRates: rates,
      fillConvention: FILL_CONVENTION,
      instrumentSources,
      decisionConvention: DECISION_CONVENTION,
    },
    diagnostics: {
      engine: 'trade-preflight' as const,
      method: 'hypothetical-fold' as const,
      converged: true as const,
      warnings,
      checkCount: checks.length,
      failedCount: checks.filter((c) => c.verdict === 'fail').length,
      unverifiableCount: unverifiable.length,
    },
  };
  return deepFreeze({ ...body, contentHash: contentHash(body) } as PreflightReport);
}
