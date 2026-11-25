/** npm can accept a signed upload before its version and latest tag become publicly readable. */
import type { ReleaseArtifact } from './artifact-policy.js';
import { requireForwardLatest } from './github-sdk-policy.js';
import { registryTags, verifyRegistryArtifact } from './registry-policy.js';

export async function waitForReadback(
  artifact: ReleaseArtifact,
  registry: string,
): Promise<Record<string, string>> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    // A missing version is processing, not permission to upload it again. Existing integrity,
    // metadata, authorization and network errors still fail immediately through these shared checks.
    const present = await verifyRegistryArtifact(artifact, registry);
    const tags = await registryTags(artifact.package, registry);
    requireForwardLatest(artifact.version, tags['latest']);
    if (present && tags['latest'] === artifact.version) return tags;
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(
        `npm readback of ${artifact.package} is still processing after 15 minutes; preserve approved artifacts and rerun the original failed job`,
      );
    console.log(
      `npm accepted the ${artifact.package} upload; waiting for approved bytes and latest to become readable`,
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, remaining)));
  }
}
