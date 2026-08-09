import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeSparqlOperation } from '@origintrail-official/dkg-core';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIRST_PARTY_STORE_USERS = [
  join(REPOSITORY_ROOT, 'packages/agent/src'),
  join(REPOSITORY_ROOT, 'packages/publisher/src'),
] as const;

function listTypeScriptSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptSources(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

function isStoreLikeReceiver(expression: ts.Expression): boolean {
  const tail = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : '';
  return /store$/iu.test(tail);
}

function staticSparql(expression: ts.Expression | undefined): string | null {
  if (expression === undefined) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

function findRawManagedChannelViolations(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && isStoreLikeReceiver(node.expression.expression)
    ) {
      const method = node.expression.name.text;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (method === 'update') {
        violations.push(`${fileName}:${line}: raw store.update()`);
      } else if (method === 'query') {
        const sparql = staticSparql(node.arguments[0]);
        if (sparql !== null) {
          const analysis = analyzeSparqlOperation(sparql);
          if (analysis.operation.kind !== 'read' || analysis.mutatingKeyword !== null) {
            violations.push(`${fileName}:${line}: non-read static store.query()`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('first-party managed store raw-channel source contract', () => {
  it('keeps Agent and Publisher production paths off raw mutating SPARQL', () => {
    const violations = FIRST_PARTY_STORE_USERS.flatMap((directory) =>
      listTypeScriptSources(directory).flatMap((path) =>
        findRawManagedChannelViolations(
          readFileSync(path, 'utf8'),
          relative(REPOSITORY_ROOT, path).split(sep).join('/'),
        ),
      ));

    expect(violations).toEqual([]);
  }, 20_000);

  it('detects direct raw update use on common store receiver shapes', () => {
    const violations = findRawManagedChannelViolations(`
      store.update('INSERT DATA { <urn:s> <urn:p> "o" }');
      this.store.update(sparql);
      agent.store.update(sparql);
      dependencies.innerStore.update(sparql);
    `, 'fixture.ts');

    expect(violations).toEqual([
      'fixture.ts:2: raw store.update()',
      'fixture.ts:3: raw store.update()',
      'fixture.ts:4: raw store.update()',
      'fixture.ts:5: raw store.update()',
    ]);
  });

  it('detects statically visible mutation and unknown syntax sent through query()', () => {
    const violations = findRawManagedChannelViolations(`
      this.store.query('DELETE WHERE { ?s ?p ?o }');
      store.query('SELECT ?s WHERE { ?s ?p ?o }; DROP ALL');
      params.store.query('VALUES ?s { <urn:s> }');
      store.query('SELECT ?s WHERE { ?s ?p ?o }');
    `, 'fixture.ts');

    expect(violations).toEqual([
      'fixture.ts:2: non-read static store.query()',
      'fixture.ts:3: non-read static store.query()',
      'fixture.ts:4: non-read static store.query()',
    ]);
  });
});
