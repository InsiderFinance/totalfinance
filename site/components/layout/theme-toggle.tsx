'use client';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { useEffect, useState } from 'react';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className={`inline-flex size-9 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-secondary hover:text-fd-foreground ${className}`}
      aria-label={mounted ? `Switch to ${dark ? 'light' : 'dark'} theme` : 'Toggle theme'}
      title="Toggle theme (D)"
    >
      {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  );
}
