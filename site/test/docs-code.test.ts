import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSnippet, extractTsBlocks } from '../../tools/readme-exec.js';

const CONTENT = fileURLToPath(new URL('../content/docs', import.meta.url));

function mdxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? mdxFiles(join(directory, entry.name))
      : entry.name.endsWith('.mdx')
        ? [join(directory, entry.name)]
        : [],
  );
}

const blocks = mdxFiles(CONTENT).flatMap((file) =>
  extractTsBlocks(readFileSync(file, 'utf8')).map((code, index) => ({
    id: `${relative(CONTENT, file)} #${index + 1}`,
    code,
  })),
);

describe('authored documentation code', () => {
  it('has executable TypeScript to check', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it.each(blocks.map((block) => [block.id, block.code] as const))(
    '%s compiles and runs against the library',
    async (_id, code) => {
      await expect(executeSnippet(code)).resolves.toBeUndefined();
    },
  );
});
