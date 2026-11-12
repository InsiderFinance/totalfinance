/**
 * Bounded reference pages from the generated public reference. Export maps own discovery; the
 * TypeScript checker and JSDoc own declarations. Every export path keeps a stable URL and anchor.
 */
import { unitByName } from '../../tools/fields-doc.js';
import { MCP_PACKAGE_NAME } from '../../tools/public-packages.js';
import type { PublicReference, ReferenceEntry } from '../../tools/public-reference.js';
import { DOMAINS, domainBySlug } from '../src/domains.js';
import type { SearchRecord } from '../src/search.js';
import type {
  DomainSummary,
  ExportLink,
  MemberView,
  ReferenceEntryView,
  ReferenceIndex,
  ReferencePageData,
} from '../src/site-data.js';

/** Contracts up to this many members render inline (and open); larger ones load from the JSON contract. */
export const INLINE_MEMBER_LIMIT = 12;
/** An entry-point page holds at most this many declarations / serialized bytes. */
const ENTRY_PAGE_ENTRIES = 20;
const ENTRY_PAGE_BYTES = 45_000;

/**
 * `reference/totalfinance` for a package root, `reference/totalfinance/options` for a subpath. No
 * route ends in `/index`: static hosts with clean URLs redirect `/x/index` to `/x`.
 */
