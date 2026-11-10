import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  contextGraphAssertionUri,
  contextGraphDataUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphRulesUri,
  contextGraphSharedMemoryUri,
  contextGraphSubGraphMetaUri,
  contextGraphSubGraphUri,
} from '../src/constants.js';
import { MemoryLayer } from '../src/memory-model.js';
import {
  READ_GRAPH_SEGMENT,
  isReadGraphAgentAddress,
  isReadGraphEligibleContextGraphId,
  isReadGraphPartitionIri,
  parseReadGraphIri,
  readGraphIri,
  readGraphPartitionRoot,
  readGraphStateGraphIri,
  readScope,
  type ReadGraphKey,
} from '../src/index.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

const EVM = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';

describe('read-graph partition', () => {
  it('names the partition root and the state graph under the context graph prefix', () => {
    expect(READ_GRAPH_SEGMENT).toBe('_read');
    expect(readGraphPartitionRoot('0xabc/proj')).toBe('did:dkg:context-graph:0xabc/proj/_read');
    expect(readGraphStateGraphIri('0xabc/proj')).toBe('did:dkg:context-graph:0xabc/proj/_read/state');
  });

  it('recognizes the root and every graph under it, for any context graph', () => {
    for (const iri of [
      'did:dkg:context-graph:plain/_read',
      'did:dkg:context-graph:plain/_read/state',
      'did:dkg:context-graph:0xabc/proj/_read/cg/_verifiable_memory',
      'did:dkg:context-graph:0xabc/proj/_read/sub/code/_working_memory/0xaa',
      'did:dkg:context-graph:0xabc/proj/_read/anything/else',
      'did:dkg:context-graph:legacy/_old/_read',
    ]) {
      expect(isReadGraphPartitionIri(iri), iri).toBe(true);
    }
  });

  it('does not recognize other partitions, look-alike segments or other schemes', () => {
    for (const iri of [
      'did:dkg:context-graph:plain',
      'did:dkg:context-graph:_read',
      'did:dkg:context-graph:_read/cg/_verifiable_memory',
      'did:dkg:context-graph:plain/_readme',
      'did:dkg:context-graph:plain/_read_/x',
      'did:dkg:context-graph:plain/read/state',
      'did:dkg:context-graph:plain/_READ',
      'urn:dkg:internal:atomic-graph-replace:plain/_read',
      '<did:dkg:context-graph:plain/_read>',
      'did:dkg:read-graph:plain/_read',
      '',
    ]) {
      expect(isReadGraphPartitionIri(iri), iri).toBe(false);
    }
  });

  it('refuses a partition root for an invalid context graph ID', () => {
    expect(() => readGraphPartitionRoot('')).toThrow(/Invalid context graph ID/);
    expect(() => readGraphPartitionRoot('a b')).toThrow(/Invalid context graph ID/);
    expect(() => readGraphPartitionRoot('a/../b')).toThrow(/Invalid context graph ID/);
  });

  it('keeps the root of an older ID with a reserved segment, but gives it no state graph', () => {
    expect(isReadGraphEligibleContextGraphId('tenant/_meta')).toBe(false);
    expect(readGraphPartitionRoot('tenant/_meta')).toBe('did:dkg:context-graph:tenant/_meta/_read');
    expect(() => readGraphStateGraphIri('tenant/_meta')).toThrow(/cannot have read graphs/);
  });
});

