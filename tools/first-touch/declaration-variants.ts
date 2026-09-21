/**
 * Materialize every union alternative declared for a fixtured public boundary.
 *
 * The magnitude mutant once relied on a short hand-written branch list. That list could exercise
 * useful semantic enums, but it could not prove completeness: `winsorizeFactor` added a declared
 * `standard-deviations` arm while its canonical fixture stayed on `percentile`, and no gate noticed.
 * This module reads the compiler-derived contract artifact, enumerates every declared union arm with
 * the same machinery as Phase 3B, and grafts only the selected union value onto the known-valid hand
 * fixture. The surrounding financial request therefore remains realistic while the branch source of
 * truth is the declaration rather than another table.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ATTEMPTS,
  alternativeOf,
  enumerateVariants,
  synthesizeArguments,
  unionSites,
  variantId,
  type RouteStep,
  type SynthesisParameter,
} from '../manifest/contract-synthesis.js';
import { createModelPortfolio } from '@totalfinance/portfolio';
import type { FixtureThunk } from './inputs.js';

interface ContractRecord {
  id: string;
  fields?: string[];
  signatures?: { parameters?: SynthesisParameter[] }[];
}

const artifact = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../manifest/public-contracts.json', import.meta.url)),
    'utf8',
  ),
) as { contracts: ContractRecord[] };

const contracts = new Map(artifact.contracts.map((record) => [record.id, record]));

const contractId = (headKey: string): string => {
  const separator = headKey.indexOf('.');
  return `@totalfinance/${headKey.slice(0, separator)}:${headKey.slice(separator + 1)}`;
};

function cloneValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const member of value) copy.push(cloneValue(member, seen));
    return copy;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Map) return new Map(value);
  if (value instanceof Set) return new Set(value);
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  // Builder-owned opaque values intentionally carry non-enumerable symbol brands/behavior. A
  // structural clone would silently strip those capabilities and make unrelated sibling-union
  // variants fail before reaching the branch under test. They are frozen, so sharing them across
  // a synthesized fixture is safe; variants that need a *different* opaque arm remain explicit in
  // the shrink-only gap ledger with end-to-end evidence.
  if (Object.isFrozen(value) && Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, member] of Object.entries(value)) copy[key] = cloneValue(member, seen);
  return copy;
}

function readRoute(args: readonly unknown[], route: readonly RouteStep[]): unknown {
  let value: unknown = args;
  for (const step of route) {
    if ('argument' in step) value = (value as readonly unknown[])[step.argument];
    else if ('property' in step)
      value = (value as Record<string, unknown> | undefined)?.[step.property];
    else if ('position' in step) value = (value as readonly unknown[] | undefined)?.[step.position];
    else value = (value as readonly unknown[] | undefined)?.[0];
  }
  return value;
}

function branchValue(type: string | undefined, synthesized: unknown): unknown {
  if (!type) return synthesized;
  const literal = /^'([^']+)'$/.exec(type);
  if (literal) return literal[1];
  if (/ReadonlyArray<\{ cashFlowDate:/.test(type))
    return [
      { cashFlowDate: '2027-12-31', amount: 120 },
      { cashFlowDate: '2028-12-31', amount: 135 },
    ];
  if (/ReadonlyArray<\{ timeYears:/.test(type))
    return [
      { timeYears: 1, amount: 120 },
      { timeYears: 2, amount: 135 },
    ];
  if (/fractionOfRevenue/.test(type)) return { fractionOfRevenue: 0.05 };
  if (/growthRate/.test(type)) return { growthRate: 0.05 };
  if (/\{ amount: number/.test(type)) return { amount: 100 };
  if (/type: 'periodic'/.test(type)) return { type: 'periodic', periodsPerYear: 12 };
  if (/method: 'perpetual-growth'/.test(type))
    return { method: 'perpetual-growth', terminalCashFlow: 135, perpetualGrowthRate: 0.025 };
  if (/method: 'exit-multiple'/.test(type))
    return { method: 'exit-multiple', terminalMetricAmount: 300, exitMultiple: 8 };
  if (/ReadonlyArray<string>|string\[\]/.test(type)) return ['tech'];
  if (/ReadonlyArray<number>|number\[\]/.test(type)) return [0.1];
  if (type === 'string') return 'tech';
  if (type === 'number') return 0.1;
  if (type === 'true') return true;
  if (type === 'false' || type === 'boolean') return false;
  return synthesized;
}

function directlyMatchesBranch(
  value: unknown,
  type: string | undefined,
  choice: {
    absent?: boolean;
    discriminator?: { field: string; value: string | number | boolean }[];
  },
): boolean {
  if (choice.absent === true) return value === undefined;
  if (choice.discriminator?.length) {
    if (value === null || typeof value !== 'object') return false;
    return choice.discriminator.every(
      (tag) => (value as Record<string, unknown>)[tag.field] === tag.value,
    );
  }
  if (!type) return value !== undefined;
  const literal = /^'([^']+)'$/.exec(type);
  if (literal) return value === literal[1];
  if (/ReadonlyArray<\{ cashFlowDate:/.test(type))
    return Array.isArray(value) && value.length > 0 && value.every((row) => 'cashFlowDate' in row);
  if (/ReadonlyArray<\{ timeYears:/.test(type))
    return Array.isArray(value) && value.length > 0 && value.every((row) => 'timeYears' in row);
  if (/fractionOfRevenue/.test(type))
    return value !== null && typeof value === 'object' && 'fractionOfRevenue' in value;
  if (/growthRate/.test(type))
    return value !== null && typeof value === 'object' && 'growthRate' in value;
  if (/\{ amount: number/.test(type))
    return value !== null && typeof value === 'object' && 'amount' in value;
  if (/ReadonlyArray<string>|string\[\]/.test(type))
    return Array.isArray(value) && value.every((member) => typeof member === 'string');
  if (/ReadonlyArray<number>|number\[\]/.test(type))
    return Array.isArray(value) && value.every((member) => typeof member === 'number');
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number';
  if (type === 'true') return value === true;
  if (type === 'false') return value === false;
  return value !== undefined;
}

/** Set (or delete for an absent presence gate) the value at one declaration route. */
function writeRoute(
  args: unknown[],
  route: readonly RouteStep[],
  value: unknown,
  absent: boolean,
): boolean {
  const write = (parent: unknown, index: number): boolean => {
    const step = route[index];
    if (!step) return false;
    const final = index === route.length - 1;
    if ('element' in step) {
      if (!Array.isArray(parent) || parent.length === 0) return false;
      if (final) {
        if (absent) parent.splice(0);
        else
          for (let member = 0; member < parent.length; member += 1)
            parent[member] = cloneValue(value);
        return true;
      }
      // An element declaration applies to EVERY member, not just index zero. Mutating only the first
      // produced a mixed dated/timed DCF schedule while claiming to exercise the array's other arm.
      return parent.every((member) => write(member, index + 1));
    }
    const key =
      'argument' in step ? step.argument : 'property' in step ? step.property : step.position;
    if (
      parent === null ||
      parent === undefined ||
      (typeof parent !== 'object' && !Array.isArray(parent))
    )
      return false;
    if (final) {
      if (absent) delete (parent as Record<string | number, unknown>)[key];
      else (parent as Record<string | number, unknown>)[key] = cloneValue(value);
      return true;
    }
    return write((parent as Record<string | number, unknown>)[key], index + 1);
  };
  return write(args, 0);
}

