'use client';
import { useState } from 'react';
import { BASE_PATH } from '@/lib/site';
import { CodePanel } from '../code/code-panel';
import type { SchemaField } from '@/src/schema-summary';

/**
 * The top-level fields of an operation schema inline (small), and the complete JSON Schema loaded
 * on demand from `/agents/operations/<id>.json`, so pages stay light even for very large schemas.
 */
export function SchemaView({
  id,
  which,
  summary,
}: {
  id: string;
  which: 'inputSchema' | 'outputSchema';
  summary: SchemaField[];
}) {
  const [schema, setSchema] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const load = () => {
    if (schema) return;
    const base = document.documentElement.dataset['tfBase'] ?? BASE_PATH;
    fetch(`${base}/agents/operations/${id}.json`)
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(String(response.status))),
      )
      .then((data: Record<string, unknown>) => setSchema(JSON.stringify(data[which], null, 2)))
      .catch(() => setError(true));
  };
  return (
    <div className="space-y-3">
      {summary.length ? (
        <div className="tf-mt-wrap">
          <table className="tf-mt">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((field) => (
                <tr key={field.name}>
                  <td>
                    <code className="tf-mt-name">{field.name}</code>
                    <span className={field.required ? 'tf-mt-req' : 'tf-mt-opt'}>
                      {field.required ? 'Required' : 'Optional'}
                    </span>
                  </td>
                  <td>
                    <code className="tf-mt-type">{field.type}</code>
                  </td>
                  <td className="tf-mt-doc">{field.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-fd-muted-foreground">No top-level fields.</p>
      )}
      <details className="tf-disclosure" onToggle={(event) => event.currentTarget.open && load()}>
        <summary>Complete JSON Schema</summary>
        <div className="mt-2">
          {schema ? (
            <CodePanel code={schema} lang="json" title="JSON Schema" />
          ) : error ? (
            <p role="alert" className="text-xs text-fd-muted-foreground">
              The schema could not load. operation-catalog.json has every schema.
            </p>
          ) : (
            <p className="text-xs text-fd-muted-foreground">Loading…</p>
          )}
        </div>
      </details>
    </div>
  );
}
