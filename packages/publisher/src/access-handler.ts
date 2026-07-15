import type { StreamHandler, EventBus } from '@origintrail-official/dkg-core';
import {
  DKGEvent,
  decodeAccessRequest,
  encodeAccessResponse,
  ed25519Verify,
  assertSafeIri,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { computePrivateRootV10 as computePrivateRoot } from './merkle.js';
import { resolveKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';

const DKG_NS = 'http://dkg.io/ontology/';

export type AccessPolicy = 'public' | 'ownerOnly' | 'allowList';

interface KAMeta {
  rootEntity: string;
  /**
   * ALL distinct member roots bound by the meta query (binding order).
   * On the collapsed multi-root shape (RFC ka-metadata-trim P3.1) a bare-UAL
   * request cannot name a member, so the handler scans these for the first
   * root that actually has a private bag instead of denying on an
   * engine-arbitrary first binding (Codex review "multi-root-access").
   */
  rootEntities: string[];
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

      // Codex review "multi-root-access" hardening: on the collapsed
      // multi-root shape, SPARQL binding order is unspecified — the first
      // bound root may have no private bag even though another member does
      // (bags are stored strictly per root). Serve the FIRST member root
      // that actually has a bag; the ambiguous-pairing guard below already
      // forces the attested privateMerkleRoot to be recomputed over the
      // served triples, so the attestation always matches what is sent.
      // Single-root KAs (and legacy `<ual>/<n>` requests, inherently 1:1)
      // are unchanged.
      let servedRootEntity = meta.rootEntity;
      let privateQuads: Quad[] | undefined;
      let hasPrivate = false;
      if (meta.graphScope) {
        privateQuads = await this.privateStore.getKnowledgeAssetPrivateTriples(
          meta.contextGraphId,
          meta.graphScope,
          meta.subGraphName,
        );
        hasPrivate = privateQuads.length > 0;
      } else {
        for (const root of meta.rootEntities) {
          if (
            this.privateStore.hasPrivateTriples(meta.contextGraphId, root, meta.subGraphName) ||
            (await this.privateStore.hasPrivateTriplesInStore(meta.contextGraphId, root, meta.subGraphName))
          ) {
            servedRootEntity = root;
            hasPrivate = true;
            break;
          }
        }
      }

      if (!hasPrivate) {
        return this.deny('No private triples available for this KA');
      }

      const effectivePolicy = this.resolveAccessPolicy(meta, hasPrivate);

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

      privateQuads ??= await this.privateStore.getPrivateTriples(
        meta.contextGraphId,
        servedRootEntity,
        meta.subGraphName,
      );

      if (meta.graphScope && meta.privateMerkleRoot) {
        const actualPrivateRoot = computePrivateRoot(privateQuads);
        if (
          !actualPrivateRoot
          || toHex(actualPrivateRoot) !== toHex(meta.privateMerkleRoot)
        ) {
          return this.deny('Private content does not match the durable KA commitment');
        }
      }

      const nquads = privateQuads
        .map(
          (q) => q.graph
            ? `<${q.subject}> <${q.predicate}> ${q.object} <${q.graph}> .`
            : `<${q.subject}> <${q.predicate}> ${q.object} .`,
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
    const graphScoped = await this.queryGraphScopedKAMeta(kaUal);
    if (graphScoped) return graphScoped;
    const direct = await this.queryKAMeta(kaUal);
    if (direct) return direct;
    // Read-both (RFC ka-metadata-trim P3.1): older requesters address private
    // content by the legacy token row `<ual>/<n>`; the collapsed shape keys
    // everything on the bare UAL. Strip a numeric suffix and retry once so
    // old-client requests keep resolving against new-shape stores.
    const legacyToken = /^(.+)\/\d+$/.exec(kaUal);
    if (legacyToken && legacyToken[1]) {
      return this.queryKAMeta(legacyToken[1]);
    }
    return null;
  }

  /** Resolve V2 metadata through the durable StorageACK head, never VM wire rows. */
  private async queryGraphScopedKAMeta(kaUal: string): Promise<KAMeta | null> {
    const safeUal = assertSafeIri(kaUal);
    const candidates = await this.store.query(
      `SELECT ?contextGraphId ?assertionVersion ?subGraphName WHERE {
        GRAPH ?g {
          ?head <${DKG_NS}contentScopeVersion> "${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<http://www.w3.org/2001/XMLSchema#integer> ;
            <${DKG_NS}kaUal> <${safeUal}> ;
            <${DKG_NS}assertionVersion> ?assertionVersion ;
            <${DKG_NS}shareOperationId> ?shareOperationId .
          ?operation <${DKG_NS}shareOperationId> ?shareOperationId ;
            <${DKG_NS}contextGraphId> ?contextGraphId .
          OPTIONAL { ?operation <${DKG_NS}subGraphName> ?subGraphName }
        }
      }`,
    );
    if (candidates.type !== 'bindings' || candidates.bindings.length === 0) return null;

    const distinct = new Map<string, { contextGraphId: string; assertionVersion: string; subGraphName?: string }>();
    for (const binding of candidates.bindings) {
      const contextGraphId = stripLiteral(binding['contextGraphId'] ?? '').trim();
      const assertionVersion = stripLiteral(binding['assertionVersion'] ?? '').trim();
      const subGraphName = binding['subGraphName']
        ? stripLiteral(binding['subGraphName']).trim()
        : undefined;
      if (!contextGraphId || !/^[1-9][0-9]*$/.test(assertionVersion)) {
        throw new Error('Corrupt graph-scoped access metadata');
      }
      if (subGraphName && !validateSubGraphName(subGraphName).valid) {
        throw new Error('Corrupt graph-scoped access sub-graph metadata');
      }
      distinct.set(`${contextGraphId}\0${assertionVersion}\0${subGraphName ?? ''}`, {
        contextGraphId,
        assertionVersion,
        ...(subGraphName ? { subGraphName } : {}),
      });
    }
    if (distinct.size !== 1) {
      throw new Error('Ambiguous graph-scoped access metadata');
    }
    const candidate = [...distinct.values()][0];
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId: candidate.contextGraphId,
      kaUal,
      subGraphName: candidate.subGraphName,
    });
    if (
      !head
      || head.assertionVersion !== candidate.assertionVersion
      || head.privateTripleCount <= 0
      || !head.privateMerkleRoot
      || !head.accessPolicy
    ) {
      throw new Error('Incomplete graph-scoped access metadata');
    }
    const graphScope = createGraphKnowledgeAssetScope(kaUal, head.assertionVersion);
    return {
      rootEntity: '',
      rootEntities: [],
      contextGraphId: candidate.contextGraphId,
      subGraphName: candidate.subGraphName,
      graphScope,
      privateMerkleRoot: hexToBytes(head.privateMerkleRoot),
      privateTripleCount: head.privateTripleCount,
      accessPolicy: head.accessPolicy,
      publisherPeerId: head.publisherPeerId,
      allowedPeers: head.allowedPeers,
    };
  }

  private async queryKAMeta(kaUal: string): Promise<KAMeta | null> {
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

function isAccessPolicy(value: string | undefined): value is AccessPolicy {
  return value === 'public' || value === 'ownerOnly' || value === 'allowList';
}
