import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_JOURNEYS, buildLlmsTxt, buildLlmsFullTxt, sdkOnlyNotes } from './llms-docs.js';
import { buildPublicReference, type PublicReference } from './public-reference.js';
import { packsForProfile, REGISTRY_PROFILES } from '../packages/workflows/src/local/profiles.js';

// Drift guard (WS9.7): the committed agent-facing docs must match what the generator produces from
// the live registries, export maps, checker/JSDoc, and operation schemas. Regenerate with
// `pnpm tsx tools/llms-docs.ts` after any public-API change.
describe('WS9.7 agent-facing docs are up to date', () => {
  let reference: PublicReference;
  let concise: string;
  let full: string;
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
  beforeAll(() => {
    reference = buildPublicReference();
    concise = buildLlmsTxt(reference);
    full = buildLlmsFullTxt(reference);
  }, 90_000);

  it('docs/llms.txt matches the generator', () => {
    const committed = readFileSync(
      fileURLToPath(new URL('../docs/llms.txt', import.meta.url)),
      'utf8',
    );
    expect(digest(committed), 'Run pnpm tsx tools/llms-docs.ts').toBe(digest(`${concise}\n`));
  });

  it('docs/llms-full.txt matches the generator', () => {
    const committed = readFileSync(
      fileURLToPath(new URL('../docs/llms-full.txt', import.meta.url)),
      'utf8',
    );
    expect(digest(committed), 'Run pnpm tsx tools/llms-docs.ts').toBe(digest(`${full}\n`));
  });

  it('links the full catalog and all six real journey destinations', () => {
    expect(concise).toContain('](llms-full.txt)');
    expect(AGENT_JOURNEYS).toHaveLength(6);
    for (const journey of AGENT_JOURNEYS) {
      expect(concise).toContain(`](llms-full.txt#journey-${journey.slug})`);
      expect(full).toContain(`## Journey ${journey.slug}\n`);
      expect(
        existsSync(
          fileURLToPath(new URL(`../docs/${journey.guide.split('#')[0]}`, import.meta.url)),
        ),
      ).toBe(true);
    }
    for (const match of concise.matchAll(/\]\(([^)]+)\)/g)) {
      const [path, anchor] = match[1]!.split('#');
      expect(
        existsSync(resolve(fileURLToPath(new URL('../docs', import.meta.url)), path!)),
        path,
      ).toBe(true);
      if (path === 'llms-full.txt' && anchor) {
        const headings = [...full.matchAll(/^## (.+)$/gm)].map((heading) =>
          heading[1]!.toLowerCase().replaceAll(' ', '-'),
        );
        expect(headings).toContain(anchor);
      }
    }
  });

  it('contains all full-profile operations with exact complete input/output schemas and notes', () => {
    const sections = new Map(
      full
        .split('\n### ')
        .slice(1)
        .map((section) => {
          const newline = section.indexOf('\n');
          return [section.slice(0, newline), section.slice(newline)];
        }),
    );
    const expected = packsForProfile('full').flatMap((pack) =>
      pack.operations.map((operation) => operation.id),
    );
    const ids = [...sections.keys()].filter((id) => /^totalfinance\.[a-z_]+\.[a-z_]+$/.test(id));
    expect(ids.sort()).toEqual(expected.sort());
    for (const operation of reference.operations) {
      const section = sections.get(operation.id)!;
      const schemas = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
        JSON.parse(match[1]!),
      );
      expect(schemas).toEqual([operation.inputSchema, operation.outputSchema]);
      expect(section).toContain(`Cost: ${operation.costClass}`);
      expect(section).toContain(`defaultEnabled: ${operation.defaultEnabled}`);
      expect(section).toContain(`Authorization: ${operation.authorization}`);
      expect(section).toContain(`Side effect: ${operation.sideEffect}`);
      for (const field of [
        ...operation.requiredCapabilities,
        ...operation.handleFields,
        ...operation.profiles,
      ])
        expect(section).toContain(field);
      for (const note of sdkOnlyNotes(operation))
        expect(section).toContain(`SDK-only limitation: ${note}`);
    }
  });

  it('includes every package entrypoint and export identity, including reexports and types', () => {
    const headings = new Set([...full.matchAll(/^### (.+)$/gm)].map((match) => match[1]));
    for (const entry of reference.entries) expect(headings.has(entry.id), entry.id).toBe(true);
    for (const pkg of reference.packages)
      for (const entrypoint of pkg.entrypoints)
        expect(full).toContain(`## Entrypoint ${entrypoint}\n`);
    const references = [
      ...full.matchAll(/Same declaration, documentation, members and stability as `([^`]+)`/g),
    ].map((match) => match[1]);
    for (const target of references) expect(headings.has(target), target).toBe(true);
  });

  it('discloses default vs opt-in/write scope, SDK-only limits, profiles, and release boundaries', () => {
    for (const profile of REGISTRY_PROFILES) expect(full).toContain(`### Profile ${profile}\n`);
    expect(full).toContain('full profile selects all registered packs but grants no capabilities');
    expect(full).toContain('readOnly: false');
    expect(full).toContain('A sideEffect of none does not imply no permission requirement');
    expect(full).toContain('Paper trading is local simulation');
    expect(full).toContain('totalfinance://capabilities');
    expect(full).toContain('totalfinance.job.result');
    expect(full).toContain('custom engines are not universally exposed by MCP');
    expect(full).toContain('not evidence of npm publication');
    expect(full).toContain('Published-package smoke: pending release');
    expect(full).toContain('follow nextCursor until absent');
    expect(full).toContain('not declared; optional never implies zero');
    expect(full).not.toContain('Every result is deterministic');
  });

  it('renders missing JSDoc defaults as not declared and preserves declared zero/false values', () => {
    const single: PublicReference = {
      ...reference,
      entries: [
        {
          id: '@fixture#Input',
          package: reference.packages[0]!.name,
          entrypoint: reference.packages[0]!.entrypoints[0]!,
          name: 'Input',
          kind: 'interface',
          signature: 'interface Input { unknown?: number; zero?: number; flag?: boolean }',
          description: '',
          examples: [],
          tags: [],
          stability: 'preview',
          members: [
            {
              name: 'unknown',
              type: 'number',
              optional: true,
              description: '',
              defaultValue: null,
            },
            { name: 'zero', type: 'number', optional: true, description: '', defaultValue: '0' },
            {
              name: 'flag',
              type: 'boolean',
              optional: true,
              description: '',
              defaultValue: 'false',
            },
          ],
        },
      ],
    };
    const rendered = buildLlmsFullTxt(single);
    expect(rendered).toContain('unknown?: number; default: not declared');
    expect(rendered).toContain('zero?: number; default: 0');
    expect(rendered).toContain('flag?: boolean; default: false');
  });

  it('renders deterministically and never discloses the build machine path', () => {
    expect(digest(buildLlmsTxt(reference))).toBe(digest(concise));
    expect(digest(buildLlmsFullTxt(reference))).toBe(digest(full));
    for (const value of [concise, full]) {
      expect(value).not.toContain(fileURLToPath(new URL('../', import.meta.url)));
      expect(value).not.toContain(homedir());
    }
  }, 90_000);
});
