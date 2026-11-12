import type { ReactNode } from 'react';

/** Each section (guide, reference, agents) renders its own shell with only its own navigation. */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return children;
}
