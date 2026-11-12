/** Local immutable research choices. Original pages never change and calculations remain ordinary. */
import { ErrorCode, DataError, InputError } from './errors.js';
import { object, numberField, textField, enumField, fail } from './data-validation.js';
import { bounded, equalData, freezeData, barIssues } from './data-protocol.js';
import type {
  DataPage,
  PriceBarRecord,
  ResearchBarChoice,
  ResearchBarSelection,
  RowRef,
  OhlcvInput,
  TimestampedOhlcvInput,
} from './data-types.js';
const fields = ['open', 'high', 'low', 'close'] as const;
const key = (r: RowRef) => r.pageIndex + ':' + r.rowIndex;
function ref(value: unknown, pages: readonly DataPage<PriceBarRecord>[]): RowRef {
  const r = object(value, 'row', ['pageIndex', 'rowIndex']);
  numberField(r['pageIndex'], 'row.pageIndex', 0, pages.length - 1, true);
  numberField(r['rowIndex'], 'row.rowIndex', 0, pages[r['pageIndex']]!.data.length - 1, true);
  return r as unknown as RowRef;
}
export function researchSelection(
  pages: readonly DataPage<PriceBarRecord>[],
  input?: unknown,
  verifyRows = true,
) {
  const rows = pages.flatMap((p, pageIndex) =>
      p.data.map((r, rowIndex) => ({ ref: { pageIndex, rowIndex }, bar: r.bar })),
    ),
    issues = freezeData(pages.flatMap((p, i) => barIssues(p.data, i))),
    resolved = new Set<string>(),
    excluded = new Set<string>(),
    corrected = new Map<string, PriceBarRecord['bar']>();
  const decisions: ResearchBarChoice[] = [];
  const affected = new Set(issues.map(key));
  function decision(value: unknown) {
    const d = object(value, 'choice');
    enumField(d['action'], 'choice.action', ['use', 'exclude', 'correct']);
    textField(d['reason'], 'choice.reason', 512);
    object(
      value,
      'choice',
      d['action'] === 'correct'
        ? ['action', 'corrections', 'reason']
        : ['action', 'rows', 'reason'],
    );
    const choices: RowRef[] = [];
    if (d['action'] === 'correct') {
      if (!Array.isArray(d['corrections']) || !d['corrections'].length) fail('choice.corrections');
      for (const c of d['corrections']) {
        const x = object(c, 'correction', ['row', 'values']);
        const r = ref(x['row'], pages),
          v = object(x['values'], 'values', fields);
        if (!Object.keys(v).length) fail('values');
        for (const f of Object.keys(v)) numberField(v[f], 'values.' + f);
        const original = pages[r.pageIndex]!.data[r.rowIndex]!;
        const bar = { ...original.bar, ...v };
        if (barIssues([{ ...original, bar }], r.pageIndex).length)
          fail('values', ErrorCode.InputOutOfRange);
        corrected.set(key(r), bar);
        choices.push(r);
      }
    } else if (d['rows'] !== undefined) {
      if (!Array.isArray(d['rows']) || !d['rows'].length) fail('choice.rows');
      for (const r of d['rows']) choices.push(ref(r, pages));
    } else
      for (const row of rows)
        if (affected.has(key(row.ref)) && !resolved.has(key(row.ref))) choices.push(row.ref);
    if (!choices.length || new Set(choices.map(key)).size !== choices.length) fail('choice.rows');
    for (const r of choices) {
      const k = key(r);
      if (!affected.has(k) || resolved.has(k)) fail('choice.rows');
      resolved.add(k);
      if (d['action'] === 'exclude') excluded.add(k);
    }
    decisions.push(freezeData(d as unknown as ResearchBarChoice));
  }
  let supplied: ResearchBarSelection | undefined;
  if (input !== undefined) {
    bounded(input);
    const s = object(input, 'selection', ['version', 'decisions', 'sourceRows']);
    enumField(s['version'], 'selection.version', [1]);
    if (!Array.isArray(s['decisions']) || s['decisions'].length > rows.length)
      fail('selection.decisions');
    for (const d of s['decisions']) decision(d);
    supplied = s as unknown as ResearchBarSelection;
  }
  const included = rows.filter((r) => !excluded.has(key(r.ref))),
    selection = freezeData({
      version: 1 as const,
      decisions,
      sourceRows: included.map((r) => r.ref),
    });
  if (supplied && verifyRows && !equalData(selection, supplied)) fail('selection.sourceRows');
  function select(name: 'closePrices' | 'ohlcvBars' | 'bars') {
    const used = name === 'closePrices' ? ['close'] : fields;
    const issue = issues.find(
      (i) =>
        !resolved.has(key(i)) && !excluded.has(key(i)) && i.fields.some((f) => used.includes(f)),
    );
    if (issue)
      throw new DataError(name + ': suspect observations require an explicit research decision.', {
        code: ErrorCode.DataSuspectObservations,
        context: { ...issue, selection: name },
      });
    return Object.freeze(
      included.map(({ ref: r, bar: original }, index) => {
        const b = corrected.get(key(r)) ?? original;
        if (name === 'closePrices') return b.close;
        if (b.volume === undefined)
          throw new InputError(name + ': actual volume is required on every selected row.', {
            code: ErrorCode.InputMissingField,
            context: { field: 'volume', ...r, index },
          });
        const o = { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
        return Object.freeze(
          name === 'bars'
            ? {
                symbol: b.symbol,
                timestampMs: b.timestampMs,
                ...o,
                ...(b.adjusted === undefined ? {} : { adjusted: b.adjusted }),
                ...(b.vwap === undefined ? {} : { vwap: b.vwap }),
              }
            : o,
        );
      }),
    );
  }
  return {
    issues,
    selection,
    descriptors() {
      let closes: readonly number[] | undefined,
        ohlcv: readonly OhlcvInput[] | undefined,
        bars: readonly TimestampedOhlcvInput[] | undefined;
      return {
        issues: { value: issues, enumerable: true },
        selection: { value: selection, enumerable: true },
        selections: {
          value: Object.freeze(['closePrices', 'ohlcvBars', 'bars']),
          enumerable: true,
        },
        closePrices: { get: () => (closes ??= select('closePrices') as readonly number[]) },
        ohlcvBars: { get: () => (ohlcv ??= select('ohlcvBars') as readonly OhlcvInput[]) },
        bars: { get: () => (bars ??= select('bars') as readonly TimestampedOhlcvInput[]) },
      };
    },
  };
}
/** Replay appended choice without accepting caller-supplied source-row bookkeeping. */
export function appendChoice(
  pages: readonly DataPage<PriceBarRecord>[],
  selection: ResearchBarSelection,
  choice: ResearchBarChoice,
): ResearchBarSelection {
  // Construct the decision record through the same rule checker; a supplied sourceRows assertion
  // is validated only by the public restore path, not filled over a lying restored record.
  return researchSelection(
    pages,
    { version: 1, decisions: [...selection.decisions, choice], sourceRows: [] },
    false,
  ).selection;
}
