// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Node built-in modules that must never appear in browser-safe compute packages.
 * TotalFinance design law #5: pure calculation packages do no I/O, env, network, filesystem, or clock.
 */
const NODE_BUILTINS = [
  'node:*',
  'fs',
  'node:fs',
  'path',
  'node:path',
  'os',
  'node:os',
  'http',
  'https',
  'net',
  'crypto',
  'child_process',
  'worker_threads',
];

/** Build a `no-restricted-imports` rule body that forbids a set of package/module patterns. */
function forbid(patterns, message) {
  return [
    'error',
    {
      patterns: patterns.map((pattern) => ({ group: [pattern], message })),
    },
  ];
}

const PURE_MESSAGE =
  'Browser-safe compute packages must not import Node built-ins (TotalFinance design law #5: no I/O, env, network, filesystem, or system clock).';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'docs/api/**',
      'docs/**/*.md',
      'coverage/**',
      'distribution/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // TotalFinance vol-spelling rule, INVERTED by Phase 3B.N. It used to ban `volatility` in favour
      // of `vol` (alignment decision D3). D3 was retracted: `vol` is ambiguous between volatility
      // and volume INSIDE this library, so the long spelling is now the canonical one and the
      // short form is what must not reappear.
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSPropertySignature[key.name='vol']",
          message:
            'Use `volatility` — `vol` is ambiguous (volatility vs volume) and is banned in public interfaces (Phase 3B.N, law N2).',
        },
        {
          selector: "TSPropertySignature[key.name='vols']",
          message:
            'Use `volatilities` — `vols` is ambiguous (volatility vs volume) and is banned in public interfaces (Phase 3B.N, law N2).',
        },
      ],
      // TotalFinance deliberately embeds full-precision scientific constants (distribution and solver
      // coefficients). The "lost" trailing digits are exactly the correctly-rounded IEEE-754 double,
      // which is the intended value — so this rule produces only false positives here.
      'no-loss-of-precision': 'off',
    },
  },

  // ---- Package boundary rules (dependency direction from spec §3) ----

  // core: depends on nothing internal.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid(
        ['@totalfinance/math', '@totalfinance/options', '@totalfinance/mcp', ...NODE_BUILTINS],
        '@totalfinance/core has zero internal/runtime dependencies.',
      ),
    },
  },
  // math: may import core only.
  {
    files: ['packages/math/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid(
        ['@totalfinance/options', '@totalfinance/mcp', ...NODE_BUILTINS],
        '@totalfinance/math may import @totalfinance/core only.',
      ),
    },
  },
  // options: may import core and math. Browser-safe → no Node built-ins.
  {
    files: ['packages/options/**/*.ts'],
    rules: {
      'no-restricted-imports': forbid(['@totalfinance/mcp', ...NODE_BUILTINS], PURE_MESSAGE),
    },
  },
  // mcp: Node package, may import everything and use Node built-ins.

  // Tests, tools, and examples are exempt from the compute-package purity rule.
  {
    files: ['**/test/**/*.ts', 'tools/**/*.ts', 'examples/**/*.ts', 'docs/**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
