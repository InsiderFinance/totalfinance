/**
 * The `totalfinance` command surface, published so the CLI guide is checked against what ships (the
 * same standing as the MCP guide's tool list).
 */

export const CLI_COMMANDS = Object.freeze([
  'operations list',
  'schema',
  'run',
  'job submit',
  'job status',
  'job result',
  'job cancel',
  'artifacts get',
  'serve',
  'doctor',
] as const);

export type CliCommand = (typeof CLI_COMMANDS)[number];
