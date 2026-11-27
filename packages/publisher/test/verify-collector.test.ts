import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  VerifyCollector,
  VERIFY_COLLECTION_TIMEOUT_MAX_MS,
} from '../src/verify-collector.js';
import { encodeVerifyApproval, decodeVerifyProposal, computeACKDigest, computeVerifyApprovalDigest } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const DOMAIN = { chainId: 84532n, contractAddress: '0x00000000000000000000000000000000000000a1' };
/** What an approver signs for batch 100 of on-chain context graph 42. */
const approvalDigest = (merkleRoot: Uint8Array) =>
  computeVerifyApprovalDigest(DOMAIN.chainId, DOMAIN.contractAddress, 42n, 100n, merkleRoot);

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
      const digest = approvalDigest(proposal.merkleRoot);

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
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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
      const digest = approvalDigest(proposal.merkleRoot);
      return makeApproval(proposal.proposalId, walletA, digest);
    };
    const collector = new VerifyCollector({
      sendP2P,
      getParticipantPeers: () => ['peer-a'],
    });

    await collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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
      signingDomain: DOMAIN,
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

describe('VerifyCollector approval digest', () => {
  const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('bound-digest-root')));

  async function approverOf(sign: (proposal: ReturnType<typeof decodeVerifyProposal>) => Uint8Array, wallet: ethers.Wallet) {
    const collector = new VerifyCollector({
      sendP2P: async (_peerId, _protocol, data) => {
        const proposal = decodeVerifyProposal(data);
        return makeApproval(proposal.proposalId, wallet, sign(proposal));
      },
      getParticipantPeers: () => ['peer-a'],
    });
    const result = await collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      signingDomain: DOMAIN,
      verifiableMemoryId: 1n,
      batchId: 100n,
      merkleRoot,
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2,
      timeoutMs: 5000,
      allowPartial: true,
    });
    return result.approvals.map((approval) => approval.approverAddress);
  }

  it('attributes an approval to its signer when it signs the digest bound to this chain, deployment and batch', async () => {
    const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    expect(await approverOf((proposal) => approvalDigest(proposal.merkleRoot), wallet)).toEqual([wallet.address]);
  });

  it.each([
    ['the unbound two-field digest', (root: Uint8Array) => computeACKDigest(42n, root)],
    ['another chain', (root: Uint8Array) => computeVerifyApprovalDigest(1n, DOMAIN.contractAddress, 42n, 100n, root)],
    ['another deployment', (root: Uint8Array) => computeVerifyApprovalDigest(DOMAIN.chainId, '0x00000000000000000000000000000000000000a2', 42n, 100n, root)],
    ['another batch', (root: Uint8Array) => computeVerifyApprovalDigest(DOMAIN.chainId, DOMAIN.contractAddress, 42n, 101n, root)],
  ])('does not count an approval signed over %s', async (_name, digestFor) => {
    const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    expect(await approverOf((proposal) => digestFor(proposal.merkleRoot), wallet)).toEqual([]);
  });
});

/**
 * An approval counts only when its approver signed this proposal's digest and, when the caller
 * says who may approve, the approver is an eligible identity not counted yet. Collection ends early
 * only on approvals that count, so a fast approval that would be dropped later cannot stop it
 * before slower eligible approvals arrive.
 */