describe('read-graph names', () => {
  it('names the shared layers of a whole context graph and of a sub-graph', () => {
    expect(readGraphIri({ scope: readScope('0xabc/proj'), layer: MemoryLayer.VerifiableMemory }))
      .toBe('did:dkg:context-graph:0xabc/proj/_read/cg/_verifiable_memory');
    expect(readGraphIri({ scope: readScope('0xabc/proj'), layer: MemoryLayer.SharedWorkingMemory }))
      .toBe('did:dkg:context-graph:0xabc/proj/_read/cg/_shared_memory');
    expect(readGraphIri({ scope: readScope('0xabc/proj', 'code'), layer: MemoryLayer.VerifiableMemory }))
      .toBe('did:dkg:context-graph:0xabc/proj/_read/sub/code/_verifiable_memory');
  });

  it('names one working-memory read graph per agent, with the canonical address', () => {
    expect(readGraphIri({ scope: readScope('0xabc/proj'), layer: MemoryLayer.WorkingMemory, agentAddress: EVM }))
      .toBe(`did:dkg:context-graph:0xabc/proj/_read/cg/_working_memory/${EVM.toLowerCase()}`);
    expect(readGraphIri({ scope: readScope('0xabc/proj', 'code'), layer: MemoryLayer.WorkingMemory, agentAddress: PEER }))
      .toBe(`did:dkg:context-graph:0xabc/proj/_read/sub/code/_working_memory/${PEER}`);
  });

  it('keeps a context graph and a same-named sub-graph apart', () => {
    const childContextGraph = readGraphIri({ scope: readScope('x/code'), layer: MemoryLayer.VerifiableMemory });
    const subGraph = readGraphIri({ scope: readScope('x', 'code'), layer: MemoryLayer.VerifiableMemory });
    expect(childContextGraph).not.toBe(subGraph);
    expect(parseReadGraphIri(childContextGraph)?.scope).toEqual(readScope('x/code'));
    expect(parseReadGraphIri(subGraph)?.scope).toEqual(readScope('x', 'code'));
  });

  it('refuses scopes and agents that cannot have a read graph', () => {
    const vm = MemoryLayer.VerifiableMemory;
    expect(() => readGraphIri({ scope: readScope('tenant/_meta'), layer: vm })).toThrow(/cannot have read graphs/);
    expect(() => readGraphIri({ scope: readScope(''), layer: vm })).toThrow(/cannot have read graphs/);
    for (const sub of ['_hidden', 'a/b', 'context', '', 'a b']) {
      expect(() => readGraphIri({ scope: readScope('x', sub), layer: vm }), sub).toThrow(/Invalid sub-graph name/);
    }
    for (const agent of ['', '0xaa/1', '.', '..', 'a b', 'a<b']) {
      expect(isReadGraphAgentAddress(agent), agent).toBe(false);
      expect(() => readGraphIri({ scope: readScope('x'), layer: MemoryLayer.WorkingMemory, agentAddress: agent }), agent)
        .toThrow(/cannot name a read graph/);
    }
    for (const agent of [EVM, PEER, 'did:dkg:agent:0xaa', 'a.b@c-d_e']) expect(isReadGraphAgentAddress(agent), agent).toBe(true);
    expect(() => readGraphIri({ scope: readScope('x'), layer: 'XX' } as unknown as ReadGraphKey)).toThrow(/Unknown read-graph layer/);
  });

  it('parses only the names it produces', () => {
    for (const iri of [
      'did:dkg:context-graph:x/_read',
      'did:dkg:context-graph:x/_read/state',
      'did:dkg:context-graph:x/_read/cg',
      'did:dkg:context-graph:x/_read/cg/_private',
      'did:dkg:context-graph:x/_read/cg/_verifiable_memory/extra',
      'did:dkg:context-graph:x/_read/cg/_working_memory',
      `did:dkg:context-graph:x/_read/cg/_working_memory/${EVM}`,
      'did:dkg:context-graph:x/_read/sub',
      'did:dkg:context-graph:x/_read/sub/_hidden/_shared_memory',
      'did:dkg:context-graph:x/_read/other/_shared_memory',
      'did:dkg:context-graph:_read/cg/_shared_memory',
      'did:dkg:context-graph:x/_meta/_read/cg/_shared_memory',
      'did:dkg:context-graph:x/_shared_memory',
      'urn:x:_read/cg/_shared_memory',
    ]) {
      expect(parseReadGraphIri(iri), iri).toBeUndefined();
    }
  });

  it('round-trips every scope, layer and agent spelling', () => {
    const contextGraphId = fc.array(fc.stringMatching(/^[a-zA-Z0-9:.@-][\w:.@-]{0,11}$/), { minLength: 1, maxLength: 3 })
      .map((segments) => segments.join('/'))
      .filter(isReadGraphEligibleContextGraphId);
    const subGraphName = fc.option(fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,11}$/)
      .filter((name) => !['context', 'assertion', 'draft'].includes(name)), { nil: undefined });
    const layer = fc.oneof(
      fc.constantFrom(MemoryLayer.SharedWorkingMemory, MemoryLayer.VerifiableMemory).map((value) => ({ layer: value })),
      fc.oneof(fc.stringMatching(/^0x[0-9a-fA-F]{40}$/), fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{8,52}$/))
        .map((agentAddress) => ({ layer: MemoryLayer.WorkingMemory as const, agentAddress })),
    );
    fc.assert(fc.property(contextGraphId, subGraphName, layer, (id, sub, layerPart) => {
      const key = { scope: readScope(id, sub), ...layerPart } as ReadGraphKey;
      const iri = readGraphIri(key);
      expect(iri.startsWith(`${readGraphPartitionRoot(id)}/`)).toBe(true);
      expect(isReadGraphPartitionIri(iri)).toBe(true);
      const parsed = parseReadGraphIri(iri);
      expect(parsed).toBeDefined();
      expect(readGraphIri(parsed!)).toBe(iri);
      expect(parsed!.scope).toEqual(key.scope);
      expect(parsed!.layer).toBe(key.layer);
      if (key.layer === MemoryLayer.WorkingMemory && parsed!.layer === MemoryLayer.WorkingMemory) {
        expect(parsed!.agentAddress.toLowerCase()).toBe(key.agentAddress.toLowerCase());
      }
      expect(isReadGraphPartitionIri(readGraphStateGraphIri(id))).toBe(true);
      expect(parseReadGraphIri(readGraphStateGraphIri(id))).toBeUndefined();
    }), propertyOptions());
  });

  it('never classifies the graphs a context graph already has as read graphs', () => {
    const id = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,8}(\/[a-z0-9][a-z0-9.-]{0,8}){0,2}$/);
    const sub = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,8}$/).filter((name) => !['context', 'assertion', 'draft'].includes(name));
    fc.assert(fc.property(id, sub, fc.nat(), (cg, name, number) => {
      for (const iri of [
        contextGraphDataUri(cg), contextGraphMetaUri(cg), contextGraphPrivateUri(cg), contextGraphRulesUri(cg),
        contextGraphDataUri(cg, '7'), contextGraphSharedMemoryUri(cg), contextGraphSharedMemoryUri(cg, name),
        contextGraphSubGraphUri(cg, name), contextGraphSubGraphMetaUri(cg, name),
        contextGraphAssertionUri(cg, EVM, 'draft-1', name),
        contextGraphLayerUri(cg, MemoryLayer.VerifiableMemory, EVM, number),
        contextGraphLayerUri(cg, MemoryLayer.WorkingMemory, EVM, number, name),
      ]) {
        expect(isReadGraphPartitionIri(iri), iri).toBe(false);
        expect(parseReadGraphIri(iri), iri).toBeUndefined();
      }
    }), propertyOptions());
  });
});
