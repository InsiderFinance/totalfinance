import 'server-only';
import { computeServer, docsServer, hostedServer, type McpServerSpec } from '@/src/agents';
import { siteVersion } from './data';
import { BASE_PATH, HOSTED_MCP, SITE_ORIGIN } from './site';

/** The current docs' MCP endpoint, even from a version snapshot. */
export const DOCS_MCP_SITE = `${SITE_ORIGIN}${process.env.TOTALFINANCE_DOCS_CANONICAL_BASE ?? BASE_PATH}`;

/** Servers a reader can connect, easiest first: hosted (when it exists), local calculations, docs. */
export function agentServers(): McpServerSpec[] {
  const version = siteVersion();
  const hosted = hostedServer(HOSTED_MCP);
  return [
    ...(hosted ? [hosted] : []),
    computeServer({ published: version.published, version: version.version }),
    docsServer(DOCS_MCP_SITE),
  ];
}
