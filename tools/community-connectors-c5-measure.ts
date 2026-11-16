/** Repeated pinned whole-source attribution. Measurement only: no budget writes or waived gates.
 * Usage: <main tree> <C4 tree> <C4+main baseline tree> <C5 tree> <receipt.json>
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLE_BUDGETS } from './bundle-size/budgets.js';
const [main, c4, integrated, c5, receipt] = process.argv.slice(2);
if (!main || !c4 || !integrated || !c5 || !receipt)
  throw Error('Four source trees and receipt required');
const output: Record<string, unknown> = { node: process.version, measurementOnly: true };
for (const [name, input] of [
  ['main', main],
  ['c4', c4],
  ['integratedPreC5', integrated],
  ['c5', c5],
] as const) {
  const root = resolve(input),
    { workspaceAlias } = await import(
      pathToFileURL(join(root, 'tools/bundle-size/workspace-alias.ts')).href
    ),
    { BUNDLE_BUDGETS: own } = await import(
      pathToFileURL(join(root, 'tools/bundle-size/budgets.ts')).href
    );
  const caps = new Map(own.map((b: any) => [b.entry, b.budgetKB * 1024]));
  const alias = workspaceAlias();
  const rows = [];
  for (const budget of BUNDLE_BUDGETS) {
    if (!existsSync(join(root, budget.entry))) continue;
    async function measure() {
      const r = await build({
        absWorkingDir: root,
        entryPoints: [join(root, budget.entry)],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        treeShaking: true,
        legalComments: 'none',
        write: false,
        alias,
        metafile: true,
      });
      const code = r.outputFiles[0]!.text;
      return {
        entry: budget.entry,
        bytesMin: Buffer.byteLength(code),
        bytesGzip: gzipSync(code).length,
        codeSha256: createHash('sha256').update(code).digest('hex'),
        repositoryCapBytes: caps.get(budget.entry) ?? null,
        candidateEnforcedCapBytes: budget.budgetKB * 1024,
        forbidden: (budget.forbidden ?? [])
          .filter((f) => code.includes(f.needle))
          .map((f) => f.needle),
        modules: Object.entries(Object.values(r.metafile!.outputs)[0]!.inputs)
          .filter(([, m]) => m.bytesInOutput > 0)
          .map(([id, m]) => ({ id: relative(root, resolve(root, id)), bytes: m.bytesInOutput }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    }
    const a = await measure();
    assert.deepEqual(await measure(), a);
    rows.push(a);
  }
  const sourceFiles: { path: string; sha256: string }[] = [];
  function scan(path: string) {
    for (const ent of readdirSync(path, { withFileTypes: true })) {
      const f = join(path, ent.name);
      if (ent.isDirectory()) scan(f);
      else if (ent.name.endsWith('.ts'))
        sourceFiles.push({
          path: relative(root, f),
          sha256: createHash('sha256').update(readFileSync(f)).digest('hex'),
        });
    }
  }
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const p = join(root, 'packages', pkg, 'src');
    if (existsSync(p)) scan(p);
  }
  sourceFiles.sort((a, b) => a.path.localeCompare(b.path));
  output[name] = {
    root,
    sourceSha256: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
    sourceFiles,
    rows,
  };
  console.log(
    name,
    JSON.stringify(
      rows
        .filter((r) => r.bytesGzip >= r.candidateEnforcedCapBytes)
        .map(({ modules: _modules, ...r }) => r),
    ),
  );
}
writeFileSync(resolve(receipt), JSON.stringify(output, null, 2) + '\n');
