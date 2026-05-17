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
  /**
   * Optional hosting filter. Given the target context-graph UAL, return
   * the subset of currently-connected core peers whose published agent
   * profile (`<https://dkg.origintrail.io/skill#contextGraphsServed>`)
   * advertises hosting it.
   *
   * When provided, the collector prefers this filtered candidate set —
   * cores that don't host the CG would otherwise have to reject the
   * StorageACK request mid-stream (most often as `No data found in SWM
   * graph ...`), which the publisher sees as a libp2p stream reset and
   * has to retry/timeout against. Filtering up front avoids that cost.
   *
   * Behaviour when fewer than `requiredACKs` peers match: the collector
   * logs a warning naming the CG + which connected cores are vs. aren't
   * advertising it, and **falls back to the full connected-core set** so
   * publishes still proceed when the hosting registry is incomplete or
   * stale. This deliberately keeps the path live during discovery races,
   * but makes hosting-coverage bugs (see GitHub issue #541) visible in
   * the log instead of presenting as opaque ACK timeouts.
   */
  getCorePeersHostingContextGraph?: (cgIdStr: string) => string[] | Promise<string[]>;
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
 * Hard ceiling for the optional `getCorePeersHostingContextGraph`
 * lookup. The lookup runs against the local triple store BEFORE the
 * `ACK_TIMEOUT_MS` budget begins, so an unbounded await here can block
 * a publish indefinitely if the store is under load or the query
 * implementation hangs (Codex Review on PR#556). On timeout the
 * collector treats the lookup as "no hosting signal" — falling back to
 * the legacy single-wave behaviour against all connected cores —
 * rather than escalating into a publish failure.
 */
const HOSTING_FILTER_TIMEOUT_MS = 1_500;

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
    /** V10 flat-KC Merkle leaf count (sorted + deduped); binds StorageACK to on-chain RandomSampling. */
    merkleLeafCount: number;
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
      merkleLeafCount: params.merkleLeafCount,
    };
    const intentBytes = encodePublishIntent(p2pMsg);

    // ACK requests are sent exclusively via direct P2P — NOT via gossip.
    // Publishing on the finalization topic would conflict with existing handlers
    // that decode payloads as FinalizationMessages, causing decode errors.
    log(`[ACKCollector] Collecting ACKs via direct P2P (merkleRoot=${ethers.hexlify(merkleRoot).slice(0, 18)}...)`);

    const allConnected = this.deps.getConnectedCorePeers();
    if (allConnected.length === 0) {
      throw new Error('ACK collection failed: no connected core peers');
    }

    // Split connected cores into two waves:
    //   priorityPeers — advertise hosting the target CG; tried first.
    //   fallbackPeers — connected but don't advertise; only tried if
    //                   the priority wave can't satisfy quorum.
    //
    // Cores outside the priority set are NOT a hard gate (a stale or
    // missing advertisement on one peer in `priorityPeers` shouldn't
    // be able to fail a publish that the rest of the connected pool
    // could have satisfied — Codex Review on PR#556 flagged this).
    // Wave 2 only fires when wave 1 doesn't reach quorum, so the happy
    // path still avoids dialling cores that would just decline / reset
    // the stream (the GitHub #541 cost).
    let priorityPeers: string[] = allConnected;
    let fallbackPeers: string[] = [];
    if (this.deps.getCorePeersHostingContextGraph) {
      let hostingPeers: string[] = [];
      try {
        const lookupPromise = Promise.resolve(
          this.deps.getCorePeersHostingContextGraph(contextGraphIdStr),
        );
        // Bound the local-store lookup so a slow / hung registry query
        // can't block the publish before the ACK_TIMEOUT_MS budget even
        // begins (Codex Review on PR#556). On timeout we treat the
        // result as "no hosting signal" — i.e. fall back to the legacy
        // single-wave path against all connected cores.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutSentinel: unique symbol = Symbol('hosting-filter-timeout');
        const timeoutPromise = new Promise<typeof timeoutSentinel>(resolve => {
          timeoutHandle = setTimeout(() => resolve(timeoutSentinel), HOSTING_FILTER_TIMEOUT_MS);
        });
        const settled = await Promise.race([lookupPromise, timeoutPromise]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (settled === timeoutSentinel) {
          log(
            `[ACKCollector] hosting-filter lookup did not return within ${HOSTING_FILTER_TIMEOUT_MS}ms for "${contextGraphIdStr}"; ` +
            `dialling all ${allConnected.length} connected cores in a single wave`,
          );
          hostingPeers = [];
        } else {
          hostingPeers = settled;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(
          `[ACKCollector] hosting-filter lookup failed for "${contextGraphIdStr}" (${errMsg}); ` +
          `dialling all ${allConnected.length} connected cores in a single wave`,
        );
        hostingPeers = [];
      }
      const hostingSet = new Set(hostingPeers);
      const matched = allConnected.filter(p => hostingSet.has(p));
      const excluded = allConnected.filter(p => !hostingSet.has(p));

      if (matched.length === 0) {
        // No hosting signal at all — keep the legacy single-wave shape.
        log(
          `[ACKCollector] hosting filter: no connected cores advertise hosting "${contextGraphIdStr}"; ` +
          `dialling all ${allConnected.length} connected cores in a single wave (expect declines from non-hosting cores).`,
        );
      } else {
        priorityPeers = matched;
        fallbackPeers = excluded;
        const includedTag = matched.map(p => p.slice(-8)).join(', ');
        const excludedTag = excluded.length > 0 ? excluded.map(p => p.slice(-8)).join(', ') : '<none>';
        log(
          `[ACKCollector] hosting filter: priority wave = ${matched.length}/${allConnected.length} cores advertising "${contextGraphIdStr}" [${includedTag}]; ` +
          `fallback wave = ${excluded.length} non-advertising cores [${excludedTag}].`,
        );
        if (matched.length < REQUIRED_ACKS) {
          log(
            `[ACKCollector] WARN: only ${matched.length} connected cores advertise hosting "${contextGraphIdStr}" (need ${REQUIRED_ACKS}); ` +
            `fallback wave will be dialled if priority wave can't satisfy quorum. ` +
            `If "${contextGraphIdStr}" has replicationPolicy=full, the non-advertising cores have a coverage bug (see GitHub issue #541).`,
          );
        }
      }
    }

    if (allConnected.length < REQUIRED_ACKS) {
      throw new Error(
        `ACK collection failed: need ${REQUIRED_ACKS} ACKs but only ${allConnected.length} core peers connected — quorum impossible`,
      );
    }
    log(`[ACKCollector] Requesting ACKs from ${allConnected.length} core peers (need ${REQUIRED_ACKS}; priority=${priorityPeers.length}, fallback=${fallbackPeers.length})`);

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

    /**
     * Dial a wave of peers in parallel, accumulating their ACKs into
     * the shared `collected` slot. Stops early when the publisher has
     * `REQUIRED_ACKS` distinct (peer, identity) ACKs.
     */
    const dialWave = async (peers: string[]): Promise<void> => {
      if (peers.length === 0) return;
      const promises = peers.map(async (peerId) => {
        if (collected.length >= REQUIRED_ACKS) return;
        const ack = await requestACK(peerId);
        if (ack && !seenPeers.has(ack.peerId) && !seenIdentityIds.has(ack.nodeIdentityId)) {
          seenPeers.add(ack.peerId);
          seenIdentityIds.add(ack.nodeIdentityId);
          collected.push(ack);
          if (collected.length >= REQUIRED_ACKS) {
            quorumResolve?.();
          }
        }
      });
      await Promise.race([Promise.allSettled(promises), quorumPromise]);
    };

    let triedPeerCount = 0;
    await Promise.race([
      (async () => {
        await dialWave(priorityPeers);
        triedPeerCount = priorityPeers.length;
        if (collected.length < REQUIRED_ACKS && fallbackPeers.length > 0) {
          log(
            `[ACKCollector] Priority wave settled with ${collected.length}/${REQUIRED_ACKS} ACKs; ` +
            `dialling fallback wave (${fallbackPeers.length} non-advertising core(s))`,
          );
          await dialWave(fallbackPeers);
          triedPeerCount += fallbackPeers.length;
        }
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
        `Tried ${triedPeerCount} core peers.`,
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
