import Link from 'next/link';
import { generatedGuides } from '@/lib/data';
import { GUIDE_GROUPS } from '@/lib/navigation';

export function GuideIndex() {
  const guides = generatedGuides();
  return (
    <div className="not-prose my-6 space-y-8">
      {GUIDE_GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="mb-3 font-display text-lg font-semibold">{group.title}</h2>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {group.routes.map((route) => {
              const guide = guides.find((candidate) => candidate.route === route);
              if (!guide) return null;
              return (
                <Link
                  key={route}
                  href={`/${route}`}
                  className="rounded-xl border border-fd-border p-3.5 transition-colors hover:border-fd-primary/50 hover:bg-fd-muted"
                >
                  <span className="block font-medium text-fd-foreground">{guide.title}</span>
                  <span className="mt-1 line-clamp-2 block text-[0.8125rem] leading-5 text-fd-muted-foreground">
                    {guide.description}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
