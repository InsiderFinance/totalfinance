/**
 * TS1/TS3: used-function consumers, NOT the whole-entrypoint budgets in budgets.ts.
 * This is the enforcing record for generated documentation as well as packed-consumer.test.ts.
 * Budgets are minified gzip KiB (1024 bytes). Runtime test code is never charged to a calculation.
 */
export const CONSUMER_BUNDLERS = ['esbuild', 'rollup'] as const;
export type ConsumerBundler = (typeof CONSUMER_BUNDLERS)[number];
export type ConsumerCanary =
  | 'normal'
  | 'rsi'
  | 'facade'
  | 'expert'
  | 'expert-black76'
  | 'expert-bachelier'
  | 'unused'
  | 'dynamic';

export interface ConsumerFixture {
  id: string;
  canary: ConsumerCanary;
  specifier: string;
  style: string;
  source: string;
  budgetKiB: Record<ConsumerBundler, number>;
  /** Public feature fixture with which portable import forms must agree. */
  parityWith?: string;
  /** Re-exported root namespaces have coarse esbuild boundaries, lean Rollup boundaries. */
  rootNamespace?: boolean;
  reason: string;
}

/** Identifier allocation/compression may differ across otherwise equivalent barrels. */
export const CONSUMER_IMPORT_TOLERANCE_BYTES = 96;

const NAMESPACE_REASON =
  'Root re-exported namespaces can retain a whole domain in esbuild ' +
  '(https://github.com/evanw/esbuild/issues/1420). Enforce an honest coarse-domain ceiling ' +
  'and no unrelated domains there; Rollup must remain equivalent to the feature import. ' +
  'This is a supported passing consumer, not an expected-failure exception.';

// Installed Node 22.23.2 measurements after the reviewed wrapper/code-registry repair:
// esbuild normal 497 B, facade 12025 B, expert models 2338/2257/2243 B; Rollup facade 7606 B.
// After restoring leaf-local TA contracts, lean RSI is 8846–8873 B esbuild / 8670–8690 B Rollup.
// Its 9 KiB ceiling leaves 343 B above the largest installed sample, paying for real defaults,
// closed-key validation and convention disclosures, not unrelated indicator metadata.
// Leave small, explicit headroom without admitting the old 11.7 KiB kernels.
// Selective Greeks (2026-10-01): the facade namespace gained delta, gamma, theta, vega, rho and
// evaluate (each with .explain) and their shared kernel (bsm-evaluate.js). Installed Node 22.23.2
// measurements 13783–13787 B esbuild / 9356 B Rollup; a namespace object cannot shed members, so
// a blackScholes.call consumer pays for them. 12 → 13.75 KiB esbuild, 8 → 9.5 KiB Rollup.
// 0.1.2 speed (2026-10-05): the gamma-only row loop, remembered expiry-label parses and the
// path-on-hit finiteness walk add about 280 B to the facade (13.9 KiB esbuild); 13.75 → 14 KiB.
// Numerical repairs #19/#23 (2026-11-11), installed Node 22.23.2, esbuild 0.25.12:
// facade ~14.3 KiB, root namespace ~96.3 KiB; Rollup facade ~9.9 KiB.
// Expert BSM/Black76 are 5025/4918 B esbuild and 2666/2591 B Rollup. The required
// registered ErrorCode reference retains the catalog in esbuild; keep code-registry
// conformance and record that cost without adding a new public error API.
// Bachelier remains 2242/2227 B. Only the exact shared analytic-premium module is
// admitted for BSM/Black76; unrelated-module exclusions and all validation checks remain binding.
// PR32 review corrections (2026-11-11), installed canonical Node 22.23.2:
// esbuild expert BSM/Black76 5475/5338 B; facade 15347–15348 B; coarse facade 99609 B.
// Rollup expert 3106/2999 B, facade 10835 B. Positive Gaussian tail evaluation,
// field-specific precision errors and IV diagnostics account for the growth. Ceilings
// leave at least 94 B headroom; exact retained-module exclusions are unchanged.
// Second review corrections: 5566/5441 B esbuild expert, 3196/3103 B Rollup expert;
// facade 15555–15558/11046 B and coarse esbuild facade 99976 B. Reusing logarithms
// offsets part of the intrinsic-sensitivity guard and explanatory-IV-message cost.
// Facade ceilings become 15.375/11 KiB; expert Rollup 3.25/3.125 KiB, coarse 97.75.
// Expert esbuild remains 5.5 KiB (66 B above the largest measured consumer).
const leanBudgets = {
  normal: 0.6,
  rsi: 9,
  facade: 15.375,
  expert: 3.25,
  'expert-black76': 3.125,
  'expert-bachelier': 2.5,
} as const;
// Actual esbuild root namespaces: 41508/105191/95468 B. These are coarse DOMAIN budgets,
// not permission to pull unrelated packages. Rollup keeps the ordinary lean consumer budgets.
// 0.1.3 canonical installed measurement: RSI root namespace 105586 B gzip (esbuild).
// The explicit OHLCV adapter and its validation add 395 B; leaf RSI remains under 9 KiB.
// Raise only the coarse TA ceiling to 103.25 KiB; unrelated-domain exclusions remain binding.
// Review repair: the installed root namespace is 105817 B gzip on canonical Node 22.23.2.
// Single-symbol/time and optional-metadata validation add 231 B; only this coarse ceiling moves
// from 103.25 to 103.5 KiB. Leaf RSI and every unrelated-domain exclusion remain unchanged.
const coarseBudgets = { normal: 42, rsi: 103.5, facade: 97.75 } as const;

