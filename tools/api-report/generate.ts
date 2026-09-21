import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Packages whose public API we snapshot, in dependency order. */
export const API_PACKAGES = [
  'core',
  'fundamentals',
  'valuation',
  'research',
  'foreign-exchange',
  'commodities',
  'crypto',
  'calendars',
  'math',
  'performance',
  'portfolio',
  'risk',
  'scenarios',
  'backtest',
  'options',
  'volatility',
  'structure',
  'technical-analysis',
  'strategy',
  'fixed-income',
  'workflows',
  'cli',
  'http',
  'mcp',
  'totalfinance',
] as const;
export type ApiPackage = (typeof API_PACKAGES)[number];

/** The published identity comes from package metadata, not its directory or an assumed scope. */
export function packageNameFor(pkg: ApiPackage): string {
  const metadata = JSON.parse(
    readFileSync(resolve(ROOT, `packages/${pkg}/package.json`), 'utf8'),
  ) as { name: string };
  return metadata.name;
}

const SOURCE_PATHS: Record<string, string[]> = {
  '@totalfinance/core': ['packages/core/src/index.ts'],
  '@totalfinance/core/*': ['packages/core/src/*'],
  '@totalfinance/fundamentals': ['packages/fundamentals/src/index.ts'],
  '@totalfinance/fundamentals/*': ['packages/fundamentals/src/*'],
  '@totalfinance/valuation': ['packages/valuation/src/index.ts'],
  '@totalfinance/valuation/*': ['packages/valuation/src/*'],
  '@totalfinance/research': ['packages/research/src/index.ts'],
  '@totalfinance/research/*': ['packages/research/src/*'],
  '@totalfinance/foreign-exchange': ['packages/foreign-exchange/src/index.ts'],
  '@totalfinance/foreign-exchange/*': ['packages/foreign-exchange/src/*'],
  '@totalfinance/commodities': ['packages/commodities/src/index.ts'],
  '@totalfinance/commodities/*': ['packages/commodities/src/*'],
  '@totalfinance/crypto': ['packages/crypto/src/index.ts'],
  '@totalfinance/crypto/*': ['packages/crypto/src/*'],
  '@totalfinance/calendars': ['packages/calendars/src/index.ts'],
  '@totalfinance/calendars/*': ['packages/calendars/src/*'],
  '@totalfinance/performance': ['packages/performance/src/index.ts'],
  '@totalfinance/performance/*': ['packages/performance/src/*'],
  '@totalfinance/portfolio': ['packages/portfolio/src/index.ts'],
  '@totalfinance/portfolio/*': ['packages/portfolio/src/*'],
  '@totalfinance/risk': ['packages/risk/src/index.ts'],
  '@totalfinance/risk/*': ['packages/risk/src/*'],
  '@totalfinance/scenarios': ['packages/scenarios/src/index.ts'],
  '@totalfinance/scenarios/*': ['packages/scenarios/src/*'],
  '@totalfinance/backtest': ['packages/backtest/src/index.ts'],
  '@totalfinance/backtest/*': ['packages/backtest/src/*'],
  '@totalfinance/technical-analysis': ['packages/technical-analysis/src/index.ts'],
  '@totalfinance/technical-analysis/*': ['packages/technical-analysis/src/*'],
  '@totalfinance/strategy': ['packages/strategy/src/index.ts'],
  '@totalfinance/strategy/*': ['packages/strategy/src/*'],
  '@totalfinance/fixed-income': ['packages/fixed-income/src/index.ts'],
  '@totalfinance/fixed-income/*': ['packages/fixed-income/src/*'],
  '@totalfinance/math': ['packages/math/src/index.ts'],
  '@totalfinance/math/*': ['packages/math/src/*'],
  '@totalfinance/options': ['packages/options/src/index.ts'],
  '@totalfinance/options/*': ['packages/options/src/*'],
  '@totalfinance/volatility': ['packages/volatility/src/index.ts'],
  '@totalfinance/volatility/*': ['packages/volatility/src/*'],
  '@totalfinance/structure': ['packages/structure/src/index.ts'],
  '@totalfinance/structure/*': ['packages/structure/src/*'],
  '@totalfinance/workflows': ['packages/workflows/src/index.ts'],
  '@totalfinance/workflows/local': ['packages/workflows/src/local/index.ts'],
  '@totalfinance/workflows/*': ['packages/workflows/src/*'],
  '@totalfinance/cli': ['packages/cli/src/index.ts'],
  '@totalfinance/cli/*': ['packages/cli/src/*'],
  '@totalfinance/http': ['packages/http/src/index.ts'],
  '@totalfinance/http/*': ['packages/http/src/*'],
  '@totalfinance/mcp': ['packages/mcp/src/index.ts'],
  '@totalfinance/mcp/*': ['packages/mcp/src/*'],
  totalfinance: ['packages/totalfinance/src/index.ts'],
};

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.WriteArrayAsGenericType |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

