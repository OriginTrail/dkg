import { describe, it, expect, vi } from 'vitest';
import {
  StorageACKHandler,
  withSignerRegistrationCache,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { QuorumUnmetError } from '../src/ack-errors.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  encodePublishIntent,
  encodeUpdateIntent,
  decodeStorageACK,
  isStorageACKDecline,
  isTransientStorageACKDeclineCode,
  boundedDeclineCodeLabel,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

// Regression suite for the testnet storage-ACK dead-air incident: when the
// core-side handler THREW anywhere (store op mid-worker-restart, signer-
// registration chain lookup against a degraded RPC), ProtocolRouter's
// inbound wrapper aborted the stream with NO reply — the publisher burned
// MAX_RETRIES=3 transport attempts and bucketed the peer as `no_response`
// (live incident: 7 cores dialled, 21 attempts, ALL no_response, 0
// declines). These tests pin the fix on all three layers:
//   1. handler: peer-local transient failures → in-band
//      CORE_TEMPORARILY_UNAVAILABLE decline (publish + update);
//   2. collector: a terminal transport failure ALWAYS records
//      TRANSPORT_ERROR + the sanitized message (never a bare no_response);
//   3. agent seam: `withSignerRegistrationCache` stops the per-ACK live
//      chain read from turning one RPC blip into network-wide dead air.

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

type FailingOp = 'query' | 'insert' | 'dropGraph' | 'deleteByPattern';

/**
 * Wrap a REAL OxigraphStore so only the named operations throw the classic
 * mid-restart oxigraph failure ('store is closed'); everything else keeps
 * hitting the live store. Models the observed node-4 failure mode without
 * faking the store's behavior wholesale.
 */
function storeWithFailingOps(
  base: OxigraphStore,
  failingOps: readonly FailingOp[],
): TripleStore {
  return new Proxy(base as unknown as TripleStore, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && (failingOps as readonly string[]).includes(prop)) {
        return async () => {
          throw new Error('store is closed');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('CORE_TEMPORARILY_UNAVAILABLE decline code (dead-air fix)', () => {
  it('is a transient (retryable) decline code with a bounded metric label', () => {
    // Transient membership is part of the publisher↔core protocol contract:
    // the collector must RETRY this peer on the transient cadence instead of
    // deselecting it on the first store/RPC blip.
    expect(
      isTransientStorageACKDeclineCode(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE),
    ).toBe(true);
    // Known enum member → allowed verbatim as a low-cardinality metric label.
    expect(
      boundedDeclineCodeLabel(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE),
    ).toBe('CORE_TEMPORARILY_UNAVAILABLE');
  });
});

describe('StorageACKHandler — failing store / failing signer lookup → explicit transient decline', () => {
  const contextGraphId = '42';
  const swmQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
  ];
  const merkleRoot = computeFlatKCRoot(swmQuads, []);
  const swmMerkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);
  const coreWallet = ethers.Wallet.createRandom();
  const fakePeerId = { toString: () => 'publisher-peer' };

  async function createHandler(
    storeQuads: Quad[],
    failingOps: readonly FailingOp[],
    configOverrides: Partial<StorageACKHandlerConfig> = {},
  ) {
    const base = new OxigraphStore();
    const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
    if (storeQuads.length > 0) {
      // Seed through the REAL store before arming the failure — the data is
      // present; only the ACK-time store access is unhealthy.
      await base.insert(storeQuads.map(q => ({ ...q, graph: swmGraph })));
    }
    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: 42n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      isCgCurated: async () => true,
      ...configOverrides,
    };
    return new StorageACKHandler(
      storeWithFailingOps(base, failingOps) as any,
      config,
      new TypedEventBus() as any,
    );
  }

  function publishIntent(overrides: Record<string, unknown> = {}): Uint8Array {
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
      ...overrides,
    });
  }

  it('publish / SWM-fallback path: a store whose query throws "store is closed" declines instead of resetting the stream', async () => {
    const onDecline = vi.fn();
    const handler = await createHandler(swmQuads, ['query'], { onDecline });

    // Pre-fix this exact call REJECTED (stream reset → publisher no_response).
    const response = await handler.handler(publishIntent(), fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('store unavailable');
    // Wire hygiene: the raw store error stays OFF the network...
    expect(decoded.declineMessage).not.toContain('store is closed');
    // ...but the local WARN hook gets the real cause for the operator.
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onDecline.mock.calls[0]?.[0]).toMatchObject({
      code: STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
      contextGraphId,
      message: expect.stringContaining('store is closed'),
    });
  });

  it('publish / inline-staging path: a store whose insert throws declines instead of resetting the stream', async () => {
    // Inline payload → the handler verifies the root in memory (passes) and
    // then must PERSIST to the staging graph before signing (crash safety).
    // The persist hitting a closed store is a transient decline, not a reset.
    const g = 'did:dkg:context-graph:42';
    const inlineQuads: Quad[] = [makeQuad('urn:s', 'urn:p', 'urn:o', g)];
    const nquadsStr = inlineQuads
      .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
      .join('\n');
    const stagingBytes = new TextEncoder().encode(nquadsStr);
    const handler = await createHandler([], ['insert']);

    const response = await handler.handler(
      publishIntent({
        merkleRoot: computeFlatKCRoot(inlineQuads, []),
        publicByteSize: stagingBytes.length,
        rootEntities: ['urn:s'],
        merkleLeafCount: computeFlatKCMerkleLeafCountV10(inlineQuads, []),
        stagingQuads: stagingBytes,
      }),
      fakePeerId,
    );
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('store unavailable');
  });

  it('update handler / SWM-fallback path: a store whose query throws declines instead of resetting the stream', async () => {
    const handler = await createHandler(swmQuads, ['query']);
    // No stagingQuads + not encrypted → the update handler resolves the new
    // root from SWM, which is the store-touching path the incident hit.
    const intent = encodeUpdateIntent({
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

    const response = await handler.updateHandler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toBe('store unavailable');
  });

  it('update handler: a THROWN signer-registration lookup declines instead of resetting the stream', async () => {
    // The publish-handler counterpart lives in storage-ack-handler.test.ts
    // ("declines (CORE_TEMPORARILY_UNAVAILABLE) when signer registration
    // lookup fails"). Inline stagingQuads keep the store out of the picture
    // so this pins the signer-lookup branch specifically.
    const lookupFailed = vi.fn();
    const unregistered = vi.fn();
    const updatedQuads: Quad[] = [makeQuad('urn:entity:1', 'urn:p', 'urn:o1-updated')];
    const nquadsStr = updatedQuads
      .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
      .join('\n');
    const stagingBytes = new TextEncoder().encode(nquadsStr);
    const handler = await createHandler([], [], {
      isSignerRegistered: async () => { throw new Error('rpc unavailable'); },
      onSignerRegistrationLookupFailed: lookupFailed,
      onSignerUnregistered: unregistered,
    });
    const intent = encodeUpdateIntent({
      kaId: '987654321',
      contextGraphId,
      preUpdateMerkleRootCount: 1,
      newMerkleRoot: computeFlatKCRoot(updatedQuads, []),
      newByteSize: stagingBytes.length,
      newTokenAmount: '1500',
      mintAmount: 0,
      burnTokenIds: [],
      newMerkleLeafCount: computeFlatKCMerkleLeafCountV10(updatedQuads, []),
      publisherPeerId: 'publisher-0',
      stagingQuads: stagingBytes,
    });

    const response = await handler.updateHandler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toContain('signer registration lookup unavailable');
    expect(decoded.declineMessage).not.toContain('rpc unavailable');
    expect(lookupFailed).toHaveBeenCalledOnce();
    // A failed LOOKUP is not an unregistration verdict — the handler must
    // NOT tear down its protocol registrations over an RPC blip.
    expect(unregistered).not.toHaveBeenCalled();
  });

  it('a definitively unregistered signer still declines SIGNER_NOT_REGISTERED (verdict path unchanged)', async () => {
    // Guard against the fix over-reaching: only the thrown-LOOKUP branch
    // moved to CORE_TEMPORARILY_UNAVAILABLE; `registered === false` keeps
    // its permanent decline + the onSignerUnregistered failover hook.
    const unregistered = vi.fn();
    const handler = await createHandler(swmQuads, [], {
      isSignerRegistered: async () => false,
      onSignerUnregistered: unregistered,
    });
    const decoded = decodeStorageACK(await handler.handler(publishIntent(), fakePeerId));
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    expect(unregistered).toHaveBeenCalledOnce();
  });
});

describe('ACKCollector — terminal transport failures surface as TRANSPORT_ERROR, not no_response', () => {
  const testCGId = 42n;
  const testCGIdStr = 'test-cg';
  const testQuads = [
    makeQuad('urn:a', 'urn:p', 'urn:o1'),
    makeQuad('urn:a', 'urn:p', 'urn:o2'),
  ];
  const merkleRoot = computeFlatKCRoot(testQuads, []);
  const merkleLeafCount = computeFlatKCMerkleLeafCountV10(testQuads, []);

  it('a peer whose sendP2P ALWAYS throws ends with peerOutcome TRANSPORT_ERROR + the real message', async () => {
    // Dead-air incident regression: the peer never gets a byte through. The
    // old `declines.has(peerId)` gate only recorded TRANSPORT_ERROR when the
    // peer had previously transient-declined — a peer that was silent from
    // the very first dial was reported as a bare `no_response` with the
    // actual transport error string erased (the incident log: 7 cores,
    // 21 attempts, ALL no_response, 0 declines).
    //
    // Single peer + requiredACKs=1 keeps the snapshot deterministic: the
    // impossible-quorum fast-fail fires only after THIS peer's retry budget
    // is fully spent, so its terminal outcome is always recorded first.
    const transportErrorMessage = 'dial to peer failed: connection refused by remote';
    const sendAttempts: string[] = [];
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sleep: async () => {}, // collapse retry backoff so the test is instant
      sendP2P: async (peerId) => {
        sendAttempts.push(peerId);
        throw new Error(transportErrorMessage);
      },
      getConnectedCorePeers: () => ['peer-0'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    let captured: QuorumUnmetError | undefined;
    try {
      await collector.collect({
        merkleRoot,
        contextGraphId: testCGId,
        contextGraphIdStr: testCGIdStr,
        publisherPeerId: 'publisher-0',
        publicByteSize: 100n,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:a'],
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        merkleLeafCount,
        requiredACKs: 1,
      });
    } catch (err) {
      if (err instanceof QuorumUnmetError) captured = err;
      else throw err;
    }

    expect(captured).toBeDefined();
    // The full transport budget was spent (the incident's 3-attempts shape).
    expect(sendAttempts).toEqual(['peer-0', 'peer-0', 'peer-0']);
    const deadPeer = captured!.peerOutcomes.find((o) => o.peerId === 'peer-0');
    expect(deadPeer).toBeDefined();
    expect(deadPeer!.reason).toBe('TRANSPORT_ERROR');
    expect(deadPeer!.reason).not.toBe('no_response');
    expect(deadPeer!.dialOk).toBe(false);
    // The sanitized transport message rides the aggregated `Declines:`
    // diagnostic so the operator sees the actual cause.
    expect(captured!.message).toContain('storage_ack_insufficient');
    expect(captured!.message).toContain(transportErrorMessage);
  });
});

describe('withSignerRegistrationCache — TTL dedupe + serve-stale-on-error', () => {
  it('serves the cached verdict within the TTL (one underlying chain read) and stale through an RPC outage', async () => {
    let clock = 0;
    let lookupCalls = 0;
    let failing = false;
    const served: Array<{ err: unknown; value: boolean }> = [];
    const probe = withSignerRegistrationCache(
      async () => {
        lookupCalls += 1;
        if (failing) throw new Error('rpc degraded: 429 over rate limit');
        return true;
      },
      {
        ttlMs: 30_000,
        staleWindowMs: 300_000,
        now: () => clock,
        onServedStale: (err, value) => served.push({ err, value }),
      },
    );

    // First call hits the chain; the next ones inside the 30s TTL do not.
    expect(await probe()).toBe(true);
    clock = 10_000;
    expect(await probe()).toBe(true);
    clock = 29_999;
    expect(await probe()).toBe(true);
    expect(lookupCalls).toBe(1);

    // TTL expired + RPC now failing → the last good verdict is served
    // (this is the incident scenario: one degraded shared RPC must not
    // dead-air every ACK on every core).
    failing = true;
    clock = 60_000;
    expect(await probe()).toBe(true);
    expect(lookupCalls).toBe(2); // it DID try the live lookup first
    expect(served).toHaveLength(1);
    expect(served[0]?.value).toBe(true);

    // Still inside the 5-min stale window → keeps serving.
    clock = 250_000;
    expect(await probe()).toBe(true);
    expect(served).toHaveLength(2);
  });

  it('rethrows once the stale window is exhausted (handler then declines CORE_TEMPORARILY_UNAVAILABLE)', async () => {
    let clock = 0;
    const probe = withSignerRegistrationCache(
      async () => {
        if (clock > 0) throw new Error('rpc degraded');
        return true;
      },
      { ttlMs: 30_000, staleWindowMs: 300_000, now: () => clock },
    );
    expect(await probe()).toBe(true);
    // Cached at t=0; beyond t=300_000 the verdict is too old to trust.
    clock = 300_001;
    await expect(probe()).rejects.toThrow('rpc degraded');
  });

  it('rethrows when the very first lookup fails (no cached verdict to serve)', async () => {
    const probe = withSignerRegistrationCache(async () => {
      throw new Error('rpc never came up');
    });
    await expect(probe()).rejects.toThrow('rpc never came up');
  });

  it('caches false verdicts too — a known-unregistered signer does not hammer the RPC', async () => {
    let clock = 0;
    let lookupCalls = 0;
    const probe = withSignerRegistrationCache(
      async () => {
        lookupCalls += 1;
        return false;
      },
      { ttlMs: 30_000, staleWindowMs: 300_000, now: () => clock },
    );
    expect(await probe()).toBe(false);
    clock = 15_000;
    expect(await probe()).toBe(false);
    expect(lookupCalls).toBe(1);
    clock = 31_000;
    expect(await probe()).toBe(false);
    expect(lookupCalls).toBe(2);
  });
});
