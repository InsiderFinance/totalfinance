/** Release-evidence types, kept free of Node imports so the browser renderer can share them. */
export interface VerifiedRelease {
  version: string;
  channel: 'preview' | 'stable';
  verifiedAt: string;
  sourceCommit: string;
  registry: string;
  examplesSha256: string;
}

export interface SiteVersion {
  version: string;
  label: string;
  channel: 'development' | 'preview' | 'stable';
  published: boolean;
  sourceMatchesRelease: boolean;
  packageVersions: Record<string, string>;
  releases: VerifiedRelease[];
}
