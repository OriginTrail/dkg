import { readFileSync, readdirSync } from 'node:fs';
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

function daemonSourceNames(): string[] {
  return readdirSync(new URL('../src/daemon/', import.meta.url))
    .filter((name) => name.endsWith('.ts'));
}

describe('managed Oxigraph supervisor module boundary', () => {
  it('keeps the public entrypoint dependent only on its contract and composer', () => {
    const facade = source('oxigraph-server.ts');

    expect(imports(facade).sort()).toEqual([
      './oxigraph-server-supervisor.js',
      './oxigraph-server-contract.js',
    ].sort());
  });

  it('routes operation dependencies through the supervisor composer', () => {
    const operationFiles = daemonSourceNames()
      .filter((name) => /^oxigraph-supervisor-.+-operations\.ts$/u.test(name))
      .sort();
    const operationSpecifiers = operationFiles
      .map((name) => `./${name.replace(/\.ts$/u, '.js')}`)
      .sort();
    const supervisor = source('oxigraph-server-supervisor.ts');
    expect(imports(supervisor).filter((specifier) => operationSpecifiers.includes(specifier)).sort())
      .toEqual(operationSpecifiers);

    const operationImporters = daemonSourceNames()
      .filter((name) => imports(source(name)).some((specifier) =>
        operationSpecifiers.includes(specifier)))
      .sort();
    expect(operationImporters).toEqual(['oxigraph-server-supervisor.ts']);

    const forbiddenOperationDependencies = new Set([
      './oxigraph-server.js',
      './oxigraph-server-contract.js',
      './oxigraph-server-supervisor.js',
    ]);
    for (const name of operationFiles) {
      expect(imports(source(name)).filter((specifier) =>
        forbiddenOperationDependencies.has(specifier)))
        .toEqual([]);
    }
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
