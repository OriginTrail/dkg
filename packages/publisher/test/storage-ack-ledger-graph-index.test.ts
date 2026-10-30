import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodePublishIntent,
  isStorageACKDecline,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  GraphSetIndexStore,
  OxigraphStore,
  type Quad,
  type TripleStore,
  type UpdateOptions,
} from '@origintrail-official/dkg-storage';
import { StorageACKHandler } from '../src/storage-ack-handler.js';
import { computeFlatKCMerkleLeafCountV10, computeFlatKCRootV10 } from '../src/merkle.js';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
} from '../src/storage-ack-ledger.js';

const CG_ID = '42';
const SWM_GRAPH_ID = 'public-source-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const PEER = { toString: () => 'publisher-peer' };

function wireNquads(quads: readonly Quad[]): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) =>
    `<${quad.subject}> <${quad.predicate}> ${quad.object} <${quad.graph}> .`,
  ).join('\n'));
}

/** A graph-scoped public publish with its payload inline. */
function publishIntent(value: string): Uint8Array {
  const quads: Quad[] = [{
    subject: 'urn:asset:gated',
    predicate: 'urn:p:value',
    object: `"${value}"`,
    graph: knowledgeAssetLayerGraphUri(
      SWM_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    ),
  }];
  return encodePublishIntent({
    merkleRoot: computeFlatKCRootV10([...quads], []),
    contextGraphId: CG_ID,
    swmGraphId: SWM_GRAPH_ID,
    publisherPeerId: 'publisher-peer',
    publicByteSize: wireNquads(quads).length,
    isPrivate: false,
    kaCount: 1,
    rootEntities: [],
    merkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
    stagingQuads: wireNquads(quads),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '1',
    publicTripleCount: quads.length,
    privateTripleCount: 0,
    accessPolicy: 'public',
    allowedPeers: [],
  });
}

/** Count the full graph-list scans a graph-set index runs against its store. */
function scanCountingStore(inner: TripleStore): { store: TripleStore; scans: () => number } {
  let scans = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'listGraphs' || prop === 'listGraphsSorted') {
        return (...args: unknown[]) => {
          scans += 1;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  }) as TripleStore;
  return { store, scans: () => scans };
}

describe('StorageACK ledger record and the graph-set index', () => {
  it('names the ledger graph on the ledger update, so the index never rescans for it', async () => {
    const counted = scanCountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counted.store, { revalidateMs: 100_000, now: () => 1_000 });
    const ledgerUpdates: Array<UpdateOptions | undefined> = [];
    const update = store.update.bind(store);
    store.update = async (sparql: string, options?: UpdateOptions) => {
      if (options?.source === 'storage-ack.ledger.record') ledgerUpdates.push(options);
      await update(sparql, options);
    };
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core',
      nodeIdentityId: 17n,
      signerWallet: new ethers.Wallet(ethers.Wallet.createRandom().privateKey),
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
      isCgCurated: async () => false,
      ensureVmPromotion: async () => ({ ok: true }),
    }, new TypedEventBus());
    // A warm index: every later full scan is a rebuild.
    await store.listGraphs();
    const scansBefore = counted.scans();

    const ack = decodeStorageACK(await handler.handler(publishIntent('v1'), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ledgerUpdates).toHaveLength(1);
    expect(ledgerUpdates[0]).toMatchObject({
      priority: 'ack',
      source: 'storage-ack.ledger.record',
      touchedGraphs: [STORAGE_ACK_LEDGER_GRAPH],
    });
    const ledger = await store.query(
      `ASK { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { ?op <${LEDGER.signedAt}> ?at } }`,
    );
    expect(ledger).toEqual({ type: 'boolean', value: true });
    expect(await store.listGraphs()).toContain(STORAGE_ACK_LEDGER_GRAPH);
    expect(counted.scans()).toBe(scansBefore);
  });
});
