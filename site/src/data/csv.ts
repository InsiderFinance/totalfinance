/**
 * Parse a reader's pasted or uploaded table (CSV, TSV or semicolon-separated) into the typed
 * datasets the playgrounds accept. Pure and deterministic: no network, no clock, no guessing of
 * financial values. Every refusal names the row and column so the reader can fix the source.
 */
import type { DataValue, OhlcvBar } from '../types';

export interface ParsedTable {
  delimiter: string;
  header: string[] | null;
  rows: string[][];
}

export interface ParseNotes {
  notes: string[];
}

const MAX_INPUT_BYTES = 2_000_000;

/** RFC 4180-style tokenizer with quoted fields and doubled quotes. */
export function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (character === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field.trim());
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('A quoted field is not closed. Check for a stray double quote.');
  row.push(field.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

export function detectDelimiter(text: string): string {
  const sample = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const candidate of ['\t', ';', ',', '|']) {
    const counts = sample.map((line) => line.split(candidate).length - 1);
    const consistent = counts.length > 0 && counts.every((count) => count === counts[0]);
    const score = (consistent ? 1000 : 0) + (counts[0] ?? 0);
    if ((counts[0] ?? 0) > 0 && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** Number parsing that accepts thousands separators, currency symbols and percent signs. */
export function parseNumberCell(cell: string): number | null {
  let text = cell.trim();
  if (!text) return null;
  let scale = 1;
  if (text.endsWith('%')) {
    scale = 0.01;
    text = text.slice(0, -1);
  }
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/^\(|\)$/g, '').replace(/[$€£¥\s]/g, '');
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text) * scale * (negative ? -1 : 1);
  return Number.isFinite(value) ? value : null;
}

const pad = (value: number) => String(value).padStart(2, '0');

function isoFromParts(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Calendar date from a cell: ISO dates/datetimes (date part kept as written), US M/D/YYYY, compact
 * YYYYMMDD, or Unix epoch seconds/milliseconds (interpreted in UTC).
 */
export function parseDateCell(cell: string): string | null {
  const text = cell.trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (match) return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return isoFromParts(Number(match[3]), Number(match[1]), Number(match[2]));
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return isoFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
  if (/^\d{9,13}$/.test(text)) {
    const value = Number(text);
    const milliseconds = text.length >= 12 ? value : value * 1000;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  return null;
}

export function parseTable(text: string): ParsedTable {
  if (text.length > MAX_INPUT_BYTES)
    throw new Error(
      `That file is larger than ${MAX_INPUT_BYTES / 1_000_000} MB. Trim it to the rows you need.`,
    );
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim())
    throw new Error('Paste or upload a table with a header row and at least one data row.');
  const delimiter = detectDelimiter(clean);
  const tokens = tokenize(clean, delimiter);
  const first = tokens[0] ?? [];
  // A header row has at least one cell that is neither a number nor a date.
  const header = first.some(
    (cell) => parseNumberCell(cell) === null && parseDateCell(cell) === null,
  )
    ? first.map((cell) => cell.trim())
    : null;
  const rows = header ? tokens.slice(1) : tokens;
  return { delimiter, header, rows };
}

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function findColumn(header: string[] | null, names: readonly string[]): number {
  if (!header) return -1;
  const normalized = header.map(normalizeName);
  for (const name of names) {
    const index = normalized.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

const DATE_NAMES = ['date', 'time', 'timestamp', 'datetime', 'day', 'tradedate', 'period'];
const OPEN_NAMES = ['open', 'o', 'openprice'];
const HIGH_NAMES = ['high', 'h', 'highprice'];
const LOW_NAMES = ['low', 'l', 'lowprice'];
const CLOSE_NAMES = ['close', 'c', 'closeprice', 'last', 'price'];
const ADJUSTED_NAMES = ['adjclose', 'adjustedclose', 'closeadj'];
const VOLUME_NAMES = ['volume', 'v', 'vol'];

function describeColumn(header: string[] | null, index: number): string {
  return header?.[index] ? `"${header[index]}"` : `column ${index + 1}`;
}

/** Chronological order: descending exports (newest first) are reversed, with a note. */
function chronological<T extends { date: string }>(rows: T[], notes: string[]): T[] {
  if (rows.length > 1 && rows[0]!.date > rows.at(-1)!.date) {
    notes.push('Rows were newest-first; they are shown oldest-first.');
    rows = [...rows].reverse();
  }
  for (let index = 1; index < rows.length; index += 1)
    if (rows[index]!.date <= rows[index - 1]!.date)
      throw new Error(
        `Dates must be unique and in order: ${rows[index]!.date} appears after ${rows[index - 1]!.date} (data row ${index + 1}).`,
      );
  return rows;
}

export interface ParseOptions {
  maxRows: number;
  minRows: number;
  label: string;
}

export function parseOhlcv(
  text: string,
  options: ParseOptions,
): { value: DataValue; notes: string[] } {
  const table = parseTable(text);
  const notes: string[] = [];
  const width = Math.max(...table.rows.map((row) => row.length));
  let date = findColumn(table.header, DATE_NAMES);
  let open = findColumn(table.header, OPEN_NAMES);
  let high = findColumn(table.header, HIGH_NAMES);
  let low = findColumn(table.header, LOW_NAMES);
  let close = findColumn(table.header, CLOSE_NAMES);
  const adjusted = findColumn(table.header, ADJUSTED_NAMES);
  let volume = findColumn(table.header, VOLUME_NAMES);
  if (!table.header) {
    // Headerless: date, open, high, low, close[, volume] is the common export order.
    if (width < 5)
      throw new Error(
        'Without a header row, use columns: date, open, high, low, close, volume (optional).',
      );
    [date, open, high, low, close, volume] = [0, 1, 2, 3, 4, width > 5 ? 5 : -1];
    notes.push('No header row: read columns as date, open, high, low, close, volume.');
  }
  if (close < 0 && adjusted >= 0) close = adjusted;
  const missing = [
    ['date', date],
    ['open', open],
    ['high', high],
    ['low', low],
    ['close', close],
  ]
    .filter(([, index]) => index === -1)
    .map(([name]) => name);
  if (missing.length)
    throw new Error(
      `Missing ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}. Found: ${table.header?.join(', ')}. Rename the header or use date, open, high, low, close, volume.`,
    );
  if (table.header)
    notes.push(
      `Columns used: ${[
        ['date', date],
        ['open', open],
        ['high', high],
        ['low', low],
        ['close', close],
        ['volume', volume],
      ]
        .filter(([, index]) => (index as number) >= 0)
        .map(([field, index]) => `${field} ← ${describeColumn(table.header, index as number)}`)
        .join(', ')}.`,
    );
  if (adjusted >= 0 && close !== adjusted)
    notes.push('Used the unadjusted close; an adjusted-close column was also present.');
  let bars: OhlcvBar[] = table.rows.map((row, rowIndex) => {
    const line = rowIndex + (table.header ? 2 : 1);
    const parsedDate = parseDateCell(row[date] ?? '');
    if (!parsedDate)
      throw new Error(
        `Line ${line}: ${describeColumn(table.header, date)} "${row[date] ?? ''}" is not a date (use YYYY-MM-DD).`,
      );
    const read = (index: number, field: string) => {
      const value = parseNumberCell(row[index] ?? '');
      if (value === null || value <= 0)
        throw new Error(`Line ${line}: ${field} "${row[index] ?? ''}" must be a positive number.`);
      return value;
    };
    const bar: OhlcvBar = {
      date: parsedDate,
      open: read(open, 'open'),
      high: read(high, 'high'),
      low: read(low, 'low'),
      close: read(close, 'close'),
    };
    if (
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close)
    )
      throw new Error(
        `Line ${line}: high must be the highest and low the lowest of the bar's prices.`,
      );
    if (volume >= 0 && (row[volume] ?? '') !== '') {
      const value = parseNumberCell(row[volume]!);
      if (value === null || value < 0)
        throw new Error(`Line ${line}: volume "${row[volume]}" must be a non-negative number.`);
      bar.volume = value;
    }
    return bar;
  });
  bars = chronological(bars, notes);
  if (bars.length < options.minRows)
    throw new Error(`At least ${options.minRows} bars are needed; found ${bars.length}.`);
  if (bars.length > options.maxRows) {
    notes.push(`Kept the most recent ${options.maxRows} of ${bars.length} bars.`);
    bars = bars.slice(-options.maxRows);
  }
  return { value: { format: 'ohlcv', label: options.label, origin: 'reader', bars }, notes };
}

export function parseSeries(
  text: string,
  options: ParseOptions & { meaning: 'prices' | 'returns' },
): { value: DataValue; notes: string[] } {
  const table = parseTable(text);
  const notes: string[] = [];
  const width = Math.max(...table.rows.map((row) => row.length));
  let date = findColumn(table.header, DATE_NAMES);
  const preferred =
    options.meaning === 'returns'
      ? ['return', 'returns', 'ret', 'dailyreturn', 'pnl', 'value']
      : [...CLOSE_NAMES, ...ADJUSTED_NAMES, 'value', 'nav', 'equity'];
  let valueColumn = findColumn(table.header, preferred);
  if (valueColumn < 0) {
    // Fall back to the only (or last) numeric column.
    const numeric = Array.from({ length: width }, (_, index) => index).filter(
      (index) =>
        index !== date && table.rows.every((row) => parseNumberCell(row[index] ?? '') !== null),
    );
    if (!numeric.length)
      throw new Error(
        'No numeric column was found. Paste one value per line, or a date and value per line.',
      );
    valueColumn = numeric.at(-1)!;
    if (numeric.length > 1)
      notes.push(
        `Used ${describeColumn(table.header, valueColumn)}; other numeric columns were ignored.`,
      );
  }
  if (
    date < 0 &&
    !table.header &&
    width >= 2 &&
    table.rows.every((row) => parseDateCell(row[0] ?? '') !== null)
  )
    date = 0;
  if (table.header)
    notes.unshift(
      `Columns used: ${date >= 0 ? `date ← ${describeColumn(table.header, date)}, ` : ''}${
        options.meaning === 'returns' ? 'return' : 'price'
      } ← ${describeColumn(table.header, valueColumn)}.`,
    );
  let rows = table.rows.map((row, rowIndex) => {
    const line = rowIndex + (table.header ? 2 : 1);
    const value = parseNumberCell(row[valueColumn] ?? '');
    if (value === null)
      throw new Error(`Line ${line}: "${row[valueColumn] ?? ''}" is not a number.`);
    if (options.meaning === 'prices' && value <= 0)
      throw new Error(`Line ${line}: price ${value} must be positive.`);
    if (options.meaning === 'returns' && value <= -1)
      throw new Error(
        `Line ${line}: return ${value} is −100% or worse. Returns are decimals: −0.05 means −5%.`,
      );
    const parsedDate = date >= 0 ? parseDateCell(row[date] ?? '') : null;
    if (date >= 0 && !parsedDate)
      throw new Error(`Line ${line}: "${row[date] ?? ''}" is not a date (use YYYY-MM-DD).`);
    return { date: parsedDate ?? '', value };
  });
  if (date >= 0) rows = chronological(rows, notes);
  if (rows.length < options.minRows)
    throw new Error(`At least ${options.minRows} values are needed; found ${rows.length}.`);
  if (rows.length > options.maxRows) {
    notes.push(`Kept the most recent ${options.maxRows} of ${rows.length} values.`);
    rows = rows.slice(-options.maxRows);
  }
  if (options.meaning === 'returns' && rows.some((row) => Math.abs(row.value) > 1))
    notes.push(
      'Some returns exceed ±100%. Returns must be decimals (0.02 = 2%); check the column is not in percent.',
    );
  return {
    value: {
      format: 'series',
      label: options.label,
      origin: 'reader',
      meaning: options.meaning,
      values: rows.map((row) => row.value),
      ...(date >= 0 ? { dates: rows.map((row) => row.date) } : {}),
    },
    notes,
  };
}
