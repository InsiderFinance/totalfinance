/** Public distribution identities; private source workspace aliases are not npm products. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PUBLIC_PACKAGE_NAME = '@insiderfinance/totalfinance';
export const MCP_PACKAGE_NAME = '@insiderfinance/totalfinance-mcp';
/**
 * The MCP server's name in the official MCP Registry. The npm package's `mcpName` must equal it:
 * that is how the registry verifies the package belongs to this server.
 */
export const MCP_REGISTRY_NAME = 'io.github.InsiderFinance/totalfinance';

/**
 * The MCP Registry `server.json` for one released version. The registry stores only this metadata,
 * so it is published with `mcp-publisher` after the npm package (docs/runbooks/release.md).
 */
export function mcpRegistryServer(version: string): Record<string, unknown> {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: MCP_REGISTRY_NAME,
    title: 'TotalFinance',
    description:
      'Finance calculations for AI agents: options, Greeks, strategies, indicators, portfolio and risk.',
    repository: {
      url: 'https://github.com/InsiderFinance/totalfinance',
      source: 'github',
      subfolder: 'distribution/mcp',
    },
    websiteUrl: 'https://www.totalfinance.io/docs/totalfinance/agents',
    version,
    packages: [
      { registryType: 'npm', identifier: MCP_PACKAGE_NAME, version, transport: { type: 'stdio' } },
    ],
  };
}

export function toPublicSpecifier(specifier: string): string {
  if (specifier === 'totalfinance') return PUBLIC_PACKAGE_NAME;
  if (specifier.startsWith('totalfinance/'))
    return `${PUBLIC_PACKAGE_NAME}${specifier.slice('totalfinance'.length)}`;
  if (specifier === '@totalfinance/mcp') return MCP_PACKAGE_NAME;
  if (specifier.startsWith('@totalfinance/mcp/'))
    return `${MCP_PACKAGE_NAME}${specifier.slice('@totalfinance/mcp'.length)}`;
  if (specifier.startsWith('@totalfinance/'))
    return `${PUBLIC_PACKAGE_NAME}/${specifier.slice('@totalfinance/'.length)}`;
  return specifier;
}

export function publicPackageDirectories(root: string): {
  dir: string;
  name: string;
  path: string;
}[] {
  return [
    {
      dir: 'totalfinance',
      name: PUBLIC_PACKAGE_NAME,
      path: resolve(root, 'distribution/totalfinance'),
    },
    { dir: 'mcp', name: MCP_PACKAGE_NAME, path: resolve(root, 'distribution/mcp') },
  ];
}

export interface SourcePackage {
  dir: string;
  name: string;
  version: string;
  private?: boolean;
  exports: Record<string, string | { types: string; import: string; default: string }>;
  dependencies?: Record<string, string>;
  files: string[];
}

export function sourcePackages(root: string): SourcePackage[] {
  return readdirSync(join(root, 'packages'))
    .sort()
    .map(
      (dir) =>
        ({
          ...JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')),
          dir,
        }) as SourcePackage,
    );
}

/** Actual export-map targets, including aliases whose names differ from their filenames. */
export function publicSourcePaths(root: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const pkg of sourcePackages(root)) {
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue;
      if (pkg.dir === 'totalfinance' && key !== '.' && key !== './data') continue;
      const name = toPublicSpecifier(pkg.name + (key === '.' ? '' : key.slice(1)));
      result[name] = [
        `./packages/${pkg.dir}/${target.types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts')}`,
      ];
    }
  }
  return result;
}
