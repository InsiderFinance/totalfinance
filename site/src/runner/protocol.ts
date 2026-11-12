/**
 * "Edit and run": the reader's edited first-call example runs in their browser, isolated three
 * ways. The page embeds a sandboxed iframe (`sandbox="allow-scripts"`, an opaque origin with no
 * access to the page, its cookies or storage); the iframe runs the code in a worker it can
 * stop at any time; the iframe's Content-Security-Policy refuses network access and every script
 * that is not part of these docs. Code only ever comes from the editor — never from a URL — and
 * only runs on an explicit Run.
 *
 * This module is the shared, framework-free core: message shapes, limits, import rewriting and
 * value formatting. `frame.ts` (the iframe) and `worker.ts` (the worker) use it; so do the tests.
 */

/** A run stops after this long. Calculators answer in milliseconds; a loop that never ends must not. */
export const RUN_TIMEOUT_MS = 10_000;
/** Output beyond these limits is cut, and the run stops. */
export const MAX_OUTPUT_LINES = 500;
export const MAX_OUTPUT_CHARACTERS = 200_000;
/** After the program finishes, late timer output is still collected for this long. */
export const LATE_OUTPUT_MS = 250;

export const PACKAGE_SPECIFIER = '@insiderfinance/totalfinance';

/** `runtime/manifest`: public specifier → bundle file, relative to the runtime directory. */
export interface RuntimeManifest {
  /** Package version the bundles were built from. */
  version: string;
  imports: Record<string, string>;
  /** The TypeScript stripper (Sucrase), relative to the runtime directory. */
  transpiler: string;
  /** The worker bootstrap, relative to the runtime directory. */
  worker: string;
  /** Node-only entry points that cannot run in a browser. */
  nodeOnly: string[];
}

export type OutputLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** Page → iframe. */
export type FrameRequest = { type: 'run'; id: number; code: string } | { type: 'stop'; id: number };

/** Why a run ended without finishing. `compile`: the code is not valid; `import`: a refused import. */
export type FailurePhase = 'compile' | 'import' | 'runtime' | 'timeout' | 'limit' | 'stopped';

export interface RunFailure {
  phase: FailurePhase;
  name: string;
  message: string;
  /** TotalFinance error code (`QuantError.code`), when the error has one. */
  code?: string;
  /** Formatted `QuantError.context`, when present. */
  context?: string;
  /** 1-based line in the reader's code, when the browser reports it. */
  line?: number;
}

/** Iframe → page. Every message after `ready` names the run it belongs to. */
export type FrameEvent =
  | { type: 'ready'; version: string }
  | { type: 'started'; id: number }
  | { type: 'output'; id: number; level: OutputLevel; text: string }
  | { type: 'done'; id: number; milliseconds: number }
  | { type: 'failed'; id: number; failure: RunFailure };

/** Iframe → worker. */
export interface WorkerRequest {
  code: string;
  /** Absolute URLs: specifier → bundle. */
  imports: Record<string, string>;
  /** Absolute URL of the TypeScript stripper. */
  transpiler: string;
  /** Node-only specifiers, refused with a specific message. */
  nodeOnly: string[];
}

/** Worker → iframe. */
export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'output'; level: OutputLevel; text: string }
  | { type: 'done'; milliseconds: number }
  | { type: 'failed'; failure: RunFailure };

