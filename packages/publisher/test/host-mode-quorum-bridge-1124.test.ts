import { describe, it, expect } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  computePublishACKDigest,
  encodePublishIntent,
  decodeStorageACK,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Issue #1124 / PR #1239 — the COLLECTOR half of the end-state: given the public
 * plaintext is present in N non-member hosts' SWM, the publisher's quorum is
 * reachable purely from them.
 *
 * SCOPE — read this with its sibling. The claim "the real host-mode ingest
 * actually WRITES the public plaintext into `<cg>/_shared_memory` (the graph the
 * ACK handler reads)" is proved by the agent-side test that drives the REAL
 * `ingestSwmHostModeEnvelope` end-to-end into a real `StorageACKHandler`:
 * `packages/agent/test/swm/host-mode-public-ingest-1124.test.ts`
 * ("a confirmed-public ingest makes a NON-MEMBER host ACK-capable"). THIS test
 * does NOT drive the ingest path — it seeds the SWM graph directly and isolates
 * the next link: that the `ACKCollector` reaches quorum from N non-member cores
 * once their SWM holds the share. (A direct seed alone would stay green even if
 * ingest never populated `_shared_memory`, which is exactly why the agent-side
 * real-ingest test — not this one — is the guard for the apply.)
 *
 * Why prove it here at the collector layer at all: the NON-member sub-scenario
 * can't be reproduced on a small all-staked devnet, where every core is a member
 * of every *registered* CG (live: a CG-4 publish reached quorum with every ACK
 * tagged `source=member`, including the host-mode node). The load-bearing
 * architectural fact: `StorageACKHandlerConfig` has NO membership input. A core
 * signs a quorum-eligible ACK iff (role=core ∧ data-present-in-SWM ∧
 * merkle-matches ∧ signer-registered) — membership is never consulted, so a
 * non-member host's ACK is consensus-identical to a member's.
 */
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

const contextGraphId = '77';
const cgIdBigInt = 77n;
const swmGraphUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

function makeQuad(s: string, p: string, o: string): Quad {
  return { subject: s, predicate: p, object: o, graph: swmGraphUri };
}

// The public plaintext a host-mode non-member core ingested off gossip.
const publicQuads: Quad[] = [
  makeQuad('urn:public:asset:1', 'http://schema.org/name', '"Public Knowledge Asset"'),
  makeQuad('urn:public:asset:1', 'http://schema.org/description', '"reachable-quorum-demo"'),
  makeQuad('urn:public:asset:1', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:test:Asset'),
];
const merkleRoot = computeFlatKCRoot(publicQuads, []);
const merkleLeafCount = computeFlatKCMerkleLeafCountV10(publicQuads, []);
const publicByteSize = BigInt(publicQuads.length * 100);

const noopBus = { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };

/**
 * Build N non-member host-mode core handlers. `seeded=true` mimics the
 * post-#1124 world (the gate admitted + stored the public plaintext);
 * `seeded=false` mimics the pre-#1124 world (the gate dropped it, SWM empty).
 */
async function makeNonMemberCores(count: number, seeded: boolean) {
  const wallets = Array.from({ length: count }, () => ethers.Wallet.createRandom());
  const handlers = [];
  for (let i = 0; i < count; i++) {
    const store = new OxigraphStore();
    if (seeded) {
      // Seed the SWM graph the ACK handler reads. That the REAL host-mode ingest
      // actually produces this state (writes the public plaintext into
      // `<cg>/_shared_memory`) is proved separately by the agent-side real-ingest
      // test (see the file header); here we take it as given and isolate the
      // collector's quorum behaviour. Nothing about membership.
      await store.insert(publicQuads.map((q) => ({ ...q })));
    }
    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: BigInt(i + 1),
      signerWallet: wallets[i],
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      // No `isCgCurated`, no membership hook — these are plain non-member hosts.
    };
    handlers.push(new StorageACKHandler(store as any, config, noopBus as any));
  }
  return { wallets, handlers };
}

// Wire the collector with the PRODUCTION identity gate. Each non-member host's
// signer wallet (wallets[i]) is "registered" on-chain to its node identity
// (i+1) via this map, so `verifyIdentity` enforces the SAME check production
// applies: an ACK is quorum-eligible only if its recovered signer is the
// registered operational key for the claimed identity. Without this the
// collector would skip identity verification entirely and accept any
// syntactically-valid signature (otReviewAgent #1239) — this proves the ACKs
// are genuinely on-chain-submittable, not just well-formed.
function makeCollector(handlers: StorageACKHandler[], wallets: ethers.Wallet[]) {
  const peers = handlers.map((_, i) => `host-${i}`);
  const registered = new Map<string, string>(); // identityId → registered signer address
  wallets.forEach((w, i) => registered.set(String(i + 1), w.address.toLowerCase()));
  const deps: ACKCollectorDeps = {
    gossipPublish: async () => {},
    sendP2P: async (peerId, _protocol, data) => {
      const idx = parseInt(peerId.replace('host-', ''), 10);
      return handlers[idx].handler(data, { toString: () => peerId });
    },
    getConnectedCorePeers: () => peers,
    verifyIdentity: async (recoveredAddress: string, identityId: bigint) =>
      registered.get(identityId.toString()) === recoveredAddress.toLowerCase(),
    log: () => {},
  };
  return new ACKCollector(deps);
}

