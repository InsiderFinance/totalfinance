import { options } from './playgrounds/options.js';
import { escapeHtml, formatNumber, renderChart } from './render.js';
import { docsUrl } from '../paths.js';
import { brandMetadata, SITE_ORIGIN } from './brand.js';

/** The same first call and sample calculation used by the installed-package playground proof. */
export function renderHomepage(): string {
  const calculation = options.run(
    Object.fromEntries(options.controls.map((control) => [control.name, control.value])),
  );
  const capabilities = [
    [
      '01',
      'Options & volatility',
      'Price options, inspect Greeks, solve implied volatility, and explore volatility surfaces.',
      '/learn/price-an-option/',
      'Price an option',
    ],
    [
      '02',
      'Strategies & portfolios',
      'Model payoffs, compare scenarios, and reconcile portfolio profit and loss.',
      '/learn/analyze-a-strategy/',
      'Explore a strategy',
    ],
    [
      '03',
      'Research & risk',
      'Backtest a hypothesis with explicit costs, then examine performance and drawdowns.',
      '/learn/backtest-a-strategy/',
      'Run a backtest',
    ],
    [
      '04',
      'Valuation & beyond',
      'Work with company cash flows, fixed income, market structure, and technical indicators.',
      '/learn/value-a-company/',
      'Value a company',
    ],
  ] as const;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>TotalFinance — Finance, in your code.</title>
<meta name="description" content="A TypeScript finance toolkit for options, portfolios, valuation, research and risk. Local calculations, explicit inputs, and answers you can inspect."/>
${brandMetadata({ title: 'TotalFinance — The most complete finance toolkit.', description: 'For developers and AI agents. Built with TypeScript. Run anywhere.', assetBase: '/assets/brand', canonicalUrl: `${SITE_ORIGIN}/` })}
<link rel="stylesheet" href="${docsUrl('/assets/styles.css')}"/><link rel="stylesheet" href="/assets/homepage.css"/>
<script type="module" src="${docsUrl('/assets/client.js')}"></script></head>
<body class="landing"><a class="skip" href="#main">Skip to content</a>
<header class="landing-header"><a class="landing-brand" href="/" aria-label="TotalFinance home"><img class="landing-mark" src="/assets/brand/logo.svg" width="44" height="44" alt=""/>TotalFinance</a>
<nav aria-label="Main navigation"><a href="#capabilities">Capabilities</a><a href="${docsUrl('/')}">Documentation</a><a class="repo-link" href="https://github.com/InsiderFinance/totalfinance">GitHub <span aria-hidden="true">↗</span></a></nav></header>
<main id="main">
<section class="landing-hero" aria-labelledby="hero-title"><div class="hero-copy"><p class="landing-eyebrow"><span class="status-dot" aria-hidden="true"></span> THE TYPESCRIPT FINANCE TOOLKIT</p>
<h1 id="hero-title">Finance,<br/>in your <span>code.</span></h1>
<p class="hero-description">From an option price to a portfolio.<br/>Build with financial calculations that speak TypeScript, run locally, and show their assumptions.</p>
<div class="landing-actions"><a class="landing-button" href="${docsUrl('/guides/start/')}">Start building <span aria-hidden="true">↗</span></a><a class="landing-text-link" href="${docsUrl('/reference/')}">Explore the API <span aria-hidden="true">→</span></a></div>
<p class="hero-footnote">Open source. Apache-2.0. Browser & Node.js.</p></div>
<div class="code-window"><div class="code-window-bar"><span><span class="file-dot" aria-hidden="true"></span> price-an-option.ts</span><button type="button" data-copy="homepage-example">Copy code</button></div>
<pre><code id="homepage-example">${escapeHtml(calculation.example.code)}</code></pre>
<div class="code-result"><span><span class="status-dot" aria-hidden="true"></span> Calculated locally</span><strong>${escapeHtml(formatNumber(calculation.example.result as number))}<small> USD / share</small></strong><p>European call · Black–Scholes–Merton<br/>Hypothetical inputs. No market data required.</p></div></div></section>
<div class="principle-strip" aria-label="Library principles"><span><span aria-hidden="true">↳</span> Typed inputs. Clear units.</span><span><span aria-hidden="true">↳</span> Your data. Local compute.</span><span><span aria-hidden="true">↳</span> Assumptions you can inspect.</span></div>
<section id="capabilities" class="landing-section" aria-labelledby="capabilities-title"><div class="section-intro"><p class="landing-eyebrow">A CONNECTED TOOLKIT</p><h2 id="capabilities-title">Small calls.<br/>A wider view.</h2><p>Start with one calculation. Keep the same language as your questions grow.</p></div>
<div class="capability-list">${capabilities.map(([number, title, description, path, label]) => `<article><span class="capability-number">${number}</span><div><h3>${title}</h3><p>${description}</p><a href="${docsUrl(path)}">${label} <span aria-hidden="true">↗</span></a></div></article>`).join('')}</div></section>
<section class="calculation-section" aria-labelledby="calculation-title"><div class="calculation-copy"><p class="landing-eyebrow">FOLLOW THE CALCULATION</p><h2 id="calculation-title">An answer.<br/>And the reasons<br/>behind it.</h2><p>A price only means something alongside its inputs and model. Explore the same sample across underlying prices, then inspect the full assumptions, diagnostics, and Greeks in the playground.</p><a class="landing-text-link" href="${docsUrl('/learn/price-an-option/')}">Open the interactive example <span aria-hidden="true">↗</span></a><p class="sample-note">Illustrative model prices, not market quotes or a forecast.</p></div><div class="homepage-chart">${renderChart(calculation.chart)}</div></section>
<section class="landing-section integration-section" aria-labelledby="integration-title"><div class="section-intro"><p class="landing-eyebrow">MEET YOUR NEXT QUESTION</p><h2 id="integration-title">Your workflow.<br/>The same math.</h2></div><div class="integration-copy"><p>Use named imports in your application, explore a calculation in the browser, or connect an agent through the optional MCP server. The library supplies the calculations; you supply the data.</p><div class="integration-links"><a href="${docsUrl('/guides/start/')}"><span>For developers</span>Make your first call <span aria-hidden="true">↗</span></a><a href="${docsUrl('/agents/')}"><span>For agents</span>Tools, setup & permissions <span aria-hidden="true">↗</span></a></div><p class="sample-note">Pre-1.0 software. See <a href="${docsUrl('/versions/')}">versions & stability</a> for this build's release status and MCP availability.</p></div></section>
<section class="landing-cta" aria-labelledby="cta-title"><p class="landing-eyebrow">START WITH A QUESTION</p><h2 id="cta-title">What will you<br/>calculate?</h2><a class="landing-button" href="${docsUrl('/')}">Find your first calculation <span aria-hidden="true">↗</span></a></section>
</main><footer class="landing-footer"><div><a class="landing-brand" href="/"><img class="landing-mark" src="/assets/brand/logo.svg" width="36" height="36" alt=""/>TotalFinance</a><p>A TypeScript toolkit by <a href="https://www.insiderfinance.io/">InsiderFinance</a>.</p></div><nav aria-label="Footer navigation"><a href="${docsUrl('/')}">Documentation</a><a href="https://github.com/InsiderFinance/totalfinance">GitHub ↗</a><a href="${docsUrl('/guides/security/')}">Security</a><a href="${docsUrl('/versions/')}">Versions & stability</a></nav><p class="footer-legal">Apache-2.0 · Analytics are not investment advice.</p></footer>
</body></html>`;
}
