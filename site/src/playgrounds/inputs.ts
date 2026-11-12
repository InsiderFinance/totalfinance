import {
  isNumberControl,
  type Control,
  type DataControl,
  type DataValue,
  type InputValue,
  type OhlcvBar,
  type Playground,
  type PlaygroundInput,
  type TableControl,
  type TableRow,
} from '../types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function defaultInput(playground: Pick<Playground, 'controls'>): PlaygroundInput {
  return Object.fromEntries(
    playground.controls.map((control) => [control.name, structuredCloneValue(control.value)]),
  );
}

function structuredCloneValue<T>(value: T): T {
  return typeof value === 'object' && value !== null
    ? (JSON.parse(JSON.stringify(value)) as T)
    : value;
}

function validateTable(control: TableControl, value: unknown): TableRow[] {
  if (!Array.isArray(value))
    throw new Error(
      `${control.label} must be a list of rows with ${control.columns.map((column) => column.name).join(', ')}.`,
    );
  if (value.length < control.minRows || value.length > control.maxRows)
    throw new Error(
      `${control.label} needs ${control.minRows}–${control.maxRows} rows; received ${value.length}.`,
    );
  const names = new Set(control.columns.map((column) => column.name));
  return value.map((row, index) => {
    const position = `${control.label}, row ${index + 1}`;
    if (!isRecord(row)) throw new Error(`${position} must be an object.`);
    for (const key of Object.keys(row))
      if (!names.has(key))
        throw new Error(`${position} has unknown field ${key}. Use: ${[...names].join(', ')}.`);
    const clean: TableRow = {};
    for (const column of control.columns) {
      const cell = row[column.name];
      if (column.type === 'select') {
        if (typeof cell !== 'string' || !column.options?.some((option) => option.value === cell))
          throw new Error(
            `${position}: ${column.label} must be one of ${column.options?.map((option) => option.value).join(', ')}.`,
          );
        clean[column.name] = cell;
      } else {
        if (typeof cell !== 'number' || !Number.isFinite(cell))
          throw new Error(
            `${position}: ${column.label} must be a finite number${column.unit ? ` (${column.unit})` : ''}.`,
          );
        if (
          (column.min !== undefined && cell < column.min) ||
          (column.max !== undefined && cell > column.max)
        )
          throw new Error(
            `${position}: ${column.label} must be from ${column.min ?? '−∞'} to ${column.max ?? '∞'}.`,
          );
        clean[column.name] = cell;
      }
    }
    return clean;
  });
}

function validateBars(control: DataControl, bars: unknown): OhlcvBar[] {
  if (!Array.isArray(bars)) throw new Error(`${control.label} must contain a bars array.`);
  if (bars.length < control.minRows || bars.length > control.maxRows)
    throw new Error(
      `${control.label} needs ${control.minRows}–${control.maxRows} bars; received ${bars.length}.`,
    );
  let previous = '';
  return bars.map((bar, index) => {
    const position = `${control.label}, bar ${index + 1}`;
    if (!isRecord(bar))
      throw new Error(`${position} must be an object with date, open, high, low and close.`);
    const date = bar['date'];
    if (
      typeof date !== 'string' ||
      !ISO_DATE.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    )
      throw new Error(`${position}: date must be an ISO calendar date (YYYY-MM-DD).`);
    if (date <= previous)
      throw new Error(
        `${position}: dates must be strictly increasing (${date} follows ${previous}).`,
      );
    previous = date;
    const clean: OhlcvBar = { date, open: 0, high: 0, low: 0, close: 0 };
    for (const field of ['open', 'high', 'low', 'close'] as const) {
      const value = bar[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw new Error(`${position}: ${field} must be a positive finite price.`);
      clean[field] = value;
    }
    if (
      clean.high < Math.max(clean.open, clean.close, clean.low) ||
      clean.low > Math.min(clean.open, clean.close)
    )
      throw new Error(
        `${position}: high must be the highest and low the lowest of open, high, low and close.`,
      );
    if (bar['volume'] !== undefined) {
      const volume = bar['volume'];
      if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0)
        throw new Error(`${position}: volume must be a non-negative finite number when present.`);
      clean.volume = volume;
    }
    for (const key of Object.keys(bar))
      if (!['date', 'open', 'high', 'low', 'close', 'volume'].includes(key))
        throw new Error(`${position} has unknown field ${key}.`);
    return clean;
  });
}

