import { describe, expect, it } from 'vitest';
import {
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphDataUri,
  contextGraphSharedMemoryUri,
  assertionLifecycleUri,
  contextGraphMetaUri,
  createOperationContext,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  KA_ID_PRED,
  VM_CURRENT_ASSERTION_PRED,
  computeFlatKCRootV10,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  namedSharedMemoryScopeForFinalizedLifecycle,
  sharedMemoryScopeForFinalizedLifecycle,
} from '../src/finalized-lifecycle-scope.js';

const DEFAULT_AGENT = `0x${'11'.repeat(20)}`;
// The confirmed-publication hook enters RFC-64's canonical control plane, so
// this fixture must use the same owner/slug identity as a registered CG.
const CG = `${DEFAULT_AGENT}/publish-agent-lane`;
const NAME = 'asset';
const AGENT_B = `0x${'22'.repeat(20)}`;
const ROOT = 'urn:test:agent-b-root';
const RESERVED_KA_ID = (BigInt(AGENT_B) << 96n) | 1n;
const KA_UAL = `did:dkg:hardhat:31337/${AGENT_B}/1`;
const PUBLIC_QUAD: Quad = {
  subject: ROOT,
  predicate: 'http://schema.org/name',
  object: '"B lane"',
  graph: '',
};
const MERKLE = computeFlatKCRootV10([PUBLIC_QUAD], []);

function buildGraphSeal(
  assertionUri: string,
  reservedKaId: bigint = RESERVED_KA_ID,
): Quad[] {
  return buildAssertionSealQuads({
    assertionUri,
    metaGraph: contextGraphMetaUri(CG),
    merkleRoot: MERKLE,
    authorAddress: AGENT_B,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: AGENT_B,
    reservedKaId,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: KA_UAL,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
  }) as Quad[];
}

function makeLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

