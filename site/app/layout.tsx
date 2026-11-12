import './global.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { NavProvider } from '@/components/layout/nav-context';
import { SiteHeader } from '@/components/layout/site-header';
import { TfSearchDialog } from '@/components/search/search-dialog';
import { siteVersion } from '@/lib/data';
import { indexable } from '@/lib/metadata';
import { BASE_PATH, SITE_URL } from '@/lib/site';

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(`${SITE_URL}/`),
    title: {
      default: 'TotalFinance — TypeScript finance by InsiderFinance',
      template: '%s · TotalFinance',
    },
    description:
      'Open-source TypeScript finance: options, strategies, technical analysis, risk, valuation, fixed income and backtesting, with explicit units, assumptions and diagnostics.',
    applicationName: 'TotalFinance',
    robots: indexable() ? { index: true, follow: true } : { index: false, follow: true },
    icons: {
      icon: [
        { url: `${BASE_PATH}/assets/brand/favicon.svg`, type: 'image/svg+xml' },
        { url: `${BASE_PATH}/assets/brand/favicon-32.png`, type: 'image/png', sizes: '32x32' },
        { url: `${BASE_PATH}/assets/brand/favicon.ico` },
      ],
      apple: `${BASE_PATH}/assets/brand/apple-touch-icon.png`,
    },
    referrer: 'strict-origin-when-cross-origin',
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#090c13' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const version = siteVersion();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-tf-base={BASE_PATH}
      data-tf-version={version.version}
    >
      <body className="min-h-screen">
        <a
          href="#tf-main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-fd-background focus:px-4 focus:py-2 focus:shadow-lg"
        >
          Skip to content
        </a>
        <RootProvider
          search={{ SearchDialog: TfSearchDialog, preload: false }}
          theme={{ defaultTheme: 'system' }}
        >
          <NavProvider>
            <SiteHeader />
            {children}
          </NavProvider>
        </RootProvider>
      </body>
    </html>
  );
}
