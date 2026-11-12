import Link from 'next/link';
import { siteVersion } from '@/lib/data';
import { BASE_PATH, FAMILY, REPOSITORY_URL } from '@/lib/site';

export function SiteFooter({ docsBaseUrl = '' }: { docsBaseUrl?: string }) {
  const version = siteVersion();
  return (
    <footer className="border-t border-fd-border">
      <div className="mx-auto flex max-w-[88rem] flex-col gap-4 px-5 py-8 text-xs leading-6 text-fd-muted-foreground sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10">
        <p>
          TotalFinance is open source (
          <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} className="hover:text-fd-primary">
            Apache-2.0
          </a>
          ), built by{' '}
          <a href={FAMILY.home} className="font-medium text-fd-foreground hover:text-fd-primary">
            InsiderFinance
          </a>
          . Sample data is hypothetical. Analytics are not investment advice.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-1">
          <Link href={`${docsBaseUrl}/versions`} className="hover:text-fd-primary">
            v{version.version}
          </Link>
          <a href={`${docsBaseUrl || BASE_PATH}/llms.txt`} className="hover:text-fd-primary">
            llms.txt
          </a>
          <Link href={`${docsBaseUrl}/agents`} className="hover:text-fd-primary">
            For agents
          </Link>
          <a href={REPOSITORY_URL} className="hover:text-fd-primary">
            GitHub
          </a>
          <a href={`${REPOSITORY_URL}/blob/main/SECURITY.md`} className="hover:text-fd-primary">
            Security
          </a>
        </nav>
      </div>
    </footer>
  );
}
