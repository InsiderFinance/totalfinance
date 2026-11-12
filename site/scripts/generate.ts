/**
 * Prebuild generation for the documentation site. Runs with the repository toolchain (tsx + root
 * tsconfig paths) BEFORE `next build`, and writes only git-ignored outputs:
 *
 *   site/.generated/          data the renderer reads at build time (reference pages, nav, version)
 *   site/content/generated/   Markdown pages generated from the repository's public guides
 *   site/public/generated/    machine-readable artifacts served verbatim (search, catalogs, JSON)
 *
 * The renderer never imports repository internals; everything it needs crosses this boundary as JSON.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY_PROFILES, packsForProfile } from '../../packages/workflows/src/local/profiles.js';
import { toolNameFor } from '../../packages/mcp/src/tool-kit.js';
import { buildPublicReference, type PublicReference } from '../../tools/public-reference.js';
import { playgrounds } from '../src/playgrounds/index.js';
import type { SearchRecord } from '../src/search.js';
import type { AgentProfileView, OperationView } from '../src/site-data.js';
import { readSiteVersion, type SiteVersion } from '../version.js';
import { generateGuides, guideFile, plainText, type GeneratedGuide } from './guides.js';
import { generateReference, memberView, type GeneratedReference } from './reference.js';

export const SITE = fileURLToPath(new URL('..', import.meta.url));
export const ROOT = join(SITE, '..');
export const GENERATED = join(SITE, '.generated');
export const GENERATED_CONTENT = join(SITE, 'content/generated');
/** Generated files served verbatim; they sit beside authored public files and are git-ignored by name. */
export const GENERATED_PUBLIC = join(SITE, 'public');
export const AUTHORED_CONTENT = join(SITE, 'content/docs');
/** Everything generate() writes into public/, so it can remove exactly its own output. */
export const GENERATED_PUBLIC_PATHS = [
  'search-index.json',
  'operation-catalog.json',
  'openapi.json',
  'version.json',
  'reference-coverage.json',
  'reference',
  'agents/operations',
];

function writeJson(path: string, value: unknown, pretty = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
}

/** Minimal front matter reader for authored MDX (`key: value` lines; JSON-quoted strings allowed). */
export function readFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    const raw = field[2]!.trim();
    data[field[1]!] = raw.startsWith('"')
      ? (JSON.parse(raw) as string)
      : raw.replace(/^'(.*)'$/, '$1');
  }
  return { data, body: source.slice(match[0].length) };
}

export interface AuthoredPage {
  /** Site route without slashes ('' for the docs root). */
  route: string;
  file: string;
  title: string;
  description: string;
  playground?: string;
  text: string;
}

export function readAuthoredPages(directory = AUTHORED_CONTENT): AuthoredPage[] {
  const pages: AuthoredPage[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (/\.mdx?$/.test(name.name)) {
        const { data, body } = readFrontmatter(readFileSync(path, 'utf8'));
        const relativePath = relative(directory, path)
          .replaceAll('\\', '/')
          .replace(/\.mdx?$/, '');
        const route = relativePath.replace(/(^|\/)index$/, '');
        if (!data['title'])
          throw new Error(`${relative(ROOT, path)} needs a title in its front matter.`);
        pages.push({
          route,
          file: relative(ROOT, path),
          title: data['title'],
          description: data['description'] ?? '',
          ...(data['playground'] ? { playground: data['playground'] } : {}),
          // Strip JSX/import lines so search sees prose, not component syntax.
          text: plainText(body.replace(/^(?:import|export) .*$/gm, '').replace(/<[^>\n]+>/g, ' ')),
        });
      }
    }
  };
  if (existsSync(directory)) walk(directory);
  return pages.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

export function searchRecordsFor(
  reference: GeneratedReference,
  guides: readonly GeneratedGuide[],
  authored: readonly AuthoredPage[],
  operations: readonly OperationView[],
): SearchRecord[] {
  const records: SearchRecord[] = [];
  const taskRoutes = new Set<string>();
  for (const playground of playgrounds) {
    taskRoutes.add(`learn/${playground.id}`);
    records.push({
      title: playground.title,
      url: `/learn/${playground.id}`,
      description: playground.introduction,
      category: 'Runnable task',
      keywords: playground.id,
      kind: 'task',
    });
  }
  for (const page of authored) {
    if (taskRoutes.has(page.route)) continue;
    records.push({
      title: page.title,
      url: page.route ? `/${page.route}` : '/',
      description: page.description || page.text.slice(0, 200),
      category: 'Guide',
      keywords: page.text.slice(0, 20000),
      kind: 'guide',
    });
  }
  for (const guide of guides)
    records.push({
      title: guide.title,
      url: `/${guide.route}`,
      description: guide.description,
      category: 'Guide',
      keywords: guide.body.replace(/```[\s\S]*?```/g, '').slice(0, 20000),
      kind: 'guide',
    });
  records.push(...reference.searchRecords);
  for (const operation of operations)
    records.push({
      title: operation.id,
      url: `/agents/operations/${operation.id}`,
      description: operation.description,
      category: 'MCP / CLI / HTTP operation',
      keywords: `${operation.title} ${operation.pack} ${operation.profiles.join(' ')}`,
      kind: 'operation',
    });
  return records;
}