function calculation(
  canary: Exclude<ConsumerCanary, 'unused' | 'dynamic'>,
  style: string,
  specifier: string,
  binding: string,
  member: string,
  rootNamespace = false,
): ConsumerFixture {
  const arguments_ = canary === 'rsi' ? 'input.values, input.parameters' : 'input';
  const id = `${canary}-${style}`;
  const reason = rootNamespace
    ? NAMESPACE_REASON
    : canary === 'rsi'
      ? "RSI includes leaf-local defaults, closed-key validation and convention disclosures, aligned series, diagnostics and serializable streaming; not a bare formula. Other indicators' metadata must be eliminated."
      : canary === 'facade'
        ? 'The BSM facade retains its validated callable/explain API, assumptions and diagnostics.'
        : canary.startsWith('expert')
          ? 'The expert kernel requires every financial input (including dividendYield for BSM) and keeps typed boundary validation. Expert exports exist only on the model subpath.'
          : 'A single normal CDF calculation must not retain other math features or any other domain.';
  return {
    id,
    canary,
    specifier,
    style,
    source: `import ${binding} from '${specifier}';\nglobalThis.consumerCall = (input) => ${member}(${arguments_});\n`,
    budgetKiB: {
      esbuild:
        canary === 'expert' || canary === 'expert-black76'
          ? 5.5
          : rootNamespace
            ? coarseBudgets[canary as keyof typeof coarseBudgets]
            : leanBudgets[canary],
      rollup: canary === 'facade' ? 11 : leanBudgets[canary],
    },
    ...(style === 'feature' ? {} : { parityWith: `${canary}-feature` }),
    ...(rootNamespace ? { rootNamespace: true } : {}),
    reason,
  };
}

function domainFixtures(
  canary: 'normal' | 'rsi' | 'facade',
  domain: string,
  feature: string,
  name: string,
  namespace: string,
  suffix = '',
): ConsumerFixture[] {
  return [
    calculation(
      canary,
      'feature',
      `@insiderfinance/totalfinance/${domain}/${feature}`,
      `{ ${name} }`,
      name + suffix,
    ),
    calculation(
      canary,
      'domain',
      `@insiderfinance/totalfinance/${domain}`,
      `{ ${name} }`,
      name + suffix,
    ),
    calculation(
      canary,
      'domain-static-star',
      `@insiderfinance/totalfinance/${domain}`,
      '* as domain',
      `domain.${name}${suffix}`,
    ),
    calculation(
      canary,
      'feature-static-star',
      `@insiderfinance/totalfinance/${domain}/${feature}`,
      '* as domain',
      `domain.${name}${suffix}`,
    ),
    calculation(
      canary,
      'root-namespace',
      '@insiderfinance/totalfinance',
      `{ ${namespace} }`,
      `${namespace}.${name}${suffix}`,
      true,
    ),
  ];
}

export const CONSUMER_FIXTURES: readonly ConsumerFixture[] = [
  ...domainFixtures('normal', 'math', 'normal', 'normalCdf', 'math'),
  ...domainFixtures('rsi', 'technical-analysis', 'rsi', 'rsi', 'technicalAnalysis'),
  ...domainFixtures('facade', 'options', 'black-scholes', 'blackScholes', 'options', '.call'),
  calculation(
    'facade',
    'root-hoist',
    '@insiderfinance/totalfinance',
    '{ blackScholes }',
    'blackScholes.call',
  ),
  calculation(
    'expert',
    'feature',
    '@insiderfinance/totalfinance/options/black-scholes',
    '{ blackScholesPrice }',
    'blackScholesPrice',
  ),
  calculation(
    'expert',
    'feature-static-star',
    '@insiderfinance/totalfinance/options/black-scholes',
    '* as model',
    'model.blackScholesPrice',
  ),
  calculation(
    'expert-black76',
    'feature',
    '@insiderfinance/totalfinance/options/black76',
    '{ black76Price }',
    'black76Price',
  ),
  calculation(
    'expert-black76',
    'feature-static-star',
    '@insiderfinance/totalfinance/options/black76',
    '* as model',
    'model.black76Price',
  ),
  calculation(
    'expert-bachelier',
    'feature',
    '@insiderfinance/totalfinance/options/bachelier',
    '{ bachelierPrice }',
    'bachelierPrice',
  ),
  calculation(
    'expert-bachelier',
    'feature-static-star',
    '@insiderfinance/totalfinance/options/bachelier',
    '* as model',
    'model.bachelierPrice',
  ),
  {
    id: 'unused-library',
    canary: 'unused',
    specifier: '@insiderfinance/totalfinance',
    style: 'unused',
    source: `import * as unused from '@insiderfinance/totalfinance';
import '@insiderfinance/totalfinance';
import '@insiderfinance/totalfinance/options/black-scholes';
import '@insiderfinance/totalfinance/technical-analysis/rsi';
globalThis.consumerCall = () => 42;
`,
    budgetKiB: { esbuild: 0.12, rollup: 0.12 },
    reason:
      'Unused bindings and side-effect-only imports must retain zero library modules using installed sideEffects metadata.',
  },
  {
    id: 'dynamic-math-namespace',
    canary: 'dynamic',
    specifier: '@insiderfinance/totalfinance/math',
    style: 'dynamic-and-enumeration',
    source: `import * as domain from '@insiderfinance/totalfinance/math';
globalThis.consumerCall = (input) => ({ value: domain[input.key](input.value), keys: Object.keys(domain).sort() });
`,
    budgetKiB: { esbuild: 43, rollup: 43 },
    reason:
      'Positive retention control: runtime-selected members plus enumeration need the math namespace. Both bundlers must retain multiple math features but no unrelated domains.',
  },
];

