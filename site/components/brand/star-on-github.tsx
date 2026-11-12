import { Star } from 'lucide-react';
import { githubStats } from '@/lib/data';
import { REPOSITORY_URL } from '@/lib/site';
import { starCountLabel } from '@/src/github';
import { GitHubIcon } from './github-icon';

/**
 * "Star on GitHub", with the build-time star count once it is worth showing (`STAR_COUNT_MIN`).
 * `header` is compact (icon only on small screens); `button` matches the hero's secondary buttons.
 */
export function StarOnGitHub({
  variant = 'button',
  className = '',
}: {
  variant?: 'header' | 'button' | 'inverse';
  className?: string;
}) {
  const count = starCountLabel(githubStats().stars);
  const label = count
    ? `Star TotalFinance on GitHub (${count} stars)`
    : 'Star TotalFinance on GitHub';
  if (variant === 'header')
    return (
      <a
        href={REPOSITORY_URL}
        aria-label={label}
        className={`inline-flex h-9 items-center gap-1.5 rounded-lg border border-fd-border px-2.5 text-sm font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary/50 hover:text-fd-foreground ${className}`}
      >
        <GitHubIcon className="size-4" />
        <span className="hidden items-center gap-1 sm:inline-flex">
          <Star className="size-3.5" aria-hidden /> Star
        </span>
        {count ? (
          <span className="hidden border-l border-fd-border pl-1.5 tabular-nums sm:inline">
            {count}
          </span>
        ) : null}
      </a>
    );
  const tone =
    variant === 'inverse'
      ? 'bg-white text-slate-900 hover:bg-slate-100'
      : 'border border-fd-border bg-fd-background hover:border-fd-primary/50';
  return (
    <a
      href={REPOSITORY_URL}
      aria-label={label}
      className={`inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-colors ${tone} ${className}`}
    >
      <GitHubIcon className="size-4" />
      <span>Star on GitHub</span>
      {count ? (
        <span
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs tabular-nums ${
            variant === 'inverse' ? 'bg-slate-100' : 'bg-fd-secondary'
          }`}
        >
          <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
          {count}
        </span>
      ) : (
        <Star className="size-4 fill-amber-400 text-amber-400" aria-hidden />
      )}
    </a>
  );
}
