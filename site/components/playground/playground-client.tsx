'use client';
import { Check, Link2, Loader2, RotateCcw, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultInput, inputSchema, validateInputs } from '@/src/playgrounds/inputs';
import { inputToQuery, queryToInput } from '@/src/url-state';
import {
  isNumberControl,
  type Calculation,
  type Control,
  type DataValue,
  type PlaygroundInput,
  type TableRow,
} from '@/src/types';
import { DataControl, NumberControl, SelectControl, TableControl } from './controls';
import { AskAgent } from './ask-agent';
import { Examples } from './examples';
import { CalculationResults } from './results';

export interface PlaygroundClientProps {
  id: string;
  title: string;
  introduction: string;
  controls: Control[];
  initial: Calculation;
}

type Status = { state: 'ready' } | { state: 'running' } | { state: 'error'; message: string };

const TIMEOUT_MS = 15000;

/** One long-lived worker per page; requests are numbered so a late answer can never win. */
function useCalculator(id: string) {
  const worker = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const pending = useRef(
    new Map<
      number,
      { resolve: (value: Calculation) => void; reject: (error: Error) => void; timer: number }
    >(),
  );

  const reset = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    for (const [, request] of pending.current) {
      window.clearTimeout(request.timer);
      request.reject(new Error('The calculation was interrupted.'));
    }
    pending.current.clear();
  }, []);

  useEffect(() => reset, [reset]);

  return useCallback(
    async (input: PlaygroundInput): Promise<Calculation> => {
      if (typeof Worker === 'undefined') {
        const { loadPlayground } = await import('@/src/playgrounds/load');
        const playground = await loadPlayground(id);
        return playground.run(validateInputs(playground, input));
      }
      if (!worker.current) {
        const created = new Worker(new URL('../../src/calculation-worker.ts', import.meta.url), {
          type: 'module',
        });
        created.onmessage = (
          event: MessageEvent<{ requestId: number; result?: Calculation; error?: string }>,
        ) => {
          const request = pending.current.get(event.data.requestId);
          if (!request) return;
          pending.current.delete(event.data.requestId);
          window.clearTimeout(request.timer);
          if (event.data.error) request.reject(new Error(event.data.error));
          else if (event.data.result) request.resolve(event.data.result);
          else request.reject(new Error('The calculation returned no result.'));
        };
        created.onerror = () => {
          reset();
        };
        worker.current = created;
      }
      const requestId = ++sequence.current;
      return new Promise<Calculation>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.current.delete(requestId);
          reset();
          reject(
            new Error(
              `Calculation stopped after ${TIMEOUT_MS / 1000} seconds. Try fewer rows or smaller inputs.`,
            ),
          );
        }, TIMEOUT_MS);
        pending.current.set(requestId, { resolve, reject, timer });
        worker.current!.postMessage({ requestId, playgroundId: id, input });
      });
    },
    [id, reset],
  );
}

interface BrowserToolContext {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}

