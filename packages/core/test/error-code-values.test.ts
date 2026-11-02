/** Every runtime registry value agrees with its literal declaration, including insertion order. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { it, expect } from 'vitest';
import { ErrorCode } from '../src/errors.js';
import * as validation from '../src/validation-codes.js';
it('compact error catalog exactly preserves the declared keys, values and order', () => {
  const source = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('errors.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (s) => ts.isTypeAliasDeclaration(s) && s.name.text === 'ErrorCodeRegistry',
  );
  if (
    !declaration ||
    !ts.isTypeAliasDeclaration(declaration) ||
    !ts.isTypeLiteralNode(declaration.type)
  )
    throw new Error('missing literal code contract');
  const entries = declaration.type.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type)
      throw new Error('invalid code contract member');
    const name = member.name.getText(file);
    const value =
      ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)
        ? member.type.literal.text
        : validation[
            member.type
              .getText(file)
              .replace('typeof ValidationCode.', '') as keyof typeof validation
          ];
    return [name, value];
  });
  expect(entries.length).toBeGreaterThan(100);
  expect(Object.entries(ErrorCode)).toEqual(entries);
});
