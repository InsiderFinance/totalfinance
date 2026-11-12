/** A private cause:unknown may be null; calling that an invalid market input is false evidence. */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { walkField } from './contract-fields.js';
it('records nullability exactly as the strict compiler for unknown/any and ordinary scalar controls', () => {
  const file = '/nullability-fixture.ts',
    source =
      'interface Inputs { unknownCause: unknown; anyCause: any; nullableText: string|null; text: string; count: number } const sample = null;';
  const host = ts.createCompilerHost({ strict: true, noLib: true });
  host.getSourceFile = (name, version) =>
    name === file ? ts.createSourceFile(name, source, version, true) : undefined;
  const program = ts.createProgram([file], { strict: true, noLib: true }, host),
    checker = program.getTypeChecker(),
    sf = program.getSourceFile(file)!;
  const declaration = sf.statements.find(ts.isInterfaceDeclaration)!;
  const fields = checker.getTypeAtLocation(declaration);
  const sample = sf.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!
    .initializer!;
  const nullType = checker.getTypeAtLocation(sample);
  for (const symbol of checker.getPropertiesOfType(fields)) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const result = walkField(checker, symbol.name, type, false, 0, new Set());
    expect(result.nullable, symbol.name).toBe(checker.isTypeAssignableTo(nullType, type));
  }
  expect(
    checker.isTypeAssignableTo(
      nullType,
      checker.getTypeOfSymbolAtLocation(checker.getPropertyOfType(fields, 'text')!, declaration),
    ),
  ).toBe(false);
});
