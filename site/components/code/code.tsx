import { tokenize } from '@/src/highlight';

/**
 * Highlighted code that renders the same on the server and in the browser: one short class per
 * token (styled in global.css), plain text inside. Safe for any string; nothing is parsed as HTML.
 */
export function Code({ code, lang = 'ts' }: { code: string; lang?: 'ts' | 'json' | 'sh' }) {
  return (
    <pre className="tf-code-pre">
      <code>
        {tokenize(code, lang).map((token, index) =>
          token.cls ? (
            <span key={index} className={`tk-${token.cls}`}>
              {token.text}
            </span>
          ) : (
            token.text
          ),
        )}
      </code>
    </pre>
  );
}
