import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createContext, runInContext, type Context } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { build, transform, version as esbuildVersion } from 'esbuild';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup, VERSION as rollupVersion, type RollupLog } from 'rollup';
import type { ConsumerBundler, ConsumerFixture } from './consumer-fixtures.js';

export interface ConsumerMeasurement {
  fixture: string;
  bundler: ConsumerBundler;
  bundlerVersion: string;
  bytesMin: number;
  bytesGzip: number;
  code: string;
  /** esbuild bytesInOutput, or Rollup renderedLength before its output-only minification. */
  retainedModules: { id: string; bytes: number }[];
}

/**
 * Reuses the existing packed consumer installation. No packing/install, source aliases, injected
 * pure annotations, externals or moduleSideEffects override: installed exports/sideEffects own
 * resolution and elimination. Rollup uses node-resolve's browser conditions and package metadata.
 * esbuild only MINIFIES Rollup's finished chunk (transform, not build); Rollup owns tree shaking.
 */
export async function measureConsumer(
  consumer: string,
  fixture: ConsumerFixture,
  bundler: ConsumerBundler,
  verifyErrorTypes = false,
): Promise<ConsumerMeasurement> {
  const directory = realpathSync(consumer);
  const modules = realpathSync(join(directory, 'node_modules')) + sep;
  const entries = join(directory, 'tree-shaking');
  mkdirSync(entries, { recursive: true });
  const entry = join(entries, `${fixture.id}${verifyErrorTypes ? '-validation' : ''}.mjs`);
  writeFileSync(
    entry,
    fixture.source +
      (verifyErrorTypes
        ? `
import { InputError, QuantError } from '@totalfinance/core';
globalThis.consumerErrorType = (error) => error instanceof InputError && error instanceof QuantError;
`
        : ''),
  );

  const installedId = (file: string): string => {
    const absolute = realpathSync(resolve(directory, file));
    assert.ok(
      absolute.startsWith(modules),
      `Consumer resolved outside its installed node_modules: ${file}`,
    );
    const id = relative(modules, absolute).split(sep).join('/');
    assert.match(
      id,
      /^(?:@totalfinance\/[^/]+|totalfinance)\/dist\/.+\.js$/,
      `Not an installed TotalFinance dist module: ${id}`,
    );
    return id;
  };
  let code: string;
  let retainedModules: ConsumerMeasurement['retainedModules'];
  if (bundler === 'esbuild') {
    const result = await build({
      absWorkingDir: directory,
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      minify: true,
      treeShaking: true,
      legalComments: 'none',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const unexpectedWarnings = result.warnings.filter(
      (warning) => !(fixture.canary === 'unused' && warning.id === 'ignored-bare-import'),
    );
    assert.deepEqual(unexpectedWarnings, [], JSON.stringify(unexpectedWarnings));
    assert.equal(result.outputFiles.length, 1);
    const output = Object.values(result.metafile.outputs)[0]!;
    assert.deepEqual(output.imports, [], 'Browser output must be self-contained');
    // Resolution safety checks may inspect parsed IDs; RETENTION only uses output contributions.
    for (const file of Object.keys(result.metafile.inputs)) {
      if (resolve(directory, file) !== entry) installedId(file);
    }
    retainedModules = Object.entries(output.inputs)
      .filter(([file, info]) => info.bytesInOutput > 0 && resolve(directory, file) !== entry)
      .map(([file, info]) => ({ id: installedId(file), bytes: info.bytesInOutput }));
    code = result.outputFiles[0]!.text;
  } else {
    const circularWarnings: RollupLog[] = [];
    const bundle = await rollup({
      input: entry,
      plugins: [nodeResolve({ browser: true, preferBuiltins: false })],
      onwarn(warning) {
        // The umbrella parses performance's existing sharpe/annualization cycle even when it
        // eliminates that domain. Judge these warnings on retained output, not parsed modules.
        if (warning.code === 'CIRCULAR_DEPENDENCY') {
          circularWarnings.push(warning);
          return;
        }
        throw new Error(`Rollup ${warning.code}: ${warning.message}`);
      },
    });
    try {
      for (const file of bundle.watchFiles) {
        if (file !== entry) installedId(file);
      }
      const result = await bundle.generate({ format: 'iife', generatedCode: 'es2015' });
      assert.equal(result.output.length, 1);
      const chunk = result.output[0]!;
      assert.equal(chunk.type, 'chunk');
      if (chunk.type !== 'chunk') throw new Error('Expected a JavaScript chunk');
      assert.deepEqual(chunk.imports, []);
      assert.deepEqual(chunk.dynamicImports, []);
      for (const warning of circularWarnings) {
        assert.ok(
          warning.ids?.length && warning.ids.every((id) => !chunk.modules[id]?.renderedLength),
          `Rollup retained a circular dependency: ${warning.message}`,
        );
      }
      retainedModules = Object.entries(chunk.modules)
        .filter(([file, info]) => info.renderedLength > 0 && file !== entry)
        .map(([file, info]) => ({ id: installedId(file), bytes: info.renderedLength }));
      code = (
        await transform(chunk.code, { minify: true, target: 'es2022', legalComments: 'none' })
      ).code;
    } finally {
      await bundle.close();
    }
  }
  return {
    fixture: fixture.id,
    bundler,
    bundlerVersion: bundler === 'esbuild' ? esbuildVersion : rollupVersion,
    bytesMin: Buffer.byteLength(code),
    bytesGzip: gzipSync(code).length,
    code,
    retainedModules: retainedModules.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const NO_NODE_GLOBALS = `
for (const name of ['process', 'require', 'Buffer', 'module', 'exports', '__dirname', '__filename', 'global']) {
  if (typeof globalThis[name] !== 'undefined') throw new Error('Node global leaked: ' + name);
}
`;

/** Fresh realm, no host functions or Node globals. Calls/inputs/errors stay INSIDE the browser. */
export function consumerBrowser(measurement: ConsumerMeasurement): Context {
  const context = createContext(Object.create(null) as object, {
    codeGeneration: { strings: false, wasm: false },
  });
  runInContext(NO_NODE_GLOBALS, context, { timeout: 1000 });
  runInContext(measurement.code, context, {
    filename: `${measurement.fixture}-${measurement.bundler}.js`,
    timeout: 5000,
  });
  runInContext(NO_NODE_GLOBALS, context, { timeout: 1000 });
  return context;
}

/** Evaluate JS literals so undefined/NaN/Infinity and realm-native arrays survive the test boundary. */
export function callConsumer(context: Context, inputExpression: string): unknown {
  const result: unknown = runInContext(`consumerCall(${inputExpression})`, context, {
    timeout: 5000,
  });
  assert.notEqual(result, undefined, 'Consumer must return an observable result');
  // Clone into the host realm without injecting a host function into the browser. Unlike JSON
  // sentinels this preserves numeric NaN/±Infinity, -0, undefined and literal strings distinctly.
  // A library returning "NaN" must never satisfy an assertion requiring a numeric warmup slot.
  return structuredClone(result);
}

export interface ConsumerErrorResult {
  typed: boolean;
  code: string;
  context: Record<string, unknown>;
  message: string;
}

export function consumerError(context: Context, inputExpression: string): ConsumerErrorResult {
  const result: unknown = runInContext(
    `(() => {
    try { consumerCall(${inputExpression}); return null; }
    catch (error) { return JSON.stringify({
      typed: error instanceof Error && consumerErrorType(error), code: error.code,
      context: error.context, message: error.message
    }); }
  })()`,
    context,
    { timeout: 5000 },
  );
  assert.equal(typeof result, 'string', `Malformed input was accepted: ${inputExpression}`);
  return JSON.parse(result as string) as ConsumerErrorResult;
}
