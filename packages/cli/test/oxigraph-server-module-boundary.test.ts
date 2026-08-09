import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { OxigraphSupervisorStateV1 } from '../src/daemon/oxigraph-supervisor-state.js';

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
    const supervisorText = supervisor.getFullText();
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
    expect(supervisorText).toContain('registerCurrentExitHandler');
    expect(supervisorText).not.toMatch(/let\s+recovery!/u);

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
      expect(text).not.toMatch(/\.transition\(|\.setHandoffPhase\(/u);
    }

    const generation = source('oxigraph-supervisor-generation.ts').getFullText();
    expect(generation).toMatch(/\.spawn\(/u);
    expect(generation).toMatch(/\.probeReady\(/u);
    expect(generation).toMatch(/bindReadyGeneration\(/u);
    expect(generation).not.toMatch(/\.transition\(/u);
  });

  it('models lifecycle and handoff transitions through legal intents', () => {
    const state = new OxigraphSupervisorStateV1();
    expect([state.lifecycle(), state.handoffPhase(), state.terminating()])
      .toEqual(['starting', 'none', false]);

    state.bindReadyGeneration();
    state.beginHandoffRetirement();
    state.markHandoffRetired();
    expect([state.lifecycle(), state.handoffPhase()]).toEqual(['recovering', 'retired']);
    expect(() => state.beginRevive()).toThrow(/handoff phase is retired/);

    state.beginCleanGeneration();
    state.bindReadyGeneration();
    expect([state.lifecycle(), state.handoffPhase()]).toEqual(['ready', 'none']);

    state.beginTermination();
    expect(() => state.beginRecovery()).toThrow(/after shutdown began/);
    state.beginStopping();
    state.markClosed();
    expect([state.lifecycle(), state.handoffPhase(), state.terminating()])
      .toEqual(['closed', 'none', true]);
  });
});
