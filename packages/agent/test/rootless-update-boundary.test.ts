import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  contextGraphDataUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  PrivateContentStore,
  canonicalSharedMemoryScopeWriteGraph,
  loadSharedMemoryQuadsForScope,
  type Quad,
  type SharedMemoryGraphScope,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  skolemizeKnowledgeAssetParts,
} from '@origintrail-official/dkg-publisher';
import { PublishMethods } from '../src/dkg-agent-publish.js';

const CG = 'rootless-update-boundary';
const CHAIN_ID = 'mock:31337';
const ORIGINAL_AUTHOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURRENT_OWNER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KA_NUMBER = 7n;
const KA_ID = (BigInt(ORIGINAL_AUTHOR) << 96n) | KA_NUMBER;
const UAL = `did:dkg:${CHAIN_ID}/${ORIGINAL_AUTHOR}/${KA_NUMBER.toString()}`;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function int(value: bigint | number): string {
  return `"${value.toString()}"^^<${XSD_INTEGER}>`;
}

function q(subject: string, predicate: string, object: string, graph = ''): Quad {
  return { subject, predicate, object, graph };
}

async function seedConfirmedRootlessHead(store: OxigraphStore): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(UAL, 1);
  const metaGraph = contextGraphMetaUri(CG);
  const vmGraph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.VerifiableMemory,
    scope,
  );
  await store.insert([
    q(UAL, `${DKG}contentScopeVersion`, int(GRAPH_KA_CONTENT_SCOPE_VERSION), metaGraph),
    q(UAL, `${DKG}kaUal`, UAL, metaGraph),
    q(UAL, `${DKG}assertionVersion`, int(1), metaGraph),
    q(UAL, `${DKG}batchId`, int(KA_ID), metaGraph),
    q(UAL, `${DKG}status`, '"confirmed"', metaGraph),
    q(UAL, `${DKG}contextGraph`, contextGraphDataUri(CG), metaGraph),
    q(UAL, `${DKG}assertionGraph`, vmGraph, metaGraph),
    q('urn:old:vm', 'urn:value', '"one"', vmGraph),
  ]);
}

async function updateAttestation(
  publicQuads: Quad[],
  privateQuads: Quad[] = [],
  authorAddress = CURRENT_OWNER,
) {
  const canonical = await skolemizeKnowledgeAssetParts(publicQuads, privateQuads);
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  return {
    canonical,
    privateRoot,
    attestation: {
      expectedNewMerkleRoot: computeFlatKCRootV10(
        canonical.publicQuads,
        privateRoot ? [privateRoot] : [],
      ),
      authorAddress,
      signature: {
        r: new Uint8Array(32),
        vs: new Uint8Array(32),
      },
      schemeVersion: 1,
    },
  };
}

function makeAgentLike(
  store: OxigraphStore,
  onPublisherUpdate: (kaId: bigint, options: Record<string, any>) => Promise<any>,
) {
  return {
    store,
    chain: { chainId: CHAIN_ID },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    node: { peerId: { toString: () => 'peer-rootless-update' } },
    publisher: { updateKnowledgeAssetFromSharedMemory: onPublisherUpdate },
    getContextGraphOnChainId: async () => null,
    createV10UpdateACKProvider: () => undefined,
    _resolveEncryptInlinePayload: async () => undefined,
    _resolveEncryptInlineChunked: async () => undefined,
    gossip: { publish: async () => undefined },
  } as any;
}

