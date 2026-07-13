import { describe, expect, it } from 'vitest';
import {
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphDataUri,
  contextGraphSharedMemoryUri,
  assertionLifecycleUri,
  contextGraphMetaUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { KA_ID_PRED, VM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

const CG = 'publish-agent-lane';
const NAME = 'asset';
const DEFAULT_AGENT = `0x${'11'.repeat(20)}`;
const AGENT_B = `0x${'22'.repeat(20)}`;
const ROOT = 'urn:test:agent-b-root';
const MERKLE = new Uint8Array(32).fill(7);
const RESERVED_KA_ID = (BigInt(AGENT_B) << 96n) | 1n;

function makeLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

describe('DKGAgent publishFromFinalizedAssertion agent lane', () => {
  it('injects the curated catalog floor into the exact named lifecycle graph', async () => {
    const store = new OxigraphStore();
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.log = makeLog();
    const swmGraph = contextGraphSharedMemoryUri(CG);
    const exactGraph = `${swmGraph}/${AGENT_B}/1`;
    const cgDid = contextGraphDataUri(CG);

    const selection = await agent._ensureCuratedCatalogInSwm(
      CG,
      { rootEntities: [ROOT] },
      undefined,
      createOperationContext('test'),
      {
        kind: 'named-lifecycle',
        identity: { agentAddress: AGENT_B, kaNumber: 1n },
      },
    );

    expect(selection).toEqual({ rootEntities: [ROOT, cgDid] });
    const exact = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${exactGraph}> { <${cgDid}> ?p ?o } }`,
    );
    const legacyBucket = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${swmGraph}> { <${cgDid}> ?p ?o } }`,
    );
    expect(exact.type).toBe('bindings');
    expect(exact.type === 'bindings' ? exact.bindings : []).toHaveLength(4);
    expect(legacyBucket.type).toBe('bindings');
    expect(legacyBucket.type === 'bindings' ? legacyBucket.bindings : []).toHaveLength(0);
  });

  it('reads finalized assertions from the explicitly selected non-default agent lane', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);

    await store.insert(buildAssertionSealQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(CG),
      merkleRoot: MERKLE,
      authorAddress: AGENT_B,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: AGENT_B,
      reservedKaId: RESERVED_KA_ID,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      rootEntities: [ROOT],
    }) as Quad[]);

    const markerCalls: Array<{
      contextGraphId: string;
      name: string;
      agentAddress: string;
      subGraphName?: string;
    }> = [];
    const publishCalls: Array<{ contextGraphId: string; selection: any; opts: any }> = [];
    const remainingClearCalls: any[][] = [];
    const ensureCalls: any[] = [];

    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = DEFAULT_AGENT;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      configurable: true,
    });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async (
        contextGraphId: string,
        name: string,
        agentAddress: string,
        subGraphName?: string,
      ) => {
        markerCalls.push({ contextGraphId, name, agentAddress, subGraphName });
        return agentAddress === AGENT_B;
      },
      ensureFinalizedLifecycleSwmPlacement: async (descriptor: any) => {
        ensureCalls.push(descriptor);
        await store.insert([{
          subject: ROOT,
          predicate: 'http://schema.org/name',
          object: '"B lane"',
          graph: `${contextGraphSharedMemoryUri(CG)}/${AGENT_B}/1`,
        }]);
        return {
          sourceEmpty: false,
          migratedLegacyQuadCount: 0,
          targetGraph: `${contextGraphSharedMemoryUri(CG)}/${AGENT_B}/1`,
        };
      },
      clearSwmShareComplete: async () => {},
      clearRemainingSharedMemory: async (...args: any[]) => { remainingClearCalls.push(args); },
    };
    agent.publishFromSharedMemory = async (contextGraphId: string, selection: any, opts: any) => {
      publishCalls.push({ contextGraphId, selection, opts });
      return {
        kaId: RESERVED_KA_ID,
        ual: 'did:dkg:test/31337/1',
        merkleRoot: MERKLE,
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [],
      };
    };

    await expect(agent.publishFromFinalizedAssertion(CG, NAME)).rejects.toThrow(/is not finalized/);

    const result = await agent.publishFromFinalizedAssertion(CG, NAME, {
      agentAddress: AGENT_B,
      clearSharedMemoryAfter: true,
    });

    expect(result.assertionUri).toBe(assertionUri);
    expect(markerCalls).toEqual([{
      contextGraphId: CG,
      name: NAME,
      agentAddress: AGENT_B,
      subGraphName: undefined,
    }]);
    expect(ensureCalls).toEqual([{
      lifecycle: {
        contextGraphId: CG,
        assertionName: NAME,
        assertionLifecycleAgentAddress: AGENT_B,
        subGraphName: undefined,
      },
      sealAuthorScope: { agentAddress: AGENT_B, kaNumber: 1n },
      rootEntities: [ROOT],
    }]);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({
      contextGraphId: CG,
      selection: { rootEntities: [ROOT] },
    });
    expect(publishCalls[0]?.opts).toMatchObject({
      reservedKaId: RESERVED_KA_ID,
      sharedMemoryScope: {
        kind: 'named-lifecycle',
        identity: { agentAddress: AGENT_B, kaNumber: 1n },
      },
      precomputedAttestation: {
        expectedMerkleRoot: MERKLE,
        authorAddress: AGENT_B,
        schemeVersion: 1,
        reservedKaId: RESERVED_KA_ID,
      },
    });
    expect(publishCalls[0]?.opts).not.toHaveProperty('clearSharedMemoryAfter');
    expect(remainingClearCalls).toHaveLength(1);
    expect(remainingClearCalls[0].slice(0, 2)).toEqual([CG, undefined]);
    expect(result.status).toBe('confirmed');
  });

  it('maps an explicit source-empty placement result to the mint no-data precondition', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    await store.insert(buildAssertionSealQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(CG),
      merkleRoot: MERKLE,
      authorAddress: AGENT_B,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: AGENT_B,
      reservedKaId: RESERVED_KA_ID,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      rootEntities: [ROOT],
    }) as Quad[]);

    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-source-empty', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
      ensureFinalizedLifecycleSwmPlacement: async () => ({
        sourceEmpty: true,
        migratedLegacyQuadCount: 0,
        targetGraph: `${contextGraphSharedMemoryUri(CG)}/${AGENT_B}/1`,
      }),
    };
    agent.publishFromSharedMemory = async () => {
      throw new Error('publish should not be called for an empty source');
    };

    let thrown: any;
    try {
      await agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AGENT_B });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toMatch(/No quads in shared memory/);
    expect(thrown?.code).not.toBe('SWM_MIGRATION_SOURCE_EMPTY');
  });

  it('explicitly migrates an older finalized legacy-bucket share before minting', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    const swmGraph = contextGraphSharedMemoryUri(CG);
    const namedGraph = `${swmGraph}/${AGENT_B}/1`;
    const legacyQuad: Quad = {
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"legacy finalized share"',
      graph: swmGraph,
    };
    await store.insert([
      ...buildAssertionSealQuads({
        assertionUri,
        metaGraph: contextGraphMetaUri(CG),
        merkleRoot: MERKLE,
        authorAddress: AGENT_B,
        authorAttestationR: new Uint8Array(32).fill(1),
        authorAttestationVS: new Uint8Array(32).fill(2),
        authorSchemeVersion: 1,
        chainId: 31337n,
        kav10Address: AGENT_B,
        reservedKaId: RESERVED_KA_ID,
        finalizedAtIso: '2026-01-01T00:00:00.000Z',
        rootEntities: [ROOT],
      }) as Quad[],
      legacyQuad,
    ]);

    const ensureCalls: any[] = [];
    const publishCalls: any[][] = [];
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-legacy-finalized', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
      ensureFinalizedLifecycleSwmPlacement: async (descriptor: any) => {
        ensureCalls.push(descriptor);
        await store.insert([{ ...legacyQuad, graph: namedGraph }]);
        await store.deleteByPattern({ graph: swmGraph, subject: ROOT });
        return {
          sourceEmpty: false,
          migratedLegacyQuadCount: 1,
          targetGraph: namedGraph,
        };
      },
      clearSwmShareComplete: async () => {},
    };
    agent.publishFromSharedMemory = async (...args: any[]) => {
      publishCalls.push(args);
      return {
        kaId: RESERVED_KA_ID,
        ual: 'did:dkg:test/legacy-finalized/1',
        merkleRoot: MERKLE,
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [],
      };
    };

    const result = await agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AGENT_B });

    expect(result.status).toBe('confirmed');
    expect(ensureCalls).toEqual([{
      lifecycle: {
        contextGraphId: CG,
        assertionName: NAME,
        assertionLifecycleAgentAddress: AGENT_B,
        subGraphName: undefined,
      },
      sealAuthorScope: { agentAddress: AGENT_B, kaNumber: 1n },
      rootEntities: [ROOT],
    }]);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0][1]).toEqual({ rootEntities: [ROOT] });
    expect(publishCalls[0][2].sharedMemoryScope).toEqual({
      kind: 'named-lifecycle',
      identity: { agentAddress: AGENT_B, kaNumber: 1n },
    });
    const legacy = await store.query(`ASK { GRAPH <${swmGraph}> { <${ROOT}> ?p ?o } }`);
    const canonical = await store.query(`ASK { GRAPH <${namedGraph}> { <${ROOT}> ?p ?o } }`);
    expect(legacy).toMatchObject({ type: 'boolean', value: false });
    expect(canonical).toMatchObject({ type: 'boolean', value: true });
  });

  it('cleans only the finalized named lifecycle after a confirmed update', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    const metaGraph = contextGraphMetaUri(CG);
    const lifecycleUri = assertionLifecycleUri(CG, AGENT_B, NAME);
    const swmGraph = contextGraphSharedMemoryUri(CG);
    const namedGraph = `${swmGraph}/${AGENT_B}/1`;
    const legacyQuad: Quad = {
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"updated"',
      graph: swmGraph,
    };
    await store.insert([
      ...buildAssertionSealQuads({
        assertionUri,
        metaGraph,
        merkleRoot: MERKLE,
        authorAddress: AGENT_B,
        authorAttestationR: new Uint8Array(32).fill(1),
        authorAttestationVS: new Uint8Array(32).fill(2),
        authorSchemeVersion: 1,
        chainId: 31337n,
        kav10Address: AGENT_B,
        reservedKaId: RESERVED_KA_ID,
        finalizedAtIso: '2026-01-01T00:00:00.000Z',
        rootEntities: [ROOT],
      }) as Quad[],
      { subject: lifecycleUri, predicate: VM_CURRENT_ASSERTION_PRED, object: '"prior"', graph: metaGraph },
      { subject: lifecycleUri, predicate: KA_ID_PRED, object: '"1"', graph: metaGraph },
      legacyQuad,
    ]);

    const cleanupCalls: any[][] = [];
    const ensureCalls: any[] = [];
    const updateCalls: any[][] = [];
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-update', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
      ensureFinalizedLifecycleSwmPlacement: async (descriptor: any) => {
        ensureCalls.push(descriptor);
        const canonicalQuad = { ...legacyQuad, graph: namedGraph };
        await store.insert([canonicalQuad]);
        await store.delete([legacyQuad]);
        return {
          sourceEmpty: false,
          migratedLegacyQuadCount: 1,
          targetGraph: namedGraph,
        };
      },
      clearSwmShareComplete: async () => {},
      clearPublishedSwmRoots: async (...args: any[]) => { cleanupCalls.push(args); },
    };
    agent._buildPrecomputedUpdateAttestationForSeal = async () => ({
      expectedNewMerkleRoot: MERKLE,
      authorAddress: AGENT_B,
      signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      schemeVersion: 1,
    });
    agent.update = async (...args: any[]) => {
      updateCalls.push(args);
      return {
        kaId: RESERVED_KA_ID,
        ual: 'did:dkg:test/update/1',
        merkleRoot: MERKLE,
        kaManifest: [],
        status: 'confirmed',
        publicQuads: [],
      };
    };

    const result = await agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AGENT_B });

    expect(result.status).toBe('confirmed');
    expect(ensureCalls).toEqual([{
      lifecycle: {
        contextGraphId: CG,
        assertionName: NAME,
        assertionLifecycleAgentAddress: AGENT_B,
        subGraphName: undefined,
      },
      sealAuthorScope: { agentAddress: AGENT_B, kaNumber: 1n },
      rootEntities: [ROOT],
    }]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].slice(0, 2)).toEqual([RESERVED_KA_ID, CG]);
    expect(updateCalls[0][2]).toEqual([{
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"updated"',
      graph: '',
    }]);
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0].slice(0, 3)).toEqual([CG, [ROOT], undefined]);
    expect(cleanupCalls[0][4]).toEqual({
      kind: 'named-lifecycle',
      identity: { agentAddress: AGENT_B, kaNumber: 1n },
    });
    const legacy = await store.query(`ASK { GRAPH <${swmGraph}> { <${ROOT}> ?p ?o } }`);
    const canonical = await store.query(`ASK { GRAPH <${namedGraph}> { <${ROOT}> ?p ?o } }`);
    expect(legacy).toMatchObject({ type: 'boolean', value: false });
    expect(canonical).toMatchObject({ type: 'boolean', value: true });
  });

  it('rejects a finalized seal whose packed KA id belongs to another author namespace', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    const mismatchedReservedKaId = (BigInt(DEFAULT_AGENT) << 96n) | 1n;
    await store.insert(buildAssertionSealQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(CG),
      merkleRoot: MERKLE,
      authorAddress: AGENT_B,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: AGENT_B,
      reservedKaId: mismatchedReservedKaId,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      rootEntities: [ROOT],
    }) as Quad[]);

    let swmLoads = 0;
    let publishes = 0;
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-namespace', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
    };
    agent._loadSelectedSWMQuads = async () => {
      swmLoads += 1;
      return [];
    };
    agent.publishFromSharedMemory = async () => {
      publishes += 1;
      throw new Error('publish must not run');
    };

    await expect(
      agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AGENT_B }),
    ).rejects.toThrow(/not in author/i);
    expect(swmLoads).toBe(0);
    expect(publishes).toBe(0);
  });
});
