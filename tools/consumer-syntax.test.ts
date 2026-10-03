import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Shipped syntax stays within what consumer toolchains parse.
 *
 * The packages compile to ES2022 and ship that syntax unchanged, so every consumer's toolchain parses
 * it — including test runners that put installed packages through Babel. Class private METHODS and
 * ACCESSORS (`#name() {}`, `get #name()`) need a Babel plugin that common configurations do not
 * enable ("Class private methods are not enabled"), and a consumer's suite then fails to load the
 * package at all. Private FIELDS are parsed by those same configurations and are used where an
 * instance must keep state out of `JSON.stringify`.
 *
 * Found integrating the selective exposure profile into a consumer whose Jest transform rejected
 * its private methods; this keeps the next one from shipping.
 */

const PACKAGES = fileURLToPath(new URL('../packages', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

function privateMembers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isPrivateIdentifier(node.name)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relative(PACKAGES, file)}:${line + 1} ${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('shipped syntax stays parseable by consumer toolchains', () => {
  it('no package declares a class private method or accessor', () => {
    const files = readdirSync(PACKAGES)
      .map((name) => join(PACKAGES, name, 'src'))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(privateMembers)).toEqual([]);
  });
});
