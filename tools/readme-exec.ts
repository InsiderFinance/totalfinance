/**
 * README snippet executor (spec DX7.1). The doc most people read must be the doc that cannot drift:
 * this extracts every fenced ```ts block from a README, concatenates them in order (docs are written
 * as a continuation — later blocks reuse earlier bindings), bundles the result against the package
 * SOURCE via esbuild, and runs it. A snippet that fails to compile or throws at runtime fails CI.
 *
 * Package READMEs are already covered transitively (their examples are the CI-run
 * `docs/examples/readme-snippets.test.ts`, and `tools/readme-gen.test.ts` asserts each README embeds
 * exactly that snippet), so the executor's job is the ROOT `README.md` — the front page.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = new URL('../', import.meta.url);

/** Extract the bodies of every ```ts / ```typescript fenced block, in document order. */
export function extractTsBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:ts|typescript)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1] ?? '');
  return blocks;
}

/**
 * Map every `@totalfinance/*` (and `totalfinance`) entrypoint to its SOURCE file, derived from each
 * package's `exports` map (`./dist/x.js` → `src/x.ts`). Subpath specifiers are aliased explicitly so
 * esbuild's package-prefix remapping cannot mangle them (mirrors the bundle-size alias map).
 */
export function readmeAliasMap(): Record<string, string> {
  const dir = fileURLToPath(new URL('packages', ROOT));
  const alias: Record<string, string> = {};
  for (const pkg of readdirSync(dir).sort()) {
    let manifest: { name?: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(`${dir}/${pkg}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.exports) continue;
    for (const [key, val] of Object.entries(manifest.exports)) {
      if (key === './package.json') continue;
      const dist = typeof val === 'object' && val ? (val as { import?: string }).import : val;
      if (typeof dist !== 'string') continue;
      const src = dist.replace(/^\.\/dist\//, `${dir}/${pkg}/src/`).replace(/\.js$/, '.ts');
      const specification = key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`;
      alias[specification] = src;
    }
  }
  return alias;
}

/** Bundle a TypeScript snippet against the package sources and run it (throws on compile or runtime error). */
export async function executeSnippet(code: string): Promise<void> {
  const result = await build({
    stdin: {
      contents: code,
      loader: 'ts',
      resolveDir: fileURLToPath(ROOT),
      sourcefile: 'readme-snippet.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    write: false,
    alias: readmeAliasMap(),
    logLevel: 'silent',
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild produced no output for the snippet');
  const require = createRequire(fileURLToPath(new URL('tools/readme-exec.ts', ROOT)));
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out.text)(module, module.exports, require);
}

/** Extract and execute all ```ts blocks of a README (concatenated). No-op when the README has none. */
export async function executeReadme(readmePath: string): Promise<void> {
  const code = extractTsBlocks(readFileSync(readmePath, 'utf8')).join('\n\n');
  if (code.trim()) await executeSnippet(code);
}

/** Absolute path to the repo-root README. */
export const ROOT_README = fileURLToPath(new URL('README.md', ROOT));
