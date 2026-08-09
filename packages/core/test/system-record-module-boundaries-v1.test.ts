import { readdirSync, readFileSync } from 'node:fs';

import * as ts from 'typescript';

import { describe, expect, it } from 'vitest';
import { SYSTEM_RECORD_OBJECT_CAPS_V1 } from '../src/system-record-limits-v1.js';
import {
  SYSTEM_RECORD_OBJECT_IDENTITY_DERIVERS_V1,
} from '../src/system-record-object-identity-descriptors-v1-internal.js';

const source = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const systemRecordModules = new Set(
  readdirSync(new URL('../src', import.meta.url))
    .filter((name) => name.startsWith('system-record-') && name.endsWith('.ts')),
);

function directDependencies(name: string): ReadonlySet<string> {
  const parsed = ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);
  const dependencies = new Set<string>();
  for (const statement of parsed.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('./')
    ) {
      const dependency = statement.moduleSpecifier.text.slice(2).replace(/\.js$/u, '.ts');
      if (systemRecordModules.has(dependency)) dependencies.add(dependency);
    }
  }
  return dependencies;
}

const dependencyGraph = new Map(
  [...systemRecordModules].map((name) => [name, directDependencies(name)]),
);

function transitiveDependencies(name: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [...(dependencyGraph.get(name) ?? [])];
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined || visited.has(dependency)) continue;
    visited.add(dependency);
    pending.push(...(dependencyGraph.get(dependency) ?? []));
  }
  return visited;
}

function expectNoDependencyPath(name: string, forbidden: readonly string[]): void {
  const reachable = transitiveDependencies(name);
  for (const dependency of forbidden) expect(reachable).not.toContain(dependency);
}

