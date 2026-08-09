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
  const calleeNames = (expression: ts.Expression): string[] => {
    if (ts.isIdentifier(expression)) return [expression.text];
    if (ts.isPropertyAccessExpression(expression)) {
      return [...calleeNames(expression.expression), expression.name.text];
    }
    if (ts.isElementAccessExpression(expression)) {
      const argument = expression.argumentExpression;
      return [
        ...calleeNames(expression.expression),
        ...(ts.isStringLiteral(argument) ? [argument.text] : []),
      ];
    }
    return [];
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) names.push(...calleeNames(node.expression));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

describe('managed Oxigraph supervisor module boundary', () => {
  it('detects direct and member-expression calls in architecture rules', () => {
    const fixture = ts.createSourceFile(
      'forbidden-calls.ts',
      'fetch(url); globalThis.fetch(url); childProcess.spawn(bin); timers["setTimeout"](fn);',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(calledIdentifiers(fixture)).toEqual(expect.arrayContaining([
      'fetch',
      'spawn',
      'setTimeout',
    ]));
  });

  it('keeps the public entrypoint as composition-only glue', () => {
    const facade = source('oxigraph-server.ts');

    expect(imports(facade).sort()).toEqual([
      './oxigraph-server-supervisor.js',
      './oxigraph-server-contract.js',
    ].sort());
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
      const calls = calledIdentifiers(operation);
      expect(imports(operation)).not.toContain('./oxigraph-server-contract.js');
      expect(imports(operation)).not.toContain('./oxigraph-supervisor-operation-context.js');
      for (const forbiddenCall of [
        'spawn',
        'probeReady',
        'transition',
        'setHandoffPhase',
        'lifecycle',
        'terminating',
        'handoffPhase',
      ]) {
        expect(calls).not.toContain(forbiddenCall);
      }
    }

    const generationCalls = calledIdentifiers(source('oxigraph-supervisor-generation.ts'));
    expect(generationCalls).toEqual(expect.arrayContaining([
      'spawn',
      'probeReady',
      'bindReadyGeneration',
    ]));
    expect(generationCalls).not.toContain('transition');
  });

  it('models lifecycle and handoff transitions through legal intents', () => {
    const state = new OxigraphSupervisorStateV1();
    expect([state.lifecycle(), state.handoffPhase(), state.terminating()])
      .toEqual(['starting', 'none', false]);

    state.bindReadyGeneration();
    state.beginHandoffRetirement();
    state.markHandoffRetired();
    expect([state.lifecycle(), state.handoffPhase()]).toEqual(['recovering', 'retired']);
    expect(() => state.tryBeginRevive()).toThrow(/handoff phase is retired/);

    state.beginCleanGeneration();
    state.bindReadyGeneration();
    expect([state.lifecycle(), state.handoffPhase()]).toEqual(['ready', 'none']);

    state.beginTermination();
    expect(() => state.beginRecovery()).toThrow(/after shutdown began/);
    expect(state.beginStopping()).toBe(true);
    state.markClosed();
    expect(state.beginStopping()).toBe(false);
    expect([state.lifecycle(), state.handoffPhase(), state.terminating()])
      .toEqual(['closed', 'none', true]);
  });
});
