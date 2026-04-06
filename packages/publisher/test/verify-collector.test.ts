import { describe, it, expect, vi } from 'vitest';
import { VerifyCollector } from '../src/verify-collector.js';
import { encodeVerifyApproval, decodeVerifyProposal } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

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
  it('collects M-of-N approvals from participants', async () => {
    const walletA = ethers.Wallet.createRandom();
    const walletB = ethers.Wallet.createRandom();
    const walletC = ethers.Wallet.createRandom();

    const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('test-root')));

    const sendP2P = vi.fn(async (_peerId: string, _protocol: string, data: Uint8Array) => {
      const proposal = decodeVerifyProposal(data);

      // Compute the same digest the contract expects
      const contextGraphIdBig = BigInt(42);
      const packed = new Uint8Array(64);
      const cgBytes = new Uint8Array(32);
      const view = new DataView(cgBytes.buffer);
      view.setBigUint64(24, contextGraphIdBig);
      packed.set(cgBytes, 0);
      packed.set(proposal.merkleRoot, 32);
      const digest = ethers.getBytes(ethers.keccak256(packed));

      // Return approval signed by the "peer's" wallet
      if (_peerId === 'peer-a') return makeApproval(proposal.proposalId, walletA, digest);
      if (_peerId === 'peer-b') return makeApproval(proposal.proposalId, walletB, digest);
      return makeApproval(proposal.proposalId, walletC, digest);
    });

    const collector = new VerifyCollector({
      sendP2P,
      getParticipantPeers: () => ['peer-a', 'peer-b', 'peer-c'],
    });

    const result = await collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiedMemoryId: 1n,
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
    expect(result.verifiedMemoryId).toBe(1n);
  });

  it('throws when not enough peers are connected', async () => {
    const collector = new VerifyCollector({
      sendP2P: async () => new Uint8Array(0),
      getParticipantPeers: () => ['peer-a'],
    });

    await expect(collector.collect({
      contextGraphId: 'test-cg',
      contextGraphIdOnChain: 42n,
      verifiedMemoryId: 1n,
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
      verifiedMemoryId: 1n,
      batchId: 100n,
      merkleRoot: new Uint8Array(32),
      entities: [],
      proposerSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      requiredSignatures: 2, // needs 1 remote, but 0 peers → error
      timeoutMs: 1000,
    })).rejects.toThrow('verify_no_peers');
  });
});
