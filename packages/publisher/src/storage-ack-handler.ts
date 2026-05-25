import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import type { EventBus, StorageACKDeclineCode } from '@origintrail-official/dkg-core';
import {
  decodePublishIntent,
  encodeStorageACK,
  computePublishACKDigest,
  assertSafeIri,
  STORAGE_ACK_DECLINE_CODES,
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
   * ACK over whatever `merkleRoot`/`kaCount`/`merkleLeafCount` it claimed
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
   * Protocol stream handler for `/dkg/10.0.0/storage-ack`.
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

    // OT-RFC-38 / LU-5 encrypted-payload path. For curated CGs the publisher
    // ships AEAD-encrypted nquad bytes inline so cores can store the
    // ciphertext (durably enough to ACK the V10 publish) without ever
    // holding plaintext. Cores can't decrypt → can't recompute the
    // plaintext merkle root → MUST trust the publisher's `merkleRoot` and
    // `merkleLeafCount` claims for the V10 ACK signature. Member
    // post-decrypt verification (LU-8) catches plaintext-vs-on-chain-root
    // mismatches; outsider attestation tokens (LU-9) let third parties
    // verify after the fact. Cores DO verify `stagingQuads.length` matches
    // `publicByteSize` so a misreported size can't slip past pricing.
    if (intent.isEncryptedPayload === true) {
      // Codex PR #608: independently verify the CG is actually curated
      // before honoring the encrypted-payload claim. Without this, a
      // publisher could set `isEncryptedPayload=true` on a PUBLIC CG
      // and bypass every root / KA / merkleLeafCount verification path
      // below (the handler signs whatever the publisher claimed because
      // cores can't decrypt to recompute). Fail closed when no oracle
      // is wired or curation cannot be determined.
      const swmGraphIdForCuration = intent.swmGraphId && intent.swmGraphId.length > 0
        ? intent.swmGraphId
        : undefined;
      if (!this.config.isCgCurated) {
        throw new Error(
          `PublishIntent.isEncryptedPayload=true rejected: this core has no curation oracle wired, ` +
          `so it cannot verify the CG is curated. Cores must independently confirm the access policy ` +
          `before signing an opaque (un-verifiable) ACK payload.`,
        );
      }
      const curationVerdict = await this.config.isCgCurated(cgId, swmGraphIdForCuration);
      if (curationVerdict !== true) {
        throw new Error(
          `PublishIntent.isEncryptedPayload=true rejected for cg=${cgId}${swmGraphIdForCuration ? ` (swmGraph=${swmGraphIdForCuration})` : ''}: ` +
          `local curation oracle reports ${curationVerdict === false ? 'PUBLIC (not curated)' : 'UNKNOWN'}. ` +
          `The encrypted-payload ACK path is restricted to verifiably-curated CGs. Resubmit using the ` +
          `plaintext-inline path so root + KA count + merkle leaf count can be verified.`,
        );
      }
      if (!intent.stagingQuads || intent.stagingQuads.length === 0) {
        throw new Error(
          'PublishIntent.isEncryptedPayload=true but stagingQuads is empty — ' +
          'curated-CG ACK requires the ciphertext bytes inline (no SWM fallback path for opaque blobs)',
        );
      }
      const MAX_ENCRYPTED_BYTES = 4 * 1024 * 1024;
      if (intent.stagingQuads.length > MAX_ENCRYPTED_BYTES) {
        throw new Error(
          `encrypted stagingQuads payload (${intent.stagingQuads.length} bytes) exceeds ` +
          `${MAX_ENCRYPTED_BYTES} byte limit — rejecting request`,
        );
      }
      const claimedByteSize = typeof intent.publicByteSize === 'number'
        ? intent.publicByteSize
        : Number(intent.publicByteSize);
      if (intent.stagingQuads.length !== claimedByteSize) {
        throw new Error(
          `encrypted payload byteSize mismatch: stagingQuads.length=${intent.stagingQuads.length} ` +
          `but publicByteSize=${claimedByteSize}. For curated CGs publicByteSize MUST equal the ` +
          `ciphertext byte count (cores price the publish off this number).`,
        );
      }

      // Persist the opaque ciphertext to a scoped staging graph as a
      // single binary literal so it survives long enough for the
      // V10 chain TX to land and for LU-7 catchup to pull it. Stored
      // under a stable predicate so LU-7's wire handler can locate it
      // by (cgId, merkleRoot) without needing a new store API.
      const stagingGraphUri = `${swmGraphUri}/staging-encrypted/${ethers.hexlify(merkleRoot).slice(2, 18)}`;
      const ciphertextSubject = `${stagingGraphUri}/ciphertext`;
      const ciphertextPredicate = 'urn:dkg:swm:v10-publish-ciphertext';
      // Base64 keeps the blob as a valid N3 literal without depending on
      // the underlying triple-store accepting arbitrary binary. AES-GCM
      // ciphertext is roughly the same size as plaintext + 16-byte tag,
      // so the 33% base64 inflation stays well under the 4 MB cap above.
      const ciphertextLiteral = `"${Buffer.from(intent.stagingQuads).toString('base64')}"`;
      await this.store.dropGraph(stagingGraphUri);
      await this.store.insert([{
        subject: ciphertextSubject,
        predicate: ciphertextPredicate,
        object: ciphertextLiteral,
        graph: stagingGraphUri,
      }]);
      // Codex PR #608 R1 #2: cleanup is now tied to publish-finalization
      // bookkeeping. When the agent wires `onEncryptedStagingPersisted`
      // it owns the cleanup — typically by listening to V10 chain events
      // and calling `dropGraph(stagingGraphUri)` when the publish tx
      // finalizes (success OR permanent failure). The safety-net timer
      // below is a fallback for nodes without that hook wired.
      //
      // Without a hook, default safety net is 60 min — long enough to
      // cover slow mainnet confirmation + at least one LU-7 catchup
      // round-trip. With a hook, the agent can pass
      // `encryptedStagingSafetyNetMs: Infinity` to disable the timer
      // entirely.
      if (this.config.onEncryptedStagingPersisted) {
        try {
          await this.config.onEncryptedStagingPersisted({
            stagingGraphUri,
            cgId,
            merkleRoot,
          });
        } catch (err) {
          // Best-effort: the hook is bookkeeping, not load-bearing.
          // The safety net timer below still fires.
          console.warn(
            '[StorageACKHandler] onEncryptedStagingPersisted hook threw:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const safetyNetMs = this.config.encryptedStagingSafetyNetMs ?? 60 * 60 * 1000;
      if (Number.isFinite(safetyNetMs) && safetyNetMs > 0) {
        setTimeout(async () => {
          try { await this.store.dropGraph(stagingGraphUri); } catch { /* ignore */ }
        }, safetyNetMs);
      }

      // Cores can't enumerate KAs from ciphertext — use the publisher's
      // claimed counts for the V10 digest. Validate they're positive so
      // an obviously malformed intent (kaCount=0) doesn't waste a sign.
      if (!intent.kaCount || intent.kaCount <= 0) {
        throw new Error(
          `encrypted PublishIntent.kaCount must be positive; got ${intent.kaCount}`,
        );
      }
      const claimedLeafCount = intent.merkleLeafCount == null ? 0 : Number(intent.merkleLeafCount);
      if (claimedLeafCount < 1) {
        throw new Error(
          `encrypted PublishIntent.merkleLeafCount must be a positive integer; got ${claimedLeafCount}`,
        );
      }

      const intentEpochs = (typeof intent.epochs === 'number' && intent.epochs > 0) ? intent.epochs : 1;
      const intentTokenAmount = intent.tokenAmountStr ? BigInt(intent.tokenAmountStr) : 0n;

      let contextGraphIdBigInt: bigint;
      try {
        contextGraphIdBigInt = BigInt(cgId);
      } catch {
        throw new Error(
          `encrypted StorageACK: V10 publish requires a numeric on-chain context graph id; got '${cgId}'.`,
        );
      }
      if (contextGraphIdBigInt <= 0n) {
        throw new Error(
          `encrypted StorageACK: V10 publish requires a positive on-chain context graph id; got ${contextGraphIdBigInt}.`,
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
      );

      if (this.config.isSignerRegistered) {
        let signerRegistered: boolean | undefined;
        try {
          signerRegistered = await this.config.isSignerRegistered();
        } catch (err) {
          try { await this.config.onSignerRegistrationLookupFailed?.(err); } catch { /* swallow */ }
          throw new Error('StorageACK signer registration lookup failed; refusing to sign');
        }
        if (signerRegistered === false) {
          try { await this.config.onSignerUnregistered?.(); } catch { /* swallow */ }
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
          `nodeIdentityId ${this.config.nodeIdentityId} exceeds uint64 wire format`,
        );
      }
      return encodeStorageACK({
        merkleRoot,
        coreNodeSignatureR: ethers.getBytes(signature.r),
        coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
        contextGraphId: cgId,
        nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(this.config.nodeIdentityId)
          : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
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

      // Validate kaCount matches the number of declared root entities.
      // Exclude skolemized blank node children (/.well-known/genid/) from the count
      // since those are internal sub-nodes of a single KA, not separate entities.
      const uniqueSubjects = new Set(parsed.map(q => q.subject));
      const rootSubjects = new Set(
        [...uniqueSubjects].filter(s => !s.includes('/.well-known/genid/')),
      );
      if (intent.kaCount > 0 && rootSubjects.size !== intent.kaCount) {
        throw new Error(
          `kaCount mismatch: intent claims ${intent.kaCount} KAs but staging quads have ` +
          `${rootSubjects.size} root entities (${uniqueSubjects.size} total subjects)`,
        );
      }

      // Validate rootEntities match actual root subjects in the payload
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

    // Recompute kaCount from verified quads. publicByteSize uses the claimed
    // value because N-Quad serialization may differ between publisher and
    // handler (different graph URIs). The merkle root already proves data
    // integrity, so byte-size manipulation cannot change the actual content.
    const verifiedRootSubjects = new Set(
      swmQuads.map(q => q.subject).filter(s => !s.includes('/.well-known/genid/')),
    );
    const verifiedKACount = verifiedRootSubjects.size;
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
        'StorageACK: empty knowledge collection (zero V10 Merkle leaves after sort+dedupe) — refusing ACK',
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

    return encodeStorageACK({
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(signature.r),
      coreNodeSignatureVS: ethers.getBytes(signature.yParityAndS),
      contextGraphId: cgId,
      nodeIdentityId: this.config.nodeIdentityId <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(this.config.nodeIdentityId)
        : { low: Number(this.config.nodeIdentityId & 0xFFFFFFFFn), high: Number((this.config.nodeIdentityId >> 32n) & 0xFFFFFFFFn), unsigned: true },
    });
  };

  private async loadSWMQuads(graphUri: string, rootEntities: string[]): Promise<Quad[]> {
    assertSafeIri(graphUri);
    if (rootEntities.length === 0) {
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`;
      const result = await this.store.query(sparql);
      return result.type === 'quads' ? result.quads : [];
    }

    const allQuads: Quad[] = [];
    for (const entity of rootEntities) {
      assertSafeIri(entity);
      const genidPrefix = `${entity}/.well-known/genid/`;
      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o . FILTER(?s = <${entity}> || STRSTARTS(STR(?s), "${genidPrefix}")) } }`;
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
