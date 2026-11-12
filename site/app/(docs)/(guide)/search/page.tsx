import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { SearchPage } from '@/components/search/search-page';
import { pageMetadata } from '@/lib/metadata';

export const metadata = pageMetadata({
  title: 'Search',
  description: 'Search TotalFinance calculators, guides, functions, types and operations.',
  route: '/search',
});

export default function Search() {
  return (
    <div className="mx-auto max-w-[56rem] px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
      <PageHeader
        route="/search"
        eyebrow="Find the right call"
        title="Search TotalFinance"
        crumbs={[{ title: 'TotalFinance', url: '/' }, { title: 'Search' }]}
      />
      <Suspense>
        <SearchPage />
      </Suspense>
    </div>
  );
}
