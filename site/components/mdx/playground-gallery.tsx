import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { playgrounds } from '@/src/playgrounds';

export function PlaygroundGallery({ exclude = [] as string[] }: { exclude?: string[] }) {
  return (
    <div className="not-prose my-6 grid gap-3 sm:grid-cols-2">
      {playgrounds
        .filter((playground) => !exclude.includes(playground.id))
        .map((playground) => (
          <Link
            key={playground.id}
            href={`/learn/${playground.id}`}
            className="group flex flex-col rounded-xl border border-fd-border p-4 transition-colors hover:border-fd-primary/50 hover:bg-fd-muted"
          >
            <span className="flex items-center justify-between gap-2 font-display font-semibold text-fd-foreground">
              {playground.title}
              <ArrowRight
                className="size-4 text-fd-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-fd-primary"
                aria-hidden
              />
            </span>
            <span className="mt-1.5 line-clamp-3 text-sm leading-6 text-fd-muted-foreground">
              {playground.introduction}
            </span>
          </Link>
        ))}
    </div>
  );
}
