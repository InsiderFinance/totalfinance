import { CodePanel } from '@/components/code/code-panel';
import { PageHeader } from '@/components/layout/page-header';
import { siteVersion } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { BASE_PATH, MCP_PACKAGE_NAME, PACKAGE_NAME } from '@/lib/site';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const metadata = pageMetadata({
  title: 'Versions & stability',
  description:
    'Which TotalFinance release these docs describe, what pre-1.0 stability means, and the verified release evidence.',
  route: '/versions',
});

function archivedVersions(): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), '.generated', 'archives.json'), 'utf8'),
    ) as { archived: string[] };
    return manifest.archived;
  } catch {
    return [];
  }
}

export default function VersionsPage() {
  const release = siteVersion();
  const archived = archivedVersions();
  return (
    <div className="mx-auto max-w-[52rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
      <PageHeader
        route="/versions"
        eyebrow="Know what you are running"
        title="Versions & stability"
        description="These pages describe two public packages: the toolkit and the optional MCP server. A package version alone is not proof of publication."
        crumbs={[{ title: 'TotalFinance', url: '/' }, { title: 'Versions' }]}
      >
        <span className="mt-4 inline-flex rounded-full border border-fd-border px-3 py-1 text-sm font-medium">
          {release.label}
        </span>
      </PageHeader>
      <div className="tf-prose">
        {release.published ? (
          <>
            <h2>Install this exact release</h2>
            <CodePanel
              lang="sh"
              title="Shell"
              code={`pnpm add ${PACKAGE_NAME}@${release.version}\nnpx -y ${MCP_PACKAGE_NAME}@${release.version}`}
            />
          </>
        ) : (
          <>
            <h2>Use this source build</h2>
            <p>
              This build is not verified as matching a public release. In a checkout of the
              repository, run the following, then import from the workspace or test its packed
              tarballs:
            </p>
            <CodePanel
              lang="sh"
              title="Shell"
              code={
                'pnpm install --frozen-lockfile\npnpm build\npnpm --dir site install --frozen-lockfile\npnpm site:build\npnpm site:dev'
              }
            />
            <p>
              Registry install commands elsewhere in these docs are release instructions, not
              evidence that this source is published.
            </p>
          </>
        )}
        <h2>Pre-1.0 stability</h2>
        <p>
          TotalFinance is pre-1.0 software, not covered by a 1.0 stability guarantee, and breaking
          changes may occur. A version without a prerelease suffix does not by itself establish API
          maturity.{' '}
          {release.published
            ? 'This build matches a recorded public registry verification.'
            : 'No public release is advertised by this build.'}{' '}
          Read the <a href={`${BASE_PATH}/guides/stability`}>stability policy</a>; a model or
          platform subpath can have a different maturity from the package as a whole.
        </p>
        <p>
          <a href={`${BASE_PATH}/versions/${release.version}`}>
            Browse this version-pinned documentation snapshot
          </a>
          .
        </p>
        {archived.length ? (
          <>
            <h2>Earlier releases</h2>
            <ul>
              {archived.map((version) => (
                <li key={version}>
                  <a href={`${BASE_PATH}/versions/${version}`}>{version}</a>: preserved pages,
                  search, examples and assets
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <h2>Verified public release evidence</h2>
        {release.releases.length ? (
          <CodePanel
            lang="json"
            title="releases.json"
            code={JSON.stringify(release.releases, null, 2)}
          />
        ) : (
          <p>
            No public registry release has been recorded. Local tests and packed rehearsals do not
            substitute for publication evidence.
          </p>
        )}
        <h2>Package versions in this build</h2>
        <table>
          <tbody>
            {Object.entries(release.packageVersions).map(([name, version]) => (
              <tr key={name}>
                <th>
                  <code>{name}</code>
                </th>
                <td>{version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