function entryFor(pkg: ApiPackage): string {
  return resolve(ROOT, `packages/${pkg}/src/index.ts`);
}

function reportPathFor(pkg: ApiPackage): string {
  return resolve(ROOT, `packages/${pkg}/etc/${pkg}.api.md`);
}

/**
 * Strip machine-specific `import("/abs/path").Name` wrappers the checker emits for cross-module
 * types, leaving deterministic bare type names so the committed snapshot is portable across machines.
 */
function normalizeTypeString(s: string): string {
  return s
    .replace(/import\("[^"]*"\)\./g, '')
    .replace(/import\("[^"]*"\)/g, '')
    .split(ROOT)
    .join('');
}

function kindLabel(flags: ts.SymbolFlags): string {
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & (ts.SymbolFlags.Module | ts.SymbolFlags.NamespaceModule)) return 'namespace';
  if (flags & ts.SymbolFlags.Variable) return 'const';
  return 'value';
}

function renderSymbol(checker: ts.TypeChecker, exportName: string, original: ts.Symbol): string {
  const flags = original.flags;
  const label = kindLabel(flags);
  const decl = original.declarations?.[0];

  const isTypeOnly =
    !!(flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) &&
    !(flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class));

  let typeString: string;
  if (isTypeOnly) {
    const t = checker.getDeclaredTypeOfSymbol(original);
    typeString = checker.typeToString(t, decl, TYPE_FORMAT_FLAGS);
  } else if (decl) {
    const t = checker.getTypeOfSymbolAtLocation(original, decl);
    typeString = checker.typeToString(t, decl, TYPE_FORMAT_FLAGS);
  } else {
    typeString = 'unknown';
  }

  return `- \`${label} ${exportName}\`: ${normalizeTypeString(typeString)}`.trimEnd();
}

/** Generate the API-report markdown for a single package, or `null` if its source is absent. */
export function generateReport(pkg: ApiPackage): string | null {
  const entry = entryFor(pkg);
  if (!existsSync(entry)) return null;

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    baseUrl: ROOT,
    paths: SOURCE_PATHS,
    types: [],
  };

  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) throw new Error(`Could not load ${entry}`);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    // A file with no module-level exports surfaces as no module symbol.
    return `# ${packageNameFor(pkg)} — public API\n\n_No exports._\n`;
  }

  const exports = checker.getExportsOfModule(moduleSymbol);
  const lines = exports
    .map((sym) => {
      const original = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      return renderSymbol(checker, sym.name, original);
    })
    .sort((a, b) => a.localeCompare(b));

  return [
    `# ${packageNameFor(pkg)} — public API`,
    '',
    '> Generated by `tools/api-report`. Do not edit by hand. Run `pnpm api:update` after intentional',
    '> public API changes; `pnpm api:check` fails on undocumented drift.',
    '',
    `## Exports (${exports.length})`,
    '',
    ...lines,
    '',
  ].join('\n');
}

export interface ApiCheckResult {
  pkg: ApiPackage;
  status: 'ok' | 'drift' | 'missing-snapshot' | 'skipped';
  expectedPath: string;
}

export function checkReports(): ApiCheckResult[] {
  const results: ApiCheckResult[] = [];
  for (const pkg of API_PACKAGES) {
    const generated = generateReport(pkg);
    const expectedPath = reportPathFor(pkg);
    if (generated === null) {
      results.push({ pkg, status: 'skipped', expectedPath });
      continue;
    }
    if (!existsSync(expectedPath)) {
      results.push({ pkg, status: 'missing-snapshot', expectedPath });
      continue;
    }
    const onDisk = readFileSync(expectedPath, 'utf8');
    results.push({
      pkg,
      status: onDisk.trim() === generated.trim() ? 'ok' : 'drift',
      expectedPath,
    });
  }
  return results;
}

export function writeReports(): ApiPackage[] {
  const written: ApiPackage[] = [];
  for (const pkg of API_PACKAGES) {
    const generated = generateReport(pkg);
    if (generated === null) continue;
    const out = reportPathFor(pkg);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, generated, 'utf8');
    written.push(pkg);
  }
  return written;
}