function normalizeScreenFilter(value: unknown): Record<string, unknown> {
  const node = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if ('all' in node)
    return {
      all:
        Array.isArray(node['all']) && node['all'].length > 0
          ? node['all'].map(normalizeScreenFilter)
          : [{ field: 'returnOnInvestedCapital', operator: 'greaterThan', value: 0.1 }],
    };
  if ('any' in node)
    return {
      any:
        Array.isArray(node['any']) && node['any'].length > 0
          ? node['any'].map(normalizeScreenFilter)
          : [{ field: 'returnOnInvestedCapital', operator: 'greaterThan', value: 0.1 }],
    };
  if ('not' in node) return { not: normalizeScreenFilter(node['not']) };
  const operator = typeof node['operator'] === 'string' ? node['operator'] : 'greaterThan';
  if (operator === 'between')
    return { field: 'returnOnInvestedCapital', operator, from: 0.05, to: 0.25 };
  if (operator === 'in' || operator === 'notIn') {
    const stringValues = Array.isArray(node['values']) && typeof node['values'][0] === 'string';
    return stringValues
      ? { field: 'sector', operator, values: ['tech'] }
      : { field: 'returnOnInvestedCapital', operator, values: [0.1] };
  }
  if (operator === 'isPresent' || operator === 'isMissing')
    return { field: 'returnOnInvestedCapital', operator };
  const raw = node['value'];
  if (typeof raw === 'string') return { field: 'sector', operator, value: 'tech' };
  if (typeof raw === 'boolean') return { field: 'isActive', operator, value: raw };
  return { field: 'returnOnInvestedCapital', operator, value: 0.1 };
}