function validateData(control: DataControl, value: unknown): DataValue {
  if (!isRecord(value) || value['format'] !== control.format)
    throw new Error(
      `${control.label} must be ${control.format === 'ohlcv' ? 'OHLC price bars' : 'a numeric series'}.`,
    );
  const label = value['label'];
  if (typeof label !== 'string' || !label.trim() || label.length > 200)
    throw new Error(`${control.label} needs a short description of its source (1–200 characters).`);
  const origin = value['origin'];
  if (origin !== 'sample' && origin !== 'reader')
    throw new Error(`${control.label} origin must be "sample" or "reader".`);
  if (control.format === 'ohlcv') {
    for (const key of Object.keys(value))
      if (!['format', 'label', 'origin', 'bars'].includes(key))
        throw new Error(`${control.label} has unknown field ${key}.`);
    return {
      format: 'ohlcv',
      label: label.trim(),
      origin,
      bars: validateBars(control, value['bars']),
    };
  }
  for (const key of Object.keys(value))
    if (!['format', 'label', 'origin', 'meaning', 'values', 'dates'].includes(key))
      throw new Error(`${control.label} has unknown field ${key}.`);
  const meaning = value['meaning'];
  const allowed = control.meanings ?? ['prices', 'returns'];
  if (meaning !== 'prices' && meaning !== 'returns')
    throw new Error(`${control.label} meaning must be "prices" or "returns".`);
  if (!allowed.includes(meaning))
    throw new Error(`${control.label} accepts ${allowed.join(' or ')}.`);
  const values = value['values'];
  if (!Array.isArray(values)) throw new Error(`${control.label} must contain a values array.`);
  if (values.length < control.minRows || values.length > control.maxRows)
    throw new Error(
      `${control.label} needs ${control.minRows}–${control.maxRows} values; received ${values.length}.`,
    );
  values.forEach((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry))
      throw new Error(`${control.label}, value ${index + 1} must be a finite number.`);
    if (meaning === 'prices' && entry <= 0)
      throw new Error(`${control.label}, price ${index + 1} must be positive.`);
    if (meaning === 'returns' && entry <= -1)
      throw new Error(
        `${control.label}, return ${index + 1} must be above −1 (a decimal; −0.05 means −5%).`,
      );
  });
  let dates: string[] | undefined;
  if (value['dates'] !== undefined) {
    const candidate = value['dates'];
    if (!Array.isArray(candidate) || candidate.length !== values.length)
      throw new Error(`${control.label} dates must match its values one-to-one.`);
    let previous = '';
    dates = candidate.map((date, index) => {
      if (typeof date !== 'string' || !ISO_DATE.test(date))
        throw new Error(`${control.label}, date ${index + 1} must be YYYY-MM-DD.`);
      if (date <= previous)
        throw new Error(`${control.label}, date ${index + 1}: dates must be strictly increasing.`);
      previous = date;
      return date;
    });
  }
  return {
    format: 'series',
    label: label.trim(),
    origin,
    meaning,
    values: values as number[],
    ...(dates ? { dates } : {}),
  };
}

function validateControl(control: Control, value: unknown): InputValue {
  if (isNumberControl(control)) {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < control.min ||
      value > control.max
    )
      throw new Error(
        `${control.label} must be a finite number from ${control.min} to ${control.max} (${control.unit}).`,
      );
    return value;
  }
  switch (control.kind) {
    case 'select':
      if (typeof value !== 'string' || !control.options.some((option) => option.value === value))
        throw new Error(
          `${control.label} must be one of: ${control.options.map((option) => option.value).join(', ')}.`,
        );
      return value;
    case 'table':
      return validateTable(control, value);
    case 'data':
      return validateData(control, value);
  }
}

/** Boundary validation shared by the form, the worker, URL state and browser agent tools. */
export function validateInputs(
  playground: Pick<Playground, 'controls'>,
  input: unknown,
): PlaygroundInput {
  if (!isRecord(input)) throw new Error('Supply a named object of playground inputs.');
  const names = new Set(playground.controls.map((control) => control.name));
  for (const name of Object.keys(input))
    if (!names.has(name)) throw new Error(`Unknown input ${name}. Use: ${[...names].join(', ')}.`);
  const result: PlaygroundInput = {};
  for (const control of playground.controls) {
    if (!(control.name in input))
      throw new Error(`Missing input ${control.name} (${control.label}).`);
    result[control.name] = validateControl(control, input[control.name]);
  }
  return result;
}

