import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SemanticProgramBinding, SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SemanticRuntimeStore } from '../../semantic-runtime/src/persistence.js';
import { SemanticProgramConfiguration } from '../src/semantic-runtime-configuration.js';
import {
  programBindingDigest, validateEffectiveProgramConfiguration, validateProgramBindings,
  validateProgramConfiguration, validateProgramRoutes,
} from '../src/semantic-runtime-program-bindings.js';
import { invokeBoundSemanticProgram, validateSemanticRuntimeConfig } from '../src/semantic-runtime.js';

const owner = '0x1111111111111111111111111111111111111111';
const stores: SemanticRuntimeStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(file = ':memory:') {
  const store = new SemanticRuntimeStore(file); stores.push(store); return store;
}
function binding(index: number, graph = 'tenant-one'): SemanticProgramBinding {
  return {
    contextGraphId: graph, operationIri: `urn:example:operation:${index}`, enabled: true,
    allowedCallerAgentAddresses: [owner], executorAgentAddress: owner, executionLayer: 'wm',
    program: { contextGraphId: graph + '-programs', programIri: `urn:example:program:${index}`,
      programLayer: 'wm', authorAgentAddress: owner, sourceHash: 'ab'.repeat(32) },
    assetCreation: { toolIri: 'urn:example:tool:create' },
  };
}
const bindings = (count: number, graph: string) => Array.from({ length: count }, (_, i) => binding(i, graph));
const route = (index: number, graph = 'tenant-one') => ({ contextGraphId: graph, operationIri: `urn:example:route:${index}`, targetPeerId: 'peer-one' });

