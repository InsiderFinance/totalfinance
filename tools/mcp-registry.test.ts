import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_JSON, mcpServerJsonText } from './assemble-distribution.js';
import { MCP_PACKAGE_NAME, MCP_REGISTRY_NAME } from './public-packages.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('MCP Registry metadata', () => {
  const manifest = JSON.parse(read('distribution/mcp/package.json')) as {
    version: string;
    mcpName?: string;
  };
  const server = JSON.parse(read(MCP_SERVER_JSON)) as {
    name: string;
    description: string;
    version: string;
    packages: { registryType: string; identifier: string; version: string; transport: unknown }[];
  };

  it('ships the ownership field the registry verifies in every npm version', () => {
    expect(manifest.mcpName).toBe(MCP_REGISTRY_NAME);
    expect(server.name).toBe(manifest.mcpName);
  });

  it('describes exactly the npm package version it is released with', () => {
    expect(read(MCP_SERVER_JSON)).toBe(mcpServerJsonText(manifest.version));
    expect(server.version).toBe(manifest.version);
    expect(server.packages).toEqual([
      {
        registryType: 'npm',
        identifier: MCP_PACKAGE_NAME,
        version: manifest.version,
        transport: { type: 'stdio' },
      },
    ]);
  });

  it('meets the registry schema limits that a validator would reject', () => {
    // server.schema.json 2025-12-11: name pattern, description at most 100 characters.
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.name.startsWith('io.github.InsiderFinance/')).toBe(true);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