// Typed accessors for `run` implementations. Inputs are validated before `run` is called; these
// guards keep a direct (test or tool) call honest instead of silently coercing.
export function numberInput(input: PlaygroundInput, name: string): number {
  const value = input[name];
  if (typeof value !== 'number') throw new Error(`Input ${name} must be a number.`);
  return value;
}

export function stringInput(input: PlaygroundInput, name: string): string {
  const value = input[name];
  if (typeof value !== 'string') throw new Error(`Input ${name} must be a string.`);
  return value;
}

export function tableInput(input: PlaygroundInput, name: string): TableRow[] {
  const value = input[name];
  if (!Array.isArray(value)) throw new Error(`Input ${name} must be a table.`);
  return value;
}

export function dataInput(input: PlaygroundInput, name: string): DataValue {
  const value = input[name];
  if (!isRecord(value) || typeof value['format'] !== 'string')
    throw new Error(`Input ${name} must be a dataset.`);
  return value as DataValue;
}

/** JSON Schema for one control, used by the page-scoped browser agent tool. */
export function controlSchema(control: Control): Record<string, unknown> {
  if (isNumberControl(control))
    return {
      type: 'number',
      description: `${control.label}; ${control.unit}`,
      minimum: control.min,
      maximum: control.max,
    };
  switch (control.kind) {
    case 'select':
      return {
        type: 'string',
        description: control.label,
        enum: control.options.map((option) => option.value),
      };
    case 'table':
      return {
        type: 'array',
        description: control.label,
        minItems: control.minRows,
        maxItems: control.maxRows,
        items: {
          type: 'object',
          additionalProperties: false,
          required: control.columns.map((column) => column.name),
          properties: Object.fromEntries(
            control.columns.map((column) => [
              column.name,
              column.type === 'select'
                ? {
                    type: 'string',
                    enum: column.options?.map((option) => option.value) ?? [],
                    description: column.label,
                  }
                : {
                    type: 'number',
                    description: `${column.label}${column.unit ? `; ${column.unit}` : ''}`,
                    ...(column.min !== undefined ? { minimum: column.min } : {}),
                    ...(column.max !== undefined ? { maximum: column.max } : {}),
                  },
            ]),
          ),
        },
      };
    case 'data':
      return control.format === 'ohlcv'
        ? {
            type: 'object',
            description: `${control.label}: OHLC(V) bars supplied by the caller. Never invent market data.`,
            additionalProperties: false,
            required: ['format', 'label', 'origin', 'bars'],
            properties: {
              format: { const: 'ohlcv' },
              label: { type: 'string', description: 'Where the data came from.' },
              origin: { enum: ['sample', 'reader'] },
              bars: {
                type: 'array',
                minItems: control.minRows,
                maxItems: control.maxRows,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['date', 'open', 'high', 'low', 'close'],
                  properties: {
                    date: { type: 'string', pattern: ISO_DATE.source },
                    open: { type: 'number', exclusiveMinimum: 0 },
                    high: { type: 'number', exclusiveMinimum: 0 },
                    low: { type: 'number', exclusiveMinimum: 0 },
                    close: { type: 'number', exclusiveMinimum: 0 },
                    volume: { type: 'number', minimum: 0 },
                  },
                },
              },
            },
          }
        : {
            type: 'object',
            description: `${control.label}: a numeric series supplied by the caller. Never invent market data.`,
            additionalProperties: false,
            required: ['format', 'label', 'origin', 'meaning', 'values'],
            properties: {
              format: { const: 'series' },
              label: { type: 'string' },
              origin: { enum: ['sample', 'reader'] },
              meaning: { enum: control.meanings ?? ['prices', 'returns'] },
              values: {
                type: 'array',
                minItems: control.minRows,
                maxItems: control.maxRows,
                items: { type: 'number' },
              },
              dates: { type: 'array', items: { type: 'string', pattern: ISO_DATE.source } },
            },
          };
  }
}

export function inputSchema(playground: Pick<Playground, 'controls'>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: playground.controls.map((control) => control.name),
    properties: Object.fromEntries(
      playground.controls.map((control) => [control.name, controlSchema(control)]),
    ),
  };
}
