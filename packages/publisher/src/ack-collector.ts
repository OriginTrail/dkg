import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK,
  encodePublishIntent,
  encodeUpdateIntent,
  decodeStorageACK,
  computePublishACKDigest,
  computeUpdateACKDigest,
  isStorageACKDecline,
  isTransientStorageACKDeclineCode,
  boundedDeclineCodeLabel,
  isSubscriptionSource,
  withSpan,
  getMetrics,
  type PublishIntentMsg,
  type UpdateIntentMsg,
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
  /**
   * The DIAL pool: the peers the collector snapshots and dials for ACKs. The
   * daemon may PAD this with non-core peers when confirmed cores are below
   * quorum (best-effort dial to avoid `pool_below_quorum`), so its length is
   * NOT a reliable "quorum is reachable" signal — see {@link getReadinessCorePeers}.
   */
  getConnectedCorePeers: () => string[];
  /**
   * The READINESS predicate: how many QUORUM-ELIGIBLE confirmed core peers are
   * connected right now (NO padding with edge/non-core peers). The readiness
   * wait polls THIS — not {@link getConnectedCorePeers} — so a padded dial pool
   * (e.g. 2 cores + 1 edge on a 3-signature chain) can no longer disarm the
   * wait and let the round fast-fail before a slow-to-identify 3rd core shows
   * up. Optional: defaults to {@link getConnectedCorePeers} for back-compat, so
   * callers that don't distinguish the two keep the legacy behaviour.
   */
  getReadinessCorePeers?: () => string[];
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
  /**
   * Backoff sleep between transport-error retries and transient
   * SWM-decline retries (#887). Injectable so unit tests can exercise
   * the multi-retry budget without waiting real seconds. Defaults to a
   * real `setTimeout` delay.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * When > 0, the collector polls {@link getConnectedCorePeers} for up to this
   * many ms before its one-shot quorum snapshot, so a publish that fires while
   * the last core peer(s) are still connecting/identifying doesn't throw
   * `quorum impossible` a moment too early (the dominant intermittent-publish
   * failure on small/NAT'd chains like Base). Omitted / 0 disables the wait,
   * keeping the legacy fail-fast one-shot behaviour — unit tests rely on this;
   * the production node wiring passes
   * {@link DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS}.
   */
  corePeerReadinessTimeoutMs?: number;
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

/**
 * Default ACK quorum when the chain's `minimumRequiredSignatures()` is
 * unavailable. Exported so peer-pool providers (see
 * `DKGAgent.getACKCandidatePeers`) can size their candidate pools to the
 * same floor instead of hardcoding a drifting copy of this number.
 */
export const DEFAULT_REQUIRED_ACKS = 3;
const ACK_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
// #887: transient declines (the core's SWM replica is still catching up
// via gossip — NO_DATA_IN_SWM / MERKLE_MISMATCH_IN_SWM /
// MISSING_CIPHERTEXT_CHUNKS) get their own, larger retry budget than
// transport errors. For a freshly-created CG the publisher's ACK round
// routinely races the very first SWM gossip push to the newly-assigned
// core peers, and propagation can take well over the ~3s the old shared
// 3-attempt / 1s+2s budget allowed — so a core that would have ACKed a
// few seconds later was permanently dropped and the publish failed with
// `storage_ack_insufficient`. The capped-exponential schedule below
// spans ~31s across 6 retries, comfortably under `ACK_TIMEOUT_MS`, and
// keeps quorum reachable once the data lands. Transport errors keep the
// unchanged `MAX_RETRIES` budget (a peer that never answers shouldn't
// hold the round open for 30s).
const MAX_TRANSIENT_DECLINE_RETRIES = 6;
const TRANSIENT_DECLINE_BACKOFF_CAP_MS = 8_000;
function transientDeclineBackoffMs(retry: number): number {
  return Math.min(1000 * 2 ** Math.max(0, retry - 1), TRANSIENT_DECLINE_BACKOFF_CAP_MS);
}
// Pre-collection peer-readiness gate. `knownCorePeerIds` (the set behind
// `getConnectedCorePeers`) is populated ASYNCHRONOUSLY — a core peer is only
// counted once libp2p identify completes and the `peer:update` reclassifier
// runs (dkg-agent-lifecycle `handlePeerUpdateForSyncRetry`, #1093), and
// warm-core redials settle over time. So the old one-shot snapshot taken the
// instant a publish starts routinely races the last core peer(s)
// connecting/identifying and threw `quorum impossible` a moment before the
// pool would have been ready — the dominant intermittent-publish failure on
// small/NAT'd chains like Base. When enabled (see `corePeerReadinessTimeoutMs`
// in the deps) we poll up to that bound before snapshotting; the round still
// fails closed with the TRUE count if quorum never forms, so no genuinely-
// under-quorum publish is masked, and the happy path (already at quorum) adds
// zero latency. The gate is OFF by default (timeout 0) so unit tests keep
// their fast one-shot semantics; the production node wiring opts in with
// {@link DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS}.
export const DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS = 15_000;
const PEER_READINESS_POLL_MS = 500;
const MAX_DECLINE_CODE_CHARS = 64;
const MAX_DECLINE_MESSAGE_CHARS = 240;

