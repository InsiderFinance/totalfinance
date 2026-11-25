/** The version these docs describe, kept free of Node imports so the browser renderer can share it. */
export interface SiteVersion {
  version: string;
  label: string;
  packageVersions: Record<string, string>;
}
