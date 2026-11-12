import { Fragment } from 'react';

/**
 * JSDoc prose for the reference: paragraphs, `code` spans and {@link Target} references (shown as
 * code). Everything else stays literal text; no HTML from source comments is ever injected.
 */
export function JsDocText({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .replace(
      /\{@link\s+([^}\s|]+)(?:\s*\|\s*([^}]+))?\s*\}/g,
      (_match, target: string, label?: string) => `\`${(label ?? target).trim()}\``,
    )
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  return (
    <div className={className}>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>
          {paragraph
            .split(/(`[^`]+`)/)
            .map((part, partIndex) =>
              part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
                <code key={partIndex}>{part.slice(1, -1)}</code>
              ) : (
                <Fragment key={partIndex}>{part}</Fragment>
              ),
            )}
        </p>
      ))}
    </div>
  );
}
