import {
  decodeVerifyProposal,
  encodeVerifyApproval,
  computeACKDigest,
  Logger,
  createOperationContext,
  type VerifyProposalMsg,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { TripleStore } from '@origintrail-official/dkg-storage';

type StreamHandler = (data: Uint8Array, peerId: { toString(): string }) => Promise<Uint8Array>;

export interface VerifyProposalHandlerDeps {
  store: TripleStore;
  agentPrivateKey: string;
  agentAddress: string;
  getBatchMerkleRoot: (contextGraphId: string, batchId: bigint) => Promise<Uint8Array | null>;
  getContextGraphIdOnChain: (contextGraphId: string) => Promise<bigint | null>;
}

/**
 * Handles incoming VERIFY proposals from other agents.
 * When a proposal arrives, the handler:
 * 1. Validates the proposal hasn't expired
 * 2. Verifies the batch exists locally and merkle root matches
 * 3. Signs the verify digest: keccak256(contextGraphId, merkleRoot)
 * 4. Returns a VerifyApproval with the signature
 */
export class VerifyProposalHandler {
  private deps: VerifyProposalHandlerDeps;
  private log = new Logger('VerifyProposalHandler');

  constructor(deps: VerifyProposalHandlerDeps) {
    this.deps = deps;
  }

  get handler(): StreamHandler {
    return async (data: Uint8Array, peerId: { toString(): string }) => {
      return this.handleProposal(data, peerId.toString());
    };
  }

  private async handleProposal(data: Uint8Array, peerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('verify');
    let proposal: VerifyProposalMsg;

    try {
      proposal = decodeVerifyProposal(data);
    } catch (err) {
      this.log.warn(ctx, `Invalid verify proposal from ${peerId}: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error('invalid_proposal: failed to decode');
    }

    // Check expiry
    const expiresAt = new Date(proposal.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      this.log.warn(ctx, `Expired verify proposal from ${peerId} (expired ${proposal.expiresAt})`);
      throw new Error('proposal_expired');
    }

    // Verify batch exists locally and merkle root matches
    const batchId = typeof proposal.batchId === 'number'
      ? BigInt(proposal.batchId)
      : BigInt((proposal.batchId as any).low) | (BigInt((proposal.batchId as any).high) << 32n);

    const localRoot = await this.deps.getBatchMerkleRoot(proposal.contextGraphId, batchId);
    if (!localRoot) {
      this.log.warn(ctx, `Batch ${batchId} not found locally for context graph ${proposal.contextGraphId}`);
      throw new Error('batch_not_found');
    }

    if (!this.bytesEqual(localRoot, proposal.merkleRoot)) {
      this.log.warn(ctx, `Merkle root mismatch for batch ${batchId}`);
      throw new Error('merkle_root_mismatch');
    }

    // Get on-chain context graph ID for digest computation
    const contextGraphIdOnChain = await this.deps.getContextGraphIdOnChain(proposal.contextGraphId);
    if (!contextGraphIdOnChain) {
      this.log.warn(ctx, `Context graph ${proposal.contextGraphId} not found on-chain`);
      throw new Error('context_graph_not_found');
    }

    // Sign the verify digest
    const digest = computeACKDigest(contextGraphIdOnChain, proposal.merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const signingKey = new ethers.SigningKey(this.deps.agentPrivateKey);
    const sig = signingKey.sign(prefixedHash);

    this.log.info(ctx, `Approved verify proposal for batch ${batchId} in ${proposal.contextGraphId} (from ${peerId.slice(-8)})`);

    return encodeVerifyApproval({
      proposalId: proposal.proposalId,
      agentSignatureR: ethers.getBytes(sig.r),
      agentSignatureVS: ethers.getBytes(sig.yParityAndS),
      approverAddress: this.deps.agentAddress,
    });
  }

  private bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
