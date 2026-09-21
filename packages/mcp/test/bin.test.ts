import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { PARITY_FIXTURES } from '../../../tools/transport-parity/fixtures.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const invoke = (...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

describe('configured binary and truthful doctor', () => {
  it('doctor reports effective filters, grants, writable stores, jobs and page caps from the actual server', () => {
    const directory = mkdtempSync(join(tmpdir(), 'totalfinance-mcp-doctor-'));
    try {
      const result = invoke(
        'doctor',
        '--profile',
        'full',
        '--store',
        directory,
        '--jobs',
        '--page-size',
        '2',
        '--capability',
        'trade:approve',
      );
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.server.tools).toBe(report.capabilities.tools.length);
      expect(report.capabilities).toMatchObject({
        selection: 'profile',
        grants: { held: ['trade:approve'] },
        jobs: { enabled: true },
        stores: { artifacts: { read: true, write: true }, authorization: true, journal: true },
        budgets: { pageSize: 2 },
      });
      expect(report.capabilities.filters.length).toBeGreaterThan(0);
      expect(report.capabilities.tools).toContain('totalfinance_trade_authorize');
      expect(report.capabilities.tools).not.toContain('totalfinance_trade_submit');
      const reader = JSON.parse(invoke('doctor', '--store', directory, '--store-read-only').stdout);
      expect(reader.capabilities).toMatchObject({
        stores: { artifacts: { read: true, write: false }, authorization: false, journal: false },
        jobs: { enabled: false },
      });
      expect(reader.server.tools).toBe(23);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ['doctor', '--page-size', '101'],
    ['doctor', '--page-size', '1.5'],
    ['doctor', '--max-input-bytes', '16777217'],
    ['doctor', '--max-input-bytes', '0'],
    ['doctor', '--seed', '9007199254740992'],
    ['doctor', '--deadline-ms', '-1'],
    ['doctor', '--capability', 'not-a-grant'],
    ['doctor', '--jobs'],
    ['doctor', '--store-read-only'],
    ['doctor', 'extra'],
    ['doctor', '--profile', 'full', '--packs', 'options,options'],
  ])('rejects invalid doctor configuration %j before claiming success', (...args) => {
    const result = invoke(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('totalfinance-mcp:');
  });
  it('runs a fetch-later job over ordinary stdio MCP without experimental client tasks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'totalfinance-mcp-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '--profile', 'backtesting', '--jobs', '--store', directory],
    });
    const client = new Client({ name: 'standard-stdio-client', version: '0' });
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.some((tool) => tool.name === 'totalfinance_job_submit'),
      ).toBe(true);
      const response = await client.callTool({
        name: 'totalfinance_job_submit',
        arguments: {
          id: 'totalfinance.backtest.options_run',
          input: PARITY_FIXTURES['totalfinance.backtest.options_run']!(),
        },
      });
      expect(response.isError, JSON.stringify(response.content)).toBeFalsy();
      const submitted = response.structuredContent as { job: { id: string } };
      await expect
        .poll(
          async () => {
            const status = await client.callTool({
              name: 'totalfinance_job_status',
              arguments: { jobId: submitted.job.id },
            });
            return (status.structuredContent as { job: { state: string } }).job.state;
          },
          { timeout: 10_000 },
        )
        .toBe('completed');
      const result = await client.callTool({
        name: 'totalfinance_job_result',
        arguments: { jobId: submitted.job.id },
      });
      expect(result.structuredContent).toMatchObject({
        result: {
          operation: { id: 'totalfinance.backtest.options_run' },
          diagnostics: { status: 'complete' },
        },
      });
    } finally {
      await client.close();
      await transport.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
