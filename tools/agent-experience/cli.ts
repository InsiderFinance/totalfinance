import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRecordedRuns } from './scorer.js';

/** Injectable I/O makes the CLI testable without processes, credentials, or external agents. */
export function runCli(
  args: readonly string[],
  io: {
    read: (path: string) => string;
    out: (text: string) => void;
    error: (text: string) => void;
  },
): number {
  if (args.length === 1 && args[0] === '--help') {
    io.out(
      'Usage: tsx tools/agent-experience/cli.ts <corpus.json> <recorded-runs.json>\nWrites JSON to stdout. --help shows this message.',
    );
    return 0;
  }
  if (args.length !== 2 || args.some((arg) => arg.startsWith('--'))) {
    io.error('Usage: tsx tools/agent-experience/cli.ts <corpus.json> <recorded-runs.json>');
    return 2;
  }
  try {
    const report = scoreRecordedRuns(JSON.parse(io.read(args[0]!)), JSON.parse(io.read(args[1]!)));
    io.out(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    io.error(`Cannot score recording: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2), {
    read: (path) => readFileSync(path, 'utf8'),
    out: (text) => process.stdout.write(`${text}\n`),
    error: (text) => process.stderr.write(`${text}\n`),
  });
}
