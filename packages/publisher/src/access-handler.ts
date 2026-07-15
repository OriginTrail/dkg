import type {
  StreamHandler,
  EventBus,
  GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import {
  DKGEvent,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  decodeAccessRequest,
  encodeAccessResponse,
  ed25519Verify,
  assertSafeIri,
  knowledgeAssetLayerGraphUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
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

      let servedRootEntity: string | undefined;
      let hasPrivate: boolean;
      if (meta.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
        // V2 metadata commits the complete private payload as one exact
        // `(UAL, assertionVersion)` graph. Do not infer membership from RDF
        // subjects and do not touch the legacy shared private bucket.
        hasPrivate = (meta.privateTripleCount ?? 0) > 0;
      } else {
        // Existing collapsed multi-root KAs have one private bag per root and
        // no reliable root-to-private-root pairing. Preserve their read-only
        // lookup by selecting the first member whose legacy bag exists.
        servedRootEntity = meta.rootEntity;
        hasPrivate = false;
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

      let privateQuads: Quad[];
      if (meta.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
        privateQuads = await this.privateStore.getKnowledgeAssetPrivateTriples(
          meta.contextGraphId,
          meta.scope,
          meta.subGraphName,
        );
        if (privateQuads.length !== meta.privateTripleCount) {
          return this.deny(
            `Private KA integrity check failed: metadata declares ${meta.privateTripleCount} triples, ` +
              `found ${privateQuads.length}`,
          );
        }
        const computedPrivateRoot = computePrivateRoot(privateQuads);
        if (
          !computedPrivateRoot
          || !meta.privateMerkleRoot
          || !bytesEqual(computedPrivateRoot, meta.privateMerkleRoot)
        ) {
          return this.deny('Private KA integrity check failed: Merkle root mismatch');
        }
      } else {
        privateQuads = await this.privateStore.getPrivateTriples(
          meta.contextGraphId,
          servedRootEntity!,
          meta.subGraphName,
        );
      }

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
        .map((q) => serializeAccessQuad(q))
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

    const direct = await this.queryLegacyKAMeta(kaUal);
    if (direct) return direct;
    // Read-both (RFC ka-metadata-trim P3.1): older requesters address private
    // content by the legacy token row `<ual>/<n>`; the collapsed shape keys
    // everything on the bare UAL. Strip a numeric suffix and retry once so
    // old-client requests keep resolving against new-shape stores.
    const legacyToken = /^(.+)\/\d+$/.exec(kaUal);
    if (legacyToken && legacyToken[1]) {
      return this.queryLegacyKAMeta(legacyToken[1]);
    }
    return null;
  }

  private async queryGraphScopedKAMeta(
    kaUal: string,
  ): Promise<GraphScopedKAMeta | null> {
    const safeUal = assertSafeIri(kaUal);
    const result = await this.store.query(
      `SELECT ?g ?scopeVersion ?kaUal ?assertionVersion ?assertionGraph ?contextGraph ` +
        `?privateMerkleRoot ?privateTripleCount ?accessPolicy ?publisherPeerId ` +
        `?attributedTo ?sgName ?allowedPeer WHERE {
        GRAPH ?g {
          <${safeUal}> <${DKG_NS}contentScopeVersion> ?scopeVersion .
          OPTIONAL { <${safeUal}> <${DKG_NS}kaUal> ?kaUal }
          OPTIONAL { <${safeUal}> <${DKG_NS}assertionVersion> ?assertionVersion }
          OPTIONAL { <${safeUal}> <${DKG_NS}assertionGraph> ?assertionGraph }
          OPTIONAL { <${safeUal}> <${DKG_NS}contextGraph> ?contextGraph }
          OPTIONAL { <${safeUal}> <${DKG_NS}privateMerkleRoot> ?privateMerkleRoot }
          OPTIONAL { <${safeUal}> <${DKG_NS}privateTripleCount> ?privateTripleCount }
          OPTIONAL { <${safeUal}> <${DKG_NS}accessPolicy> ?accessPolicy }
          OPTIONAL { <${safeUal}> <${DKG_NS}publisherPeerId> ?publisherPeerId }
          OPTIONAL { <${safeUal}> <http://www.w3.org/ns/prov#wasAttributedTo> ?attributedTo }
          OPTIONAL { <${safeUal}> <${DKG_NS}subGraphName> ?sgName }
          OPTIONAL { <${safeUal}> <${DKG_NS}allowedPeer> ?allowedPeer }
        }
      }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;

    const values = (field: string): string[] => [
      ...new Set(
        result.bindings
          .map((row) => row[field])
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];
    const requireSingle = (field: string): string => {
      const candidates = values(field);
      if (candidates.length !== 1) {
        throw new Error(
          `Graph-scoped KA ${kaUal} has ${candidates.length === 0 ? 'missing' : 'ambiguous'} ${field} metadata`,
        );
      }
      return candidates[0] as string;
    };
    const optionalSingle = (field: string): string | undefined => {
      const candidates = values(field);
      if (candidates.length > 1) {
        throw new Error(`Graph-scoped KA ${kaUal} has ambiguous ${field} metadata`);
      }
      return candidates[0];
    };
    const parseInteger = (raw: string, field: string): bigint => {
      const value = stripLiteral(raw);
      if (!/^-?\d+$/.test(value)) {
        throw new Error(`Graph-scoped KA ${kaUal} has invalid ${field}: ${raw}`);
      }
      return BigInt(value);
    };

    const scopeVersions = values('scopeVersion').map((raw) =>
      parseInteger(raw, 'contentScopeVersion'),
    );
    const uniqueScopeVersions = [...new Set(scopeVersions.map(String))];
    if (uniqueScopeVersions.length !== 1) {
      throw new Error(`Graph-scoped KA ${kaUal} has ambiguous contentScopeVersion metadata`);
    }
    const scopeVersion = BigInt(uniqueScopeVersions[0] as string);
    if (scopeVersion === 1n) return null;
    if (scopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new Error(`Unsupported KA contentScopeVersion: ${scopeVersion}`);
    }

    const metadataUal = requireSingle('kaUal');
    if (metadataUal !== safeUal) {
      throw new Error(`Graph-scoped KA metadata UAL mismatch: requested ${safeUal}, found ${metadataUal}`);
    }

    const contextGraphUri = requireSingle('contextGraph');
    const contextGraphPrefix = 'did:dkg:context-graph:';
    if (!contextGraphUri.startsWith(contextGraphPrefix)) {
      throw new Error(`Graph-scoped KA ${kaUal} has invalid contextGraph metadata`);
    }
    const contextGraphId = contextGraphUri.slice(contextGraphPrefix.length);
    if (!contextGraphId) {
      throw new Error(`Graph-scoped KA ${kaUal} has an empty context graph id`);
    }
    const expectedMetaGraph = `${contextGraphUri}/_meta`;
    const metadataGraph = requireSingle('g');
    if (metadataGraph !== expectedMetaGraph) {
      throw new Error(
        `Graph-scoped KA ${kaUal} metadata graph mismatch: expected ${expectedMetaGraph}, found ${metadataGraph}`,
      );
    }

    const subGraphNameRaw = optionalSingle('sgName');
    const subGraphName = subGraphNameRaw === undefined
      ? undefined
      : stripLiteral(subGraphNameRaw);
    if (subGraphName !== undefined) {
      const validation = validateSubGraphName(subGraphName);
      if (!validation.valid) {
        throw new Error(
          `Graph-scoped KA ${kaUal} has invalid subGraphName: ${validation.reason}`,
        );
      }
    }

    const assertionVersion = parseInteger(
      requireSingle('assertionVersion'),
      'assertionVersion',
    ).toString();
    const scope = createGraphKnowledgeAssetScope(safeUal, assertionVersion);
    const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
    );
    const assertionGraph = requireSingle('assertionGraph');
    if (assertionGraph !== expectedAssertionGraph) {
      throw new Error(
        `Graph-scoped KA ${kaUal} assertionGraph mismatch: ` +
          `expected ${expectedAssertionGraph}, found ${assertionGraph}`,
      );
    }

    const privateTripleCountBig = parseInteger(
      requireSingle('privateTripleCount'),
      'privateTripleCount',
    );
    if (
      privateTripleCountBig < 0n
      || privateTripleCountBig > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        `Graph-scoped KA ${kaUal} has invalid privateTripleCount: ${privateTripleCountBig}`,
      );
    }
    const privateTripleCount = Number(privateTripleCountBig);
    const privateRootRaw = optionalSingle('privateMerkleRoot');
    if (privateTripleCount > 0 && privateRootRaw === undefined) {
      throw new Error(`Graph-scoped KA ${kaUal} is missing privateMerkleRoot metadata`);
    }
    if (privateTripleCount === 0 && privateRootRaw !== undefined) {
      throw new Error(`Graph-scoped KA ${kaUal} has a privateMerkleRoot without private content`);
    }
    const privateMerkleRoot = privateRootRaw === undefined
      ? undefined
      : decodeHexBytes32(privateRootRaw, `Graph-scoped KA ${kaUal} privateMerkleRoot`);

    const rawPolicy = optionalSingle('accessPolicy');
    const parsedPolicy = rawPolicy === undefined ? undefined : stripLiteral(rawPolicy);
    const accessPolicy = isAccessPolicy(parsedPolicy) ? parsedPolicy : undefined;
    const hasInvalidExplicitPolicy = parsedPolicy !== undefined && !isAccessPolicy(parsedPolicy);
    const publisherPeerIdRaw = optionalSingle('publisherPeerId');
    const attributedToRaw = optionalSingle('attributedTo');
    const publisherPeerId = publisherPeerIdRaw !== undefined
      ? stripLiteral(publisherPeerIdRaw)
      : attributedToRaw !== undefined
        ? stripLiteral(attributedToRaw)
        : undefined;
    const allowedPeers = values('allowedPeer').map(stripLiteral);

    return {
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      scope,
      rootEntities: [],
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

function decodeHexBytes32(raw: string, field: string): Uint8Array {
  const hex = stripLiteral(raw).replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`${field} must be exactly 32 bytes of hexadecimal data`);
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function serializeAccessQuad(quad: Quad): string {
  const subject = quad.subject.startsWith('_:') ? quad.subject : `<${quad.subject}>`;
  const graph = quad.graph ? ` <${quad.graph}>` : '';
  return `${subject} <${quad.predicate}> ${quad.object}${graph} .`;
}

function isAccessPolicy(value: string | undefined): value is AccessPolicy {
  return value === 'public' || value === 'ownerOnly' || value === 'allowList';
}