describe('System Record V1 module ownership', () => {
  it('keeps the supported object and inventory facades explicit', () => {
    for (const facade of ['system-record-objects-v1.ts', 'system-record-inventory-v1.ts']) {
      expect(source(facade)).not.toMatch(/export\s+\*/u);
    }
  });

  it('composes the package facade only from the approved public subfacades', () => {
    const facade = source('system-record-v1.ts');
    const wildcardSources = [...facade.matchAll(/export\s+\*\s+from\s+'([^']+)'/gu)]
      .map((match) => match[1]);
    expect(wildcardSources).toEqual([
      './system-record-limits-v1.js',
      './system-record-objects-v1.js',
      './agent-profile-projection-schema-v1.js',
      './system-record-applied-state-v1.js',
      './system-record-inventory-v1.js',
      './system-record-wire-v1.js',
    ]);
    expect(facade).not.toMatch(/-internal\.js/u);
  });

  it('keeps internal ownership units off compatibility facades', () => {
    for (const unit of [
      'system-record-agent-profile-primitives-v1-internal.ts',
      'system-record-agent-profile-head-codec-v1-internal.ts',
      'system-record-agent-profile-control-codecs-v1-internal.ts',
      'system-record-agent-profile-evidence-codecs-v1-internal.ts',
      'system-record-owned-subject-codecs-v1-internal.ts',
      'system-record-signed-envelope-codecs-v1-internal.ts',
      'system-record-signature-policy-v1-internal.ts',
      'system-record-signatures-v1-internal.ts',
      'system-record-authority-verification-v1-internal.ts',
      'system-record-authority-v1-internal.ts',
      'system-record-verification-closure-v1-internal.ts',
      'system-record-cache-accounting-v1-internal.ts',
      'system-record-object-identity-descriptors-v1-internal.ts',
      'system-record-inventory-codecs-v1-internal.ts',
      'system-record-inventory-signatures-v1-internal.ts',
      'system-record-inventory-traversal-v1-internal.ts',
      'system-record-inventory-cow-build-v1-internal.ts',
      'system-record-inventory-cow-context-v1-internal.ts',
      'system-record-inventory-cow-update-v1-internal.ts',
      'system-record-inventory-cow-v1-internal.ts',
    ]) {
      expectNoDependencyPath(unit, ['system-record-objects-v1.ts', 'system-record-inventory-v1.ts']);
    }
  });

  it('keeps inventory codecs, traversal, and COW mutation independent of authority policy', () => {
    for (const unit of [
      'system-record-inventory-codecs-v1-internal.ts',
      'system-record-inventory-traversal-v1-internal.ts',
      'system-record-inventory-cow-build-v1-internal.ts',
      'system-record-inventory-cow-context-v1-internal.ts',
      'system-record-inventory-cow-update-v1-internal.ts',
      'system-record-inventory-cow-v1-internal.ts',
    ]) {
      expectNoDependencyPath(unit, [
        'system-record-objects-v1.ts',
        'system-record-authority-v1-internal.ts',
        'system-record-verification-closure-v1-internal.ts',
        'system-record-cache-accounting-v1-internal.ts',
      ]);
    }
  });

  it('keeps inventory data codecs below provider signature verification', () => {
    expectNoDependencyPath('system-record-inventory-codecs-v1-internal.ts', [
      'system-record-inventory-signatures-v1-internal.ts',
    ]);
    expect(directDependencies('system-record-inventory-signatures-v1-internal.ts')).toContain(
      'system-record-inventory-codecs-v1-internal.ts',
    );
    expect(source('system-record-inventory-codecs-v1-internal.ts'))
      .not.toMatch(/@libp2p\/|@noble\/ed25519/u);
  });

  it('owns one exhaustive internal identity deriver for every object kind', () => {
    expect(Object.keys(SYSTEM_RECORD_OBJECT_IDENTITY_DERIVERS_V1).sort())
      .toEqual(Object.keys(SYSTEM_RECORD_OBJECT_CAPS_V1).sort());
    expect(Object.isFrozen(SYSTEM_RECORD_OBJECT_IDENTITY_DERIVERS_V1)).toBe(true);
    for (const derive of Object.values(SYSTEM_RECORD_OBJECT_IDENTITY_DERIVERS_V1)) {
      expect(derive).toBeTypeOf('function');
    }
    expect(source('system-record-inventory-v1.ts'))
      .not.toContain('system-record-object-identity-descriptors-v1-internal');
  });

  it('keeps COW implementation units acyclic and below the file-health boundary', () => {
    const build = source('system-record-inventory-cow-build-v1-internal.ts');
    const context = source('system-record-inventory-cow-context-v1-internal.ts');
    const update = source('system-record-inventory-cow-update-v1-internal.ts');

    expectNoDependencyPath('system-record-inventory-cow-build-v1-internal.ts', [
      'system-record-inventory-cow-context-v1-internal.ts',
      'system-record-inventory-cow-update-v1-internal.ts',
      'system-record-inventory-cow-v1-internal.ts',
    ]);
    expectNoDependencyPath('system-record-inventory-cow-context-v1-internal.ts', [
      'system-record-inventory-cow-update-v1-internal.ts',
      'system-record-inventory-cow-v1-internal.ts',
    ]);
    expectNoDependencyPath('system-record-inventory-cow-update-v1-internal.ts', [
      'system-record-inventory-cow-v1-internal.ts',
    ]);
    expect(build.split('\n').length).toBeLessThan(1_000);
    expect(context.split('\n').length).toBeLessThan(1_000);
    expect(update.split('\n').length).toBeLessThan(1_000);
  });

  it('keeps profile data codecs independent of signature verification', () => {
    for (const unit of [
      'system-record-agent-profile-primitives-v1-internal.ts',
      'system-record-agent-profile-head-codec-v1-internal.ts',
      'system-record-agent-profile-control-codecs-v1-internal.ts',
      'system-record-agent-profile-evidence-codecs-v1-internal.ts',
      'system-record-owned-subject-codecs-v1-internal.ts',
    ]) {
      expectNoDependencyPath(unit, ['system-record-signatures-v1-internal.ts']);
    }
  });

  it('keeps cache identity below profile signature verification', () => {
    expectNoDependencyPath('system-record-object-identity-descriptors-v1-internal.ts', [
      'system-record-signatures-v1-internal.ts',
    ]);
    expect(directDependencies('system-record-object-identity-descriptors-v1-internal.ts'))
      .toContain('system-record-signed-envelope-codecs-v1-internal.ts');
    expect(directDependencies('system-record-signatures-v1-internal.ts'))
      .toContain('system-record-signed-envelope-codecs-v1-internal.ts');
    expect(directDependencies('system-record-signed-envelope-codecs-v1-internal.ts'))
      .toContain('system-record-signature-policy-v1-internal.ts');
    expect(directDependencies('system-record-signatures-v1-internal.ts'))
      .toContain('system-record-signature-policy-v1-internal.ts');
    expect(source('system-record-signed-envelope-codecs-v1-internal.ts'))
      .not.toMatch(/@noble\/|Signature\.fromBytes|signature message/u);
    expect(source('system-record-signature-policy-v1-internal.ts'))
      .not.toMatch(/@noble\/ed25519|verifyEd25519/u);
    expect(source('system-record-signatures-v1-internal.ts')).toMatch(/@noble\/ed25519/u);
    expect(source('system-record-signed-envelope-codecs-v1-internal.ts'))
      .not.toMatch(/concatSystemRecordBytesV1|systemRecordHexToBytesV1/u);
  });

  it('keeps closure verification below authority policy and summary minting private', () => {
    expectNoDependencyPath('system-record-verification-closure-v1-internal.ts', [
      'system-record-authority-v1-internal.ts',
    ]);
    expectNoDependencyPath('system-record-authority-verification-v1-internal.ts', [
      'system-record-verification-closure-v1-internal.ts',
    ]);
    expect(directDependencies('system-record-authority-v1-internal.ts')).toContain(
      'system-record-verification-closure-v1-internal.ts',
    );
    expect(source('system-record-verification-closure-v1-internal.ts')).toMatch(
      /function mintAgentProfileVerifiedAuthoritySummaryV1/u,
    );
    expect(directDependencies('system-record-verification-closure-v1-internal.ts')).toContain(
      'system-record-verification-closure-visitors-v1-internal.ts',
    );
    expectNoDependencyPath('system-record-verification-closure-visitors-v1-internal.ts', [
      'system-record-verification-closure-v1-internal.ts',
    ]);
  });

  it('keeps closure and cache internals below durable code-health boundaries', () => {
    expect(source('system-record-verification-closure-v1-internal.ts').split('\n').length)
      .toBeLessThan(850);
    expect(source('system-record-verification-closure-visitors-v1-internal.ts').split('\n').length)
      .toBeLessThan(350);
    expect(source('system-record-cache-accounting-v1-internal.ts').split('\n').length)
      .toBeLessThan(650);
    for (const unit of [
      'system-record-verification-closure-v1-internal.ts',
      'system-record-verification-closure-visitors-v1-internal.ts',
      'system-record-cache-accounting-v1-internal.ts',
    ]) {
      expect(source(unit)).not.toMatch(/export\s+\*/u);
    }
  });

  it('keeps wire and applied-state codecs off authority and closure implementations', () => {
    for (const unit of ['system-record-wire-v1.ts', 'system-record-applied-state-v1.ts']) {
      expectNoDependencyPath(unit, [
        'system-record-objects-v1.ts',
        'system-record-authority-v1-internal.ts',
        'system-record-verification-closure-v1-internal.ts',
        'system-record-cache-accounting-v1-internal.ts',
      ]);
    }
  });
});
