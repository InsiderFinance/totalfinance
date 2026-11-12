import type { ReactNode } from 'react';
import { Code } from './code';
import { CopyButton } from './copy-button';

/** A titled, copyable, highlighted code panel. Renders on the server or in the browser. */
export function CodePanel({
  code,
  title,
  lang = 'ts',
  actions,
  height = 'max-h-[32rem]',
  wrap = false,
}: {
  code: string;
  title?: string;
  lang?: 'ts' | 'json' | 'sh';
  actions?: ReactNode;
  /** Scroll height class; `''` for unbounded. */
  height?: string;
  /** Wrap long lines instead of scrolling sideways (for prose-like output). */
  wrap?: boolean;
}) {
  return (
    <figure className="tf-code not-prose">
      <figcaption className="tf-code-bar">
        <span className="truncate">
          {title ?? (lang === 'json' ? 'JSON' : lang === 'sh' ? 'Shell' : 'TypeScript')}
        </span>
        <span className="flex items-center gap-1">
          {actions}
          <CopyButton text={code} />
        </span>
      </figcaption>
      <div className={`tf-code-body ${height} ${wrap ? 'tf-code-wrap' : ''}`}>
        <Code code={code} lang={lang} />
      </div>
    </figure>
  );
}
