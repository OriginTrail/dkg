import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TARGETS = [
  '../src/async-lift-publisher-impl.ts',
  '../src/async-promote-queue-impl.ts',
  '../src/async-lift-wallet-persistence.ts',
  '../src/async-lift-journal-completion.ts',
  '../src/job-record-atomic-write.ts',
  '../src/subject-atomic-write.ts',
  '../src/lift-job-store-selectors.ts',
  '../src/lift-job-listing-selectors.ts',
] as const;

// RFC-73 P1b: the queue-graph MUTATIONS must be attributable too, so a rejection at the store
// scheduler names the queue operation that issued it. Method name -> index of its options argument.
const MUTATION_METHOD_OPTIONS_INDEX: Readonly<Record<string, number>> = {
  insert: 1,
  delete: 1,
  deleteByPattern: 1,
  deleteBySubjectPrefix: 2,
  update: 1,
  replaceSubject: 3,
  replaceSubjectAndInsert: 4,
  dropGraph: 1,
};
// Free helper name -> index of its options argument. `createGraph` and `flush` are exempt: the
// option-less forms never reach the store scheduler.
const MUTATION_HELPER_OPTIONS_INDEX: Readonly<Record<string, number>> = {
  deleteByPatternWithoutCount: 2,
  replaceSubjectAtomicallyOrFallback: 4,
  tryReplaceSubjectAtomically: 4,
  tryReplaceSubjectAndInsertAtomically: 5,
};
const MUTATION_TARGETS = [
  '../src/async-promote-queue-impl.ts',
  '../src/async-lift-publisher-impl.ts',
  '../src/async-lift-wallet-persistence.ts',
  '../src/async-lift-journal-completion.ts',
  '../src/job-record-atomic-write.ts',
  '../src/subject-atomic-write.ts',
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

/**
 * True only for an argument we can PROVE carries no source: it is absent, or an object literal
 * with no `source` property. A string literal (the helper's string form), a prepared options
 * identifier or a spread stay permissive, like the query check above.
 */
function lacksSource(options: ts.Expression | undefined): boolean {
  if (options === undefined) return true;
  return ts.isObjectLiteralExpression(options) && !options.properties.some(propertyCarriesSource);
}

function missingMutationSource(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const missing: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let optionsIndex: number | undefined;
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression.getText(sourceFile);
        if (/(?:^|\.)store\??$/.test(receiver)) {
          optionsIndex = MUTATION_METHOD_OPTIONS_INDEX[node.expression.name.text];
        }
      } else if (ts.isIdentifier(node.expression)) {
        optionsIndex = MUTATION_HELPER_OPTIONS_INDEX[node.expression.text];
      }
      if (optionsIndex !== undefined && lacksSource(node.arguments[optionsIndex])) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        missing.push(`${fileName}:${position.line + 1}`);
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

describe('publisher control-plane mutation source coverage', () => {
  it('keeps every queue-graph mutation attributable', () => {
    const missingAttribution: string[] = [];

    for (const relativePath of MUTATION_TARGETS) {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      const sourceText = readFileSync(path, 'utf8');
      missingAttribution.push(...missingMutationSource(sourceText, relativePath));
    }

    expect(missingAttribution).toEqual([]);
  });

  it('rejects source-less mutation literals without blocking prepared, spread or string options', () => {
    const sourceText = [
      "store.insert(quads);",
      "this.store.insert(quads, {});",
      "store.delete(quads, { signal });",
      "store.deleteByPattern(pattern);",
      "store.deleteBySubjectPrefix(graph, prefix);",
      "store.update(sparql);",
      "store.replaceSubject(graph, subject, quads);",
      "store.replaceSubjectAndInsert(graph, subject, quads, extra);",
      "store.dropGraph(graph);",
      "deleteByPatternWithoutCount(store, pattern);",
      "deleteByPatternWithoutCount(store, pattern, {});",
      "replaceSubjectAtomicallyOrFallback(store, graph, subject, quads);",
      "tryReplaceSubjectAtomically(store, graph, subject, quads);",
      "tryReplaceSubjectAndInsertAtomically(store, graph, subject, quads, extra);",
      // Everything below carries (or may carry) a source and must stay clean.
      "store.insert(quads, { source: 'a' });",
      "store.insert(quads, { source });",
      "store.insert(quads, queryOptions);",
      "store.insert(quads, { ...queryOptions });",
      "store.replaceSubject(graph, subject, quads, { source: 'a' });",
      "store.replaceSubjectAndInsert(graph, subject, quads, extra, { source: 'a' });",
      "store.deleteBySubjectPrefix(graph, prefix, { source: 'a' });",
      "deleteByPatternWithoutCount(store, pattern, { source: 'a' });",
      "replaceSubjectAtomicallyOrFallback(store, graph, subject, quads, 'a');",
      "replaceSubjectAtomicallyOrFallback(store, graph, subject, quads, queryOptions);",
      // Exempt: no scheduler reach, and non-store receivers are not the queue store.
      "store.createGraph(graph);",
      "store.flush?.();",
      "cache.insert(quads);",
      "someOther(store, pattern);",
    ].join('\n');

    expect(missingMutationSource(sourceText, 'fixture.ts')).toEqual(
      Array.from({ length: 14 }, (_, i) => `fixture.ts:${i + 1}`),
    );
  });
});
