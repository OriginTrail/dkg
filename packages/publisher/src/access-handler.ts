import type {
  StreamHandler,
  EventBus,
  GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import {
  DKGEvent,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildGraphKnowledgeAssetMetadataQuery,
  buildTrustedRootContextGraphRegistrationFilter,
  decodeAccessRequest,
  encodeAccessResponse,
  ed25519Verify,
  assertSafeIri,
  parseDeterministicKnowledgeAssetUal,
  parseGraphKnowledgeAssetMetadataBindings,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  ExactGraphReadError,
  GraphManager,
  PrivateContentStore,
  quadsToNQuads,
} from '@origintrail-official/dkg-storage';
import { computePrivateRootV10 as computePrivateRoot } from './merkle.js';

const DKG_NS = 'http://dkg.io/ontology/';

export type AccessPolicy = 'public' | 'ownerOnly' | 'allowList';

interface KAMetaBase {
  contextGraphId: string;
  subGraphName?: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
  accessPolicy?: AccessPolicy;
  hasInvalidExplicitPolicy?: boolean;
  publisherPeerId?: string;
  allowedPeers?: string[];
}

interface GraphScopedKAMeta extends KAMetaBase {
  contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  scope: GraphKnowledgeAssetScope;
  privateTripleCount: number;
  rootEntities: [];
  rootEntity?: never;
}

interface LegacyRootKAMeta extends KAMetaBase {
  contentScopeVersion: 1;
  rootEntity: string;
  /**
   * ALL distinct member roots bound by the meta query (binding order).
   * On the collapsed multi-root shape (RFC ka-metadata-trim P3.1) a bare-UAL
   * request cannot name a member, so the handler scans these for the first
   * root that actually has a private bag instead of denying on an
   * engine-arbitrary first binding (Codex review "multi-root-access").
   */
  rootEntities: string[];
}

type KAMeta = GraphScopedKAMeta | LegacyRootKAMeta;

interface PrivatePayload {
  quads: Quad[];
  privateMerkleRoot: Uint8Array;
}

type PrivatePayloadLoader = () => Promise<PrivatePayload>;

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

      if (meta.hasInvalidExplicitPolicy) {
        return this.deny('Access denied: invalid access policy metadata');
      }

      const loadPrivatePayload = await this.preparePrivatePayload(meta);
      if (!loadPrivatePayload) {
        return this.deny('No private triples available for this KA');
      }

      const effectivePolicy = this.resolveAccessPolicy(meta, true);

      // Enforce access policy (cheap peerId checks first, before expensive crypto)
      if (effectivePolicy === 'ownerOnly') {
        if (!meta.publisherPeerId || meta.publisherPeerId === 'unknown') {
          return this.deny('Access denied: owner identity missing for owner-only policy');
        }
        if (meta.publisherPeerId && fromPeerId !== meta.publisherPeerId) {
          this.eventBus.emit(DKGEvent.ACCESS_RESPONSE, {
            kaUal: request.kaUal,
            requester: fromPeerId,
            granted: false,
          });
          return this.deny('Access denied: owner-only policy');
        }
      } else if (effectivePolicy === 'allowList') {
        if (!meta.allowedPeers || meta.allowedPeers.length === 0) {
          return this.deny('Access denied: allow list missing or empty');
        }
        if (!meta.allowedPeers.includes(fromPeerId)) {
          this.eventBus.emit(DKGEvent.ACCESS_RESPONSE, {
            kaUal: request.kaUal,
            requester: fromPeerId,
            granted: false,
          });
          return this.deny('Access denied: not on allow list');
        }
      }

      // Verify signature for non-public access policies
      if (effectivePolicy !== 'public') {
        if (!request.requesterSignature || request.requesterSignature.length === 0) {
          return this.deny('Access denied: signature required for non-public access');
        }
        if (!request.requesterPublicKey || request.requesterPublicKey.length === 0) {
          return this.deny('Access denied: public key required for signature verification');
        }

        const message = new TextEncoder().encode(
          request.kaUal + toHex(request.paymentProof),
        );
        const valid = await ed25519Verify(
          request.requesterSignature,
          message,
          request.requesterPublicKey,
        );
        if (!valid) {
          return this.deny('Access denied: invalid signature');
        }
      }

      const { quads: privateQuads, privateMerkleRoot } = await loadPrivatePayload();
      const nquads = quadsToNQuads(privateQuads);

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

  /**
   * Resolve the private payload location before policy checks, but defer the
   * bounded graph read and Merkle work until after the requester is allowed.
   */
  private async preparePrivatePayload(meta: KAMeta): Promise<PrivatePayloadLoader | null> {
    if (meta.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
      if (meta.privateTripleCount <= 0) return null;

      return async () => {
        let quads: Quad[];
        try {
          quads = await this.privateStore.getKnowledgeAssetPrivateTriples(
            meta.contextGraphId,
            meta.scope,
            meta.subGraphName,
            {
              expectedQuadCount: meta.privateTripleCount,
              queryOptions: { source: 'publisher.access' },
            },
          );
        } catch (error) {
          if (
            error instanceof ExactGraphReadError
            && error.code === 'QUAD_COUNT_MISMATCH'
          ) {
            throw new Error(
              `Private KA integrity check failed: metadata declares ${meta.privateTripleCount} triples, `
                + `found ${error.actual ?? 'an unknown count'}`,
            );
          }
          throw error;
        }

        const computedPrivateRoot = computePrivateRoot(quads);
        if (
          !computedPrivateRoot
          || !meta.privateMerkleRoot
          || !bytesEqual(computedPrivateRoot, meta.privateMerkleRoot)
        ) {
          throw new Error('Private KA integrity check failed: Merkle root mismatch');
        }
        return {
          quads,
          privateMerkleRoot: Uint8Array.from(meta.privateMerkleRoot),
        };
      };
    }

    // Existing collapsed multi-root KAs have one private bag per root and no
    // reliable root-to-private-root pairing. Preserve read-only lookup by
    // selecting the first member whose legacy bag exists.
    let servedRootEntity: string | undefined;
    for (const root of meta.rootEntities) {
      if (
        this.privateStore.hasPrivateTriples(meta.contextGraphId, root, meta.subGraphName)
        || await this.privateStore.hasPrivateTriplesInStore(
          meta.contextGraphId,
          root,
          meta.subGraphName,
        )
      ) {
        servedRootEntity = root;
        break;
      }
    }
    if (!servedRootEntity) return null;

    return async () => {
      const quads = await this.privateStore.getPrivateTriples(
        meta.contextGraphId,
        servedRootEntity,
        meta.subGraphName,
      );
      let privateMerkleRoot = meta.privateMerkleRoot
        ? Uint8Array.from(meta.privateMerkleRoot)
        : new Uint8Array(32);
      if (!meta.privateMerkleRoot && quads.length > 0) {
        const computed = computePrivateRoot(quads);
        if (computed) privateMerkleRoot = Uint8Array.from(computed);
      }
      return { quads, privateMerkleRoot };
    };
  }

  private async lookupKAMeta(kaUal: string): Promise<KAMeta | null> {
    const legacyAliasBase = legacyTokenAliasBase(kaUal);
    const canonicalUal = legacyAliasBase ?? kaUal;
    // A token-form legacy alias must not bypass a V2 marker on the canonical
    // bare UAL. Resolve the canonical control plane before either legacy path.
    const graphScoped = await this.queryGraphScopedKAMeta(canonicalUal);
    if (graphScoped) return graphScoped;

    const direct = await this.queryLegacyKAMeta(kaUal);
    if (direct) return direct;
    // Read-both (RFC ka-metadata-trim P3.1): older requesters address private
    // content by the legacy token row `<ual>/<n>`; the collapsed shape keys
    // everything on the bare UAL. Strip a numeric suffix and retry once so
    // old-client requests keep resolving against new-shape stores.
    if (legacyAliasBase) {
      return this.queryLegacyKAMeta(legacyAliasBase);
    }
    return null;
  }

  private async queryGraphScopedKAMeta(
    kaUal: string,
  ): Promise<GraphScopedKAMeta | null> {
    const safeUal = assertSafeIri(kaUal);
    const result = await this.store.query(
      buildGraphKnowledgeAssetMetadataQuery(safeUal),
    );
    const parsed = parseGraphKnowledgeAssetMetadataBindings(
      safeUal,
      result.type === 'bindings' ? result.bindings : [],
    );
    if (parsed.kind !== 'graph') return null;
    const metadata = parsed.metadata;

    return {
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      scope: metadata.scope,
      rootEntities: [],
      contextGraphId: metadata.contextGraphId,
      subGraphName: metadata.subGraphName,
      privateMerkleRoot: metadata.privateMerkleRoot,
      privateTripleCount: metadata.privateTripleCount,
      accessPolicy: metadata.accessPolicy,
      hasInvalidExplicitPolicy: false,
      publisherPeerId: metadata.publisherPeerId ?? metadata.attributedTo,
      allowedPeers: [...metadata.allowedPeers],
    };
  }

  private async queryLegacyKAMeta(kaUal: string): Promise<LegacyRootKAMeta | null> {
    const safeUal = assertSafeIri(kaUal);
    // Read-both (RFC ka-metadata-trim P3.1): the collapsed shape has NO
    // `<ual>/<n>` token row — the UAL subject itself carries the entity pair
    // and `dkg:contextGraph`, so `?kc` binds to the UAL. The `partOf` branch
    // keeps legacy `<ual>/<n>` lookups (old clients / old-shape replica rows)
    // resolving.
    const result = await this.store.query(
      `SELECT ?rootEntity ?contextGraph ?kc ?privateMerkleRoot ?privateTripleCount ?accessPolicy ?publisherPeerId ?attributedTo ?sgName WHERE {
        GRAPH ?g {
          {
            <${safeUal}> <${DKG_NS}rootEntity> ?rootEntity .
            <${safeUal}> <${DKG_NS}partOf> ?kc .
          }
          UNION
          {
            <${safeUal}> <${DKG_NS}rootEntity> ?rootEntity .
            BIND(<${safeUal}> AS ?kc)
          }
          ?kc <${DKG_NS}contextGraph> ?contextGraph .
          OPTIONAL { <${safeUal}> <${DKG_NS}privateMerkleRoot> ?privateMerkleRoot }
          OPTIONAL { <${safeUal}> <${DKG_NS}privateTripleCount> ?privateTripleCount }
          OPTIONAL { ?kc <${DKG_NS}accessPolicy> ?accessPolicy }
          OPTIONAL { ?kc <${DKG_NS}publisherPeerId> ?publisherPeerId }
          OPTIONAL { ?kc <http://www.w3.org/ns/prov#wasAttributedTo> ?attributedTo }
          OPTIONAL { ?kc <${DKG_NS}subGraphName> ?sgName }
          BIND(CONCAT(STR(?contextGraph), '/_meta') AS ?expectedMetaGraph)
          FILTER(STR(?g) = ?expectedMetaGraph)
        }
        ${buildTrustedRootContextGraphRegistrationFilter('?contextGraph', '?g')}
      }`,
    );

    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }

    const row = result.bindings[0];
    const rootEntity = row['rootEntity'];
    const contextGraphUri = row['contextGraph'];
    const contextGraphId = contextGraphUri.replace('did:dkg:context-graph:', '');
    const kcUal = row['kc'];

    // Adversarial review F3 — multi-root pairing hazard on the collapsed
    // shape (RFC ka-metadata-trim P3.1): ALL member `dkg:rootEntity` rows and
    // ALL per-root `dkg:privateMerkleRoot` rows now sit on the same UAL
    // subject, with no token row tying root N to private root N. The two
    // independent patterns above cross-product, so the former `LIMIT 1` could
    // pair member root A with private root B — the handler would then attest
    // root B's merkle root over root A's served triples. When more than one
    // member root OR more than one private root is on the subject, ignore the
    // meta `privateMerkleRoot` entirely; `handleAccess` falls back to
    // `computePrivateRoot(privateQuads)` over the actually-served triples, so
    // the attestation always matches what is sent. Single-root KAs (and
    // legacy `<ual>/<n>` token rows, inherently 1:1) keep the cheap meta read.
    const distinctRoots = new Set(
      result.bindings.map((b) => b['rootEntity']).filter(Boolean),
    );
    const distinctPrivRoots = new Set(
      result.bindings.map((b) => b['privateMerkleRoot']).filter(Boolean),
    );
    const ambiguousPrivatePairing = distinctRoots.size > 1 || distinctPrivRoots.size > 1;

    let privateMerkleRoot: Uint8Array | undefined;
    const rawRoot = ambiguousPrivatePairing ? undefined : row['privateMerkleRoot'];
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

    const privateTripleCount = row['privateTripleCount']
      ? Number(stripLiteral(row['privateTripleCount']))
      : 0;

    const rawPolicy = row['accessPolicy'];
    const parsedPolicy = rawPolicy ? stripLiteral(rawPolicy) : undefined;
    const accessPolicy = isAccessPolicy(parsedPolicy) ? parsedPolicy : undefined;
    const hasInvalidExplicitPolicy = !!parsedPolicy && !isAccessPolicy(parsedPolicy);

    const publisherPeerId = row['publisherPeerId']
      ? stripLiteral(row['publisherPeerId'])
      : row['attributedTo']
        ? stripLiteral(row['attributedTo'])
        : undefined;

    const subGraphName = row['sgName'] ? stripLiteral(row['sgName']) : undefined;

    const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    const allowedPeerRes = await this.store.query(
      `SELECT ?allowedPeer WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          <${assertSafeIri(kcUal)}> <${DKG_NS}allowedPeer> ?allowedPeer .
        }
      }`,
    );
    const allowedPeers =
      allowedPeerRes.type === 'bindings'
        ? [...new Set(
          allowedPeerRes.bindings
            .map((b) => b['allowedPeer'])
            .filter(Boolean)
            .map((s) => stripLiteral(s)),
        )]
        : undefined;

    return {
      contentScopeVersion: 1,
      rootEntity,
      rootEntities: [...distinctRoots],
      contextGraphId,
      subGraphName,
      privateMerkleRoot,
      privateTripleCount,
      accessPolicy,
      hasInvalidExplicitPolicy,
      publisherPeerId,
      allowedPeers,
    };
  }

  private resolveAccessPolicy(meta: KAMeta, hasPrivate: boolean): AccessPolicy {
    if (meta.accessPolicy) return meta.accessPolicy;
    return hasPrivate ? 'ownerOnly' : 'public';
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isAccessPolicy(value: string | undefined): value is AccessPolicy {
  return value === 'public' || value === 'ownerOnly' || value === 'allowList';
}

function legacyTokenAliasBase(kaUal: string): string | undefined {
  const match = /^(.+)\/\d+$/.exec(kaUal);
  const candidate = match?.[1];
  if (!candidate) return undefined;
  try {
    return parseDeterministicKnowledgeAssetUal(candidate).ual;
  } catch {
    // A canonical bare UAL also ends in digits. Its prefix is not itself a
    // deterministic KA UAL, so it must never be stripped as a token alias.
    return undefined;
  }
}
