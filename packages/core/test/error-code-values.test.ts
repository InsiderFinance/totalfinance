/** Every runtime registry value agrees with its literal declaration, including insertion order. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { it, expect } from 'vitest';
import { ErrorCode } from '../src/errors.js';
import { WarningCode } from '../src/diagnostics.js';
import { createHash } from 'node:crypto';
import * as validation from '../src/validation-codes.js';
it('static error catalog exactly preserves the declared keys, values and order', () => {
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

it('warning initializers preserve every pre-correction key, value and enumeration position', () => {
  // Captured from aad83f28's literal registry before changing its representation.
  expect(Object.keys(WarningCode)).toHaveLength(140);
  expect(
    createHash('sha256')
      .update(JSON.stringify(Object.entries(WarningCode)))
      .digest('hex'),
  ).toBe('14ae05e11a30125358037fcbed63e4698bf0e111c6388e83477c913c4084d21a');
});
