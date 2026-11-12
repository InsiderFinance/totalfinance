'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { NavGroup, NavTab } from '@/lib/navigation';
import { sitePath } from '@/src/routes';
import { useNav } from './nav-context';

export interface SidebarProps {
  tabs: Pick<NavTab, 'id' | 'title' | 'url' | 'description'>[];
  active: NavTab['id'];
  groups: NavGroup[];
  versionLabel: string;
  repositoryUrl: string;
  packageUrl: string;
  data: { label: string; href: string };
  llmsUrl: string;
  /** Render the fixed desktop sidebar (pages like the home page use only the mobile drawer). */
  desktop?: boolean;
}

const normalize = (path: string) => sitePath(path);

function Group({
  group,
  pathname,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  onNavigate: () => void;
}) {
  const containsActive = group.links.some((link) => normalize(link.url) === pathname);
  const [open, setOpen] = useState(!group.collapsible || containsActive);
  const id = useId();
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  const list = (
    <ul id={id} className="tf-nav-list">
      {group.links.map((link) => {
        const active = normalize(link.url) === pathname;
        return (
          <li key={link.url}>
            <Link
              href={link.url}
              prefetch={false}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              data-active={active || undefined}
              className="tf-nav-link"
            >
              {link.badge ? <span className="tf-nav-badge">{link.badge}</span> : null}
              <span>{link.title}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="mb-5">
      {group.collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={id}
          className="tf-nav-group tf-nav-toggle"
        >
          {group.title}
          <ChevronRight
            className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </button>
      ) : (
        <p className="tf-nav-group">{group.title}</p>
      )}
      {/* Closed groups render no links: the data is already on the page, the markup is not needed. */}
      {open ? list : null}
    </div>
  );
}

function SidebarContent({
  tabs,
  active: current,
  groups,
  versionLabel,
  repositoryUrl,
  packageUrl,
  data,
  llmsUrl,
  onNavigate,
}: SidebarProps & { onNavigate: () => void }) {
  const pathname = normalize(usePathname() ?? '/');
  const tab = tabs.find((candidate) => candidate.id === current) ?? tabs[0]!;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = scroller.current;
    const active = container?.querySelector<HTMLElement>('[data-active]');
    if (!container || !active) return;
    // Scroll the list itself, not `scrollIntoView`: Chromium moves the Tab starting point to a
    // scrolled-into-view element, so the first Tab would skip the skip link and the header.
    const box = container.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < box.top) container.scrollTop -= box.top - item.top + 8;
    else if (item.bottom > box.bottom) container.scrollTop += item.bottom - box.bottom + 8;
  }, [pathname]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-fd-border px-4 py-4">
        <nav
          aria-label="Project resources"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-10 text-xs text-fd-muted-foreground lg:pr-0"
        >
          <Link
            href="/versions"
            onClick={onNavigate}
            className="rounded-full bg-fd-secondary px-2 py-0.5 font-medium hover:text-fd-primary"
            aria-label={`TotalFinance versions (${versionLabel})`}
          >
            {versionLabel}
          </Link>
          <a href={repositoryUrl} className="hover:text-fd-primary">
            GitHub
          </a>
          <a href={packageUrl} className="hover:text-fd-primary">
            npm
          </a>
        </nav>
        <nav
          aria-label="Documentation areas"
          className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-fd-secondary p-1"
        >
          {tabs.map((candidate) => (
            <Link
              key={candidate.id}
              href={candidate.url}
              onClick={onNavigate}
              aria-current={candidate.id === current ? 'true' : undefined}
              title={candidate.description}
              className={`rounded-lg px-2 py-1.5 text-center text-xs font-semibold transition-colors ${
                candidate.id === current
                  ? 'bg-fd-background text-fd-foreground shadow-sm ring-1 ring-fd-border'
                  : 'text-fd-muted-foreground hover:text-fd-foreground'
              }`}
            >
              {candidate.title}
            </Link>
          ))}
        </nav>
      </div>
      <div ref={scroller} className="tf-scrollbar min-h-0 flex-1 overflow-y-auto px-2.5 py-5">
        <nav aria-label={`${tab.title} navigation`}>
          {groups.map((group) => (
            <Group
              key={`${tab.id}-${group.title}`}
              group={group}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      </div>
      <div className="space-y-3 border-t border-fd-border px-4 py-4 text-xs">
        <a
          href={data.href}
          className="block rounded-xl border border-fd-border bg-fd-muted p-3 transition-colors hover:border-fd-primary/40"
        >
          <span className="block font-semibold text-fd-foreground">Need market data?</span>
          <span className="mt-0.5 block leading-5 text-fd-muted-foreground">
            TotalFinance computes on data you supply. {data.label} provides options flow, dark pool
            and market data. ↗
          </span>
        </a>
        <div className="text-fd-muted-foreground">
          <a href={llmsUrl} className="hover:text-fd-primary">
            llms.txt
          </a>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ desktop = true, ...props }: SidebarProps) {
  const { mobileOpen, setMobileOpen } = useNav();
  const dialog = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (mobileOpen && !element.open) element.showModal();
    if (!mobileOpen && element.open) element.close();
  }, [mobileOpen]);
  useEffect(() => setMobileOpen(false), [pathname, setMobileOpen]);
  return (
    <>
      {desktop ? (
        <aside className="fixed bottom-0 left-0 top-(--tf-header-height) z-30 hidden w-(--tf-sidebar-width) border-r border-fd-border bg-fd-background lg:block">
          <SidebarContent {...props} onNavigate={() => undefined} />
        </aside>
      ) : null}
      <dialog
        ref={dialog}
        id="tf-mobile-navigation"
        aria-label="Documentation navigation"
        onClose={() => setMobileOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setMobileOpen(false);
        }}
        className={`m-0 h-dvh max-h-dvh w-[min(22rem,88vw)] max-w-none bg-fd-background p-0 text-fd-foreground shadow-2xl backdrop:bg-slate-950/50 backdrop:backdrop-blur-sm ${desktop ? 'lg:hidden' : ''}`}
      >
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="absolute right-3 top-4 z-10 inline-flex size-9 items-center justify-center rounded-lg text-fd-muted-foreground hover:bg-fd-secondary"
          aria-label="Close navigation"
        >
          <X className="size-5" aria-hidden />
        </button>
        {mobileOpen ? <SidebarContent {...props} onNavigate={() => setMobileOpen(false)} /> : null}
      </dialog>
    </>
  );
}
