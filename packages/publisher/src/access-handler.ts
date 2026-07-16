import type {
  StreamHandler,
  EventBus,
  GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import {
  DKGEvent,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildLegacyKnowledgeAssetAccessMetadataQuery,
  decodeAccessRequest,
  encodeAccessResponse,
  ed25519Verify,
  assertSafeIri,
  createGraphKnowledgeAssetScope,
  parseDeterministicKnowledgeAssetUal,
  type ParsedGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  ExactGraphReadError,
  GraphManager,
  PrivateContentStore,
  quadsToNQuads,
  resolveGraphScopedOrLegacyMetadata,
} from '@origintrail-official/dkg-storage';
import { computePrivateRootV10 as computePrivateRoot } from './merkle.js';
import { resolveKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';

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
  graphScope?: ReturnType<typeof createGraphKnowledgeAssetScope>;
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
    const graphScopedAliasBase = canonicalDeterministicUal(legacyAliasBase);
    const canonicalUal = graphScopedAliasBase ?? kaUal;
    // A token-form legacy alias must not bypass a V2 marker on the canonical
    // bare UAL. Resolve the canonical control plane before either legacy path.
    const resolved = await resolveGraphScopedOrLegacyMetadata(
      this.store,
      canonicalUal,
      async () => null,
      { source: 'publisher.access.metadata' },
    );
    if (resolved.kind === 'graph') {
      // Numeric token suffixes are legacy compatibility addresses only. V2
      // assets have one canonical UAL and must never be served through one.
      if (graphScopedAliasBase) return null;
      return this.graphScopedKAMeta(resolved.metadata);
    }
    const workspaceMeta = await this.lookupWorkspaceHeadKAMeta(canonicalUal);
    if (workspaceMeta) return workspaceMeta;

    const direct = await this.queryLegacyKAMeta(kaUal);
    if (direct) return direct;
    // Read-both (RFC ka-metadata-trim P3.1): older requesters address
    // private content by `<ual>/<n>`. Retry the canonical bare UAL once.
    return legacyAliasBase
      ? this.queryLegacyKAMeta(legacyAliasBase)
      : null;
  }

  private async lookupWorkspaceHeadKAMeta(kaUal: string): Promise<GraphScopedKAMeta | null> {
    let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    try {
      scope = createGraphKnowledgeAssetScope(
        parseDeterministicKnowledgeAssetUal(kaUal).ual,
        1,
      );
    } catch {
      // Legacy token/entity aliases are not graph-scoped identities. Let the
      // read-only legacy resolver below handle them unchanged.
      return null;
    }
    const headSubject = `${scope.ual}#dkg-swm-head`;
    const result = await this.store.query(
      `SELECT DISTINCT ?g WHERE { GRAPH ?g {
        <${assertSafeIri(headSubject)}> <${DKG_NS}contentScopeVersion> ?scopeVersion ;
          <${DKG_NS}kaUal> <${assertSafeIri(scope.ual)}> .
      } } LIMIT 2`,
      { source: 'publisher.access.workspace-head' },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    if (result.bindings.length !== 1) {
      throw new Error(`Graph-scoped KA ${scope.ual} has ambiguous durable workspace heads`);
    }
    const graph = result.bindings[0]?.['g'] ?? '';
    const match = graph.match(
      /^did:dkg:context-graph:([^/]+)(?:\/([^/]+))?\/_shared_memory_meta$/,
    );
    if (!match) {
      throw new Error(`Graph-scoped KA ${scope.ual} has an invalid durable workspace-head graph`);
    }
    const contextGraphId = match[1]!;
    const subGraphName = match[2];
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId,
      kaUal: scope.ual,
      subGraphName,
    });
    if (!head) return null;
    return {
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      scope: createGraphKnowledgeAssetScope(head.kaUal, head.assertionVersion),
      rootEntities: [],
      contextGraphId,
      subGraphName,
      privateMerkleRoot: head.privateMerkleRoot
        ? hexToBytes(head.privateMerkleRoot)
        : undefined,
      privateTripleCount: head.privateTripleCount,
      accessPolicy: head.accessPolicy,
      hasInvalidExplicitPolicy: false,
      publisherPeerId: head.publisherPeerId,
      allowedPeers: [...head.allowedPeers],
    };
  }

  private graphScopedKAMeta(
    metadata: ParsedGraphKnowledgeAssetMetadata,
  ): GraphScopedKAMeta {
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
      buildLegacyKnowledgeAssetAccessMetadataQuery(safeUal),
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

function hexToBytes(value: string): Uint8Array {
  const hex = value.replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Invalid private Merkle root');
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
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
  try {
    parseDeterministicKnowledgeAssetUal(kaUal);
    return undefined;
  } catch {
    // Continue: non-deterministic legacy UALs may carry a token suffix.
  }
  const match = /^(.+)\/\d+$/.exec(kaUal);
  return match?.[1];
}

function canonicalDeterministicUal(ual: string | undefined): string | undefined {
  if (!ual) return undefined;
  try {
    return parseDeterministicKnowledgeAssetUal(ual).ual;
  } catch {
    return undefined;
  }
}
