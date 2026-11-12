'use client';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatValue } from '@/src/format';
import type { Calculation, Metric } from '@/src/types';
import { Chart } from '../charts/chart';

export function MetricTiles({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="relative overflow-hidden rounded-[var(--radius-card)] border border-fd-border bg-fd-background px-4 py-3.5"
        >
          {metric.tone === 'profit' || metric.tone === 'loss' ? (
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-[3px]"
              style={{
                background: metric.tone === 'profit' ? 'var(--color-profit)' : 'var(--color-loss)',
              }}
            />
          ) : null}
          <dt className="text-xs text-fd-muted-foreground">{metric.label}</dt>
          <dd
            className="mt-1 text-xl font-semibold tracking-tight text-fd-foreground"
            title={typeof metric.value === 'number' ? String(metric.value) : undefined}
          >
            {formatValue(metric.value, metric.format)}
          </dd>
          {metric.unit ? (
            <dd className="mt-0.5 text-[0.6875rem] leading-4 text-fd-muted-foreground">
              {metric.unit}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

/** Flatten an assumptions/diagnostics object into readable `path → value` rows. */
export function flatten(value: unknown, prefix = '', depth = 0): { key: string; value: string }[] {
  if (value === null || value === undefined)
    return prefix ? [{ key: prefix, value: String(value) }] : [];
  if (typeof value !== 'object')
    return [
      {
        key: prefix || 'value',
        value: typeof value === 'number' ? formatValue(value) : String(value),
      },
    ];
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object'))
      return [{ key: prefix, value: value.length ? value.join(', ') : 'none' }];
    if (depth >= 3) return [{ key: prefix, value: `${value.length} entries` }];
    return value.flatMap((item, index) => flatten(item, `${prefix}[${index}]`, depth + 1));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return prefix ? [{ key: prefix, value: 'none' }] : [];
  if (depth >= 4) return [{ key: prefix, value: JSON.stringify(value) }];
  return entries.flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key, depth + 1),
  );
}

/** Every warning in a diagnostics object, whether a string or a `{ code, message }` record. */
export function warningsOf(diagnostics: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (Array.isArray(value)) {
      if (/warnings?$/i.test(key))
        for (const item of value)
          found.push(
            typeof item === 'string'
              ? item
              : item && typeof item === 'object' && 'message' in item
                ? String((item as { message: unknown }).message)
                : JSON.stringify(item),
          );
      else value.forEach((item) => visit(item));
    } else if (value && typeof value === 'object')
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>))
        visit(child, childKey);
  };
  visit(diagnostics);
  return [...new Set(found)];
}

function KeyValues({ value }: { value: unknown }) {
  const rows = flatten(value).filter((row) => !/warnings?$/i.test(row.key));
  if (!rows.length) return <p className="text-xs text-fd-muted-foreground">None reported.</p>;
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-x-4 text-xs">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="break-all border-t border-fd-border py-1.5 font-mono text-[0.6875rem] text-fd-muted-foreground">
            {row.key}
          </dt>
          <dd className="break-words border-t border-fd-border py-1.5 font-mono text-[0.6875rem] text-fd-foreground">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CalculationResults({
  calculation,
  stale,
}: {
  calculation: Calculation;
  stale: boolean;
}) {
  const charts = [calculation.chart, ...(calculation.additionalCharts ?? [])];
  const warnings = warningsOf(calculation.diagnostics);
  return (
    <div className={`space-y-6 transition-opacity ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      <MetricTiles metrics={calculation.metrics} />
      <div className="grid gap-6 lg:grid-cols-2">
        {charts.map((chart, index) => (
          <div
            key={`${chart.title}-${index}`}
            className={`min-w-0 rounded-[var(--radius-card)] border border-fd-border bg-fd-background p-4 sm:p-5 ${chart.size === 'half' ? '' : 'lg:col-span-2'}`}
          >
            <Chart chart={chart} />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section
          className="rounded-[var(--radius-card)] border border-fd-border p-4"
          aria-labelledby="assumptions-heading"
        >
          <h3
            id="assumptions-heading"
            className="mb-1 flex items-center gap-2 text-sm font-semibold"
          >
            <CheckCircle2 className="size-4 text-fd-primary" aria-hidden /> Assumptions &
            conventions
          </h3>
          <p className="mb-2 text-xs text-fd-muted-foreground">
            What the calculation assumed, echoed by the library rather than hidden.
          </p>
          <KeyValues value={calculation.assumptions} />
        </section>
        <section
          className="rounded-[var(--radius-card)] border border-fd-border p-4"
          aria-labelledby="diagnostics-heading"
        >
          <h3
            id="diagnostics-heading"
            className="mb-1 flex items-center gap-2 text-sm font-semibold"
          >
            <AlertTriangle
              className={`size-4 ${warnings.length ? 'text-amber-500' : 'text-fd-muted-foreground'}`}
              aria-hidden
            />{' '}
            Diagnostics & warnings
          </h3>
          {warnings.length ? (
            <ul className="mb-3 space-y-1.5">
              {warnings.map((warning) => (
                <li
                  key={warning}
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-fd-foreground"
                >
                  <span className="font-semibold">Warning: </span>
                  {warning}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-xs text-fd-muted-foreground">
              No warnings. Engine, method and convergence details:
            </p>
          )}
          <KeyValues value={calculation.diagnostics} />
        </section>
      </div>
    </div>
  );
}
