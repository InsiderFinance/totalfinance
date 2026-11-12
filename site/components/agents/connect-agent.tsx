import { agentServers } from '@/lib/agents';
import { SOURCE_BUILD, setupsFor, type McpServerSpec } from '@/src/agents';
import { ConnectAgentClient } from './connect-agent-client';

/**
 * Connect an AI agent: every server this build offers (see `lib/agents.ts`), each with exact setup
 * for eight clients. `only` narrows to one server, e.g. on the docs MCP page.
 */
export function ConnectAgent({ only }: { only?: McpServerSpec['id'] }) {
  const servers = agentServers()
    .filter((server) => !only || server.id === only)
    .map((server) => ({ server, setups: setupsFor(server) }));
  return <ConnectAgentClient servers={servers} sourceBuild={SOURCE_BUILD} />;
}