describe('DKGAgent publishFromFinalizedAssertion agent lane', () => {
  it('derives finalized SWM scope in the neutral lifecycle boundary', () => {
    expect(sharedMemoryScopeForFinalizedLifecycle(AGENT_B, undefined)).toEqual({
      kind: 'complete-family',
    });
    expect(sharedMemoryScopeForFinalizedLifecycle(AGENT_B, 1n)).toEqual({
      kind: 'named-lifecycle',
      identity: { agentAddress: AGENT_B, kaNumber: 1n },
    });
    expect(sharedMemoryScopeForFinalizedLifecycle(AGENT_B, RESERVED_KA_ID)).toEqual({
      kind: 'named-lifecycle',
      identity: { agentAddress: AGENT_B, kaNumber: 1n },
    });
    expect(namedSharedMemoryScopeForFinalizedLifecycle(AGENT_B, RESERVED_KA_ID)).toEqual({
      kind: 'named-lifecycle',
      identity: { agentAddress: AGENT_B, kaNumber: 1n },
    });
    expect(() => sharedMemoryScopeForFinalizedLifecycle(DEFAULT_AGENT, RESERVED_KA_ID))
      .toThrow(/not in author .* namespace/);
  });

  it('keeps the legacy catalog-in-SWM helper scoped to the selected lifecycle graph', async () => {
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
    const exactGraph = `${contextGraphSharedMemoryUri(CG)}/${AGENT_B}/1`;
    await store.insert([
      ...buildGraphSeal(assertionUri),
      { ...PUBLIC_QUAD, graph: exactGraph },
    ]);

    const markerCalls: Array<{
      contextGraphId: string;
      name: string;
      agentAddress: string;
      subGraphName?: string;
    }> = [];
    const publishCalls: Array<{ contextGraphId: string; selection: any; opts: any }> = [];
    const remainingClearCalls: any[][] = [];
    const rfc64CatalogCalls: any[] = [];
    const rfc64SwmInventoryRemovalCalls: any[] = [];
    const warnings: string[] = [];

    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = DEFAULT_AGENT;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      configurable: true,
    });
    agent.log = {
      ...makeLog(),
      warn: (_ctx: unknown, message: string) => { warnings.push(message); },
    };
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
    agent.recordConfirmedRfc64PublicCatalogAssetV1 = async (input: any) => {
      rfc64CatalogCalls.push(input);
      throw new Error('simulated finalized RFC-64 catalog failure');
    };
    agent.removeRfc64SwmAuthorInventoryShadowV1 = async (input: any) => {
      rfc64SwmInventoryRemovalCalls.push(input);
      throw new Error('simulated escaped RFC-64 SWM inventory removal failure');
    };

    // GH#1778 — a genuinely absent name still yields "is not finalized":
    // resolveAssertionAuthor finds no seal, returns undefined, and the caller
    // falls back to its own address. (Before #1778, publishing NAME itself
    // without an explicit agentAddress failed here; it now auto-resolves the
    // sole author AGENT_B — covered by publish-foreign-author-resolution.test.ts.)
    await expect(agent.publishFromFinalizedAssertion(CG, 'no-such-name')).rejects.toThrow(/is not finalized/);

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
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({
      contextGraphId: CG,
      selection: 'all',
    });
    expect(publishCalls[0]?.opts).toMatchObject({
      reservedKaId: RESERVED_KA_ID,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: KA_UAL,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
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
    expect(rfc64CatalogCalls).toHaveLength(1);
    expect(rfc64CatalogCalls[0]).toMatchObject({
      contextGraphId: CG,
      assertionCoordinate: NAME,
      publicQuads: [PUBLIC_QUAD],
    });
    expect(rfc64CatalogCalls[0].seal).toMatchObject({
      authorAddress: AGENT_B,
      reservedKaId: RESERVED_KA_ID,
      kaUal: KA_UAL,
    });
    expect(rfc64SwmInventoryRemovalCalls).toHaveLength(1);
    expect(rfc64SwmInventoryRemovalCalls[0]).toMatchObject({
      contextGraphId: CG,
      seal: {
        authorAddress: AGENT_B,
        reservedKaId: RESERVED_KA_ID,
        kaUal: KA_UAL,
      },
    });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('simulated finalized RFC-64 catalog failure'),
      expect.stringContaining('simulated escaped RFC-64 SWM inventory removal failure'),
    ]));
  });

  it('maps an empty exact KA graph to the mint no-data precondition', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    await store.insert(buildGraphSeal(assertionUri));

    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-source-empty', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
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
  });

  it('keeps an older finalized legacy-bucket share read-only', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    const swmGraph = contextGraphSharedMemoryUri(CG);
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

    let publishCalls = 0;
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-legacy-finalized', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
    };
    agent.publishFromSharedMemory = async () => {
      publishCalls += 1;
      throw new Error('legacy publish must not run');
    };

    await expect(
      agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AGENT_B }),
    ).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
    expect(publishCalls).toBe(0);
    const legacy = await store.query(`ASK { GRAPH <${swmGraph}> { <${ROOT}> ?p ?o } }`);
    expect(legacy).toMatchObject({ type: 'boolean', value: true });
  });

  it('cleans only the finalized named lifecycle after a confirmed update', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    const metaGraph = contextGraphMetaUri(CG);
    const lifecycleUri = assertionLifecycleUri(CG, AGENT_B, NAME);
    const swmGraph = contextGraphSharedMemoryUri(CG);
    const namedGraph = `${swmGraph}/${AGENT_B}/1`;
    const unrelatedLegacyQuad: Quad = {
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"unrelated legacy bucket"',
      graph: swmGraph,
    };
    await store.insert([
      ...buildGraphSeal(assertionUri),
      { subject: lifecycleUri, predicate: VM_CURRENT_ASSERTION_PRED, object: '"prior"', graph: metaGraph },
      { subject: lifecycleUri, predicate: KA_ID_PRED, object: '"1"', graph: metaGraph },
      { ...PUBLIC_QUAD, graph: namedGraph },
      unrelatedLegacyQuad,
    ]);

    const cleanupCalls: any[][] = [];
    const updateCalls: any[][] = [];
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.store = store;
    agent.chain = {};
    agent.defaultAgentAddress = AGENT_B;
    Object.defineProperty(agent, 'peerId', { value: 'peer-update', configurable: true });
    agent.log = makeLog();
    agent.publisher = {
      hasSwmShareComplete: async () => true,
      clearPublishedKnowledgeAssetSwm: async (...args: any[]) => {
        cleanupCalls.push(args);
        await store.dropGraph(namedGraph);
      },
      clearSwmShareComplete: async () => {},
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
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].slice(0, 2)).toEqual([RESERVED_KA_ID, CG]);
    expect(updateCalls[0][2]).toEqual([PUBLIC_QUAD]);
    expect(updateCalls[0][4]).toMatchObject({
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: KA_UAL,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
    });
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0][0]).toBe(CG);
    expect(cleanupCalls[0][1]).toEqual({
      kind: 'named-lifecycle',
      identity: { agentAddress: AGENT_B, kaNumber: 1n },
    });
    expect(cleanupCalls[0][2]).toBeUndefined();
    expect(cleanupCalls[0][4]).toBe(KA_UAL);
    const legacy = await store.query(`ASK { GRAPH <${swmGraph}> { <${ROOT}> ?p ?o } }`);
    const canonical = await store.query(`ASK { GRAPH <${namedGraph}> { <${ROOT}> ?p ?o } }`);
    expect(legacy).toMatchObject({ type: 'boolean', value: true });
    expect(canonical).toMatchObject({ type: 'boolean', value: false });
  });

  it('rejects a finalized seal whose packed KA id belongs to another author namespace', async () => {
    const store = new OxigraphStore();
    const assertionUri = contextGraphAssertionUri(CG, AGENT_B, NAME);
    const mismatchedReservedKaId = (BigInt(DEFAULT_AGENT) << 96n) | 1n;
    await store.insert(buildGraphSeal(assertionUri, mismatchedReservedKaId));

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
    ).rejects.toThrow(/does not match UAL-derived kaId/i);
    expect(swmLoads).toBe(0);
    expect(publishes).toBe(0);
  });
});
