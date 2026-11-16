/** Reproducible C3 review measurements; no budget decisions or threshold writes. */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baselinePath, candidatePath, receiptPath] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !receiptPath)
  throw Error('baseline, candidate and receipt paths required');
async function measure(root: string, entry: string, alias: Record<string, string>) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, entry)],
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
  const output = Object.values(result.metafile!.outputs)[0]!;
  return {
    bytesMin: Buffer.byteLength(code),
    bytesGzip: gzipSync(code).length,
    retainedModules: Object.entries(output.inputs)
      .filter(([, m]) => m.bytesInOutput > 0)
      .map(([p, m]) => ({ id: relative(root, resolve(root, p)), bytes: m.bytesInOutput }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
const entries = [
  'packages/totalfinance/src/index.ts',
  'packages/core/src/data.ts',
  'packages/math/src/montecarlo.ts',
  'packages/calendars/src/crypto.ts',
  'packages/fixed-income/src/convertible.ts',
];
const results: Record<string, unknown> = { node: process.version };
for (const [name, root] of [
  ['baseline', resolve(baselinePath)],
  ['candidate', resolve(candidatePath)],
] as const) {
  const { workspaceAlias } = await import(
    pathToFileURL(resolve(root, 'tools/bundle-size/workspace-alias.ts')).href
  );
  const alias = workspaceAlias();
  const measured: Record<string, unknown> = {};
  for (const entry of [
    ...entries,
    ...(name === 'candidate' ? ['packages/totalfinance/src/data.ts'] : []),
  ]) {
    const a = await measure(root, entry, alias),
      b = await measure(root, entry, alias);
    if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('Nonrepeatable measurement: ' + entry);
    measured[entry] = a;
  }
  results[name] = measured;
}
writeFileSync(receiptPath, JSON.stringify(results, null, 2) + '\n');
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(results)
        .filter(([k]) => k !== 'node')
        .map(([k, v]) => [
          k,
          Object.fromEntries(
            Object.entries(v as any).map(([e, m]) => [
              e,
              { bytesMin: (m as any).bytesMin, bytesGzip: (m as any).bytesGzip },
            ]),
          ),
        ]),
    ),
    null,
    2,
  ),
);
