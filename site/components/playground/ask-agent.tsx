'use client';
import { ArrowRight, Bot } from 'lucide-react';
import Link from 'next/link';
import { CALCULATOR_AGENTS } from '@/src/playgrounds/agent';
import type { PlaygroundInput } from '@/src/types';
import { CopyButton } from '../code/copy-button';

/**
 * The same calculation, asked of an AI agent: the MCP tool that performs it and a prompt built
 * from the inputs of the last successful calculation.
 */
export function AskAgent({ id, input }: { id: string; input: PlaygroundInput }) {
  const agent = CALCULATOR_AGENTS[id];
  if (!agent) return null;
  const prompt = agent.prompt(input);
  const tool = agent.operation?.replaceAll('.', '_');
  return (
    <section aria-labelledby="ask-agent-heading" className="space-y-4">
      <div>
        <h2
          id="ask-agent-heading"
          className="flex items-center gap-2 font-display text-xl font-semibold tracking-tight"
        >
          <Bot className="size-5 text-fd-primary" aria-hidden /> Ask your AI agent
        </h2>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-fd-muted-foreground">
          {tool ? (
            <>
              With the TotalFinance MCP server connected, your agent runs this calculation with the{' '}
              <code>{tool}</code> tool
              {agent.profile ? (
                <>
                  {' '}
                  (start the server with <code>--profile {agent.profile}</code>)
                </>
              ) : (
                ' (on by default)'
              )}
              . The prompt below uses your current inputs.
            </>
          ) : (
            <>
              With the TotalFinance docs MCP connected, your agent looks up the exact API and writes
              the code. The prompt below uses your current inputs.
            </>
          )}
        </p>
      </div>
      <figure className="not-prose overflow-hidden rounded-xl border border-fd-border bg-fd-card">
        <figcaption className="flex items-center justify-between gap-3 border-b border-fd-border px-4 py-2 text-xs text-fd-muted-foreground">
          <span>Prompt</span>
          <CopyButton text={prompt} tone="light" label="Copy prompt" />
        </figcaption>
        <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-6">{prompt}</p>
      </figure>
      <p className="text-sm">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1 font-medium text-fd-primary hover:underline"
        >
          Connect Claude, Cursor, VS Code, Codex or ChatGPT{' '}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </p>
    </section>
  );
}