export const CONSUMER_VALID_INPUTS = {
  normal: 1,
  rsi: { values: [100, 102, 101, 104, 103, 106], parameters: { period: 3 } },
  facade: {
    spot: 100,
    strike: 105,
    timeToExpiryYears: 30 / 365,
    riskFreeRate: 0.045,
    volatility: 0.22,
  },
  expert: {
    type: 'call',
    spot: 100,
    strike: 105,
    timeToExpiryYears: 30 / 365,
    riskFreeRate: 0.045,
    volatility: 0.22,
    dividendYield: 0,
  },
  'expert-black76': {
    type: 'call',
    forward: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0,
    volatility: 0.2,
  },
  'expert-bachelier': {
    type: 'call',
    forward: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0,
    normalVolatility: 20,
  },
  unused: null,
  dynamic: { key: 'normalCdf', value: 1 },
} as const;

export const CONSUMER_EXPECTED_PRICES = {
  facade: 0.8983963669668142,
  expert: 0.8983963669668142,
  'expert-black76': 7.965567455405804,
  'expert-bachelier': 7.978845608028655,
} as const;

/** Module identities refer to retained installed dist, never parsed source/workspace graphs. */
export function allowedConsumerModule(
  fixture: ConsumerFixture,
  bundler: ConsumerBundler,
  id: string,
): boolean {
  if (fixture.canary === 'unused') return false;
  const coarse = fixture.canary === 'dynamic' || (fixture.rootNamespace && bundler === 'esbuild');
  if (coarse) {
    const domains =
      fixture.canary === 'rsi'
        ? 'core|technical-analysis'
        : fixture.canary === 'facade'
          ? 'core|math|options'
          : 'core|math';
    return new RegExp(
      `^@insiderfinance/totalfinance/modules/(?:${domains}|totalfinance)/dist/`,
    ).test(id);
  }
  if (fixture.canary === 'normal')
    return id === '@insiderfinance/totalfinance/modules/math/dist/normal.js';
  // Schema/transport/artifact infrastructure is never part of a lean calculation's error handling.
  if (/^@insiderfinance\/totalfinance\/modules\/core\/dist\//.test(id))
    return !/(?:schema|artifacts|serialization)/.test(id);
  if (fixture.canary === 'rsi') {
    return /^@insiderfinance\/totalfinance\/modules\/technical-analysis\/dist\/(?:rsi|framework|validate|limits|snapshot-envelope|builtin-metadata|indicator-metadata)\.js$/.test(
      id,
    );
  }
  if (fixture.canary === 'expert') {
    // esbuild can retain the model module's tiny key-array construction even when the entire
    // facade is eliminated. Tests cap that residue; forbidding the whole source file is false.
    return (
      id === '@insiderfinance/totalfinance/modules/options/dist/analytic-premium.js' ||
      id === '@insiderfinance/totalfinance/modules/options/dist/bsm.js' ||
      id === '@insiderfinance/totalfinance/modules/math/dist/normal.js' ||
      id === '@insiderfinance/totalfinance/modules/options/dist/black-scholes.js'
    );
  }
  if (fixture.canary === 'expert-black76' || fixture.canary === 'expert-bachelier') {
    const model = fixture.canary.slice('expert-'.length);
    return (
      (fixture.canary === 'expert-black76' &&
        id === '@insiderfinance/totalfinance/modules/options/dist/analytic-premium.js') ||
      id === `@insiderfinance/totalfinance/modules/options/dist/${model}.js` ||
      id === '@insiderfinance/totalfinance/modules/math/dist/normal.js'
    );
  }
  // The facade namespace carries its selective members (delta…rho, evaluate) and their one kernel.
  return (
    /^@insiderfinance\/totalfinance\/modules\/options\/dist\/(?:black-scholes|bsm|bsm-evaluate|facade-util|analytic-premium)\.js$/.test(
      id,
    ) ||
    /^@insiderfinance\/totalfinance\/modules\/math\/dist\/(?:normal|solvers|resource-validation)\.js$/.test(
      id,
    )
  );
}
