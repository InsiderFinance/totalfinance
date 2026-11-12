// @ts-check
/* global process, URL */
import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

/**
 * Static export under a base path, so the site can be served as a zone of
 * https://www.insiderfinance.io (multi-zone rewrite) or from any static host.
 * The build orchestrator (`site/build.ts`) owns these environment variables.
 */
const basePath = process.env.TOTALFINANCE_DOCS_BASE_PATH ?? '/docs/totalfinance';
if (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/')))
  throw new Error('TOTALFINANCE_DOCS_BASE_PATH must be empty or start, but not end, with "/".');

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath,
  // No trailing slashes, like the InsiderFinance app that hosts this zone: its Next.js redirects
  // `/x/` to `/x` before rewrites run, so a trailing-slash zone would redirect forever.
  trailingSlash: false,
  reactStrictMode: true,
  distDir: process.env.TOTALFINANCE_NEXT_DIST_DIR ?? '.next',
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  env: { NEXT_PUBLIC_TOTALFINANCE_DOCS_BASE_PATH: basePath },
  // The site consumes the built package through a link outside this directory.
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
};

export default createMDX()(config);
