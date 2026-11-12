'use client';
import { useState, type ReactNode } from 'react';
import { displayValue } from '@/src/display';
import { firstCallCode } from '@/src/examples';
import type { Calculation } from '@/src/types';
import { Code } from '../code/code';
import { CopyButton } from '../code/copy-button';
import { RunnableFirstCall } from './run-example';

function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <figure className="tf-code not-prose">
      <figcaption className="tf-code-bar">
        <span className="truncate">{title}</span>
        <span className="flex items-center gap-1">{actions}</span>
      </figcaption>
      <div className="tf-code-body max-h-[30rem]">{children}</div>
    </figure>
  );
}

/** A disclosure whose content renders only once opened (large code stays out of the page until asked for). */
function Disclosure({
  summary,
  children,
  onOpen,
}: {
  summary: string;
  children: ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="tf-disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setOpen(true);
          onOpen?.();
        }
      }}
    >
      <summary>{summary}</summary>
      {open ? <div className="mt-2 space-y-2">{children}</div> : null}
    </details>
  );
}

export function Examples({
  calculation,
  onNeedResult,
}: {
  calculation: Calculation;
  onNeedResult?: () => void;
}) {
  const { example } = calculation;
  const setup = example.setup;
  const output = displayValue(example.result);
  return (
    <section aria-labelledby="use-it-heading" className="space-y-5">
      <div>
        <h2 id="use-it-heading" className="font-display text-xl font-semibold tracking-tight">
          Use it in your project
        </h2>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-fd-muted-foreground">
          {example.description}
        </p>
      </div>
      {setup ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Sample inputs</h3>
          <p className="max-w-3xl text-xs leading-5 text-fd-muted-foreground">
            {setup.description}
          </p>
          <Panel title="Preview">
            <Code code={setup.preview} />
          </Panel>
          <Disclosure summary="Complete setup · included when you copy">
            <Panel title="Setup" actions={<CopyButton text={setup.code} label="Copy setup" />}>
              <Code code={setup.code} />
            </Panel>
          </Disclosure>
        </div>
      ) : null}
      <RunnableFirstCall
        display={example.code}
        program={firstCallCode(calculation)}
        copyLabel={setup ? 'Copy setup + call' : 'Copy'}
        documentedOutput={example.result}
      />
      <Panel title="Output of this example" actions={<CopyButton text={output} />}>
        <Code code={output} lang="json" />
      </Panel>
      <Disclosure summary="Reproduce this entire calculator">
        <p className="max-w-3xl text-xs leading-5 text-fd-muted-foreground">
          This complete program reproduces every chart point and the full result. Sample generation
          and chart mapping are example setup, not conversions the library requires.
        </p>
        <Panel
          title="Complete program"
          actions={<CopyButton text={calculation.code} label="Copy program" />}
        >
          <Code code={calculation.code} />
        </Panel>
      </Disclosure>
      <Disclosure
        summary="Full result object"
        {...(calculation.result === null && onNeedResult ? { onOpen: onNeedResult } : {})}
      >
        {calculation.result === null ? (
          <p className="text-xs text-fd-muted-foreground">
            Calculating the full result in your browser…
          </p>
        ) : (
          <Panel
            title="result"
            actions={<CopyButton text={() => displayValue(calculation.result)} />}
          >
            <pre className="tf-code-pre">
              <code>{displayValue(calculation.result)}</code>
            </pre>
          </Panel>
        )}
      </Disclosure>
      <p className="text-xs leading-5 text-fd-muted-foreground">
        Both examples use the inputs of the last successful calculation. Displayed metrics are
        rounded; copied programs keep exact values. Every copy on this page is type-checked and
        executed against the packed package in CI.
      </p>
    </section>
  );
}
