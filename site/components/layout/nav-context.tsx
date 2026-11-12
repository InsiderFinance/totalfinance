'use client';
import { createContext, use, useMemo, useState, type ReactNode } from 'react';

interface NavContextValue {
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const NavContext = createContext<NavContextValue | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const value = useMemo(() => ({ mobileOpen, setMobileOpen }), [mobileOpen]);
  return <NavContext value={value}>{children}</NavContext>;
}

export function useNav(): NavContextValue {
  const context = use(NavContext);
  if (!context) throw new Error('useNav must be used inside <NavProvider>.');
  return context;
}