const collectArgs = {
  merkleRoot,
  contextGraphId: cgIdBigInt,
  contextGraphIdStr: contextGraphId,
  publisherPeerId: 'publisher-edge',
  publicByteSize,
  isPrivate: false,
  kaCount: 1,
  rootEntities: [] as string[],
  chainId: TEST_CHAIN_ID,
  kav10Address: TEST_KAV10_ADDR,
  merkleLeafCount,
  ackMode: { kind: 'public' } as const,
};

describe('#1124 end-state: public-CG quorum is REACHED purely via non-member host-mode cores', () => {
  it('POST-FIX — 3 non-member hosts holding the host-mode-ingested plaintext reach quorum with valid, IDENTITY-VERIFIED signed ACKs', async () => {
    const { wallets, handlers } = await makeNonMemberCores(3, /* seeded */ true);
    // verifyIdentity wired with the (identity→signer) registration → the
    // collector applies the SAME on-chain identity gate production does.
    const collector = makeCollector(handlers, wallets);

    const result = await collector.collect({ ...collectArgs });

    // Quorum (DEFAULT_REQUIRED_ACKS = 3) reached entirely from non-members, and
    // every ACK passed the identity gate (registered signer for its identity).
    expect(result.acks).toHaveLength(3);

    // Every ACK is a real EIP-191 signature over the canonical V10 publish
    // digest, recovering to one of the non-member host signers — i.e. each is
    // a consensus-valid, on-chain-submittable ACK, not a courtesy response.
    const digest = computePublishACKDigest(
      TEST_CHAIN_ID, TEST_KAV10_ADDR, cgIdBigInt, merkleRoot,
      1n, publicByteSize, 1n, 0n, BigInt(merkleLeafCount),
    );
    const prefixedHash = ethers.hashMessage(digest);
    const hostAddresses = wallets.map((w) => w.address.toLowerCase());
    for (const ack of result.acks) {
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.signatureR),
        yParityAndS: ethers.hexlify(ack.signatureVS),
      });
      expect(hostAddresses).toContain(recovered.toLowerCase());
    }
  });

  it('the identity gate is load-bearing — the REAL collector cannot reach quorum when no host signer is a registered identity', async () => {
    // Drives the ACTUAL ACKCollector with verifyIdentity rejecting every signer
    // (no registration), so the test fails if the collector ever stopped calling
    // verifyIdentity or ignored its result. The hosts still SIGN valid ACKs, but
    // identity rejection is non-retryable (not a transient decline), so the
    // collector settles all peers and fails quorum fast — no ~31s retry budget.
    const { handlers } = await makeNonMemberCores(3, /* seeded */ true);
    const peers = handlers.map((_, i) => `host-${i}`);
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, _protocol, data) => {
        const idx = parseInt(peerId.replace('host-', ''), 10);
        return handlers[idx].handler(data, { toString: () => peerId });
      },
      getConnectedCorePeers: () => peers,
      verifyIdentity: async () => false, // no signer is a registered identity
      log: () => {},
    };
    const collector = new ACKCollector(deps);
    await expect(collector.collect({ ...collectArgs })).rejects.toThrow();
  });

  it('PRE-FIX (negative control) — with the plaintext DROPPED (empty SWM) every host DECLINEs NO_DATA, the quorum-blocking signal', async () => {
    // This is the #1124 failure mode: the gate dropped the self-signed public
    // plaintext, SWM stayed empty. Each host then returns NO_DATA_IN_SWM — a
    // permanent decline the collector cannot count, so quorum is unreachable.
    // Asserting it at the handler layer (vs. burning the collector's ~31s
    // retry-then-fail budget) pins the exact decline AND proves the seeded
    // data above — not some membership side-channel — is what makes quorum
    // reachable.
    const { handlers } = await makeNonMemberCores(3, /* seeded */ false);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-edge',
      publicByteSize: Number(publicByteSize),
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      merkleLeafCount,
    });
    for (const handler of handlers) {
      const decoded = decodeStorageACK(await handler.handler(intent, { toString: () => 'publisher-edge' }));
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    }
  });
});
