'use client';
import { AnchorProvider, TOCItem, type TOCItemType } from 'fumadocs-core/toc';
import type { ReactNode } from 'react';

export function TableOfContents({
  items,
  children,
}: {
  items: TOCItemType[];
  children?: ReactNode;
}) {
  if (!items.length && !children) return null;
  return (
    <AnchorProvider toc={items}>
      <nav aria-label="On this page" className="text-sm">
        {items.length ? (
          <>
            <p className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-fd-muted-foreground">
              On this page
            </p>
            <ul className="space-y-1 border-l border-fd-border">
              {items.map((item) => (
                <li key={item.url}>
                  <TOCItem
                    href={item.url}
                    className="-ml-px block border-l border-transparent py-1 text-fd-muted-foreground transition-colors hover:text-fd-foreground data-[active=true]:border-fd-primary data-[active=true]:font-medium data-[active=true]:text-fd-primary"
                    style={{ paddingLeft: `${0.75 + Math.max(0, item.depth - 2) * 0.75}rem` }}
                  >
                    {item.title}
                  </TOCItem>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {children}
      </nav>
    </AnchorProvider>
  );
}
