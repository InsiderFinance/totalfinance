/**
 * Data contracts between the build-time generator (`site/scripts/generate.ts`, run with the
 * repository's TypeScript toolchain) and the Next.js renderer. Framework-free on purpose: the
 * renderer only reads these JSON shapes; it never imports repository internals.
 */

/** A public domain: one top-level subpath of the umbrella package (or the MCP package). */
export interface DomainSummary {
  slug: string;
  title: string;
  summary: string;
  entrypoints: EntrypointSummary[];
}

export interface EntrypointSummary {
  specifier: string;
  package: string;
  /** Site route without base path or slashes, e.g. `reference/totalfinance/options`. */
  path: string;
  exportCount: number;
  /** Counts by declaration kind, for the entry-point card. */
  kinds: Record<string, number>;
}

export interface ReferenceIndex {
  packages: {
    name: string;
    version: string;
    description: string;
    stability: string;
    entrypoints: string[];
  }[];
  domains: DomainSummary[];
  /** Every rendered reference route (entry pages, continuation pages, member pages). */
  routes: ReferenceRoute[];
  totals: { packages: number; entrypoints: number; exportPaths: number; operations: number };
}

export interface ReferenceRoute {
  path: string;
  /** JSON file under `.generated/reference/` holding the page data. */
  file: string;
  kind: 'entrypoint';
}

export interface MemberView {
  name: string;
  type: string;
  description: string;
  optional: boolean;
  /** Only an explicit JSDoc @default/@defaultValue; null means not declared. */
  defaultValue: string | null;
  /** Unit implied by the field name, or 'unitless by name'. */
  unit: string;
}

export interface ReferenceEntryView {
  id: string;
  name: string;
  kind: string;
  signature: string;
  description: string;
  examples: string[];
  tags: { name: string; text: string }[];
  stability: string;
  memberCount: number;
  /**
   * Inline members for small contracts; null for larger ones, which the page loads on demand from
   * the entry point's JSON contract (`EntrypointPageData.contract`).
   */
  members: MemberView[] | null;
}

export interface ExportLink {
  name: string;
  kind: string;
  url: string;
  summary: string;
}

export interface EntrypointPageData {
  kind: 'entrypoint';
  path: string;
  entrypoint: string;
  package: string;
  domain: string;
  stability: string;
  chunk: number;
  chunks: string[];
  /** Every export of the entry point (all chunks), for the overview grid. */
  exports: ExportLink[];
  entries: ReferenceEntryView[];
  empty: boolean;
  /** Base-path-relative URL of the entry point's complete JSON contract (all members). */
  contract: string;
}

export type ReferencePageData = EntrypointPageData;

export interface OperationView {
  id: string;
  /** The tool name the MCP server registers for this operation. */
  mcpToolName: string;
  title: string;
  description: string;
  pack: string;
  profiles: string[];
  defaultEnabled: boolean;
  requiredCapabilities: string[];
  sideEffect: string;
  authorization: string;
  costClass: string;
  supportsCancellation: boolean;
  handleFields: string[];
  idempotency: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface AgentProfileView {
  profile: string;
  packs: string[];
  operations: number;
}

/** Navigation for the Guide tab, derived from content files plus generated guides. */
export interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface NavItem {
  title: string;
  url: string;
  badge?: string;
}
