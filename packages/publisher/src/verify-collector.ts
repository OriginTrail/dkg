import {
  PROTOCOL_VERIFY_PROPOSAL,
  encodeVerifyProposal,
  decodeVerifyApproval,
  computeACKDigest,
  type VerifyProposalMsg,
  type VerifyApprovalMsg,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export interface VerifyCollectorDeps {
  sendP2P: (peerId: string, protocol: string, data: Uint8Array) => Promise<Uint8Array>;
  getParticipantPeers: (contextGraphId: string) => string[];
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface CollectedApproval {
  peerId: string;
  signatureR: Uint8Array;
  signatureVS: Uint8Array;
  approverAddress: string;
  identityId: bigint;
}

export interface VerifyCollectionResult {
  approvals: CollectedApproval[];
  merkleRoot: Uint8Array;
  contextGraphId: string;
  verifiedMemoryId: bigint;
  requiredRemoteApprovals: number;
  quorumReached: boolean;
}

const MAX_RETRIES = 2;
export const VERIFY_COLLECTION_TIMEOUT_MIN_MS = 1_000;
export const VERIFY_COLLECTION_TIMEOUT_MAX_MS = 30 * 60 * 1000;
export const VERIFY_COLLECTION_TIMEOUT_DEFAULT_MS = VERIFY_COLLECTION_TIMEOUT_MAX_MS;

export function assertVerifyCollectionTimeoutMs(timeoutMs: number): number {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < VERIFY_COLLECTION_TIMEOUT_MIN_MS ||
    timeoutMs > VERIFY_COLLECTION_TIMEOUT_MAX_MS
  ) {
    throw new RangeError(
      `verify_timeout_invalid: timeoutMs must be an integer between ` +
        `${VERIFY_COLLECTION_TIMEOUT_MIN_MS} and ${VERIFY_COLLECTION_TIMEOUT_MAX_MS} milliseconds`,
    );
  }
  return timeoutMs;
}

/**
 * VerifyCollector implements spec §10.1: collecting M-of-N approval
 * signatures for VERIFY proposals via direct P2P streams.
 *
 * Flow:
 * 1. Send VerifyProposal to each participant peer via PROTOCOL_VERIFY_PROPOSAL
 * 2. Each participant signs keccak256(contextGraphId, merkleRoot) and returns VerifyApproval
 * 3. Collect until requiredSignatures reached or timeout
 */
export class VerifyCollector {
  private deps: VerifyCollectorDeps;

  constructor(deps: VerifyCollectorDeps) {
    this.deps = deps;
  }

  async collect(params: {
    contextGraphId: string;
    contextGraphIdOnChain: bigint;
    verifiedMemoryId: bigint;
    batchId: bigint;
    merkleRoot: Uint8Array;
    entities: string[];
    proposerSignature: { r: Uint8Array; vs: Uint8Array };
    requiredSignatures: number;
    timeoutMs: number;
    allowPartial?: boolean;
  }): Promise<VerifyCollectionResult> {
    const {
      contextGraphId, contextGraphIdOnChain, verifiedMemoryId,
      batchId, merkleRoot, entities, proposerSignature,
      requiredSignatures, timeoutMs, allowPartial = false,
    } = params;
    const boundedTimeoutMs = Math.min(
      assertVerifyCollectionTimeoutMs(timeoutMs),
      VERIFY_COLLECTION_TIMEOUT_MAX_MS,
    );

    const log = this.deps.log ?? (() => {});

    const proposalId = crypto.getRandomValues(new Uint8Array(16));
    const expiresAt = new Date(Date.now() + boundedTimeoutMs).toISOString();

    // Use { low, high, unsigned } Long objects for uint64 fields to avoid
    // precision loss above 2^53 - 1 (protobufjs uint64 representation).
    const toLong = (n: bigint) => ({ low: Number(n & 0xFFFFFFFFn), high: Number((n >> 32n) & 0xFFFFFFFFn), unsigned: true });
    const proposal: VerifyProposalMsg = {
      proposalId,
      verifiedMemoryId: toLong(verifiedMemoryId),
      batchId: toLong(batchId),
      merkleRoot,
      entities,
      agentSignatureR: proposerSignature.r,
      agentSignatureVS: proposerSignature.vs,
      expiresAt,
      contextGraphId,
    };
    const proposalBytes = encodeVerifyProposal(proposal);

    // The proposer already signed before calling collect(), so we need
    // (requiredSignatures - 1) additional remote approvals.
    const remoteRequired = Math.max(0, requiredSignatures - 1);

    const peers = this.deps.getParticipantPeers(contextGraphId);
    if (remoteRequired > 0 && peers.length === 0) {
      if (allowPartial) {
        return {
          approvals: [],
          merkleRoot,
          contextGraphId,
          verifiedMemoryId,
          requiredRemoteApprovals: remoteRequired,
          quorumReached: false,
        };
      }
      throw new Error('verify_no_peers: no participant peers connected');
    }
    if (peers.length < remoteRequired && !allowPartial) {
      throw new Error(
        `verify_insufficient_peers: need ${remoteRequired} remote approvals but only ${peers.length} participants connected`,
      );
    }

    // Self-sign only (1-of-1): return immediately, no remote collection needed
    if (remoteRequired === 0) {
      log(`[VerifyCollector] Self-sign mode (1-of-1) — no remote approvals needed`);
      return {
        approvals: [],
        merkleRoot,
        contextGraphId,
        verifiedMemoryId,
        requiredRemoteApprovals: 0,
        quorumReached: true,
      };
    }

    log(`[VerifyCollector] Requesting approvals from ${peers.length} participants (need ${remoteRequired} remote, ${requiredSignatures} total)`);

    // Digest for signature verification: keccak256(contextGraphId, merkleRoot)
    const digest = computeACKDigest(contextGraphIdOnChain, merkleRoot);

    const collected: CollectedApproval[] = [];
    const seenAddresses = new Set<string>();

    const requestApproval = async (peerId: string): Promise<CollectedApproval | null> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await this.deps.sendP2P(peerId, PROTOCOL_VERIFY_PROPOSAL, proposalBytes);
          const approval: VerifyApprovalMsg = decodeVerifyApproval(response);

          const recovered = this.recoverSigner(approval, digest);
          if (!recovered) {
            log(`[VerifyCollector] Invalid signature from ${peerId.slice(-8)}`);
            return null;
          }

          log(`[VerifyCollector] Valid approval from ${peerId.slice(-8)} (address=${recovered.slice(0, 10)}...)`);

          return {
            peerId,
            signatureR: approval.agentSignatureR,
            signatureVS: approval.agentSignatureVS,
            approverAddress: recovered,
            identityId: 0n, // resolved during on-chain submission
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_RETRIES) {
            log(`[VerifyCollector] Retry ${attempt + 1} for ${peerId.slice(-8)}: ${msg}`);
            await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
          } else {
            log(`[VerifyCollector] Failed from ${peerId.slice(-8)} after ${MAX_RETRIES + 1} attempts: ${msg}`);
          }
        }
      }
      return null;
    };

    let quorumResolve: (() => void) | undefined;
    const quorumPromise = new Promise<void>(resolve => { quorumResolve = resolve; });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const promises = peers.map(async (peerId) => {
            if (collected.length >= remoteRequired) return;
            const approval = await requestApproval(peerId);
            if (approval && !seenAddresses.has(approval.approverAddress)) {
              seenAddresses.add(approval.approverAddress);
              collected.push(approval);
              if (collected.length >= remoteRequired) {
                quorumResolve?.();
              }
            }
          });
          await Promise.race([Promise.allSettled(promises), quorumPromise]);
        })(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`verify_timeout: ${collected.length}/${remoteRequired} remote approvals within ${boundedTimeoutMs}ms`)),
            boundedTimeoutMs,
          );
        }),
      ]);
    } catch (err) {
      if (!allowPartial) throw err;
      log(`[VerifyCollector] Partial verify collection: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }

    if (collected.length < remoteRequired && !allowPartial) {
      throw new Error(
        `verify_insufficient: got ${collected.length}/${remoteRequired} valid remote approvals from ${peers.length} participants`,
      );
    }

    const quorumReached = collected.length >= remoteRequired;
    log(
      quorumReached
        ? `[VerifyCollector] Collected ${collected.length} approvals — quorum reached`
        : `[VerifyCollector] Collected ${collected.length}/${remoteRequired} approvals — quorum not reached`,
    );
    return {
      approvals: collected.slice(0, remoteRequired),
      merkleRoot,
      contextGraphId,
      verifiedMemoryId,
      requiredRemoteApprovals: remoteRequired,
      quorumReached,
    };
  }

  private recoverSigner(approval: VerifyApprovalMsg, digest: Uint8Array): string | null {
    try {
      const r = ethers.hexlify(approval.agentSignatureR);
      const vs = ethers.hexlify(approval.agentSignatureVS);
      const prefixedHash = ethers.hashMessage(digest);
      return ethers.recoverAddress(prefixedHash, { r, yParityAndS: vs }) || null;
    } catch {
      return null;
    }
  }
}
