import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  VerifyCollector,
  VERIFY_COLLECTION_TIMEOUT_MAX_MS,
} from '../src/verify-collector.js';
import { encodeVerifyApproval, decodeVerifyProposal } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function makeApproval(proposalId: Uint8Array, wallet: ethers.Wallet, digest: Uint8Array) {
  const prefixedHash = ethers.hashMessage(digest);
  const sig = wallet.signingKey.sign(prefixedHash);
  return encodeVerifyApproval({
    proposalId,
    agentSignatureR: ethers.getBytes(sig.r),
    agentSignatureVS: ethers.getBytes(sig.yParityAndS),
    approverAddress: wallet.address,
  });
}

describe('VerifyCollector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects M-of-N approvals from participants', async () => {
    const walletA = ethers.Wallet.createRandom();
    const walletB = ethers.Wallet.createRandom();
    const walletC = ethers.Wallet.createRandom();

    const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('test-root')));

    const sendP2P = async (_peerId: string, _protocol: string, data: Uint8Array) => {
      const proposal = decodeVerifyProposal(data);

      const contextGraphIdBig = BigInt(42);
      const packed = new Uint8Array(64);
      const cgBytes = new Uint8Array(32);
      const view = new DataView(cgBytes.buffer);
      view.setBigUint64(24, contextGraphIdBig);
      packed.set(cgBytes, 0);
      packed.set(proposal.merkleRoot, 32);
      const digest = ethers.getBytes(ethers.keccak256(packed));

      if (_peerId === 'peer-a') return makeApproval(proposal.proposalId, walletA, digest);
      if (_peerId === 'peer-b') return makeApproval(proposal.proposalId, walletB, digest);
      return makeApproval(proposal.proposalId, walletC, digest);
    };

    const collector = new VerifyCollector({
      sendP2P,
      getParticipantPeers: () => ['peer-a', 'peer-b', 'peer-c'],
    });

    const result = await collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot,
      entities: ['urn:entity:1'],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2,
      timeoutMs: 5000,
    });

    // requiredSignatures=2 means 1 remote needed (proposer already signed)
    expect(result.approvals).toHaveLength(1);
    expect(result.contextGraphId).toBe('test-cg');
    expect(result.verifiableMemoryId).toBe(1n);
    expect(result.requiredRemoteApprovals).toBe(1);
    expect(result.quorumReached).toBe(true);
  });

  it('throws when not enough peers are connected', async () => {
    const collector = new VerifyCollector({
      sendP2P: async () => new Uint8Array(0),
      getParticipantPeers: () => ['peer-a'],
    });

    await expect(collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 3,
      timeoutMs: 1000,
    })).rejects.toThrow('verify_insufficient_peers');
  });

  it('throws when no peers are connected', async () => {
    const collector = new VerifyCollector({
      sendP2P: async () => new Uint8Array(0),
      getParticipantPeers: () => [],
    });

    await expect(collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2, // needs 1 remote, but 0 peers → error
      timeoutMs: 1000,
    })).rejects.toThrow('verify_no_peers');
  });

  it('returns no-quorum metadata instead of throwing when partial collection is allowed and no peers are connected', async () => {
    const collector = new VerifyCollector({
      sendP2P: async () => new Uint8Array(0),
      getParticipantPeers: () => [],
    });

    const result = await collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2,
      timeoutMs: 1000,
      allowPartial: true,
    });

    expect(result.approvals).toEqual([]);
    expect(result.requiredRemoteApprovals).toBe(1);
    expect(result.quorumReached).toBe(false);
  });

  it('rejects oversized timeout values before sending proposals', async () => {
    const sendP2P = recorder(async () => new Uint8Array(0));
    const collector = new VerifyCollector({
      sendP2P,
      getParticipantPeers: () => ['peer-a'],
    });

    await expect(collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2,
      timeoutMs: VERIFY_COLLECTION_TIMEOUT_MAX_MS + 1,
    })).rejects.toThrow(/verify_timeout_invalid/);

    expect(sendP2P.calls).toEqual([]);
  });

  it('clears the timeout timer after quorum resolves', async () => {
    vi.useFakeTimers();
    const walletA = ethers.Wallet.createRandom();
    const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('timer-root')));
    const sendP2P = async (_peerId: string, _protocol: string, data: Uint8Array) => {
      const proposal = decodeVerifyProposal(data);
      const contextGraphIdBig = BigInt(42);
      const packed = new Uint8Array(64);
      const cgBytes = new Uint8Array(32);
      const view = new DataView(cgBytes.buffer);
      view.setBigUint64(24, contextGraphIdBig);
      packed.set(cgBytes, 0);
      packed.set(proposal.merkleRoot, 32);
      const digest = ethers.getBytes(ethers.keccak256(packed));
      return makeApproval(proposal.proposalId, walletA, digest);
    };
    const collector = new VerifyCollector({
      sendP2P,
      getParticipantPeers: () => ['peer-a'],
    });

    await collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot,
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2,
      timeoutMs: 5000,
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  // Codex PR #595 round-4: a caller that omits `requiredSignatures` MUST
  // get the system minimum, never a silent default of 1. `chain.verify()`
  // does not revalidate signatures on-chain, so this local count is the
  // only enforcement gate — defaulting to 1 would let the proposer
  // self-approve and pass quorum on a single signature.
  describe('fail-closed when requiredSignatures is omitted', () => {
    const baseCollectArgs = {
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      timeoutMs: 1000,
    } as const;

    it('throws when no `getMinimumRequiredSignatures` probe is wired', async () => {
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => ['peer-a'],
        // no getMinimumRequiredSignatures
      });
      await expect(collector.collect(baseCollectArgs)).rejects.toThrow(
        /requiredSignatures was omitted and no `getMinimumRequiredSignatures` probe/,
      );
    });

    it('throws when the probe rejects (RPC outage)', async () => {
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => ['peer-a'],
        getMinimumRequiredSignatures: async () => { throw new Error('RPC down'); },
      });
      await expect(collector.collect(baseCollectArgs)).rejects.toThrow(
        /getMinimumRequiredSignatures\(\) failed.*RPC down/,
      );
    });

    it('throws when the probe returns garbage (non-positive integer)', async () => {
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => ['peer-a'],
        getMinimumRequiredSignatures: async () => 0,
      });
      await expect(collector.collect(baseCollectArgs)).rejects.toThrow(
        /returned invalid value 0/,
      );
    });

    it('honours the system minimum when the probe is wired correctly', async () => {
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => [],
        getMinimumRequiredSignatures: async () => 3,
      });
      // remoteRequired = 3 - 1 = 2 > 0 peers → verify_no_peers (proves
      // the probe value was used, not the silent fallback of 1).
      await expect(collector.collect(baseCollectArgs)).rejects.toThrow(
        /verify_no_peers/,
      );
    });
  });

  // Codex PR #595 round-5: when the proposer is dropped from the
  // resolved-signatures set (edge node with identityId=0, or signer
  // not in the sharding table), the collector must demand the FULL
  // `requiredSignatures` from remote peers instead of
  // `requiredSignatures - 1`. The default behaviour
  // (proposerCountsTowardQuorum=true) preserves the legacy "proposer
  // self-counts" math; the fix is opt-in via the new flag.
  describe('proposerCountsTowardQuorum=false (edge / non-member proposers)', () => {
    const baseCollectArgs = {
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      timeoutMs: 1000,
    } as const;

    it('requires full quorum from remote peers when proposer cannot self-count (system minimum=1)', async () => {
      // System min = 1. Default math (proposerCountsTowardQuorum=true)
      // would return quorumReached=true with 0 remote ACKs. With the
      // proposer flagged ineligible, the collector must ask for 1
      // remote ACK and fail no-peer when none are connected.
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => [],
      });
      await expect(collector.collect({
        ...baseCollectArgs,
        requiredSignatures: 1,
        proposerCountsTowardQuorum: false,
      })).rejects.toThrow(/verify_no_peers/);
    });

    it('requires 2 remote ACKs when proposer cannot self-count and system minimum=2', async () => {
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => ['peer-a'],
      });
      await expect(collector.collect({
        ...baseCollectArgs,
        requiredSignatures: 2,
        proposerCountsTowardQuorum: false,
        allowPartial: false,
      })).rejects.toThrow(/verify_insufficient_peers: need 2 remote approvals/);
    });

    it('returns self-sign-style early-return only when proposer counts AND requiredSignatures=1', async () => {
      const collector = new VerifyCollector({
        sendP2P: async () => new Uint8Array(0),
        getParticipantPeers: () => [],
      });
      const result = await collector.collect({
        ...baseCollectArgs,
        requiredSignatures: 1,
        proposerCountsTowardQuorum: true,
      });
      expect(result.quorumReached).toBe(true);
      expect(result.requiredRemoteApprovals).toBe(0);
    });
  });

  // Codex PR #595 round-5: verify-proposal payloads include
  // contextGraphId, verifiableMemoryId, batchId, and root entities — for
  // curated CGs that's CG-visible metadata. The collector must accept
  // an async `getParticipantPeers` so the caller can await an
  // enumerator that returns only CG-member peers.
  it('awaits a Promise-returning getParticipantPeers', async () => {
    const peersByCg: Record<string, string[]> = { 'cg-x': [] };
    const collector = new VerifyCollector({
      sendP2P: async () => new Uint8Array(0),
      getParticipantPeers: async (cgId) => {
        await new Promise(r => setTimeout(r, 5));
        return peersByCg[cgId] ?? [];
      },
    });
    await expect(collector.collect({
      contextGraphId: 'cg-x',
      contextGraphIdOnChain: 42n,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2,
      timeoutMs: 1000,
    })).rejects.toThrow(/verify_no_peers/);
  });
});
