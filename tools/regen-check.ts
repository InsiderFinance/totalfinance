/**
 * Stage 4.7 (FC9, Decision 9) — clean-repository generation as one command.
 *
 * Runs the whole regeneration chain in its lawful order and fails when the working tree is not
 * byte-identical afterwards: a generated artifact that drifts from its declarations, a README that
 * drifts from its generator, a field reference that drifts from the contracts — any of them fails
 * here and names the file. The chain's ordering law (the contract before the validation projector,
 * the API reports before the README and `llms.txt` generators, the bundle report before the docs
 * inventory) is this script's, not the operator's memory.
 *
 *   pnpm regen:check
 *
 * The hosted workflow runs it as a job beside the test matrix; the Stage 4.7 closeout quotes the
 * local run at its commit.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The chain, in order. Each step is a package script or a generator invocation. */
export const REGENERATION_STEPS: readonly string[] = [
  'pnpm signature:update',
  'pnpm naming:update',
  'pnpm contract:update',
  'pnpm enforcement:update',
  'pnpm validation:update',
  'pnpm api:update',
  'pnpm exec tsx tools/readme-gen.ts',
  'pnpm exec tsx tools/llms-docs.ts',
  'pnpm exec tsx tools/public-reference.ts --typedoc',
  'pnpm bundle:update',
  'pnpm openapi:update',
  'pnpm docs:update',
];

function run(command: string): void {
  process.stdout.write(`\n▶ ${command}\n`);
  execSync(command, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CI: process.env['CI'] ?? '1' },
  });
}

/** Paths that differ from HEAD after the chain (tracked changes and untracked files). */
export function dirtyPaths(): string[] {
  const status = execSync('git status --porcelain --untracked-files=all -- .', {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function main(): void {
  const before = dirtyPaths();
  if (before.length > 0) {
    process.stderr.write(
      `regen:check: the working tree must be clean before the chain runs; ${before.length} path(s) differ:\n${before.join('\n')}\n`,
    );
    process.exit(2);
  }
  for (const step of REGENERATION_STEPS) run(step);
  const after = dirtyPaths();
  if (after.length > 0) {
    process.stderr.write(
      `\nregen:check: the regeneration chain changed ${after.length} path(s) — a generated artifact drifted from its declarations. Commit the regeneration, or fix the generator:\n${after.join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('\nregen:check: the regeneration chain is byte-stable — nothing changed.\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
