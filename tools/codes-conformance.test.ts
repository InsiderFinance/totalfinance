import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ErrorCode, WarningCode } from '@totalfinance/core';

/**
 * Alignment-spec Phase 1.4 — the monorepo-wide, family-aware code-conformance gate.
 *
 * Supersedes the core-only scan in `packages/core/test/codes-registry.test.ts` at monorepo scope:
 * every `code: '…'` object literal and every positional `warning('…', …)` code across EVERY
 * package's src must either resolve to the central ErrorCode/WarningCode registries or appear in
 * the frozen LEGACY_UNREGISTERED ratchet below.
 *
 * The ratchet is SHRINK-ONLY, both ways: a NEW unregistered code fails (register it in
 * `@totalfinance/core` — never grow the list), and a stale allowlist entry whose code no longer
 * appears in source also fails (delete it — the list can only shrink). Full registration (or
 * per-package registries) is the Phase 3 manifest's job; this gate guarantees the debt is frozen
 * and visible until then.
 */

const PKG_DIR = fileURLToPath(new URL('../packages', import.meta.url));

/**
 * BURNED TO ZERO (P3.1c, Phase 3): every code in the monorepo is now centrally registered in
 * `@totalfinance/core`'s ErrorCode/WarningCode. This list stays empty forever — it exists only so
 * the gate fails loudly if someone tries to grow it back.
 */
const LEGACY_UNREGISTERED: readonly string[] = [];

interface Occurrence {
  code: string;
  file: string;
}

function scanSources(): Occurrence[] {
  const out: Occurrence[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/code:\s*['"]([a-z][a-z0-9_.]+)['"]/g)) {
          out.push({ code: m[1]!, file: p });
        }
        for (const m of text.matchAll(/\bwarning\(\s*['"]([a-z][a-z0-9_.]+)['"]/g)) {
          out.push({ code: m[1]!, file: p });
        }
      }
    }
  };
  for (const pkg of readdirSync(PKG_DIR).sort()) {
    const src = join(PKG_DIR, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // package without src/ — nothing to scan
    }
  }
  return out;
}

describe('monorepo code-conformance gate (alignment specification P1.4)', () => {
  const registered = new Set<string>([...Object.values(ErrorCode), ...Object.values(WarningCode)]);
  const legacy = new Set<string>(LEGACY_UNREGISTERED);
  const occurrences = scanSources();

  it('C hygiene: no raw code literal survives outside the registries — every code is an ErrorCode/WarningCode member', () => {
    // The two registries in core are the only place a code is spelled as a string. Everything else
    // names the member, so a typo is a type error and a rename is one edit. The scenarios failure
    // guard synthesizes an over-long code on purpose (it is testing the length ceiling).
    const literals = occurrences
      .filter((o) => !/core\/src\/(errors|diagnostics)\.ts$/.test(o.file))
      .filter((o) => !/scenarios\/src\/internal\/failures\.ts$/.test(o.file))
      .map((o) => `${o.file.slice(o.file.indexOf('packages'))}: '${o.code}'`);
    expect(
      literals,
      `raw code literal(s) — use ErrorCode.X / WarningCode.X:\n${literals.join('\n')}`,
    ).toEqual([]);
  });

  it('C hygiene: every InputError/UnsupportedError/NumericalError message starts with its function name', () => {
    // `new XError(\`${functionName}: …\`)` or `new XError('name: …')` — the message names the door
    // that refused, so an agent reading it knows what to change. Checked on the AST so a template
    // whose head is a name, a string, or the left operand of a `+` chain all count the same way.
    const ERRORS = new Set(['InputError', 'UnsupportedError', 'NumericalError', 'QuantError']);
    const prefixed = (head: string): boolean =>
      /^(\$\{[A-Za-z_.]+\}|[A-Za-z_][A-Za-z0-9_.-]*)(: |\.)/.test(head) || head.startsWith('${');
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith('.ts')) {
          const text = readFileSync(p, 'utf8');
          const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true);
          const visit = (node: ts.Node): void => {
            if (
              ts.isNewExpression(node) &&
              ts.isIdentifier(node.expression) &&
              ERRORS.has(node.expression.text) &&
              node.arguments?.length
            ) {
              let arg: ts.Expression = node.arguments[0]!;
              while (
                ts.isBinaryExpression(arg) &&
                arg.operatorToken.kind === ts.SyntaxKind.PlusToken
              )
                arg = arg.left;
              while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
              let head: string | null = null;
              if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
                head = arg.text;
              else if (ts.isTemplateExpression(arg)) head = `${arg.head.text}\${`;
              if (head !== null && !prefixed(head)) {
                const { line } = sf.getLineAndCharacterOfPosition(arg.getStart());
                violations.push(
                  `${p.slice(p.indexOf('packages'))}:${line + 1}: ${head.slice(0, 60)}`,
                );
              }
            }
            ts.forEachChild(node, visit);
          };
          visit(sf);
        }
      }
    };
    for (const pkg of readdirSync(PKG_DIR).sort()) {
      const src = join(PKG_DIR, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // package without src/
      }
    }
    expect(
      violations,
      `error message(s) that do not start with their function name:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('every code literal is registered or frozen legacy — no NEW unregistered codes', () => {
    const strays = occurrences
      .filter((o) => !registered.has(o.code) && !legacy.has(o.code))
      .map((o) => `${o.file.slice(o.file.indexOf('packages'))}: '${o.code}'`);
    expect(
      strays,
      `unregistered code literal(s) — add to ErrorCode/WarningCode in @totalfinance/core (the legacy ratchet only shrinks):\n${strays.join('\n')}`,
    ).toEqual([]);
  });

  it('the legacy ratchet only shrinks — no stale allowlist entries', () => {
    const inUse = new Set(occurrences.map((o) => o.code));
    const stale = LEGACY_UNREGISTERED.filter((c) => !inUse.has(c));
    expect(
      stale,
      `allowlist entries no longer used in source — delete them:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('no allowlist entry duplicates a registered code', () => {
    const shadowed = LEGACY_UNREGISTERED.filter((c) => registered.has(c));
    expect(shadowed).toEqual([]);
  });

  it('family rule: linalg non-convergence is LinalgNoConvergence, never SolverNoConvergence', () => {
    const linalg = readFileSync(join(PKG_DIR, 'math', 'src', 'linalg.ts'), 'utf8');
    expect(linalg.includes('SolverNoConvergence')).toBe(false);
    expect(linalg.includes("'solver.no_convergence'")).toBe(false);
  });
});
