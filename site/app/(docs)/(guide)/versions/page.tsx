import Link from 'next/link';
import { CodePanel } from '@/components/code/code-panel';
import { PageHeader } from '@/components/layout/page-header';
import { siteVersion } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { BASE_PATH, MCP_PACKAGE_NAME, PACKAGE_NAME } from '@/lib/site';
import { MCP_PUBLISHED_ON_NPM } from '@/src/agents';

export const metadata = pageMetadata({
  title: 'Versions & stability',
  description:
    'Which TotalFinance release these docs describe, how to install it, and what pre-1.0 stability means.',
  route: '/versions',
});

export default function VersionsPage() {
  const release = siteVersion();
  return (
    <div className="mx-auto max-w-[52rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
      <PageHeader
        route="/versions"
        eyebrow="Know what you are running"
        title="Versions & stability"
        description="These pages describe two packages: the toolkit and the optional MCP server."
        crumbs={[{ title: 'TotalFinance', url: '/' }, { title: 'Versions' }]}
      >
        <span className="mt-4 inline-flex rounded-full border border-fd-border px-3 py-1 text-sm font-medium">
          {release.label}
        </span>
      </PageHeader>
      <div className="tf-prose">
        <h2>Install</h2>
        <CodePanel lang="sh" title="Shell" code={`pnpm add ${PACKAGE_NAME}`} />
        {MCP_PUBLISHED_ON_NPM ? (
          <>
            <p>The optional MCP server, pinned to this release:</p>
            <CodePanel
              lang="sh"
              title="Shell"
              code={`npx -y ${MCP_PACKAGE_NAME}@${release.version}`}
            />
          </>
        ) : (
          <p>
            The optional MCP server (<code>{MCP_PACKAGE_NAME}</code>) is not on npm yet. Build it
            from a source checkout; <Link href="/agents">Connect an agent</Link> has the steps.
          </p>
        )}
        <h2>Pre-1.0 stability</h2>
        <p>
          TotalFinance is pre-1.0 software, not covered by a 1.0 stability guarantee, and breaking
          changes may occur. A version without a prerelease suffix does not by itself establish API
          maturity. Read the <a href={`${BASE_PATH}/guides/stability`}>stability policy</a>; a model
          or platform subpath can have a different maturity from the package as a whole.
        </p>
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
