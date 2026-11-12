import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageActions } from './page-actions';

export interface Crumb {
  title: string;
  url?: string;
}

export function PageHeader({
  route,
  title,
  description,
  eyebrow,
  crumbs,
  children,
}: {
  /** Base-path-relative route with slashes, e.g. `/learn/price-an-option`. */
  route: string;
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  crumbs: Crumb[];
  children?: ReactNode;
}) {
  return (
    <header className="mb-8">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="min-w-0 text-xs text-fd-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1.5">
            {crumbs.map((crumb, index) => (
              <li key={`${crumb.title}-${index}`} className="flex items-center gap-1.5">
                {index > 0 ? <span aria-hidden>/</span> : null}
                {crumb.url ? (
                  <Link href={crumb.url} className="hover:text-fd-primary">
                    {crumb.title}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-fd-foreground">
                    {crumb.title}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <PageActions
          route={route}
          title={typeof title === 'string' ? title : (crumbs.at(-1)?.title ?? 'TotalFinance')}
        />
      </div>
      {eyebrow ? <p className="tf-eyebrow mb-3">{eyebrow}</p> : null}
      <h1 className="font-display text-3xl font-semibold tracking-tight text-fd-foreground text-balance sm:text-[2.5rem] sm:leading-[1.1]">
        {title}
      </h1>
      {description ? (
        <p className="mt-4 max-w-3xl text-lg leading-8 text-fd-muted-foreground text-pretty">
          {description}
        </p>
      ) : null}
      {children}
    </header>
  );
}
