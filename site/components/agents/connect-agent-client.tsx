'use client';
import { Download, Laptop, Cloud, Terminal } from 'lucide-react';
import { useId, useState } from 'react';
import type { ClientSetup, McpServerSpec, SetupStep } from '@/src/agents';
import { Code } from '../code/code';
import { CopyButton } from '../code/copy-button';

export interface ConnectServer {
  server: McpServerSpec;
  setups: ClientSetup[];
}

const SERVER_ICON = { compute: Laptop, docs: Cloud, hosted: Cloud } as const;
const SERVER_TAG = {
  compute: 'Runs on your machine',
  docs: 'Hosted · nothing to install',
  hosted: 'Hosted · nothing to install',
} as const;

function Step({ step }: { step: SetupStep }) {
  if (step.kind === 'note')
    return <p className="text-sm leading-6 text-fd-muted-foreground">{step.text}</p>;
  const title = step.kind === 'file' ? step.path : step.label;
  return (
    <div className="space-y-1.5">
      {step.kind === 'file' ? (
        <p className="text-xs text-fd-muted-foreground">{step.label}</p>
      ) : null}
      <figure className="tf-code not-prose">
        <figcaption className="tf-code-bar">
          <span className="flex min-w-0 items-center gap-1.5 truncate font-mono">
            {step.kind === 'command' ? (
              <Terminal className="size-3.5 shrink-0" aria-hidden />
            ) : null}
            {title}
          </span>
          <CopyButton text={step.code} />
        </figcaption>
        <div className="tf-code-body max-h-80">
          <Code
            code={step.code}
            lang={step.kind === 'file' && step.lang === 'json' ? 'json' : 'sh'}
          />
        </div>
      </figure>
    </div>
  );
}

/**
 * Pick a server, pick your client, copy one thing. The first server and client render on the
 * server, so the setup is readable without JavaScript.
 */
export function ConnectAgentClient({
  servers,
  sourceBuild,
}: {
  servers: ConnectServer[];
  sourceBuild: string;
}) {
  const id = useId();
  const [serverIndex, setServerIndex] = useState(0);
  const [clientId, setClientId] = useState(servers[0]!.setups[0]!.client);
  const { server, setups } = servers[serverIndex]!;
  const setup = setups.find((candidate) => candidate.client === clientId) ?? setups[0]!;
  return (
    <div className="not-prose overflow-hidden rounded-2xl border border-fd-border bg-fd-card">
      {servers.length > 1 ? (
        <div
          role="group"
          aria-label="What to connect"
          className="grid gap-px border-b border-fd-border bg-fd-border sm:grid-cols-[repeat(auto-fit,minmax(0,1fr))]"
        >
          {servers.map((option, index) => {
            const Icon = SERVER_ICON[option.server.id];
            const selected = index === serverIndex;
            return (
              <button
                key={option.server.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setServerIndex(index)}
                className={`flex items-start gap-3 px-5 py-4 text-left transition-colors ${
                  selected ? 'bg-fd-card' : 'bg-fd-muted text-fd-muted-foreground hover:bg-fd-card'
                }`}
              >
                <span
                  className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg ${
                    selected ? 'bg-fd-primary text-white' : 'bg-fd-secondary'
                  }`}
                >
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-[0.9375rem] font-semibold text-fd-foreground">
                    {option.server.title}
                  </span>
                  <span className="block text-xs">{SERVER_TAG[option.server.id]}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="space-y-5 p-5 sm:p-6">
        <p className="max-w-3xl text-sm leading-6 text-fd-muted-foreground">{server.summary}</p>
        <div
          role="tablist"
          aria-label="Your AI client"
          className="tf-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
          onKeyDown={(event) => {
            // Arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
            const current = setups.findIndex((candidate) => candidate.client === setup.client);
            const next =
              event.key === 'ArrowRight'
                ? (current + 1) % setups.length
                : event.key === 'ArrowLeft'
                  ? (current - 1 + setups.length) % setups.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? setups.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            setClientId(setups[next]!.client);
            document.getElementById(`${id}-${setups[next]!.client}`)?.focus();
          }}
        >
          {setups.map((candidate) => {
            const selected = candidate.client === setup.client;
            return (
              <button
                key={candidate.client}
                type="button"
                role="tab"
                id={`${id}-${candidate.client}`}
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setClientId(candidate.client)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  selected
                    ? 'bg-fd-primary text-white'
                    : 'text-fd-muted-foreground hover:bg-fd-secondary hover:text-fd-foreground'
                }`}
              >
                {candidate.label}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-${setup.client}`}
          className="space-y-4"
        >
          {server.id === 'compute' && !server.installable ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-6">
              <p>
                <strong>Not on npm yet.</strong> Build the server once from a source checkout, then
                point your client at <code>distribution/mcp/dist/bin.js</code> as below. When the
                package is published, this becomes a one-line <code>npx</code> command.
              </p>
              <figure className="tf-code mt-3">
                <figcaption className="tf-code-bar">
                  <span>Build from source (Node 22.13+, pnpm)</span>
                  <CopyButton text={sourceBuild} />
                </figcaption>
                <div className="tf-code-body">
                  <Code code={sourceBuild} lang="sh" />
                </div>
              </figure>
            </div>
          ) : null}
          {setup.install ? (
            <a
              href={setup.install.href}
              className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[var(--color-brand-hover)]"
            >
              <Download className="size-4" aria-hidden /> {setup.install.label}
            </a>
          ) : null}
          {setup.steps.map((step, index) => (
            <Step key={`${setup.client}-${index}`} step={step} />
          ))}
        </div>
      </div>
    </div>
  );
}
