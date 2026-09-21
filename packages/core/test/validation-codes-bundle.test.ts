import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import * as ValidationCode from '../src/validation-codes.js';

/** Source-level regression for the private split; installed-package budgets live in tooling. */
async function bundle(contents: string): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL('../src', import.meta.url)) },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    globalName: 'probe',
    minify: true,
  });
  return result.outputFiles[0]!.text;
}

describe('guard-only error code retention', () => {
  it('drops unrelated codes while retaining guards and the same error classes', async () => {
    const output = await bundle(`
      export { ensureFinite, requireFiniteFields } from './invariants.ts';
      export { facade, assertFiniteValue } from './facade.ts';
      export { InputError, QuantError, PostconditionError, wrongShapeError } from './errors.ts';
    `);
    for (const [key, code] of Object.entries(ErrorCode)) {
      if (!(key in ValidationCode)) expect(output).not.toContain(code);
    }
    // Run without Node globals. Test instanceof within the bundle's own class identity.
    runInNewContext(
      `${output}
      function refuses(run, ErrorClass, code) {
        try { run(); } catch (error) {
          if (!(error instanceof ErrorClass) || !(error instanceof probe.QuantError) ||
              error.code !== code || error.toJSON().code !== code) throw error;
          return;
        }
        throw new Error('guard was eliminated');
      }
      refuses(() => probe.ensureFinite(NaN, 'spot', 'probe'), probe.InputError, ${JSON.stringify(ErrorCode.InputNaN)});
      refuses(() => probe.requireFiniteFields('probe', {}, ['spot'], { exampleCall: 'probe({ spot: 100 })' }), probe.InputError, ${JSON.stringify(ErrorCode.InputMissingField)});
      refuses(() => { throw probe.wrongShapeError('probe', '{ spot }', {}); }, probe.InputError, ${JSON.stringify(ErrorCode.InputWrongShape)});
      refuses(() => probe.assertFiniteValue('probe', Infinity), probe.PostconditionError, ${JSON.stringify(ErrorCode.PostconditionNonFinite)});
      const guarded = probe.facade('probe', () => 1, () => ({ value: 1, assumptions: {}, diagnostics: {} }));
      refuses(() => guarded(null), probe.InputError, ${JSON.stringify(ErrorCode.InputWrongType)});
      if (guarded({}) !== 1) throw new Error('valid call changed');
    `,
      {},
      { timeout: 1000 },
    );
  });

  it('keeps the entire registry when a consumer enumerates it', async () => {
    const output = await bundle("export { ErrorCode } from './errors.ts';");
    for (const code of Object.values(ErrorCode)) expect(output).toContain(code);
    expect(runInNewContext(`${output}; JSON.stringify(probe.ErrorCode)`)).toBe(
      JSON.stringify(ErrorCode),
    );
  });

  it('emits no code for an unused registry import', async () => {
    const output = await bundle("import { ErrorCode } from './errors.ts';");
    expect(output).not.toContain('input.');
    expect(output).not.toContain('class');
    expect(output.length).toBeLessThan(30);
  });
});
