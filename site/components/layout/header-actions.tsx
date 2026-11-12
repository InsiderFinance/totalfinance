'use client';
import { Menu, Search } from 'lucide-react';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { useEffect, useState } from 'react';
import { useNav } from './nav-context';

export function SearchButton() {
  const { setOpenSearch } = useSearchContext();
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpenSearch(true)}
        className="hidden h-9 w-64 items-center gap-2 rounded-lg border border-fd-border bg-fd-muted px-3 text-sm text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground md:flex lg:w-72"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate whitespace-nowrap text-left">Search docs…</span>
        <kbd className="tf-kbd">{mac ? '⌘' : 'Ctrl'}</kbd>
        <kbd className="tf-kbd -ml-1">K</kbd>
      </button>
      <button
        type="button"
        onClick={() => setOpenSearch(true)}
        className="inline-flex size-9 items-center justify-center rounded-lg text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground md:hidden"
        aria-label="Search"
      >
        <Search className="size-4" aria-hidden />
      </button>
    </>
  );
}

export function MenuButton() {
  const { mobileOpen, setMobileOpen } = useNav();
  return (
    <button
      type="button"
      onClick={() => setMobileOpen(!mobileOpen)}
      className="inline-flex size-9 items-center justify-center rounded-lg text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground lg:hidden"
      aria-label="Open navigation"
      aria-expanded={mobileOpen}
      aria-controls="tf-mobile-navigation"
    >
      <Menu className="size-5" aria-hidden />
    </button>
  );
}
