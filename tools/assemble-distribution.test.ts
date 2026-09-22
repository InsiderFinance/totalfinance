import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@jridgewell/sourcemap-codec';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  distributionMarkdown,
  rewriteMap,
  rewriteModuleSpecifiers,
} from './assemble-distribution.js';
import {
  PUBLIC_PACKAGE_NAME,
  publicPackageDirectories,
  publicSourcePaths,
  sourcePackages,
  toPublicSpecifier,
} from './public-packages.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('the two-artifact distribution', () => {
  it('never teaches private package imports in editor examples or runtime repair hints', () => {
    const failures: string[] = [];
    for (const pkg of sourcePackages(ROOT)) {
      const directory = join(ROOT, 'packages', pkg.dir, 'src');
      for (const filename of readdirSync(directory, { recursive: true }) as string[]) {
        if (!filename.endsWith('.ts')) continue;
        const source = readFileSync(join(directory, filename), 'utf8');
        const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
        const ranges = new Map<number, ts.CommentRange>();
        function visit(node: ts.Node): void {
          const literal =
            ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node);
          const parent = node.parent;
          const moduleSpecifier =
            parent &&
            (ts.isImportDeclaration(parent) ||
              ts.isExportDeclaration(parent) ||
              (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
              (ts.isCallExpression(parent) &&
                parent.expression.kind === ts.SyntaxKind.ImportKeyword));
          // Generated schema IDs remain stable internal identities, not import/install guidance.
          if (
            !filename.startsWith('generated/') &&
            literal &&
            !moduleSpecifier &&
            node.text.includes('@totalfinance/')
          )
            failures.push(`${pkg.dir}/src/${filename}: private import in runtime teaching text`);
          for (const range of [
            ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
            ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
          ])
            ranges.set(range.pos, range);
          ts.forEachChild(node, visit);
        }
        visit(file);
        for (const { pos, end } of ranges.values()) {
          if (
            /(?:\bfrom\s*|\bimport\s*\(\s*)['"](?:@totalfinance\/|totalfinance(?:\/|['"]))/m.test(
              source.slice(pos, end),
            )
          )
            failures.push(
              `${pkg.dir}/src/${filename}:${file.getLineAndCharacterOfPosition(pos).line + 1}`,
            );
        }
      }
    }
    expect(failures).toEqual([]);
  });
  it('keeps README links usable when npm renders the relocated artifact', () => {
    expect(distributionMarkdown('[Guide](./docs/guide.md#setup)', 'README.md')).toBe(
      '[Guide](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guide.md#setup)',
    );
    expect(
      distributionMarkdown('[Guide](../../docs/guide.md) [Here](#local)', 'packages/mcp/README.md'),
    ).toBe(
      '[Guide](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guide.md) [Here](#local)',
    );
  });
  it('maps public imports, without renaming third-party imports or introducing sibling packages', () => {
    expect(toPublicSpecifier('totalfinance')).toBe('@insiderfinance/totalfinance');
    expect(toPublicSpecifier('totalfinance/options')).toBe('@insiderfinance/totalfinance/options');
    expect(toPublicSpecifier('@totalfinance/options/black-scholes')).toBe(
      '@insiderfinance/totalfinance/options/black-scholes',
    );
    expect(toPublicSpecifier('@totalfinance/mcp')).toBe('@insiderfinance/totalfinance-mcp');
    expect(toPublicSpecifier('@modelcontextprotocol/sdk/server')).toBe(
      '@modelcontextprotocol/sdk/server',
    );
    expect(publicPackageDirectories(ROOT).map((p) => p.name)).toEqual([
      '@insiderfinance/totalfinance',
      '@insiderfinance/totalfinance-mcp',
    ]);
  });

  it('uses the real export target for renamed and nested entry points', () => {
    const paths = publicSourcePaths(ROOT);
    expect(paths[`${PUBLIC_PACKAGE_NAME}/foreign-exchange/risk`]).toEqual([
      './packages/foreign-exchange/src/exposure.ts',
    ]);
    expect(paths[`${PUBLIC_PACKAGE_NAME}/workflows/local`]).toEqual([
      './packages/workflows/src/local/index.ts',
    ]);
    expect(paths[PUBLIC_PACKAGE_NAME]).toEqual(['./packages/totalfinance/src/index.ts']);
  });

  it('rewrites only module syntax, including declarations and dynamic imports', () => {
    const source = `// '@totalfinance/core' stays a comment\nconst label = '@totalfinance/core';\nimport { X } from '@totalfinance/core';\nexport * from '@totalfinance/core';\ntype T = import('@totalfinance/core').T;\nconst load = () => import('@totalfinance/core');\nconst cjs = require('@totalfinance/core');`;
    const result = rewriteModuleSpecifiers(source, 'test.ts', toPublicSpecifier);
    expect(result.edits).toHaveLength(5);
    expect(result.text).toContain("const label = '@totalfinance/core'");
    expect(result.text).toContain("// '@totalfinance/core' stays a comment");
    expect(result.text.match(/@insiderfinance\/totalfinance\/core/g)).toHaveLength(5);
  });

  it('adjusts source map columns without losing the original source locations', () => {
    const source = "export * from '@totalfinance/core';";
    const result = rewriteModuleSpecifiers(source, 'test.d.ts', () => '../core/dist/index.js');
    const original = {
      version: 3,
      sources: ['../src/index.ts'],
      names: [],
      mappings: encode([
        [
          [0, 0, 0, 0],
          [source.length, 0, 0, source.length],
        ],
      ]),
    };
    const adjusted = JSON.parse(rewriteMap(JSON.stringify(original), source, result.edits));
    expect(adjusted.sources).toEqual(original.sources);
    expect(decode(adjusted.mappings)[0]![1]).toEqual([result.text.length, 0, 0, source.length]);
  });

  it('keeps all source workspaces private and version-synchronized', () => {
    const main = JSON.parse(
      readFileSync(join(ROOT, 'distribution/totalfinance/package.json'), 'utf8'),
    );
    expect(sourcePackages(ROOT)).toHaveLength(25);
    for (const pkg of sourcePackages(ROOT)) {
      expect(pkg.private, pkg.name).toBe(true);
      expect(pkg.version, pkg.name).toBe(main.version);
    }
    expect(readdirSync(join(ROOT, 'distribution')).sort()).toEqual(['mcp', 'totalfinance']);
    expect(main.dependencies).toEqual({});
    expect(main.exports['./mcp']).toBeUndefined();
    expect(main.exports['./options/black-scholes'].import).toBe(
      './modules/options/dist/black-scholes.js',
    );
    expect(main.exports['./options/package.json']).toBeUndefined();
    expect(main.bin).toEqual({
      totalfinance: './modules/cli/dist/bin.js',
      'totalfinance-http': './modules/http/dist/bin.js',
    });
  });
});
