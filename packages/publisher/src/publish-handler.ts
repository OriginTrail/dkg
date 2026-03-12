import type { TripleStore, Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import type { EventBus, StreamHandler, OperationContext } from '@dkg/core';
import {
  DKGEvent,
  decodePublishRequest,
  encodePublishAck,
  Logger,
  createOperationContext,
  type PublishRequestMsg,
} from '@dkg/core';
import type { ChainAdapter } from '@dkg/chain';
import { ethers } from 'ethers';
import { validatePublishRequest } from './validation.js';
import { computeTripleHash, computeFlatKCRoot } from './merkle.js';
import {
  generateTentativeMetadata,
  getTentativeStatusQuad,
  getConfirmedStatusQuad,
  type KAMetadata,
} from './metadata.js';
import { autoPartition } from './auto-partition.js';
import { PublishJournal, type JournalEntry } from './publish-journal.js';

interface PendingPublish {
  ual: string;
  paranetId: string;
  dataQuads: Quad[];
  metadataQuads: Quad[];
  timeout: ReturnType<typeof setTimeout>;
  expectedPublisherAddress: string;
  expectedMerkleRoot: Uint8Array;
  expectedStartKAId: bigint;
  expectedEndKAId: bigint;
  expectedChainId: string;
  rootEntities: string[];
  createdAt: number;
}

/**
 * Handles incoming /dkg/publish/1.0.0 protocol messages on the receiving node.
 * Validates the request, verifies the merkle tree, stores public triples
 * with tentative status, and returns an ack signed by the node's operational key.
 */
export class PublishHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly eventBus: EventBus;
  private readonly ownedEntities = new Map<string, Set<string>>();
  private readonly chainAdapter?: ChainAdapter;
  private readonly signingKey?: Uint8Array;
  private readonly nodeIdentityId?: bigint;
  private readonly pendingPublishes = new Map<string, PendingPublish>();
  private readonly log = new Logger('PublishHandler');
  private readonly journal?: PublishJournal;

  private static readonly TENTATIVE_TIMEOUT_MS = 60 * 60 * 1000;

  constructor(
    store: TripleStore,
    eventBus: EventBus,
    options?: {
      chainAdapter?: ChainAdapter;
      signingKey?: Uint8Array;
      nodeIdentityId?: bigint;
      journal?: PublishJournal;
    },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.eventBus = eventBus;
    this.chainAdapter = options?.chainAdapter;
    this.signingKey = options?.signingKey;
    this.nodeIdentityId = options?.nodeIdentityId;
    this.journal = options?.journal;
  }

  get handler(): StreamHandler {
    return async (data, peerId) => {
      return this.handlePublish(data, peerId.toString());
    };
  }

  get hasPendingPublishes(): boolean {
    return this.pendingPublishes.size > 0;
  }

  /**
   * Attempts to confirm a pending publish by matching the on-chain merkle root
   * against pending entries. Used by the ChainEventPoller.
   */
  async confirmByMerkleRoot(
    merkleRoot: Uint8Array,
    onChainData: {
      publisherAddress: string;
      startKAId: bigint;
      endKAId: bigint;
      chainId: string;
    },
    ctx?: OperationContext,
  ): Promise<boolean> {
    const merkleHex = ethers.hexlify(merkleRoot);
    for (const [ual, pending] of this.pendingPublishes) {
      if (ethers.hexlify(pending.expectedMerkleRoot) === merkleHex) {
        return this.confirmPublish(ual, {
          publisherAddress: onChainData.publisherAddress,
          merkleRoot,
          startKAId: onChainData.startKAId,
          endKAId: onChainData.endKAId,
        }, ctx);
      }
    }
    return false;
  }

  /**
   * Called when an on-chain KnowledgeBatchCreated event confirms the batch.
   * Verifies that the on-chain transaction matches the signed commitment,
   * then promotes tentative → confirmed in the graph (remove tentative status quad, add confirmed)
   * and clears the timeout so the data is retained permanently.
   */
  async confirmPublish(
    ual: string,
    onChainData?: {
      publisherAddress: string;
      merkleRoot: Uint8Array;
      startKAId: bigint;
      endKAId: bigint;
    },
    ctx?: OperationContext,
  ): Promise<boolean> {
    const opCtx = ctx ?? createOperationContext('publish');
    const pending = this.pendingPublishes.get(ual);
    if (!pending) return false;

    // Dedup guard: if already confirmed (e.g. by FinalizationHandler), skip
    if (await this.isPublishConfirmed(ual, pending.paranetId)) {
      this.log.info(opCtx, `Publish ${ual} already confirmed, skipping duplicate confirmation`);
      clearTimeout(pending.timeout);
      this.pendingPublishes.delete(ual);
      this.persistJournal();
      return true;
    }

    if (onChainData) {
      if (onChainData.publisherAddress.toLowerCase() !== pending.expectedPublisherAddress.toLowerCase()) {
        this.log.warn(opCtx,
          `On-chain publisher mismatch for ${ual}: ` +
          `expected ${pending.expectedPublisherAddress}, got ${onChainData.publisherAddress}`,
        );
        return false;
      }

      const expectedHex = ethers.hexlify(pending.expectedMerkleRoot);
      const actualHex = ethers.hexlify(onChainData.merkleRoot);
      if (expectedHex !== actualHex) {
        this.log.warn(opCtx,
          `On-chain merkle root mismatch for ${ual}: expected ${expectedHex}, got ${actualHex}`,
        );
        return false;
      }

      if (onChainData.startKAId !== pending.expectedStartKAId ||
          onChainData.endKAId !== pending.expectedEndKAId) {
        this.log.warn(opCtx,
          `On-chain KA range mismatch for ${ual}: ` +
          `expected ${pending.expectedStartKAId}..${pending.expectedEndKAId}, ` +
          `got ${onChainData.startKAId}..${onChainData.endKAId}`,
        );
        return false;
      }
    }

    this.log.info(opCtx, `Confirmed publish for ${ual}`);
    clearTimeout(pending.timeout);

    // Promote in graph: remove tentative status, add confirmed (clean model: either tentative or confirmed, never both)
    try {
      await this.store.delete([getTentativeStatusQuad(ual, pending.paranetId)]);
      await this.store.insert([getConfirmedStatusQuad(ual, pending.paranetId)]);
    } catch (err) {
      this.log.error(opCtx, `Failed to promote tentative→confirmed in store: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.pendingPublishes.delete(ual);
    this.persistJournal();
    return true;
  }

  private async handlePublish(
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<Uint8Array> {
    const ctx = createOperationContext('publish');
    try {
      const request = decodePublishRequest(data);
      const paranetId = request.paranetId;
      this.log.info(ctx, `Received publish request from ${fromPeerId} for paranet ${paranetId}`);
      await this.graphManager.ensureParanet(paranetId);

      const nquadsStr = new TextDecoder().decode(request.nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      const manifest = request.kas.map((ka) => ({
        tokenId: BigInt(typeof ka.tokenId === 'number' ? ka.tokenId : 0),
        rootEntity: ka.rootEntity,
        privateTripleCount: ka.privateTripleCount,
      }));

      const existing = this.ownedEntities.get(paranetId) ?? new Set();
      const validation = validatePublishRequest(quads, manifest, paranetId, existing);

      if (!validation.valid) {
        return this.rejectAck(validation.errors.join('; '));
      }

      // ── Merkle verification (flat mode: triple hashes + private root anchors) ──
      const privateRoots = (request.kas ?? [])
        .filter(ka => ka.privateMerkleRoot?.length)
        .map(ka => new Uint8Array(ka.privateMerkleRoot));
      const computedMerkleRoot = computeFlatKCRoot(quads, privateRoots);

      const partitioned = autoPartition(quads);

      // ── UAL consistency ──
      const startKAId = protoToBigInt(request.startKAId);
      const endKAId = protoToBigInt(request.endKAId);

      if (startKAId > 0n || endKAId > 0n) {
        const ualErrors = verifyUALConsistency(quads, startKAId, endKAId);
        if (ualErrors.length > 0) {
          return this.rejectAck(ualErrors.join('; '));
        }
      }

      // Publisher identity is verified on-chain via msg.sender — no separate
      // signature needed in the P2P message. The contract derives the publisher's
      // identity from IdentityStorage.getIdentityId(msg.sender).

      // ── On-chain range check: reject if publisher does not own startKAId..endKAId ──
      if (
        startKAId > 0n &&
        endKAId > 0n &&
        request.publisherAddress &&
        this.chainAdapter?.verifyPublisherOwnsRange
      ) {
        const owns = await this.chainAdapter.verifyPublisherOwnsRange(
          request.publisherAddress,
          startKAId,
          endKAId,
        );
        if (!owns) {
          return this.rejectAck(
            `Publisher ${request.publisherAddress} does not own UAL range ${startKAId}..${endKAId} on-chain`,
          );
        }
      }

      this.log.info(ctx, `Merkle verification passed, storing ${quads.length} triples as tentative`);
      const dataGraph = this.graphManager.dataGraphUri(paranetId);
      const normalized = quads.map((q) => ({ ...q, graph: dataGraph }));
      await this.store.insert(normalized);

      const kaMetadata: KAMetadata[] = manifest.map((m, i) => ({
        rootEntity: m.rootEntity,
        kcUal: request.ual,
        tokenId: m.tokenId,
        publicTripleCount: (partitioned.get(m.rootEntity) ?? []).length,
        privateTripleCount: m.privateTripleCount ?? 0,
        privateMerkleRoot: request.kas[i].privateMerkleRoot?.length
          ? new Uint8Array(request.kas[i].privateMerkleRoot)
          : undefined,
      }));

      const metadataQuads = generateTentativeMetadata(
        {
          ual: request.ual,
          paranetId,
          merkleRoot: computedMerkleRoot,
          kaCount: manifest.length,
          publisherPeerId: fromPeerId,
          timestamp: new Date(),
        },
        kaMetadata,
      );
      await this.store.insert(metadataQuads);

      // ── Tentative lifecycle timeout ──
      const timeout = setTimeout(
        () => this.expireTentativePublish(request.ual, paranetId, normalized, metadataQuads),
        PublishHandler.TENTATIVE_TIMEOUT_MS,
      );
      this.pendingPublishes.set(request.ual, {
        ual: request.ual,
        paranetId,
        dataQuads: normalized,
        metadataQuads,
        timeout,
        expectedPublisherAddress: request.publisherAddress ?? '',
        expectedMerkleRoot: computedMerkleRoot,
        expectedStartKAId: startKAId,
        expectedEndKAId: endKAId,
        expectedChainId: request.chainId ?? '',
        rootEntities: manifest.map(m => m.rootEntity),
        createdAt: Date.now(),
      });
      this.persistJournal();

      // Track owned entities
      if (!this.ownedEntities.has(paranetId)) {
        this.ownedEntities.set(paranetId, new Set());
      }
      for (const m of manifest) {
        this.ownedEntities.get(paranetId)!.add(m.rootEntity);
      }

      this.eventBus.emit(DKGEvent.KC_PUBLISHED, {
        ual: request.ual,
        from: fromPeerId,
      });

      const publicByteSize = request.nquads.length;
      const { signatureR, signatureVs } = await this.signMerkleRootAndByteSize(computedMerkleRoot, publicByteSize);
      this.log.info(ctx, `Sending signed ack for ${request.ual} (publicByteSize=${publicByteSize})`);

      return encodePublishAck({
        merkleRoot: computedMerkleRoot,
        identityId: this.nodeIdentityId ? Number(this.nodeIdentityId) : 0,
        signatureR,
        signatureVs,
        accepted: true,
        rejectionReason: '',
        publicByteSize,
      });
    } catch (err) {
      this.log.error(ctx, `Publish handling failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.rejectAck(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  /**
   * Sign (merkleRoot, publicByteSize) so the attested byte size is binding on-chain; token amount is enforced from it.
   * Must match contract: ECDSA.toEthSignedMessageHash(keccak256(abi.encodePacked(merkleRoot, publicByteSize))).
   */
  private async signMerkleRootAndByteSize(
    merkleRoot: Uint8Array,
    publicByteSize: number,
  ): Promise<{ signatureR: Uint8Array; signatureVs: Uint8Array }> {
    if (!this.signingKey) {
      return { signatureR: new Uint8Array(0), signatureVs: new Uint8Array(0) };
    }

    const merkleRootHex = ethers.hexlify(merkleRoot);
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64'],
      [merkleRootHex, BigInt(publicByteSize)],
    );
    const wallet = new ethers.Wallet(ethers.hexlify(this.signingKey));
    const rawSig = await wallet.signMessage(ethers.getBytes(messageHash));
    const { r, yParityAndS } = ethers.Signature.from(rawSig);

    return {
      signatureR: ethers.getBytes(r),
      signatureVs: ethers.getBytes(yParityAndS),
    };
  }

  private async expireTentativePublish(
    ual: string,
    paranetId: string,
    dataQuads: Quad[],
    metadataQuads: Quad[],
  ): Promise<void> {
    const ctx = createOperationContext('publish');
    this.pendingPublishes.delete(ual);
    this.persistJournal();
    try {
      if (await this.isPublishConfirmed(ual, paranetId)) {
        this.log.info(ctx, `Publish already confirmed, skipping cleanup: ${ual}`);
        return;
      }

      await this.store.delete(dataQuads);
      await this.store.delete(metadataQuads);

      const owned = this.ownedEntities.get(paranetId);
      if (owned) {
        const subjects = new Set(dataQuads.map((q) => q.subject));
        for (const s of subjects) owned.delete(s);
      }

      this.log.info(ctx, `Tentative publish expired, data removed: ${ual}`);
    } catch (err) {
      this.log.error(ctx, `Failed to clean up expired publish: ${ual} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private journalWriteQueue: Promise<void> = Promise.resolve();

  private persistJournal(): void {
    if (!this.journal) return;
    const entries: JournalEntry[] = [];
    for (const p of this.pendingPublishes.values()) {
      entries.push({
        ual: p.ual,
        paranetId: p.paranetId,
        expectedPublisherAddress: p.expectedPublisherAddress,
        expectedMerkleRoot: ethers.hexlify(p.expectedMerkleRoot),
        expectedStartKAId: p.expectedStartKAId.toString(),
        expectedEndKAId: p.expectedEndKAId.toString(),
        expectedChainId: p.expectedChainId,
        rootEntities: p.rootEntities,
        createdAt: p.createdAt,
      });
    }
    this.journalWriteQueue = this.journalWriteQueue
      .then(() => this.journal!.save(entries))
      .catch((err) => {
        this.log.warn(
          createOperationContext('publish'),
          `Failed to persist journal: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  async restorePendingPublishes(): Promise<number> {
    if (!this.journal) return 0;
    const ctx = createOperationContext('publish');
    let entries: JournalEntry[];
    try {
      entries = await this.journal.load();
    } catch (err) {
      this.log.warn(ctx, `Failed to load journal: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    if (entries.length === 0) return 0;

    let restored = 0;
    let expired = 0;
    let skippedInvalid = 0;
    for (const entry of entries) {
      if (this.pendingPublishes.has(entry.ual)) continue;

      const elapsed = Date.now() - entry.createdAt;
      const remaining = PublishHandler.TENTATIVE_TIMEOUT_MS - elapsed;
      if (remaining <= 0) {
        this.log.info(ctx, `Journal entry expired, skipping: ${entry.ual}`);
        expired++;
        continue;
      }

      let merkleRoot: Uint8Array;
      let startKAId: bigint;
      let endKAId: bigint;
      try {
        merkleRoot = ethers.getBytes(entry.expectedMerkleRoot);
        startKAId = BigInt(entry.expectedStartKAId);
        endKAId = BigInt(entry.expectedEndKAId);
      } catch (parseErr) {
        this.log.warn(ctx, `Skipping malformed journal entry ${entry.ual}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        skippedInvalid++;
        continue;
      }

      const timeout = setTimeout(
        () => this.expireRestoredPublish(entry.ual),
        remaining,
      );

      this.pendingPublishes.set(entry.ual, {
        ual: entry.ual,
        paranetId: entry.paranetId,
        dataQuads: [],
        metadataQuads: [],
        timeout,
        expectedPublisherAddress: entry.expectedPublisherAddress,
        expectedMerkleRoot: merkleRoot,
        expectedStartKAId: startKAId,
        expectedEndKAId: endKAId,
        expectedChainId: entry.expectedChainId,
        rootEntities: entry.rootEntities ?? [],
        createdAt: entry.createdAt,
      });
      restored++;
    }

    if (expired > 0 || skippedInvalid > 0) {
      this.persistJournal();
    }

    if (restored > 0) {
      this.log.info(ctx, `Restored ${restored} pending publish(es) from journal`);
    }
    return restored;
  }

  private async expireRestoredPublish(ual: string): Promise<void> {
    const ctx = createOperationContext('publish');
    const pending = this.pendingPublishes.get(ual);
    this.pendingPublishes.delete(ual);
    this.persistJournal();

    if (pending) {
      try {
        if (await this.isPublishConfirmed(ual, pending.paranetId)) {
          this.log.info(ctx, `Restored publish already confirmed, skipping cleanup: ${ual}`);
          return;
        }
        const dataGraph = this.graphManager.dataGraphUri(pending.paranetId);
        const metaGraph = this.graphManager.metaGraphUri(pending.paranetId);
        for (const rootEntity of pending.rootEntities) {
          await this.store.deleteByPattern({ graph: dataGraph, subject: rootEntity });
          await this.store.deleteBySubjectPrefix(dataGraph, rootEntity + '/.well-known/genid/');
        }
        await this.store.deleteBySubjectPrefix(metaGraph, ual);
        await this.store.delete([getTentativeStatusQuad(ual, pending.paranetId)]);
        this.log.info(ctx, `Restored tentative publish expired, data removed: ${ual} (${pending.rootEntities.length} root entities)`);
      } catch (err) {
        this.log.error(ctx, `Failed to clean up expired restored publish: ${ual} — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      this.log.info(ctx, `Restored tentative publish expired: ${ual}`);
    }
  }

  private async isPublishConfirmed(ual: string, paranetId: string): Promise<boolean> {
    const metaGraph = `did:dkg:paranet:${paranetId}/_meta`;
    const DKG_STATUS = 'http://dkg.io/ontology/status';
    const result = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${metaGraph}> { <${ual}> <${DKG_STATUS}> ?status } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return false;
    const status = result.bindings[0]?.['status'] ?? '';
    return status === 'confirmed' || status === '"confirmed"';
  }

  private rejectAck(reason: string): Uint8Array {
    return encodePublishAck({
      merkleRoot: new Uint8Array(32),
      identityId: 0,
      signatureR: new Uint8Array(0),
      signatureVs: new Uint8Array(0),
      accepted: false,
      rejectionReason: reason,
    });
  }
}

// ── Helpers ──

const DID_DKG_PREFIX = 'did:dkg:';

/**
 * Verify that any triple subjects using DKG UALs reference KA IDs
 * within the publisher's claimed range.
 * UAL format: did:dkg:{chainId}/{publisherAddress}/{localKAId}[/...]
 */
function verifyUALConsistency(
  quads: Quad[],
  startKAId: bigint,
  endKAId: bigint,
): string[] {
  const errors: string[] = [];

  for (const q of quads) {
    if (!q.subject.startsWith(DID_DKG_PREFIX)) continue;

    const segments = q.subject.slice(DID_DKG_PREFIX.length).split('/');
    if (segments.length < 3) continue;

    let localKAId: bigint;
    try {
      localKAId = BigInt(segments[2]);
    } catch {
      continue;
    }

    if (localKAId < startKAId || localKAId > endKAId) {
      errors.push(
        `UAL consistency: subject "${q.subject}" references KA ID ${localKAId} ` +
          `outside claimed range ${startKAId}..${endKAId}`,
      );
    }
  }

  return errors;
}

function protoToBigInt(val: number | { low: number; high: number; unsigned: boolean }): bigint {
  if (typeof val === 'number') return BigInt(val);
  const lo = BigInt(val.low >>> 0);
  const hi = BigInt(val.high >>> 0);
  return (hi << 32n) | lo;
}

/**
 * Minimal N-Triples/N-Quads parser for incoming publish data.
 * Accepts both N-Triples (<s> <p> <o> .) and N-Quads (<s> <p> <o> <g> .).
 * The graph component is ignored; the handler derives it from paranetId.
 * Exported for tests that verify receiver recomputes the same merkle root.
 */
export function parseSimpleNQuads(text: string): Quad[] {
  const quads: Quad[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Remove trailing " ."
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length >= 3) {
      quads.push({
        subject: stripAngleBrackets(parts[0]),
        predicate: stripAngleBrackets(parts[1]),
        object: parts[2].startsWith('"') ? parts[2] : stripAngleBrackets(parts[2]),
        graph: parts[3] ? stripAngleBrackets(parts[3]) : '',
      });
    }
  }
  return quads;
}

function splitNQuadLine(line: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;

    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end === -1) break;
      parts.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          j++;
          // Check for language tag or datatype
          if (line[j] === '@') {
            while (j < line.length && line[j] !== ' ') j++;
          } else if (line[j] === '^' && line[j + 1] === '^') {
            j += 2;
            if (line[j] === '<') {
              const end = line.indexOf('>', j);
              j = end + 1;
            }
          }
          break;
        }
        j++;
      }
      parts.push(line.slice(i, j));
      i = j;
    } else if (line[i] === '_') {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      parts.push(line.slice(i, j));
      i = j;
    } else {
      break;
    }
  }
  return parts;
}

function stripAngleBrackets(s: string): string {
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}