export interface GenerateResult {
  version: SiteVersion;
  reference: GeneratedReference;
  publicReference: PublicReference;
  guides: GeneratedGuide[];
  authored: AuthoredPage[];
  operations: OperationView[];
  searchRecords: SearchRecord[];
}

export function generate(): GenerateResult {
  for (const directory of [GENERATED, GENERATED_CONTENT])
    rmSync(directory, { recursive: true, force: true });
  for (const path of GENERATED_PUBLIC_PATHS)
    rmSync(join(GENERATED_PUBLIC, path), { recursive: true, force: true });
  mkdirSync(GENERATED, { recursive: true });

  const version = readSiteVersion(ROOT);
  writeJson(join(GENERATED, 'version.json'), version, true);

  const publicReference = buildPublicReference();
  const reference = generateReference(publicReference);
  writeJson(join(GENERATED, 'reference-index.json'), reference.index);
  for (const route of reference.index.routes)
    writeJson(join(GENERATED, 'reference', route.file), reference.pages.get(route.path));

  const operations: OperationView[] = publicReference.operations.map((operation) => ({
    id: operation.id,
    mcpToolName: toolNameFor(operation.id),
    title: operation.title,
    description: operation.description,
    pack: operation.pack,
    profiles: operation.profiles,
    defaultEnabled: operation.defaultEnabled,
    requiredCapabilities: [...operation.requiredCapabilities],
    sideEffect: operation.sideEffect,
    authorization: operation.authorization,
    costClass: operation.costClass,
    supportsCancellation: operation.supportsCancellation,
    handleFields: [...operation.handleFields],
    idempotency: operation.idempotency,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
  }));
  writeJson(join(GENERATED, 'operations.json'), operations);
  const profiles: AgentProfileView[] = REGISTRY_PROFILES.map((profile) => {
    const packs = packsForProfile(profile);
    return {
      profile,
      packs: packs.map((pack) => pack.name),
      operations: packs.reduce((count, pack) => count + pack.operations.length, 0),
    };
  });
  writeJson(join(GENERATED, 'agent-profiles.json'), profiles, true);

  const guides = generateGuides(ROOT);
  for (const guide of guides) {
    const file = join(
      GENERATED_CONTENT,
      guide.group === 'agents' ? `${guide.route}/index.md` : `${guide.route}.md`,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, guideFile(guide));
  }
  writeJson(
    join(GENERATED, 'guides.json'),
    guides.map(({ body: _body, ...guide }) => guide),
    true,
  );

  const authored = readAuthoredPages();
  const searchRecords = searchRecordsFor(reference, guides, authored, operations);
  const urls = new Set<string>();
  for (const record of searchRecords)
    if (record.kind === 'task' || record.kind === 'guide') {
      if (urls.has(record.url)) throw new Error(`Two search records claim ${record.url}.`);
      urls.add(record.url);
    }

  writeJson(join(GENERATED_PUBLIC, 'search-index.json'), searchRecords);
  writeJson(join(GENERATED_PUBLIC, 'operation-catalog.json'), publicReference.operations);
  for (const operation of operations)
    writeJson(join(GENERATED_PUBLIC, 'agents/operations', `${operation.id}.json`), {
      id: operation.id,
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
    });
  cpSync(join(ROOT, 'packages/http/etc/openapi.json'), join(GENERATED_PUBLIC, 'openapi.json'));
  writeJson(join(GENERATED_PUBLIC, 'version.json'), version, true);
  writeJson(join(GENERATED_PUBLIC, 'reference-coverage.json'), {
    packages: publicReference.packages.map((pkg) => ({
      package: pkg.name,
      entrypoints: pkg.entrypoints,
    })),
    exportPaths: publicReference.entries.map((entry) => ({
      id: entry.id,
      url: reference.exportUrls.get(entry.id)!,
    })),
  });
  // JSON contracts: one complete, machine-readable document per reference entry point, with every
  // member. Reference pages load large member tables from here on demand.
  const byEntrypoint = new Map<string, typeof publicReference.entries>();
  for (const entry of publicReference.entries) {
    const list = byEntrypoint.get(entry.entrypoint) ?? [];
    list.push(entry);
    byEntrypoint.set(entry.entrypoint, list);
  }
  for (const page of reference.pages.values())
    if (page.chunk === 0)
      writeJson(join(GENERATED_PUBLIC, `${page.path}.json`), {
        entrypoint: page.entrypoint,
        package: page.package,
        domain: page.domain,
        stability: page.stability,
        url: `/${page.path}`,
        exports: (byEntrypoint.get(page.entrypoint) ?? []).map((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          url: reference.exportUrls.get(entry.id)!,
          signature: entry.signature,
          description: entry.description,
          examples: entry.examples,
          tags: entry.tags,
          stability: entry.stability,
          members: entry.members.map(memberView),
        })),
      });

  return { version, reference, publicReference, guides, authored, operations, searchRecords };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = Date.now();
  const result = generate();
  console.log(
    `Generated ${result.reference.index.routes.length} reference routes, ${result.guides.length} guides, ` +
      `${result.searchRecords.length} search records in ${Date.now() - started} ms.`,
  );
}
