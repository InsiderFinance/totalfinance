import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentProfileView,
  OperationView,
  ReferenceIndex,
  ReferencePageData,
} from '@/src/site-data';
import type { GitHubStats } from '@/src/github';
import type { SiteVersion } from '@/version-types';

/**
 * Build-time readers for `site/.generated` (written by `site/scripts/generate.ts`). Each file is
 * read once per build worker and cached; pages never import repository internals.
 */
const GENERATED = join(process.cwd(), '.generated');
const cache = new Map<string, unknown>();

function read<T>(file: string): T {
  if (!cache.has(file)) {
    try {
      cache.set(file, JSON.parse(readFileSync(join(GENERATED, file), 'utf8')));
    } catch (error) {
      throw new Error(
        `Missing generated site data ${file}. Run \`pnpm site:build\` (or \`pnpm tsx site/scripts/generate.ts\`) first.`,
        { cause: error },
      );
    }
  }
  return cache.get(file) as T;
}

export const siteVersion = (): SiteVersion => read<SiteVersion>('version.json');

/** Star count read at build time; optional, so a dev server without it shows no count. */
export function githubStats(): GitHubStats {
  try {
    return read<GitHubStats>('github.json');
  } catch {
    return { stars: null, fetchedAt: null };
  }
}
export const referenceIndex = (): ReferenceIndex => read<ReferenceIndex>('reference-index.json');
export const operations = (): OperationView[] => read<OperationView[]>('operations.json');
export const agentProfiles = (): AgentProfileView[] =>
  read<AgentProfileView[]>('agent-profiles.json');
export const generatedGuides = () =>
  read<
    {
      route: string;
      title: string;
      description: string;
      group: string;
      source: string;
      installs: boolean;
    }[]
  >('guides.json');

export function referencePage(path: string): ReferencePageData | null {
  const route = referenceIndex().routes.find((candidate) => candidate.path === path);
  if (!route) return null;
  // Page data is large; do not keep every page in memory across a build worker.
  return JSON.parse(
    readFileSync(join(GENERATED, 'reference', route.file), 'utf8'),
  ) as ReferencePageData;
}