export const referencePath = (entry: Pick<ReferenceEntry, 'package' | 'entrypoint'>): string => {
  const subpath = entry.entrypoint.slice(entry.package.length).replace(/^\//, '');
  return `reference/${entry.package === MCP_PACKAGE_NAME ? 'mcp' : 'totalfinance'}${
    subpath ? `/${subpath}` : ''
  }`;
};

export function domainOf(pkg: string, entrypoint: string): string {
  if (pkg === MCP_PACKAGE_NAME) return 'mcp';
  return entrypoint.slice(pkg.length).split('/')[1] ?? 'index';
}

export const memberView = (member: ReferenceEntry['members'][number]): MemberView => ({
  ...member,
  unit: unitByName(member.name.split('.').at(-1) ?? member.name),
});

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

function stripFence(example: string): string {
  return example.replace(/^```(?:ts|typescript)?\s*\n?|\n?```\s*$/g, '');
}

/** First sentence-ish summary for cards and search. */
export function summaryOf(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const sentence = /^(.{20,220}?[.!?])(?:\s|$)/.exec(text)?.[1];
  return sentence ?? (text.length > 220 ? `${text.slice(0, 217)}…` : text);
}

export interface GeneratedReference {
  index: ReferenceIndex;
  pages: Map<string, ReferencePageData>;
  /** Export id -> URL (route plus anchor), every export path. */
  exportUrls: Map<string, string>;
  searchRecords: SearchRecord[];
}

export function generateReference(reference: PublicReference): GeneratedReference {
  const pages = new Map<string, ReferencePageData>();
  const exportUrls = new Map<string, string>();
  const grouped = new Map<string, ReferenceEntry[]>();
  for (const entry of reference.entries) {
    const path = referencePath(entry);
    const list = grouped.get(path) ?? [];
    list.push(entry);
    grouped.set(path, list);
  }

  const routes: ReferenceIndex['routes'] = [];
  const addPage = (data: ReferencePageData) => {
    if (pages.has(data.path)) throw new Error(`Duplicate reference route: ${data.path}`);
    pages.set(data.path, data);
    routes.push({
      path: data.path,
      file: `${String(routes.length).padStart(5, '0')}.json`,
      kind: data.kind,
    });
  };

  const views = new Map<string, ReferenceEntryView>();
  for (const [path, entries] of grouped) {
    for (const entry of entries) {
      const members = entry.members.map(memberView);
      views.set(entry.id, {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        signature: entry.signature,
        description: entry.description,
        examples: entry.examples.map(stripFence),
        tags: entry.tags.filter(
          (tag) => !['example', 'default', 'defaultValue'].includes(tag.name),
        ),
        stability: entry.stability,
        memberCount: members.length,
        members: members.length <= INLINE_MEMBER_LIMIT ? members : null,
      });
    }

    // Bounded static pages: large roots must not force a multi-megabyte download to read one export.
    const chunks: ReferenceEntry[][] = [];
    let current: ReferenceEntry[] = [];
    let currentBytes = 0;
    for (const entry of entries) {
      const bytes = size(views.get(entry.id));
      if (
        current.length &&
        (current.length >= ENTRY_PAGE_ENTRIES || currentBytes + bytes > ENTRY_PAGE_BYTES)
      ) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(entry);
      currentBytes += bytes;
    }
    if (current.length) chunks.push(current);
    const chunkPaths = chunks.map((_chunk, index) => (index ? `${path}/page-${index + 1}` : path));
    chunks.forEach((chunk, index) => {
      for (const entry of chunk)
        exportUrls.set(entry.id, `/${chunkPaths[index]}#${encodeURIComponent(entry.name)}`);
    });
    const exports: ExportLink[] = entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      url: exportUrls.get(entry.id)!,
      summary: summaryOf(entry.description),
    }));
    const first = entries[0]!;
    chunks.forEach((chunk, index) => {
      addPage({
        kind: 'entrypoint',
        path: chunkPaths[index]!,
        entrypoint: first.entrypoint,
        package: first.package,
        domain: domainOf(first.package, first.entrypoint),
        stability: first.stability,
        chunk: index,
        chunks: chunkPaths,
        exports,
        entries: chunk.map((entry) => views.get(entry.id)!),
        empty: false,
        contract: `/${path}.json`,
      });
    });
  }

  // Export maps, not a curated menu, own complete entry-point coverage (including empty ones).
  for (const pkg of reference.packages)
    for (const entrypoint of pkg.entrypoints) {
      const path = referencePath({ package: pkg.name, entrypoint });
      if (!pages.has(path))
        addPage({
          kind: 'entrypoint',
          path,
          entrypoint,
          package: pkg.name,
          domain: domainOf(pkg.name, entrypoint),
          stability: pkg.stability,
          chunk: 0,
          chunks: [path],
          exports: [],
          entries: [],
          empty: true,
          contract: `/${path}.json`,
        });
    }

  const domains: DomainSummary[] = [];
  const bySlug = new Map<string, DomainSummary>();
  for (const pkg of reference.packages)
    for (const entrypoint of pkg.entrypoints) {
      const slug = domainOf(pkg.name, entrypoint);
      const authored = domainBySlug.get(slug);
      if (!authored)
        throw new Error(
          `Entry point ${entrypoint} belongs to domain "${slug}", which has no authored title in site/src/domains.ts.`,
        );
      let domain = bySlug.get(slug);
      if (!domain) {
        domain = { ...authored, entrypoints: [] };
        bySlug.set(slug, domain);
      }
      const path = referencePath({ package: pkg.name, entrypoint });
      const entries = grouped.get(path) ?? [];
      const kinds: Record<string, number> = {};
      for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
      domain.entrypoints.push({
        specifier: entrypoint,
        package: pkg.name,
        path,
        exportCount: entries.length,
        kinds,
      });
    }
  for (const authored of DOMAINS) {
    const domain = bySlug.get(authored.slug);
    if (domain) {
      // Domain root first, then feature subpaths alphabetically.
      domain.entrypoints.sort(
        (a, b) =>
          a.specifier.split('/').length - b.specifier.split('/').length ||
          (a.specifier < b.specifier ? -1 : 1),
      );
      domains.push(domain);
    }
  }

  const searchRecords: SearchRecord[] = [];
  const referenceSearch = new Map<string, SearchRecord>();
  for (const [, entries] of grouped)
    for (const entry of entries) {
      // Re-exports share a search hit only when name, package AND full signature agree. Every
      // import path stays indexed as a keyword and keeps its independent reference page.
      const key = JSON.stringify([entry.package, entry.name, entry.signature]);
      const previous = referenceSearch.get(key);
      if (previous) {
        if (!previous.keywords.includes(entry.entrypoint))
          previous.keywords += ` ${entry.entrypoint}`;
        if (previous.category === entry.package && entry.entrypoint !== entry.package) {
          previous.url = exportUrls.get(entry.id)!;
          previous.category = entry.entrypoint;
        }
      } else
        referenceSearch.set(key, {
          title: entry.name,
          url: exportUrls.get(entry.id)!,
          description: entry.description.slice(0, 160) || `${entry.kind} from ${entry.entrypoint}`,
          category: entry.entrypoint,
          kind: entry.kind,
          keywords: `${entry.entrypoint} ${entry.kind} ${entry.tags
            .map((tag) => tag.text)
            .join(' ')
            .slice(0, 100)} ${entry.members
            .map((member) => member.name)
            .join(' ')
            .slice(0, 140)}`,
        });
    }
  searchRecords.push(...referenceSearch.values());
  for (const pkg of reference.packages)
    for (const entrypoint of pkg.entrypoints)
      searchRecords.push({
        title: entrypoint,
        url: `/${referencePath({ package: pkg.name, entrypoint })}`,
        description: `Public import: ${entrypoint}. Browse its complete export contracts.`,
        category: pkg.name,
        keywords: entrypoint,
        kind: 'entrypoint',
      });

  const index: ReferenceIndex = {
    packages: reference.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      stability: pkg.stability,
      entrypoints: pkg.entrypoints,
    })),
    domains,
    routes,
    totals: {
      packages: reference.packages.length,
      entrypoints: reference.packages.reduce((count, pkg) => count + pkg.entrypoints.length, 0),
      exportPaths: reference.entries.length,
      operations: reference.operations.length,
    },
  };
  return { index, pages, exportUrls, searchRecords };
}
