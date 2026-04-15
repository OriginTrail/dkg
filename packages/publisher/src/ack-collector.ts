import {
  PROTOCOL_STORAGE_ACK,
  encodePublishIntent,
  decodeStorageACK,
  computePublishACKDigest,
  type PublishIntentMsg,
  type StorageACKMsg,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export interface ACKCollectorDeps {
  gossipPublish: (topic: string, data: Uint8Array) => Promise<void>;
  sendP2P: (peerId: string, protocol: string, data: Uint8Array) => Promise<Uint8Array>;
  getConnectedCorePeers: () => string[];
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface CollectedACK {
  peerId: string;
  signatureR: Uint8Array;
  signatureVS: Uint8Array;
  nodeIdentityId: bigint;
}

export interface ACKCollectionResult {
  acks: CollectedACK[];
  merkleRoot: Uint8Array;
  contextGraphId: bigint;
}

const DEFAULT_REQUIRED_ACKS = 3;
const ACK_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

/**
 * ACKCollector implements V10 spec §9.0 Phase 3: collecting 3 core node
 * StorageACKs via direct P2P before the chain TX.
 *
 * Flow:
 * 1. Broadcast PublishIntent via GossipSub (finalization topic)
 * 2. Concurrently dial each known core node on /dkg/10.0.0/storage-ack
 * 3. First 3 valid ACKs win; verify each signature via ecrecover
 */
export class ACKCollector {
  private deps: ACKCollectorDeps;

  constructor(deps: ACKCollectorDeps) {
    this.deps = deps;
  }

  async collect(params: {
    merkleRoot: Uint8Array;
    contextGraphId: bigint;
    contextGraphIdStr: string;
    publisherPeerId: string;
    publicByteSize: bigint;
    isPrivate: boolean;
    kaCount: number;
    rootEntities: string[];
    /** Numeric EVM chain id (e.g. 31337n for hardhat). Required by the H5 prefix in the V10 ACK digest. */
    chainId: bigint;
    /** Deployed address of `KnowledgeAssetsV10`. Required by the H5 prefix in the V10 ACK digest. */
    kav10Address: string;
    requiredACKs?: number;
    stagingQuads?: Uint8Array;
    epochs?: number;
    tokenAmount?: bigint;
    /**
     * Source SWM graph id. Different from `contextGraphIdStr` only on the
     * `publishFromSharedMemory` remap flow where the data lives under one
     * graph name but is published to a different on-chain numeric id.
     * Peers use this to locate SWM data; the ACK digest still uses
     * `contextGraphId`.
     */
    swmGraphId?: string;
    /** Optional sub-graph name suffix appended to the SWM URI. */
    subGraphName?: string;
  }): Promise<ACKCollectionResult> {
    const {
      merkleRoot, contextGraphId, contextGraphIdStr,
      publisherPeerId, publicByteSize, isPrivate,
      kaCount, rootEntities, chainId, kav10Address,
    } = params;
    const REQUIRED_ACKS = params.requiredACKs ?? DEFAULT_REQUIRED_ACKS;

    const log = this.deps.log ?? (() => {});

    // P2P intent includes staging quads so core nodes can verify inline.
    // `contextGraphId` on the wire is the TARGET numeric id peers will sign
    // the ACK against. `swmGraphId` (optional) is the SOURCE graph where
    // data lives in SWM — only set when the publisher is remapping a named
    // SWM graph to a numeric on-chain id.
    const p2pMsg: PublishIntentMsg = {
      merkleRoot,
      contextGraphId: contextGraphIdStr,
      publisherPeerId,
      publicByteSize: Number(publicByteSize),
      isPrivate,
      kaCount,
      rootEntities,
      stagingQuads: params.stagingQuads,
      epochs: params.epochs ?? 1,
      tokenAmountStr: params.tokenAmount != null ? params.tokenAmount.toString() : undefined,
      swmGraphId: params.swmGraphId && params.swmGraphId !== contextGraphIdStr
        ? params.swmGraphId
        : undefined,
      subGraphName: params.subGraphName,
    };
    const intentBytes = encodePublishIntent(p2pMsg);

    // ACK requests are sent exclusively via direct P2P — NOT via gossip.
    // Publishing on the finalization topic would conflict with existing handlers
    // that decode payloads as FinalizationMessages, causing decode errors.
    log(`[ACKCollector] Collecting ACKs via direct P2P (merkleRoot=${ethers.hexlify(merkleRoot).slice(0, 18)}...)`);

    const corePeers = this.deps.getConnectedCorePeers();
    if (corePeers.length === 0) {
      throw new Error('ACK collection failed: no connected core peers');
    }
    if (corePeers.length < REQUIRED_ACKS) {
      throw new Error(
        `ACK collection failed: need ${REQUIRED_ACKS} ACKs but only ${corePeers.length} core peers connected — quorum impossible`,
      );
    }
    log(`[ACKCollector] Requesting ACKs from ${corePeers.length} core peers (need ${REQUIRED_ACKS})`);

    const ackDigest = computePublishACKDigest(
      chainId,
      kav10Address,
      contextGraphId,
      merkleRoot,
      BigInt(kaCount),
      publicByteSize,
      BigInt(params.epochs ?? 1),
      params.tokenAmount ?? 0n,
    );

    const collected: CollectedACK[] = [];
    const seenPeers = new Set<string>();
    const seenIdentityIds = new Set<bigint>();

    const requestACK = async (peerId: string): Promise<CollectedACK | null> => {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const response = await this.deps.sendP2P(peerId, PROTOCOL_STORAGE_ACK, intentBytes);
          const ack: StorageACKMsg = decodeStorageACK(response);

          const recoveredAddress = this.recoverACKSigner(ack, ackDigest);
          if (!recoveredAddress) {
            log(`[ACKCollector] Invalid ACK signature from ${peerId.slice(-8)}`);
            return null;
          }

          if (!this.merkleRootsMatch(ack.merkleRoot, merkleRoot)) {
            log(`[ACKCollector] Merkle root mismatch from ${peerId.slice(-8)}`);
            return null;
          }

          const identityId = typeof ack.nodeIdentityId === 'number'
            ? BigInt(ack.nodeIdentityId)
            : BigInt(ack.nodeIdentityId.low) | (BigInt(ack.nodeIdentityId.high) << 32n);

          if (this.deps.verifyIdentity) {
            const valid = await this.deps.verifyIdentity(recoveredAddress, identityId);
            if (!valid) {
              log(`[ACKCollector] Signer ${recoveredAddress.slice(0, 10)}... not registered for identity ${identityId} — rejecting ACK from ${peerId.slice(-8)}`);
              return null;
            }
          }

          log(`[ACKCollector] Valid ACK from ${peerId.slice(-8)} (identity=${identityId}, signer=${recoveredAddress.slice(0, 10)}...)`);

          return {
            peerId,
            signatureR: ack.coreNodeSignatureR,
            signatureVS: ack.coreNodeSignatureVS,
            nodeIdentityId: identityId,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_RETRIES - 1) {
            log(`[ACKCollector] Retry ${attempt + 1}/${MAX_RETRIES} for ${peerId.slice(-8)}: ${msg}`);
            await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
          } else {
            log(`[ACKCollector] Failed to get ACK from ${peerId.slice(-8)} after ${MAX_RETRIES} attempts: ${msg}`);
          }
        }
      }
      return null;
    };

    let quorumResolve: (() => void) | undefined;
    const quorumPromise = new Promise<void>(resolve => { quorumResolve = resolve; });

    await Promise.race([
      (async () => {
        const promises = corePeers.map(async (peerId) => {
          if (collected.length >= REQUIRED_ACKS) return;
          const ack = await requestACK(peerId);
          if (ack && !seenPeers.has(ack.peerId) && !seenIdentityIds.has(ack.nodeIdentityId)) {
            seenPeers.add(ack.peerId);
            seenIdentityIds.add(ack.nodeIdentityId);
            collected.push(ack);
            if (collected.length >= REQUIRED_ACKS) {
              quorumResolve?.();
              return;
            }
          }
        });
        await Promise.race([Promise.allSettled(promises), quorumPromise]);
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`storage_ack_timeout: only ${collected.length}/${REQUIRED_ACKS} ACKs received within ${ACK_TIMEOUT_MS}ms`)),
          ACK_TIMEOUT_MS,
        ),
      ),
    ]);

    if (collected.length < REQUIRED_ACKS) {
      throw new Error(
        `storage_ack_insufficient: got ${collected.length}/${REQUIRED_ACKS} valid ACKs. ` +
        `Tried ${corePeers.length} core peers.`,
      );
    }

    log(`[ACKCollector] Collected ${collected.length} ACKs successfully`);
    return {
      acks: collected.slice(0, REQUIRED_ACKS),
      merkleRoot,
      contextGraphId,
    };
  }

  /**
   * Recover the signer address from an ACK signature. Returns the address
   * or null if the signature is malformed. On-chain verification in
   * KnowledgeAssetsV10 binds this address to the claimed nodeIdentityId.
   */
  private recoverACKSigner(ack: StorageACKMsg, expectedDigest: Uint8Array): string | null {
    try {
      const r = ethers.hexlify(ack.coreNodeSignatureR);
      const vs = ethers.hexlify(ack.coreNodeSignatureVS);

      const prefixedHash = ethers.hashMessage(expectedDigest);
      const recovered = ethers.recoverAddress(prefixedHash, { r, yParityAndS: vs });

      return recovered || null;
    } catch {
      return null;
    }
  }

  private merkleRootsMatch(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
