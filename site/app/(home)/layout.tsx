import type { ReactNode } from 'react';
import { DocsShell } from '@/components/layout/docs-shell';
import { PUBLIC_DOCS_URL } from '@/lib/site';

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <DocsShell tab="guide" sidebarOnDesktop={false} docsBaseUrl={PUBLIC_DOCS_URL}>
      {children}
    </DocsShell>
  );
}
