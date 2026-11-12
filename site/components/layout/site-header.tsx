import Link from 'next/link';
import { Bot } from 'lucide-react';
import { FAMILY, SITE_ORIGIN } from '@/lib/site';
import { TotalFinanceMark } from '../brand/totalfinance-mark';
import { StarOnGitHub } from '../brand/star-on-github';
import { MenuButton, SearchButton } from './header-actions';
import { ThemeToggle } from './theme-toggle';

/**
 * The InsiderFinance documentation header, with TotalFinance as the active section. Family links
 * leave this zone, so they are plain anchors (no base path).
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 h-(--tf-header-height) border-b border-fd-border bg-fd-background/90 backdrop-blur supports-[backdrop-filter]:bg-fd-background/75">
      <div className="flex h-full items-center gap-3 px-4 sm:px-6">
        <MenuButton />
        <a
          href={`${SITE_ORIGIN}/`}
          className="flex shrink-0 items-center gap-2.5"
          aria-label="TotalFinance home"
        >
          <TotalFinanceMark className="size-8" />
          <span className="font-display text-[1.0625rem] font-semibold tracking-tight">
            TotalFinance
            <span className="ml-2.5 hidden border-l border-fd-border pl-2.5 text-sm font-normal text-fd-muted-foreground sm:inline">
              by InsiderFinance
            </span>
          </span>
        </a>
        <nav
          aria-label="Documentation sections"
          className="ml-6 hidden items-center gap-6 text-sm md:flex"
        >
          {FAMILY.links.map((item) =>
            item.external ? (
              <a
                key={item.id}
                href={item.href}
                className="text-fd-muted-foreground transition-colors hover:text-fd-primary"
              >
                {item.label}
              </a>
            ) : (
              <Link
                key={item.id}
                href={item.href}
                aria-current="page"
                className="font-semibold text-fd-primary"
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href="/agents"
            className="mr-1 inline-flex h-9 items-center gap-1.5 rounded-lg border border-fd-primary/30 bg-fd-accent px-2.5 text-sm font-semibold text-fd-primary transition-colors hover:border-fd-primary/60"
            aria-label="Connect an AI agent"
          >
            <Bot className="size-4" aria-hidden />
            <span className="hidden lg:inline">Connect AI</span>
          </Link>
          <SearchButton />
          <ThemeToggle />
          <StarOnGitHub variant="header" className="ml-1" />
        </div>
      </div>
    </header>
  );
}