export class RunnerError extends Error {
  constructor(
    readonly phase: FailurePhase,
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

const lineAt = (source: string, index: number) => source.slice(0, index).split('\n').length;

/** `import … from '…'`, `export … from '…'` and side-effect `import '…'`. */
const STATIC_IMPORT = /\b(?:import|export)(?:\s+[^'";]*?\s+from\s*|\s*)(['"])([^'"\n]+)\1/g;
/** `import('…')` with a literal, or `import(` followed by anything else (refused). */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(['"])([^'"\n]+)\1\s*\)|(?=[^'"\s]))/g;

/**
 * Point every import at the docs' own browser bundles. Only public `@insiderfinance/totalfinance`
 * entry points resolve; a relative path, a URL, another package or a computed `import()` is
 * refused with a message, because nothing else exists in the sandbox (and fetching code from a
 * URL is exactly what the runner must never do). Line numbers survive: nothing adds a line.
 */
export function rewriteImports(
  source: string,
  imports: Readonly<Record<string, string>>,
  nodeOnly: readonly string[] = [],
): string {
  const resolve = (specifier: string, line: number): string => {
    const url = imports[specifier];
    if (url) return url;
    if (nodeOnly.includes(specifier))
      throw new RunnerError(
        'import',
        `${specifier} is Node-only (it uses files, processes or sockets), so it cannot run in a browser. Run it with Node.`,
        line,
      );
    if (specifier === PACKAGE_SPECIFIER || specifier.startsWith(`${PACKAGE_SPECIFIER}/`))
      throw new RunnerError(
        'import',
        `${specifier} is not a public entry point of ${PACKAGE_SPECIFIER}. Check the API reference for the import path.`,
        line,
      );
    throw new RunnerError(
      'import',
      `Only ${PACKAGE_SPECIFIER} imports are available here, not "${specifier}". Copy the code to run it with other packages.`,
      line,
    );
  };
  const statics = source.replace(
    STATIC_IMPORT,
    (match, quote: string, specifier: string, offset: number) =>
      `${match.slice(0, match.length - specifier.length - 2)}${quote}${resolve(specifier, lineAt(source, offset))}${quote}`,
  );
  return statics.replace(
    DYNAMIC_IMPORT,
    (_match, quote: string | undefined, specifier: string | undefined, offset: number) => {
      const line = lineAt(statics, offset);
      if (specifier === undefined)
        throw new RunnerError(
          'import',
          `import() needs a literal ${PACKAGE_SPECIFIER} path here.`,
          line,
        );
      return `import(${quote}${resolve(specifier, line)}${quote})`;
    },
  );
}

const INDENT = '  ';

/**
 * A readable value, JSON-shaped like the page's "Output of this example": for plain data it is
 * exactly `JSON.stringify(value, null, 2)`, except that NaN and infinities stay visible. Values
 * JSON cannot hold (bigint, undefined, functions, Map, Set, Date, errors, cycles) get a
 * JavaScript-style label instead of disappearing.
 */
export function formatValue(value: unknown): string {
  const seen = new WeakSet<object>();
  const format = (entry: unknown, depth: number): string => {
    const pad = INDENT.repeat(depth);
    const inner = INDENT.repeat(depth + 1);
    switch (typeof entry) {
      case 'string':
        return JSON.stringify(entry);
      case 'number':
        return Number.isFinite(entry) ? JSON.stringify(entry) : String(entry);
      case 'boolean':
        return String(entry);
      case 'bigint':
        return `${entry}n`;
      case 'undefined':
        return 'undefined';
      case 'symbol':
        return entry.toString();
      case 'function':
        return `[Function ${entry.name || 'anonymous'}]`;
    }
    if (entry === null) return 'null';
    const object = entry as object;
    if (seen.has(object)) return '[Circular]';
    if (object instanceof Date)
      return Number.isNaN(object.getTime()) ? 'Invalid Date' : JSON.stringify(object.toJSON());
    if (object instanceof Error) return formatError(object);
    const list = (items: string[], open: string, close: string) =>
      items.length
        ? `${open}\n${items.map((item) => inner + item).join(',\n')}\n${pad}${close}`
        : `${open}${close}`;
    seen.add(object);
    try {
      if (object instanceof Map)
        return `Map(${object.size}) ${list(
          [...object].map(
            ([key, item]) => `${format(key, depth + 1)} => ${format(item, depth + 1)}`,
          ),
          '{',
          '}',
        )}`;
      if (object instanceof Set)
        return `Set(${object.size}) ${list(
          [...object].map((item) => format(item, depth + 1)),
          '[',
          ']',
        )}`;
      if (Array.isArray(object) || ArrayBuffer.isView(object)) {
        const items = Array.from(object as ArrayLike<unknown>, (item) => format(item, depth + 1));
        const label = Array.isArray(object) ? '' : `${object.constructor.name}(${items.length}) `;
        return label + list(items, '[', ']');
      }
      const json = (object as { toJSON?: unknown }).toJSON;
      if (typeof json === 'function') return format(json.call(object), depth);
      return list(
        Object.entries(object).map(
          ([key, item]) => `${JSON.stringify(key)}: ${format(item, depth + 1)}`,
        ),
        '{',
        '}',
      );
    } finally {
      seen.delete(object);
    }
  };
  return format(value, 0);
}

/** `console.log` arguments: strings print as themselves, everything else as `formatValue`. */
export function formatArguments(values: readonly unknown[]): string {
  return values.map((value) => (typeof value === 'string' ? value : formatValue(value))).join(' ');
}

function formatError(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return `${error.name}: ${error.message}${typeof code === 'string' ? ` [${code}]` : ''}`;
}

/** Describe a thrown value for the page; `userModule` is the URL the reader's code ran from. */
export function describeFailure(
  error: unknown,
  phase: FailurePhase,
  userModule?: string,
): RunFailure {
  if (error instanceof RunnerError)
    return {
      phase: error.phase,
      name: 'Error',
      message: error.message,
      ...(error.line ? { line: error.line } : {}),
    };
  if (!(error instanceof Error))
    return { phase, name: 'Thrown value', message: formatArguments([error]) };
  const failure: RunFailure = { phase, name: error.name, message: error.message };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') failure.code = code;
  const context = (error as { context?: unknown }).context;
  if (context !== undefined) failure.context = formatValue(context);
  const line = userModule ? userLine(error.stack ?? '', userModule) : undefined;
  if (line) failure.line = line;
  return failure;
}

/** The first stack frame in the reader's module, as a 1-based line (Sucrase keeps lines). */
export function userLine(stack: string, userModule: string): number | undefined {
  const at = stack.indexOf(userModule);
  if (at === -1) return undefined;
  const match = /^:(\d+)(?::\d+)?/.exec(stack.slice(at + userModule.length));
  return match ? Number(match[1]) : undefined;
}

/** Sucrase reports `… (line:column)`; keep the line for the editor. */
export function compileFailure(error: unknown): RunFailure {
  const message = error instanceof Error ? error.message : String(error);
  const position = /\((\d+):(\d+)\)\s*$/.exec(message);
  return {
    phase: 'compile',
    name: 'SyntaxError',
    message: message.replace(/\s*\(\d+:\d+\)\s*$/, ''),
    ...(position ? { line: Number(position[1]) } : {}),
  };
}
