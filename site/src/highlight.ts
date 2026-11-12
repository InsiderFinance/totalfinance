/**
 * A small, synchronous TypeScript/JSON highlighter for generated and live code (signatures,
 * calculator examples, schemas). It runs identically on the server and in the browser, emits one
 * short class per token, and never injects HTML. MDX prose code blocks use Shiki at build time.
 */
export type TokenClass = 'k' | 's' | 'n' | 'c' | 't' | 'f' | 'p' | 'b' | 'x' | '';

export interface Token {
  text: string;
  cls: TokenClass;
}

const KEYWORDS = new Set(
  (
    'abstract as asserts async await break case catch class const continue declare default delete do else enum export extends ' +
    'false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null ' +
    'of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique ' +
    'unknown var void while with yield'
  ).split(' '),
);
const BUILTIN_TYPES = new Set(
  'string number boolean bigint symbol object any Array Record Readonly Partial Promise ArrayLike Float64Array'.split(
    ' ',
  ),
);

const PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b|\bNaN\b|\bInfinity\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d'"`/]+|\/)/g;

export function tokenize(code: string, lang: 'ts' | 'json' | 'sh' = 'ts'): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, cls: TokenClass) => {
    const last = tokens.at(-1);
    if (last && last.cls === cls) last.text += text;
    else tokens.push({ text, cls });
  };
  if (lang === 'sh') {
    for (const line of code.split(/(\n)/)) {
      if (line === '\n') push(line, '');
      else if (line.trimStart().startsWith('#')) push(line, 'c');
      else {
        const [command = '', ...rest] = line.split(/(?<=^\S+)/);
        push(command, 'f');
        push(rest.join(''), '');
      }
    }
    return tokens;
  }
  let match: RegExpExecArray | null;
  PATTERN.lastIndex = 0;
  while ((match = PATTERN.exec(code)) !== null) {
    const [text, comment, string, number, word, space] = match;
    if (comment) push(text, 'c');
    else if (string) {
      // JSON object keys read as properties, not string values.
      const rest = code.slice(PATTERN.lastIndex);
      push(text, lang === 'json' && /^\s*:/.test(rest) ? 'x' : 's');
    } else if (number) push(text, 'n');
    else if (word) {
      const next = code.slice(PATTERN.lastIndex).match(/^\s*(\(|<[^=])/);
      if (KEYWORDS.has(word)) push(text, 'k');
      else if (BUILTIN_TYPES.has(word)) push(text, 't');
      else if (/^[A-Z]/.test(word)) push(text, 't');
      else if (next) push(text, 'f');
      else push(text, '');
    } else if (space) push(text, '');
    else push(text, /^[{}()[\]]+$/.test(text) ? 'b' : 'p');
  }
  return tokens;
}
