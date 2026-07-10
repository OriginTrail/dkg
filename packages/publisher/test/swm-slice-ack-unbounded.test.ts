// T7 (#1549 SWM-slice bound) — the storage-ACK responder read lane is OFF the
// bound path.
//
// The finalization gossip lane (packages/agent) accelerates its SWM slice with a
// per-KA `SwmKaGraphBound` and, because that narrowing can under-read under root
// recurrence, tags its reads `agent.finalization.sharedMemorySlice.bounded` /
// `…​.fallbackUnbounded` so the canary can watch the widen ratio. The ACK
// responder deliberately does NOT bound: a regular `PublishIntent` carries no
// kaId, and MERKLE_MISMATCH_IN_SWM here is a lost-ACK decline (a bounded
// under-read would silently drop a publish-quorum vote). storage-ack-handler.ts
// is therefore left byte-for-byte unchanged by that work, and its SWM read must
// keep flowing through `loadSelectedSharedMemoryQuads` with NO `kaGraphBound`
// and the plain `storage-ack.loadSWMQuads.construct{Entity,All}` source.
//
// These tests drive the real responder entry point on the SWM-fallback path (a
// PublishIntent with no stagingQuads → `loadSWMOrDecline` → `loadSWMQuads`,
// storage-ack-handler.ts:1214/1795) against a real OxigraphStore wrapped in a
// query-source spy, and pin: (1) the read source is exactly the unbounded ACK
// tag — never a `.bounded` / `.fallbackUnbounded` suffix, never the finalization
// lane; (2) the signed ACK's root equals the root over the exact seeded quads
// (byte-identical read — the graph-set narrowing never ran); (3) the existing
// MERKLE_MISMATCH_IN_SWM and NO_DATA_IN_SWM declines are unchanged and still
// read on the unbounded ACK source.

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  OxigraphStore,
  type Quad,
  type QueryOptions,
  type QueryResult,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  encodePublishIntent,
  decodeStorageACK,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const CONTEXT_GRAPH_ID = '42';
const SWM_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory`;

const coreWallet = ethers.Wallet.createRandom();
const fakePeerId = { toString: () => 'requester-peer' } as any;

const q = (subject: string, predicate: string, object: string): Quad =>
  ({ subject, predicate, object, graph: SWM_GRAPH_URI });

// A small author payload seeded directly into the SWM bucket graph.
const authorQuads: Quad[] = [
  q('urn:entity:1', 'http://schema.org/name', '"Entity One"'),
  q('urn:entity:1', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Thing'),
  q('urn:entity:2', 'http://schema.org/name', '"Entity Two"'),
];
const authorRoot = computeFlatKCRoot(authorQuads, []);
const authorLeafCount = computeFlatKCMerkleLeafCountV10(authorQuads, []);

interface SpyHandle {
  handler: StorageACKHandler;
  /** `source` recorded for every `store.query` the handler issues, in order. */
  querySources: (string | undefined)[];
}

// Real OxigraphStore (genuine merkle recompute) behind a Proxy that records the
// `source` on every CONSTRUCT read. The SWM graph-set resolution goes through
// `listGraphs` (OxigraphStore has no `listGraphsByPrefix`), so the ONLY
// `store.query` on this path is the slice CONSTRUCT — exactly the read we pin.
async function makeHandler(seedQuads: Quad[]): Promise<SpyHandle> {
  const inner = new OxigraphStore();
  if (seedQuads.length > 0) await inner.insert(seedQuads);

  const querySources: (string | undefined)[] = [];
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sparql: string, options?: QueryOptions): Promise<QueryResult> => {
          querySources.push(options?.source);
          return target.query(sparql, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as TripleStore;

  const config: StorageACKHandlerConfig = {
    nodeRole: 'core',
    nodeIdentityId: 42n,
    signerWallet: coreWallet,
    contextGraphSharedMemoryUri: (cgId: string) =>
      `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
  };
  const eventBus = { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };
  return {
    handler: new StorageACKHandler(store as any, config, eventBus as any),
    querySources,
  };
}

// SWM-fallback publish intent: NO stagingQuads → the handler recomputes the root
// from its own SWM copy via `loadSWMQuads` (the read under test).
function swmFallbackIntent(overrides: Record<string, unknown> = {}): Uint8Array {
  return encodePublishIntent({
    merkleRoot: authorRoot,
    contextGraphId: CONTEXT_GRAPH_ID,
    publisherPeerId: 'pub-0',
    publicByteSize: 4096,
    isPrivate: false,
    kaCount: 1,
    rootEntities: ['urn:entity:1', 'urn:entity:2'],
    merkleLeafCount: authorLeafCount,
    ...overrides,
  });
}

