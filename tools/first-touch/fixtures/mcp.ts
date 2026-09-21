/**
 * Stage 7A slice 1 — first-touch fixtures for `@totalfinance/mcp`: the server builder and the two tool
 * builders (an adapter over a registry operation; a caller's own custom tool). Thunks build FRESH
 * inputs per call. Before this shard the package had no hand baseline, so `defineTool` sat as
 * `incomplete-baseline` debt; the adapter that replaced its shipped role is measured alongside it.
 */

import { schema } from '@totalfinance/core/schema';
import { optionsPack as operationsPack } from '@totalfinance/workflows';
import { optionsPack } from '@totalfinance/mcp';
import { type FixtureThunk } from '../inputs.js';

export const MCP_FIXTURES: Record<string, FixtureThunk> = {
  'mcp.createTotalFinanceMcpServer': () => [{ packs: [optionsPack()], maxInputBytes: 65_536 }],
  'mcp.toolFromOperation': () => [operationsPack().operations[0]],
  'mcp.defineTool': () => [
    {
      name: 'totalfinance.fixture.echo',
      title: 'Echo',
      description: 'Returns its input (fixture).',
      schema: schema.object({ value: schema.number() }),
      run: (input: { value: number }) => ({ summary: 'echo', structured: { value: input.value } }),
    },
  ],
};
