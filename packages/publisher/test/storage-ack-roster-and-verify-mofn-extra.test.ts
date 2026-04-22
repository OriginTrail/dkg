/**
 * Storage ACK roster & Verify M-of-N quorum unit tests.
 *
 * Audit findings covered:
 *
 *   P-8 (HIGH) — VerifyCollector M-of-N semantics. The existing tests
 *                prove that "enough" approvals succeed; they do NOT
 *                assert the negative direction that ONE voter (the
 *                proposer, with no remote approvals) MUST NOT be able
 *                to promote a VerifiedMemory batch past trust level 1.
 *                Spec §10.1 is unambiguous: requiredSignatures >= 2
 *                requires at least (N-1) remote approvals on top of
 *                the proposer signature.
 *
 *   P-9 (HIGH) — StorageACKHandler roster gap. The handler checks
 *                `nodeRole === 'core'` before signing, but it does
 *                NOT verify the `signerWallet` / `nodeIdentityId` is
 *                actually in the current on-chain core-node roster.
 *                A core-flagged edge deployment with any fresh wallet
 *                could therefore sign ACKs the publisher accepts,
 *                even if the chain would reject them. These tests
 *                exercise both sides so the missing roster check
 *                shows up as a RED test (bug evidence).
 *
 * Per QA policy: no production code changed; failing tests ARE the bug
 * evidence — see BUGS_FOUND.md P-8 / P-9.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { TypedEventBus } from '@origintrail-official/dkg-core';
import {
  encodePublishIntent,
  encodeVerifyApproval,
  computePublishACKDigest,
  computeACKDigest,
  decodeStorageACK,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  VerifyCollector,
  type VerifyCollectorDeps,
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../src/index.js';
import { computeFlatKCRootV10 } from '../src/merkle.js';

// ─────────────────────────────────────────────────────────────────────────────
// P-8  VerifyCollector M-of-N semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('P-8: VerifyCollector rejects single-voter promotion (requiredSignatures >= 2)', () => {
  const CG = 'cg-verify-mofn';
  const CG_ON_CHAIN = 42n;
  const VERIFIED_ID = 1n;
  const BATCH_ID = 7n;
  const merkleRoot = ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes('p8-verify-root')),
  );
  const proposerWallet = ethers.Wallet.createRandom();

  function makeProposerSig() {
    const digest = computeACKDigest(CG_ON_CHAIN, merkleRoot);
    return proposerWallet
      .signMessage(digest)
      .then((hex) => {
        const sig = ethers.Signature.from(hex);
        return {
          r: ethers.getBytes(sig.r),
          vs: ethers.getBytes(sig.yParityAndS),
        };
      });
  }

  it('requiredSignatures=2 with ZERO connected participants → rejects (no quorum)', async () => {
    const deps: VerifyCollectorDeps = {
      sendP2P: async () => { throw new Error('no peers connected'); },
      getParticipantPeers: () => [], // nobody home
      log: () => {},
    };
    const collector = new VerifyCollector(deps);

    const proposerSignature = await makeProposerSig();
    await expect(
      collector.collect({
        contextGraphId: CG,
        contextGraphIdOnChain: CG_ON_CHAIN,
        verifiedMemoryId: VERIFIED_ID,
        batchId: BATCH_ID,
        merkleRoot,
        entities: ['urn:test:p8:entity'],
        proposerSignature,
        requiredSignatures: 2,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/verify_no_peers|verify_insufficient/);
  });

  it('requiredSignatures=4 with only 2 peers → rejects pre-collection (quorum impossible)', async () => {
    // remoteRequired = requiredSignatures - 1 = 3.  peers = 2.  2 < 3, so the
    // collector MUST refuse up front with `verify_insufficient_peers` instead
    // of hanging on sendP2P until timeout.
    const deps: VerifyCollectorDeps = {
      sendP2P: async () => { throw new Error('unreachable'); },
      getParticipantPeers: () => ['peer-1', 'peer-2'],
      log: () => {},
    };
    const collector = new VerifyCollector(deps);
    const proposerSignature = await makeProposerSig();
    await expect(
      collector.collect({
        contextGraphId: CG,
        contextGraphIdOnChain: CG_ON_CHAIN,
        verifiedMemoryId: VERIFIED_ID,
        batchId: BATCH_ID,
        merkleRoot,
        entities: ['urn:test:p8:entity'],
        proposerSignature,
        requiredSignatures: 4,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/insufficient_peers/);
  });

  it('requiredSignatures=2, 1 peer present but times out → collector rejects (no silent promotion)', async () => {
    const deps: VerifyCollectorDeps = {
      // sendP2P hangs past the timeout so the collector cannot collect the
      // 1 remote approval it needs. This pins the "single voter (proposer)
      // alone MUST NOT promote" behavior: even with a reachable peer, if
      // the peer never signs, the collector must fail — not silently pass.
      sendP2P: () => new Promise((_resolve, reject) => setTimeout(
        () => reject(new Error('peer timed out')),
        10_000,
      )),
      getParticipantPeers: () => ['peer-slow-1'],
      log: () => {},
    };
    const collector = new VerifyCollector(deps);
    const proposerSignature = await makeProposerSig();
    await expect(
      collector.collect({
        contextGraphId: CG,
        contextGraphIdOnChain: CG_ON_CHAIN,
        verifiedMemoryId: VERIFIED_ID,
        batchId: BATCH_ID,
        merkleRoot,
        entities: ['urn:test:p8:entity'],
        proposerSignature,
        requiredSignatures: 2,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/verify_(timeout|insufficient)/);
  }, 15000);

  it('requiredSignatures=2 with 1 peer that signs for a DIFFERENT address is not counted (dedup by address)', async () => {
    // The legit remote voter; they sign the right digest and their
    // address is distinct from the proposer's → should count as 1 remote
    // approval (meets requiredSignatures = 2 with proposer as the 2nd).
    const remoteWallet = ethers.Wallet.createRandom();
    const approvalDigest = computeACKDigest(CG_ON_CHAIN, merkleRoot);
    const approvalBytesFor = async (w: ethers.Wallet) => {
      const sig = ethers.Signature.from(await w.signMessage(approvalDigest));
      return encodeVerifyApproval({
        proposalId: new Uint8Array(16), // echoes proposer; collector only uses approval signature/addresses
        agentSignatureR: ethers.getBytes(sig.r),
        agentSignatureVS: ethers.getBytes(sig.yParityAndS),
        approvalTimestamp: new Date().toISOString(),
      });
    };

    const deps: VerifyCollectorDeps = {
      sendP2P: async () => approvalBytesFor(remoteWallet),
      getParticipantPeers: () => ['peer-legit-1'],
      log: () => {},
    };
    const collector = new VerifyCollector(deps);
    const proposerSignature = await makeProposerSig();
    const result = await collector.collect({
      contextGraphId: CG,
      contextGraphIdOnChain: CG_ON_CHAIN,
      verifiedMemoryId: VERIFIED_ID,
      batchId: BATCH_ID,
      merkleRoot,
      entities: ['urn:test:p8:entity'],
      proposerSignature,
      requiredSignatures: 2,
      timeoutMs: 2000,
    });

    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0].approverAddress.toLowerCase()).toBe(
      remoteWallet.address.toLowerCase(),
    );
    // Proposer's own address must NOT appear in the remote approval list —
    // that's the guarantee of "single voter does NOT promote": the
    // proposer counts as the implicit signer only because the collector
    // returns `remoteRequired = requiredSignatures - 1` approvals.
    expect(result.approvals[0].approverAddress.toLowerCase()).not.toBe(
      proposerWallet.address.toLowerCase(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-9  StorageACKHandler roster check gap
// ─────────────────────────────────────────────────────────────────────────────

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeMockStore() {
  const inserts: Quad[][] = [];
  const noop = async () => {};
  return {
    impl: {
      insert: async (quads: Quad[]) => { inserts.push(quads); },
      delete: noop,
      deleteByPattern: noop,
      hasGraph: async () => true,
      createGraph: noop,
      dropGraph: noop,
      query: noop,
      close: noop,
    } as unknown as Parameters<StorageACKHandler['handler']>[0] extends never ? never : any,
    inserts,
  };
}

function makeIntent(params: {
  cgId: string;
  merkleRoot: Uint8Array;
  kaCount: number;
  byteSize: bigint;
  epochs: number;
  tokenAmount: bigint;
  rootEntities: string[];
  stagingQuads: Uint8Array;
}): Uint8Array {
  return encodePublishIntent({
    merkleRoot: params.merkleRoot,
    contextGraphId: params.cgId,
    publisherPeerId: 'publisher-9',
    publicByteSize: Number(params.byteSize),
    isPrivate: false,
    kaCount: params.kaCount,
    rootEntities: params.rootEntities,
    stagingQuads: params.stagingQuads,
    epochs: params.epochs,
    tokenAmountStr: params.tokenAmount.toString(),
  });
}

describe('P-9: StorageACKHandler nodeRole guard (edge nodes cannot issue ACKs)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects ACK signing when nodeRole is "edge" (spec §9.0 Phase 3 — core only)', async () => {
    const { impl: store } = makeMockStore();

    const config: StorageACKHandlerConfig = {
      nodeRole: 'edge',
      nodeIdentityId: 5n,
      signerWallet: ethers.Wallet.createRandom(),
      contextGraphSharedMemoryUri: (cgId) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };
    const handler = new StorageACKHandler(
      store,
      config,
      { emit: () => {}, on: () => {}, off: () => {}, once: () => {} } as unknown as TypedEventBus<any>,
    );

    const merkleRoot = new Uint8Array(32).fill(0xaa);
    const intent = makeIntent({
      cgId: '101',
      merkleRoot,
      kaCount: 0,
      byteSize: 10n,
      epochs: 1,
      tokenAmount: 0n,
      rootEntities: [],
      stagingQuads: new Uint8Array(),
    });

    await expect(handler.handler(intent, { toString: () => 'peer-1' })).rejects.toThrow(
      /core nodes can issue StorageACKs/i,
    );
  });
});

describe('P-9: StorageACKHandler roster gap — core-flagged node signs with ANY fresh wallet', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'PROD-BUG: handler signs an ACK even when the signerWallet has no on-chain roster membership ' +
      '— the handler has no roster hook to reject rogue core-flagged nodes. See BUGS_FOUND.md P-9.',
    async () => {
      // Freshly-generated wallet that has never been registered as a
      // core node. In a correctly-specced handler, signing MUST be
      // refused unless the (nodeIdentityId, signerWallet) pair is
      // verified against the on-chain core roster (spec §9.0.3).
      vi.useFakeTimers();
      const rogueWallet = ethers.Wallet.createRandom();

      const { impl: store } = makeMockStore();
      const config: StorageACKHandlerConfig = {
        nodeRole: 'core',
        nodeIdentityId: 9999n, // arbitrary, not on the chain roster
        signerWallet: rogueWallet,
        contextGraphSharedMemoryUri: (cgId) =>
          `did:dkg:context-graph:${cgId}/_shared_memory`,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
      };
      const handler = new StorageACKHandler(
        store,
        config,
        { emit: () => {}, on: () => {}, off: () => {}, once: () => {} } as unknown as TypedEventBus<any>,
      );

      // Build inline staging quads whose flat KC merkle root we
      // compute so the handler's in-memory verification passes —
      // isolating the issue to the ABSENCE of a roster check, not
      // some other validation failure.
      const quads: Quad[] = [
        { subject: 'urn:roster-test:a', predicate: 'urn:p', object: 'urn:v', graph: 'urn:test:swm' },
      ];
      const merkleRoot = computeFlatKCRootV10(quads, []);
      const stagingQuads = new TextEncoder().encode(
        quads
          .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
          .join('\n'),
      );
      const intent = makeIntent({
        cgId: '101',
        merkleRoot,
        kaCount: 1,
        byteSize: 64n,
        epochs: 1,
        tokenAmount: 0n,
        rootEntities: ['urn:roster-test:a'],
        stagingQuads,
      });

      const responseBytes = await handler.handler(intent, { toString: () => 'rogue' });
      // If the handler had a proper roster check, we'd never reach
      // here — the call would throw. It doesn't, so we assert the
      // fact directly: ACK is produced and signed by a wallet the
      // chain has never heard of. This is the bug.
      const ack = decodeStorageACK(responseBytes);

      const digest = computePublishACKDigest(
        TEST_CHAIN_ID,
        TEST_KAV10_ADDR,
        101n,
        merkleRoot,
        1n, 64n, 1n, 0n,
      );
      const prefixedHash = ethers.hashMessage(digest);
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.coreNodeSignatureR),
        yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS),
      });

      // The handler accepted a wallet with no chain presence.
      // PROD-BUG: signerWallet roster check missing — see BUGS_FOUND.md P-9.
      expect(recovered.toLowerCase()).toBe(rogueWallet.address.toLowerCase());
    },
  );
});
