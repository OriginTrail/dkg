import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import type { EventBus } from '@origintrail-official/dkg-core';
import {
  decodePublishIntent,
  encodeStorageACK,
  computeACKDigest,
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 as computeFlatKCRoot } from './merkle.js';
import { parseSimpleNQuads } from './publish-handler.js';
import { ethers } from 'ethers';

type PeerId = { toString(): string };

export interface StorageACKHandlerConfig {
  nodeRole: 'core' | 'edge';
  nodeIdentityId: bigint;
  signerWallet: ethers.Wallet;
  contextGraphSharedMemoryUri: (cgId: string) => string;
}

/**
 * StorageACKHandler implements the core node side of V10 spec §9.0 Phase 3.
 *
 * When a publisher broadcasts a PublishIntent:
 * 1. Verify this node is a core node
 * 2. Verify the data exists in SWM
 * 3. Recompute the merkle root from SWM triples
 * 4. Sign ACK = EIP-191(keccak256(abi.encodePacked(contextGraphId, merkleRoot)))
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
   * Protocol stream handler for `/dkg/10.0.0/storage-ack`.
   * Receives PublishIntent, returns StorageACK.
   */
  handler = async (data: Uint8Array, _peerId: PeerId): Promise<Uint8Array> => {
    if (this.config.nodeRole !== 'core') {
      throw new Error('Only core nodes can issue StorageACKs');
    }

    const intent = decodePublishIntent(data);
    const cgId = intent.contextGraphId;
    const merkleRoot = intent.merkleRoot instanceof Uint8Array
      ? intent.merkleRoot
      : new Uint8Array(intent.merkleRoot);

    const swmGraphUri = this.config.contextGraphSharedMemoryUri(cgId);

    let swmQuads: Quad[];

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
      // Fallback: data should already be in SWM (publishFromSharedMemory path)
      swmQuads = await this.loadSWMQuads(swmGraphUri, intent.rootEntities);

      if (swmQuads.length === 0) {
        throw new Error(`No data found in SWM graph ${swmGraphUri} for entities: ${intent.rootEntities.join(', ')}`);
      }

      const recomputedRoot = computeFlatKCRoot(swmQuads, []);
      if (!bytesEqual(recomputedRoot, merkleRoot)) {
        throw new Error(
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

    // Derive numeric CG ID the same way the publisher does.
    let contextGraphIdBigInt: bigint;
    try {
      contextGraphIdBigInt = BigInt(cgId);
    } catch {
      contextGraphIdBigInt = BigInt(ethers.keccak256(ethers.toUtf8Bytes(cgId)));
    }
    const intentEpochs = (typeof intent.epochs === 'number' && intent.epochs > 0) ? intent.epochs : 1;
    const intentTokenAmount = intent.tokenAmountStr
      ? BigInt(intent.tokenAmountStr)
      : 0n;
    const digest = computeACKDigest(contextGraphIdBigInt, merkleRoot, verifiedKACount, verifiedByteSize, intentEpochs, intentTokenAmount);
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
