import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

export interface BundleMeasurement {
  entry: string;
  /** Minified byte size of the tree-shaken ESM bundle. */
  bytesMin: number;
  /** Gzip byte size — the number budgets are measured against. */
  bytesGzip: number;
  /** The bundled output text, for sentinel/inclusion assertions. */
  code: string;
}

/**
 * Bundle an entire source entrypoint, preserving its exported surface, then minify and gzip it.
 * `alias` resolves public package specifiers to source for a fast whole-entrypoint budget without
 * a build step. This is NOT a used-function consumer measurement: installed-consumer tests own
 * the cost and retained-module guarantees for a caller importing only selected functions.
 *
 * This is the enforcement mechanism for spec §21.5 (bundle budgets) and the hot-path rule (§6):
 * a compute entrypoint must not drag in validators or JSON-Schema machinery.
 */
export async function measureBundle(
  entry: string,
  alias: Record<string, string>,
): Promise<BundleMeasurement> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    legalComments: 'none',
    write: false,
    alias,
  });

  const out = result.outputFiles[0];
  if (!out) throw new Error(`esbuild produced no output for ${entry}`);
  const code = out.text;
  const bytesMin = Buffer.byteLength(code, 'utf8');
  const bytesGzip = gzipSync(Buffer.from(code, 'utf8')).length;
  return { entry, bytesMin, bytesGzip, code };
}

export const KB = 1024;
