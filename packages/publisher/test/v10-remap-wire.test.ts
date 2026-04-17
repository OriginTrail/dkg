import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TypedEventBus } from '@origintrail-official/dkg-core';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { computeFlatKCRootV10 } from '../src/merkle.js';
import {
  encodePublishIntent,
  decodePublishIntent,
  encodeStorageACK,
  decodeStorageACK,
  computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

// Focused regression coverage for the dual-ID remap wire introduced in the
// V10 publish off-chain rewire PR:
//
//   `contextGraphIdStr` / `contextGraphId` on the wire = the TARGET on-chain
//     numeric CG id that the ACK digest and the publishDirect tx use.
//   `swmGraphId` on the wire = the SOURCE graph the publisher is reading
//     data from in SWM. Only populated on the `publishFromSharedMemory`
//     remap flow where source graph name (e.g. "epcis-source-graph") is
//     distinct from the target numeric id.
//   `subGraphName` = optional sub-graph partition appended to the SWM URI.
//
// Goal: prove the collector puts both fields on the wire, prove the handler
// resolves SWM via the SOURCE graph while still signing the ACK digest
// against the TARGET numeric id, and prove the `omit swmGraphId when it
// matches target` short-circuit works so direct publishes keep a minimal
// wire payload.

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

// Use a distinctive, long target id so positive string assertions on the
// staging graph URI cannot accidentally collide with a short prefix
// substring of the merkle hex.
const SOURCE_SWM_GRAPH_ID = 'epcis-source-graph';
const SUB_GRAPH_NAME = 'shipments-2025';
const TARGET_CG_ID_STR = '987654321';
const TARGET_CG_ID_BIGINT = 987654321n;

const KA_COUNT = 2;
const BYTE_SIZE = 300n;
const EPOCHS = 1n;
const TOKEN_AMOUNT = 1000n;

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function computeTargetAckDigest(merkleRoot: Uint8Array): Uint8Array {
  return computePublishACKDigest(
    TEST_CHAIN_ID,
    TEST_KAV10_ADDR,
    TARGET_CG_ID_BIGINT,
    merkleRoot,
    BigInt(KA_COUNT),
    BYTE_SIZE,
    EPOCHS,
    TOKEN_AMOUNT,
  );
}

async function signTargetAck(
  wallet: ethers.Wallet,
  merkleRoot: Uint8Array,
  nodeIdentityId: number,
  contextGraphIdOnWire: string = TARGET_CG_ID_STR,
): Promise<Uint8Array> {
  const digest = computeTargetAckDigest(merkleRoot);
  const sig = ethers.Signature.from(await wallet.signMessage(digest));
  return encodeStorageACK({
    merkleRoot,
    coreNodeSignatureR: ethers.getBytes(sig.r),
    coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
    contextGraphId: contextGraphIdOnWire,
    nodeIdentityId,
  });
}

describe('V10 remap wire (PublishIntent.swmGraphId + subGraphName)', () => {
  const swmQuads: Quad[] = [
    makeQuad('urn:ship:1', 'urn:has', 'urn:item:a'),
    makeQuad('urn:ship:1', 'urn:has', 'urn:item:b'),
    makeQuad('urn:ship:2', 'urn:has', 'urn:item:c'),
  ];
  const merkleRoot = computeFlatKCRootV10(swmQuads, []);
  const rootEntities = ['urn:ship:1', 'urn:ship:2'];

  // Hand-serialized N-Quads that re-hash to the same merkle root the test
  // oracle computes. The handler parses these inline (stagingQuads path)
  // instead of hitting a real SWM store.
  const stagingQuads = new TextEncoder().encode(
    swmQuads
      .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
      .join('\n'),
  );

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ACKCollector puts swmGraphId + subGraphName on the wire and signs against the target', async () => {
    let dispatchedIntent: Uint8Array | undefined;
    const peerWallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ];

    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, _protocol, data) => {
        // Capture the very first intent dispatched so we can assert its
        // wire contents below — subsequent peer dials use the same bytes.
        if (dispatchedIntent === undefined) dispatchedIntent = data;
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        // Peers MUST sign the H5 digest built from the TARGET numeric id.
        // If the collector were passing the SOURCE graph name into the
        // digest, ecrecover would yield a different address and the ACK
        // would be rejected at collector verification, failing this test.
        return signTargetAck(peerWallets[idx], merkleRoot, idx + 1);
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: TARGET_CG_ID_BIGINT,
      contextGraphIdStr: TARGET_CG_ID_STR,
      publisherPeerId: 'publisher-0',
      publicByteSize: BYTE_SIZE,
      isPrivate: false,
      kaCount: KA_COUNT,
      rootEntities,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      epochs: Number(EPOCHS),
      tokenAmount: TOKEN_AMOUNT,
      swmGraphId: SOURCE_SWM_GRAPH_ID,
      subGraphName: SUB_GRAPH_NAME,
      stagingQuads,
    });

    expect(result.acks).toHaveLength(3);
    expect(result.contextGraphId).toBe(TARGET_CG_ID_BIGINT);

    // The wire payload must carry BOTH source and target identifiers.
    expect(dispatchedIntent).toBeDefined();
    const decoded = decodePublishIntent(dispatchedIntent!);
    expect(decoded.contextGraphId).toBe(TARGET_CG_ID_STR);
    expect(decoded.swmGraphId).toBe(SOURCE_SWM_GRAPH_ID);
    expect(decoded.subGraphName).toBe(SUB_GRAPH_NAME);
    expect(decoded.kaCount).toBe(KA_COUNT);
  });

  it('ACKCollector elides swmGraphId when source equals target (direct publish)', async () => {
    let dispatchedIntent: Uint8Array | undefined;
    const peerWallet = ethers.Wallet.createRandom();

    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, _protocol, data) => {
        if (dispatchedIntent === undefined) dispatchedIntent = data;
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        return signTargetAck(peerWallet, merkleRoot, idx + 1);
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    // Direct publish: swmGraphId is set to the same value as the target.
    // The collector short-circuits and omits it from the wire payload so
    // peers fall back to contextGraphId for SWM resolution.
    await collector.collect({
      merkleRoot,
      contextGraphId: TARGET_CG_ID_BIGINT,
      contextGraphIdStr: TARGET_CG_ID_STR,
      publisherPeerId: 'publisher-0',
      publicByteSize: BYTE_SIZE,
      isPrivate: false,
      kaCount: KA_COUNT,
      rootEntities,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      epochs: Number(EPOCHS),
      tokenAmount: TOKEN_AMOUNT,
      swmGraphId: TARGET_CG_ID_STR,
      stagingQuads,
    }).catch(() => {});

    expect(dispatchedIntent).toBeDefined();
    const decoded = decodePublishIntent(dispatchedIntent!);
    expect(decoded.contextGraphId).toBe(TARGET_CG_ID_STR);
    // protobufjs maps an omitted optional string to '' on decode; either
    // shape is acceptable. The contract is: no caller-visible value that
    // could be mistaken for a non-trivial remap source.
    expect(decoded.swmGraphId ?? '').toBe('');
    expect(decoded.subGraphName ?? '').toBe('');
  });

  it('StorageACKHandler resolves SWM via (swmGraphId, subGraphName) and signs the target digest', async () => {
    // Inline staging insert schedules a 10-minute setTimeout cleanup. Use
    // fake timers so the dangling handle does not keep the test process
    // alive after the assertion block returns.
    vi.useFakeTimers();

    const uriCalls: Array<[string, string | undefined]> = [];
    const insertCalls: Quad[][] = [];
    const noop = async () => {};
    const mockStore = {
      insert: async (quads: Quad[]) => { insertCalls.push(quads); },
      delete: noop,
      deleteByPattern: noop,
      hasGraph: async () => true,
      createGraph: noop,
      dropGraph: noop,
      query: noop,
      close: noop,
    };

    const coreWallet = ethers.Wallet.createRandom();
    const coreIdentityId = 99n;

    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId, subGraphName) => {
        uriCalls.push([cgId, subGraphName]);
        return subGraphName
          ? `did:dkg:context-graph:${cgId}/${subGraphName}/_shared_memory`
          : `did:dkg:context-graph:${cgId}/_shared_memory`;
      },
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };

    const handler = new StorageACKHandler(
      mockStore as unknown as Parameters<typeof StorageACKHandler.prototype.handler>[0] extends never ? never : any,
      config,
      { emit: () => {}, on: () => {}, off: () => {}, once: () => {} } as unknown as TypedEventBus<any>,
    );

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: TARGET_CG_ID_STR,
      publisherPeerId: 'publisher-0',
      publicByteSize: Number(BYTE_SIZE),
      isPrivate: false,
      kaCount: KA_COUNT,
      rootEntities,
      stagingQuads,
      epochs: Number(EPOCHS),
      tokenAmountStr: TOKEN_AMOUNT.toString(),
      swmGraphId: SOURCE_SWM_GRAPH_ID,
      subGraphName: SUB_GRAPH_NAME,
    });

    const response = await handler.handler(intent, { toString: () => 'publisher-peer-0' });
    const ack = decodeStorageACK(response);

    // 1. Handler looked up SWM under the SOURCE graph + sub-graph, NOT the
    //    numeric target. Any other call would drop the staging write into
    //    the wrong physical graph and leak data across context graphs.
    expect(uriCalls).toHaveLength(1);
    expect(uriCalls[0][0]).toBe(SOURCE_SWM_GRAPH_ID);
    expect(uriCalls[0][1]).toBe(SUB_GRAPH_NAME);

    expect(insertCalls.length).toBeGreaterThan(0);
    const inserted = insertCalls[0];
    expect(inserted).toHaveLength(swmQuads.length);
    const stagingGraph = inserted[0].graph;
    expect(stagingGraph).toContain(SOURCE_SWM_GRAPH_ID);
    expect(stagingGraph).toContain(SUB_GRAPH_NAME);
    expect(stagingGraph).not.toContain(TARGET_CG_ID_STR);

    // 3. ACK contextGraphId on the wire is the TARGET numeric id the
    //    publisher will submit on-chain — not the SWM source name.
    expect(ack.contextGraphId).toBe(TARGET_CG_ID_STR);

    // 4. ACK signature recovers against the TARGET digest. If the handler
    //    had mistakenly used the source-graph string here, BigInt() would
    //    have thrown at line 195 and the handler would have refused the
    //    intent — this test doubles as a guard against that regression.
    const digest = computeTargetAckDigest(merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const r = ack.coreNodeSignatureR instanceof Uint8Array
      ? ack.coreNodeSignatureR
      : new Uint8Array(ack.coreNodeSignatureR);
    const vs = ack.coreNodeSignatureVS instanceof Uint8Array
      ? ack.coreNodeSignatureVS
      : new Uint8Array(ack.coreNodeSignatureVS);
    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(r),
      yParityAndS: ethers.hexlify(vs),
    });
    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
  });
});