export function PlaygroundClient({
  id,
  title,
  introduction,
  controls,
  initial,
}: PlaygroundClientProps) {
  const defaults = useMemo(() => defaultInput({ controls }), [controls]);
  const [input, setInput] = useState<PlaygroundInput>(defaults);
  // The inputs of the last successful calculation (prompts and examples describe these).
  const [validInput, setValidInput] = useState<PlaygroundInput>(defaults);
  const [calculation, setCalculation] = useState<Calculation>(initial);
  const [status, setStatus] = useState<Status>({ state: 'ready' });
  const [shared, setShared] = useState<'idle' | 'copied' | 'note'>('idle');
  const [touched, setTouched] = useState(false);
  const calculate = useCalculator(id);
  const latest = useRef(0);
  const debounce = useRef<number | undefined>(undefined);

  const run = useCallback(
    async (next: PlaygroundInput, { updateUrl = true } = {}) => {
      const ticket = ++latest.current;
      setStatus({ state: 'running' });
      try {
        const validated = validateInputs({ controls }, next);
        const result = await calculate(validated);
        if (ticket !== latest.current) return result;
        setCalculation(result);
        setValidInput(validated);
        setStatus({ state: 'ready' });
        if (updateUrl) {
          const { query } = inputToQuery(controls, validated);
          window.history.replaceState(
            window.history.state,
            '',
            `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
          );
        }
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'The calculation could not complete.';
        if (ticket === latest.current) setStatus({ state: 'error', message });
        throw error;
      }
    },
    [calculate, controls],
  );

  const schedule = useCallback(
    (next: PlaygroundInput, immediate = false) => {
      setInput(next);
      setTouched(true);
      window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(
        () => void run(next).catch(() => undefined),
        immediate ? 0 : 160,
      );
    },
    [run],
  );

  // A shared link restores its inputs on load.
  useEffect(() => {
    if (!window.location.search) return;
    const restored = { ...defaults, ...queryToInput(controls, window.location.search) };
    try {
      validateInputs({ controls }, restored);
    } catch {
      return;
    }
    if (JSON.stringify(restored) === JSON.stringify(defaults)) return;
    setInput(restored);
    void run(restored, { updateUrl: false }).catch(() => undefined);
  }, [controls, defaults, run]);

  // Page-scoped browser agent tool (WebMCP), generated from the same control schema.
  useEffect(() => {
    const context = (document as Document & { modelContext?: BrowserToolContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      context.registerTool(
        {
          name: `calculate_${id.replaceAll('-', '_')}`,
          title,
          description: `${introduction} Runs the visible calculator in this page and updates its inputs, results, charts and copyable TypeScript. Computes only on the inputs supplied; never fetches data, stores a portfolio or places orders. Defaults are hypothetical examples, not recommendations.`,
          inputSchema: inputSchema({ controls }),
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          async execute(raw) {
            const validated = validateInputs({ controls }, raw);
            setInput(validated);
            setTouched(true);
            const result = await run(validated);
            return {
              metrics: result.metrics,
              assumptions: result.assumptions,
              diagnostics: result.diagnostics,
              result: result.result,
              code: result.code,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [controls, id, introduction, run, title]);

  const visible = (control: Control) =>
    !control.when || input[control.when.name] === control.when.value;
  const share = async () => {
    const { query, omitted } = inputToQuery(controls, input);
    const url = `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      setShared(omitted.length ? 'note' : 'copied');
    } catch {
      window.prompt('Copy this link', url);
    }
    window.setTimeout(() => setShared('idle'), 3500);
  };

  const panel = (
    <div className="overflow-hidden rounded-2xl border border-panel-border bg-panel text-panel-foreground shadow-xl shadow-slate-950/10">
      <div className="flex items-center justify-between gap-3 border-b border-panel-border px-5 py-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-white">Run it</h2>
          <p className="text-xs text-panel-muted">
            Live, in your browser. Nothing leaves this page.
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-panel-border px-2.5 py-1 text-[0.6875rem] text-panel-muted">
          {status.state === 'running' ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Zap className="size-3 text-[#7be0b8]" aria-hidden />
          )}
          {status.state === 'running' ? 'Calculating' : 'Local'}
        </span>
      </div>
      <form
        className="tf-scrollbar space-y-5 overflow-y-auto px-5 py-5 xl:max-h-[calc(100dvh-var(--tf-header-height)-12.5rem)]"
        onSubmit={(event) => {
          event.preventDefault();
          void run(input).catch(() => undefined);
        }}
        aria-label={`${title} inputs`}
      >
        {controls.filter(visible).map((control) => {
          const value = input[control.name];
          const update = (next: PlaygroundInput[string], immediate = false) =>
            schedule({ ...input, [control.name]: next }, immediate);
          if (isNumberControl(control))
            return (
              <NumberControl
                key={control.name}
                control={control}
                value={value as number}
                onChange={(next) => update(next)}
              />
            );
          switch (control.kind) {
            case 'select':
              return (
                <SelectControl
                  key={control.name}
                  control={control}
                  value={value as string}
                  onChange={(next) => update(next, true)}
                />
              );
            case 'table':
              return (
                <TableControl
                  key={control.name}
                  control={control}
                  value={value as TableRow[]}
                  onChange={(next) => update(next)}
                />
              );
            case 'data':
              return (
                <DataControl
                  key={control.name}
                  control={control}
                  value={value as DataValue}
                  onChange={(next) => update(next, true)}
                />
              );
          }
        })}
        <button type="submit" className="sr-only">
          Calculate
        </button>
      </form>
      <div className="space-y-3 border-t border-panel-border px-5 py-4">
        <div role="status" aria-live="polite" className="min-h-4 text-xs">
          {status.state === 'error' ? (
            <p className="leading-5 text-[#ffb4b4]">
              <span className="font-semibold">Not calculated: </span>
              {status.message} The results show the last valid inputs.
            </p>
          ) : (
            <p className="text-panel-muted">
              {touched
                ? 'Results, charts and code follow your inputs.'
                : 'Change any input; everything updates.'}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setTouched(false);
              setInput(defaults);
              window.clearTimeout(debounce.current);
              void run(defaults).catch(() => undefined);
              window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${window.location.hash}`,
              );
            }}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-panel-border px-3 py-2 text-xs font-medium text-panel-foreground hover:bg-white/5"
          >
            <RotateCcw className="size-3.5" aria-hidden /> Reset
          </button>
          <button
            type="button"
            onClick={() => void share()}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#303fe1] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2432cf]"
          >
            {shared === 'idle' ? (
              <Link2 className="size-3.5" aria-hidden />
            ) : (
              <Check className="size-3.5" aria-hidden />
            )}
            {shared === 'copied'
              ? 'Link copied'
              : shared === 'note'
                ? 'Copied without your data'
                : 'Copy share link'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <section
      aria-label={`${title} calculator`}
      className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]"
    >
      <div className="xl:order-2">
        <div className="xl:sticky xl:top-[calc(var(--tf-header-height)+1.25rem)]">{panel}</div>
      </div>
      <div className="min-w-0 space-y-12 xl:order-1">
        <CalculationResults calculation={calculation} stale={status.state === 'running'} />
        <Examples
          calculation={calculation}
          onNeedResult={() => void run(input, { updateUrl: false }).catch(() => undefined)}
        />
        <AskAgent id={id} input={validInput} />
      </div>
    </section>
  );
}
