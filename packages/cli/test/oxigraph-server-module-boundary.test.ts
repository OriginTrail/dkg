import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function source(name: string): ts.SourceFile {
  const path = new URL(`../src/daemon/${name}`, import.meta.url);
  return ts.createSourceFile(
    name,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function imports(file: ts.SourceFile): string[] {
  return file.statements
    .filter(ts.isImportDeclaration)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
}

function newExpressions(file: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) names.push(node.expression.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function calledIdentifiers(file: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

describe('managed Oxigraph supervisor module boundary', () => {
  it('keeps the public entrypoint as composition-only glue', () => {
    const facade = source('oxigraph-server.ts');

    expect(imports(facade)).toEqual([
      './oxigraph-server-supervisor.js',
      './oxigraph-server-contract.js',
    ]);
    expect(calledIdentifiers(facade)).toContain('createOxigraphServerSupervisorV1');
    expect(calledIdentifiers(facade)).not.toContain('setTimeout');
    expect(calledIdentifiers(facade)).not.toContain('spawn');
    expect(calledIdentifiers(facade)).not.toContain('fetch');
  });

  it('composes exactly one lifecycle, timer, child, and probe owner', () => {
    const supervisor = source('oxigraph-server-supervisor.ts');
    const constructed = newExpressions(supervisor);

    expect(
      constructed.filter((name) => name === 'SerializedOxigraphLifecycleV1'),
    ).toHaveLength(1);
    expect(
      constructed.filter((name) => name === 'OxigraphSupervisorTimersV1'),
    ).toHaveLength(1);
    expect(
      constructed.filter((name) => name === 'OxigraphSupervisorChildV1'),
    ).toHaveLength(1);
    expect(
      constructed.filter((name) => name === 'OxigraphSupervisorProbesV1'),
    ).toHaveLength(1);
    expect(
      constructed.filter(
        (name) => name === 'OxigraphSupervisorReviveBackoffV1',
      ),
    ).toHaveLength(1);
    expect(calledIdentifiers(supervisor)).toContain('createOxigraphSupervisorOwnershipV1');
    expect(calledIdentifiers(supervisor)).not.toContain('setTimeout');
    expect(calledIdentifiers(supervisor)).not.toContain('clearTimeout');
  });
});