// The bound path is observable ONLY through the read source: the ACK responder
// must never carry the finalization lane's `.bounded` / `.fallbackUnbounded`
// suffix, nor borrow the `agent.finalization.*` source at all.
function expectNoBoundLane(querySources: (string | undefined)[]): void {
  expect(
    querySources.some((s) => s?.endsWith('.bounded') || s?.endsWith('.fallbackUnbounded')),
  ).toBe(false);
  expect(querySources.some((s) => s?.startsWith('agent.finalization.'))).toBe(false);
}

function ackRootHex(ack: { merkleRoot: Uint8Array | ArrayLike<number> }): string {
  const root = ack.merkleRoot instanceof Uint8Array
    ? ack.merkleRoot
    : new Uint8Array(ack.merkleRoot);
  return ethers.hexlify(root);
}

describe('T7 — storage-ACK SWM read lane is off the #1549 bound path', () => {
  it('per-root-entity read carries the unbounded storage-ack.loadSWMQuads.constructEntity source', async () => {
    const { handler, querySources } = await makeHandler(authorQuads);

    const response = await handler.handler(
      swmFallbackIntent({ rootEntities: ['urn:entity:1', 'urn:entity:2'] }),
      fakePeerId,
    );
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(false);
    // Byte-identical read: the signed root equals the root over the EXACT seeded
    // quads, i.e. the read returned the whole bucket — no graph-set narrowing.
    expect(ackRootHex(ack as any)).toBe(ethers.hexlify(authorRoot));

    const swmReads = querySources.filter((s) => s?.startsWith('storage-ack.loadSWMQuads.'));
    expect(swmReads).toEqual(['storage-ack.loadSWMQuads.constructEntity']);
    expectNoBoundLane(querySources);
  });

  it('read-both (empty rootEntities) carries the unbounded storage-ack.loadSWMQuads.constructAll source', async () => {
    const { handler, querySources } = await makeHandler(authorQuads);

    const response = await handler.handler(
      swmFallbackIntent({ rootEntities: [] }),
      fakePeerId,
    );
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ackRootHex(ack as any)).toBe(ethers.hexlify(authorRoot));

    const swmReads = querySources.filter((s) => s?.startsWith('storage-ack.loadSWMQuads.'));
    expect(swmReads).toEqual(['storage-ack.loadSWMQuads.constructAll']);
    expectNoBoundLane(querySources);
  });

  it('MERKLE_MISMATCH_IN_SWM decline is unchanged and still reads on the unbounded ACK source', async () => {
    const { handler, querySources } = await makeHandler(authorQuads);

    // Claim a root the core's SWM copy cannot reproduce (the 2026-07-07 incident
    // shape) — the recompute over the seeded quads differs → decline.
    const wrongRoot = computeFlatKCRoot(
      [q('urn:entity:1', 'http://schema.org/name', '"Different"')],
      [],
    );
    const response = await handler.handler(
      swmFallbackIntent({ merkleRoot: wrongRoot, rootEntities: ['urn:entity:1', 'urn:entity:2'] }),
      fakePeerId,
    );
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(true);
    expect((ack as any).declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);

    const swmReads = querySources.filter((s) => s?.startsWith('storage-ack.loadSWMQuads.'));
    expect(swmReads).toEqual(['storage-ack.loadSWMQuads.constructEntity']);
    expectNoBoundLane(querySources);
  });

  it('NO_DATA_IN_SWM decline is unchanged and still reads on the unbounded ACK source', async () => {
    // Empty store — the bucket graph is still resolved and read, returns nothing.
    const { handler, querySources } = await makeHandler([]);

    const response = await handler.handler(
      swmFallbackIntent({ rootEntities: ['urn:entity:1'] }),
      fakePeerId,
    );
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(true);
    expect((ack as any).declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);

    const swmReads = querySources.filter((s) => s?.startsWith('storage-ack.loadSWMQuads.'));
    expect(swmReads).toEqual(['storage-ack.loadSWMQuads.constructEntity']);
    expectNoBoundLane(querySources);
  });
});