/** Repair semantic relationships synthesis cannot infer while preserving the selected branch. */
function normalizeCandidate(headKey: string, args: unknown[]): void {
  const root = args[0] as Record<string, unknown> | undefined;
  if (!root) return;
  if (headKey === 'research.screenUniverse') {
    const definitions = root['fieldDefinitions'] as Array<Record<string, unknown>>;
    if (!definitions.some((definition) => definition['fieldName'] === 'isActive'))
      definitions.push({ fieldName: 'isActive', kind: 'boolean' });
    for (const observation of root['observations'] as Array<Record<string, unknown>>) {
      (observation['fields'] as Record<string, unknown>)['isActive'] = true;
    }
    if (root['filter'] !== undefined) root['filter'] = normalizeScreenFilter(root['filter']);
    return;
  }
  if (headKey.startsWith('portfolio.')) {
    // The event envelope duplicates `event.eventType` at the top level BY DESIGN (agent-native
    // envelope grammar), so a grafted event arm must be mirrored onto its envelope, and the
    // synthesized fragment's identity/currency/amount fields must satisfy the ledger's semantic
    // relations (real currency codes, positive amounts, a 2-for-1 split) — the fold refuses the
    // declaration's placeholder strings, not the arm.
    const base = Date.UTC(2026, 0, 2, 15);
    const HOUR_MS = 3_600_000;
    type Bag = Record<string, unknown>;
    const isBag = (value: unknown): value is Bag => !!value && typeof value === 'object';
    const isEconomic = (eventType: unknown): boolean =>
      typeof eventType === 'string' && !eventType.startsWith('admin.');
    const deposit = (): Bag => ({ eventType: 'cash.deposit', amount: 100, currency: 'USD' });
    const repairBody = (ev: Bag): void => {
      delete ev['relatesToEventId'];
      delete ev['settleTimestampMs'];
      delete ev['lotSelections'];
      if ('currency' in ev) ev['currency'] = 'USD';
      if ('amount' in ev) ev['amount'] = 100;
      if ('instrumentId' in ev) ev['instrumentId'] = 'AAPL';
      switch (ev['eventType']) {
        case 'trade.fill':
          ev['quantity'] = 10;
          ev['pricePerUnit'] = 150;
          if (ev['side'] !== 'sell') ev['side'] = 'buy';
          break;
        case 'cash.transfer':
          ev['fromAccountId'] = 'main';
          ev['toAccountId'] = 'ira';
          break;
        case 'cash.conversion':
          ev['fromCurrency'] = 'USD';
          ev['toCurrency'] = 'EUR';
          ev['fromAmount'] = 100;
          ev['toAmount'] = 92;
          break;
        case 'corporate.split':
          ev['sharesAfterSplit'] = 2;
          ev['sharesBeforeSplit'] = 1;
          break;
        case 'admin.account-migration':
          ev['fromAccountId'] = 'main';
          ev['toAccountId'] = 'ira';
          break;
        // FC7 slice 5 — the lifecycle families. Their arms are grafted onto the first event, where
        // nothing is held yet, so the fold refuses them (a lifecycle event transforms HELD lots);
        // the bodies are still repaired so the refusal is the position teaching, not a placeholder.
        case 'derivative.exercise':
        case 'derivative.assignment': {
          ev['quantity'] = 1;
          const settlement = isBag(ev['settlement']) ? ev['settlement'] : { kind: 'physical' };
          if (settlement['kind'] === 'cash') {
            ev['settlement'] = { kind: 'cash', settlementPricePerUnit: 210 };
          } else {
            ev['settlement'] = { kind: 'physical' };
          }
          if (ev['premiumTreatment'] !== 'fold-into-underlying-basis')
            ev['premiumTreatment'] = 'realize';
          break;
        }
        case 'derivative.expiration':
          ev['quantity'] = 1;
          break;
        case 'derivative.multiplier-change':
          ev['contractMultiplierAfter'] = 200;
          if (ev['strikePricePerUnitAfter'] !== undefined) ev['strikePricePerUnitAfter'] = 100;
          break;
        case 'derivative.variation-margin':
          ev['settlementPricePerUnit'] = 4_520;
          break;
        case 'derivative.roll':
          ev['fromInstrumentId'] = 'ESH6';
          ev['toInstrumentId'] = 'ESM6';
          ev['quantity'] = 1;
          ev['closePricePerUnit'] = 4_510;
          ev['openPricePerUnit'] = 4_530;
          if (ev['contract'] !== undefined) ev['contract'] = repairContractTerms(ev['contract']);
          break;
        case 'fixed-income.redemption':
          ev['quantity'] = 1_000;
          ev['pricePerUnit'] = 1;
          if (
            !['maturity', 'call', 'principal-paydown', 'sinking-fund'].includes(
              ev['redemptionType'] as string,
            )
          )
            ev['redemptionType'] = 'maturity';
          break;
        case 'corporate.symbol-change':
          ev['fromInstrumentId'] = 'AAPL';
          ev['toInstrumentId'] = 'AAPL-NEW';
          break;
        case 'corporate.merger':
          ev['fromInstrumentId'] = 'AAPL';
          if (ev['sharesPerShare'] !== undefined) {
            ev['sharesPerShare'] = 0.5;
            ev['toInstrumentId'] = 'MSFT';
          } else {
            delete ev['toInstrumentId'];
          }
          if (ev['cashPerShare'] !== undefined) {
            ev['cashPerShare'] = 30;
            ev['currency'] = 'USD';
          } else {
            delete ev['currency'];
          }
          if (ev['sharesPerShare'] === undefined && ev['cashPerShare'] === undefined) {
            ev['cashPerShare'] = 30;
            ev['currency'] = 'USD';
          }
          break;
        case 'corporate.spin-off':
          ev['parentInstrumentId'] = 'AAPL';
          ev['childInstrumentId'] = 'AAPL-SPIN';
          ev['sharesPerParentShare'] = 2;
          ev['basisAllocationFraction'] = 0.2;
          break;
        case 'corporate.return-of-capital':
          ev['amountPerShare'] = 1.5;
          break;
        case 'corporate.cash-in-lieu':
          ev['quantity'] = 0.4;
          ev['amount'] = 60;
          break;
        case 'position.transfer':
          ev['quantity'] = 1;
          ev['fromAccountId'] = 'main';
          ev['toAccountId'] = 'ira';
          break;
        default:
          break;
      }
      // A fill's instrument profile (slice 5): a derivative fill states its multiplier and the
      // settlement style its contract kind requires; the terms themselves need real ids and dates.
      if (ev['eventType'] === 'trade.fill') {
        if (ev['contract'] !== undefined) {
          ev['contract'] = repairContractTerms(ev['contract']);
          const kind = (ev['contract'] as Bag)['kind'];
          ev['contractMultiplier'] = kind === 'option' ? 100 : 50;
          ev['settlementStyle'] = kind === 'option' ? 'cash-on-trade' : 'variation-margin';
        } else if (ev['settlementStyle'] === 'variation-margin') {
          ev['contractMultiplier'] = 50;
        } else if (ev['contractMultiplier'] !== undefined) {
          ev['contractMultiplier'] = 1;
        }
        if (ev['accruedInterest'] !== undefined) ev['accruedInterest'] = 12.5;
      }
    };
    function repairContractTerms(value: unknown): Bag {
      const terms: Bag = isBag(value) ? value : {};
      const kind =
        terms['kind'] === 'future' || terms['kind'] === 'perpetual' ? terms['kind'] : 'option';
      const expiry = Date.UTC(2026, 5, 19);
      if (kind === 'option') {
        return {
          kind,
          underlyingInstrumentId: 'AAPL',
          right: terms['right'] === 'put' ? 'put' : 'call',
          strikePricePerUnit: 200,
          expiryTimestampMs: expiry,
        };
      }
      if (kind === 'future')
        return { kind, underlyingInstrumentId: 'ES', expiryTimestampMs: expiry };
      return { kind, underlyingInstrumentId: 'BTC' };
    }
    const repairEnvelope = (env: Bag, eventId: string): void => {
      const ev = env['event'] as Bag;
      env['eventType'] = ev['eventType'];
      env['schemaVersion'] = 1;
      if (typeof env['eventId'] !== 'string' || !env['eventId']) env['eventId'] = eventId;
      if (typeof env['sourceId'] !== 'string' || !env['sourceId']) env['sourceId'] = 'fixture';
      env['accountId'] = 'main';
      env['provenance'] = {};
      for (const key of ['correlationId', 'causationId', 'reversesEventId']) delete env[key];
    };
    // A repair (admin.reversal / admin.correction) carries the envelope it repairs and links it by
    // `reversesEventId`; both are repaired to well-formed economic facts so the grafted arm reaches
    // the FOLD (which refuses it as a typed target-missing teaching: the builder grafts at index 0,
    // where no applied fact can precede it — see DECLARED_BRANCH_GAP_LEDGER in overflow-sweep).
    const repairEvents = (events: unknown): void => {
      if (!Array.isArray(events)) return;
      events.forEach((envelope, index) => {
        if (!isBag(envelope) || !isBag(envelope['event'])) return;
        const env = envelope;
        const ev = env['event'] as Bag;
        repairBody(ev);
        repairEnvelope(env, `evt-${index}`);
        env['effectiveTimestampMs'] = base + index * HOUR_MS;
        env['recordedTimestampMs'] = base + index * HOUR_MS;
        const type = ev['eventType'];
        if (type !== 'admin.reversal' && type !== 'admin.correction') return;
        if (!isBag(ev['original']) || !isBag((ev['original'] as Bag)['event'])) {
          ev['original'] = { event: deposit() };
        }
        const original = ev['original'] as Bag;
        if (!isEconomic((original['event'] as Bag)['eventType'])) original['event'] = deposit();
        repairBody(original['event'] as Bag);
        original['eventId'] = `orig-${index}`;
        repairEnvelope(original, `orig-${index}`);
        original['effectiveTimestampMs'] = base + index * HOUR_MS - HOUR_MS / 2;
        original['recordedTimestampMs'] = base + index * HOUR_MS - HOUR_MS / 2;
        env['reversesEventId'] = original['eventId'];
        if (type !== 'admin.correction') return;
        if (!isBag(ev['replacement']) || !isEconomic((ev['replacement'] as Bag)['eventType'])) {
          ev['replacement'] = deposit();
        }
        repairBody(ev['replacement'] as Bag);
      });
    };
    repairEvents(root['events']);
    // `asOf: EpochMs | string` — the declared string arm must be a real date grammar, not the
    // declaration's placeholder word.
    // A zoned instant: valid at every boundary (ledger dates accept it; pricing paths require it).
    if (typeof root['asOf'] === 'string') root['asOf'] = '2026-02-01T16:00:00-05:00';
    // ...and the epoch-millisecond arm must be an integer instant a Date represents (the package's
    // one as-of law), not the declaration's 0.1.
    if (typeof root['asOf'] === 'number') root['asOf'] = Date.UTC(2026, 1, 1);
    const external = root['external'];
    if (isBag(external) && typeof external['asOf'] === 'number')
      external['asOf'] = Date.UTC(2026, 1, 1);
    const ledger = root['ledger'];
    if (isBag(ledger)) repairEvents(ledger['events']);
    if (root['portfolio'] && typeof root['portfolio'] === 'object')
      (root['portfolio'] as Record<string, unknown>)['baseCurrency'] = 'USD';
    // FC7 slice 4 — the policy grammar. The declaration's date arms are a placeholder word (string
    // arm) or 0.1 (epoch arm); the grammar wants real dates that ORDER (effectiveTo after
    // effectiveFrom, glide points strictly increasing, liabilities non-decreasing). A grafted model
    // is a content-addressed ARTIFACT, so a synthesized one can never carry a valid hash: the hook
    // mirrors the synthesized model's arm kinds (which dates are numbers, which optional parts are
    // present) into a real createModelPortfolio call. (A grafted reconciliation companion never
    // reaches this hook: the builder cannot synthesize a produced report — see the overflow ledger.)
    const DAY_MS = 86_400_000;
    const dateAt = (value: unknown, dayOffset: number): number | string => {
      const ms = Date.UTC(2026, 0, 1) + dayOffset * DAY_MS;
      return typeof value === 'number' ? ms : new Date(ms).toISOString().slice(0, 10);
    };
    const canonicalTargets = (): Bag[] => [
      { group: { tag: 'equity' }, weight: 0.6 },
      { group: { tag: 'fixed-income' }, weight: 0.3 },
      { group: { assetClass: 'cash' }, weight: 0.1 },
    ];
    const GROUP_KEYS = [
      'instrumentId',
      'sleeveId',
      'assetClass',
      'currency',
      'tag',
      'underlying',
      'strategy',
    ];
    const wellFormedTarget = (target: unknown): boolean =>
      isBag(target) &&
      isBag(target['group']) &&
      GROUP_KEYS.filter((key) => (target['group'] as Bag)[key] !== undefined).length === 1 &&
      (target['weight'] !== undefined) !== (target['riskBudget'] !== undefined);
    const repairTargets = (targets: unknown): Bag[] =>
      Array.isArray(targets) && targets.length > 0 && targets.every(wellFormedTarget)
        ? (targets as Bag[])
        : canonicalTargets();
    const repairTargetSet = (set: unknown, dayOffset: number, allowEnd: boolean): Bag => {
      const out: Bag = isBag(set) ? set : {};
      out['effectiveFrom'] = dateAt(out['effectiveFrom'], dayOffset);
      if (allowEnd && out['effectiveTo'] !== undefined) {
        out['effectiveTo'] = dateAt(out['effectiveTo'], dayOffset + 20);
      } else {
        delete out['effectiveTo'];
      }
      out['targets'] = repairTargets(out['targets']);
      if (out['note'] !== undefined && typeof out['note'] !== 'string') delete out['note'];
      return out;
    };
    const repairBenchmark = (benchmark: Bag): void => {
      if (typeof benchmark['benchmarkId'] !== 'string') benchmark['benchmarkId'] = 'SPX';
      if (benchmark['asOf'] !== undefined) benchmark['asOf'] = dateAt(benchmark['asOf'], 31);
      if (benchmark['constituents'] !== undefined) {
        benchmark['constituents'] = [{ instrumentId: 'AAPL', weight: 1 }];
      }
    };
    const repairModelDefinition = (definition: Bag): Bag => {
      if (typeof definition['modelId'] !== 'string' || !definition['modelId'])
        definition['modelId'] = 'balanced';
      if (!Number.isSafeInteger(definition['version']) || (definition['version'] as number) < 1)
        definition['version'] = 1;
      definition['baseCurrency'] = 'USD';
      definition['strategic'] = repairTargetSet(definition['strategic'], 0, true);
      if (definition['tactical'] !== undefined) {
        const sets = Array.isArray(definition['tactical']) ? definition['tactical'] : [{}];
        definition['tactical'] = sets.map((set, index) =>
          repairTargetSet(set, 60 + index * 40, true),
        );
      }
      if (definition['glidePath'] !== undefined) {
        const glide: Bag = isBag(definition['glidePath']) ? definition['glidePath'] : {};
        if (glide['interpolation'] !== 'linear') glide['interpolation'] = 'step';
        const points =
          Array.isArray(glide['points']) && glide['points'].length > 0 ? glide['points'] : [{}];
        glide['points'] = points.map((point, index) => {
          const set = repairTargetSet(point, 100 + index * 30, false);
          set['targets'] = canonicalTargets(); // linear needs ONE group set across points
          return set;
        });
        definition['glidePath'] = glide;
      }
      if (definition['sleeves'] !== undefined) {
        definition['sleeves'] = [
          { sleeveId: 'core', members: [{ instrumentId: 'AAPL', weight: 1 }] },
        ];
      }
      if (definition['benchmark'] !== undefined) {
        if (!isBag(definition['benchmark'])) definition['benchmark'] = {};
        repairBenchmark(definition['benchmark'] as Bag);
      }
      if (definition['liabilities'] !== undefined) {
        const schedule: Bag = isBag(definition['liabilities']) ? definition['liabilities'] : {};
        const entries = Array.isArray(schedule['entries']) ? schedule['entries'] : [{}];
        schedule['entries'] = entries.map((entry, index) => ({
          date: dateAt(isBag(entry) ? entry['date'] : undefined, 200 + index * 10),
          amount: 1_000,
          currency: 'USD',
        }));
        if (schedule['note'] !== undefined && typeof schedule['note'] !== 'string')
          delete schedule['note'];
        definition['liabilities'] = schedule;
      }
      if (definition['horizonEndDate'] !== undefined) {
        definition['horizonEndDate'] = dateAt(definition['horizonEndDate'], 400);
      }
      if (definition['note'] !== undefined && typeof definition['note'] !== 'string')
        delete definition['note'];
      return definition;
    };
    if (headKey === 'portfolio.createModelPortfolio') {
      repairModelDefinition(root);
      return;
    }
    const policy = root['policy'];
    if (isBag(policy)) {
      if (policy['targets'] !== undefined) policy['targets'] = repairTargets(policy['targets']);
      if (isBag(policy['model'])) {
        const definition: Bag = { ...(policy['model'] as Bag) };
        delete definition['kind'];
        delete definition['schemaVersion'];
        delete definition['contentHash'];
        policy['model'] = createModelPortfolio(repairModelDefinition(definition) as never);
        delete policy['targets'];
      }
      if (policy['benchmark'] !== undefined) {
        if (!isBag(policy['benchmark'])) policy['benchmark'] = {};
        repairBenchmark(policy['benchmark'] as Bag);
      }
      const limits = policy['limits'];
      if (isBag(limits) && Array.isArray(limits['maximumGroupWeights'])) {
        limits['maximumGroupWeights'] = limits['maximumGroupWeights'].map((row) => ({
          group: { tag: 'equity' },
          maximumWeight:
            isBag(row) && typeof row['maximumWeight'] === 'number' ? row['maximumWeight'] : 0.7,
        }));
      }
    }
    return;
  }
  if (!headKey.startsWith('valuation.')) return;

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    const compounding = object['compounding'];
    if (
      compounding &&
      typeof compounding === 'object' &&
      (compounding as Record<string, unknown>)['type'] === 'periodic'
    )
      (compounding as Record<string, unknown>)['periodsPerYear'] = 12;
    const terminal = object['terminalValueMethod'];
    if (terminal !== undefined) {
      const method =
        terminal && typeof terminal === 'object'
          ? (terminal as Record<string, unknown>)['method']
          : undefined;
      if (method === 'exit-multiple')
        object['terminalValueMethod'] = {
          method: 'exit-multiple',
          terminalMetricAmount: 300,
          exitMultiple: 8,
        };
      else if (method === 'perpetual-growth' || typeof terminal !== 'object')
        object['terminalValueMethod'] = {
          method: 'perpetual-growth',
          terminalCashFlow: 135,
          perpetualGrowthRate: 0.025,
        };
    }
    const flows = object['projectedCashFlows'];
    if (Array.isArray(flows) && flows.length > 0) {
      const dated = flows.some(
        (flow) => flow && typeof flow === 'object' && 'cashFlowDate' in (flow as object),
      );
      object['projectedCashFlows'] = flows.map((flow, index) => {
        const amount =
          flow &&
          typeof flow === 'object' &&
          Number.isFinite((flow as Record<string, unknown>)['amount'])
            ? ((flow as Record<string, unknown>)['amount'] as number)
            : 100 + index * 10;
        return dated
          ? { cashFlowDate: `${2027 + index}-12-31`, amount }
          : { timeYears: index + 1, amount };
      });
      if (dated) object['dayCount'] = 'ACT/365F';
      else delete object['dayCount'];
    }
    const distribution = object['distribution'];
    if (distribution && typeof distribution === 'object') {
      const type = (distribution as Record<string, unknown>)['type'];
      if (type === 'normal')
        object['distribution'] = { type, mean: 0.09, standardDeviation: 0.005 };
      else if (type === 'uniform') object['distribution'] = { type, from: 0.08, to: 0.1 };
      else if (type === 'triangular')
        object['distribution'] = { type, minimum: 0.08, mode: 0.09, maximum: 0.1 };
    }
    Object.values(object).forEach(visit);
  };
  visit(root);

  if (headKey === 'valuation.discountedCashFlowScenarioAnalysis') {
    const base = root['discountedCashFlowInput'] as Record<string, unknown>;
    for (const scenario of root['scenarios'] as Array<Record<string, unknown>>) {
      const overrides = scenario['overrides'] as Record<string, unknown>;
      const flows = overrides['projectedCashFlows'];
      if (Array.isArray(flows) && flows.length > 0) {
        const dated = flows.every(
          (flow) => flow && typeof flow === 'object' && 'cashFlowDate' in (flow as object),
        );
        if (dated) overrides['dayCount'] = 'ACT/365F';
        else delete overrides['dayCount'];
      }
    }
    // `visit` correctly governs the base schedule itself.
    void base;
  }

  if (headKey === 'valuation.discountedCashFlowSensitivityTable') {
    const dcf = root['discountedCashFlowInput'] as Record<string, unknown>;
    const terminal = dcf['terminalValueMethod'] as Record<string, unknown>;
    root['rowAxis'] = { variable: 'annual-discount-rate', values: [0.08, 0.09] };
    root['columnAxis'] =
      terminal['method'] === 'exit-multiple'
        ? { variable: 'exit-multiple', values: [7, 8] }
        : { variable: 'perpetual-growth-rate', values: [0.02, 0.025] };
  }
}

