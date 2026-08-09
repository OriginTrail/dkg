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

  it('keeps lifecycle phases in focused operation modules', () => {
    const supervisor = source('oxigraph-server-supervisor.ts');
    expect(imports(supervisor)).toEqual(expect.arrayContaining([
      './oxigraph-supervisor-state.js',
      './oxigraph-supervisor-generation.js',
      './oxigraph-supervisor-recovery-operations.js',
      './oxigraph-supervisor-shutdown-operations.js',
      './oxigraph-supervisor-handoff-operations.js',
      './oxigraph-supervisor-startup-operations.js',
    ]));
    expect(calledIdentifiers(supervisor)).toContain('createOxigraphSupervisorOwnershipV1');
    expect(calledIdentifiers(supervisor)).not.toContain('setTimeout');
    expect(calledIdentifiers(supervisor)).not.toContain('clearTimeout');
    expect(calledIdentifiers(supervisor)).not.toContain('spawn');
    expect(calledIdentifiers(supervisor)).not.toContain('fetch');

    for (const name of [
      'oxigraph-supervisor-recovery-operations.ts',
      'oxigraph-supervisor-shutdown-operations.ts',
      'oxigraph-supervisor-handoff-operations.ts',
      'oxigraph-supervisor-startup-operations.ts',
    ]) {
      const operation = source(name);
      const text = operation.getFullText();
      expect(imports(operation)).not.toContain('./oxigraph-server-contract.js');
      expect(imports(operation)).not.toContain('./oxigraph-supervisor-operation-context.js');
      expect(text).not.toMatch(/\.spawn\(|\.probeReady\(|\.current\(\)!/u);
    }

    const generation = source('oxigraph-supervisor-generation.ts').getFullText();
    expect(generation).toMatch(/\.spawn\(/u);
    expect(generation).toMatch(/\.probeReady\(/u);
    expect(generation).toMatch(/bindReadyGeneration\(/u);
  });
});
