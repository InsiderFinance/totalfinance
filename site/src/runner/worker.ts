/**
 * The worker that runs the reader's code (see `protocol.ts`). It strips TypeScript with
 * Sucrase (line numbers stay the same), points imports at the docs' bundles, imports the result
 * as a module, and reports console output, completion and failures. The iframe that created it
 * terminates it on completion, timeout, a new run or Stop.
 */
import {
  compileFailure,
  describeFailure,
  formatArguments,
  rewriteImports,
  type OutputLevel,
  type WorkerEvent,
  type WorkerRequest,
} from './protocol';

interface WorkerScope {
  postMessage(event: WorkerEvent): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: 'unhandledrejection',
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}

const scope = globalThis as unknown as WorkerScope;
const post = (event: WorkerEvent) => scope.postMessage(event);
let userModule: string | undefined;

const levels: OutputLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
for (const level of levels)
  console[level] = (...values: unknown[]) =>
    post({ type: 'output', level, text: formatArguments(values) });
console.table = (data: unknown) =>
  post({ type: 'output', level: 'log', text: formatArguments([data]) });
console.dir = (value: unknown) =>
  post({ type: 'output', level: 'log', text: formatArguments([value]) });

// Errors after the program finished (a timer, a forgotten promise) still reach the reader.
scope.addEventListener('error', (event) => {
  event.preventDefault();
  post({
    type: 'failed',
    failure: describeFailure(event.error ?? new Error(event.message), 'runtime', userModule),
  });
});
scope.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  post({ type: 'failed', failure: describeFailure(event.reason, 'runtime', userModule) });
});

let started = false;
scope.addEventListener('message', (event) => {
  if (started) return;
  started = true;
  void run(event.data);
});

async function run({ code, imports, transpiler, nodeOnly }: WorkerRequest): Promise<void> {
  let transform: (source: string, options: object) => { code: string };
  try {
    ({ transform } = (await import(/* webpackIgnore: true */ transpiler)) as {
      transform: typeof transform;
    });
  } catch {
    post({
      type: 'failed',
      failure: {
        phase: 'runtime',
        name: 'Error',
        message: 'The TypeScript compiler could not load. Reload the page and try again.',
      },
    });
    return;
  }
  let javascript: string;
  try {
    javascript = transform(code, {
      transforms: ['typescript'],
      disableESTransforms: true,
    }).code;
  } catch (error) {
    post({ type: 'failed', failure: compileFailure(error) });
    return;
  }
  try {
    javascript = rewriteImports(javascript, imports, nodeOnly);
  } catch (error) {
    post({ type: 'failed', failure: describeFailure(error, 'import') });
    return;
  }
  userModule = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }));
  const startedAt = performance.now();
  try {
    await import(/* webpackIgnore: true */ userModule);
    post({ type: 'done', milliseconds: performance.now() - startedAt });
  } catch (error) {
    post({ type: 'failed', failure: describeFailure(error, 'runtime', userModule) });
  }
}

post({ type: 'ready' });
