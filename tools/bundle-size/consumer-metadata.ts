import assert from 'node:assert/strict';
import ts from 'typescript';

/** Inspect only emitted code, decoding escaped Unicode rather than searching raw source text. */
export function assertConsumerConventions(
  code: string,
  expected: readonly string[],
  foreign: readonly string[],
): void {
  const strings = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) strings.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('consumer.js', code, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS));
  assert.ok(expected.length > 0 && foreign.length > 0, 'Convention census must be nonempty');
  for (const value of expected)
    assert.ok(strings.has(value), `Missing retained RSI convention: ${value}`);
  for (const value of foreign)
    assert.ok(!strings.has(value), `Retained unrelated indicator convention: ${value}`);
}
