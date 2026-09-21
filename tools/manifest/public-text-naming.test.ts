/**
 * Phase 3B naming, extended to the surfaces the inventory cannot see: PUBLIC TEXT.
 *
 * The naming baseline walks declared identifiers. It never read the strings a caller actually
 * receives, and the spec's own rule (N8) says private shorthand becomes public the moment it is
 * exposed through an error message or a diagnostic context.
 *
 * ## Why this is an AST scan and not a regex
 *
 * The first version read LINES: lines containing a backtick, and flat `context: { … }` matches. It
 * found thirty-three leaks and then PASSED while numerous public messages still taught `vol`, `rate`,
 * `t` and `ts` — because a message split across lines, built by concatenation, or written as a plain
 * quoted string is invisible to a line-based match. A reviewer listed five it had missed.
 *
 * So this walks the AST, finds the error and warning CONSTRUCTION SITES, and reads what those calls
 * actually pass: quoted strings, template literals of any length, concatenations, and the properties
 * of the context object. What a caller receives is a property of the call, not of a line.
 *
 * ## What counts as a leak
 *
 * Two constructs TEACH, and both were wrong in the library when this was written:
 *
 *   A DESTRUCTURING EXAMPLE   `{ spot, vol, rate, asOf }` in a message. `PremiumMarket` declares
 *                             `volatility` and `riskFreeRate`, so the error named two fields that do
 *                             not exist — and the same file got it right eighty lines later. Three
 *                             more like it, including bachelier's `{ …, t, rate, … }` inside the very
 *                             error meant to teach "two different units never share a name".
 *   A CONTEXT KEY             `context: { t }` is a serialized payload a consumer reads off the error.
 *
 * Prose and comments are deliberately out of scope: `ρ`, `σ_S` and `w_{t,i}` are notation the spec
 * permits and no caller can type. The test is whether a name is presented as something to WRITE.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TOKENS } from './naming-policy.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = resolve(ROOT, 'packages');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(path);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
    }
  };
  for (const dir of readdirSync(PACKAGES).sort()) {
    const src = resolve(PACKAGES, dir, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      continue;
    }
  }
  return out;
}

/** Is this token banned as a complete public name? */
const banned = (token: string): boolean => Object.hasOwn(FORBIDDEN_TOKENS, token);

/**
 * Calls whose arguments reach a caller. `warning` is here because a `QuantWarning` carries a message
 * AND a context, and `diagnostics.ts` taught `vol`, `t` and `rate` through exactly that.
 */
const REPORTING_CALLS = new Set([
  'InputError',
  'ConvergenceError',
  'QuantError',
  'warning',
  'fail',
]);

/** Every string a call site would show a caller, flattened out of templates and concatenations. */
function messageText(node: ts.Node): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${x}${span.literal.text}`).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return messageText(node.left) + messageText(node.right);
  }
  return '';
}

interface Leak {
  file: string;
  line: number;
  detail: string;
}

function calleeName(node: ts.CallExpression | ts.NewExpression): string {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return '';
}

function scan(file: string): Leak[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const relative = file.slice(ROOT.length);
  const leaks: Leak[] = [];
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  /** Object literals that are, or contain, a `context` payload. */
  const contexts = (object: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression[] => [
    object,
    ...object.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'context' &&
      ts.isObjectLiteralExpression(property.initializer)
        ? [property.initializer]
        : [],
    ),
  ];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      REPORTING_CALLS.has(calleeName(node))
    ) {
      for (const argument of node.arguments ?? []) {
        const message = messageText(argument);
        if (message !== '') {
          for (const match of message.matchAll(/\{([^{}]*,[^{}]*)\}/g)) {
            for (const raw of match[1]!.split(',')) {
              const name = raw
                .trim()
                .replace(/[?:].*$/, '')
                .trim();
              if (/^[a-z][A-Za-z0-9]*$/.test(name) && banned(name)) {
                leaks.push({
                  file: relative,
                  line: at(argument),
                  detail: `teaches \`${name}\` in ${match[0].trim()}`,
                });
              }
            }
          }
          for (const match of message.matchAll(/`([a-z][A-Za-z0-9]*)`/g)) {
            if (banned(match[1]!)) {
              leaks.push({
                file: relative,
                line: at(argument),
                detail: `tells the caller to pass \`${match[1]}\``,
              });
            }
          }
        }
        if (ts.isObjectLiteralExpression(argument)) {
          for (const object of contexts(argument)) {
            for (const property of object.properties) {
              if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
                continue;
              const name = ts.isIdentifier(property.name) ? property.name.text : '';
              if (name !== '' && banned(name)) {
                leaks.push({
                  file: relative,
                  line: at(property),
                  detail: `serializes context key \`${name}\``,
                });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return leaks;
}

const files = sourceFiles();
const leaks = files.flatMap(scan);
const unique = (found: Leak[]): string[] => [
  ...new Set(found.map((leak) => `${leak.file}:${leak.line} ${leak.detail}`)),
];

describe('public TEXT obeys the naming policy (spec N8)', () => {
  it('reads a non-trivial slice of the library', () => {
    // A guard against the walk finding nothing and every assertion passing vacuously.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no error or warning message teaches a forbidden field name', () => {
    const found = unique(leaks.filter((leak) => !leak.detail.startsWith('serializes')));
    expect(
      found,
      `a message names a field the caller cannot type. A corrective error that misnames the field ` +
        `costs the reader the one thing they came for:\n${found.slice(0, 25).join('\n')}`,
    ).toEqual([]);
  });

  it('no error or warning CONTEXT is keyed by a forbidden name', () => {
    const found = unique(leaks.filter((leak) => leak.detail.startsWith('serializes')));
    expect(
      found,
      `an error context is keyed by a forbidden public name — the context is a payload a consumer ` +
        `reads, not a local:\n${found.slice(0, 25).join('\n')}`,
    ).toEqual([]);
  });
});
