'use client';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tokenize } from '@/src/highlight';
import {
  RUN_TIMEOUT_MS,
  formatValue,
  type OutputLevel,
  type RunFailure,
} from '@/src/runner/protocol';
import { Code } from '../code/code';
import { CopyButton } from '../code/copy-button';
import { runner } from './runner-client';

type Status =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; id: number }
  | { kind: 'done'; milliseconds: number }
  | { kind: 'failed'; failure: RunFailure };

interface OutputLine {
  level: OutputLevel;
  text: string;
}

const LEVEL_PREFIX: Partial<Record<OutputLevel, string>> = { warn: 'warn ', error: 'error ' };

/** Plain-text editor over the same highlighter as the static panels; the textarea stays the input. */
function Editor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
}) {
  const tokens = useMemo(() => tokenize(value, 'ts'), [value]);
  return (
    <div className="tf-code-body max-h-[30rem]">
      <div className="tf-editor grid min-w-max">
        <pre aria-hidden className="tf-code-pre pointer-events-none [grid-area:1/1]">
          <code>
            {tokens.map((token, index) =>
              token.cls ? (
                <span key={index} className={`tk-${token.cls}`}>
                  {token.text}
                </span>
              ) : (
                token.text
              ),
            )}
            {'\n'}
          </code>
        </pre>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              onRun();
            }
          }}
          aria-label="Example code. Edit it, then press Control or Command and Enter to run."
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="tf-editor-input [grid-area:1/1]"
        />
      </div>
    </div>
  );
}

function StatusLine({
  status,
  matches,
  onStop,
}: {
  status: Status;
  matches: boolean;
  onStop: () => void;
}) {
  switch (status.kind) {
    case 'idle':
      return (
        <span>
          Runs in a sandbox in your browser: no network, no access to this page. Stops after{' '}
          {RUN_TIMEOUT_MS / 1000} s.
        </span>
      );
    case 'starting':
    case 'running':
      return (
        <span className="flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {status.kind === 'starting' ? 'Starting the sandbox…' : 'Running…'}
          {status.kind === 'running' ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-slate-200 hover:bg-white/10"
            >
              <Square className="size-3" aria-hidden /> Stop
            </button>
          ) : null}
        </span>
      );
    case 'done':
      return (
        <span className="flex items-center gap-2 text-slate-200">
          <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden />
          Finished in{' '}
          {status.milliseconds < 1 ? 'under 1 ms' : `${Math.round(status.milliseconds)} ms`}
          {matches ? ' · same output as below' : ''}
        </span>
      );
    case 'failed': {
      const { failure } = status;
      return (
        <span className="flex items-start gap-2 text-slate-100">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-hidden />
          <span>
            <span className="font-semibold">
              {failure.phase === 'compile'
                ? 'Not valid TypeScript'
                : failure.phase === 'import'
                  ? 'Import not available'
                  : failure.name}
              {failure.code ? ` [${failure.code}]` : ''}
              {failure.line ? ` · line ${failure.line}` : ''}:
            </span>{' '}
            {failure.message}
          </span>
        </span>
      );
    }
  }
}

/**
 * The calculator's first call, as a code panel that can switch into an editor and run in the
 * reader's browser (see `src/runner/protocol.ts`). Runs only on an explicit Run; the code never
 * comes from or goes to a URL.
 */
