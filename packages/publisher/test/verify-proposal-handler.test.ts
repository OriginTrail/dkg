import { describe, it, expect, vi } from 'vitest';
import { VerifyProposalHandler, type VerifyProposalHandlerDeps } from '../src/verify-proposal-handler.js';
import {
  encodeVerifyProposal,
  decodeVerifyApproval,
  computeACKDigest,
  computeVerifyApprovalDigest,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const wallet = ethers.Wallet.createRandom();
const merkleRoot = new Uint8Array(32).fill(0xab);
const domain = { chainId: 84532n, contractAddress: '0x00000000000000000000000000000000000000a1' };

function makeDeps(overrides?: Partial<VerifyProposalHandlerDeps>): VerifyProposalHandlerDeps {
  return {
    store: {} as any,
    agentPrivateKey: wallet.privateKey,
    agentAddress: wallet.address,
    getBatchMerkleRoot: async () => merkleRoot,
    getContextGraphIdOnChain: async () => 42n,
    getSigningDomain: async () => domain,
    ...overrides,
  };
}

function makeProposalBytes(overrides?: Record<string, unknown>): Uint8Array {
  return encodeVerifyProposal({
    proposalId: crypto.getRandomValues(new Uint8Array(16)),
    contextGraphId: 'test-cg',
    batchId: 1,
    merkleRoot,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

const peerId = { toString: () => '12D3KooWTest' };

describe('VerifyProposalHandler', () => {
  it('returns a signed approval for a valid proposal', async () => {
    const deps = makeDeps();
    const handler = new VerifyProposalHandler(deps);

    const data = makeProposalBytes();
    const response = await handler.handler(data, peerId);

    const approval = decodeVerifyApproval(response);
    expect(approval.approverAddress).toBe(deps.agentAddress);
    expect(approval.agentSignatureR.length).toBe(32);
    expect(approval.agentSignatureVS.length).toBe(32);
  });

  it('rejects expired proposals', async () => {
    const handler = new VerifyProposalHandler(makeDeps());

    const data = makeProposalBytes({
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await expect(handler.handler(data, peerId)).rejects.toThrow('proposal_expired');
  });

  it('rejects when batch not found locally', async () => {
    const handler = new VerifyProposalHandler(makeDeps({
      getBatchMerkleRoot: async () => null,
    }));

    await expect(handler.handler(makeProposalBytes(), peerId)).rejects.toThrow('batch_not_found');
  });

  it('rejects when merkle root mismatches', async () => {
    const handler = new VerifyProposalHandler(makeDeps({
      getBatchMerkleRoot: async () => new Uint8Array(32).fill(0xff),
    }));

    await expect(handler.handler(makeProposalBytes(), peerId)).rejects.toThrow('merkle_root_mismatch');
  });

  it('rejects when context graph not found on-chain', async () => {
    const handler = new VerifyProposalHandler(makeDeps({
      getContextGraphIdOnChain: async () => null,
    }));

    await expect(handler.handler(makeProposalBytes(), peerId)).rejects.toThrow('context_graph_not_found');
  });

  it('rejects invalid (malformed) proposal data', async () => {
    const handler = new VerifyProposalHandler(makeDeps());
    const garbage = new Uint8Array([0xff, 0x00, 0x01]);

    await expect(handler.handler(garbage, peerId)).rejects.toThrow('invalid_proposal');
  });

  it.each([
    ['empty', ''],
    ['with a space', 'test cg'],
    ['with angle brackets', 'test-cg>'],
    ['with braces', 'test-cg{x}'],
    ['with a dot-dot segment', 'test/../cg'],
    ['longer than 256 characters', 'c'.repeat(257)],
  ])('refuses a proposal whose context graph id is %s, before any lookup', async (_name, contextGraphId) => {
    const getBatchMerkleRoot = vi.fn(async () => merkleRoot);
    const getContextGraphIdOnChain = vi.fn(async () => 42n);
    const handler = new VerifyProposalHandler(makeDeps({ getBatchMerkleRoot, getContextGraphIdOnChain }));

    await expect(handler.handler(makeProposalBytes({ contextGraphId }), peerId))
      .rejects.toThrow('invalid_proposal: invalid context graph id');
    expect(getBatchMerkleRoot).not.toHaveBeenCalled();
    expect(getContextGraphIdOnChain).not.toHaveBeenCalled();
  });

  it('signs the approval digest bound to the chain, the deployment, the context graph and the batch', async () => {
    const handler = new VerifyProposalHandler(makeDeps());
    const approval = decodeVerifyApproval(await handler.handler(makeProposalBytes({ batchId: 7 }), peerId));
    const signature = ethers.Signature.from({
      r: ethers.hexlify(approval.agentSignatureR),
      yParityAndS: ethers.hexlify(approval.agentSignatureVS),
    });
    const signerOver = (digest: Uint8Array) => ethers.verifyMessage(digest, signature);

    expect(signerOver(computeVerifyApprovalDigest(domain.chainId, domain.contractAddress, 42n, 7n, merkleRoot)))
      .toBe(wallet.address);
    // Not a signature over the unbound two-field digest, nor over another batch, chain or deployment.
    expect(signerOver(computeACKDigest(42n, merkleRoot))).not.toBe(wallet.address);
    expect(signerOver(computeVerifyApprovalDigest(domain.chainId, domain.contractAddress, 42n, 8n, merkleRoot)))
      .not.toBe(wallet.address);
    expect(signerOver(computeVerifyApprovalDigest(1n, domain.contractAddress, 42n, 7n, merkleRoot)))
      .not.toBe(wallet.address);
    expect(signerOver(computeVerifyApprovalDigest(domain.chainId, '0x00000000000000000000000000000000000000a2', 42n, 7n, merkleRoot)))
      .not.toBe(wallet.address);
  });
});
