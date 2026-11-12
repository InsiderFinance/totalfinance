import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Braces,
  Calculator,
  FileSearch,
  Package,
  Sparkles,
} from 'lucide-react';
import { CopyButton } from '@/components/code/copy-button';
import { CodePanel } from '@/components/code/code-panel';
import { StarOnGitHub } from '@/components/brand/star-on-github';
import { ConnectAgent } from '@/components/agents/connect-agent';
import { DomainGrid } from '@/components/mdx/reference-widgets';
import { PlaygroundGallery } from '@/components/mdx/playground-gallery';
import { PlaygroundSection } from '@/components/playground/playground-section';
import { operations, referenceIndex } from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import {
  BASE_PATH,
  FAMILY,
  PACKAGE_NAME,
  PUBLIC_DOCS_URL,
  REPOSITORY_URL,
  SITE_ORIGIN,
} from '@/lib/site';
import { blackScholes } from '@insiderfinance/totalfinance/options';
import { createOperationRegistry, defaultOperations } from '@insiderfinance/totalfinance/workflows';

const homeMetadata = pageMetadata({
  title: 'TotalFinance — the complete finance library for TypeScript and AI agents',
  description:
    'Options, volatility, technical analysis, risk, valuation, fixed income and backtesting in one fully typed, dependency-free TypeScript package, with MCP tools for AI agents. Open source, by InsiderFinance.',
  route: '/',
});

export const metadata = {
  ...homeMetadata,
  alternates: { canonical: `${SITE_ORIGIN}/`, types: { 'text/markdown': `${BASE_PATH}/index.md` } },
  openGraph: { ...homeMetadata.openGraph, url: `${SITE_ORIGIN}/`, type: 'website' as const },
  title: { absolute: 'TotalFinance — the complete finance library for TypeScript and AI agents' },
};

/** One calculation, shown twice: as library code and as the MCP tool call an agent makes. */
const QUOTE_INPUT = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  volatility: 0.2,
  riskFreeRate: 0.04,
} as const;

const APP_CODE = `import { blackScholes } from '${PACKAGE_NAME}/options';

const quote = blackScholes.greeks.explain({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  volatility: 0.2,
  riskFreeRate: 0.04,
});`;

/**
 * Measured, not estimated: `blackScholesPriceMany` with `{ greeks: true }` over 1,000,000 rows,
 * median of seven runs on one thread of an Apple M4 with Node 26 (2026-10-15). Price alone: ~50 ms.
 */
const BENCHMARK_MS = 86;

const PROBLEM_ICONS = {
  package: Package,
  alert: AlertTriangle,
  trace: FileSearch,
  bot: Bot,
} as const;

/** Pains the target reader already has, each with what TotalFinance does about it. */
const PROBLEMS = [
  {
    icon: 'package',
    problem: 'Python has QuantLib. TypeScript has scattered packages.',
    answer:
      'So you port formulas from blog posts or run a Python service next to your app. TotalFinance covers options, volatility surfaces, technical analysis, risk, valuation, fixed income and backtesting in one package with no runtime dependencies.',
  },
  {
    icon: 'alert',
    problem: 'Wrong inputs don’t throw.',
    answer:
      'A percent where a decimal belongs, days where years belong: the answer still looks plausible. TotalFinance flags suspicious inputs with the likely fix, and impossible ones throw a typed error that names the field.',
  },
  {
    icon: 'trace',
    problem: 'You can’t defend a number you can’t trace.',
    answer:
      'Every explained result lists its assumptions (day count, compounding, conventions) and its diagnostics, so you can show your users, your team or an auditor where a number came from.',
  },
  {
    icon: 'bot',
    problem: 'Your AI agent makes up the math.',
    answer:
      'Connect TotalFinance over MCP and your agent calls tested calculations instead of guessing, and reads these docs to write code against the real API.',
  },
] as const;

function Pillar({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="py-6 sm:px-6 lg:first:pl-0">
      <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-fd-primary">{title}</dt>
      <dd className="mt-2 font-display text-2xl font-semibold tracking-tight">{value}</dd>
      <dd className="mt-1 text-sm leading-6 text-fd-muted-foreground">{detail}</dd>
    </div>
  );
}