export function RunnableFirstCall({
  display,
  program,
  copyLabel,
  documentedOutput,
}: {
  /** The code shown before editing (the call itself). */
  display: string;
  /** The complete program that runs and copies (sample setup plus the call). */
  program: string;
  copyLabel: string;
  /** The page's "Output of this example", to confirm a run reproduces it. */
  documentedOutput: unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lines, setLines] = useState<OutputLine[]>([]);
  // The latest run; events of any earlier run (or after unmount) are ignored.
  const current = useRef(0);
  const stopRun = useRef<() => void>(() => {});
  const code = draft ?? program;
  const documented = useMemo(() => formatValue(documentedOutput), [documentedOutput]);

  useEffect(
    () => () => {
      current.current = -1;
    },
    [],
  );

  const run = async () => {
    const runId = ++current.current;
    setLines([]);
    setStatus({ kind: 'starting' });
    try {
      const sandbox = await runner();
      if (current.current !== runId) return;
      const id = sandbox.run(code, (event) => {
        if (current.current !== runId) return;
        if (event.type === 'started') setStatus({ kind: 'running', id });
        else if (event.type === 'output')
          setLines((previous) => [...previous, { level: event.level, text: event.text }]);
        else if (event.type === 'done')
          setStatus({ kind: 'done', milliseconds: event.milliseconds });
        else if (event.type === 'failed') setStatus({ kind: 'failed', failure: event.failure });
      });
      stopRun.current = () => sandbox.stop(id);
    } catch (error) {
      if (current.current === runId)
        setStatus({
          kind: 'failed',
          failure: {
            phase: 'runtime',
            name: 'Error',
            message: error instanceof Error ? error.message : 'The sandbox did not start.',
          },
        });
    }
  };
  const busy = status.kind === 'starting' || status.kind === 'running';
  const matches =
    status.kind === 'done' &&
    lines.length === 1 &&
    lines[0]!.level === 'log' &&
    lines[0]!.text === documented;

  const button = (label: string, icon: ReactNode, onClick: () => void, primary = false) => (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
        primary
          ? 'bg-fd-primary text-white hover:bg-fd-primary/90 disabled:opacity-60'
          : 'text-slate-300 hover:bg-white/10 hover:text-white'
      }`}
      disabled={primary && busy}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <figure className="tf-code not-prose">
      <figcaption className="tf-code-bar">
        <span className="truncate">{editing ? 'First call · editable' : 'First call'}</span>
        <span className="flex items-center gap-1">
          {editing ? (
            <>
              {draft !== null
                ? button('Reset', <RotateCcw className="size-3.5" aria-hidden />, () =>
                    setDraft(null),
                  )
                : null}
              <CopyButton text={code} label="Copy" />
              {button('Close', <X className="size-3.5" aria-hidden />, () => setEditing(false))}
              {button('Run', <Play className="size-3.5" aria-hidden />, () => void run(), true)}
            </>
          ) : (
            <>
              {button('Edit and run', <Pencil className="size-3.5" aria-hidden />, () =>
                setEditing(true),
              )}
              <CopyButton text={program} label={copyLabel} />
            </>
          )}
        </span>
      </figcaption>
      {editing ? (
        <>
          <Editor value={code} onChange={setDraft} onRun={() => void (!busy && run())} />
          <div className="border-t border-panel-border">
            <div
              role="status"
              className="flex min-h-9 items-center px-4 py-2 text-xs text-panel-muted"
            >
              <StatusLine status={status} matches={matches} onStop={() => stopRun.current()} />
            </div>
            {lines.length ? (
              <pre
                role="log"
                aria-label="Output"
                className="tf-code-pre tf-scrollbar max-h-72 overflow-auto border-t border-panel-border"
              >
                <code>
                  {lines.map((line, index) => (
                    <span
                      key={index}
                      className={
                        line.level === 'error'
                          ? 'text-red-300'
                          : line.level === 'warn'
                            ? 'text-amber-200'
                            : undefined
                      }
                    >
                      {LEVEL_PREFIX[line.level] ?? ''}
                      {line.text}
                      {'\n'}
                    </span>
                  ))}
                </code>
              </pre>
            ) : null}
            {status.kind === 'failed' && status.failure.context ? (
              <pre className="tf-code-pre max-h-48 overflow-auto border-t border-panel-border text-xs">
                <code>context: {status.failure.context}</code>
              </pre>
            ) : null}
          </div>
        </>
      ) : (
        <div className="tf-code-body max-h-[30rem]">
          <Code code={display} />
        </div>
      )}
    </figure>
  );
}