const sameChoice = (
  left: { branch: number; absent?: boolean },
  right: { branch: number; absent?: boolean },
): boolean => left.branch === right.branch && left.absent === right.absent;

const routePrefix = (ancestor: readonly RouteStep[], descendant: readonly RouteStep[]): boolean =>
  ancestor.length <= descendant.length &&
  ancestor.every((step, index) => JSON.stringify(step) === JSON.stringify(descendant[index]));

export interface DeclaredVariantResult {
  fixtures: { id: string; fixture: FixtureThunk }[];
  gaps: string[];
}

/**
 * Return one known-valid fixture for every declared union alternative beyond the canonical fixture.
 * Any branch that cannot be materialized and called successfully is a named gap; callers fail their
 * suite rather than quietly measuring the branch they happened to have.
 */
export function declaredVariantFixtures(input: {
  headKey: string;
  canonical: FixtureThunk;
  fn: (...args: unknown[]) => unknown;
}): DeclaredVariantResult {
  const record = contracts.get(contractId(input.headKey));
  if (!record) return { fixtures: [], gaps: [`${input.headKey}: no compiler-derived contract`] };
  const parameters = record.signatures?.[0]?.parameters ?? [];
  const fields = record.fields ?? [];
  const enumerated = enumerateVariants(parameters, fields);
  if (enumerated.variants.length <= 1) return { fixtures: [], gaps: [] };
  const sites = unionSites(parameters, fields);
  const canonicalArgs = input.canonical();
  const selected = alternativeOf(canonicalArgs, sites);
  if (selected === null) {
    return { fixtures: [], gaps: [`${input.headKey}: canonical fixture selects no declared arm`] };
  }
  const fixtures: DeclaredVariantResult['fixtures'] = [];
  const gaps: string[] = [];

  // One obligation per (declaration site, alternative). This is stronger and simpler than assuming
  // one enumerated call equals one branch: an enumerated call also writes canonical choices for every
  // independent sibling, while a financial hand fixture may intentionally use a different sibling.
  for (const site of sites) {
    for (const alternative of site.alternatives) {
      const canonicalChoice = selected.get(site.key);
      if (canonicalChoice && sameChoice(canonicalChoice, alternative)) continue;
      const variant = enumerated.variants.find((candidate) => {
        const choice = candidate.selection.get(site.key);
        return choice !== undefined && sameChoice(choice, alternative);
      });
      const id = variantId(site.path, alternative);
      if (!variant) {
        gaps.push(`${input.headKey}#${id}: declaration enumerated no call for this arm`);
        continue;
      }
      let accepted: FixtureThunk | null = null;
      let lastError = '';
      for (let attempt = 0; attempt < ATTEMPTS && accepted === null; attempt += 1) {
        const synthesized =
          synthesizeArguments(parameters, fields, attempt, undefined, variant.selection) ??
          (cloneValue(canonicalArgs) as unknown[]);
        const grafted = cloneValue(canonicalArgs) as unknown[];
        // Only the target union and the ancestor unions needed to reach it come from synthesis.
        // Independent siblings stay on the known-valid hand fixture instead of being reset to the
        // declaration's first branch (the source of the old DCF baseline rejections).
        const selectedSites = sites
          .filter(
            (candidate) =>
              variant.selection.has(candidate.key) && routePrefix(candidate.route, site.route),
          )
          .sort((left, right) => left.route.length - right.route.length);
        let writable = true;
        for (const site of selectedSites) {
          const choice = variant.selection.get(site.key)!;
          const branchType = site.branchTypes?.[choice.branch];
          const selectedValue = branchValue(branchType, readRoute(synthesized, site.route));
          if (!writeRoute(grafted, site.route, selectedValue, choice.absent === true)) {
            writable = false;
            break;
          }
        }
        if (!writable) continue;
        normalizeCandidate(input.headKey, grafted);
        const realized = alternativeOf(grafted, sites);
        const realizedChoice = realized?.get(site.key);
        if (
          (!realizedChoice || !sameChoice(realizedChoice, alternative)) &&
          !directlyMatchesBranch(
            readRoute(grafted, site.route),
            site.branchTypes?.[alternative.branch],
            alternative,
          )
        )
          continue;
        try {
          input.fn(...(cloneValue(grafted) as unknown[]));
          accepted = () => cloneValue(grafted) as unknown[];
        } catch (error) {
          lastError = String((error as Error)?.message ?? error)
            .split('\n')[0]!
            .slice(0, 180);
          // The synthesized branch fragment can still violate a semantic relation. Walk the existing
          // three-attempt value ladder; if all fail, the gap is explicit and needs one curated fixture.
        }
      }
      if (accepted) fixtures.push({ id, fixture: accepted });
      else
        gaps.push(
          `${input.headKey}#${id}: no successful declared-branch baseline${
            lastError
              ? ` (${lastError})`
              : ` [route=${JSON.stringify(site.route)}, type=${site.branchTypes?.[alternative.branch] ?? 'unknown'}]`
          }`,
        );
    }
  }
  if (enumerated.truncated) gaps.push(`${input.headKey}: declared variants were truncated`);
  return { fixtures, gaps };
}
