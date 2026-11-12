/** Repeat main-only and integrated source measurements without changing any gate. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLE_BUDGETS } from './bundle-size/budgets.js';
const [main, integrated, receipt] = process.argv.slice(2);
if (!main || !integrated || !receipt) throw Error('main, integrated, receipt required');
const { BUNDLE_BUDGETS: baselineBudgets } = await import(
  pathToFileURL(resolve(main, 'tools/bundle-size/budgets.ts')).href
);
const baselineCaps = new Map(baselineBudgets.map((b: any) => [b.entry, b.budgetKB * 1024]));
const output: Record<string, unknown> = { node: process.version };
for (const [name, root] of [
  ['main', resolve(main)],
  ['integrated', resolve(integrated)],
] as const) {
  const { workspaceAlias } = await import(
    pathToFileURL(resolve(root, 'tools/bundle-size/workspace-alias.ts')).href
  );
  const alias = workspaceAlias();
  const measurements = [];
  for (const budget of BUNDLE_BUDGETS) {
    if (!existsSync(resolve(root, budget.entry))) continue;
    async function measure() {
      const result = await build({
        absWorkingDir: root,
        entryPoints: [resolve(root, budget.entry)],
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
      const code = result.outputFiles[0]!.text;
      const forbidden = (budget.forbidden ?? [])
        .filter(({ needle }) => code.includes(needle))
        .map(({ needle }) => needle);
      return {
        entry: budget.entry,
        bytesMin: Buffer.byteLength(code),
        bytesGzip: gzipSync(code).length,
        targetCapBytes: budget.budgetKB * 1024,
        repositoryCapBytes:
          name === 'main' ? baselineCaps.get(budget.entry) : budget.budgetKB * 1024,
        forbidden,
        modules: Object.entries(Object.values(result.metafile!.outputs)[0]!.inputs)
          .filter(([, v]) => v.bytesInOutput > 0)
          .map(([id, v]) => ({ id: relative(root, resolve(root, id)), bytes: v.bytesInOutput }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    }
    const first = await measure();
    assert.deepEqual(await measure(), first);
    measurements.push(first);
  }
  output[name] = measurements;
}
writeFileSync(receipt, JSON.stringify(output, null, 2) + '\n');
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(output).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(({ modules: _modules, ...row }) => row) : value,
      ]),
    ),
    null,
    2,
  ),
);
