/**
 * The CLI guide describes exactly what ships (Stage 7A Decision 6): every command the guide names
 * exists, every shipped command is named, and the exit-code table is the published contract.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, CLI_EXIT_CODES } from '@totalfinance/cli';

const GUIDE = fileURLToPath(new URL('../docs/guides/cli.md', import.meta.url));
const guide = readFileSync(GUIDE, 'utf8');

describe('CLI guide conformance (Stage 7A)', () => {
  it('names every shipped command, and no command that does not ship', () => {
    const named = new Set(
      [
        ...guide.matchAll(
          /`totalfinance ((?:operations list|schema|run|job (?:submit|status|result|cancel)|artifacts get|serve|doctor|[a-z]+(?: [a-z]+)?))\b/g,
        ),
      ].map((match) => match[1]!),
    );
    for (const command of CLI_COMMANDS) {
      expect(named.has(command), `the guide never names \`totalfinance ${command}\``).toBe(true);
    }
    const phantom = [...named].filter(
      (command) =>
        !(CLI_COMMANDS as readonly string[]).includes(command) && !command.startsWith('--'),
    );
    expect(phantom, `the guide names commands that do not ship:\n${phantom.join('\n')}`).toEqual(
      [],
    );
  });

  it('publishes the exit-code contract exactly', () => {
    const rows = [...guide.matchAll(/^\| `(\d+)` +\| ([^|]+)\|/gm)].map(
      (match) => [Number(match[1]), match[2]!.trim()] as const,
    );
    expect(rows.map(([code]) => code)).toEqual(Object.values(CLI_EXIT_CODES));
    const meanings = Object.fromEntries(rows);
    expect(meanings[CLI_EXIT_CODES.success]).toMatch(/success/);
    expect(meanings[CLI_EXIT_CODES.usage]).toMatch(/usage/);
    expect(meanings[CLI_EXIT_CODES.inputRefused]).toMatch(/input\.\*/);
    expect(meanings[CLI_EXIT_CODES.operationFailed]).toMatch(/operation failed/);
    expect(meanings[CLI_EXIT_CODES.jobCancelled]).toMatch(/cancelled/);
    expect(meanings[CLI_EXIT_CODES.internal]).toMatch(/internal/);
  });

  it('states the store default and the byte budget the binary resolves', () => {
    expect(guide).toContain('~/.totalfinance/store');
    expect(guide).toContain('65,536');
    expect(guide).toContain('16,777,216');
  });
});
