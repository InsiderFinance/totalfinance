import { escapeHtml } from './render.js';

export const SITE_ORIGIN = 'https://totalfinance.io';
export const SOCIAL_IMAGE = `${SITE_ORIGIN}/assets/brand/og.png`;

/** Shared assets keep the homepage and proxied/versioned documentation recognizably TotalFinance. */
export function brandMetadata(input: {
  title: string;
  description: string;
  assetBase: string;
  canonicalUrl?: string;
}): string {
  return `<meta name="theme-color" content="#078754"/>
<link rel="icon" type="image/svg+xml" href="${input.assetBase}/favicon.svg"/>
<link rel="icon" type="image/png" sizes="32x32" href="${input.assetBase}/favicon-32.png"/>
<link rel="icon" type="image/x-icon" href="${input.assetBase}/favicon.ico"/>
<link rel="apple-touch-icon" sizes="180x180" href="${input.assetBase}/apple-touch-icon.png"/>
${input.canonicalUrl ? `<link rel="canonical" href="${escapeHtml(input.canonicalUrl)}"/><meta property="og:url" content="${escapeHtml(input.canonicalUrl)}"/>` : ''}
<meta property="og:type" content="website"/><meta property="og:site_name" content="TotalFinance"/>
<meta property="og:title" content="${escapeHtml(input.title)}"/>
<meta property="og:description" content="${escapeHtml(input.description)}"/>
<meta property="og:image" content="${SOCIAL_IMAGE}"/>
<meta property="og:image:type" content="image/png"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>
<meta property="og:image:alt" content="TotalFinance. The most complete finance toolkit. For developers and AI agents. Built with TypeScript. Run anywhere."/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${escapeHtml(input.title)}"/>
<meta name="twitter:description" content="${escapeHtml(input.description)}"/><meta name="twitter:image" content="${SOCIAL_IMAGE}"/>
<meta name="twitter:image:alt" content="TotalFinance. The most complete finance toolkit. For developers and AI agents. Built with TypeScript. Run anywhere."/>`;
}
