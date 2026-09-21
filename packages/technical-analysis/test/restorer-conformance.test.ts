/**
 * The restorer law, enforced structurally (3B.1).
 *
 * The envelope tests prove the 335 indicators that exist today are guarded. They cannot prove the
 * 336th will be: a new indicator written the old way — `snapshotState(s)` and a column of
 * `as number` casts — would restore garbage and pass every one of them, because nothing drives an
 * indicator that has not been written yet.
 *
 * So this reads the SOURCE. Three rules, each the exact shape of a defect that was measured:
 *
 *   ONE DOOR IN    Every `fromJSON` / `restore` that touches snapshot state goes through
 *                  `readSnapshot`, which is where the closed envelope, the version and the indicator
 *                  identity are checked. The old helper is gone; this keeps it gone.
 *   NO CASTS       No `state['x'] as T` inside a restorer. `as` is a claim to the compiler; it was
 *                  the whole defect, repeated 766 times.
 *   ONE DOOR OUT   Every `toJSON` builds its envelope with `snapshotOf`, which stamps the version and
 *                  encodes non-finite numbers. A hand-built envelope would skip both, and the reader
 *                  would then be right to reject the raw NaN it wrote.
 *   NOTHING DEAD   Every key a `toJSON` writes is read back by its restorer. A written-and-never-read
 *                  field is a lie about the payload: change it and the restore ignores you, which is
 *                  exactly what the enforcement harness convicted `DpoStream` for — it serialized a
 *                  `shift` that the constructor recomputes from `period`.
 *
 * A structural gate is worth its weight only when it names the fix. Each failure below prints the
 * file, the line and the replacement.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE = fileURLToPath(new URL('../src', import.meta.url));

const files = readdirSync(SOURCE)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort()
  .map((name) => ({ name, path: resolve(SOURCE, name) }))
  .filter(({ path }) => statSync(path).isFile());

interface Violation {
  file: string;
  line: number;
  detail: string;
}

const restorerViolations: Violation[] = [];
const envelopeViolations: Violation[] = [];
const deadFieldViolations: Violation[] = [];
let restorersSeen = 0;
let serializersSeen = 0;

for (const { name, path } of files) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  /**
   * A function body that reads snapshot state — a restorer, whatever it is spelled.
   *
   * AST, not text. The first version tested the body's SOURCE with a regex and flagged
   * `makeIndicator`'s own `fromJSON`, whose only `state[` is inside a comment explaining what a
   * composed indicator reads. A gate that convicts on prose is a gate people learn to ignore.
   */
  const isRestorerBody = (body: ts.Node): boolean => {
    let reads = false;
    const walk = (node: ts.Node): void => {
      if (reads) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'readSnapshot' || node.expression.text === 'snapshotState')
          reads = true;
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'state' &&
        ts.isStringLiteralLike(node.argumentExpression)
      )
        reads = true;
      ts.forEachChild(node, walk);
    };
    walk(body);
    return reads;
  };

  const checkRestorer = (body: ts.Node, label: string): void => {
    restorersSeen++;
    let entersThroughReader = false;
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'readSnapshot') entersThroughReader = true;
        if (node.expression.text === 'snapshotState')
          restorerViolations.push({
            file: name,
            line: at(node),
            detail: `${label} calls snapshotState — call readSnapshot(snapshot, '<kind>') instead, which also checks the identity`,
          });
      }
      // `state['x'] as T` — an unchecked read, whatever the identifier is called
      if (ts.isAsExpression(node)) {
        const inner = node.expression;
        if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression))
          restorerViolations.push({
            file: name,
            line: at(node),
            detail: `${label} casts state["${inner.argumentExpression.text}"] — use a checked accessor (state.number/numbers/child/cached/…)`,
          });
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    if (!entersThroughReader)
      restorerViolations.push({
        file: name,
        line: at(body),
        detail: `${label} reads snapshot state without readSnapshot — the identity guard is what stops one indicator restoring another's numbers`,
      });
  };

  /**
   * Pair a class's writer with its reader: the literal keys `snapshotOf` is handed, against the
   * field names the restorer asks for. Classes whose state is built by a spread are skipped — their
   * key set is not statically knowable, and guessing would produce noise instead of findings.
   */
  /** Every `state.accessor('field')` in the file — the fallback for a restorer written outside its class. */
  const fileReads = new Set<string>();
  const collectFileReads = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'state'
    ) {
      const first = n.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first)) fileReads.add(first.text);
    }
    ts.forEachChild(n, collectFileReads);
  };
  collectFileReads(source);

  const checkClassKeys = (node: ts.ClassDeclaration | ts.ClassExpression): void => {
    const owner = node.name?.text ?? '(anonymous)';
    const written = new Set<string>();
    const read = new Set<string>();
    let writerLine = 0;
    let spread = false;
    let sawWriter = false;
    /**
     * Some restorers are not class members — `htScalar`, `statelessBar`, `projected` and
     * `rangeVolatilityFacade` build theirs as an arrow passed to `makeIndicator`, and the
     * `PairWindow` base class is restored by each subclass. For those, the reads are gathered from
     * the whole FILE. That is weaker (a dead key could be masked by a same-named read elsewhere in
     * the module) and it is why the enforcement harness stays the independent check; it is also the
     * difference between a gate with findings and a gate with twelve false positives.
     */
    const ownRestorer = node.members.some(
      (member) =>
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        (member.name.text === 'fromJSON' || member.name.text === 'restore'),
    );

    const collect = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (ts.isIdentifier(n.expression) && n.expression.text === 'snapshotOf') {
          sawWriter = true;
          writerLine = at(n);
          const state = n.arguments[1];
          if (state !== undefined && ts.isObjectLiteralExpression(state)) {
            for (const property of state.properties) {
              if (
                (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
              )
                written.add(property.name.text);
              else spread = true;
            }
          } else spread = true;
        }
        // state.<accessor>('field')
        if (
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === 'state'
        ) {
          const first = n.arguments[0];
          if (first !== undefined && ts.isStringLiteralLike(first)) read.add(first.text);
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(node);
    if (!sawWriter || spread) return;
    const seen = ownRestorer ? read : fileReads;
    for (const key of written)
      if (!seen.has(key))
        deadFieldViolations.push({
          file: name,
          line: writerLine,
          detail: `${owner} serializes "${key}" and never reads it back — drop it from toJSON, or read it in the restorer`,
        });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) checkClassKeys(node);
    // class members
    if (ts.isMethodDeclaration(node) && node.body !== undefined && ts.isIdentifier(node.name)) {
      const method = node.name.text;
      if ((method === 'fromJSON' || method === 'restore') && isRestorerBody(node.body)) {
        const owner = ts.isClassDeclaration(node.parent) ? (node.parent.name?.text ?? '?') : '?';
        checkRestorer(node.body, `${owner}.${method}`);
      }
      if (method === 'toJSON') {
        serializersSeen++;
        /**
         * Building an envelope means `snapshotOf`. DELEGATING is fine and is not building:
         * `VersionedStream.toJSON` returns `this.inner.toJSON()`, and a subclass may extend
         * `super.toJSON()` — in both cases the stamp and the encoding already happened downstream.
         */
        let builds = false;
        let delegates = false;
        const walk = (inner: ts.Node): void => {
          if (ts.isCallExpression(inner)) {
            if (ts.isIdentifier(inner.expression) && inner.expression.text === 'snapshotOf')
              builds = true;
            if (
              ts.isPropertyAccessExpression(inner.expression) &&
              inner.expression.name.text === 'toJSON'
            )
              delegates = true;
          }
          ts.forEachChild(inner, walk);
        };
        walk(node.body);
        if (!builds && !delegates)
          envelopeViolations.push({
            file: name,
            line: at(node),
            detail: `toJSON builds an envelope without snapshotOf — it would skip the version stamp and the non-finite encoding`,
          });
      }
    }
    // free-standing restorers: the arrow functions handed to makeIndicator
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      !ts.isMethodDeclaration(node.parent) &&
      isRestorerBody(node.body)
    ) {
      const insideMethod = (() => {
        let cursor: ts.Node | undefined = node.parent;
        while (cursor !== undefined) {
          if (ts.isMethodDeclaration(cursor) && ts.isIdentifier(cursor.name))
            return cursor.name.text === 'fromJSON' || cursor.name.text === 'restore';
          cursor = cursor.parent;
        }
        return false;
      })();
      if (!insideMethod) checkRestorer(node.body, `restorer at line ${at(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const show = (violations: Violation[]): string[] =>
  violations.map((v) => `${v.file}:${v.line} — ${v.detail}`);

describe('every restorer goes through the reader (3B.1)', () => {
  it('the scan actually found the restorers', () => {
    // Without this, deleting the walk would make every assertion below pass vacuously.
    expect(restorersSeen).toBeGreaterThan(180);
    expect(serializersSeen).toBeGreaterThan(180);
  });

  it('no restorer reads state without readSnapshot, and none casts a state field', () => {
    expect(show(restorerViolations).slice(0, 25)).toEqual([]);
  });

  it('every toJSON builds its envelope with snapshotOf', () => {
    expect(show(envelopeViolations).slice(0, 25)).toEqual([]);
  });

  it('no snapshot carries a field its restorer never reads', () => {
    expect(show(deadFieldViolations).slice(0, 25)).toEqual([]);
  });
});
