'use client';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { parseOhlcv, parseSeries } from '@/src/data/csv';
import { formatControl } from '@/src/format';
import type {
  DataControl as DataControlSpec,
  DataValue,
  NumberControl as NumberControlSpec,
  SelectControl as SelectControlSpec,
  TableControl as TableControlSpec,
  TableRow,
} from '@/src/types';

const field =
  'w-full rounded-lg border border-panel-border bg-panel-raised px-2.5 py-1.5 text-sm text-panel-foreground tabular-nums outline-none transition-colors placeholder:text-panel-muted focus:border-[#67d9a3] focus:ring-2 focus:ring-[#67d9a3]/30 disabled:opacity-60';

function Label({
  htmlFor,
  label,
  value,
  hint,
}: {
  htmlFor?: string;
  label: string;
  value?: string;
  hint?: string;
}) {
  return (
    <div className="mb-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium text-white">
          {label}
        </label>
        {value ? <span className="font-mono text-xs text-[#a8eac6]">{value}</span> : null}
      </div>
      {hint ? <p className="mt-0.5 text-[0.6875rem] leading-4 text-panel-muted">{hint}</p> : null}
    </div>
  );
}

/** Slider position ↔ value; logarithmic when a positive range spans several orders of magnitude. */
function sliderMapping(control: NumberControlSpec) {
  const logarithmic = control.min > 0 && control.max / control.min >= 1000;
  if (!logarithmic)
    return {
      toSlider: (value: number) => value,
      fromSlider: (value: number) => value,
      min: control.min,
      max: control.max,
      step: control.step,
    };
  const low = Math.log(control.min);
  const high = Math.log(control.max);
  return {
    toSlider: (value: number) => ((Math.log(value) - low) / (high - low)) * 1000,
    fromSlider: (position: number) => {
      const raw = Math.exp(low + (position / 1000) * (high - low));
      const snapped = Math.round(raw / control.step) * control.step;
      return Math.min(control.max, Math.max(control.min, Number(snapped.toPrecision(12))));
    },
    min: 0,
    max: 1000,
    step: 1,
  };
}

