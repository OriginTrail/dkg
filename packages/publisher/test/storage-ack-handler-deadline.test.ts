import { describe, it, expect, vi } from 'vitest';
import {
  StorageACKHandler,
  DEFAULT_ACK_HANDLER_DEADLINE_MS,
  ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  encodePublishIntent,
  encodeUpdateIntent,
  decodeStorageACK,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
  DEFAULT_SEND_TIMEOUT_MS,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

// 2026-07-07 Gnosis mainnet dead-air fix, SLOW-store variant. The existing
// core-unavailable suite covers a store that THROWS; this covers a store that
// simply does not answer in time (Blazegraph saturated under the sync storm).
// Without a handler deadline the invocation dead-airs past the publisher's 20s
// per-send timeout, so the publisher records TRANSPORT_ERROR / mislabels the
// empty reply as INVALID_SIGNATURE and burns the round. With the deadline the
// handler returns an actionable transient CORE_TEMPORARILY_UNAVAILABLE decline
// before the publisher gives up.

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const contextGraphId = '42';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const swmQuads: Quad[] = [
  makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
  makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
];
const merkleRoot = computeFlatKCRoot(swmQuads, []);
const swmMerkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);
const coreWallet = ethers.Wallet.createRandom();
const fakePeerId = { toString: () => 'publisher-peer' } as any;

