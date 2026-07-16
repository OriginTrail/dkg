import { describe, it, expect } from 'vitest';
import { VerifyProposalHandler, type VerifyProposalHandlerDeps } from '../src/verify-proposal-handler.js';
import {
  encodeVerifyProposal,
  decodeVerifyApproval,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const wallet = ethers.Wallet.createRandom();
const merkleRoot = new Uint8Array(32).fill(0xab);

function makeDeps(overrides?: Partial<VerifyProposalHandlerDeps>): VerifyProposalHandlerDeps {
  return {
    store: {} as any,
    agentPrivateKey: wallet.privateKey,
    agentAddress: wallet.address,
    getBatchMerkleRoot: async () => merkleRoot,
    getContextGraphIdOnChain: async () => 42n,
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
});
