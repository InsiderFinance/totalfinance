import { createHash } from 'node:crypto';
import {
  NPMJS,
  object,
  validatePackageMetadata,
  type ReleaseArtifact,
  type ReleaseManifest,
} from './artifact-policy.js';

export function releaseRegistry(value: string): { registry: string; loopback: boolean } {
  const url = new URL(value);
  const loopback =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (!loopback && url.origin !== NPMJS)
  )
    throw new Error('Only npmjs.org or a root loopback rehearsal registry is permitted');
  return { registry: url.origin, loopback };
}

/** Read-only: 404 alone means absent. Auth/network errors never authorize a new upload. */
export async function verifyRegistryArtifact(
  artifact: ReleaseArtifact,
  registry: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  releaseRegistry(registry);
  const response = await request(
    `${registry}/${encodeURIComponent(artifact.package)}/${artifact.version}`,
    {
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(`Registry metadata failed: ${artifact.package} (${response.status})`);
  const metadata = object(await response.json(), 'registry metadata');
  // npm normalizes bin paths when publishing ("./dist/bin.js" becomes "dist/bin.js").
  // Restore only that equivalent spelling for metadata validation; the packed manifest and
  // downloaded tarball remain exact-byte checks. Wrong/traversing/absolute paths still fail.
  const bin = object(metadata['bin'], 'registry bin');
  validatePackageMetadata(
    {
      ...metadata,
      bin: Object.fromEntries(
        Object.entries(bin).map(([name, path]) => [
          name,
          typeof path === 'string' && !path.startsWith('./') ? `./${path}` : path,
        ]),
      ),
    },
    artifact.package,
    artifact.version,
  );
  const dist = object(metadata['dist'], 'registry dist');
  if (
    typeof dist['tarball'] !== 'string' ||
    new URL(dist['tarball']).origin !== registry ||
    new URL(dist['tarball']).username ||
    new URL(dist['tarball']).password ||
    new URL(dist['tarball']).hash
  )
    throw new Error(`Unsafe registry tarball URL: ${artifact.package}`);
  const tarball = await request(dist['tarball'], {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!tarball.ok)
    throw new Error(`Registry tarball failed: ${artifact.package} (${tarball.status})`);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  if (
    bytes.length !== artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error(`Registry bytes differ from approval: ${artifact.package}`);
  return true;
}

export async function verifyRegistryGroup(
  manifest: ReleaseManifest,
  registry: string,
): Promise<void> {
  for (const artifact of manifest.packages) {
    if (!(await verifyRegistryArtifact(artifact, registry)))
      throw new Error(`Registry is missing ${artifact.package}@${artifact.version}`);
  }
}

/** Complete read-only preflight before the first upload, including partial-publish recovery. */
export async function planPublication(
  manifest: ReleaseManifest,
  registry: string,
  resume: boolean,
  request: typeof fetch = fetch,
): Promise<boolean[]> {
  const existing: boolean[] = [];
  for (const artifact of manifest.packages) {
    const exists = await verifyRegistryArtifact(artifact, registry, request);
    if (exists && !resume)
      throw new Error(
        `${artifact.package} already exists; recovery requires --resume with the original approved artifact`,
      );
    existing.push(exists);
  }
  return existing;
}