/** Wrap a real store so `query` never resolves — models a saturated store. */
function storeWithHangingQuery(base: OxigraphStore): TripleStore {
  return new Proxy(base as unknown as TripleStore, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return () => new Promise(() => {}); // never settles
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function createHandler(
  store: TripleStore,
  configOverrides: Partial<StorageACKHandlerConfig> = {},
) {
  const config: StorageACKHandlerConfig = {
    nodeRole: 'core',
    nodeIdentityId: 42n,
    signerWallet: coreWallet,
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
    isCgCurated: async () => true,
    ...configOverrides,
  };
  return new StorageACKHandler(store as any, config, new TypedEventBus() as any);
}

function publishIntent(): Uint8Array {
  return encodePublishIntent({
    merkleRoot,
    contextGraphId,
    publisherPeerId: 'publisher-0',
    publicByteSize: 300,
    isPrivate: false,
    kaCount: 1,
    rootEntities: ['urn:entity:1'],
    epochs: 1,
    tokenAmountStr: '1000',
    merkleLeafCount: swmMerkleLeafCount,
  });
}

/**
 * No `stagingQuads` + not encrypted → the update handler resolves the new
 * root from SWM (`loadSWMQuads` → `store.query`) — the store-touching path
 * that hangs when the store is saturated.
 */
function updateIntent(): Uint8Array {
  return encodeUpdateIntent({
    kaId: '987654321',
    contextGraphId,
    preUpdateMerkleRootCount: 1,
    newMerkleRoot: merkleRoot,
    newByteSize: 300,
    newTokenAmount: '1500',
    mintAmount: 0,
    burnTokenIds: [],
    newMerkleLeafCount: swmMerkleLeafCount,
    publisherPeerId: 'publisher-0',
  });
}

describe('StorageACKHandler — ack-handler deadline (slow-store dead-air fix)', () => {
  it('default deadline is below the publisher per-send timeout', () => {
    // The decline must reach the publisher BEFORE it gives up, or it is moot.
    // Asserted against the IMPORTED send timeout (not a restated literal) and
    // pinned to the derivation so the coupling survives a timeout change.
    expect(DEFAULT_ACK_HANDLER_DEADLINE_MS).toBeLessThan(DEFAULT_SEND_TIMEOUT_MS);
    expect(DEFAULT_ACK_HANDLER_DEADLINE_MS).toBe(
      DEFAULT_SEND_TIMEOUT_MS - ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS,
    );
    expect(ACK_HANDLER_DEADLINE_SAFETY_MARGIN_MS).toBeGreaterThan(0);
  });

  it('a store that never answers yields a CORE_TEMPORARILY_UNAVAILABLE decline, not dead-air', async () => {
    const onDecline = vi.fn();
    const handler = await createHandler(
      storeWithHangingQuery(new OxigraphStore()),
      { onDecline, ackHandlerDeadlineMs: 50 },
    );

    const started = Date.now();
    const response = await handler.handler(publishIntent(), fakePeerId);
    const elapsed = Date.now() - started;
    const decoded = decodeStorageACK(response);

    // Resolved via the deadline, not by hanging until the publisher timed out.
    expect(elapsed).toBeLessThan(5_000);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('ack handler deadline exceeded');
    // Wire message stays generic; the local hook carries the real cause + cgId.
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onDecline.mock.calls[0]?.[0]).toMatchObject({
      code: STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
      contextGraphId,
    });
  });

  it('a healthy fast handler is unaffected by the deadline (returns its real reply)', async () => {
    const base = new OxigraphStore();
    await base.insert(
      swmQuads.map((q) => ({ ...q, graph: `did:dkg:context-graph:${contextGraphId}/_shared_memory` })),
    );
    // A generous deadline; the real store answers well within it.
    const handler = await createHandler(base as unknown as TripleStore, { ackHandlerDeadlineMs: 10_000 });

    const response = await handler.handler(publishIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);

    // Not a deadline decline — either a signed ACK or a domain decline, but
    // never the CORE_TEMPORARILY_UNAVAILABLE "deadline exceeded" reply.
    expect(decoded.declineMessage).not.toBe('ack handler deadline exceeded');
  });

  it('deadline disabled (0) falls through to the raw handler', async () => {
    const base = new OxigraphStore();
    await base.insert(
      swmQuads.map((q) => ({ ...q, graph: `did:dkg:context-graph:${contextGraphId}/_shared_memory` })),
    );
    const handler = await createHandler(base as unknown as TripleStore, { ackHandlerDeadlineMs: 0 });

    const response = await handler.handler(publishIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(decoded.declineMessage).not.toBe('ack handler deadline exceeded');
  });
});

// The UPDATE ACK handler ('/dkg/10.0.1/storage-update-ack') shares the store
// and the failure mode: before the fix it awaited its body directly, so a
// hanging SWM `store.query` dead-aired update ACKs past the publisher's 20s
// per-send timeout exactly as publish did. It now runs under the SAME
// deadline runner, and the update collector rides the same transient-decline
// retry ladder — these mirror the publish cases above.
describe('StorageACKHandler — update-ACK handler deadline (slow-store dead-air fix)', () => {
  it('a store that never answers yields a CORE_TEMPORARILY_UNAVAILABLE decline, not dead-air', async () => {
    const onDecline = vi.fn();
    const handler = await createHandler(
      storeWithHangingQuery(new OxigraphStore()),
      { onDecline, ackHandlerDeadlineMs: 50 },
    );

    const started = Date.now();
    const response = await handler.updateHandler(updateIntent(), fakePeerId);
    const elapsed = Date.now() - started;
    const decoded = decodeStorageACK(response);

    // Resolved via the deadline, not by hanging until the publisher timed out.
    expect(elapsed).toBeLessThan(5_000);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('ack handler deadline exceeded');
    // The decline carries the cgId decoded off the update intent so the
    // publisher's collector can attribute it; the wire message stays generic
    // while the local hook carries the real cause.
    expect(decoded.contextGraphId).toBe(contextGraphId);
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onDecline.mock.calls[0]?.[0]).toMatchObject({
      code: STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
      contextGraphId,
    });
  });

  it('a healthy fast update body is unaffected by the deadline (returns its real reply)', async () => {
    const base = new OxigraphStore();
    await base.insert(
      swmQuads.map((q) => ({ ...q, graph: `did:dkg:context-graph:${contextGraphId}/_shared_memory` })),
    );
    // A generous deadline; the real store answers well within it.
    const handler = await createHandler(base as unknown as TripleStore, { ackHandlerDeadlineMs: 10_000 });

    const response = await handler.updateHandler(updateIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);

    // Not a deadline decline — either a signed ACK or a domain decline, but
    // never the CORE_TEMPORARILY_UNAVAILABLE "deadline exceeded" reply.
    expect(decoded.declineMessage).not.toBe('ack handler deadline exceeded');
  });

  it('deadline disabled (0) falls through to the raw update handler', async () => {
    const base = new OxigraphStore();
    await base.insert(
      swmQuads.map((q) => ({ ...q, graph: `did:dkg:context-graph:${contextGraphId}/_shared_memory` })),
    );
    const handler = await createHandler(base as unknown as TripleStore, { ackHandlerDeadlineMs: 0 });

    const response = await handler.updateHandler(updateIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(decoded.declineMessage).not.toBe('ack handler deadline exceeded');
  });
});
