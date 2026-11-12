/**
 * Public guides stay single-sourced in the repository (`docs/guides/*.md` and a few root
 * documents). This module turns each into a generated Markdown page for the site: front matter from
 * its heading and first paragraph, repository links rewritten to site routes, and links to files
 * that are not public pages reduced to their text (provenance, not a disguised navigation target).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface GuideSource {
  /** Repository-relative source path. */
  source: string;
  /** Site route without slashes. */
  route: string;
  /** Optional title override (otherwise the source's first heading). */
  title?: string;
  group: 'start' | 'guides' | 'agents';
}

export interface GeneratedGuide extends GuideSource {
  title: string;
  description: string;
  /** Markdown body without its first heading. */
  body: string;
  /** Mentions an install/run command whose availability depends on publication. */
  installs: boolean;
}

export function guideSources(root: string): GuideSource[] {
  const guides = readdirSync(join(root, 'docs/guides'))
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map<GuideSource>((file) => ({
      source: `docs/guides/${file}`,
      route: `guides/${file.slice(0, -3)}`,
      group: 'guides',
    }));
  return [
    {
      source: 'site/content/start.md',
      route: 'start/quickstart',
      title: 'Quickstart',
      group: 'start',
    },
    { source: 'site/content/agents.md', route: 'agents/handbook', group: 'agents' },
    { source: 'docs/getting-started.md', route: 'guides/getting-started', group: 'guides' },
    ...guides,
    { source: 'docs/stability.md', route: 'guides/stability', group: 'guides' },
    { source: 'docs/bundle-size.md', route: 'guides/bundle-size', group: 'guides' },
    { source: 'SECURITY.md', route: 'guides/security', group: 'guides' },
  ];
}

/** Plain text of a Markdown fragment (for titles, descriptions and search). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed || /^(#|```|\||-|\*|\d+\.|<|>)/.test(trimmed)) continue;
    const text = plainText(trimmed);
    if (text.length >= 40) return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
  }
  return '';
}

/**
 * Apply `transform` to Markdown prose only: fenced code blocks and inline code spans are copied
 * through untouched.
 */
export function mapProse(markdown: string, transform: (prose: string) => string): string {
  const parts = markdown.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .split(/(`+[^`\n]*`+)/)
        .map((segment, segmentIndex) => (segmentIndex % 2 === 1 ? segment : transform(segment)))
        .join('');
    })
    .join('');
}

export function rewriteLinks(
  markdown: string,
  source: string,
  routes: ReadonlyMap<string, string>,
): string {
  return mapProse(markdown, (prose) =>
    prose.replace(
      /(!?)\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
      (match, bang: string, text: string, href: string, title: string) => {
        if (bang || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
        const [file = '', fragment] = href.split('#');
        const resolved = posix.normalize(posix.join(posix.dirname(source), file));
        const target = resolved === 'STABILITY.md' ? 'guides/stability' : routes.get(resolved);
        if (target) return `[${text}](/${target}${fragment ? `#${fragment}` : ''}${title})`;
        // A repository test/spec reference is provenance, not a public learning target.
        return text;
      },
    ),
  );
}

export function generateGuides(root: string): GeneratedGuide[] {
  const sources = guideSources(root);
  const routes = new Map(sources.map((guide) => [guide.source, guide.route]));
  return sources.map((guide) => {
    const raw = readFileSync(join(root, guide.source), 'utf8').replace(/\r\n/g, '\n');
    const heading = /^# (.+)$/m.exec(raw);
    const sourceTitle = heading ? plainText(heading[1]!) : guide.route;
    const withoutHeading = heading ? raw.replace(heading[0], '').replace(/^\s+/, '') : raw;
    const body = rewriteLinks(withoutHeading, guide.source, routes);
    return {
      ...guide,
      title: guide.title ?? sourceTitle,
      description: firstParagraph(body),
      body,
      installs: /\b(?:pnpm add|npm (?:i|install)|yarn add|npx\b|pnpm dlx)/.test(raw),
    };
  });
}

const yamlString = (value: string): string => JSON.stringify(value);

export function guideFile(guide: GeneratedGuide): string {
  return [
    '---',
    `title: ${yamlString(guide.title)}`,
    `description: ${yamlString(guide.description)}`,
    `source: ${yamlString(guide.source)}`,
    `installs: ${guide.installs}`,
    '# Generated by site/scripts/generate.ts. Edit the source document, not this file.',
    '---',
    '',
    guide.body.trimEnd(),
    '',
  ].join('\n');
}