describe('VerifyCollector counts only approvals it can attribute', () => {
  const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('attributed-root')));
  const wallets = () => Array.from({ length: 4 }, () => new ethers.Wallet(ethers.Wallet.createRandom().privateKey));

  /** Answers each peer after its delay, signed by its wallet over `digestFor` and naming `named` as approver. */
  type Answer = { wallet: ethers.Wallet; delayMs: number; digestFor?: (root: Uint8Array) => Uint8Array; named?: string };
  function collectorFor(answers: Record<string, Answer>, resolveEligibleApprover?: (address: string) => Promise<bigint | null>) {
    return new VerifyCollector({
      sendP2P: async (peerId, _protocol, data) => {
        const proposal = decodeVerifyProposal(data);
        const answer = answers[peerId]!;
        await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
        const digest = (answer.digestFor ?? approvalDigest)(proposal.merkleRoot);
        const sig = answer.wallet.signingKey.sign(ethers.hashMessage(digest));
        return encodeVerifyApproval({
          proposalId: proposal.proposalId,
          agentSignatureR: ethers.getBytes(sig.r),
          agentSignatureVS: ethers.getBytes(sig.yParityAndS),
          approverAddress: answer.named ?? answer.wallet.address,
        });
      },
      getParticipantPeers: () => Object.keys(answers),
      ...(resolveEligibleApprover ? { resolveEligibleApprover } : {}),
    });
  }
  const collect = (collector: VerifyCollector, requiredSignatures: number, allowPartial = false) => collector.collect({
    contextGraphId: 'test-cg',
    contextGraphIdOnChain: 42n,
    signingDomain: DOMAIN,
    verifiableMemoryId: 1n,
    batchId: 100n,
    merkleRoot,
    entities: [],
    proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
    requiredSignatures,
    timeoutMs: 5000,
    allowPartial,
  });

  it('keeps collecting past a faster approval in an earlier signing format', async () => {
    const [older, current] = wallets();
    const collector = collectorFor({
      'peer-older': { wallet: older!, delayMs: 0, digestFor: (root) => computeACKDigest(42n, root) },
      'peer-current': { wallet: current!, delayMs: 30 },
    });
    const result = await collect(collector, 2);
    expect(result.quorumReached).toBe(true);
    expect(result.approvals.map((approval) => approval.approverAddress)).toEqual([current!.address]);
  });

  it('does not count an approval whose signature is not by the approver it names', async () => {
    const [signer, named] = wallets();
    const result = await collect(collectorFor({ 'peer-a': { wallet: signer!, delayMs: 0, named: named!.address } }), 2, true);
    expect(result).toMatchObject({ approvals: [], quorumReached: false });
  });

  it('counts only approvers the resolver accepts, each identity once', async () => {
    const [first, sameIdentity, ineligible, second] = wallets();
    const identities = new Map<string, bigint | null>([
      [first!.address, 7n], [sameIdentity!.address, 7n], [ineligible!.address, null], [second!.address, 9n],
    ]);
    const resolved: string[] = [];
    const collector = collectorFor({
      'peer-first': { wallet: first!, delayMs: 0 },
      'peer-same-identity': { wallet: sameIdentity!, delayMs: 10 },
      'peer-ineligible': { wallet: ineligible!, delayMs: 20 },
      'peer-second': { wallet: second!, delayMs: 40 },
    }, async (address) => {
      resolved.push(address);
      return identities.get(address) ?? null;
    });
    const result = await collect(collector, 3);
    expect(result.quorumReached).toBe(true);
    expect(result.approvals.map(({ approverAddress, identityId }) => [approverAddress, identityId])).toEqual([
      [first!.address, 7n], [second!.address, 9n],
    ]);
    expect(resolved).toEqual([first!.address, sameIdentity!.address, ineligible!.address, second!.address]);
  });

  it('does not count an approver the resolver cannot check', async () => {
    const [unchecked, eligible] = wallets();
    const collector = collectorFor({
      'peer-unchecked': { wallet: unchecked!, delayMs: 0 },
      'peer-eligible': { wallet: eligible!, delayMs: 20 },
    }, async (address) => {
      if (address === unchecked!.address) throw new Error('RPC down');
      return 11n;
    });
    const result = await collect(collector, 2);
    expect(result.approvals.map(({ approverAddress, identityId }) => [approverAddress, identityId])).toEqual([[eligible!.address, 11n]]);
  });

  it('reports no quorum when no approval it receives can count', async () => {
    const [a, b] = wallets();
    const answers = { 'peer-a': { wallet: a!, delayMs: 0 }, 'peer-b': { wallet: b!, delayMs: 10 } };
    const noneEligible = async () => null;
    expect(await collect(collectorFor(answers, noneEligible), 2, true)).toMatchObject({ approvals: [], quorumReached: false });
    await expect(collect(collectorFor(answers, noneEligible), 2)).rejects.toThrow(/verify_insufficient: got 0\/1/);
  });
});
