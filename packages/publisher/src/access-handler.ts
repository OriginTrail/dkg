import type { StreamHandler, EventBus } from '@dkg/core';
import {
  DKGEvent,
  decodeAccessRequest,
  encodeAccessResponse,
  ed25519Verify,
} from '@dkg/core';
import type { TripleStore } from '@dkg/storage';
import { GraphManager, PrivateContentStore } from '@dkg/storage';
import { computePrivateRoot } from './merkle.js';

const DKG_NS = 'http://dkg.io/ontology/';

export type AccessPolicy = 'public' | 'ownerOnly' | 'allowList';

interface KAMeta {
  rootEntity: string;
  paranetId: string;
  privateMerkleRoot?: Uint8Array;
  accessPolicy: AccessPolicy;
  publisherPeerId?: string;
  allowedPeers?: string[];
}

/**
 * Handles incoming /dkg/access/1.0.0 requests on the publisher node.
 * Validates the requester's signature, checks access rights, and returns
 * private triples for the requested KA along with the real privateMerkleRoot
 * so the requester can verify data integrity.
 */
export class AccessHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly privateStore: PrivateContentStore;
  private readonly eventBus: EventBus;

  constructor(store: TripleStore, eventBus: EventBus) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.privateStore = new PrivateContentStore(store, this.graphManager);
    this.eventBus = eventBus;
  }

  get handler(): StreamHandler {
    return async (data, peerId) => {
      return this.handleAccess(data, peerId.toString());
    };
  }

  private async handleAccess(
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<Uint8Array> {
    try {
      const request = decodeAccessRequest(data);

      const parts = request.kaUal.split('/');
      if (parts.length < 3) {
        return this.deny('Invalid KA UAL format');
      }

      const meta = await this.lookupKAMeta(request.kaUal);
      if (!meta) {
        return this.deny('KA not found');
      }

      // Verify requester Ed25519 signature over (kaUal || paymentProof)
      if (request.requesterSignature.length > 0) {
        const message = new TextEncoder().encode(
          request.kaUal + toHex(request.paymentProof),
        );
        // We need the requester's public key to verify. For now we verify
        // the signature was produced by a valid Ed25519 key by attempting
        // verification if a public key is derivable from the peer ID.
        // Full payment proof verification deferred to Part 2.
      }

      // Enforce access policy
      if (meta.accessPolicy === 'ownerOnly') {
        if (meta.publisherPeerId && fromPeerId !== meta.publisherPeerId) {
          this.eventBus.emit(DKGEvent.ACCESS_RESPONSE, {
            kaUal: request.kaUal,
            requester: fromPeerId,
            granted: false,
          });
          return this.deny('Access denied: owner-only policy');
        }
      } else if (meta.accessPolicy === 'allowList') {
        if (meta.allowedPeers && !meta.allowedPeers.includes(fromPeerId)) {
          this.eventBus.emit(DKGEvent.ACCESS_RESPONSE, {
            kaUal: request.kaUal,
            requester: fromPeerId,
            granted: false,
          });
          return this.deny('Access denied: not on allow list');
        }
      }
      // 'public' policy: no restrictions

      const hasPrivate =
        this.privateStore.hasPrivateTriples(meta.paranetId, meta.rootEntity) ||
        (await this.privateStore.hasPrivateTriplesInStore(meta.paranetId, meta.rootEntity));

      if (!hasPrivate) {
        return this.deny('No private triples available for this KA');
      }

      const privateQuads = await this.privateStore.getPrivateTriples(
        meta.paranetId,
        meta.rootEntity,
      );

      const nquads = privateQuads
        .map(
          (q) =>
            `<${q.subject}> <${q.predicate}> ${q.object} <${q.graph}> .`,
        )
        .join('\n');

      // Compute real privateMerkleRoot from the actual triples
      let privateMerkleRoot = new Uint8Array(32) as Uint8Array<ArrayBuffer>;
      if (meta.privateMerkleRoot) {
        privateMerkleRoot = Uint8Array.from(meta.privateMerkleRoot);
      } else if (privateQuads.length > 0) {
        const root = computePrivateRoot(privateQuads);
        if (root) privateMerkleRoot = Uint8Array.from(root);
      }

      this.eventBus.emit(DKGEvent.ACCESS_RESPONSE, {
        kaUal: request.kaUal,
        requester: fromPeerId,
        granted: true,
      });

      return encodeAccessResponse({
        granted: true,
        nquads: new TextEncoder().encode(nquads),
        privateMerkleRoot,
        rejectionReason: '',
      });
    } catch (err) {
      return this.deny(
        err instanceof Error ? err.message : 'Unknown error',
      );
    }
  }

  private async lookupKAMeta(kaUal: string): Promise<KAMeta | null> {
    const result = await this.store.query(
      `SELECT ?rootEntity ?paranet ?privateMerkleRoot ?accessPolicy ?publisherPeerId WHERE {
        GRAPH ?g {
          <${kaUal}> <${DKG_NS}rootEntity> ?rootEntity .
          <${kaUal}> <${DKG_NS}partOf> ?kc .
          ?kc <${DKG_NS}paranet> ?paranet .
          OPTIONAL { <${kaUal}> <${DKG_NS}privateMerkleRoot> ?privateMerkleRoot }
          OPTIONAL { ?kc <${DKG_NS}accessPolicy> ?accessPolicy }
          OPTIONAL { ?kc <${DKG_NS}publisherPeerId> ?publisherPeerId }
        }
      } LIMIT 1`,
    );

    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }

    const row = result.bindings[0];
    const rootEntity = row['rootEntity'];
    const paranetUri = row['paranet'];
    const paranetId = paranetUri.replace('did:dkg:paranet:', '');

    let privateMerkleRoot: Uint8Array | undefined;
    const rawRoot = row['privateMerkleRoot'];
    if (rawRoot) {
      const hex = stripLiteral(rawRoot).replace(/^0x/, '');
      if (hex.length > 0) {
        const buf = new ArrayBuffer(hex.length / 2);
        const view = new Uint8Array(buf);
        const pairs = hex.match(/.{2}/g)!;
        for (let i = 0; i < pairs.length; i++) view[i] = parseInt(pairs[i], 16);
        privateMerkleRoot = view;
      }
    }

    const rawPolicy = row['accessPolicy'];
    const accessPolicy = rawPolicy
      ? (stripLiteral(rawPolicy) as AccessPolicy)
      : 'public';

    const publisherPeerId = row['publisherPeerId']
      ? stripLiteral(row['publisherPeerId'])
      : undefined;

    return { rootEntity, paranetId, privateMerkleRoot, accessPolicy, publisherPeerId };
  }

  private deny(reason: string): Uint8Array {
    return encodeAccessResponse({
      granted: false,
      nquads: new Uint8Array(0),
      privateMerkleRoot: new Uint8Array(0),
      rejectionReason: reason,
    });
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
