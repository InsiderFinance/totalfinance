import { transform } from 'sucrase';
import { describe, expect, it } from 'vitest';
import { displayValue } from '../src/display';
import { firstCallCode } from '../src/examples';
import { playgrounds } from '../src/playgrounds/index';
import { defaultInput } from '../src/playgrounds/inputs';
import {
  compileFailure,
  describeFailure,
  formatArguments,
  formatValue,
  rewriteImports,
  RunnerError,
  userLine,
} from '../src/runner/protocol';

const IMPORTS = {
  '@insiderfinance/totalfinance': 'https://docs.example/runtime/pkg/index-A.js',
  '@insiderfinance/totalfinance/options': 'https://docs.example/runtime/pkg/options-B.js',
  '@insiderfinance/totalfinance/options/batch':
    'https://docs.example/runtime/pkg/options/batch-C.js',
};
const NODE_ONLY = ['@insiderfinance/totalfinance/cli'];

/** The worker's compile step: Sucrase strips types without moving a line. */
const compile = (code: string) =>
  transform(code, { transforms: ['typescript'], disableESTransforms: true }).code;

function refusal(source: string): RunnerError {
  try {
    rewriteImports(source, IMPORTS, NODE_ONLY);
  } catch (error) {
    if (error instanceof RunnerError) return error;
    throw error;
  }
  throw new Error(`Expected a refusal for: ${source}`);
}

describe('runner imports', () => {
  it('points every public import form at the docs bundles', () => {
    const source = [
      "import { blackScholes } from '@insiderfinance/totalfinance/options';",
      'import * as tf from "@insiderfinance/totalfinance";',
      "import {\n  blackScholesEvaluateManyInto,\n} from '@insiderfinance/totalfinance/options/batch';",
      "export { blackScholes as bs } from '@insiderfinance/totalfinance/options';",
      "import '@insiderfinance/totalfinance';",
      "const lazy = await import('@insiderfinance/totalfinance/options');",
    ].join('\n');
    const rewritten = rewriteImports(source, IMPORTS, NODE_ONLY);
    expect(rewritten).not.toContain("'@insiderfinance");
    expect(rewritten).not.toContain('"@insiderfinance');
    expect(rewritten).toContain("from 'https://docs.example/runtime/pkg/options-B.js'");
    expect(rewritten).toContain('from "https://docs.example/runtime/pkg/index-A.js"');
    expect(rewritten).toContain("import('https://docs.example/runtime/pkg/options-B.js')");
    expect(rewritten.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('leaves code that merely mentions import alone', () => {
    const source = "const label = 'imported';\nconsole.log(import.meta.url, label);";
    expect(rewriteImports(source, IMPORTS)).toBe(source);
  });

  it('refuses anything that is not a public entry point, with the line', () => {
    expect(refusal("import x from 'left-pad';").message).toMatch(
      /Only @insiderfinance\/totalfinance/,
    );
    expect(refusal("\n\nimport x from './local.js';").line).toBe(3);
    expect(refusal("import x from 'https://evil.example/x.js';").phase).toBe('import');
    expect(refusal("import { y } from '@insiderfinance/totalfinance/private';").message).toMatch(
      /not a public entry point/,
    );
    expect(refusal("import { run } from '@insiderfinance/totalfinance/cli';").message).toMatch(
      /Node-only/,
    );
    expect(refusal('const m = await import(`https://evil.example/${1}`);').message).toMatch(
      /needs a literal/,
    );
    expect(refusal("const name = 'x';\nawait import(name);").line).toBe(2);
  });
});

describe('runner output', () => {
  it('prints plain data exactly like the page output, NaN and infinities included', () => {
    const value = {
      price: 2.39,
      greeks: { delta: 0.37, values: [1, 2, NaN, Infinity, -Infinity] },
      empty: [],
      nothing: {},
      label: 'call',
      flag: true,
      none: null,
    };
    expect(formatValue(value)).toBe(displayValue(value));
    // Regression: the page output once showed NaN as "\u0000NaN\u0000".
    expect(displayValue([NaN, Infinity, -Infinity])).toBe('[\n  NaN,\n  Infinity,\n  -Infinity\n]');
  });

  it('labels values JSON cannot hold instead of dropping them', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(formatValue(cyclic)).toContain('"self": [Circular]');
    expect(formatValue({ id: 10n, missing: undefined })).toBe(
      '{\n  "id": 10n,\n  "missing": undefined\n}',
    );
    expect(formatValue(new Map([['a', 1]]))).toBe('Map(1) {\n  "a" => 1\n}');
    expect(formatValue(new Set([1]))).toBe('Set(1) [\n  1\n]');
    expect(formatValue(new Float64Array([0.5]))).toBe('Float64Array(1) [\n  0.5\n]');
    expect(formatValue(function price() {})).toBe('[Function price]');
    expect(formatValue(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(formatArguments(['Price:', 2.5, 'USD'])).toBe('Price: 2.5 USD');
  });

  it('describes TotalFinance errors with their code, context and line', () => {
    const error = Object.assign(new Error('spot must be positive'), {
      name: 'InputError',
      code: 'input.negative_spot',
      context: { spot: -1 },
      stack: 'InputError: spot must be positive\n    at blob:null/1234-abcd:7:15',
    });
    expect(describeFailure(error, 'runtime', 'blob:null/1234-abcd')).toEqual({
      phase: 'runtime',
      name: 'InputError',
      message: 'spot must be positive',
      code: 'input.negative_spot',
      context: '{\n  "spot": -1\n}',
      line: 7,
    });
    expect(userLine('at https://docs.example/runtime/pkg/options-B.js:1:200', 'blob:null/x')).toBe(
      undefined,
    );
    expect(describeFailure('plain', 'runtime')).toEqual({
      phase: 'runtime',
      name: 'Thrown value',
      message: 'plain',
    });
  });

  it('reports a compile error with its line', () => {
    let failure;
    try {
      compile('const a = 1;\nconst b = ;');
    } catch (error) {
      failure = compileFailure(error);
    }
    expect(failure).toMatchObject({ phase: 'compile', name: 'SyntaxError', line: 2 });
  });
});

describe('every calculator first call', () => {
  it.each(playgrounds.map((playground) => [playground.id, playground] as const))(
    '%s compiles in the browser runner with its imports resolved and its lines kept',
    (_id, playground) => {
      const program = firstCallCode(playground.run(defaultInput(playground)));
      const javascript = compile(program);
      expect(javascript.split('\n').length).toBe(program.split('\n').length);
      const specifiers = [...javascript.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      expect(specifiers.length).toBeGreaterThan(0);
      const imports = Object.fromEntries(
        specifiers.map((s) => [s, `https://docs.example/${s}.js`]),
      );
      const rewritten = rewriteImports(javascript, imports);
      expect(rewritten).not.toMatch(/from\s*['"]@insiderfinance/);
    },
  );
});
