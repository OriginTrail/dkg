import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  ACK_PROTOCOL_VERSION_V1_LU5,
  ACK_PROTOCOL_VERSION_V2_LU11,
  encodePublishIntent,
  decodeStorageACK,
  computePublishACKDigest,
  isStorageACKDecline,
  isTransientStorageACKDeclineCode,
  isSubscriptionSource,
  type PublishIntentMsg,
  type StorageACKMsg,
  type SubscriptionSource,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { QuorumUnmetError, type PeerOutcome } from './ack-errors.js';

/**
 * Why an ACK signer pre-flight rejected a recovered signer. Mirrors
 * `VerifyACKIdentityReason` from `@origintrail-official/dkg-chain`.
 * Kept as a string union here to avoid a hard cross-package type dep
 * — adapters wire concrete reasons through; legacy `boolean` callers
 * still work and surface `undefined`.
 */
export type ACKVerifyReason = 'key-not-registered' | 'not-in-sharding-table' | 'rpc-error';

export interface ACKVerifyResult {
  valid: boolean;
  reason?: ACKVerifyReason;
}

export interface ACKCollectorDeps {
  gossipPublish: (topic: string, data: Uint8Array) => Promise<void>;
  sendP2P: (peerId: string, protocol: string, data: Uint8Array) => Promise<Uint8Array>;
  getConnectedCorePeers: () => string[];
  /**
   * Boolean ACK signer pre-flight. Backward-compatible legacy entry
   * point — when only this is provided the rejection log surfaces a
   * generic "ACK rejected" line without a reason. New code should
   * prefer `verifyIdentityDetailed`.
   */
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  /**
   * Structured ACK signer pre-flight. When provided, the collector
   * uses this in preference to `verifyIdentity` and surfaces the
   * specific failing gate (`key-not-registered`, `not-in-sharding-
   * table`, `rpc-error`) in the rejection log so operators can act on
   * the actual root cause instead of guessing.
   */
  verifyIdentityDetailed?: (
    recoveredAddress: string,
    claimedIdentityId: bigint,
  ) => Promise<ACKVerifyResult>;
  log?: (msg: string) => void;
}

export interface CollectedACK {
  peerId: string;
  signatureR: Uint8Array;
  signatureVS: Uint8Array;
  nodeIdentityId: bigint;
  /**
   * PR5 ACK-provenance: which of the four LU-6 Phase B discovery
   * paths the responding core reported caused it to be hosting the
   * curated CG at ACK time. `undefined` for legacy / pre-PR5 peers
   * (the wire field is optional). Surfaced through the publisher's
   * per-publish ACK-provenance summary line on success and through
   * `QuorumUnmetError.peerOutcomes` on failure.
   */
  subscriptionSource?: SubscriptionSource;
}

export interface ACKCollectionResult {
  acks: CollectedACK[];
  merkleRoot: Uint8Array;
  contextGraphId: bigint;
}

const DEFAULT_REQUIRED_ACKS = 3;
const ACK_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const MAX_DECLINE_CODE_CHARS = 64;
const MAX_DECLINE_MESSAGE_CHARS = 240;

