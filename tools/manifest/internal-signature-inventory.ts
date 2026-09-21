/** Phase 3A ratchet for long primitive signatures inside financial-domain source packages. */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FINANCIAL_DOMAINS = new Set([
  'backtest',
  'crypto',
  'fixed-income',
  'options',
  'performance',
  'risk',
  'strategy',
  'structure',
  'technical-analysis',
  'volatility',
]);

export interface InternalSignatureCandidate {
  id: string;
  path: string;
  signature: string;
  numericParameters: number;
}

function enclosingClassOrInterface(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current)) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function identifierName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function stableName(node: ts.SignatureDeclaration): string | null {
  if (ts.isConstructorDeclaration(node)) {
    const owner = enclosingClassOrInterface(node);
    return owner ? `${owner}.constructor` : null;
  }

  const ownName =
    'name' in node
      ? identifierName((node as ts.SignatureDeclaration & { name?: ts.PropertyName }).name)
      : null;
  if (ownName) {
    const owner = enclosingClassOrInterface(node);
    return owner ? `${owner}.${ownName}` : ownName;
  }

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    return identifierName(node.parent.name);
  }

  if (ts.isFunctionTypeNode(node)) {
    if (ts.isTypeAliasDeclaration(node.parent)) return node.parent.name.text;
    if (ts.isPropertySignature(node.parent)) {
      const owner = enclosingClassOrInterface(node);
      const property = identifierName(node.parent.name);
      return owner && property ? `${owner}.${property}` : property;
    }
    if (ts.isParameter(node.parent)) {
      const parameter = identifierName(node.parent.name);
      let current: ts.Node | undefined = node.parent.parent;
      while (current && !ts.isFunctionLike(current)) current = current.parent;
      const owner = current && ts.isFunctionLike(current) ? stableName(current) : null;
      return owner && parameter ? `${owner}.${parameter}Callback` : null;
    }
  }

  return null;
}

function isNumericType(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): boolean {
  const type = checker.getTypeAtLocation(parameter);
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) =>
    Boolean(part.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)),
  );
}

/**
 * Return every explicitly named internal callable with at least three numeric coordinates.
 * Anonymous inline callbacks are intentionally excluded: array reducers and numerical traversal
 * callbacks follow their host protocol, while named callback types and parameters remain inspected.
 */
export function generateInternalSignatureInventory(): InternalSignatureCandidate[] {
  const configPath = resolve(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const candidates: InternalSignatureCandidate[] = [];

  for (const source of program.getSourceFiles()) {
    const path = relative(ROOT, source.fileName).replaceAll('\\', '/');
    const match = path.match(/^packages\/([^/]+)\/src\//);
    if (!match || !FINANCIAL_DOMAINS.has(match[1]!)) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node.parameters) {
        const numericParameters = node.parameters.filter((parameter) =>
          isNumericType(checker, parameter),
        ).length;
        const name = numericParameters >= 3 ? stableName(node) : null;
        if (name) {
          candidates.push({
            id: `${path}#${name}`,
            path,
            signature: `${name}(${node.parameters
              .map(
                (parameter) =>
                  `${parameter.name.getText(source)}: ${checker.typeToString(
                    checker.getTypeAtLocation(parameter),
                  )}`,
              )
              .join(', ')})`,
            numericParameters,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return candidates.sort((a, b) => a.id.localeCompare(b.id));
}
