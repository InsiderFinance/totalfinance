/**
 * Phase 3B.N8-DOCS item 6 — the MCP guide names the identities the server actually exposes.
 *
 * "Regenerate MCP guides/resources/prompts and prove tool IDs, pack IDs, required arrays,
 * descriptions, examples, error contexts, and output fields use the same canonical identities as the
 * SDK and shared schemas."
 *
 * The MCP guide is hand-authored, which is fine — it explains things a generator cannot. What is not
 * fine is that nothing checked its claims, and three had rotted:
 *
 *   - `totalfinance.crypto.perp_funding` — the tool is `perpetual_funding`. This is the worst kind of
 *     documentation defect: an agent following the guide calls a tool that does not exist. The
 *     `perp` → `perpetual` rename landed in 3B.N and the guide was never touched.
 *   - `totalfinance.technical_analysis.describe` ships in the default server and the guide never
 *     mentioned it, so a third of the TA pack was undiscoverable from the docs.
 *   - the pack id was written `technical-analysis` (it is `technical_analysis`), and the opt-in
 *     paragraph said adding backtest sits "on top of the standard 20" when the default is 23.
 *
 * A tool id is a WIRE identity — an agent types it verbatim — so these gates check exact strings in
 * both directions rather than counts. `technical_analysis.describe` proves why: a count of 23 was
 * correct the whole time the guide named the wrong 23.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultTools, defaultPacks, createTotalFinanceMcpServer } from '@totalfinance/mcp';
import { createMemoryArtifactStore, KNOWN_CAPABILITIES } from '@totalfinance/workflows';
import { REGISTRY_PROFILES, packsForProfile } from '@totalfinance/workflows/local';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listStrategies } from '@totalfinance/strategy';
import { listIndicators } from '@totalfinance/technical-analysis';

const GUIDE = fileURLToPath(new URL('../docs/guides/mcp.md', import.meta.url));
const guide = readFileSync(GUIDE, 'utf8');

/**
 * Tool ids the guide names, in backticks.
 *
 * Pre-publish repairs B1 (2026-09-21): a tool NAME is the operation id with its dots replaced by
 * underscores (`totalfinance_option_price` for `totalfinance.option.price`); the dotted id rides `_meta`.
 * The guide names tools by their wire name, so that is the form this reads.
 */
function namedToolIds(): Set<string> {
  return new Set([...guide.matchAll(/`(totalfinance_[a-z_]+)`/g)].map((match) => match[1]!));
}

