/**
 * The sandboxed iframe (`runtime/runner`, see `protocol.ts`). It owns one worker per run, relays
 * the worker's events to the page, and enforces the time and output limits by terminating the
 * worker. It talks only to its parent window and holds nothing worth stealing: its origin is
 * opaque and its Content-Security-Policy allows no network access.
 */
import {
  LATE_OUTPUT_MS,
  MAX_OUTPUT_CHARACTERS,
  MAX_OUTPUT_LINES,
  RUN_TIMEOUT_MS,
  type FrameEvent,
  type FrameRequest,
  type RunFailure,
  type RuntimeManifest,
  type WorkerEvent,
  type WorkerRequest,
} from './protocol';

const manifest = JSON.parse(
  document.getElementById('tf-runtime')?.textContent ?? 'null',
) as RuntimeManifest;
const runtime = new URL('./', import.meta.url);
const absolute = (file: string) => new URL(file, runtime).href;
const imports = Object.fromEntries(
  Object.entries(manifest.imports).map(([specifier, file]) => [specifier, absolute(file)]),
);
// A worker must share this document's (opaque) origin, so it starts from a one-line blob that
// imports the real bootstrap from the docs. It is a classic worker: browsers refuse a module
// worker from a blob in an opaque origin, while `import()` inside a classic worker works.
const workerShim = URL.createObjectURL(
  new Blob(
    [
      `import(${JSON.stringify(absolute(manifest.worker))}).catch(() => postMessage(${JSON.stringify(
        {
          type: 'failed',
          failure: {
            phase: 'runtime',
            name: 'Error',
            message: 'The sandbox could not load. Reload the page and try again.',
          },
        } satisfies WorkerEvent,
      )}));`,
    ],
    { type: 'text/javascript' },
  ),
);

interface Run {
  id: number;
  worker: Worker;
  timer: number;
  lines: number;
  characters: number;
}

let current: Run | null = null;
const send = (event: FrameEvent) => window.parent.postMessage(event, '*');

function end(run: Run, failure?: RunFailure): void {
  if (current !== run) return;
  current = null;
  window.clearTimeout(run.timer);
  run.worker.terminate();
  if (failure) send({ type: 'failed', id: run.id, failure });
}

function start(id: number, code: string): void {
  if (current) end(current);
  const worker = new Worker(workerShim, { name: 'TotalFinance example' });
  const run: Run = {
    id,
    worker,
    lines: 0,
    characters: 0,
    timer: window.setTimeout(
      () =>
        end(run, {
          phase: 'timeout',
          name: 'Stopped',
          message: `The code ran for ${RUN_TIMEOUT_MS / 1000} s without finishing, so it was stopped.`,
        }),
      RUN_TIMEOUT_MS,
    ),
  };
  current = run;
  worker.onmessage = (message: MessageEvent<WorkerEvent>) => {
    if (current !== run) return;
    const event = message.data;
    switch (event.type) {
      case 'ready': {
        const request: WorkerRequest = {
          code,
          imports,
          transpiler: absolute(manifest.transpiler),
          nodeOnly: manifest.nodeOnly,
        };
        worker.postMessage(request);
        send({ type: 'started', id });
        break;
      }
      case 'output': {
        run.lines += 1;
        run.characters += event.text.length;
        if (run.lines > MAX_OUTPUT_LINES || run.characters > MAX_OUTPUT_CHARACTERS) {
          end(run, {
            phase: 'limit',
            name: 'Stopped',
            message: `The output passed ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_CHARACTERS.toLocaleString('en-US')} characters, so the run was stopped.`,
          });
          return;
        }
        send({ type: 'output', id, level: event.level, text: event.text });
        break;
      }
      case 'done':
        send({ type: 'done', id, milliseconds: event.milliseconds });
        // Output from timers that fire right after the program finishes still arrives.
        window.setTimeout(() => end(run), LATE_OUTPUT_MS);
        break;
      case 'failed':
        send({ type: 'failed', id, failure: event.failure });
        end(run);
        break;
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    end(run, {
      phase: 'runtime',
      name: 'Error',
      message:
        event.message || 'The sandbox could not start the code. Reload the page and try again.',
    });
  };
}

window.addEventListener('message', (event: MessageEvent<FrameRequest>) => {
  if (event.source !== window.parent) return;
  const request = event.data;
  if (request?.type === 'run' && typeof request.code === 'string' && Number.isInteger(request.id))
    start(request.id, request.code);
  else if (request?.type === 'stop' && current?.id === request.id)
    end(current, { phase: 'stopped', name: 'Stopped', message: 'Stopped.' });
});

send({ type: 'ready', version: manifest.version });
