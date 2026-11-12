'use client';
import Link from 'next/link';
import { useState } from 'react';
import { BASE_PATH } from '@/lib/site';
import type { ExportLink, MemberView, ReferenceEntryView } from '@/src/site-data';
import { CodePanel } from '../code/code-panel';
import { JsDocText } from './jsdoc-text';
import { KindBadge } from './kind-badge';
import { MemberTable } from './member-table';

/**
 * Reference declarations render as a client component: the page ships the entries once as data
 * (not as a server-rendered tree plus its serialized copy), and the markup is produced from it.
 */
export function ReferenceEntries({
  entries,
  entrypoint,
  contract,
}: {
  entries: ReferenceEntryView[];
  entrypoint: string;
  contract: string;
}) {
  return (
    <div className="space-y-10">
      {entries.map((entry) => {
        const importLine =
          entry.kind === 'interface' || entry.kind === 'type'
            ? `import type { ${entry.name} } from '${entrypoint}';`
            : `import { ${entry.name} } from '${entrypoint}';`;
        return (
          <article key={entry.id} id={entry.name} className="tf-entry">
            <header className="tf-entry-head">
              <KindBadge kind={entry.kind} />
              <h2>{entry.name}</h2>
              <a href={`#${encodeURIComponent(entry.name)}`} aria-label={`Link to ${entry.name}`}>
                #
              </a>
            </header>
            {entry.description ? (
              <JsDocText text={entry.description} className="tf-entry-doc" />
            ) : (
              <p className="tf-entry-doc tf-muted">
                Public declaration. Read the signature and member contracts below; no additional
                behaviour is inferred.
              </p>
            )}
            <div className="space-y-4">
              <CodePanel code={`${importLine}\n\n${entry.signature}`} title="Signature" />
              {entry.memberCount ? <Members entry={entry} contract={contract} /> : null}
              {entry.examples.map((example, index) => (
                <CodePanel
                  key={index}
                  code={example}
                  title={entry.examples.length > 1 ? `Example ${index + 1}` : 'Example'}
                />
              ))}
              {entry.tags.length ? (
                <dl className="tf-entry-tags">
                  {entry.tags.map((tag, index) => (
                    <div key={`${tag.name}-${index}`}>
                      <dt>@{tag.name}</dt>
                      <dd>
                        <JsDocText text={tag.text || '—'} />
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <p className="tf-entry-foot">
                Stability: {entry.stability}. Units come from declared names; “unitless by name”
                means the name alone does not establish a unit. See{' '}
                <Link href="/guides/assumptions" prefetch={false}>
                  conventions
                </Link>{' '}
                and{' '}
                <Link href="/guides/errors" prefetch={false}>
                  errors and warnings
                </Link>
                .
              </p>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/** One fetch per entry point's JSON contract, shared by every entry on the page. */
const contracts = new Map<string, Promise<Map<string, MemberView[]>>>();
function loadContract(url: string): Promise<Map<string, MemberView[]>> {
  let request = contracts.get(url);
  if (!request) {
    request = fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          exports: { id: string; members: MemberView[] }[];
        };
        return new Map(data.exports.map((entry) => [entry.id, entry.members]));
      })
      .catch((error: unknown) => {
        contracts.delete(url);
        throw error;
      });
    contracts.set(url, request);
  }
  return request;
}

const PAGE = 200;

/**
 * Small contracts are inline and open. Larger ones load every member from the entry point's JSON
 * contract when opened, so a page never ships thousands of rows nobody asked to see.
 */
function Members({ entry, contract }: { entry: ReferenceEntryView; contract: string }) {
  const inline = entry.members;
  const [members, setMembers] = useState<MemberView[] | null>(inline);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const open = () => {
    if (members) return;
    const base = document.documentElement.dataset['tfBase'] ?? BASE_PATH;
    loadContract(`${base}${contract}`)
      .then((all) => setMembers(all.get(entry.id) ?? []))
      .catch(() =>
        setError(
          'The member list could not load. The JSON contract and Markdown page have every member.',
        ),
      );
  };
  return (
    <details
      className="tf-disclosure"
      open={inline !== null}
      onToggle={(event) => event.currentTarget.open && open()}
    >
      <summary>
        Fields, parameters and returned members ({entry.memberCount.toLocaleString('en-US')})
      </summary>
      <div className="mt-3">
        {members ? (
          <>
            <MemberTable members={members.slice(0, shown)} />
            {members.length > shown ? (
              <button
                type="button"
                onClick={() => setShown(shown + PAGE)}
                className="mt-2 text-xs font-medium text-fd-primary hover:underline"
              >
                Show {Math.min(PAGE, members.length - shown)} more of {members.length - shown}{' '}
                remaining
              </button>
            ) : null}
          </>
        ) : error ? (
          <p role="alert" className="text-xs text-fd-muted-foreground">
            {error}
          </p>
        ) : (
          <p className="text-xs text-fd-muted-foreground">
            Loading {entry.memberCount.toLocaleString('en-US')} members…
          </p>
        )}
      </div>
    </details>
  );
}

const KIND_ORDER: [string, string][] = [
  ['function', 'Functions'],
  ['value', 'Values & facades'],
  ['class', 'Classes'],
  ['namespace', 'Namespaces'],
  ['interface', 'Interfaces'],
  ['type', 'Types'],
];

export function ExportGrid({ exports }: { exports: ExportLink[] }) {
  return (
    <div className="space-y-6">
      {KIND_ORDER.map(([kind, title]) => {
        const items = exports.filter((entry) => entry.kind === kind);
        if (!items.length) return null;
        return (
          <section key={kind}>
            <h2 className="tf-grid-title">
              {title} <span>· {items.length}</span>
            </h2>
            <ul className="tf-export-grid">
              {items.map((entry) => (
                <li key={`${entry.kind}-${entry.name}`}>
                  <Link href={entry.url} prefetch={false} title={entry.summary}>
                    <code>{entry.name}</code>
                    <span>{entry.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