/**
 * Map a terminal {@link QuorumUnmetError} to the low-cardinality
 * `ackQuorumTotal` outcome label. The collector encodes the failure kind
 * only in the embedded `legacyMessage` prefix (no structured `kind`
 * field): `storage_ack_timeout*` ⇒ the round ran out of time, every other
 * quorum-fail throw (`no connected core peers`, `quorum impossible`,
 * `storage_ack_insufficient`) ⇒ quorum was/became impossible.
 */
export function quorumOutcomeFromError(err: QuorumUnmetError): 'timeout' | 'impossible' {
  const msg = err.legacyMessage ?? err.message ?? '';
  // Classify on the structured PREFIX only. The message tail can embed
  // sanitized peer-supplied decline text (`…Declines: ab12→NO_DATA_IN_SWM`),
  // so a substring match on the whole string would let a peer that writes
  // "storage_ack_timeout" into its decline message flip an insufficient/
  // impossible quorum to 'timeout'. Only the timeout throw STARTS with the prefix.
  return msg.startsWith('storage_ack_timeout') ? 'timeout' : 'impossible';
}

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

  /**
   * Wait (bounded by {@link PEER_READINESS_TIMEOUT_MS}) until at least
   * `required` connected core peers are visible, then return the snapshot.
   * Returns immediately when the pool is already at/above quorum, so the happy
   * path adds zero latency. If the deadline passes still short, returns the
   * final (insufficient) snapshot — the caller then throws `quorum impossible`
   * with the TRUE count, identical to the old one-shot behaviour minus the
   * early-race false negatives.
   */
  private async getQuorumEligibleCorePeersOrThrow(
    required: number,
    log: (msg: string) => void,
  ): Promise<string[]> {
    // Readiness is decided by QUORUM-ELIGIBLE CONFIRMED cores only — never the
    // padded dial pool. `getConnectedCorePeers` may be padded with non-core
    // peers when confirmed cores are below quorum (best-effort dial), so polling
    // it for readiness would let a single connected edge peer disarm the wait
    // and fast-fail before a slow 3rd core identifies. Fall back to it only when
    // no distinct readiness probe is wired (legacy callers / unit tests). The
    // whole readiness poll is gated on the timeout being enabled, so the legacy
    // one-shot path takes EXACTLY the single dial snapshot below (no extra read).
    const timeoutMs = this.deps.corePeerReadinessTimeoutMs ?? 0;
    if (timeoutMs > 0) {
      const readinessProbe = this.deps.getReadinessCorePeers ?? this.deps.getConnectedCorePeers;
      let readyCount = readinessProbe().length;
      if (readyCount < required) {
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        log(
          `[ACKCollector] ${readyCount}/${required} core peers connected — waiting up to ` +
          `${timeoutMs}ms for quorum-eligible peers to connect/identify`,
        );
        // Bound the wait by the SAME poll interval handed to `sleep` (elapsed =
        // sum of PEER_READINESS_POLL_MS steps) rather than a `Date.now()` deadline,
        // so a test that injects a fast/no-op `sleep` fully controls how many polls
        // run — no wall-clock dependency, no tight-loop footgun.
        for (let waited = 0; waited < timeoutMs; waited += PEER_READINESS_POLL_MS) {
          await sleep(PEER_READINESS_POLL_MS);
          readyCount = readinessProbe().length;
          if (readyCount >= required) {
            log(`[ACKCollector] core-peer quorum ready: ${readyCount}/${required} connected`);
            break;
          }
        }
      }
    }
    // Snapshot the DIAL pool (which may be padded) AFTER the readiness gate, so
    // we still dial the broader pool when confirmed cores never reach quorum
    // (unchanged `pool_below_quorum` fallback) but only after the wait has had
    // its chance to let a real core identify.
    const peers = this.deps.getConnectedCorePeers();
    // Own the full pre-collection quorum invariant in one place: below-quorum is
    // a THROW here, not a normal return value each caller re-checks. Preserve the
    // exact legacy messages + peerOutcome shapes so log greps + tests keep matching.
    if (peers.length === 0) {
      throw new QuorumUnmetError({
        collected: 0,
        required,
        dialled: 0,
        peerOutcomes: [],
        legacyMessage: 'ACK collection failed: no connected core peers',
      });
    }
    if (peers.length < required) {
      throw new QuorumUnmetError({
        collected: 0,
        required,
        dialled: peers.length,
        peerOutcomes: peers.map((peerId) => ({ peerId, reason: 'pool_below_quorum' })),
        legacyMessage:
          `ACK collection failed: need ${required} ACKs but only ${peers.length} core peers connected — quorum impossible`,
      });
    }
    return peers;
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
    /**
     * OT-RFC-49 / WS-D — the curated PUBLIC `_catalog` commitment (REPLACED
     * the stripped ciphertext-chunks commitment). When present,
     * `isEncryptedPayload` MUST be `true` and `stagingQuads` carries the
     * catalog N-quads (plaintext, public). The collector packs
     * `(catalogRoot, catalogLeafCount)` into the PublishIntent + the ACK
     * digest; cores rebuild the same root over the inline catalog and DECLINE
     * `CATALOG_ROOT_MISMATCH` on disagreement.
     */
    catalogCommitment?: {
      catalogRoot: Uint8Array;
      catalogLeafCount: number;
    };
  }): Promise<ACKCollectionResult> {
    const {
      merkleRoot, contextGraphId, contextGraphIdStr,
      publisherPeerId, publicByteSize, isPrivate,
      kaCount, rootEntities, chainId, kav10Address,
    } = params;
    const REQUIRED_ACKS = params.requiredACKs ?? DEFAULT_REQUIRED_ACKS;
    const chainIdLabel = chainId != null ? chainId.toString() : undefined;

    return withSpan('publisher.ack_collect', async (span) => {
      span.setAttributes({
        'dkg.context_graph_id': contextGraphIdStr,
        'dkg.required_acks': REQUIRED_ACKS,
      });
      try {
        const result = await this.collectInner({
          merkleRoot, contextGraphId, contextGraphIdStr,
          publisherPeerId, publicByteSize, isPrivate,
          kaCount, rootEntities, chainId, kav10Address,
          REQUIRED_ACKS,
          params,
        });
        span.setAttribute('dkg.collected_acks', result.acks.length);
        getMetrics().ackQuorumTotal.add(1, {
          outcome: 'reached',
          ...(chainIdLabel ? { chain_id: chainIdLabel } : {}),
        });
        return result;
      } catch (err) {
        // QuorumUnmetError throw is auto-recorded by withSpan (ERROR status).
        // Map its failure kind to the terminal quorum metric outcome.
        if (err instanceof QuorumUnmetError) {
          getMetrics().ackQuorumTotal.add(1, {
            outcome: quorumOutcomeFromError(err),
            ...(chainIdLabel ? { chain_id: chainIdLabel } : {}),
          });
        }
        throw err;
      }
    });
  }

  /**
   * Body of {@link collect}, split out so the public method is a thin
   * `withSpan('publisher.ack_collect')` wrapper. Preserves the exact
   * control flow + error propagation of the original method body.
   */
  private async collectInner(ctx: {
    merkleRoot: Uint8Array;
    contextGraphId: bigint;
    contextGraphIdStr: string;
    publisherPeerId: string;
    publicByteSize: bigint;
    isPrivate: boolean;
    kaCount: number;
    rootEntities: string[];
    chainId: bigint;
    kav10Address: string;
    REQUIRED_ACKS: number;
    params: Parameters<ACKCollector['collect']>[0];
  }): Promise<ACKCollectionResult> {
    const {
      merkleRoot, contextGraphId, contextGraphIdStr,
      publisherPeerId, publicByteSize, isPrivate,
      kaCount, rootEntities, chainId, kav10Address,
      REQUIRED_ACKS, params,
    } = ctx;

    const log = this.deps.log ?? (() => {});
    if (!Number.isInteger(params.merkleLeafCount) || params.merkleLeafCount < 1) {
      throw new Error(
        `ACK collection failed: merkleLeafCount must be a positive integer, got ${params.merkleLeafCount}`,
      );
    }
    if (params.kaCount !== 1) {
      throw new Error(
        `ACK collection failed: V10 publish requires exactly one Knowledge Asset (kaCount=1); got ${params.kaCount}`,
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
    // OT-RFC-49 / WS-D — a curated publish carries a non-zero catalog
    // commitment AND the inline catalog N-quads (plaintext, public) so the
    // core can rebuild + verify the catalog root self-contained. Surface a
    // mis-wired branch loudly rather than ship a half-formed intent.
    if (params.catalogCommitment) {
      if (!params.isEncryptedPayload) {
        throw new Error(
          'ACKCollector: catalogCommitment requires isEncryptedPayload=true (curated-CG-only path)',
        );
      }
      if (!params.stagingQuads || params.stagingQuads.length === 0) {
        throw new Error(
          'ACKCollector: catalogCommitment requires non-empty stagingQuads — ' +
          'the curated ACK ships the public catalog N-quads inline so the core can ' +
          'rebuild and verify the catalog root',
        );
      }
      if (params.catalogCommitment.catalogLeafCount <= 0) {
        throw new Error(
          `ACKCollector: catalogCommitment.catalogLeafCount must be positive; got ${params.catalogCommitment.catalogLeafCount}`,
        );
      }
      if (params.catalogCommitment.catalogRoot.length !== 32) {
        throw new Error(
          `ACKCollector: catalogCommitment.catalogRoot must be 32 bytes; got ${params.catalogCommitment.catalogRoot.length}`,
        );
      }
    }
    // OT-RFC-49 collapsed the V2 chunked-ciphertext ACK path; the curated
    // catalog ACK rides the V1 protocol with inline catalog stagingQuads.
    const ackProtocolId = PROTOCOL_STORAGE_ACK;
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
      catalogRoot: params.catalogCommitment?.catalogRoot,
      catalogLeafCount: params.catalogCommitment?.catalogLeafCount,
    };
    const intentBytes = encodePublishIntent(p2pMsg);

    // ACK requests are sent exclusively via direct P2P — NOT via gossip.
    // Publishing on the finalization topic would conflict with existing handlers
    // that decode payloads as FinalizationMessages, causing decode errors.
    log(`[ACKCollector] Collecting ACKs via direct P2P (merkleRoot=${ethers.hexlify(merkleRoot).slice(0, 18)}...)`);

    const corePeers = await this.getQuorumEligibleCorePeersOrThrow(REQUIRED_ACKS, log);
    log(`[ACKCollector] Requesting ACKs from ${corePeers.length} core peers (need ${REQUIRED_ACKS})`);

    const catalogRoot = params.catalogCommitment?.catalogRoot
      ?? new Uint8Array(32);
    const catalogLeafCount = BigInt(params.catalogCommitment?.catalogLeafCount ?? 0);
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
      catalogRoot,
      catalogLeafCount,
      false,
    );

    return this.runACKRound({
      intentBytes,
      ackProtocolId,
      ackDigest,
      merkleRoot,
      contextGraphId,
      corePeers,
      requiredACKs: REQUIRED_ACKS,
      log,
    });
  }

  /**
   * V10 UPDATE counterpart to {@link collect}. Mirrors it exactly — only
   * the digest (`computeUpdateACKDigest`, 13 fields), the request proto
   * (`UpdateIntent` over {@link PROTOCOL_STORAGE_UPDATE_ACK}), and the
   * field set differ. Dials connected core peers, sends an
   * `UpdateIntent`, recovers the signer against the UPDATE ACK digest,
   * validates `ack.merkleRoot == newMerkleRoot`, dedups, and races the
   * `requiredACKs(minSig)` quorum — all via the shared {@link runACKRound}.
   *
   * The caller MUST source `preUpdateMerkleRootCount` + `newTokenAmount`
   * (+ `contextGraphId`, `mintAmount`, `burnTokenIds`) from the SAME
   * place the chain adapter resolves them for the update tx, so the
   * off-chain-signed digest is byte-identical to the on-chain verify
   * (see `evm-adapter-publish.ts:getUpdateAckDigestFields`). `kaId` +
   * `preUpdateMerkleRootCount` are trusted from the params (the on-chain
   * tx reverts if wrong).
   */
  async collectUpdate(params: {
    kaId: bigint;
    /** TARGET on-chain numeric context graph id. */
    contextGraphId: bigint;
    /** Pre-update on-chain Merkle-roots array length for this KA. */
    preUpdateMerkleRootCount: bigint;
    newMerkleRoot: Uint8Array;
    newByteSize: bigint;
    /** Floored newTokenAmount the on-chain tx submits (digest re-floors identically). */
    newTokenAmount: bigint;
    mintAmount: bigint;
    burnTokenIds: bigint[];
    newMerkleLeafCount: number;
    newCatalogRoot?: Uint8Array;
    newCatalogLeafCount?: number;
    /** Numeric EVM chain id. Required by the H5 prefix in the UPDATE ACK digest. */
    chainId: bigint;
    /** Deployed `KnowledgeAssetsLifecycle` address. Required by the H5 prefix. */
    kav10Address: string;
    publisherPeerId: string;
    requiredACKs?: number;
    /** Source SWM graph id (defaults to the numeric contextGraphId). */
    swmGraphId?: string;
    subGraphName?: string;
    /** Updated KC quads (N-Quads) so peers can recompute newMerkleRoot. */
    stagingQuads?: Uint8Array;
    isEncryptedPayload?: boolean;
    ackProtocolVersion?: number;
  }): Promise<ACKCollectionResult> {
    const {
      kaId, contextGraphId, preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
      newMerkleLeafCount, chainId, kav10Address, publisherPeerId,
    } = params;
    const REQUIRED_ACKS = params.requiredACKs ?? DEFAULT_REQUIRED_ACKS;
    const log = this.deps.log ?? (() => {});

    if (newMerkleRoot.length !== 32) {
      throw new Error(
        `UPDATE ACK collection failed: newMerkleRoot must be 32 bytes, got ${newMerkleRoot.length}`,
      );
    }
    if (!Number.isInteger(newMerkleLeafCount) || newMerkleLeafCount < 1) {
      throw new Error(
        `UPDATE ACK collection failed: newMerkleLeafCount must be a positive integer, got ${newMerkleLeafCount}`,
      );
    }

    const contextGraphIdStr = contextGraphId.toString();
    const catalogRoot = params.newCatalogRoot ?? new Uint8Array(32);
    const catalogCount = BigInt(params.newCatalogLeafCount ?? 0);

    const p2pMsg: UpdateIntentMsg = {
      kaId: kaId.toString(),
      contextGraphId: contextGraphIdStr,
      preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
      newMerkleRoot,
      newByteSize: Number(newByteSize),
      newTokenAmount: newTokenAmount.toString(),
      mintAmount: Number(mintAmount),
      burnTokenIds: burnTokenIds.map((id) => id.toString()),
      newMerkleLeafCount,
      newCatalogRoot: params.newCatalogRoot,
      newCatalogLeafCount: params.newCatalogLeafCount,
      publisherPeerId,
      swmGraphId: params.swmGraphId && params.swmGraphId !== contextGraphIdStr
        ? params.swmGraphId
        : undefined,
      subGraphName: params.subGraphName,
      stagingQuads: params.stagingQuads,
      isEncryptedPayload: params.isEncryptedPayload === true ? true : undefined,
      ackProtocolVersion: params.ackProtocolVersion,
    };
    const intentBytes = encodeUpdateIntent(p2pMsg);

    log(`[ACKCollector] Collecting UPDATE ACKs via direct P2P (kaId=${kaId}, newMerkleRoot=${ethers.hexlify(newMerkleRoot).slice(0, 18)}...)`);

    const corePeers = await this.getQuorumEligibleCorePeersOrThrow(REQUIRED_ACKS, log);
    log(`[ACKCollector] Requesting UPDATE ACKs from ${corePeers.length} core peers (need ${REQUIRED_ACKS})`);

    // 13-field UPDATE ACK digest — byte-identical to what the peer signs
    // and to `KnowledgeAssetsLifecycle._executeUpdateCore`. The token
    // amount is floored INSIDE `computeUpdateACKDigest`, matching the
    // on-chain submission.
    const ackDigest = computeUpdateACKDigest(
      chainId,
      kav10Address,
      contextGraphId,
      kaId,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      BigInt(newMerkleLeafCount),
      catalogRoot,
      catalogCount,
    );

    return this.runACKRound({
      intentBytes,
      ackProtocolId: PROTOCOL_STORAGE_UPDATE_ACK,
      ackDigest,
      merkleRoot: newMerkleRoot,
      contextGraphId,
      corePeers,
      requiredACKs: REQUIRED_ACKS,
      log,
    });
  }

  /**
   * Shared quorum round used by both {@link collect} (PUBLISH) and
   * {@link collectUpdate} (UPDATE). Given pre-encoded intent bytes, the
   * ACK protocol id, and the precomputed ACK digest the peers are
   * expected to have signed, this dials every connected core peer,
   * recovers + validates each `StorageACK`, dedups by peer + identity,
   * enforces the `requiredACKs` quorum race, and surfaces the typed
   * `QuorumUnmetError` paths (impossible-pool / timeout / insufficient).
   *
   * Identical logic for publish and update — only the request bytes,
   * protocol id, and digest differ, which is why both flows funnel
   * through here so the consensus-critical quorum semantics never drift.
   */
  private async runACKRound(args: {
    intentBytes: Uint8Array;
    ackProtocolId: string;
    ackDigest: Uint8Array;
    merkleRoot: Uint8Array;
    contextGraphId: bigint;
    corePeers: string[];
    requiredACKs: number;
    log: (msg: string) => void;
  }): Promise<ACKCollectionResult> {
    const {
      intentBytes, ackProtocolId, ackDigest,
      merkleRoot, contextGraphId, corePeers, log,
    } = args;
    const REQUIRED_ACKS = args.requiredACKs;

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
    // additive on the wire. ALSO carries the synthetic `TRANSPORT_ERROR`
    // terminal outcome for peers whose final send attempt threw, so a
    // peer that never answered surfaces WITH its transport error string
    // instead of a bare `no_response` (testnet dead-air incident).
    const declines = new Map<string, { code: string; message: string }>();
    // ACKs that arrived over the protocol but failed publisher-side validation
    // are not "no response". Track them separately so QuorumUnmetError can
    // distinguish transport silence from an ACK the publisher rejected locally
    // (signature, merkle root, or chain/RPC identity verification).
    const ackFailures = new Map<string, { reason: string }>();
    const recordACKFailure = (peerId: string, reason: string): void => {
      ackFailures.set(peerId, { reason });
      // A later terminal ACK-validation failure is more actionable than an
      // earlier transient decline from the same peer.
      declines.delete(peerId);
    };

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
        const ackFailure = ackFailures.get(peerId);
        if (ackFailure) {
          return {
            peerId,
            dialOk: true,
            protocolSupported: true,
            reason: ackFailure.reason,
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

    // PR #896 review (🟡): once the round is decided — quorum reached, timed
    // out, or proven impossible — any `requestACK` loop still sleeping
    // between retries must bail on wake instead of continuing to dial. With
    // the widened #887 transient-decline budget (~31s) a losing peer could
    // otherwise keep retrying long after `collect()` already resolved,
    // emitting avoidable ACK traffic and log noise. `roundSettled` is set
    // when the outer race settles; `roundIsOver()` also treats a satisfied
    // quorum as terminal so a peer mid-backoff bails the instant the last
    // needed ACK lands elsewhere.
    let roundSettled = false;
    const roundIsOver = () => roundSettled || collected.length >= REQUIRED_ACKS;

    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

    const requestACK = async (peerId: string): Promise<CollectedACK | null> => {
      // #887: transient SWM declines and transport errors now have
      // independent retry budgets. A core whose SWM is still catching up
      // (transient decline) is given the larger `MAX_TRANSIENT_DECLINE_
      // RETRIES` budget below; a core that simply won't answer keeps the
      // unchanged transport `MAX_RETRIES` budget. Mixing them in one
      // counter (the pre-#887 behaviour) let a couple of transport blips
      // burn the whole budget a slow-gossip core needed to ACK.
      let transportAttempts = 0;
      let declineRetries = 0;
      for (;;) {
        try {
          // publisher.ack_peer_request — one per-peer sendP2P attempt.
          // Transport throw → withSpan auto-records ERROR; the catch below
          // tags ackPeerTotal{result:'transport_error'}. A decline response
          // is an expected negative (status stays OK, dkg.decline_code set).
          const ack: StorageACKMsg = await withSpan(
            'publisher.ack_peer_request',
            async (span) => {
              const response = await this.deps.sendP2P(peerId, ackProtocolId, intentBytes);
              const decoded: StorageACKMsg = decodeStorageACK(response);
              if (isStorageACKDecline(decoded)) {
                const declineCode = sanitizeDeclineField(
                  decoded.declineCode ?? 'UNKNOWN',
                  MAX_DECLINE_CODE_CHARS,
                ) || 'UNKNOWN';
                span.setAttribute('dkg.decline_code', declineCode);
                getMetrics().ackPeerTotal.add(1, {
                  result: 'decline',
                  // `declineCode` is peer-supplied and untrusted — bound it to the
                  // known enum so a peer can't explode metric cardinality with
                  // unique codes. Full code stays on the span + declines map.
                  decline_code: boundedDeclineCodeLabel(declineCode),
                });
              }
              // A non-decline response is NOT counted as a successful ACK here:
              // it is still unverified. The terminal ackPeerTotal{result:'ack'}
              // is recorded only after signature/merkle/identity validation
              // passes below; failed validation is counted {result:'rejected'}.
              return decoded;
            },
            {
              attributes: {
                'dkg.protocol_id': ackProtocolId,
                'dkg.peer': peerId.slice(0, 8),
              },
            },
          );

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
            ackFailures.delete(peerId);

            // Transient declines (SWM replication catching up via
            // gossip) can resolve on a retry, so re-send with backoff
            // instead of permanently deselecting the peer. Codex review
            // on PR #559 flagged the "every decline is permanent" path
            // as a regression: a core that would have ACKed seconds
            // later was being removed from the quorum pool the moment
            // its SWM trailed the publish by even one gossip cycle.
            // #887 widened this further — the old budget shared with
            // transport retries gave only ~3s, which a fresh CG's first
            // gossip push to its assigned cores routinely overran.
            if (isTransientStorageACKDeclineCode(code) && declineRetries < MAX_TRANSIENT_DECLINE_RETRIES) {
              if (roundIsOver()) {
                log(
                  `[ACKCollector] Quorum already settled — abandoning transient-decline ` +
                  `retry for ${peerId.slice(-8)} (${code})`,
                );
                return null;
              }
              declineRetries += 1;
              const waitMs = transientDeclineBackoffMs(declineRetries);
              log(
                `[ACKCollector] Transient decline from ${peerId.slice(-8)}: ${code}` +
                (declineMessage ? ` — ${declineMessage}` : '') +
                ` (retry ${declineRetries}/${MAX_TRANSIENT_DECLINE_RETRIES}, waiting ${waitMs}ms for SWM gossip)`,
              );
              await sleep(waitMs);
              // #896 review: quorum may have settled DURING the backoff above
              // (collect() resolves the instant the last needed ACK lands on
              // another peer). Re-check before re-dialing so a decided round
              // never leaks one more `sendP2P` after the caller moved on.
              if (roundIsOver()) {
                log(
                  `[ACKCollector] Quorum settled during backoff — abandoning ` +
                  `transient-decline retry for ${peerId.slice(-8)} (${code})`,
                );
                return null;
              }
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
            recordACKFailure(peerId, 'INVALID_SIGNATURE');
            getMetrics().ackPeerTotal.add(1, { result: 'rejected' });
            log(`[ACKCollector] Invalid ACK signature from ${peerId.slice(-8)}`);
            return null;
          }

          if (!this.merkleRootsMatch(ack.merkleRoot, merkleRoot)) {
            recordACKFailure(peerId, 'MERKLE_ROOT_MISMATCH');
            getMetrics().ackPeerTotal.add(1, { result: 'rejected' });
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
            const verdict = await withSpan(
              'publisher.ack_verify_identity',
              async (span) => {
                const v = await this.deps.verifyIdentityDetailed!(recoveredAddress, identityId);
                // A rejected identity is an expected negative, not a span
                // error (status stays OK). withSpan only flips ERROR on throw.
                span.setAttribute('dkg.verify_result', v.valid ? 'valid' : (v.reason ?? 'unknown'));
                getMetrics().ackVerifyTotal.add(1, {
                  result: v.valid ? 'valid' : (v.reason ?? 'key-not-registered'),
                });
                return v;
              },
              { attributes: { 'dkg.identity_id': String(identityId) } },
            );
            if (!verdict.valid) {
              const reason = sanitizeDeclineField(verdict.reason ?? 'unknown', MAX_DECLINE_CODE_CHARS) || 'unknown';
              recordACKFailure(peerId, `ACK_VERIFY:${reason}`);
              getMetrics().ackPeerTotal.add(1, { result: 'rejected' });
              log(
                `[ACKCollector] ACK from ${peerId.slice(-8)} rejected: ${reason}` +
                ` (signer=${recoveredAddress.slice(0, 10)}..., identity=${identityId})`,
              );
              return null;
            }
          } else if (this.deps.verifyIdentity) {
            const valid = await withSpan(
              'publisher.ack_verify_identity',
              async (span) => {
                const ok = await this.deps.verifyIdentity!(recoveredAddress, identityId);
                // Legacy boolean verifier surfaces no structured reason; an
                // invalid result maps to the generic registration gate.
                span.setAttribute('dkg.verify_result', ok ? 'valid' : 'key-not-registered');
                getMetrics().ackVerifyTotal.add(1, {
                  result: ok ? 'valid' : 'key-not-registered',
                });
                return ok;
              },
              { attributes: { 'dkg.identity_id': String(identityId) } },
            );
            if (!valid) {
              recordACKFailure(peerId, 'ACK_VERIFY:key-not-registered');
              getMetrics().ackPeerTotal.add(1, { result: 'rejected' });
              log(`[ACKCollector] Signer ${recoveredAddress.slice(0, 10)}... not registered for identity ${identityId} — rejecting ACK from ${peerId.slice(-8)}`);
              return null;
            }
          }

          // Clear any prior transient-decline record now that this peer
          // has produced a valid ACK on a later retry — otherwise the
          // stale decline would still appear in `storage_ack_insufficient`
          // if quorum fails for unrelated reasons.
          declines.delete(peerId);
          ackFailures.delete(peerId);

          // PR5: capture the peer-reported ACK-provenance source if
          // present. Pre-PR5 cores never set the field; treat any
          // unknown / off-enum value as `undefined` (strict additive
          // wire — only documented enum members are honoured).
          const subscriptionSource = isSubscriptionSource(ack.subscriptionSource)
            ? ack.subscriptionSource
            : undefined;

          const sourceTag = subscriptionSource ? ` source=${subscriptionSource}` : '';
          log(`[ACKCollector] Valid ACK from ${peerId.slice(-8)} (identity=${identityId}, signer=${recoveredAddress.slice(0, 10)}...${sourceTag})`);

          // Terminal: a fully-validated ACK (signature + merkle + identity all
          // passed). Counted here, not at decode time, so the 'ack' result
          // reflects accepted ACKs only.
          getMetrics().ackPeerTotal.add(1, { result: 'ack' });

          return {
            peerId,
            signatureR: ack.coreNodeSignatureR,
            signatureVS: ack.coreNodeSignatureVS,
            nodeIdentityId: identityId,
            ...(subscriptionSource ? { subscriptionSource } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          transportAttempts += 1;
          getMetrics().ackPeerTotal.add(1, { result: 'transport_error' });
          if (transportAttempts < MAX_RETRIES) {
            if (roundIsOver()) {
              log(
                `[ACKCollector] Quorum already settled — abandoning transport retry ` +
                `for ${peerId.slice(-8)}: ${msg}`,
              );
              return null;
            }
            log(`[ACKCollector] Retry ${transportAttempts}/${MAX_RETRIES} for ${peerId.slice(-8)}: ${msg}`);
            await sleep(transportAttempts * 1000);
            // #896 review: re-check after the backoff too — quorum may have
            // settled while we waited, so don't re-dial a decided round.
            if (roundIsOver()) {
              log(
                `[ACKCollector] Quorum settled during backoff — abandoning ` +
                `transport retry for ${peerId.slice(-8)}: ${msg}`,
              );
              return null;
            }
            continue;
          }
          // Terminal transport failure on the final attempt. ALWAYS record
          // it — not only when this peer transient-declined earlier. The old
          // `declines.has(peerId)` gate (a remnant of the PR #559 "stale
          // decline shadows the real failure" overwrite) meant a peer that
          // never got a single byte back surfaced as a bare `no_response`
          // in `snapshotPeerOutcomes` + the final error, with the real
          // transport error string erased (testnet dead-air incident:
          // 7 cores dialled × 3 attempts, ALL `no_response`, 0 declines —
          // zero diagnostic signal for the operator). Recording the
          // sanitized, bounded message here makes the terminal cause ride
          // `QuorumUnmetError.peerOutcomes` (reason `TRANSPORT_ERROR`) and
          // the `Declines:` detail on the aggregated message.
          declines.set(peerId, {
            code: 'TRANSPORT_ERROR',
            message: sanitizeDeclineField(msg, MAX_DECLINE_MESSAGE_CHARS),
          });
          log(`[ACKCollector] Failed to get ACK from ${peerId.slice(-8)} after ${MAX_RETRIES} attempts: ${msg}`);
          return null;
        }
      }
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

    try {
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
                  // Eagerly mark the round settled so any peers still mid-
                  // backoff bail before their next dial (see `roundIsOver`).
                  roundSettled = true;
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
    } finally {
      // The round is decided (quorum, timeout, or impossible-quorum). Signal
      // any `requestACK` loops still sleeping between retries to abandon on
      // wake rather than keep dialing after the caller has its answer.
      roundSettled = true;
    }

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

/**
 * The SINGLE production construction boundary for ACK collection. It always
 * enables the core-peer readiness gate ({@link DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS})
 * so a publish that fires while the last core peer is still connecting/identifying
 * doesn't fail `quorum impossible` a moment too early — the dominant intermittent-
 * publish failure on small/NAT'd chains like Base.
 *
 * Every production caller — the daemon publish + update ACK providers
 * (`dkg-agent.ts`) and the CLI publisher runner (`publisher-runner.ts`) — routes
 * through here instead of hand-copying `corePeerReadinessTimeoutMs` into a bare
 * `new ACKCollector(...)`, so the readiness opt-in cannot be silently forgotten
 * when a new production call site is added (a bare constructor would compile but
 * silently revert to the legacy one-shot snapshot). The deps type OMITS
 * `corePeerReadinessTimeoutMs` precisely so callers can't accidentally under- or
 * mis-configure it. Unit tests that want the legacy fail-fast one-shot construct
 * {@link ACKCollector} directly with `corePeerReadinessTimeoutMs: 0` (or omitted).
 */
export function createProductionACKCollector(
  deps: Omit<ACKCollectorDeps, 'corePeerReadinessTimeoutMs'>,
): ACKCollector {
  return new ACKCollector({
    ...deps,
    corePeerReadinessTimeoutMs: DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS,
  });
}