function sanitizeDeclineField(value: string, maxChars: number): string {
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * ACKCollector implements V10 spec §9.0 Phase 3: collecting 3 core node
 * StorageACKs via direct P2P before the chain TX.
 *
 * Flow:
 * 1. Broadcast PublishIntent via GossipSub (finalization topic)
 * 2. Concurrently dial each known core node on PROTOCOL_STORAGE_ACK
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
    /** V10 flat-KC Merkle leaf count (sorted + deduped); binds StorageACK to on-chain RandomSampling. */
    merkleLeafCount: number;
    /**
     * OT-RFC-38 / LU-5. When `true`, `stagingQuads` is opaque AEAD ciphertext
     * (curated-CG payload). Cores skip N-Quad parsing and merkle-root
     * recompute; verify only that `stagingQuads.length === publicByteSize`.
     * Defaults to `false` so the existing public-CG inline-quads path is
     * unchanged.
     */
    isEncryptedPayload?: boolean;
    /**
     * OT-RFC-38 LU-11 / OT-RFC-39. When set, the publisher has fanned
     * per-chunk ciphertexts via SWM gossip (one envelope per chunk,
     * carrying `swmMessageIndex` + the chunked type marker) and the
     * ACK request goes out on `PROTOCOL_STORAGE_ACK_V2` with empty
     * `stagingQuads` + populated `ciphertextChunksRoot` /
     * `ciphertextChunkCount` / `ackProtocolVersion = 2`. Required
     * when `isEncryptedPayload === true` AND chunked emission was
     * used; mutually exclusive with non-empty `stagingQuads`.
     *
     * **Cluster-wide V2 requirement** (Codex review on PR #715): this
     * collector unconditionally dispatches chunked ACK requests over
     * `PROTOCOL_STORAGE_ACK_V2` — there is NO automatic V1 fallback
     * for cores in the quorum target that don't advertise V2. A core
     * that only speaks `/dkg/10.0.1/storage-ack` will surface a
     * libp2p "could not negotiate" send error here, which counts as a
     * peer-unreachable failure against `requiredACKs`. The
     * mixed-rc.11-rc.12 cluster case is therefore strictly an
     * upgrade-window concern (a rc.11 core can't decode LU-11
     * chunked gossip envelopes either, so it would fail upstream of
     * this collector even with a V1 fallback). The operational
     * assumption for rc.12 — and the rc.12 release runbook — is that
     * every quorum-target core has been upgraded to LU-11 BEFORE the
     * curator's first chunked publish. The OT-RFC-38 §A.1 host-mode
     * reconciler converges the cluster within the per-CG window the
     * curator sets; operators must respect that window before
     * issuing curated publishes. A per-peer capability probe + V1
     * downgrade is filed as a follow-up — see TODO(rc.12.1) below.
     */
    chunkedCommitment?: {
      ciphertextChunksRoot: Uint8Array;
      ciphertextChunkCount: number;
    };
  }): Promise<ACKCollectionResult> {
    const {
      merkleRoot, contextGraphId, contextGraphIdStr,
      publisherPeerId, publicByteSize, isPrivate,
      kaCount, rootEntities, chainId, kav10Address,
    } = params;
    const REQUIRED_ACKS = params.requiredACKs ?? DEFAULT_REQUIRED_ACKS;

    const log = this.deps.log ?? (() => {});
    if (!Number.isInteger(params.merkleLeafCount) || params.merkleLeafCount < 1) {
      throw new Error(
        `ACK collection failed: merkleLeafCount must be a positive integer, got ${params.merkleLeafCount}`,
      );
    }

    // P2P intent includes staging quads so core nodes can verify inline.
    // Encrypted inline payloads are gated by this collector's exclusive
    // use of PROTOCOL_STORAGE_ACK (`/dkg/10.0.1/storage-ack`): pre-LU-5
    // cores that only speak `/dkg/10.0.0/storage-ack` never receive field
    // 14 ciphertext and therefore cannot misparse it as plaintext.
    // `contextGraphId` on the wire is the TARGET numeric id peers will sign
    // the ACK against. `swmGraphId` (optional) is the SOURCE graph where
    // data lives in SWM — only set when the publisher is remapping a named
    // SWM graph to a numeric on-chain id.
    // OT-RFC-38 LU-11: chunked path requires V2 ACK protocol id and
    // empty `stagingQuads` (chunks live on SWM, not on the ACK wire).
    // Anything else is a programmer error in the publisher's branch
    // selection — surface it loudly instead of silently shipping a
    // V1 envelope that pre-LU-11 cores would still accept.
    if (params.chunkedCommitment) {
      if (!params.isEncryptedPayload) {
        throw new Error(
          'ACKCollector: chunkedCommitment requires isEncryptedPayload=true (curated-CG-only path)',
        );
      }
      if (params.stagingQuads && params.stagingQuads.length > 0) {
        throw new Error(
          'ACKCollector: chunkedCommitment + non-empty stagingQuads is invalid — ' +
          'on the LU-11 chunked path the ciphertext lives in SWM, not on the ACK wire',
        );
      }
      if (params.chunkedCommitment.ciphertextChunkCount <= 0) {
        throw new Error(
          `ACKCollector: chunkedCommitment.ciphertextChunkCount must be positive; got ${params.chunkedCommitment.ciphertextChunkCount}`,
        );
      }
      if (params.chunkedCommitment.ciphertextChunksRoot.length !== 32) {
        throw new Error(
          `ACKCollector: chunkedCommitment.ciphertextChunksRoot must be 32 bytes; got ${params.chunkedCommitment.ciphertextChunksRoot.length}`,
        );
      }
    }
    const ackProtocolVersion = params.chunkedCommitment
      ? ACK_PROTOCOL_VERSION_V2_LU11
      : ACK_PROTOCOL_VERSION_V1_LU5;
    // TODO(rc.12.1, Codex review on PR #715): add per-peer capability
    // probe so chunked publishes can opportunistically downgrade to V1
    // for cores that don't advertise V2. Until then, chunked publishes
    // require every quorum-target core to support V2 — see the
    // `chunkedCommitment` field doc for the cluster-wide requirement
    // and the rc.12 release-runbook rationale.
    const ackProtocolId = params.chunkedCommitment
      ? PROTOCOL_STORAGE_ACK_V2
      : PROTOCOL_STORAGE_ACK;
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
      merkleLeafCount: params.merkleLeafCount,
      isEncryptedPayload: params.isEncryptedPayload === true ? true : undefined,
      ciphertextChunksRoot: params.chunkedCommitment?.ciphertextChunksRoot,
      ciphertextChunkCount: params.chunkedCommitment?.ciphertextChunkCount,
      ackProtocolVersion: params.chunkedCommitment ? ackProtocolVersion : undefined,
    };
    const intentBytes = encodePublishIntent(p2pMsg);

    // ACK requests are sent exclusively via direct P2P — NOT via gossip.
    // Publishing on the finalization topic would conflict with existing handlers
    // that decode payloads as FinalizationMessages, causing decode errors.
    log(`[ACKCollector] Collecting ACKs via direct P2P (merkleRoot=${ethers.hexlify(merkleRoot).slice(0, 18)}...)`);

    const corePeers = this.deps.getConnectedCorePeers();
    if (corePeers.length === 0) {
      // Pre-dial impossibility — wrap in the typed surface but preserve
      // the legacy `ACK collection failed: no connected core peers` text
      // so log greps + existing tests keep matching.
      throw new QuorumUnmetError({
        collected: 0,
        required: REQUIRED_ACKS,
        dialled: 0,
        peerOutcomes: [],
        legacyMessage: 'ACK collection failed: no connected core peers',
      });
    }
    if (corePeers.length < REQUIRED_ACKS) {
      throw new QuorumUnmetError({
        collected: 0,
        required: REQUIRED_ACKS,
        dialled: corePeers.length,
        peerOutcomes: corePeers.map((peerId) => ({ peerId, reason: 'pool_below_quorum' })),
        legacyMessage:
          `ACK collection failed: need ${REQUIRED_ACKS} ACKs but only ${corePeers.length} core peers connected — quorum impossible`,
      });
    }
    log(`[ACKCollector] Requesting ACKs from ${corePeers.length} core peers (need ${REQUIRED_ACKS})`);

    const ciphertextRoot = params.chunkedCommitment?.ciphertextChunksRoot
      ?? new Uint8Array(32);
    const ciphertextCount = BigInt(params.chunkedCommitment?.ciphertextChunkCount ?? 0);
    const ackDigest = computePublishACKDigest(
      chainId,
      kav10Address,
      contextGraphId,
      merkleRoot,
      BigInt(kaCount),
      publicByteSize,
      BigInt(params.epochs ?? 1),
      params.tokenAmount ?? 0n,
      BigInt(params.merkleLeafCount),
      ciphertextRoot,
      ciphertextCount,
      false,
    );

    const collected: CollectedACK[] = [];
    const seenPeers = new Set<string>();
    const seenIdentityIds = new Set<bigint>();
    // Per-peer typed declines from core nodes that ran the StorageACK
    // handler against the request and decided they cannot sign. The
    // publisher records the reason, skips retries against the declining
    // peer, and surfaces all collected reasons in the final
    // `storage_ack_insufficient` message when quorum can't be reached.
    // Cores that pre-date the typed wire shape continue to throw / reset
    // and follow the legacy retry path below — declines are strictly
    // additive on the wire.
    const declines = new Map<string, { code: string; message: string }>();

    const formatDeclineDetail = (): string => {
      if (declines.size === 0) return '';
      const formatted = [...declines.entries()]
        .map(([peer, { code, message }]) => {
          const tag = `${peer.slice(-8)}→${code}`;
          return message ? `${tag} (${message})` : tag;
        })
        .join('; ');
      return ` Declines: ${formatted}.`;
    };

    // Build the per-peer outcome list `QuorumUnmetError` carries
    // through to PR5 telemetry. Snapshots the collector's bookkeeping at
    // throw time so the surface stays consistent regardless of which of
    // the three quorum-fail throw sites fires (impossible-pool, timeout,
    // insufficient).
    //
    // The `reason` field carries only the typed code (e.g.
    // `STORAGE_ACK_DECLINE:NO_DATA_IN_SWM`) — NOT the peer-controlled
    // human message. The legacy `Declines:` substring on the embedded
    // `legacyMessage` already carries the operator-readable detail in
    // its existing sanitized form, and the test
    // `sanitizes and truncates peer-controlled decline messages` pins
    // a per-error length bound that double-rendering would blow past.
    const snapshotPeerOutcomes = (): PeerOutcome[] => {
      const ackedById = new Map(collected.map(a => [a.peerId, a] as const));
      return corePeers.map((peerId): PeerOutcome => {
        const ack = ackedById.get(peerId);
        if (ack) {
          // PR5: an ACK from a peer with `source=member` or any of
          // the four host-mode sources is, by construction, advertising
          // host-mode (or the stronger "I'm a member, decrypt+apply
          // handler is authoritative") for this CG. Peers that ACKed
          // without a source field are pre-PR5; we leave
          // `swmHostModeAdvertised` undefined rather than asserting
          // either way.
          const advertised = ack.subscriptionSource !== undefined ? true : undefined;
          return {
            peerId,
            dialOk: true,
            protocolSupported: true,
            ...(advertised !== undefined ? { swmHostModeAdvertised: advertised } : {}),
            reason: ack.subscriptionSource ? `ACK:${ack.subscriptionSource}` : 'ACK',
          };
        }
        const decline = declines.get(peerId);
        if (decline) {
          const code = decline.code;
          const reason = code === 'TRANSPORT_ERROR'
            ? 'TRANSPORT_ERROR'
            : `STORAGE_ACK_DECLINE:${code}`;
          return {
            peerId,
            dialOk: code !== 'TRANSPORT_ERROR',
            protocolSupported: code !== 'TRANSPORT_ERROR' ? true : undefined,
            reason,
          };
        }
        return { peerId, reason: 'no_response' };
      });
    };

    const requestACK = async (peerId: string): Promise<CollectedACK | null> => {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const response = await this.deps.sendP2P(peerId, ackProtocolId, intentBytes);
          const ack: StorageACKMsg = decodeStorageACK(response);

          if (isStorageACKDecline(ack)) {
            const code = sanitizeDeclineField(
              ack.declineCode ?? 'UNKNOWN',
              MAX_DECLINE_CODE_CHARS,
            ) || 'UNKNOWN';
            const declineMessage = sanitizeDeclineField(
              ack.declineMessage ?? '',
              MAX_DECLINE_MESSAGE_CHARS,
            );
            // Record the latest decline reason so it surfaces in the
            // final `storage_ack_insufficient` error. Overwriting any
            // prior entry is intentional — operators care most about
            // why the peer ultimately could not ACK.
            declines.set(peerId, { code, message: declineMessage });

            // Transient declines (SWM replication catching up via
            // gossip) can resolve on a retry, so re-send through the
            // same backoff as transport errors instead of permanently
            // deselecting the peer. Codex review on PR #559 flagged
            // the "every decline is permanent" path as a regression:
            // a core that would have ACKed seconds later was being
            // removed from the quorum pool the moment its SWM trailed
            // the publish by even one gossip cycle.
            if (isTransientStorageACKDeclineCode(code) && attempt < MAX_RETRIES - 1) {
              log(
                `[ACKCollector] Transient decline from ${peerId.slice(-8)}: ${code}` +
                (declineMessage ? ` — ${declineMessage}` : '') +
                ` (retry ${attempt + 1}/${MAX_RETRIES})`,
              );
              await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
              continue;
            }

            log(
              `[ACKCollector] Decline from ${peerId.slice(-8)}: ${code}` +
              (declineMessage ? ` — ${declineMessage}` : ''),
            );
            return null;
          }

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

          // Prefer the detailed verifier — surfaces the specific failing
          // gate in the rejection log so operators can tell apart "this
          // signer is genuinely not registered" (operator-side) from
          // "the node is registered but has not crossed minimumStake"
          // (operator-side, different action) from "we couldn't reach
          // the chain to check" (infra-side, retryable). Pre-PR every
          // failure surfaced as the same "not registered" string.
          if (this.deps.verifyIdentityDetailed) {
            const verdict = await this.deps.verifyIdentityDetailed(recoveredAddress, identityId);
            if (!verdict.valid) {
              const reason = verdict.reason ?? 'unknown';
              log(
                `[ACKCollector] ACK from ${peerId.slice(-8)} rejected: ${reason}` +
                ` (signer=${recoveredAddress.slice(0, 10)}..., identity=${identityId})`,
              );
              return null;
            }
          } else if (this.deps.verifyIdentity) {
            const valid = await this.deps.verifyIdentity(recoveredAddress, identityId);
            if (!valid) {
              log(`[ACKCollector] Signer ${recoveredAddress.slice(0, 10)}... not registered for identity ${identityId} — rejecting ACK from ${peerId.slice(-8)}`);
              return null;
            }
          }

          // Clear any prior transient-decline record now that this peer
          // has produced a valid ACK on a later retry — otherwise the
          // stale decline would still appear in `storage_ack_insufficient`
          // if quorum fails for unrelated reasons.
          declines.delete(peerId);

          // PR5: capture the peer-reported ACK-provenance source if
          // present. Pre-PR5 cores never set the field; treat any
          // unknown / off-enum value as `undefined` (strict additive
          // wire — only documented enum members are honoured).
          const subscriptionSource = isSubscriptionSource(ack.subscriptionSource)
            ? ack.subscriptionSource
            : undefined;

          const sourceTag = subscriptionSource ? ` source=${subscriptionSource}` : '';
          log(`[ACKCollector] Valid ACK from ${peerId.slice(-8)} (identity=${identityId}, signer=${recoveredAddress.slice(0, 10)}...${sourceTag})`);

          return {
            peerId,
            signatureR: ack.coreNodeSignatureR,
            signatureVS: ack.coreNodeSignatureVS,
            nodeIdentityId: identityId,
            ...(subscriptionSource ? { subscriptionSource } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_RETRIES - 1) {
            log(`[ACKCollector] Retry ${attempt + 1}/${MAX_RETRIES} for ${peerId.slice(-8)}: ${msg}`);
            await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
          } else {
            // Terminal transport failure on the final attempt. If this
            // peer transient-declined on an earlier attempt the
            // `declines` map still holds that stale code — overwrite
            // it with the actual terminal reason so the aggregated
            // `storage_ack_insufficient` diagnostic reflects the last
            // observed outcome (the codex review on PR #559 caught
            // the original "stale decline shadows the real failure"
            // path here).
            if (declines.has(peerId)) {
              declines.set(peerId, {
                code: 'TRANSPORT_ERROR',
                message: sanitizeDeclineField(msg, MAX_DECLINE_MESSAGE_CHARS),
              });
            }
            log(`[ACKCollector] Failed to get ACK from ${peerId.slice(-8)} after ${MAX_RETRIES} attempts: ${msg}`);
          }
        }
      }
      return null;
    };

    let quorumResolve: (() => void) | undefined;
    const quorumPromise = new Promise<void>(resolve => { quorumResolve = resolve; });

    // Fast-fail on impossible quorum (Codex Review on PR#559): once
    // declines + max-retries-failures bring the still-pending pool too
    // low to ever reach `REQUIRED_ACKS`, surface the
    // `storage_ack_insufficient` error immediately rather than waiting
    // out the full ACK_TIMEOUT_MS for a hung peer that — by that point
    // — couldn't change the outcome anyway. The check is conservative
    // (counts a still-pending peer as a potential ACK), so we never
    // fail-fast a quorum that's still attainable.
    let peersSettled = 0;
    let impossibleReject: ((reason: Error) => void) | undefined;
    const impossiblePromise = new Promise<never>((_, reject) => { impossibleReject = reject; });

    const settlePeer = () => {
      peersSettled += 1;
      if (collected.length >= REQUIRED_ACKS) return;
      const stillPending = corePeers.length - peersSettled;
      if (collected.length + stillPending < REQUIRED_ACKS) {
        impossibleReject?.(new QuorumUnmetError({
          collected: collected.length,
          required: REQUIRED_ACKS,
          dialled: corePeers.length,
          peerOutcomes: snapshotPeerOutcomes(),
          legacyMessage:
            `storage_ack_insufficient: got ${collected.length}/${REQUIRED_ACKS} valid ACKs after ` +
            `${peersSettled}/${corePeers.length} core peer(s) settled — quorum no longer reachable.${formatDeclineDetail()}`,
        }));
      }
    };

    await Promise.race([
      (async () => {
        const promises = corePeers.map(async (peerId) => {
          if (collected.length >= REQUIRED_ACKS) {
            settlePeer();
            return;
          }
          try {
            const ack = await requestACK(peerId);
            if (ack && !seenPeers.has(ack.peerId) && !seenIdentityIds.has(ack.nodeIdentityId)) {
              seenPeers.add(ack.peerId);
              seenIdentityIds.add(ack.nodeIdentityId);
              collected.push(ack);
              if (collected.length >= REQUIRED_ACKS) {
                quorumResolve?.();
              }
            }
          } finally {
            settlePeer();
          }
        });
        await Promise.race([Promise.allSettled(promises), quorumPromise]);
      })(),
      impossiblePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new QuorumUnmetError({
          collected: collected.length,
          required: REQUIRED_ACKS,
          dialled: corePeers.length,
          peerOutcomes: snapshotPeerOutcomes(),
          legacyMessage:
            `storage_ack_timeout: only ${collected.length}/${REQUIRED_ACKS} ACKs received within ${ACK_TIMEOUT_MS}ms.${formatDeclineDetail()}`,
        })),
          ACK_TIMEOUT_MS,
        ),
      ),
    ]);

    if (collected.length < REQUIRED_ACKS) {
      throw new QuorumUnmetError({
        collected: collected.length,
        required: REQUIRED_ACKS,
        dialled: corePeers.length,
        peerOutcomes: snapshotPeerOutcomes(),
        legacyMessage:
          `storage_ack_insufficient: got ${collected.length}/${REQUIRED_ACKS} valid ACKs. ` +
          `Tried ${corePeers.length} core peers.${formatDeclineDetail()}`,
      });
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
