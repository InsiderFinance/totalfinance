import type { ReactNode } from 'react';
import { siteVersion } from '@/lib/data';
import { navigation, type NavTab } from '@/lib/navigation';
import { BASE_PATH, FAMILY, REPOSITORY_URL } from '@/lib/site';
import { Sidebar } from './sidebar';
import { SiteFooter } from './site-footer';

/** A section shell: only the active section's navigation is rendered (and shipped) with its pages. */
export function DocsShell({
  children,
  tab,
  sidebarOnDesktop = true,
}: {
  children: ReactNode;
  tab: NavTab['id'];
  sidebarOnDesktop?: boolean;
}) {
  const version = siteVersion();
  const tabs = navigation();
  const active = tabs.find((candidate) => candidate.id === tab)!;
  return (
    <>
      <Sidebar
        tabs={tabs.map(({ id, title, url, description }) => ({ id, title, url, description }))}
        active={tab}
        groups={active.groups}
        versionLabel={`v${version.version}`}
        repositoryUrl={REPOSITORY_URL}
        data={FAMILY.data}
        llmsUrl={`${BASE_PATH}/llms.txt`}
        desktop={sidebarOnDesktop}
      />
      <div className={sidebarOnDesktop ? 'lg:pl-(--tf-sidebar-width)' : ''}>
        <main id="tf-main" tabIndex={-1} className="outline-none">
          {children}
        </main>
        <SiteFooter />
      </div>
    </>
  );
}
