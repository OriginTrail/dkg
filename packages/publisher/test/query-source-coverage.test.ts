import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TARGETS = [
  '../src/async-lift-publisher-impl.ts',
  '../src/async-promote-queue-impl.ts',
] as const;

function propertyCarriesSource(property: ts.ObjectLiteralElementLike): boolean {
  // A spread may carry a prepared QueryOptions.source that cannot be resolved
  // locally. Keep those and non-literal option variables permissive; the guard
  // is intended to reject only source-less option literals we can prove wrong.
  if (ts.isSpreadAssignment(property)) return true;
  const { name } = property;
  if (!name) return false;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === 'source';
  return ts.isComputedPropertyName(name)
    && ts.isStringLiteral(name.expression)
    && name.expression.text === 'source';
}

function missingSourceAttribution(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const missing: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'query'
    ) {
      const receiver = node.expression.expression.getText(sourceFile);
      if (/(?:^|\.)store\??$/.test(receiver)) {
        const options = node.arguments[1];
        const literalMissingSource = options !== undefined
          && ts.isObjectLiteralExpression(options)
          && !options.properties.some(propertyCarriesSource);
        if (options === undefined || literalMissingSource) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          missing.push(`${fileName}:${position.line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return missing;
}

describe('publisher control-plane query source coverage', () => {
  it('keeps direct store queries attributable in async queue and wallet-lock paths', () => {
    const missingAttribution: string[] = [];

    // Deliberately scoped to the async publisher hot paths exercised by the
    // scheduler profile. Add a file here when that profiled surface expands.
    for (const relativePath of TARGETS) {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      const sourceText = readFileSync(path, 'utf8');
      missingAttribution.push(...missingSourceAttribution(sourceText, relativePath));
    }

    expect(missingAttribution).toEqual([]);
  });

  it('rejects source-less literals without blocking prepared or spread options', () => {
    const sourceText = [
      "store.query('missing-options');",
      "store.query('empty-options', {});",
      "store.query('other-options', { signal });",
      "store.query('literal-source', { source: 'publisher.test' });",
      "store.query('shorthand-source', { source });",
      "store.query('prepared-options', queryOptions);",
      "store.query('spread-options', { ...queryOptions });",
    ].join('\n');

    expect(missingSourceAttribution(sourceText, 'fixture.ts')).toEqual([
      'fixture.ts:1',
      'fixture.ts:2',
      'fixture.ts:3',
    ]);
  });
});