export function NumberControl({
  control,
  value,
  onChange,
}: {
  control: NumberControlSpec;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
    setError(null);
  }, [value]);
  const mapping = sliderMapping(control);
  const commit = (raw: string) => {
    setText(raw);
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setError('Enter a number.');
      return;
    }
    if (parsed < control.min || parsed > control.max) {
      setError(`Use ${control.min} to ${control.max}.`);
      return;
    }
    setError(null);
    onChange(parsed);
  };
  return (
    <div>
      <Label
        htmlFor={id}
        label={control.label}
        value={formatControl(value, control.display)}
        hint={control.hint ?? control.unit}
      />
      <div className="flex items-center gap-2.5">
        {control.slider !== false ? (
          <input
            type="range"
            aria-label={`${control.label} slider`}
            min={mapping.min}
            max={mapping.max}
            step={mapping.step}
            value={mapping.toSlider(value)}
            onChange={(event) => {
              const next = mapping.fromSlider(Number(event.target.value));
              setText(String(next));
              setError(null);
              onChange(next);
            }}
            className="tf-range min-w-0 flex-1"
          />
        ) : null}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={control.min}
          max={control.max}
          step="any"
          value={text}
          onChange={(event) => commit(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`${field.replace('w-full ', '')} ${control.slider === false ? 'w-full' : 'w-24 shrink-0'}`}
        />
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-[0.6875rem] text-[#ffb4b4]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SelectControl({
  control,
  value,
  onChange,
}: {
  control: SelectControlSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  if (control.options.length <= 3)
    return (
      <div>
        <Label label={control.label} hint={control.hint} />
        <div
          role="radiogroup"
          aria-label={control.label}
          className="grid gap-1 rounded-lg bg-panel-raised p-1"
          style={{ gridTemplateColumns: `repeat(${control.options.length}, minmax(0, 1fr))` }}
        >
          {control.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.value === value}
              onClick={() => onChange(option.value)}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                option.value === value
                  ? 'bg-[#078754] text-white shadow-sm'
                  : 'text-panel-muted hover:text-white'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div>
      <Label htmlFor={id} label={control.label} hint={control.hint} />
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={field}
      >
        {control.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CellInput({
  value,
  column,
  label,
  onChange,
}: {
  value: number;
  column: TableControlSpec['columns'][number];
  label: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(
    () => setText((current) => (Number(current) === value ? current : String(value))),
    [value],
  );
  return (
    <input
      type="number"
      inputMode="decimal"
      step="any"
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value);
        const ok =
          event.target.value.trim() !== '' &&
          Number.isFinite(parsed) &&
          (column.min === undefined || parsed >= column.min) &&
          (column.max === undefined || parsed <= column.max);
        setInvalid(!ok);
        if (ok) onChange(parsed);
      }}
      className={`${field} px-2 ${invalid ? 'border-[#ff8a8a]' : ''}`}
    />
  );
}

export function TableControl({
  control,
  value,
  onChange,
}: {
  control: TableControlSpec;
  value: TableRow[];
  onChange: (value: TableRow[]) => void;
}) {
  const presetId = useId();
  const current =
    control.presets?.find((preset) => JSON.stringify(preset.rows) === JSON.stringify(value))?.id ??
    '';
  const template = control.columns
    .map((column) => (column.type === 'select' ? 'minmax(4.5rem,1.1fr)' : 'minmax(0,1fr)'))
    .join(' ');
  return (
    <div>
      <Label label={control.label} hint={control.hint} />
      {control.presets ? (
        <div className="mb-2">
          <label htmlFor={presetId} className="sr-only">
            Start from a preset
          </label>
          <select
            id={presetId}
            value={current}
            onChange={(event) => {
              const preset = control.presets!.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (preset) onChange(JSON.parse(JSON.stringify(preset.rows)) as TableRow[]);
            }}
            className={field}
          >
            <option value="" disabled>
              Custom {control.label.toLowerCase()}
            </option>
            {control.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div role="table" aria-label={control.label} className="space-y-1.5">
        <div
          role="row"
          className="grid gap-1.5 pr-7 text-[0.625rem] font-semibold uppercase tracking-wide text-panel-muted"
          style={{ gridTemplateColumns: template }}
        >
          {control.columns.map((column) => (
            <span role="columnheader" key={column.name} title={column.unit}>
              {column.label}
            </span>
          ))}
        </div>
        {value.map((row, rowIndex) => (
          <div role="row" key={rowIndex} className="flex items-center gap-1.5">
            <div className="grid min-w-0 flex-1 gap-1.5" style={{ gridTemplateColumns: template }}>
              {control.columns.map((column) =>
                column.type === 'select' ? (
                  <select
                    key={column.name}
                    aria-label={`Row ${rowIndex + 1} ${column.label}`}
                    value={String(row[column.name])}
                    onChange={(event) =>
                      onChange(
                        value.map((candidate, index) =>
                          index === rowIndex
                            ? { ...candidate, [column.name]: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                    className={`${field} px-1.5`}
                  >
                    {column.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <CellInput
                    key={column.name}
                    value={row[column.name] as number}
                    column={column}
                    label={`Row ${rowIndex + 1} ${column.label}${column.unit ? ` (${column.unit})` : ''}`}
                    onChange={(cell) =>
                      onChange(
                        value.map((candidate, index) =>
                          index === rowIndex ? { ...candidate, [column.name]: cell } : candidate,
                        ),
                      )
                    }
                  />
                ),
              )}
            </div>
            <button
              type="button"
              onClick={() => onChange(value.filter((_row, index) => index !== rowIndex))}
              disabled={value.length <= control.minRows}
              aria-label={`Remove row ${rowIndex + 1}`}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-panel-muted hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...value, { ...control.newRow }])}
        disabled={value.length >= control.maxRows}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[#a8eac6] hover:bg-white/10 disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden /> Add row
      </button>
    </div>
  );
}

function summary(value: DataValue) {
  const count =
    value.format === 'ohlcv'
      ? `${value.bars.length.toLocaleString('en-US')} bars`
      : `${value.values.length.toLocaleString('en-US')} ${value.meaning}`;
  const first = value.format === 'ohlcv' ? value.bars[0]?.date : value.dates?.[0];
  const last = value.format === 'ohlcv' ? value.bars.at(-1)?.date : value.dates?.at(-1);
  return (
    <>
      <span className="whitespace-nowrap">{count}</span>
      {first && last ? (
        <>
          {' · '}
          <span className="whitespace-nowrap">
            {first} → {last}
          </span>
        </>
      ) : null}
    </>
  );
}

function toCsv(value: DataValue): string {
  if (value.format === 'ohlcv')
    return [
      'date,open,high,low,close,volume',
      ...value.bars.map(
        (bar) => `${bar.date},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume ?? ''}`,
      ),
    ].join('\n');
  return [
    value.dates
      ? `date,${value.meaning === 'returns' ? 'return' : 'close'}`
      : value.meaning === 'returns'
        ? 'return'
        : 'close',
    ...value.values.map((entry, index) =>
      value.dates ? `${value.dates[index]},${entry}` : String(entry),
    ),
  ].join('\n');
}

/** The first and last rows exactly as the calculator will read them. */
function DataPreview({ value }: { value: DataValue }) {
  const header =
    value.format === 'ohlcv'
      ? ['date', 'open', 'high', 'low', 'close', 'volume']
      : [value.dates ? 'date' : '#', value.meaning === 'returns' ? 'return' : 'price'];
  const rows: (string | number)[][] =
    value.format === 'ohlcv'
      ? value.bars.map((bar) => [
          bar.date,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume ?? '',
        ])
      : value.values.map((entry, index) => [value.dates?.[index] ?? index + 1, entry]);
  const shown = rows.length > 6 ? [...rows.slice(0, 3), null, ...rows.slice(-2)] : rows;
  return (
    <details className="mt-1.5 text-[0.6875rem] text-panel-muted">
      <summary className="cursor-pointer select-none hover:text-white">Preview rows</summary>
      <div className="tf-scrollbar mt-1 overflow-x-auto">
        <table className="w-full font-mono tabular-nums">
          <thead>
            <tr>
              {header.map((name) => (
                <th
                  key={name}
                  scope="col"
                  className="px-1.5 py-0.5 text-left font-medium text-white"
                >
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) =>
              row === null ? (
                <tr key="gap">
                  <td colSpan={header.length} className="px-1.5 py-0.5">
                    … {(rows.length - 5).toLocaleString('en-US')} more rows …
                  </td>
                </tr>
              ) : (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className="px-1.5 py-0.5">
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function DataControl({
  control,
  value,
  onChange,
}: {
  control: DataControlSpec;
  value: DataValue;
  onChange: (value: DataValue) => void;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [meaning, setMeaning] = useState<'prices' | 'returns'>(control.meanings?.[0] ?? 'prices');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const currentSample = control.samples.find(
    (sample) => JSON.stringify(sample.value) === JSON.stringify(value),
  );

  const apply = (source: string, label: string) => {
    try {
      const options = { minRows: control.minRows, maxRows: control.maxRows, label };
      const parsed =
        control.format === 'ohlcv'
          ? parseOhlcv(source, options)
          : parseSeries(source, { ...options, meaning });
      setError(null);
      setNotes(parsed.notes);
      setEditing(false);
      onChange(parsed.value);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That data could not be read.');
    }
  };

  const download = () => {
    const blob = new Blob([toCsv(value)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${currentSample?.id ?? 'data'}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <Label htmlFor={`${id}-sample`} label={control.label} hint={control.hint} />
      <div className="rounded-lg border border-panel-border bg-panel-raised p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-white" title={value.label}>
              {value.label}
            </p>
            <p className="mt-0.5 font-mono text-[0.6875rem] text-panel-muted">{summary(value)}</p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide ${
              value.origin === 'reader'
                ? 'bg-[#1f9a6f]/25 text-[#7be0b8]'
                : 'bg-white/10 text-panel-muted'
            }`}
          >
            {value.origin === 'reader' ? 'Your data' : 'Synthetic'}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <label htmlFor={`${id}-sample`} className="sr-only">
            Sample dataset
          </label>
          <select
            id={`${id}-sample`}
            value={currentSample?.id ?? ''}
            onChange={(event) => {
              const sample = control.samples.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (sample) {
                setNotes([]);
                onChange(JSON.parse(JSON.stringify(sample.value)) as DataValue);
              }
            }}
            className={`${field} min-w-0 flex-1 py-1 text-xs`}
          >
            <option value="" disabled>
              Your data
            </option>
            {control.samples.map((sample) => (
              <option key={sample.id} value={sample.id}>
                {sample.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
            className="inline-flex items-center gap-1 rounded-lg bg-[#078754] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#066b43]"
          >
            <Upload className="size-3.5" aria-hidden /> Use your data
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-panel-muted hover:bg-white/10 hover:text-white"
            title="Download the current dataset as CSV (shows the expected format)"
          >
            <Download className="size-3.5" aria-hidden /> CSV
          </button>
        </div>
      </div>
      <DataPreview value={value} />
      {editing ? (
        <div className="mt-2 space-y-2 rounded-lg border border-panel-border bg-panel-raised p-2.5">
          {control.format === 'series' && (control.meanings?.length ?? 2) > 1 ? (
            <div role="radiogroup" aria-label="The values are" className="flex gap-1 text-xs">
              {(control.meanings ?? ['prices', 'returns']).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={meaning === option}
                  onClick={() => setMeaning(option)}
                  className={`rounded-md px-2 py-1 font-medium ${meaning === option ? 'bg-[#078754] text-white' : 'text-panel-muted hover:text-white'}`}
                >
                  {option === 'prices' ? 'Closing prices' : 'Returns (decimals)'}
                </button>
              ))}
            </div>
          ) : null}
          <label htmlFor={`${id}-paste`} className="block text-[0.6875rem] text-panel-muted">
            {control.format === 'ohlcv'
              ? 'Paste CSV or TSV with a header row: date, open, high, low, close, volume (optional). Most exports work as-is.'
              : 'Paste one value per line, or a date and a value per line. A header row is optional.'}
          </label>
          <textarea
            id={`${id}-paste`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={
              control.format === 'ohlcv'
                ? 'date,open,high,low,close,volume\n2025-01-02,100.5,101.2,99.8,100.9,1250000'
                : 'date,return\n2025-01-03,-0.0042\n2025-01-06,0.0118'
            }
            className={`${field} font-mono text-[0.6875rem] leading-5`}
          />
          {error ? (
            <p role="alert" className="text-[0.6875rem] leading-4 text-[#ffb4b4]">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => apply(text, 'Your pasted data')}
              disabled={!text.trim()}
              className="rounded-lg bg-[#078754] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#066b43] disabled:opacity-40"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => file.current?.click()}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-panel-muted hover:bg-white/10 hover:text-white"
            >
              <Upload className="size-3.5" aria-hidden /> Upload .csv
            </button>
            <input
              ref={file}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only"
              tabIndex={-1}
              onChange={async (event) => {
                const chosen = event.target.files?.[0];
                event.target.value = '';
                if (!chosen) return;
                if (chosen.size > 2_000_000) {
                  setError('That file is larger than 2 MB. Trim it to the rows you need.');
                  return;
                }
                const contents = await chosen.text();
                setText(contents);
                apply(contents, `Your file ${chosen.name}`);
              }}
            />
            <span className="text-[0.625rem] text-panel-muted">
              Stays in your browser · up to {control.maxRows.toLocaleString('en-US')} rows
            </span>
          </div>
        </div>
      ) : null}
      {notes.length ? (
        <ul className="mt-1.5 space-y-0.5 text-[0.6875rem] leading-4 text-[#a8eac6]" role="status">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