describe('graph-scoped durable Program configuration', () => {
  it('retains the 256-entry trusted file input limits', () => {
    expect(() => validateProgramBindings(bindings(257, 'tenant-one'))).toThrow('INVALID_PROGRAM_BINDINGS');
    const acrossGraphs = [...bindings(256, 'tenant-one'), binding(0, 'tenant-two')];
    expect(() => validateProgramBindings(acrossGraphs)).toThrow('INVALID_PROGRAM_BINDINGS');
    expect(() => validateProgramRoutes(Array.from({ length: 257 }, (_, i) => route(i, 'tenant-' + i)))).toThrow('INVALID_PROGRAM_ROUTES');
    expect(() => new SemanticProgramConfiguration(open(), { programBindings: acrossGraphs })).toThrow('INVALID_PROGRAM_BINDINGS');
  });

  it('allows independent effective graph quotas and rejects a 257th operation in one graph', () => {
    const effective = [...bindings(256, 'tenant-one'), ...bindings(256, 'tenant-two')];
    expect(() => validateEffectiveProgramConfiguration(effective, [])).not.toThrow();
    expect(() => validateSemanticRuntimeConfig({ programBindings: effective })).not.toThrow();
    expect(() => validateEffectiveProgramConfiguration([...effective, binding(256)], [])).toThrow('INVALID_PROGRAM_BINDINGS');
    expect(() => validateProgramConfiguration(effective, [])).toThrow('INVALID_PROGRAM_BINDINGS');
  });

  it('validates every effective grant, including malformed entries and duplicate operations', () => {
    const effective = [...bindings(256, 'tenant-one'), binding(0, 'tenant-two')];
    expect(() => validateEffectiveProgramConfiguration([...effective, { ...binding(1, 'tenant-two'), executorAgentAddress: 'invalid' }], [])).toThrow('INVALID_PROGRAM_BINDING');
    expect(() => validateEffectiveProgramConfiguration([...effective, binding(0, 'tenant-two')], [])).toThrow('DUPLICATE_PROGRAM_BINDING');
    expect(() => validateEffectiveProgramConfiguration([...effective, { ...binding(1, 'tenant-two'), contextGraphId: 'bad graph' }], [])).toThrow('INVALID_PROGRAM_BINDING_GRAPH');
    expect(() => validateEffectiveProgramConfiguration(null, [])).toThrow('INVALID_PROGRAM_BINDINGS');
  });

  it('keeps graph-local route limits, duplicate detection and binding/route ambiguity', () => {
    const routes = [...Array.from({ length: 256 }, (_, i) => route(i)), ...Array.from({ length: 256 }, (_, i) => route(i, 'tenant-two'))];
    expect(() => validateEffectiveProgramConfiguration([], routes)).not.toThrow();
    expect(() => validateEffectiveProgramConfiguration([], [...routes, route(256)])).toThrow('INVALID_PROGRAM_ROUTES');
    expect(() => validateEffectiveProgramConfiguration([], [...routes.slice(0, -1), route(0, 'tenant-two')])).toThrow('DUPLICATE_PROGRAM_ROUTE');
    expect(() => validateEffectiveProgramConfiguration([], [...routes, { ...route(256, 'tenant-two'), targetPeerId: '' }])).toThrow('INVALID_PROGRAM_ROUTE');
    expect(() => validateEffectiveProgramConfiguration(bindings(1, 'tenant-two'), [{ ...route(0, 'tenant-two'), operationIri: binding(0).operationIri }])).toThrow('AMBIGUOUS_PROGRAM_ROUTE');
  });

  it('persists more than 256 total grants, restarts, and preserves exact pins and owner ACLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-config-quota-')); dirs.push(dir);
    const file = join(dir, 'runtime.sqlite'); let store = open(file);
    let config: SemanticRuntimeConfig = {};
    const manager = new SemanticProgramConfiguration(store as any, config);
    for (const item of bindings(256, 'tenant-one')) manager.write('binding', item.contextGraphId, item.operationIri, item, 0, owner);
    const extra = binding(0, 'tenant-two');
    const before = manager.write('binding', extra.contextGraphId, extra.operationIri, extra, 0, owner);
    expect(store.programConfigurationRecords()).toHaveLength(257);
    expect(config.programBindings).toHaveLength(257);
    store.close(); store = open(file); config = {};
    const restarted = new SemanticProgramConfiguration(store as any, config);
    expect(config.programBindings).toHaveLength(257);
    expect(restarted.inspect('binding', extra.contextGraphId, extra.operationIri)).toEqual(before);
    expect(before.binding!.allowedCallerAgentAddresses).toEqual([owner]);
    expect(before.bindingDigest).toBe(programBindingDigest(before.binding!));
  });

  it('retains revocation CAS slots at the exact per-graph cap and rejects overflow before commit', () => {
    const store = open(); const config: SemanticRuntimeConfig = {};
    const manager = new SemanticProgramConfiguration(store as any, config);
    for (const item of bindings(256, 'tenant-one')) manager.write('binding', item.contextGraphId, item.operationIri, item, 0, owner);
    const first = binding(0);
    const revoked = manager.write('binding', first.contextGraphId, first.operationIri, { ...first, enabled: false }, 1, owner);
    expect(revoked.revision).toBe(2); expect(revoked.binding!.enabled).toBe(false);
    expect(() => manager.write('binding', first.contextGraphId, first.operationIri, first, 1, owner)).toThrow('PROGRAM_CONFIGURATION_CONFLICT');
    const overflow = binding(256);
    expect(() => manager.write('binding', overflow.contextGraphId, overflow.operationIri, overflow, 0, owner)).toThrow('INVALID_PROGRAM_BINDINGS');
    expect(store.programConfigurationRecords()).toHaveLength(256);
    expect(manager.inspect('binding', overflow.contextGraphId, overflow.operationIri)).toBeUndefined();
    const another = binding(0, 'tenant-two');
    expect(() => manager.write('binding', another.contextGraphId, another.operationIri, another, 0, owner)).not.toThrow();
  });

  it('keeps durable route tombstones at the cap and uses independent graph/kind quotas', () => {
    const store = open();
    const write = (item: ReturnType<typeof route>, revision = 0, payload: string | null = JSON.stringify(item)) => store.writeProgramConfiguration({
      kind: 'route', contextGraphId: item.contextGraphId, operationIri: item.operationIri, payload, updatedBy: owner, updatedAt: 1,
    }, revision);
    for (let i = 0; i < 256; i++) write(route(i));
    expect(write(route(0), 1, null)).toBe(2);
    expect(() => write(route(256))).toThrow('PROGRAM_CONFIGURATION_LIMIT');
    expect(() => write(route(0, 'tenant-two'))).not.toThrow();
    expect(() => write(route(0), 1)).toThrow('PROGRAM_CONFIGURATION_CONFLICT');
    const grant = { ...binding(0), authorizationRevision: 1 };
    expect(() => store.writeProgramConfiguration({ kind: 'binding', contextGraphId: grant.contextGraphId,
      operationIri: grant.operationIri, payload: JSON.stringify(grant), updatedBy: owner, updatedAt: 1 }, 0)).not.toThrow();
    const config: SemanticRuntimeConfig = {};
    const manager = new SemanticProgramConfiguration(store as any, config);
    expect(config.programRoutes).toHaveLength(256);
    expect(manager.inspect('route', 'tenant-one', route(0).operationIri)!.route).toBeNull();
  });

  it('validates durable schema/revisions and rejects ambiguous route updates before persistence', () => {
    const store = open(); const manager = new SemanticProgramConfiguration(store as any, {});
    const first = binding(0); manager.write('binding', first.contextGraphId, first.operationIri, first, 0, owner);
    expect(() => manager.write('route', first.contextGraphId, first.operationIri,
      { ...route(0), operationIri: first.operationIri }, 0, owner)).toThrow('AMBIGUOUS_PROGRAM_ROUTE');
    expect(store.programConfigurationRecords()).toHaveLength(1);
    expect(() => manager.write('binding', 'tenant-two', 'urn:example:operation:1', { ...binding(1, 'tenant-two'), enabled: 'yes' } as any, 0, owner)).toThrow('INVALID_PROGRAM_BINDING');
    expect(store.programConfigurationRecords()).toHaveLength(1);
    const invalid = { ...binding(1, 'tenant-two'), authorizationRevision: 2 };
    store.writeProgramConfiguration({ kind: 'binding', contextGraphId: invalid.contextGraphId, operationIri: invalid.operationIri,
      payload: JSON.stringify(invalid), updatedBy: owner, updatedAt: 1 }, 0);
    expect(() => new SemanticProgramConfiguration(store as any, {})).toThrow('PROGRAM_CONFIGURATION_REVISION_MISMATCH');
  });

  it('checks invocation authority in its own bounded graph after independent approvals exceed 256', async () => {
    const effective = [...bindings(256, 'tenant-one'), binding(0, 'tenant-two')];
    const query = vi.fn(); const agent = { query };
    await expect(invokeBoundSemanticProgram(agent as any, {} as any, 'tenant-two', binding(0).operationIri,
      '123e4567-e89b-42d3-a456-426614174099', { programBindings: effective }, undefined)).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
    await expect(invokeBoundSemanticProgram(agent as any, {} as any, 'tenant-one', binding(0).operationIri,
      '123e4567-e89b-42d3-a456-426614174099', { programBindings: [...effective, binding(256)] }, undefined)).rejects.toThrow('INVALID_PROGRAM_BINDINGS');
    await expect(invokeBoundSemanticProgram(agent as any, {} as any, 'tenant-two', binding(0).operationIri,
      '123e4567-e89b-42d3-a456-426614174099', { programBindings: [...effective, { ...binding(1, 'tenant-two'), executorAgentAddress: 'bad' }] }, owner)).rejects.toThrow('INVALID_PROGRAM_BINDING');
  });
});