async function withFullClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = createTotalFinanceMcpServer({
    profile: 'full',
    readOnly: false,
    capabilities: KNOWN_CAPABILITIES,
    artifacts: createMemoryArtifactStore(),
    jobs: {
      submit: () => {
        throw new Error('Discovery only');
      },
      cancel: () => {
        throw new Error('Discovery only');
      },
      get: () => null,
      list: () => [],
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-doc-conformance', version: '0' });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP guide conformance (3B.N8-DOCS item 6)', () => {
  const tools = defaultTools();
  const packs = defaultPacks();

  it('names every actually configured full-profile and job tool, with no phantom ids', async () =>
    withFullClient(async (client) => {
      const shipped = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const named = namedToolIds();

      const undocumented = [...shipped].filter((id) => !named.has(id)).sort();
      expect(
        undocumented,
        `default tools the MCP guide never names — an agent cannot discover them:\n${undocumented.join('\n')}`,
      ).toEqual([]);

      const phantom = [...named].filter((id) => !shipped.has(id)).sort();
      expect(
        phantom,
        `the guide names tool ids that do not exist. An agent types these verbatim, so a stale id is a ` +
          `broken call, not a typo:\n${phantom.join('\n')}`,
      ).toEqual([]);
    }));

  it('documents every shared task profile and its exact packs', () => {
    for (const profile of REGISTRY_PROFILES) {
      const row = guide
        .split('\n')
        .find((line) => new RegExp(`^\\|\\s*\`${profile}\`\\s*\\|`).test(line));
      expect(row, `${profile} profile missing`).toBeDefined();
      const cells = row!.split('|');
      const namedPacks = [...cells[2]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      if (profile === 'full') {
        expect(cells[2]).toContain('All default packs plus');
        namedPacks.unshift(...packsForProfile('default').map((pack) => pack.name));
      }
      expect(namedPacks).toEqual(packsForProfile(profile).map((pack) => pack.name));
    }
  });

  it('names every pack id exactly', () => {
    const shipped = packs.map((pack: unknown) => (pack as { name: string }).name).sort();
    expect(shipped.length).toBe(10);
    const missing = shipped.filter((id) => !guide.includes(`\`${id}\``));
    expect(
      missing,
      `pack ids the guide does not name, or names in the wrong form (the guide said ` +
        `\`technical-analysis\` for \`technical_analysis\`):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('states the default tool count correctly everywhere it states one', () => {
    // The guide quotes the number in three places; each one is a claim.
    const counts = [...guide.matchAll(/(?:exposes|all|standard)\s+(\d+)\b/g)].map((match) =>
      Number(match[1]),
    );
    expect(counts.length).toBeGreaterThanOrEqual(3);
    for (const count of counts) {
      expect(count, `the guide claims a tool count that is not ${tools.length}`).toBe(tools.length);
    }
  });

  it('describes the preview-gate items exactly (Stage 7A slice 6)', () => {
    // The capabilities resource and the report resources are named; the removed prompt is not.
    expect(guide).toContain('`totalfinance://capabilities`');
    expect(guide).toContain('totalfinance://reports/');
    expect(guide).not.toContain('screen-options-chain');
    // Annotations, instructions, protocol errors, and policy-B error results are each described.
    for (const phrase of [
      'readOnlyHint',
      'instructions',
      'McpError',
      'structuredContent',
      'OperationError',
    ]) {
      expect(guide, `the guide never mentions ${phrase}`).toContain(phrase);
    }
    // The per-call stochastic predicate is described with its example.
    expect(guide).toContain('stochastic only for');
    expect(guide).toContain('totalfinance_risk_value_at_risk');
    // The binary's flags are documented.
    for (const flag of [
      '--profile',
      '--packs',
      '--max-input-bytes',
      '--seed',
      '--deadline-ms',
      '--store',
      '--jobs',
      '--page-size',
      '--store-read-only',
      '--capability',
      'doctor',
    ]) {
      expect(guide, `the guide never documents ${flag}`).toContain(flag);
    }
  });

  it('documents actual grounded prompts, paging limits, grants and not-ready errors', async () =>
    withFullClient(async (client) => {
      for (const prompt of (await client.listPrompts()).prompts)
        expect(guide).toContain(`\`${prompt.name}\``);
      for (const phrase of [
        'nextCursor',
        'InvalidParams',
        'cross-server',
        'cross-catalog',
        '1–100',
        '65,536',
        '16,777,216',
        'input.wrong_shape',
        'operation.cancelled',
        'SDK-only',
        'exact replacement',
        'experimental',
        'totalfinance://profiles',
      ])
        expect(guide).toContain(phrase);
      expect(guide).not.toContain('Cancelled work or a job result requested before completion');
    }));

  it('every pack export it tells the reader to call is real', async () => {
    const mcp = (await import('@totalfinance/mcp')) as unknown as Record<string, unknown>;
    // Not anchored to a backtick pair: the calls the guide actually tells you to make appear inside
    // longer spans, e.g. `createTotalFinanceMcpServer({ packs: [optionsPack(), technicalAnalysisPack()] })`.
    const named = [...guide.matchAll(/\b(\w+Packs?)\(\)/g)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(4);
    for (const exportName of new Set(named)) {
      expect(typeof mcp[exportName], `${exportName}() is documented but not exported`).toBe(
        'function',
      );
    }
  });

  it('every resource URI and prompt it documents is served', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../packages/mcp/src/server.ts', import.meta.url)),
      'utf8',
    );
    // Static resource URIs, and the two templated per-tool ones.
    for (const uri of [
      'totalfinance://schema/bar',
      'totalfinance://schema/option-contract',
      'totalfinance://schema/option-quote',
      'totalfinance://policy/seed',
    ]) {
      expect(
        guide.includes(uri) ? source.includes(uri) : true,
        `${uri} documented but not served`,
      ).toBe(true);
    }
    for (const template of ['schema/tool/', 'policy/seed']) {
      expect(source).toContain(template);
    }
    for (const prompt of ['analyze-option-trade']) {
      expect(guide, `${prompt} is served but undocumented`).toContain(prompt);
      expect(source, `${prompt} is documented but not served`).toContain(prompt);
    }
  });

  it('its approximate catalog sizes are still approximately right', () => {
    // Prose may round ("~58 builders", "~300 indicators"); it may not be stale by a wide margin.
    const builders = listStrategies().length;
    const indicators = listIndicators().length;
    const claimedBuilders = /~(\d+)-builder/.exec(guide);
    const claimedIndicators = /~(\d+) registered indicators/.exec(guide);
    expect(claimedBuilders, 'the guide no longer states a builder count').not.toBeNull();
    expect(claimedIndicators, 'the guide no longer states an indicator count').not.toBeNull();
    expect(Math.abs(Number(claimedBuilders![1]) - builders)).toBeLessThanOrEqual(5);
    expect(Math.abs(Number(claimedIndicators![1]) - indicators) / indicators).toBeLessThanOrEqual(
      0.2,
    );
  });

  it('the tools it documents as stochastic really declare it', () => {
    // The guide promises `totalfinance_risk_value_at_risk` declares `stochastic` and echoes its seed.
    const valueAtRisk = tools.find(
      (tool) => (tool as { name: string }).name === 'totalfinance_risk_value_at_risk',
    ) as { stochastic?: unknown } | undefined;
    expect(valueAtRisk, 'totalfinance_risk_value_at_risk is documented but absent').toBeDefined();
    expect(
      valueAtRisk!.stochastic,
      'the guide says value_at_risk declares `stochastic`; it does not',
    ).toBeDefined();
  });
});
