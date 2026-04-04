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

    // When inline staging quads are provided via P2P, persist them to SWM
    // first to maintain the storage-attestation guarantee — we only sign
    // after the data is actually stored locally.
    if (intent.stagingQuads && intent.stagingQuads.length > 0) {
      const parsed = parseSimpleNQuads(new TextDecoder().decode(intent.stagingQuads));
      if (parsed.length > 0) {
        const graphedQuads = parsed.map(q => ({ ...q, graph: swmGraphUri }));
        await this.store.insert(graphedQuads);
      }
    }

    const swmQuads = await this.loadSWMQuads(swmGraphUri, intent.rootEntities);

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

    // Derive numeric CG ID the same way the publisher does
    const cgIdHash = ethers.keccak256(ethers.toUtf8Bytes(cgId));
    const contextGraphIdBigInt = BigInt(cgIdHash);
    const digest = computeACKDigest(contextGraphIdBigInt, merkleRoot);
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