describe('DKGAgent rootless update boundary', () => {
  it('stages one exact SWM graph, versions private content, and permits a transferred owner', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicQuads = [
      q('urn:update:asset', 'urn:hasPart', '_:part'),
      q('_:part', 'urn:value', '"two"'),
    ];
    const privateQuads = [q('_:secret', 'urn:secret', '"classified"')];
    const { canonical, privateRoot, attestation } = await updateAttestation(
      publicQuads,
      privateQuads,
      CURRENT_OWNER,
    );

    const graphManager = new GraphManager(store);
    const swmBucket = graphManager.sharedMemoryUri(CG);
    const scope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    const canonicalSwm = canonicalSharedMemoryScopeWriteGraph(swmBucket, scope);
    const historicalAlias = `${swmBucket}/0x${ORIGINAL_AUTHOR.slice(2).toUpperCase()}/${KA_NUMBER.toString()}`;
    await store.insert([q('urn:stale', 'urn:value', '"stale"', historicalAlias)]);

    let publisherCalls = 0;
    const agent = makeAgentLike(store, async (kaId, options) => {
      publisherCalls += 1;
      expect(kaId).toBe(KA_ID);
      expect(options).toMatchObject({
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: '2',
        publicTripleCount: canonical.publicQuads.length,
        privateTripleCount: canonical.privateQuads.length,
      });
      expect(options.privateMerkleRoot).toEqual(privateRoot);

      const staged = await loadSharedMemoryQuadsForScope(
        store,
        swmBucket,
        'all',
        scope,
      );
      expect(staged.map(({ graph: _graph, ...quad }) => quad)).toEqual(
        canonical.publicQuads.map(({ graph: _graph, ...quad }) => quad),
      );
      return {
        kaId,
        ual: UAL,
        merkleRoot: attestation.expectedNewMerkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: staged,
      };
    });

    const result = await (PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      privateQuads,
      { precomputedUpdateAttestation: attestation },
    );

    expect(result.status).toBe('tentative');
    expect(publisherCalls).toBe(1);
    expect(await store.countQuads(canonicalSwm)).toBe(canonical.publicQuads.length);
    expect(await store.countQuads(historicalAlias)).toBe(0);
    const privateStore = new PrivateContentStore(store, graphManager);
    expect(await privateStore.getKnowledgeAssetPrivateTriples(
      CG,
      createGraphKnowledgeAssetScope(UAL, 2),
    )).toEqual(canonical.privateQuads);

    // Staging an update must not mutate the current VM graph before the
    // publisher/chain confirms it.
    const currentVm = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    );
    expect(await store.countQuads(currentVm)).toBe(1);
  });

  it('rejects an attestation-root mismatch before touching SWM or private storage', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicQuads = [q('urn:update:asset', 'urn:value', '"two"')];
    const { attestation } = await updateAttestation(publicQuads);
    attestation.expectedNewMerkleRoot = new Uint8Array(32).fill(0xff);
    let publisherCalls = 0;
    const agent = makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toThrow(/expectedNewMerkleRoot mismatch/);

    const graphManager = new GraphManager(store);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    expect(await store.countQuads(canonicalSharedMemoryScopeWriteGraph(
      graphManager.sharedMemoryUri(CG),
      swmScope,
    ))).toBe(0);
    expect(await new PrivateContentStore(store, graphManager)
      .getKnowledgeAssetPrivateTriples(CG, createGraphKnowledgeAssetScope(UAL, 2)))
      .toEqual([]);
    expect(publisherCalls).toBe(0);
  });

  it('stages a fully private update without inventing a public placeholder', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const privateQuads = [q('urn:private:only', 'urn:secret', '"updated"')];
    const { canonical, privateRoot, attestation } = await updateAttestation([], privateQuads);
    let publisherCalls = 0;
    const agent = makeAgentLike(store, async (kaId, options) => {
      publisherCalls += 1;
      expect(kaId).toBe(KA_ID);
      expect(options.publicTripleCount).toBe(0);
      expect(options.privateTripleCount).toBe(canonical.privateQuads.length);
      expect(options.privateMerkleRoot).toEqual(privateRoot);
      expect(options.privateQuads).toEqual(canonical.privateQuads);
      return {
        kaId,
        ual: UAL,
        merkleRoot: attestation.expectedNewMerkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: [],
      };
    });

    await (PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      [],
      privateQuads,
      { precomputedUpdateAttestation: attestation },
    );

    expect(publisherCalls).toBe(1);
    const scope = createGraphKnowledgeAssetScope(UAL, 2);
    const graphManager = new GraphManager(store);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    expect(await store.countQuads(canonicalSharedMemoryScopeWriteGraph(
      graphManager.sharedMemoryUri(CG),
      swmScope,
    ))).toBe(0);
    expect(await new PrivateContentStore(store, graphManager)
      .getKnowledgeAssetPrivateTriples(CG, scope)).toEqual(canonical.privateQuads);
  });

  it('requires the confirmed V2 head to be locally materialized', async () => {
    const store = new OxigraphStore();
    const publicQuads = [q('urn:update:asset', 'urn:value', '"two"')];
    const { attestation } = await updateAttestation(publicQuads);
    let publisherCalls = 0;
    const agent = makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toMatchObject({ code: 'ROOTLESS_KA_NOT_MATERIALIZED' });
    expect(publisherCalls).toBe(0);
  });

  it('keeps an existing root-scoped KA read-only instead of synthesizing a V2 target', async () => {
    const store = new OxigraphStore();
    const legacyUal = 'did:dkg:legacy/0xcccccccccccccccccccccccccccccccccccccccc/1';
    await store.insert([
      q(legacyUal, `${DKG}batchId`, int(KA_ID), contextGraphMetaUri(CG)),
      q(legacyUal, `${DKG}status`, '"confirmed"', contextGraphMetaUri(CG)),
    ]);
    const publicQuads = [q('urn:update:asset', 'urn:value', '"two"')];
    const { attestation } = await updateAttestation(publicQuads);
    let publisherCalls = 0;
    const agent = makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
    expect(publisherCalls).toBe(0);
  });
});
