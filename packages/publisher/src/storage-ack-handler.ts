import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import type { EventBus, StorageACKDeclineCode, SubscriptionSource } from '@origintrail-official/dkg-core';
import {
  decodePublishIntent,
  decodeUpdateIntent,
  encodeStorageACK,
  computePublishACKDigest,
  computeUpdateACKDigest,
  assertSafeIri,
  STORAGE_ACK_DECLINE_CODES,
  computeCatalogRoot,
  catalogCommittedLeaves,
  contextGraphCatalogUri,
  sharedMemoryReadBothFilter,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from './merkle.js';
import { parseSimpleNQuads } from './publish-handler.js';
import { ethers } from 'ethers';

type PeerId = { toString(): string };

const MAX_DECLINE_ENTITY_COUNT = 5;
const MAX_DECLINE_ENTITY_CHARS = 120;

function compactDeclineText(value: string, maxChars: number): string {
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

/** Public publishes omit the catalog root; protobuf decodes that as `bytes` length 0, not absent. */
function catalogRootForAckDigest(root: Uint8Array | undefined): Uint8Array {
  if (!root || root.length === 0) {
    return new Uint8Array(32);
  }
  if (root.length !== 32) {
    throw new Error(`catalogRoot must be 32 bytes, got ${root.length}`);
  }
  return root;
}

function summarizeDeclineEntities(entities: readonly string[]): string {
  if (entities.length === 0) return '(none)';
  const visible = entities
    .slice(0, MAX_DECLINE_ENTITY_COUNT)
    .map((entity) => compactDeclineText(entity, MAX_DECLINE_ENTITY_CHARS));
  const remaining = entities.length - visible.length;
  return remaining > 0
    ? `${visible.join(', ')} (+${remaining} more)`
    : visible.join(', ');
}

export interface StorageACKHandlerConfig {
  nodeRole: 'core' | 'edge';
  nodeIdentityId: bigint;
  signerWallet: ethers.Wallet;
  /**
   * Resolves the SWM graph URI for a given (sourceGraphId, subGraphName).
   * Accepts an optional `subGraphName` so the handler can locate data
   * stored under `.../<cgId>/<subGraphName>/_shared_memory` when the
   * publisher is writing into a sub-graph partition.
   */
  contextGraphSharedMemoryUri: (cgId: string, subGraphName?: string) => string;
  /**
   * Numeric EVM chain id (e.g. 31337n for hardhat). Part of the H5 prefix
   * on the V10 ACK digest — without this the signature will not match the
   * publisher's or the on-chain contract's expectation.
   */
  chainId: bigint;
  /**
   * Deployed address of `KnowledgeAssetsV10` on the handler's chain. Part
   * of the H5 prefix on the V10 ACK digest.
   */
  kav10Address: string;
  /**
   * Optional live confirmation hook. When provided, the handler calls it
   * immediately before signing so removed/unregistered operational keys stop
   * producing ACKs without needing a process restart.
   */
  isSignerRegistered?: () => Promise<boolean>;
  /**
   * Called when the live confirmation hook reports the signer is no longer
   * registered. Agents can use this to stop advertising StorageACK support.
   */
  onSignerUnregistered?: () => void | Promise<void>;
  /**
   * Called when the live confirmation hook itself fails. Lookup errors are
   * signing blockers because ACKs must only be produced by keys confirmed
   * registered on-chain at signing time.
   */
  onSignerRegistrationLookupFailed?: (err: unknown) => void | Promise<void>;
  /**
   * Codex PR #608: independent curation oracle. The handler MUST verify a
   * publisher's `isEncryptedPayload=true` claim against the CG's real
   * access policy before signing — without this, a malicious publisher
   * could set the encrypted bit on a PUBLIC CG and have the core sign an
   * ACK over whatever `merkleRoot`/`merkleLeafCount` it claimed
   * (cores skip plaintext verification on the encrypted path because they
   * can't decrypt). Return `true` only when the CG is curated (private /
   * invite-only / allowlisted). Return `false` for public CGs and `null`
   * for "cannot determine locally" — the handler treats both as
   * "publisher must use the non-encrypted path".
   *
   * When omitted, the handler defaults to fail-closed: encrypted-payload
   * publishes are rejected wholesale (operators wiring a core without
   * curated-CG support shouldn't be tricked into signing for them).
   *
   * Inputs:
   *   - `cgId`: numeric on-chain id used in the V10 ACK digest
   *   - `swmGraphId`: cleartext CG id (may equal `cgId`); the publisher
   *     sends this for curated publishes so the core can resolve the
   *     local access-policy record without a chain RPC.
   */
  isCgCurated?: (cgId: string, swmGraphId?: string) => Promise<boolean | null>;
  /**
   * Codex PR #608 R1 #2 — publish-finalization callback. Called immediately
   * AFTER the handler has persisted the encrypted-payload staging graph
   * and signed an ACK, with the `(stagingGraphUri, cgId, merkleRoot)`
   * triple. The agent (which owns the chain-event subscriber) is expected
   * to register the staging-graph URI against the (cgId, merkleRoot) key
   * and drop it when the V10 publish finalizes (success or permanent
   * failure).
   *
   * The handler ALSO arms a long-window safety-net timer (default 60 min)
   * as a fallback for nodes without finalization hooks wired. The
   * safety net is configurable via `encryptedStagingSafetyNetMs`; agents
   * that wire a real finalization hook can set this to `Infinity` to
   * disable the timer entirely.
   *
   * Optional: handlers without this hook continue to rely on the
   * safety-net timer (current behaviour).
   */
  onEncryptedStagingPersisted?: (info: {
    stagingGraphUri: string;
    cgId: string;
    merkleRoot: Uint8Array;
  }) => void | Promise<void>;
  /**
   * Codex PR #608 R1 #2 — safety-net cleanup window for encrypted staging
   * graphs (default 60 * 60 * 1000 = 60 min). Set to `Infinity` to disable
   * timer-based cleanup entirely when a finalization hook is wired.
   */
  encryptedStagingSafetyNetMs?: number;
  /**
   * PR5 — ACK-provenance hook. When wired, called immediately before
   * signing a StorageACK to look up which of the four LU-6 Phase B
   * discovery paths (chain-event / beacon / reconciler / manual) or
   * member-mode caused this core to be hosting the CG. The returned
   * value is populated into `StorageACKMsg.subscriptionSource` so the
   * publisher can emit a per-publish ACK-provenance summary line and
   * surface the same data through `QuorumUnmetError.peerOutcomes`
   * when ACK collection fails.
   *
   * Returning `undefined` is honest and additive — the wire field
   * stays absent and consumers render "source unknown". Callers
   * SHOULD bind this to `DKGAgent.getSwmSubscriptionSource` (which
   * accepts multiple candidate ids and is path-shape aware) rather
   * than implementing it ad-hoc. Optional: handlers that don't wire
   * this just emit ACKs without the provenance field (legacy shape).
   *
   * The candidate ids are: numeric on-chain `cgId`, cleartext
   * `swmGraphId`, and the SWM gossip topic the publisher derived
   * for the ACK request. Resolvers should try each in turn.
   */
  getSubscriptionSourceForCg?: (
    cgId: string,
    swmGraphId?: string,
    gossipTopic?: string,
  ) => SubscriptionSource | undefined;
  /**
   * Codex review on PR #715: the per-CG named graph that backs the
   * LU-11 ciphertext chunk store MUST use a CANONICAL form of the CG
   * id so that publishers (writing `envelope.contextGraphId` from
   * their gossip envelope) and cores (looking up by `swmGraphId` from
   * the V2 ACK request) land on the same graph URI. Without
   * canonicalization, the cleartext-vs-wire-hash mismatch causes
   * lookups to miss and forces a `GRAPH ?g` wildcard scan, which in
   * turn exposes the multi-CG identical-KC collision the bot called
   * out on `ciphertext-chunk-store.ts`.
   *
   * The agent wires this to `DKGAgent.canonicalChunkStoreCgIdOrNull`
   * (which routes 0x-hex, cleartext, and decimal-numeric ids through
   * the local subscription map). Returning `null` is honest:
   * "I can't safely canonicalize this id — please degrade to the
   * legacy `GRAPH ?g` wildcard scan for this lookup." Codex review
   * (round 2) on PR #727: the previous shape forced a
   * `gossipWireIdFor(cgId)` even for decimal-numeric ids, which
   * keccak'd "42" as a literal string and missed every persisted
   * chunk — required for ACK V2 robustness when
   * `PublishIntent.swmGraphId` is absent.
   *
   * Optional: handlers without this hook continue to use the raw
   * `swmGraphId` as the graph key, which preserves the legacy
   * (pre-fix) behaviour for any caller that doesn't yet expose a
   * normalizer.
   */
  normalizeContextGraphIdForChunkStore?: (cgId: string) => string | null;
  /**
   * Test-only knob to shrink the V2 chunked-ACK local-wait retry
   * budget (default 20 retries × 500ms = 10s). The defaults exist so
   * the SWM ingest can finish persisting chunks before the ACK
   * lookup runs on freshly-subscribed cores; production callers
   * MUST NOT override this. Tests that exercise the deterministic
   * MISSING_CIPHERTEXT_CHUNKS decline path use it to keep CI fast
   * without changing the production behaviour pin.
   *
   * Codex review on PR #738: the prior MISSING_CHUNKS regression
   * burned the full ~10s retry budget on every run. The injection
   * point is intentionally narrow — only `maxRetries` and
   * `delayMs` are tunable; the loop structure is unchanged.
   */
  _v2ChunkLookupRetryPolicyForTests?: {
    maxRetries: number;
    delayMs: number;
  };
}

/**
 * StorageACKHandler implements the core node side of V10 spec §9.0 Phase 3.
 *
 * When a publisher broadcasts a PublishIntent:
 * 1. Verify this node is a core node
 * 2. Verify the data exists in SWM
 * 3. Recompute the merkle root from SWM triples
 * 4. Sign ACK = EIP-191(computePublishACKDigest(chainId, kav10Address, cgId,
 *    merkleRoot, kaCount, byteSize, epochs, tokenAmount, merkleLeafCount)) —
 *    the H5-prefixed digest. Matches `KnowledgeAssetsV10._executePublishCore`.
 * 5. Return StorageACK via the P2P stream response
 */
export class StorageACKHandler {
  private store: TripleStore;
  private config: StorageACKHandlerConfig;
  private eventBus: EventBus;

  constructor(store: TripleStore, config: StorageACKHandlerConfig, eventBus: EventBus) {
    this.store = store;
    this.config = config;
    this.eventBus = eventBus;
  }

  /**
   * Encode a structured decline response. Used in place of `throw` for
   * the subset of failures that represent "I as a core legitimately
   * cannot ACK this request right now" — currently SWM-side cases
   * that present as "data missing" or "data stale" to the publisher.
   *
   * The publisher's collector treats declines as **permanent for this
   * request** and surfaces the per-peer reason in the final error if
   * quorum fails. Throwing instead would close the libp2p stream as a
   * reset, which the publisher only sees as a generic IO error and
   * retries 3× against the same peer before giving up.
   *
   * Old senders never produce these fields and old receivers ignore
   * them, so adding declines is a strictly additive wire change — see
   * `packages/core/src/proto/storage-ack.ts` for the schema rationale.
   */
  private encodeDecline(
    cgId: string,
    code: StorageACKDeclineCode,
    message: string,
  ): Uint8Array {
    return encodeStorageACK({
      merkleRoot: new Uint8Array(0),
      coreNodeSignatureR: new Uint8Array(0),
      coreNodeSignatureVS: new Uint8Array(0),
      contextGraphId: cgId,
      nodeIdentityId: 0,
      declineCode: code,
      declineMessage: message,
    });
  }

  /**
   * Protocol stream handler for `/dkg/10.0.1/storage-ack`.
   * Receives PublishIntent, returns StorageACK.
   */
  handler = async (data: Uint8Array, _peerId: PeerId): Promise<Uint8Array> => {
    if (this.config.nodeRole !== 'core') {
      throw new Error('Only core nodes can issue StorageACKs');
    }

    const intent = decodePublishIntent(data);
    // `cgId` is the TARGET on-chain numeric id used by the ACK digest and
    // the publishDirect tx. `swmGraphId` (optional, from the remap flow)
    // is the SOURCE graph where data lives in SWM. When absent, fall back
    // to `cgId` so direct-publish flows keep working unchanged.
    const cgId = intent.contextGraphId;
    const swmGraphId = intent.swmGraphId && intent.swmGraphId.length > 0
      ? intent.swmGraphId
      : cgId;
    const subGraphName = intent.subGraphName && intent.subGraphName.length > 0
      ? intent.subGraphName
      : undefined;
    const merkleRoot = intent.merkleRoot instanceof Uint8Array
      ? intent.merkleRoot
      : new Uint8Array(intent.merkleRoot);

    const swmGraphUri = this.config.contextGraphSharedMemoryUri(swmGraphId, subGraphName);

    let swmQuads: Quad[];

    // OT-RFC-49 / WS-D — CURATED catalog ACK. A curated publish ships the
    // PUBLIC `_catalog` N-quads inline (plaintext — the catalog is public by
    // design) and claims `(catalogRoot, catalogLeafCount)`. This core, which
    // cannot decrypt the PRIVATE data, instead independently REBUILDS the
    // catalog root over the inline catalog via the SAME definition the
    // producer and prover use (`computeCatalogRoot(catalogCommittedLeaves(...))`)
    // and DECLINEs `CATALOG_ROOT_MISMATCH` on disagreement. It then PERSISTS
    // the catalog to `<cg>/_catalog` so it can serve + later re-prove it, and
    // signs the V10 ACK digest (carrying the catalog commitment + the trusted
    // private `merkleRoot`). This REPLACED the stripped ciphertext-chunk /
    // encrypted-blob ACK paths.
    //
    // Curation is independently confirmed via `isCgCurated` (Codex PR #608
    // property): a publisher must NOT be able to claim curated semantics on a
    // PUBLIC CG — otherwise it could have this core sign over a `merkleRoot` it
    // cannot verify. Fail closed when no oracle is wired or curation is unknown.
    if (intent.isEncryptedPayload === true) {
      const swmGraphIdForCuration = intent.swmGraphId && intent.swmGraphId.length > 0
        ? intent.swmGraphId
        : undefined;
      if (!this.config.isCgCurated) {
        throw new Error(
          `PublishIntent.isEncryptedPayload=true rejected: this core has no curation oracle wired, ` +
          `so it cannot verify the CG is curated. Cores must independently confirm the access policy ` +
          `before signing an ACK whose private merkleRoot they cannot recompute.`,
        );
      }
      const curationVerdict = await this.config.isCgCurated(cgId, swmGraphIdForCuration);
      if (curationVerdict !== true) {
        throw new Error(
          `PublishIntent.isEncryptedPayload=true rejected for cg=${cgId}${swmGraphIdForCuration ? ` (swmGraph=${swmGraphIdForCuration})` : ''}: ` +
          `local curation oracle reports ${curationVerdict === false ? 'PUBLIC (not curated)' : 'UNKNOWN'}. ` +
          `The curated ACK path is restricted to verifiably-curated CGs.`,
        );
      }

      // The inline payload is the PUBLIC catalog N-quads. Bound the size and
      // require a non-empty payload — the curated commitment is verified
      // against it, so an empty payload is a malformed request.
      const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
      if (!intent.stagingQuads || intent.stagingQuads.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          'curated ACK requires the public catalog N-quads inline (empty stagingQuads)',
        );
      }
      if (intent.stagingQuads.length > MAX_CATALOG_BYTES) {
        throw new Error(
          `curated catalog stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${MAX_CATALOG_BYTES} byte limit — rejecting request`,
        );
      }
      const claimedByteSize = typeof intent.publicByteSize === 'number'
        ? intent.publicByteSize
        : Number(intent.publicByteSize);
      // byteSize parity: the curated CG prices off the catalog footprint, so
      // the inline catalog bytes MUST equal the claimed `publicByteSize`
      // (same honesty guard the plaintext path applies to its quads).
      if (intent.stagingQuads.length !== claimedByteSize) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK byteSize mismatch: inline catalog is ${intent.stagingQuads.length} bytes ` +
          `but publisher claims publicByteSize=${claimedByteSize}. For curated CGs byteSize MUST ` +
          `equal the catalog N-quads byte count.`,
        );
      }

      const claimedCatalogRoot = intent.catalogRoot;
      const claimedCatalogLeafCount = intent.catalogLeafCount ?? 0;
      if (!claimedCatalogRoot || claimedCatalogRoot.length !== 32 || claimedCatalogLeafCount <= 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK requires a 32-byte catalogRoot and a positive catalogLeafCount; ` +
          `got root=${claimedCatalogRoot ? claimedCatalogRoot.length : 'missing'} bytes, count=${claimedCatalogLeafCount}`,
        );
      }

      // Independently rebuild the catalog commitment over the inline catalog
      // via the SHARED definition (post-publish stamps stripped) so the core's
      // rebuilt root is byte-identical to the producer's committed root AND the
      // prover's later rebuild. DECLINE on any disagreement.
      const parsedCatalog = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      const committedLeaves = catalogCommittedLeaves(parsedCatalog);
      if (committedLeaves.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          'curated ACK: inline catalog parsed to zero committed leaves',
        );
      }
      const rebuilt = computeCatalogRoot(committedLeaves);
      if (rebuilt.leafCount !== claimedCatalogLeafCount) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK leaf-count mismatch: rebuilt ${rebuilt.leafCount} catalog leaves ` +
          `but publisher claims ${claimedCatalogLeafCount}`,
        );
      }
      if (!bytesEqual(rebuilt.root, claimedCatalogRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
          `curated ACK root mismatch: rebuilt catalog root=${ethers.hexlify(rebuilt.root).slice(0, 18)}... ` +
          `does not match publisher claim=${ethers.hexlify(claimedCatalogRoot).slice(0, 18)}...`,
        );
      }

      // Root verified — persist the public catalog to `<cg>/_catalog` so this
      // core can serve it (the §7 facet open-serve) and the prover can later
      // rebuild the SAME root for curated proving. CLEAR/REPLACE the subjects.
      const catalogGraph = contextGraphCatalogUri(cgId);
      assertSafeIri(catalogGraph);
      const catalogSubjects = new Set(parsedCatalog.map((q) => q.subject));
      for (const subject of catalogSubjects) {
        await this.store.deleteByPattern({ graph: catalogGraph, subject });
      }
      await this.store.insert(parsedCatalog.map((q) => ({ ...q, graph: catalogGraph })));

      // OT-RFC-43 / V10: every publish mints exactly ONE Knowledge Asset.
      if (intent.kaCount !== 1) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `curated PublishIntent.kaCount must be exactly 1 for V10 publishes; got ${intent.kaCount}`,
        );
      }
      const claimedLeafCount = intent.merkleLeafCount == null ? 0 : Number(intent.merkleLeafCount);
      if (claimedLeafCount < 1) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `curated PublishIntent.merkleLeafCount must be a positive integer; got ${claimedLeafCount}`,
        );
      }

      const intentEpochs = (typeof intent.epochs === 'number' && intent.epochs > 0) ? intent.epochs : 1;
      const intentTokenAmount = intent.tokenAmountStr ? BigInt(intent.tokenAmountStr) : 0n;
      let contextGraphIdBigInt: bigint;
      try {
        contextGraphIdBigInt = BigInt(cgId);
      } catch {
        throw new Error(
          `curated StorageACK: V10 publish requires a numeric on-chain context graph id; got '${cgId}'.`,
        );
      }
      if (contextGraphIdBigInt <= 0n) {
        throw new Error(
          `curated StorageACK: V10 publish requires a positive on-chain context graph id; got ${contextGraphIdBigInt}.`,
        );
      }

      const digest = computePublishACKDigest(
        this.config.chainId,
        this.config.kav10Address,
        contextGraphIdBigInt,
        merkleRoot,
        BigInt(intent.kaCount),
        BigInt(claimedByteSize),
        BigInt(intentEpochs),
        intentTokenAmount,
        BigInt(claimedLeafCount),
        catalogRootForAckDigest(intent.catalogRoot),
        BigInt(intent.catalogLeafCount ?? 0),
        false,
      );

      if (this.config.isSignerRegistered) {
        let signerRegistered: boolean | undefined;
        try {
          signerRegistered = await this.config.isSignerRegistered();
        } catch (err) {
          try { await this.config.onSignerRegistrationLookupFailed?.(err); } catch { /* swallow */ }
          throw new Error('curated StorageACK signer registration lookup failed; refusing to sign');
        }
        if (signerRegistered === false) {
          try { await this.config.onSignerUnregistered?.(); } catch { /* swallow */ }
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
            'curated StorageACK signer is not confirmed on-chain as an operational wallet',
          );
        }
      }

      const signature = ethers.Signature.from(
        await this.config.signerWallet.signMessage(digest),
      );
      const MAX_UINT64 = (1n << 64n) - 1n;
      if (this.config.nodeIdentityId > MAX_UINT64) {
        throw new Error(
          `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format`,
        );
      }
      const curatedSubscriptionSource = this.config.getSubscriptionSourceForCg?.(
        cgId,
        swmGraphId !== cgId ? swmGraphId : undefined,
      );
      return encodeStorageACK({
        merkleRoot,
        coreNodeSignatureR: ethers.getBytes(signature.r),
        coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
        contextGraphId: cgId,
        nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(this.config.nodeIdentityId)
          : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
        ...(curatedSubscriptionSource ? { subscriptionSource: curatedSubscriptionSource } : {}),
      });
    }


    if (intent.stagingQuads && intent.stagingQuads.length > 0) {
      // Size limit: reject payloads over 4 MB to prevent memory exhaustion
      const MAX_STAGING_BYTES = 4 * 1024 * 1024;
      if (intent.stagingQuads.length > MAX_STAGING_BYTES) {
        throw new Error(
          `stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${MAX_STAGING_BYTES} byte limit — rejecting request`,
        );
      }

      // Verify merkle root IN-MEMORY before persisting anything to SWM.
      // This prevents untrusted peers from injecting arbitrary quads.
      const parsed = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      if (parsed.length === 0) {
        throw new Error('stagingQuads present but contained no parseable N-Quads');
      }

      // OT-RFC-44 / Design B: a publish is exactly ONE Knowledge Asset whose
      // member entities are the root subjects (any count). `kaCount` is the KA
      // count (must be 1) — NOT the entity count. The pre-Design-B check
      // `rootSubjects.size === intent.kaCount` conflated the two and made a
      // receiving node REFUSE to ACK any multi-entity KA (the silent cross-node
      // failure in OT-RFC-43 §2.7 / the §11.2 canary). Under Design B we assert
      // only the KA-count invariant here; data integrity (that these quads are
      // exactly what the publisher committed to) is guaranteed by the Merkle
      // check below, not by counting subjects.
      //
      // We deliberately do NOT require a count bijection between `rootEntities`
      // and the payload's root subjects. `rootEntities` is a *selection*, not a
      // complete enumeration: in the SWM-fallback branch it is the entity filter
      // passed to `loadSWMQuads`, so a caller may legitimately declare a subset
      // of the subjects present. The per-entity presence loop below still pins
      // the one direction that matters for a receiver — every entity the caller
      // names must actually be in the payload (declared ⊆ actual).
      const uniqueSubjects = new Set(parsed.map(q => q.subject));
      const rootSubjects = new Set(
        [...uniqueSubjects].filter(s => !s.includes('/.well-known/genid/')),
      );
      if (intent.kaCount !== 1) {
        throw new Error(
          `Design B: a publish must declare exactly one Knowledge Asset (kaCount=1); got ${intent.kaCount}`,
        );
      }

      // Validate that every declared rootEntity is actually present in the
      // payload (declared ⊆ actual). Skolemized blank-node children
      // (/.well-known/genid/) are excluded from `rootSubjects` above — they are
      // internal sub-nodes of a single entity, not separate root entities.
      if (intent.rootEntities && intent.rootEntities.length > 0) {
        for (const entity of intent.rootEntities) {
          if (!rootSubjects.has(entity)) {
            throw new Error(
              `rootEntity '${entity}' from intent not found in staging quads root subjects`,
            );
          }
        }
      }

      const inMemoryRoot = computeFlatKCRoot(parsed, []);
      if (!bytesEqual(inMemoryRoot, merkleRoot)) {
        throw new Error(
          `Merkle root mismatch (inline quads): publisher=${ethers.hexlify(merkleRoot).slice(0, 18)}..., ` +
          `computed=${ethers.hexlify(inMemoryRoot).slice(0, 18)}... ` +
          `(${parsed.length} triples) — refusing to store`,
        );
      }

      // Root verified — persist to a scoped staging graph so the data is
      // durable before we sign the ACK (crash safety: on-chain KC implies
      // at least one core node stored the data). The staging graph is keyed
      // by merkle root prefix and cleaned up during finalization.
      const stagingGraphUri = `${swmGraphUri}/staging/${ethers.hexlify(merkleRoot).slice(2, 18)}`;
      await this.store.dropGraph(stagingGraphUri);
      const graphedQuads = parsed.map(q => ({ ...q, graph: stagingGraphUri }));
      await this.store.insert(graphedQuads);
      swmQuads = parsed;

      // Schedule cleanup: remove staging graph after 10 minutes.
      // Finalization may promote data to LTM before this fires.
      setTimeout(async () => {
        try { await this.store.dropGraph(stagingGraphUri); } catch { /* ignore */ }
      }, 10 * 60 * 1000);
    } else {
      // Fallback: data should already be in SWM (publishFromSharedMemory path).
      // Both the "no data" and "data but wrong merkle root" cases below are
      // reasons this specific core can't ACK this specific request — the
      // publisher should deselect this peer (no retry against it) and try
      // another core. Returning a typed decline instead of throwing keeps
      // the libp2p stream alive so the publisher sees the reason in band
      // rather than as an opaque stream reset (the #541 failure mode).
      swmQuads = await this.loadSWMQuads(swmGraphUri, intent.rootEntities);

      if (swmQuads.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
          `No data found in SWM graph ${swmGraphUri} for entities: ` +
          summarizeDeclineEntities(intent.rootEntities ?? []),
        );
      }

      const recomputedRoot = computeFlatKCRoot(swmQuads, []);
      if (!bytesEqual(recomputedRoot, merkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `Merkle root mismatch: publisher=${ethers.hexlify(merkleRoot).slice(0, 18)}..., ` +
          `local=${ethers.hexlify(recomputedRoot).slice(0, 18)}... ` +
          `(${swmQuads.length} triples in SWM)`,
        );
      }
    }

    // OT-RFC-44 / Design B: a publish is exactly ONE Knowledge Asset whose
    // member entities are the root subjects (any count). The KA count signed
    // into the ACK digest is therefore ALWAYS 1 — it must match what the
    // publisher submits on chain (`knowledgeAssetsAmount`, which the contract
    // requires to be 1) and the digest the publisher/ACK-collector compute.
    // Pre-Design-B this recomputed kaCount = rootSubjects.size (the ENTITY
    // count); for a multi-entity KA that made the receiver sign a digest with
    // kaCount=N while the publisher and contract used kaCount=1, so no ACK
    // could ever validate — the silent cross-node failure in OT-RFC-43 §2.7.
    // The data integrity that recompute was protecting is already guaranteed
    // by the merkle-root check above (computeFlatKCRoot over the SWM quads).
    const verifiedKACount = 1;
    const verifiedByteSize = typeof intent.publicByteSize === 'number'
      ? BigInt(intent.publicByteSize)
      : BigInt(Number(intent.publicByteSize));

    // Derive numeric CG ID the same way the publisher does. Fail loud on
    // non-numeric or non-positive ids — the V10 contract rejects
    // `contextGraphId == 0` with `ZeroContextGraphId` at
    // `KnowledgeAssetsV10.sol:379`, so signing an ACK against CG 0 (or a
    // negative id from `BigInt("-1")`, which would die later in the
    // evm-adapter's uint256 encoder) would just produce a signature the
    // contract rejects downstream.
    //
    // Throw rather than decline: this is a malformed PublishIntent (the
    // publisher built a request the contract will never accept), not
    // peer-local state. A typed decline would make the publisher fan
    // out to every other core looking for a different answer and
    // report `storage_ack_insufficient` after the full retry budget,
    // masking the real caller error. The stream reset surfaces the
    // original message to the caller immediately.
    let contextGraphIdBigInt: bigint;
    try {
      contextGraphIdBigInt = BigInt(cgId);
    } catch {
      throw new Error(
        `StorageACK: V10 publish requires a numeric on-chain context graph id; ` +
        `got '${cgId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (contextGraphIdBigInt <= 0n) {
      throw new Error(
        `StorageACK: V10 publish requires a positive on-chain context graph id; ` +
        `got ${contextGraphIdBigInt}. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    const intentEpochs = (typeof intent.epochs === 'number' && intent.epochs > 0) ? intent.epochs : 1;
    const intentTokenAmount = intent.tokenAmountStr
      ? BigInt(intent.tokenAmountStr)
      : 0n;

    const verifiedLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);
    if (verifiedLeafCount === 0) {
      throw new Error(
        'StorageACK: empty Knowledge Asset payload (zero V10 Merkle leaves after sort+dedupe) — refusing ACK',
      );
    }
    const claimedLeafCount = intent.merkleLeafCount == null ? 0 : Number(intent.merkleLeafCount);
    if (claimedLeafCount !== verifiedLeafCount) {
      throw new Error(
        `StorageACK: merkleLeafCount mismatch (intent=${claimedLeafCount}, computed=${verifiedLeafCount}). ` +
        'Publishers must set PublishIntent.merkleLeafCount to the V10 flat-KC leaf count.',
      );
    }

    // H5-prefixed ACK digest matching `KnowledgeAssetsV10._executePublishCore`.
    // `chainId` and `kav10Address` are threaded in via StorageACKHandlerConfig.
    const digest = computePublishACKDigest(
      this.config.chainId,
      this.config.kav10Address,
      contextGraphIdBigInt,
      merkleRoot,
      BigInt(verifiedKACount),
      verifiedByteSize,
      BigInt(intentEpochs),
      intentTokenAmount,
      BigInt(verifiedLeafCount),
      // Public CGs carry no catalog commitment — absent fields decode as
      // 32 zero bytes + 0, matching the on-chain `bytes32(0)` / 0 defaults.
      catalogRootForAckDigest(intent.catalogRoot),
      BigInt(intent.catalogLeafCount ?? 0),
      false,
    );
    if (this.config.isSignerRegistered) {
      let signerRegistered: boolean | undefined;
      try {
        signerRegistered = await this.config.isSignerRegistered();
      } catch (err) {
        try {
          await this.config.onSignerRegistrationLookupFailed?.(err);
        } catch {
          // Keep ACK availability independent from logging/callback failures.
        }
        throw new Error('StorageACK signer registration lookup failed; refusing to sign');
      }
      if (signerRegistered === false) {
        try {
          await this.config.onSignerUnregistered?.();
        } catch {
          // Keep the signing refusal deterministic even if protocol cleanup fails.
        }
        // Decline rather than throw: the operator can rotate / re-register
        // a key without restarting publishers, and the publisher should
        // deselect this core for THIS request and move on rather than
        // retry-and-time-out against a known-rejecting signer.
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
          'StorageACK signer is not confirmed on-chain as an operational wallet',
        );
      }
    }

    const signature = ethers.Signature.from(
      await this.config.signerWallet.signMessage(digest),
    );

    const MAX_UINT64 = (1n << 64n) - 1n;
    if (this.config.nodeIdentityId > MAX_UINT64) {
      throw new Error(
        `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format — ` +
        `protocol upgrade required before this identity can issue ACKs`,
      );
    }

    const subscriptionSource = this.config.getSubscriptionSourceForCg?.(
      cgId,
      swmGraphId !== cgId ? swmGraphId : undefined,
    );
    return encodeStorageACK({
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(signature.r),
      coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
      contextGraphId: cgId,
      nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(this.config.nodeIdentityId)
        : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
      ...(subscriptionSource ? { subscriptionSource } : {}),
    });
  };

  /**
   * Protocol stream handler for `/dkg/10.0.1/storage-update-ack`.
   *
   * Receives an `UpdateIntent`, recomputes the new flat-KC Merkle root
   * from the request's `stagingQuads` (the same way the plaintext/SWM
   * publish branch does via `computeFlatKCRoot`), verifies it equals the
   * request's `newMerkleRoot`, then signs the 13-field UPDATE ACK digest
   * (`computeUpdateACKDigest`) with the operational key (EIP-191) and
   * returns a `StorageACK` whose `merkleRoot` carries `newMerkleRoot`.
   *
   * `kaId` + `preUpdateMerkleRootCount` are taken from the request and
   * trusted (the publisher binds them; the on-chain update tx reverts if
   * they're wrong). Publish `kaCount` is not analogous anymore: V10 create
   * ACKs require exactly one KA before signing.
   *
   * Mirrors the publish `handler` above; only the digest, the request
   * fields, and the protocol id differ.
   */
  updateHandler = async (data: Uint8Array, _peerId: PeerId): Promise<Uint8Array> => {
    if (this.config.nodeRole !== 'core') {
      throw new Error('Only core nodes can issue StorageACKs');
    }

    const intent = decodeUpdateIntent(data);
    // `cgId` is the TARGET on-chain numeric id used by the UPDATE ACK
    // digest and the update tx. `swmGraphId` (optional) is the SOURCE
    // graph where the data lives in SWM. When absent, fall back to `cgId`.
    const cgId = intent.contextGraphId;
    const swmGraphId = intent.swmGraphId && intent.swmGraphId.length > 0
      ? intent.swmGraphId
      : cgId;
    const subGraphName = intent.subGraphName && intent.subGraphName.length > 0
      ? intent.subGraphName
      : undefined;
    const newMerkleRoot = intent.newMerkleRoot instanceof Uint8Array
      ? intent.newMerkleRoot
      : new Uint8Array(intent.newMerkleRoot);
    if (newMerkleRoot.length !== 32) {
      throw new Error(
        `UpdateStorageACK: newMerkleRoot must be 32 bytes, got ${newMerkleRoot.length}`,
      );
    }

    const swmGraphUri = this.config.contextGraphSharedMemoryUri(swmGraphId, subGraphName);

    // Verify the new Merkle root the same way the publish path does:
    // recompute over the updated quads and compare to the publisher's
    // claim. For curated (encrypted) updates the core can't decrypt, so
    // it trusts the claimed root (member post-decrypt verification + the
    // on-chain revert are the integrity backstop) but still independently
    // confirms the CG is curated before signing an opaque ACK.
    if (intent.isEncryptedPayload === true) {
      const swmGraphIdForCuration = intent.swmGraphId && intent.swmGraphId.length > 0
        ? intent.swmGraphId
        : undefined;
      if (!this.config.isCgCurated) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
          'UpdateIntent.isEncryptedPayload=true rejected: this core has no curation oracle wired and cannot verify the CG access policy',
        );
      }
      const curationVerdict = await this.config.isCgCurated(cgId, swmGraphIdForCuration);
      if (curationVerdict !== true) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
          `UpdateIntent.isEncryptedPayload=true rejected for cg=${cgId}: local curation oracle reports ${curationVerdict === false ? 'PUBLIC (not curated)' : 'UNKNOWN'}; the encrypted-payload path is curated-only`,
        );
      }
      // OT-RFC-49 WS-D (update): if this curated update carries a public
      // `_catalog` commitment, INDEPENDENTLY rebuild + verify it and REPLACE-
      // persist `<cg>/_catalog` — the SAME guarantee the publish handler gives.
      // The PRIVATE newMerkleRoot stays trusted (the core can't decrypt it),
      // but the catalog is public and verifiable, so a curated update can no
      // longer obtain a signed ACK for a catalog root that doesn't match the
      // data, and cores re-host the rotated catalog so sampling can prove it.
      // A 32-zero-byte newCatalogRoot = no commitment (the on-chain gate
      // rejects a zero-root value-adding curated update), so we only ADD the
      // verification where a commitment is present — legacy/no-op flows intact.
      if (
        intent.newCatalogRoot &&
        intent.newCatalogRoot.length === 32 &&
        intent.newCatalogRoot.some((b) => b !== 0)
      ) {
        const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
        if (!intent.stagingQuads || intent.stagingQuads.length === 0) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            'curated UPDATE ACK requires the public catalog N-quads inline (empty stagingQuads)',
          );
        }
        if (intent.stagingQuads.length > MAX_CATALOG_BYTES) {
          throw new Error(
            `curated UPDATE catalog stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
            `${MAX_CATALOG_BYTES} byte limit — rejecting request`,
          );
        }
        // byteSize parity: a curated update prices off the catalog footprint, so
        // the inline catalog bytes MUST equal the claimed `newByteSize`. NOTE:
        // UpdateIntent has NO `publicByteSize` (unlike PublishIntent) — parity is
        // vs `newByteSize`, which the producer sets to the catalog byte count.
        const claimedNewByteSize = typeof intent.newByteSize === 'number'
          ? intent.newByteSize
          : Number(
              BigInt(intent.newByteSize.low >>> 0) |
                (BigInt(intent.newByteSize.high >>> 0) << 32n),
            );
        if (intent.stagingQuads.length !== claimedNewByteSize) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK byteSize mismatch: inline catalog is ${intent.stagingQuads.length} bytes ` +
            `but publisher claims newByteSize=${claimedNewByteSize}. For curated updates newByteSize MUST ` +
            `equal the catalog N-quads byte count.`,
          );
        }
        const claimedCatalogLeafCount = intent.newCatalogLeafCount ?? 0;
        if (claimedCatalogLeafCount <= 0) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK requires a positive newCatalogLeafCount; got ${claimedCatalogLeafCount}`,
          );
        }
        // Rebuild over the SHARED committed-leaf definition (post-publish stamps
        // stripped) so the rebuilt root is byte-identical to the producer's
        // committed root AND the prover's later rebuild. DECLINE on disagreement.
        const parsedCatalog = parseSimpleNQuads(
          new TextDecoder().decode(intent.stagingQuads),
        );
        const committedLeaves = catalogCommittedLeaves(parsedCatalog);
        if (committedLeaves.length === 0) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            'curated UPDATE ACK: inline catalog parsed to zero committed leaves',
          );
        }
        const rebuilt = computeCatalogRoot(committedLeaves);
        if (rebuilt.leafCount !== claimedCatalogLeafCount) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK leaf-count mismatch: rebuilt ${rebuilt.leafCount} catalog leaves ` +
            `but publisher claims ${claimedCatalogLeafCount}`,
          );
        }
        if (!bytesEqual(rebuilt.root, intent.newCatalogRoot)) {
          return this.encodeDecline(
            cgId,
            STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH,
            `curated UPDATE ACK root mismatch: rebuilt catalog root=${ethers.hexlify(rebuilt.root).slice(0, 18)}... ` +
            `does not match publisher claim=${ethers.hexlify(intent.newCatalogRoot).slice(0, 18)}...`,
          );
        }
        // Root verified — REPLACE-persist the updated public catalog to
        // `<cg>/_catalog` so this core serves + later proves the rotated root.
        const catalogGraph = contextGraphCatalogUri(cgId);
        assertSafeIri(catalogGraph);
        const catalogSubjects = new Set(parsedCatalog.map((q) => q.subject));
        for (const subject of catalogSubjects) {
          await this.store.deleteByPattern({ graph: catalogGraph, subject });
        }
        await this.store.insert(
          parsedCatalog.map((q) => ({ ...q, graph: catalogGraph })),
        );
      }
      // Encrypted updates trust the publisher's claimed newMerkleRoot —
      // no recompute. Fall through to the digest sign below.
    } else if (intent.stagingQuads && intent.stagingQuads.length > 0) {
      const MAX_STAGING_BYTES = 4 * 1024 * 1024;
      if (intent.stagingQuads.length > MAX_STAGING_BYTES) {
        throw new Error(
          `UpdateStorageACK: stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${MAX_STAGING_BYTES} byte limit — rejecting request`,
        );
      }
      const parsed = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      if (parsed.length === 0) {
        throw new Error('UpdateStorageACK: stagingQuads present but contained no parseable N-Quads');
      }
      const recomputedRoot = computeFlatKCRoot(parsed, []);
      if (!bytesEqual(recomputedRoot, newMerkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: newMerkleRoot mismatch (inline quads): publisher=${ethers.hexlify(newMerkleRoot).slice(0, 18)}..., ` +
          `computed=${ethers.hexlify(recomputedRoot).slice(0, 18)}... (${parsed.length} triples) — refusing to ACK`,
        );
      }
    } else {
      // Fallback: data should already be in SWM (publishFromSharedMemory
      // remap / SWM-resolution path). Reuse the publish branch's SWM
      // CONSTRUCT + recompute + typed-decline shape.
      const swmQuads = await this.loadSWMQuads(swmGraphUri, []);
      if (swmQuads.length === 0) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
          `UpdateStorageACK: no data found in SWM graph ${swmGraphUri}`,
        );
      }
      const recomputedRoot = computeFlatKCRoot(swmQuads, []);
      if (!bytesEqual(recomputedRoot, newMerkleRoot)) {
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
          `UpdateStorageACK: newMerkleRoot mismatch (SWM): publisher=${ethers.hexlify(newMerkleRoot).slice(0, 18)}..., ` +
          `local=${ethers.hexlify(recomputedRoot).slice(0, 18)}... (${swmQuads.length} triples in SWM)`,
        );
      }
    }

    // Derive the bigint digest inputs. Fail loud on non-numeric / non-
    // positive on-chain ids — the contract rejects `contextGraphId == 0`,
    // so signing against it would just produce a signature it rejects.
    let contextGraphIdBigInt: bigint;
    try {
      contextGraphIdBigInt = BigInt(cgId);
    } catch {
      throw new Error(
        `UpdateStorageACK: V10 update requires a numeric on-chain context graph id; got '${cgId}'.`,
      );
    }
    if (contextGraphIdBigInt <= 0n) {
      throw new Error(
        `UpdateStorageACK: V10 update requires a positive on-chain context graph id; got ${contextGraphIdBigInt}.`,
      );
    }
    let kaIdBigInt: bigint;
    try {
      kaIdBigInt = BigInt(intent.kaId);
    } catch {
      throw new Error(`UpdateStorageACK: kaId must be a numeric decimal string; got '${intent.kaId}'.`);
    }
    const preUpdateMerkleRootCount = typeof intent.preUpdateMerkleRootCount === 'number'
      ? BigInt(intent.preUpdateMerkleRootCount)
      : BigInt(intent.preUpdateMerkleRootCount.low >>> 0)
        | (BigInt(intent.preUpdateMerkleRootCount.high >>> 0) << 32n);
    const newByteSize = typeof intent.newByteSize === 'number'
      ? BigInt(intent.newByteSize)
      : BigInt(intent.newByteSize.low >>> 0) | (BigInt(intent.newByteSize.high >>> 0) << 32n);
    const newTokenAmount = intent.newTokenAmount && intent.newTokenAmount.length > 0
      ? BigInt(intent.newTokenAmount)
      : 0n;
    const mintAmount = intent.mintAmount == null
      ? 0n
      : (typeof intent.mintAmount === 'number'
          ? BigInt(intent.mintAmount)
          : BigInt(intent.mintAmount.low >>> 0) | (BigInt(intent.mintAmount.high >>> 0) << 32n));
    const burnTokenIds = (intent.burnTokenIds ?? []).map((id) => BigInt(id));
    const newMerkleLeafCount = intent.newMerkleLeafCount == null ? 0 : Number(intent.newMerkleLeafCount);
    if (!Number.isInteger(newMerkleLeafCount) || newMerkleLeafCount < 1) {
      throw new Error(
        `UpdateStorageACK: newMerkleLeafCount must be a positive integer; got ${newMerkleLeafCount}`,
      );
    }

    // 13-field UPDATE ACK digest — byte-identical to
    // `KnowledgeAssetsLifecycle._executeUpdateCore`. The token amount is
    // floored INSIDE `computeUpdateACKDigest` (floorPublishTokenAmount),
    // matching the on-chain submission, so the publisher and this signer
    // bind the same `newTokenAmount` wire value.
    const digest = computeUpdateACKDigest(
      this.config.chainId,
      this.config.kav10Address,
      contextGraphIdBigInt,
      kaIdBigInt,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      BigInt(newMerkleLeafCount),
      catalogRootForAckDigest(intent.newCatalogRoot),
      BigInt(intent.newCatalogLeafCount ?? 0),
    );

    if (this.config.isSignerRegistered) {
      let signerRegistered: boolean | undefined;
      try {
        signerRegistered = await this.config.isSignerRegistered();
      } catch (err) {
        try { await this.config.onSignerRegistrationLookupFailed?.(err); } catch { /* swallow */ }
        throw new Error('UpdateStorageACK signer registration lookup failed; refusing to sign');
      }
      if (signerRegistered === false) {
        try { await this.config.onSignerUnregistered?.(); } catch { /* swallow */ }
        return this.encodeDecline(
          cgId,
          STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED,
          'UpdateStorageACK signer is not confirmed on-chain as an operational wallet',
        );
      }
    }

    const signature = ethers.Signature.from(
      await this.config.signerWallet.signMessage(digest),
    );
    const MAX_UINT64 = (1n << 64n) - 1n;
    if (this.config.nodeIdentityId > MAX_UINT64) {
      throw new Error(
        `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format`,
      );
    }
    const subscriptionSource = this.config.getSubscriptionSourceForCg?.(
      cgId,
      swmGraphId !== cgId ? swmGraphId : undefined,
    );
    return encodeStorageACK({
      merkleRoot: newMerkleRoot,
      coreNodeSignatureR: ethers.getBytes(signature.r),
      coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
      contextGraphId: cgId,
      nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(this.config.nodeIdentityId)
        : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
      ...(subscriptionSource ? { subscriptionSource } : {}),
    });
  };

  private async loadSWMQuads(graphUri: string, rootEntities: string[]): Promise<Quad[]> {
    assertSafeIri(graphUri);
    if (rootEntities.length === 0) {
      // read-both: per-KA …/_shared_memory/{addr}/{number} graphs (promote) + the legacy
      // bucket; exclude the transient /staging/ graphs (they would corrupt the recompute).
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } ${sharedMemoryReadBothFilter(graphUri)} }`;
      const result = await this.store.query(sparql);
      return result.type === 'quads' ? result.quads : [];
    }

    const allQuads: Quad[] = [];
    for (const entity of rootEntities) {
      assertSafeIri(entity);
      const genidPrefix = `${entity}/.well-known/genid/`;
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o . FILTER(?s = <${entity}> || STRSTARTS(STR(?s), "${genidPrefix}")) } ${sharedMemoryReadBothFilter(graphUri)} }`;
      const result = await this.store.query(sparql);
      if (result.type === 'quads') {
        allQuads.push(...result.quads);
      }
    }
    return allQuads;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