export default function HomePage() {
  const index = referenceIndex();
  // Both panels are computed by the library at build time.
  const quote = blackScholes.greeks.explain(QUOTE_INPUT);
  const appOutput = JSON.stringify(
    {
      value: Object.fromEntries(
        Object.entries(quote.value).map(([key, value]) => [key, Number(value.toFixed(6))]),
      ),
      assumptions: {
        dayCount: quote.assumptions.dayCount,
        compounding: quote.assumptions.compounding,
        units: quote.assumptions.units,
      },
    },
    null,
    2,
  );
  const toolCall = createOperationRegistry({ operations: defaultOperations() }).run({
    id: 'totalfinance.option.greeks',
    input: QUOTE_INPUT,
  });
  const agentOutput = JSON.stringify(
    {
      tool: 'totalfinance_option_greeks',
      arguments: QUOTE_INPUT,
      result: {
        summary: toolCall.summary,
        assumptions: { dayCount: toolCall.assumptions['dayCount'] },
      },
    },
    null,
    2,
  );
  const domainCount = index.domains.filter((domain) => domain.slug !== 'index').length;
  const defaultTools = operations().filter((operation) => operation.defaultEnabled).length;
  return (
    <div>
      <section className="relative overflow-hidden border-b border-fd-border">
        <div aria-hidden className="tf-hero-grid pointer-events-none absolute inset-0" />
        <div className="relative mx-auto grid max-w-[88rem] gap-12 px-5 pb-16 pt-14 sm:px-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:px-10 lg:pb-20 lg:pt-20">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-background/80 px-3 py-1 text-xs font-medium text-fd-muted-foreground backdrop-blur">
              <span className="size-1.5 rounded-full bg-[var(--color-profit)]" aria-hidden />
              Open source · by{' '}
              <a href={FAMILY.home} className="text-fd-foreground hover:text-fd-primary">
                InsiderFinance
              </a>
            </p>
            <h1 className="mt-6 font-display text-[2.6rem] font-semibold leading-[1.04] tracking-[-0.035em] text-balance sm:text-6xl">
              The complete finance library for TypeScript and{' '}
              <span className="text-fd-primary">AI agents.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-fd-muted-foreground text-pretty">
              Most quant work still means a Python service or an npm package nobody maintains.
              TotalFinance puts options, volatility, technical analysis, risk, valuation, fixed
              income and backtesting in one fully typed package with no runtime dependencies. It
              runs in Node, browsers and edge workers, and your AI agent can call it as tools.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={`${PUBLIC_DOCS_URL}/start`}
                className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground shadow-sm transition-colors hover:bg-[var(--color-brand-hover)]"
              >
                Get started <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link
                href={`${PUBLIC_DOCS_URL}/agents`}
                className="inline-flex items-center gap-2 rounded-xl border border-fd-primary/40 bg-fd-accent px-5 py-3 text-sm font-semibold text-fd-primary transition-colors hover:border-fd-primary"
              >
                <Bot className="size-4" aria-hidden /> Connect your AI agent
              </Link>
              <StarOnGitHub />
            </div>
            <div className="mt-8 flex max-w-md items-center justify-between gap-3 rounded-xl border border-fd-border bg-fd-muted py-1.5 pl-4 pr-1.5 font-mono text-sm">
              <span className="truncate">
                <span className="select-none text-fd-muted-foreground">$ </span>pnpm add{' '}
                {PACKAGE_NAME}
              </span>
              <CopyButton text={`pnpm add ${PACKAGE_NAME}`} tone="light" />
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            <CodePanel
              code={APP_CODE}
              title="In your app"
              height=""
              actions={
                <span className="mr-1 hidden text-[0.6875rem] text-panel-muted sm:inline">
                  TypeScript
                </span>
              }
            />
            <CodePanel code={appOutput} lang="json" title="quote" height="max-h-[13rem]" />
            <CodePanel
              code={agentOutput}
              lang="json"
              title="In your AI agent: the same math as an MCP tool"
              height=""
              wrap
            />
          </div>
        </div>
      </section>

      <section aria-label="Why TotalFinance" className="border-b border-fd-border">
        <dl className="mx-auto grid max-w-[88rem] grid-cols-1 divide-y divide-fd-border px-5 sm:grid-cols-2 sm:divide-y-0 sm:px-8 lg:grid-cols-4 lg:divide-x lg:px-10">
          <Pillar
            title="Complete"
            value={`${domainCount} modules`}
            detail={`${index.totals.exportPaths.toLocaleString('en-US')} documented exports, from Black–Scholes to backtests`}
          />
          <Pillar
            title="Fast"
            value={`${BENCHMARK_MS} ms`}
            detail="to price 1,000,000 options with all five Greeks, on one thread*"
          />
          <Pillar
            title="TypeScript-native"
            value="0 dependencies"
            detail="Fully typed, explicit units, typed errors; Node, browsers and edge"
          />
          <Pillar
            title="Agent-ready"
            value={`${operations().length} MCP tools`}
            detail="plus these docs as an MCP server, llms.txt and Markdown pages"
          />
        </dl>
        <p className="mx-auto max-w-[88rem] px-5 pb-4 text-[0.6875rem] text-fd-muted-foreground sm:px-8 lg:px-10">
          * <code>blackScholesPriceMany</code> with Greeks, median of seven runs on an Apple M4 with
          Node 26. Prices alone take about 50 ms.
        </p>
      </section>

      <section
        aria-labelledby="problems-heading"
        className="mx-auto max-w-[88rem] px-5 py-16 sm:px-8 lg:px-10 lg:py-20"
      >
        <div className="max-w-2xl">
          <p className="tf-eyebrow">Sound familiar?</p>
          <h2
            id="problems-heading"
            className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Finance code fails quietly. TotalFinance makes it speak up.
          </h2>
        </div>
        <div className="mt-10 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {PROBLEMS.map((item) => {
            const Icon = PROBLEM_ICONS[item.icon];
            return (
              <div key={item.problem} className="flex gap-4">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-fd-accent text-fd-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h3 className="font-display text-lg font-semibold">{item.problem}</h3>
                  <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{item.answer}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby="agents-heading"
        className="border-b border-fd-border bg-fd-muted/60"
      >
        <div className="mx-auto grid max-w-[88rem] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:px-10 lg:py-20">
          <div>
            <p className="tf-eyebrow">Built for AI agents</p>
            <h2
              id="agents-heading"
              className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
            >
              Give your agent a calculator it can trust.
            </h2>
            <p className="mt-4 text-fd-muted-foreground">
              Language models guess at arithmetic and at APIs. Connect TotalFinance over MCP and
              your agent calls tested calculations that report their assumptions, and writes code
              against the real API.
            </p>
            <ul className="mt-6 space-y-4 text-sm leading-6 text-fd-muted-foreground">
              <li className="flex gap-3">
                <Calculator className="mt-0.5 size-5 shrink-0 text-fd-primary" aria-hidden />
                <span>
                  <strong className="text-fd-foreground">Calculations on your machine.</strong>{' '}
                  {defaultTools} read-only tools by default, {operations().length} with profiles:
                  pricing, Greeks, strategies, volatility, indicators, risk, bonds and backtests.
                  Your data never leaves your computer.
                </span>
              </li>
              <li className="flex gap-3">
                <Braces className="mt-0.5 size-5 shrink-0 text-fd-primary" aria-hidden />
                <span>
                  <strong className="text-fd-foreground">These docs as tools.</strong> A hosted docs
                  MCP lets the agent search, read pages and fetch any export&apos;s exact contract.
                  Nothing to install.
                </span>
              </li>
              <li className="flex gap-3">
                <Sparkles className="mt-0.5 size-5 shrink-0 text-fd-primary" aria-hidden />
                <span>
                  <strong className="text-fd-foreground">Context-ready docs.</strong>{' '}
                  <a
                    href={`${PUBLIC_DOCS_URL}/llms.txt`}
                    className="font-medium text-fd-primary hover:underline"
                  >
                    llms.txt
                  </a>
                  , per-domain bundles and a Markdown version of every page.
                </span>
              </li>
              <li className="flex gap-3">
                <Bot className="mt-0.5 size-5 shrink-0 text-fd-primary" aria-hidden />
                <span>
                  <strong className="text-fd-foreground">A prompt on every calculator.</strong> Each
                  one shows the tool your agent calls and a prompt built from your inputs.
                </span>
              </li>
            </ul>
            <Link
              href={`${PUBLIC_DOCS_URL}/agents`}
              className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-fd-primary hover:underline"
            >
              Everything for agents <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <ConnectAgent />
        </div>
      </section>

      <section className="mx-auto max-w-[88rem] px-5 py-16 sm:px-8 lg:px-10 lg:py-20">
        <div className="mb-8 max-w-2xl">
          <p className="tf-eyebrow">Try it live</p>
          <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">
            Drag a slider. Watch the library answer.
          </h2>
          <p className="mt-3 text-fd-muted-foreground">
            This calculator runs the real package in your browser. Results, charts and the copyable
            TypeScript all follow your inputs.
          </p>
        </div>
        <PlaygroundSection id="price-an-option" docsBaseUrl={PUBLIC_DOCS_URL} />
      </section>

      <section className="border-y border-fd-border bg-fd-muted">
        <div className="mx-auto max-w-[88rem] px-5 py-16 sm:px-8 lg:px-10 lg:py-20">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="tf-eyebrow">Ten calculators</p>
              <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">
                Bring your own data. Keep the code.
              </h2>
              <p className="mt-3 text-fd-muted-foreground">
                Paste or upload your own prices into the backtest, indicator and risk calculators.
                Every result comes with the exact TypeScript that reproduces it, tested in CI.
              </p>
            </div>
            <Link
              href={`${PUBLIC_DOCS_URL}/playgrounds`}
              className="text-sm font-semibold text-fd-primary hover:underline"
            >
              All calculators →
            </Link>
          </div>
          <PlaygroundGallery exclude={['price-an-option']} docsBaseUrl={PUBLIC_DOCS_URL} />
        </div>
      </section>

      <section className="mx-auto max-w-[88rem] px-5 py-16 sm:px-8 lg:px-10 lg:py-20">
        <div className="mb-2 max-w-2xl">
          <p className="tf-eyebrow">Everything in one package</p>
          <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">
            The finance library, tree-shakeable.
          </h2>
        </div>
        <DomainGrid docsBaseUrl={PUBLIC_DOCS_URL} />
      </section>

      <section aria-labelledby="star-heading" className="px-5 pb-6 sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[88rem] flex-col items-start justify-between gap-6 rounded-3xl border border-fd-border bg-fd-muted/60 p-8 sm:p-10 lg:flex-row lg:items-center">
          <div className="max-w-2xl">
            <p className="tf-eyebrow">Open source</p>
            <h2
              id="star-heading"
              className="mt-2 font-display text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Help TypeScript developers find TotalFinance.
            </h2>
            <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
              TotalFinance is new and built in the open. If it saves you a Python service or a week
              of porting formulas, a star on GitHub helps the next developer find it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StarOnGitHub />
            <a
              href={`${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`}
              className="px-2 py-3 text-sm font-medium text-fd-muted-foreground hover:text-fd-foreground"
            >
              Contribute ↗
            </a>
          </div>
        </div>
      </section>

      <section className="px-5 pb-20 sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[88rem] flex-col items-start justify-between gap-6 rounded-3xl bg-panel p-8 text-panel-foreground sm:p-10 lg:flex-row lg:items-center">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#a8eac6]">
              From InsiderFinance
            </p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              TotalFinance computes. InsiderFinance brings the data.
            </h2>
            <p className="mt-3 text-sm leading-6 text-panel-muted">
              Options flow, dark pool prints and market data from {FAMILY.data.label}, ready to feed
              straight into the calculations on this site.
            </p>
          </div>
          <a
            href={FAMILY.data.href}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
          >
            Explore {FAMILY.data.label} <ArrowRight className="size-4" aria-hidden />
          </a>
        </div>
      </section>
    </div>
  );
}
