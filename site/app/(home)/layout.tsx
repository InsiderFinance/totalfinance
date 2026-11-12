import type { ReactNode } from 'react';
import { DocsShell } from '@/components/layout/docs-shell';

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <DocsShell tab="guide" sidebarOnDesktop={false}>
      {children}
    </DocsShell>
  );
}
