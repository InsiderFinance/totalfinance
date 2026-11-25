import 'server-only';
import {
  MCP_PUBLISHED_ON_NPM,
  computeServer,
  docsServer,
  hostedServer,
  type McpServerSpec,
} from '@/src/agents';
import { siteVersion } from './data';
import { BASE_PATH, HOSTED_MCP, SITE_ORIGIN } from './site';

/** The docs' own MCP endpoint. */
export const DOCS_MCP_SITE = `${SITE_ORIGIN}${BASE_PATH}`;

/** Servers a reader can connect, easiest first: hosted (when it exists), local calculations, docs. */
export function agentServers(): McpServerSpec[] {
  const version = siteVersion();
  const hosted = hostedServer(HOSTED_MCP);
  return [
    ...(hosted ? [hosted] : []),
    computeServer({ published: MCP_PUBLISHED_ON_NPM, version: version.version }),
    docsServer(DOCS_MCP_SITE),
  ];
}
