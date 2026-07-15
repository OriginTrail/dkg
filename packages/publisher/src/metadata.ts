import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, LOCAL_TRUSTED_KA_CONTROLS_GRAPH } from '@origintrail-official/dkg-storage';
import {
  validateSubGraphName,
  isSafeIri,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
  contextGraphLayerUri,
  contextGraphDataUri,
  contextGraphMetaUri,
  MemoryLayer,
  ASSERTION_STATE_TO_LAYER,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import type { AssertionState } from '@origintrail-official/dkg-core';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'http://schema.org/';
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const LOCAL_TRUSTED_KA_CONTROL_PREDICATES = new Set([
  `${DKG}accessPolicy`,
  `${DKG}allowedPeer`,
  `${DKG}publisherPeerId`,
]);
const LOCAL_TRUSTED_KA_ANCHOR_PREDICATES = new Set([
  `${DKG}assertionVersion`,
  `${DKG}merkleRoot`,
]);
const LOCAL_TRUSTED_KA_UAL_PREDICATE = `${DKG}kaUal`;
const LOCAL_TRUSTED_KA_SIDECAR_PREDICATES = new Set([
  ...LOCAL_TRUSTED_KA_CONTROL_PREDICATES,
  ...LOCAL_TRUSTED_KA_ANCHOR_PREDICATES,
]);

// RFC ka-metadata-trim Phase 2: the OT-RFC-43 §10.1 dual-write
// (`dkg:rootEntity` + `dkg:entity`, same object) was collapsed back to a
// SINGLE `dkg:rootEntity` row — the predicate every deployed reader already
// resolves. The §10.1 rename is cancelled for the KA/share member list; the
// honest name can land at the next deliberate ontology bump instead of
// doubling every member row in the meantime. Readers stay dual-read
// (ENTITY_PRED_ALT / isEntityPredicate in @origintrail-official/dkg-core)
// because replicas hold dual-written rows synced from older nodes. The
// seal's `assertionRootEntity`/`assertionEntity` pair is untouched
// (author-signed block, assertion-seal.ts).
/** Emit the single member-entity row (`dkg:rootEntity`). */
function entityMemberQuads(subject: string, entity: string, graph: string): Quad[] {
  return [mq(subject, DKG_ROOT_ENTITY_LEGACY, entity, graph)];
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface KCMetadata {
  ual: string;
  contextGraphId: string;
  merkleRoot: Uint8Array;
  publisherPeerId: string;
  /**
   * Durable on-chain agent identifier (EVM address, bare `0x…`). When
   * supplied, `prov:wasAttributedTo` is emitted as `<did:dkg:agent:0x…>`.
   * When omitted, falls back to `lit(publisherPeerId)` for backwards
   * compatibility with callers that don't yet have the agent address.
   * See GH #748.
   */
  agentAddress?: string;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
  timestamp: Date;
  subGraphName?: string;
  /**
   * On-chain author address (bare `0x…`). Used as the
   * `prov:wasAttributedTo` fallback when `agentAddress` isn't threaded —
   * the on-chain `KnowledgeBatch.authorAddress` remains canonical.
   * (The former `dkg:Publication` provenance mirror keyed on
   * `publishOperationId` was dropped — RFC ka-metadata-trim Phase 1,
   * zero readers.)
   */
  authorAddress?: string;
}

export interface KAMetadata {
  rootEntity: string;
  kcUal: string;
  tokenId: bigint;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
}

export interface OnChainProvenance {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  publisherAddress: string;
  batchId: bigint;
  chainId: string;
}

export interface GraphKnowledgeAssetMetadata extends KCMetadata {
  assertionVersion: string | number | bigint;
  publicTripleCount: number;
  privateTripleCount?: number;
  privateMerkleRoot?: Uint8Array;
  assertionGraph: string;
}

function assertSafeContextGraphIdForSparql(contextGraphId: string): void {
  if (/[<>"{}|^`\\\s]/.test(contextGraphId)) {
    throw new Error(`Unsafe contextGraphId for SPARQL graph IRI: "${contextGraphId}"`);
  }
}

function assertSafeSubGraphNameForSparql(subGraphName: string): void {
  const v = validateSubGraphName(subGraphName);
  if (!v.valid) throw new Error(`Unsafe sub-graph name for SPARQL: ${v.reason}`);
}

function assertSafeGraphIriForSparql(graphIri: string): void {
  // GRAPH <...> must not allow delimiter/control chars that can alter query structure.
  if (/[<>"{}|^`\\\s]/.test(graphIri)) {
    throw new Error(`Unsafe graph IRI for SPARQL query: "${graphIri}"`);
  }
}

/**
 * Generate RDF metadata triples for a Knowledge Collection.
 * These go into the context graph's meta graph.
 */
export function generateKCMetadata(
  meta: KCMetadata,
  kaEntries: KAMetadata[],
): Quad[] {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const quads: Quad[] = [];

  // KC metadata. RFC ka-metadata-trim: the `rdf:type dkg:KnowledgeCollection`
  // row and `dkg:kaCount` were dropped (zero readers; the daemon KC counter
  // now counts `dkg:status` subjects). Old-store rows synced from older nodes
  // may still carry them — readers must not assume either shape exclusively.
  quads.push(
    mq(meta.ual, `${DKG}merkleRoot`, lit(toHex(meta.merkleRoot)), metaGraph),
    // KEPT (initially slated as a Phase-1 drop): kafka-plugin discovery
    // (packages/kafka-plugin/src/discovery.ts buildListQuery) joins
    // `?ual dkg:publishedAt ?receivedAt` and ORDERs the KA list by it —
    // a load-bearing reader, so the write stays (+1 quad).
    mq(meta.ual, `${DKG}publishedAt`, dateLit(meta.timestamp), metaGraph),
    mq(meta.ual, `${DKG}accessPolicy`, lit(meta.accessPolicy ?? 'public'), metaGraph),
    mq(meta.ual, `${DKG}publisherPeerId`, lit(meta.publisherPeerId || 'unknown'), metaGraph),
    mq(
      meta.ual,
      `${PROV}wasAttributedTo`,
      // KC publishes always know their author on-chain (`authorAddress`),
      // so prefer that when `agentAddress` wasn't explicitly threaded.
      // Falls back to the peer-ID literal only for legacy/tentative
      // callers with neither identity available.
      // GH #748 Codex round 7: treat `0x0000…0000` as the no-author sentinel
      // (used when `publisherNodeIdentityIdOverride = 0`). Without this guard
      // an unattributed publish would mint `did:dkg:agent:0x000…000`, making
      // the provenance look like a real agent authored the KC.
      ((): string => {
        const candidate = meta.agentAddress ?? meta.authorAddress;
        if (candidate && !isZeroEthAddress(candidate)) {
          return agentDid(candidate);
        }
        return lit(meta.publisherPeerId || 'unknown');
      })(),
      metaGraph,
    ),
    mq(meta.ual, `${DKG}contextGraph`, `did:dkg:context-graph:${meta.contextGraphId}`, metaGraph),
  );

  if (meta.subGraphName) {
    quads.push(mq(meta.ual, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }

  if (meta.allowedPeers?.length) {
    for (const peerId of meta.allowedPeers) {
      quads.push(
        mq(meta.ual, `${DKG}allowedPeer`, lit(peerId), metaGraph),
      );
    }
  }

  // OT-RFC-44 Design B + RFC ka-metadata-trim Phase 3 (P3.1): the bare <ual>
  // IS the Knowledge Asset (post-rc.17 invariant: 1 publish = 1 KA = 1 UAL).
  // The legacy per-token `<ual>/<n>` label rows (`dkg:partOf` + entity pair)
  // are NO LONGER minted — member entities, private counts and private merkle
  // roots all live on the UAL subject directly.
  // NB: deliberately NO `<ual> partOf <ual>` self-edge — that would make the
  // bare node match `?x partOf <ual>` member-enumeration (incl. resolveKA) and
  // double-count members; the collapsed node is purely self-describing.
  // Readers are read-both (UAL-subject ‖ legacy `<ual>/<n>`+partOf) because
  // replicas hold old-shape rows synced from older nodes.
  if (kaEntries.length > 0) {
    const aggPrivateTripleCount = kaEntries.reduce((sum, ka) => sum + ka.privateTripleCount, 0);
    const memberRoots = [...new Set(kaEntries.map((ka) => ka.rootEntity))];
    for (const root of memberRoots) {
      // dual-write dkg:rootEntity + dkg:entity (OT-RFC-43 §10.1).
      quads.push(...entityMemberQuads(meta.ual, root, metaGraph));
    }
    if (aggPrivateTripleCount > 0) {
      quads.push(mq(meta.ual, `${DKG}privateTripleCount`, intLit(aggPrivateTripleCount), metaGraph));
    }
    // All per-root private merkle roots land on the UAL subject (the
    // `<ual>/<n>` row that used to carry them is gone). Distinct-hex dedupe;
    // verifiers treat them as an unordered leaf set (V10MerkleTree dedupes).
    const seenPrivRoots = new Set<string>();
    for (const ka of kaEntries) {
      if (!ka.privateMerkleRoot) continue;
      const hex = toHex(ka.privateMerkleRoot);
      if (seenPrivRoots.has(hex)) continue;
      seenPrivRoots.add(hex);
      quads.push(mq(meta.ual, `${DKG}privateMerkleRoot`, lit(hex), metaGraph));
    }
    // Codex review "multi-root-access": the collapsed shape cannot tie member
    // root N to private bag N — every rootEntity/privateMerkleRoot row shares
    // the bare UAL subject, so the AccessHandler could only pick an
    // engine-arbitrary root (denying or silently mis-serving multi-root
    // private KAs). For MULTI-root publishes, ADDITIONALLY re-emit the
    // pre-trim per-token pairing rows (`<ual>/<tokenId>` + rootEntity/partOf/
    // privateTripleCount/privateMerkleRoot — the 75c53a2ed shape minus the
    // Phase-1/2 zero-reader rows). Single-root publishes — the measured,
    // dominant case — keep the full collapse.
    if (memberRoots.length > 1) {
      for (const ka of kaEntries) {
        const kaUri = `${meta.ual}/${ka.tokenId}`;
        quads.push(
          ...entityMemberQuads(kaUri, ka.rootEntity, metaGraph),
          mq(kaUri, `${DKG}partOf`, meta.ual, metaGraph),
        );
        if (ka.privateTripleCount > 0) {
          quads.push(mq(kaUri, `${DKG}privateTripleCount`, intLit(ka.privateTripleCount), metaGraph));
        }
        if (ka.privateMerkleRoot) {
          quads.push(mq(kaUri, `${DKG}privateMerkleRoot`, lit(toHex(ka.privateMerkleRoot)), metaGraph));
        }
      }
    }
  }

  return quads;
}

/**
 * Phase 1 metadata generated at P2P broadcast time.
 * Same as generateKCMetadata but adds dkg:status "tentative".
 */
export function generateTentativeMetadata(
  meta: KCMetadata,
  kaEntries: KAMetadata[],
): Quad[] {
  const quads = generateKCMetadata(meta, kaEntries);
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  quads.push(
    mq(meta.ual, `${DKG}status`, lit('tentative'), metaGraph),
  );
  return quads;
}

/**
 * Returns the single quad that marks a KC as tentative in the meta graph.
 * Used when promoting to confirmed: delete this quad before inserting confirmed metadata.
 */
export function getTentativeStatusQuad(ual: string, contextGraphId: string): Quad {
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  return mq(ual, `${DKG}status`, lit('tentative'), metaGraph);
}

/**
 * Returns the single quad that marks a KC as confirmed (minimal, no chain provenance).
 * Used by receivers when promoting tentative → confirmed after seeing the chain event.
 */
export function getConfirmedStatusQuad(ual: string, contextGraphId: string): Quad {
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  return mq(ual, `${DKG}status`, lit('confirmed'), metaGraph);
}

/**
 * Status and on-chain provenance quads for a confirmed KC.
 * Used together with KC/KA structure when promoting (receiver) or when storing confirmed-only (publisher).
 */
export function generateConfirmedMetadata(
  ual: string,
  contextGraphId: string,
  provenance: OnChainProvenance,
): Quad[] {
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  // RFC ka-metadata-trim Phase 1: `dkg:blockNumber`, `dkg:blockTimestamp`,
  // `dkg:publisherAddress` and `dkg:chainId` were dropped (zero readers;
  // block number is derivable from `transactionHash` via RPC on demand).
  // The `OnChainProvenance` shape is unchanged — it mirrors the chain
  // receipt, not what gets persisted.
  const quads: Quad[] = [
    mq(ual, `${DKG}status`, lit('confirmed'), metaGraph),
    mq(ual, `${DKG}transactionHash`, lit(provenance.txHash), metaGraph),
    mq(ual, `${DKG}batchId`, intLit(provenance.batchId), metaGraph),
  ];
  return quads;
}

/**
 * Full KC/KA metadata with status "confirmed" and chain provenance (no tentative triple).
 * Use on publisher when on-chain tx succeeds: insert this only, so the graph has either tentative or confirmed, never both.
 */
export function generateConfirmedFullMetadata(
  meta: KCMetadata,
  kaEntries: KAMetadata[],
  provenance: OnChainProvenance,
): Quad[] {
  return [
    ...generateKCMetadata(meta, kaEntries),
    ...generateConfirmedMetadata(meta.ual, meta.contextGraphId, provenance),
  ];
}

/**
 * Constant-size VM metadata for one graph-scoped KA. RDF subjects in the KA
 * payload never become membership, token, ownership, or trust rows here.
 */
export function generateGraphKnowledgeAssetMetadata(
  meta: GraphKnowledgeAssetMetadata,
  status: 'tentative' | 'confirmed',
  provenance?: OnChainProvenance,
): Quad[] {
  const scope = createGraphKnowledgeAssetScope(meta.ual, meta.assertionVersion);
  if (!Number.isSafeInteger(meta.publicTripleCount) || meta.publicTripleCount < 0) {
    throw new Error(`Invalid graph-scoped KA public triple count: ${meta.publicTripleCount}`);
  }
  const privateTripleCount = meta.privateTripleCount ?? 0;
  if (!Number.isSafeInteger(privateTripleCount) || privateTripleCount < 0) {
    throw new Error(`Invalid graph-scoped KA private triple count: ${privateTripleCount}`);
  }
  if (privateTripleCount > 0 && meta.privateMerkleRoot?.length !== 32) {
    throw new Error('Graph-scoped KA private content requires one 32-byte private Merkle root');
  }
  if (privateTripleCount === 0 && meta.privateMerkleRoot !== undefined) {
    throw new Error('Graph-scoped KA private Merkle root requires a positive private triple count');
  }
  if (meta.publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('Graph-scoped KA metadata cannot describe an empty asset');
  }
  assertSafeGraphIriForSparql(meta.assertionGraph);
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const quads = [
    ...generateKCMetadata({ ...meta, ual: scope.ual }, []),
    mq(scope.ual, `${DKG}contentScopeVersion`, intLit(GRAPH_KA_CONTENT_SCOPE_VERSION), metaGraph),
    mq(scope.ual, `${DKG}kaUal`, scope.ual, metaGraph),
    mq(scope.ual, `${DKG}assertionVersion`, intLit(BigInt(scope.assertionVersion)), metaGraph),
    mq(scope.ual, `${DKG}publicTripleCount`, intLit(meta.publicTripleCount), metaGraph),
    mq(scope.ual, `${DKG}privateTripleCount`, intLit(privateTripleCount), metaGraph),
    mq(scope.ual, `${DKG}assertionGraph`, meta.assertionGraph, metaGraph),
  ];
  if (meta.privateMerkleRoot) {
    quads.push(
      mq(scope.ual, `${DKG}privateMerkleRoot`, lit(toHex(meta.privateMerkleRoot)), metaGraph),
    );
  }
  if (status === 'confirmed') {
    if (!provenance) {
      throw new Error('Confirmed graph-scoped KA metadata requires on-chain provenance');
    }
    quads.push(...generateConfirmedMetadata(scope.ual, meta.contextGraphId, provenance));
  } else {
    quads.push(mq(scope.ual, `${DKG}status`, lit('tentative'), metaGraph));
  }
  return quads;
}

/**
 * Persist locally authored access controls outside sync-visible metadata.
 * Durable sync never writes this graph, so an exact recovery can distinguish
 * local policy from controls injected by the former insert-only peer path.
 */
export async function replaceLocallyTrustedKnowledgeAssetControls(
  store: TripleStore,
  ual: string,
  metadataQuads: readonly Quad[],
): Promise<void> {
  assertSafeGraphIriForSparql(ual);
  const version = parseControlVersion(
    readControlAnchor(metadataQuads, `${DKG}assertionVersion`, 'assertionVersion'),
  );
  const root = normalizeControlRoot(
    readControlAnchor(metadataQuads, `${DKG}merkleRoot`, 'merkleRoot'),
  );
  const entry = `${ual}/_local_controls/${version}/${root}`;
  assertSafeGraphIriForSparql(entry);
  const controls = metadataQuads
    .filter(
      (quad) => quad.subject === ual && LOCAL_TRUSTED_KA_SIDECAR_PREDICATES.has(quad.predicate),
    )
    .map((quad) => ({
      ...quad,
      subject: entry,
      graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    }));
  validateLocallyTrustedControlRows(controls);
  await store.insert([
    ...controls,
    {
      subject: entry,
      predicate: LOCAL_TRUSTED_KA_UAL_PREDICATE,
      object: ual,
      graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    },
  ]);
}

/** Read trusted local controls and remap them into the public metadata commit. */
export async function readLocallyTrustedKnowledgeAssetControls(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  incomingMetadataQuads: readonly Quad[],
  options: QueryOptions = {},
): Promise<Quad[]> {
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
  const incomingVersion = parseControlVersion(
    readControlAnchor(incomingMetadataQuads, `${DKG}assertionVersion`, 'assertionVersion'),
  );
  const incomingRoot = normalizeControlRoot(
    readControlAnchor(incomingMetadataQuads, `${DKG}merkleRoot`, 'merkleRoot'),
  );
  const predicates = [...LOCAL_TRUSTED_KA_SIDECAR_PREDICATES]
    .map((predicate) => `<${predicate}>`)
    .join('\n');
  const result = await store.query(`
    SELECT ?entry ?predicate ?object WHERE {
      GRAPH <${LOCAL_TRUSTED_KA_CONTROLS_GRAPH}> {
        ?entry <${LOCAL_TRUSTED_KA_UAL_PREDICATE}> <${ual}> .
        ?entry ?predicate ?object .
        VALUES ?predicate { ${predicates} }
      }
    }
  `, options);
  if (result.type !== 'bindings') return [];
  const rowsByEntry = new Map<string, Quad[]>();
  for (const row of result.bindings) {
    const predicate = row.predicate?.replace(/^<|>$/g, '');
    if (
      !row.entry
      || !predicate
      || row.object === undefined
      || !LOCAL_TRUSTED_KA_SIDECAR_PREDICATES.has(predicate)
    ) {
      continue;
    }
    const rows = rowsByEntry.get(row.entry) ?? [];
    rows.push({
      subject: row.entry,
      predicate,
      object: row.object,
      graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    });
    rowsByEntry.set(row.entry, rows);
  }
  const candidates: Array<{ version: bigint; rows: Quad[] }> = [];
  for (const rows of rowsByEntry.values()) {
    validateLocallyTrustedControlRows(rows);
    const sidecarVersion = parseControlVersion(
      readControlAnchor(rows, `${DKG}assertionVersion`, 'sidecar assertionVersion'),
    );
    const sidecarRoot = normalizeControlRoot(
      readControlAnchor(rows, `${DKG}merkleRoot`, 'sidecar merkleRoot'),
    );
    if (sidecarVersion > incomingVersion) continue;
    if (sidecarVersion === incomingVersion && sidecarRoot !== incomingRoot) continue;
    candidates.push({ version: sidecarVersion, rows });
  }
  if (candidates.length === 0) return [];
  const highestVersion = candidates.reduce(
    (highest, candidate) => candidate.version > highest ? candidate.version : highest,
    candidates[0]!.version,
  );
  const highest = candidates.filter((candidate) => candidate.version === highestVersion);
  if (highest.length !== 1) return [];
  return highest[0]!.rows
    .filter((quad) => LOCAL_TRUSTED_KA_CONTROL_PREDICATES.has(quad.predicate))
    .map((quad) => ({ ...quad, subject: ual, graph: metaGraph }));
}

function validateLocallyTrustedControlRows(rows: readonly Quad[]): void {
  const values = (predicate: string) => [...new Set(
    rows.filter((quad) => quad.predicate === predicate).map((quad) => quad.object),
  )];
  const policies = values(`${DKG}accessPolicy`);
  const publishers = values(`${DKG}publisherPeerId`);
  const allowedPeers = values(`${DKG}allowedPeer`);
  if (policies.length !== 1 || !['"public"', '"ownerOnly"', '"allowList"'].includes(policies[0]!)) {
    throw new Error('Locally trusted KA controls require exactly one valid accessPolicy');
  }
  if (publishers.length !== 1 || !/^"(?:[^"\\]|\\.)+"$/.test(publishers[0]!)) {
    throw new Error('Locally trusted KA controls require exactly one publisherPeerId');
  }
  if (
    (policies[0] === '"allowList"' && allowedPeers.length === 0)
    || (policies[0] !== '"allowList"' && allowedPeers.length > 0)
    || allowedPeers.some((peer) => !/^"(?:[^"\\]|\\.)+"$/.test(peer))
  ) {
    throw new Error('Locally trusted KA controls have an invalid allowedPeer envelope');
  }
}

function readControlAnchor(
  quads: readonly Quad[],
  predicate: string,
  label: string,
): string {
  const values = [...new Set(
    quads.filter((quad) => quad.predicate === predicate).map((quad) => quad.object),
  )];
  if (values.length !== 1) {
    throw new Error(`Locally trusted KA controls require exactly one ${label}`);
  }
  return values[0]!;
}

function parseControlVersion(raw: string): bigint {
  const lexical = raw.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  if (!/^\d+$/.test(lexical)) throw new Error(`Invalid trusted-control assertionVersion: ${raw}`);
  return BigInt(lexical);
}

function normalizeControlRoot(raw: string): string {
  const lexical = raw.match(/^"([^"]*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  const root = lexical.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(root)) throw new Error(`Invalid trusted-control merkleRoot: ${raw}`);
  return root;
}

/**
 * GH #936 — explicit, deterministic per-root token map
 * (`<ual>/<tokenId>` dkg:tokenId / dkg:entity) for MULTI-root KCs. Emitted via a
 * SHARED helper so the publisher (originator) and the gossip / chain-reconcile
 * replica paths expose an IDENTICAL, queryable rootEntity→tokenId mapping — the
 * same multi-root KC must not surface different token rows depending on which
 * node materialised it. Kept OUT of generateKCMetadata (metadata.test.ts pins
 * that output to the collapsed `dkg:rootEntity` shape and forbids these
 * predicates); both call sites append these rows alongside the confirmed
 * metadata. `kaEntries` MUST already be in the canonical
 * (lexicographically-sorted-by-rootEntity) tokenId order — both call sites sort
 * before minting.
 */
/**
 * GH #936 — the canonical root ordering used for deterministic compatibility
 * tokenId assignment. The publisher (originator), the gossip path, and the
 * chain-reconcile path MUST all assign `<ual>/<tokenId>` over roots sorted by
 * THIS comparator, so every node derives the identical rootEntity→tokenId map.
 * Shared here so the invariant is API-enforced rather than comment-enforced.
 */
export function compareRootIris(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildDeterministicTokenRows(
  ual: string,
  kaEntries: ReadonlyArray<{ tokenId: bigint; rootEntity: string }>,
  metaGraph: string,
): Quad[] {
  if (kaEntries.length <= 1) return [];
  const rows: Quad[] = [];
  for (const ka of kaEntries) {
    const subject = `${ual}/${ka.tokenId}`;
    rows.push(
      mq(subject, `${DKG}tokenId`, intLit(ka.tokenId), metaGraph),
      mq(subject, DKG_ENTITY, ka.rootEntity, metaGraph),
    );
  }
  return rows;
}

function mq(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function lit(val: string): string {
  const escaped = val
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function intLit(val: number | bigint): string {
  return `"${val}"^^<${XSD}integer>`;
}

/**
 * Canonical builder for the "minimal scoped meta" rows the RS prover + access
 * handler read off a scoped context-graph meta graph: `dkg:batchId` (the UAL
 * resolution edge) + `dkg:merkleRoot`, the collapsed `dkg:rootEntity`
 * (+ `dkg:privateMerkleRoot`) member rows on the UAL subject, and — for
 * MULTI-root KCs only — the `<ual>/<tokenId>` `rootEntity`/`partOf`/
 * `privateMerkleRoot` pairing rows so each member root↔privateMerkleRoot stays
 * joinable on its own token subject (single-root keeps the full collapse).
 *
 * Single source of truth for the two PUBLISH paths that promote a confirmed KC
 * into a scoped meta graph: `DKGPublisher.publishFromSharedMemory` (the SWM
 * path) and `DKGPublisher.promoteConfirmedKCToScopedGraph` (the one-shot
 * `publish()` RS promotion, #1266). Output is byte-identical to the inline blocks
 * those two previously carried.
 *
 * `restateKaPartition` below writes the SAME shape but from a different data
 * model — per-root Maps + POSITIONAL `<ual>/<n>` token labels + a DELETE/INSERT
 * restate — so it intentionally does NOT call this builder. Keep the two shapes
 * in sync (see the note in `restateKaPartition`).
 */
export function buildScopedMinimalMeta(
  ual: string,
  kaId: bigint,
  merkleRoot: Uint8Array,
  manifestEntries: ReadonlyArray<{ rootEntity: string; tokenId: bigint; privateMerkleRoot?: Uint8Array }>,
  metaGraph: string,
): Quad[] {
  const out: Quad[] = [
    mq(ual, `${DKG}batchId`, intLit(kaId), metaGraph),
    mq(ual, `${DKG}merkleRoot`, lit(toHex(merkleRoot)), metaGraph),
  ];
  const multiRoot = new Set(manifestEntries.map((ka) => ka.rootEntity)).size > 1;
  const seenRoots = new Set<string>();
  const seenPrivRoots = new Set<string>();
  for (const ka of manifestEntries) {
    if (!seenRoots.has(ka.rootEntity)) {
      seenRoots.add(ka.rootEntity);
      out.push(...entityMemberQuads(ual, ka.rootEntity, metaGraph));
    }
    if (ka.privateMerkleRoot && ka.privateMerkleRoot.length > 0) {
      const privHex = toHex(ka.privateMerkleRoot);
      if (!seenPrivRoots.has(privHex)) {
        seenPrivRoots.add(privHex);
        out.push(mq(ual, `${DKG}privateMerkleRoot`, lit(privHex), metaGraph));
      }
    }
    // MULTI-root only: re-emit the `<ual>/<tokenId>` token rows so each member
    // root carries its OWN privateMerkleRoot on a shared subject (recoverable
    // pairing). Not deduped — every token keeps its pairing row.
    if (multiRoot) {
      const kaUri = `${ual}/${ka.tokenId}`;
      out.push(
        ...entityMemberQuads(kaUri, ka.rootEntity, metaGraph),
        mq(kaUri, `${DKG}partOf`, ual, metaGraph),
      );
      if (ka.privateMerkleRoot && ka.privateMerkleRoot.length > 0) {
        out.push(mq(kaUri, `${DKG}privateMerkleRoot`, lit(toHex(ka.privateMerkleRoot)), metaGraph));
      }
    }
  }
  return out;
}

function dateLit(d: Date): string {
  return `"${d.toISOString()}"^^<${XSD}dateTime>`;
}

/**
 * Returns true for the EVM zero address sentinel `0x0000…0000` (any casing).
 * Used to detect "unattributed publish" intent (`publisherNodeIdentityIdOverride = 0`)
 * so callers don't mint a fake `did:dkg:agent:0x000…000` URI for it.
 */
export function isZeroEthAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

export function agentDid(address: string): string {
  // GH #748 Codex round 3: canonicalise EVM-address DID subjects to lowercase
  // so the same wallet doesn't split into multiple RDF subjects when callers
  // pass checksummed vs lowercased forms (e.g. `ethers.getAddress(...)` in
  // workspace-handler returns checksummed, while config files often carry
  // lowercase). Mirrors `canonicalAgentDidSubject` in
  // `packages/agent/src/profile.ts:20` — the canonical writer for agent
  // registry records, which has lowercased EVM subjects since A-12. Non-EVM
  // shapes (peer IDs, names) pass through unchanged.
  const subject = /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
  return `did:dkg:agent:${subject}`;
}

// RFC ka-metadata-trim Phase 3 (P3.4): `generateShareTransitionMetadata`
// (spec §8, the `urn:dkg:share:{opId} a dkg:ShareTransition` record in
// `_shared_memory_meta`) was deleted. Its only repo-wide consumer was the
// node-ui on-chain-receipt hook's first hop, which now reads the
// seal-subject receipt rows in `_meta` directly and only falls back to
// ShareTransition rows for old stores (read-both).

/** Shared memory metadata: no UAL; stored in _shared_memory_meta graph. */
export interface ShareMetadata {
  shareOperationId: string;
  contextGraphId: string;
  rootEntities: string[];
  publisherPeerId: string;
  /**
   * Durable on-chain agent identifier (EVM address, bare `0x…`). When
   * supplied, `prov:wasAttributedTo` is emitted as `<did:dkg:agent:0x…>`.
   * When omitted, falls back to `lit(publisherPeerId)` so legacy callers
   * (notably the gossip-received `SharedMemoryHandler` path) continue to
   * work until the peer-ID → agent-address lookup is wired in. See GH #748.
   */
  agentAddress?: string;
  timestamp: Date;
  subGraphName?: string;
}

/** @deprecated Use ShareMetadata */
export type WorkspaceMetadata = ShareMetadata;

/**
 * Generate RDF metadata triples for a shared memory write.
 * Stored in context graph's _shared_memory_meta graph (not _meta).
 */
export function generateShareMetadata(
  meta: ShareMetadata,
  swmMetaGraph: string,
): Quad[] {
  const quads: Quad[] = [];
  const subject = `urn:dkg:share:${meta.contextGraphId}:${meta.shareOperationId}`;

  quads.push(
    mq(subject, `${RDF}type`, `${DKG}WorkspaceOperation`, swmMetaGraph),
    mq(subject, `${DKG}contextGraphId`, lit(meta.contextGraphId), swmMetaGraph),
    mq(subject, `${DKG}shareOperationId`, lit(meta.shareOperationId), swmMetaGraph),
    mq(subject, `${DKG}publisherPeerId`, lit(meta.publisherPeerId), swmMetaGraph),
    mq(
      subject,
      `${PROV}wasAttributedTo`,
      meta.agentAddress ? agentDid(meta.agentAddress) : lit(meta.publisherPeerId),
      swmMetaGraph,
    ),
    mq(
      subject,
      `${DKG}publishedAt`,
      dateLit(meta.timestamp),
      swmMetaGraph,
    ),
  );

  if (meta.subGraphName) {
    quads.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), swmMetaGraph));
  }

  for (const rootEntity of meta.rootEntities) {
    quads.push(...entityMemberQuads(subject, rootEntity, swmMetaGraph));
  }

  return quads;
}

/** @deprecated Use generateShareMetadata */
export const generateWorkspaceMetadata = generateShareMetadata;

/** Metadata for one atomic graph-scoped KA share operation. */
export interface KnowledgeAssetShareMetadata {
  shareOperationId: string;
  contextGraphId: string;
  kaUal: string;
  assertionVersion: string | number | bigint;
  publicTripleCount: number;
  /** One KA-level private commitment. Empty/undefined when the KA is public-only. */
  privateMerkleRoot?: Uint8Array;
  /** Number of private triples committed by privateMerkleRoot. */
  privateTripleCount?: number;
  publisherPeerId: string;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: readonly string[];
  agentAddress?: string;
  timestamp: Date;
  subGraphName?: string;
}

/**
 * Emit constant-size metadata for a complete KA graph.
 *
 * There are intentionally no entity membership or ownership rows. RDF
 * subjects remain data in the per-KA graph and never become control-plane
 * records.
 */
export function generateKnowledgeAssetShareMetadata(
  meta: KnowledgeAssetShareMetadata,
  swmMetaGraph: string,
): Quad[] {
  const scope = createGraphKnowledgeAssetScope(meta.kaUal, meta.assertionVersion);
  if (!Number.isSafeInteger(meta.publicTripleCount) || meta.publicTripleCount < 0) {
    throw new Error(`Invalid graph-scoped KA public triple count: ${meta.publicTripleCount}`);
  }
  const privateTripleCount = meta.privateTripleCount ?? 0;
  if (!Number.isSafeInteger(privateTripleCount) || privateTripleCount < 0) {
    throw new Error(`Invalid graph-scoped KA private triple count: ${privateTripleCount}`);
  }
  const privateMerkleRoot = meta.privateMerkleRoot;
  if (privateTripleCount > 0 && privateMerkleRoot?.length !== 32) {
    throw new Error('Graph-scoped KA private content requires one 32-byte private Merkle root');
  }
  if (privateTripleCount === 0 && (privateMerkleRoot?.length ?? 0) > 0) {
    throw new Error('Graph-scoped KA private Merkle root requires a positive private triple count');
  }
  if (meta.publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('Graph-scoped KA share cannot contain zero public and zero private triples');
  }
  const rawAllowedPeers = meta.allowedPeers ?? [];
  const allowedPeers = [...new Set(rawAllowedPeers.map((peer) => peer.trim()).filter(Boolean))];
  if (
    allowedPeers.length !== rawAllowedPeers.length
    || (meta.accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (meta.accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) {
    throw new Error('Graph-scoped KA share has an invalid access-policy peer envelope');
  }
  const subject = `urn:dkg:share:${meta.contextGraphId}:${meta.shareOperationId}`;
  const quads = [
    mq(subject, `${RDF}type`, `${DKG}WorkspaceOperation`, swmMetaGraph),
    mq(subject, `${DKG}contextGraphId`, lit(meta.contextGraphId), swmMetaGraph),
    mq(subject, `${DKG}shareOperationId`, lit(meta.shareOperationId), swmMetaGraph),
    mq(subject, `${DKG}contentScopeVersion`, intLit(GRAPH_KA_CONTENT_SCOPE_VERSION), swmMetaGraph),
    mq(subject, `${DKG}kaUal`, scope.ual, swmMetaGraph),
    mq(subject, `${DKG}assertionVersion`, intLit(BigInt(scope.assertionVersion)), swmMetaGraph),
    mq(subject, `${DKG}publicQuadsCount`, intLit(meta.publicTripleCount), swmMetaGraph),
    mq(subject, `${DKG}privateTripleCount`, intLit(privateTripleCount), swmMetaGraph),
    mq(subject, `${DKG}publisherPeerId`, lit(meta.publisherPeerId), swmMetaGraph),
    mq(
      subject,
      `${PROV}wasAttributedTo`,
      meta.agentAddress ? agentDid(meta.agentAddress) : lit(meta.publisherPeerId),
      swmMetaGraph,
    ),
    mq(subject, `${DKG}publishedAt`, dateLit(meta.timestamp), swmMetaGraph),
  ];
  if (privateMerkleRoot?.length === 32) {
    quads.push(
      mq(subject, `${DKG}privateMerkleRoot`, lit(`0x${toHex(privateMerkleRoot)}`), swmMetaGraph),
    );
  }
  if (meta.accessPolicy) {
    quads.push(mq(subject, `${DKG}accessPolicy`, lit(meta.accessPolicy), swmMetaGraph));
    for (const peer of allowedPeers) {
      quads.push(mq(subject, `${DKG}allowedPeer`, lit(peer), swmMetaGraph));
    }
  }
  if (meta.subGraphName) {
    quads.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), swmMetaGraph));
  }
  return quads;
}

/**
 * Generate ownership triples for shared memory root entities.
 * Each triple: `<rootEntity> dkg:sharedMemoryOwner "creatorPeerId"` in SWM meta.
 * Used to persist the in-memory sharedMemoryOwnedEntities map so it survives restarts.
 */
export function generateOwnershipQuads(
  rootEntities: { rootEntity: string; creatorPeerId: string }[],
  swmMetaGraph: string,
): Quad[] {
  return rootEntities.map((entry) =>
    mq(entry.rootEntity, `${DKG}workspaceOwner`, lit(entry.creatorPeerId), swmMetaGraph),
  );
}

/**
 * Resolve a KC's UAL from the _meta graph by its batchId.
 * Uses String(batchId) to avoid Number precision loss for large bigints.
 */
export async function resolveUalByBatchId(
  store: TripleStore,
  metaGraph: string,
  batchId: bigint,
): Promise<string | undefined> {
  assertSafeGraphIriForSparql(metaGraph);
  const result = await store.query(
    `SELECT ?ual WHERE { GRAPH <${metaGraph}> { ?ual <${DKG}batchId> "${batchId}"^^<${XSD}integer> } } LIMIT 1`,
  );
  if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
  return result.bindings[0]['ual'] ?? undefined;
}

/**
 * Update the merkle root for a KC in the _meta graph after a data update.
 * Shared between DKGPublisher (local updates) and UpdateHandler (gossip).
 */
export async function updateMetaMerkleRoot(
  store: TripleStore,
  graphManager: GraphManager,
  contextGraphId: string,
  batchId: bigint,
  newMerkleRoot: Uint8Array,
): Promise<void> {
  assertSafeContextGraphIdForSparql(contextGraphId);
  const metaGraph = graphManager.metaGraphUri(contextGraphId);
  const ual = await resolveUalByBatchId(store, metaGraph, batchId);
  if (!ual) return;
  assertSafeGraphIriForSparql(ual);

  const rootLiteral = `"${toHex(newMerkleRoot)}"`;

  // Prefer a single SPARQL DELETE/INSERT to avoid an intermediate
  // state with no dkg:merkleRoot when update succeeds.
  try {
    await store.query(
      `DELETE { GRAPH <${metaGraph}> { <${ual}> <${DKG}merkleRoot> ?oldRoot } }
       INSERT { GRAPH <${metaGraph}> { <${ual}> <${DKG}merkleRoot> ${rootLiteral} } }
       WHERE  { GRAPH <${metaGraph}> { OPTIONAL { <${ual}> <${DKG}merkleRoot> ?oldRoot } } }`,
    );
    return;
  } catch {
    // Some backends may not support SPARQL updates via query().
    // Fallback preserves correctness by inserting first, then pruning old roots.
  }

  const existing = await store.query(
    `SELECT ?root WHERE { GRAPH <${metaGraph}> { <${ual}> <${DKG}merkleRoot> ?root } }`,
  );
  await store.insert([{
    subject: ual,
    predicate: `${DKG}merkleRoot`,
    object: rootLiteral,
    graph: metaGraph,
  }]);
  if (existing.type !== 'bindings' || existing.bindings.length === 0) return;

  const staleRootQuads: Quad[] = existing.bindings
    .map((row) => row['root'])
    .filter((root): root is string => typeof root === 'string' && root.length > 0 && root !== rootLiteral)
    .map((root) => ({
      subject: ual,
      predicate: `${DKG}merkleRoot`,
      object: root,
      graph: metaGraph,
    }));
  if (staleRootQuads.length > 0) {
    await store.delete(staleRootQuads);
  }
}

const SKOLEM_INFIX = '/.well-known/genid/';

// ── GH#842 materialization version guard ───────────────────────────────
//
// A KA's public triples are projected into the triple store by several
// independent, asynchronous writers (publish→per-cgId promotion, the inline
// update promotion, and the gossip FinalizationHandler). The chain assigns a
// strict order (publish then update), but those writers can land in the
// OPPOSITE order locally — a late publish-promotion re-materialises the
// pre-update KA on top of an already-applied update, with no guard, so the RS
// prover then extracts the stale state forever (`data-corrupted`).
//
// The fix: stamp every materialisation with its chain version
// (`<blockNumber>:<txIndex>`) on the KC's `<ual>` subject in the meta graph it
// writes, and have every writer refuse to apply a state OLDER than what is
// already materialised. This gives the projection the same ordering guarantee
// the chain log already has, regardless of interleaving.
const MATERIALIZED_VERSION_PRED = `${DKG}materializedVersion`;
const ASSERTION_VERSION_PRED = `${DKG}assertionVersion`;

export interface MaterializedVersion {
  blockNumber: number;
  txIndex: number;
}

export function compareMaterializedVersion(a: MaterializedVersion, b: MaterializedVersion): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.txIndex !== b.txIndex) return a.txIndex < b.txIndex ? -1 : 1;
  return 0;
}

function parseMaterializedVersion(raw: string | undefined): MaterializedVersion | null {
  if (!raw) return null;
  const m = /(\d+):(\d+)/.exec(raw);
  if (!m) return null;
  return { blockNumber: Number(m[1]), txIndex: Number(m[2]) };
}

export async function readMaterializedVersion(
  store: TripleStore,
  metaGraph: string,
  ual: string,
): Promise<MaterializedVersion | null> {
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
  const res = await store.query(
    `SELECT ?v WHERE { GRAPH <${metaGraph}> { <${ual}> <${MATERIALIZED_VERSION_PRED}> ?v } } LIMIT 1`,
  );
  if (res.type !== 'bindings' || res.bindings.length === 0) return null;
  return parseMaterializedVersion(res.bindings[0]['v']);
}

/**
 * True when `incoming` is newer-or-equal to what's already materialised for
 * this KA (equal allows idempotent re-apply). False means a newer state exists
 * and the caller MUST NOT write — it would clobber an already-applied update.
 */
export async function shouldApplyMaterialization(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  incoming: MaterializedVersion,
  incomingAssertionVersion?: bigint,
): Promise<boolean> {
  if (incomingAssertionVersion !== undefined) {
    assertSafeGraphIriForSparql(metaGraph);
    assertSafeGraphIriForSparql(ual);
    const assertionVersions = await store.query(
      `SELECT ?v WHERE { GRAPH <${metaGraph}> { <${ual}> <${ASSERTION_VERSION_PRED}> ?v } }`,
    );
    if (assertionVersions.type === 'bindings') {
      for (const row of assertionVersions.bindings) {
        const raw = row.v;
        const lexical = raw?.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
        if (lexical === undefined || !/^\d+$/.test(lexical)) {
          throw new Error(`Invalid stored assertionVersion metadata for ${ual}: ${raw ?? '<missing>'}`);
        }
        if (BigInt(lexical) > incomingAssertionVersion) return false;
      }
    }
  }
  const current = await readMaterializedVersion(store, metaGraph, ual);
  if (!current) return true;
  return compareMaterializedVersion(incoming, current) >= 0;
}

export async function writeMaterializedVersion(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  version: MaterializedVersion,
): Promise<void> {
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
  await store.deleteByPattern({ graph: metaGraph, subject: ual, predicate: MATERIALIZED_VERSION_PRED });
  await store.insert([materializedVersionQuad(metaGraph, ual, version)]);
}

export function materializedVersionQuad(
  metaGraph: string,
  ual: string,
  version: MaterializedVersion,
): Quad {
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
  return {
    subject: ual,
    predicate: MATERIALIZED_VERSION_PRED,
    object: lit(`${version.blockNumber}:${version.txIndex}`),
    graph: metaGraph,
  };
}

/**
 * In-process serialising lock keyed on `(metaGraph, ual)` so that the
 * "read version → apply payload → stamp version" sequence used by the
 * publish-promote / update-restate / finalization paths is effectively
 * atomic on a single node.
 *
 * Why this exists (PR #845 review by @branarakic):
 * The `shouldApplyMaterialization` check is TOCTOU against the eventual
 * `writeMaterializedVersion`: between the read and the write, the helper
 * performs many awaited store mutations. Three independent async writers
 * (publishFromSharedMemory, FinalizationHandler, DKGPublisher.update +
 * UpdateHandler via restate*) can pass the check while NO version is
 * stamped, then one materialises a newer version, then a stale writer
 * resumes mid-sequence and overwrites the newer payload.
 *
 * Solution: every check-then-write site enters this lock, so the
 * sequence runs end-to-end without interleave. The lock is per-KA so
 * unrelated work parallelises freely. The store layer doesn't expose
 * a CAS primitive, and a true cross-process lock would need to be
 * pushed into Oxigraph; per-process is sufficient because all four
 * writers live in the same daemon for a given context graph.
 */
const _materializationLocks = new Map<string, Promise<unknown>>();

export async function withMaterializationLock<T>(
  metaGraph: string,
  ual: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${metaGraph}\u0000${ual}`;
  const prev = _materializationLocks.get(key);
  // Build our work promise so subsequent callers can chain after us
  // BEFORE we start awaiting prev (otherwise two near-simultaneous
  // callers would both see `prev === undefined` and run in parallel).
  const work = (async () => {
    if (prev) {
      try { await prev; } catch { /* prev's caller already handled it */ }
    }
    return fn();
  })();
  _materializationLocks.set(key, work);
  try {
    return await work;
  } finally {
    // GC: if no one else queued after us, drop the entry so the map
    // doesn't grow unbounded across long-running daemons.
    if (_materializationLocks.get(key) === work) {
      _materializationLocks.delete(key);
    }
  }
}

/**
 * Full-restatement of a KA into a given data+meta partition pair, with the
 * minimal meta shape the RS prover needs (`rootEntity`/`entity` pair +
 * `privateMerkleRoot` + `batchId` + `merkleRoot`, all on the UAL subject —
 * the collapsed shape, RFC ka-metadata-trim P3.1). Used for the per-cgId
 * partition. Returns false (no-op) when a newer version is already
 * materialised — see {@link shouldApplyMaterialization}.
 */
export async function restateKaPartition(opts: {
  store: TripleStore;
  dataGraph: string;
  metaGraph: string;
  ual: string;
  kaId: bigint;
  merkleRoot: Uint8Array;
  payloadByRoot: Map<string, Quad[]>;
  privateRootByRoot?: Map<string, Uint8Array>;
  version?: MaterializedVersion;
}): Promise<boolean> {
  const { store, dataGraph, metaGraph, ual, kaId, merkleRoot, payloadByRoot, privateRootByRoot, version } = opts;
  assertSafeGraphIriForSparql(dataGraph);
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);

  // PR #845 review: the version check + writes must be atomic relative
  // to other writers on the same KA, otherwise a stale publish-promotion
  // can interleave between the check and the final `writeMaterializedVersion`
  // and clobber an applied update.
  return withMaterializationLock(metaGraph, ual, () => _restateKaPartitionLocked({
    store, dataGraph, metaGraph, ual, kaId, merkleRoot, payloadByRoot, privateRootByRoot, version,
  }));
}

async function _restateKaPartitionLocked(opts: {
  store: TripleStore;
  dataGraph: string;
  metaGraph: string;
  ual: string;
  kaId: bigint;
  merkleRoot: Uint8Array;
  payloadByRoot: Map<string, Quad[]>;
  privateRootByRoot?: Map<string, Uint8Array>;
  version?: MaterializedVersion;
}): Promise<boolean> {
  const { store, dataGraph, metaGraph, ual, kaId, merkleRoot, payloadByRoot, privateRootByRoot, version } = opts;

  if (version && !(await shouldApplyMaterialization(store, metaGraph, ual, version))) {
    return false;
  }

  // 1. Discover prior roots so their now-stale data is purged (restatement).
  //    Read-both (RFC ka-metadata-trim P3.1): collapsed-shape rows carry the
  //    entity pair directly on the UAL subject; legacy rows are
  //    `<ual>/<n> partOf <ual>` (still present in pre-upgrade local stores
  //    and on replicas synced from older nodes).
  const rootsToPurge = new Set<string>(payloadByRoot.keys());
  const priorRes = await store.query(
    `SELECT DISTINCT ?root WHERE { GRAPH <${metaGraph}> {
       VALUES ?entityPred { <${DKG_ROOT_ENTITY_LEGACY}> <${DKG_ENTITY}> }
       { ?ka <${DKG}partOf> <${ual}> . ?ka ?entityPred ?root . }
       UNION
       { <${ual}> ?entityPred ?root . }
     } }`,
  );
  if (priorRes.type === 'bindings') {
    for (const row of priorRes.bindings) {
      const r = row['root'];
      if (r) rootsToPurge.add(r);
    }
  }
  for (const root of rootsToPurge) {
    await store.deleteByPattern({ graph: dataGraph, subject: root });
    await store.deleteBySubjectPrefix(dataGraph, root + SKOLEM_INFIX);
  }

  // 2. Delete prior KA meta rows: legacy `?ka partOf <ual>` token subjects
  //    entirely, plus the collapsed-shape member rows on the UAL subject
  //    itself. Other KC-level <ual> rows (status, merkleRoot, batchId, …)
  //    stay.
  const priorKaRes = await store.query(
    `SELECT DISTINCT ?ka WHERE { GRAPH <${metaGraph}> { ?ka <${DKG}partOf> <${ual}> } }`,
  );
  if (priorKaRes.type === 'bindings') {
    for (const row of priorKaRes.bindings) {
      const ka = row['ka'];
      if (ka && ka !== ual) await store.deleteByPattern({ graph: metaGraph, subject: ka });
    }
  }
  for (const pred of [DKG_ROOT_ENTITY_LEGACY, DKG_ENTITY, `${DKG}privateMerkleRoot`, `${DKG}privateTripleCount`]) {
    await store.deleteByPattern({ graph: metaGraph, subject: ual, predicate: pred });
  }

  // 3. Insert payload public triples.
  const dataQuads: Quad[] = [];
  for (const quads of payloadByRoot.values()) {
    for (const q of quads) dataQuads.push({ ...q, graph: dataGraph });
  }
  if (dataQuads.length > 0) await store.insert(dataQuads);

  // 4. Insert fresh minimal KA meta rows on the UAL subject (collapsed shape,
  //    RFC ka-metadata-trim P3.1): no `<ual>/<n>` token subjects, no
  //    `dkg:partOf`. Member entities are an unordered set on the UAL; private
  //    merkle roots are an unordered leaf set (V10MerkleTree sorts + dedupes).
  //    Codex review "multi-root-access": MULTI-root payloads additionally
  //    re-emit the legacy `<ual>/<n>` token rows (insertion = manifest order,
  //    matching the pre-trim tokenIdx mint) so the root↔privateMerkleRoot
  //    pairing stays recoverable; single-root keeps the full collapse.
  //    SAME SHAPE as `buildScopedMinimalMeta` (the publish-path builder) but
  //    NOT shared: this path works from per-root Maps with POSITIONAL token
  //    labels and a DELETE/INSERT restate, vs. the builder's manifest + minted
  //    `ka.tokenId`. Keep the two shapes in sync if either changes.
  const metaQuads: Quad[] = [];
  const partitionMultiRoot = payloadByRoot.size > 1;
  let partitionTokenIdx = 1;
  for (const root of payloadByRoot.keys()) {
    metaQuads.push(...entityMemberQuads(ual, root, metaGraph));
    const privRoot = privateRootByRoot?.get(root);
    if (privRoot && privRoot.length > 0) {
      metaQuads.push(mq(ual, `${DKG}privateMerkleRoot`, lit(toHex(privRoot)), metaGraph));
    }
    if (partitionMultiRoot) {
      const kaUri = `${ual}/${partitionTokenIdx}`;
      metaQuads.push(
        ...entityMemberQuads(kaUri, root, metaGraph),
        mq(kaUri, `${DKG}partOf`, ual, metaGraph),
      );
      if (privRoot && privRoot.length > 0) {
        metaQuads.push(mq(kaUri, `${DKG}privateMerkleRoot`, lit(toHex(privRoot)), metaGraph));
      }
    }
    partitionTokenIdx++;
  }
  if (metaQuads.length > 0) await store.insert(metaQuads);

  // 5. Refresh resolution edges (batchId) + current merkleRoot.
  const batchLit = `"${kaId}"^^<${XSD}integer>`;
  const rootLit = `"${toHex(merkleRoot)}"`;
  await store.deleteByPattern({ graph: metaGraph, subject: ual, predicate: `${DKG}merkleRoot` });
  await store.insert([
    { subject: ual, predicate: `${DKG}merkleRoot`, object: rootLit, graph: metaGraph },
    { subject: ual, predicate: `${DKG}batchId`, object: batchLit, graph: metaGraph },
  ]);

  if (version) await writeMaterializedVersion(store, metaGraph, ual, version);
  return true;
}

/**
 * Full-restatement of a KA in the app-facing LABEL graph after an update.
 *
 * Unlike {@link restateKaPartition} (per-cgId, minimal meta), this PRESERVES
 * the KA's rich publish metadata (status, provenance, …) on the UAL subject
 * and only:
 *  - deletes the prior root entities' DATA (so `agent.query` no longer returns
 *    stale pre-update triples — the full-restatement bug, GH#842 §7.1), and
 *  - re-stamps the member-entity pair / `dkg:privateMerkleRoot` on the UAL
 *    subject to the new payload roots (collapsed shape, RFC ka-metadata-trim
 *    P3.1; legacy `<ual>/<n>` token rows found in the store are removed —
 *    the restate is the migration), and
 *  - refreshes `dkg:merkleRoot`.
 *
 * Returns false (no-op) when a newer version is already materialised.
 */
export async function restateLabelGraphForUpdate(opts: {
  store: TripleStore;
  dataGraph: string;
  metaGraph: string;
  ual: string;
  merkleRoot: Uint8Array;
  payloadByRoot: Map<string, Quad[]>;
  privateRootByRoot?: Map<string, Uint8Array>;
  version?: MaterializedVersion;
}): Promise<boolean> {
  const { store, dataGraph, metaGraph, ual, merkleRoot, payloadByRoot, privateRootByRoot, version } = opts;
  assertSafeGraphIriForSparql(dataGraph);
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);

  // PR #845 review: serialise check+write so a concurrent stale writer
  // cannot interleave between `shouldApplyMaterialization` and the final
  // `writeMaterializedVersion` (TOCTOU). See `withMaterializationLock`.
  return withMaterializationLock(metaGraph, ual, () => _restateLabelGraphForUpdateLocked({
    store, dataGraph, metaGraph, ual, merkleRoot, payloadByRoot, privateRootByRoot, version,
  }));
}

async function _restateLabelGraphForUpdateLocked(opts: {
  store: TripleStore;
  dataGraph: string;
  metaGraph: string;
  ual: string;
  merkleRoot: Uint8Array;
  payloadByRoot: Map<string, Quad[]>;
  privateRootByRoot?: Map<string, Uint8Array>;
  version?: MaterializedVersion;
}): Promise<boolean> {
  const { store, dataGraph, metaGraph, ual, merkleRoot, payloadByRoot, privateRootByRoot, version } = opts;

  if (version && !(await shouldApplyMaterialization(store, metaGraph, ual, version))) {
    return false;
  }

  // Insertion order (= manifest order). Under the collapsed shape the member
  // entities are an unordered set on the UAL subject, so order is only for
  // deterministic logs/inserts.
  const newRoots = [...payloadByRoot.keys()];

  // 1. Resolve prior KA rows (ka↔root) from the label meta. Read-both
  //    (RFC ka-metadata-trim P3.1): the collapsed shape carries the entity
  //    pair on the UAL subject itself; legacy `<ual>/<n> partOf <ual>` token
  //    rows still exist in pre-upgrade local stores and on replicas synced
  //    from older nodes.
  const priorKaRows: { ka: string; root: string }[] = [];
  const priorRes = await store.query(
    `SELECT DISTINCT ?ka ?root WHERE { GRAPH <${metaGraph}> {
       VALUES ?entityPred { <${DKG_ROOT_ENTITY_LEGACY}> <${DKG_ENTITY}> }
       { ?ka <${DKG}partOf> <${ual}> . ?ka ?entityPred ?root . }
       UNION
       { <${ual}> ?entityPred ?root . BIND(<${ual}> AS ?ka) }
     } }`,
  );
  if (priorRes.type === 'bindings') {
    for (const row of priorRes.bindings) {
      const ka = row['ka'];
      const root = row['root'];
      if (ka && root) priorKaRows.push({ ka, root });
    }
  }

  // 2. Delete prior + payload roots' data, then insert the payload.
  const rootsToPurge = new Set<string>(newRoots);
  for (const { root } of priorKaRows) rootsToPurge.add(root);
  for (const root of rootsToPurge) {
    await store.deleteByPattern({ graph: dataGraph, subject: root });
    await store.deleteBySubjectPrefix(dataGraph, root + SKOLEM_INFIX);
  }
  const dataQuads: Quad[] = [];
  for (const quads of payloadByRoot.values()) {
    for (const q of quads) dataQuads.push({ ...q, graph: dataGraph });
  }
  if (dataQuads.length > 0) await store.insert(dataQuads);

  // 3. Collapse (RFC ka-metadata-trim P3.1): member-entity + private-root
  //    rows live on the UAL subject itself. Delete the legacy `<ual>/<n>`
  //    token subjects entirely — their only remaining writer-side content is
  //    the entity pair + partOf + private roots, all replaced by the
  //    collapsed shape (this restate IS the migration for pre-upgrade local
  //    rows) — then re-stamp the UAL-subject member rows to the new payload
  //    roots. Everything else on the <ual> subject (status, provenance,
  //    merkleRoot, batchId, …) is preserved.
  const legacyKaSubjects = [...new Set(priorKaRows.map((r) => r.ka))].filter((ka) => ka !== ual);
  for (const ka of legacyKaSubjects) {
    await store.deleteByPattern({ graph: metaGraph, subject: ka });
  }
  for (const pred of [DKG_ROOT_ENTITY_LEGACY, DKG_ENTITY, `${DKG}privateMerkleRoot`]) {
    await store.deleteByPattern({ graph: metaGraph, subject: ual, predicate: pred });
  }
  // Codex review "multi-root-access": MULTI-root updates additionally
  // re-emit the legacy `<ual>/<n>` token rows (manifest order, matching the
  // pre-trim mint) so the AccessHandler keeps an unambiguous
  // root↔privateMerkleRoot pairing — this label `_meta` is exactly what
  // `queryKAMeta` resolves `<ual>/<n>` requests against. Single-root keeps
  // the full collapse.
  const metaQuads: Quad[] = [];
  const labelMultiRoot = newRoots.length > 1;
  for (let i = 0; i < newRoots.length; i++) {
    const root = newRoots[i];
    metaQuads.push(...entityMemberQuads(ual, root, metaGraph));
    const privRoot = privateRootByRoot?.get(root);
    if (privRoot && privRoot.length > 0) {
      metaQuads.push(mq(ual, `${DKG}privateMerkleRoot`, lit(toHex(privRoot)), metaGraph));
    }
    if (labelMultiRoot) {
      const kaUri = `${ual}/${i + 1}`;
      metaQuads.push(
        ...entityMemberQuads(kaUri, root, metaGraph),
        mq(kaUri, `${DKG}partOf`, ual, metaGraph),
      );
      if (privRoot && privRoot.length > 0) {
        metaQuads.push(mq(kaUri, `${DKG}privateMerkleRoot`, lit(toHex(privRoot)), metaGraph));
      }
    }
  }
  if (metaQuads.length > 0) await store.insert(metaQuads);

  // 4. Refresh merkleRoot.
  const rootLit = `"${toHex(merkleRoot)}"`;
  await store.deleteByPattern({ graph: metaGraph, subject: ual, predicate: `${DKG}merkleRoot` });
  await store.insert([{ subject: ual, predicate: `${DKG}merkleRoot`, object: rootLit, graph: metaGraph }]);

  if (version) await writeMaterializedVersion(store, metaGraph, ual, version);
  return true;
}

/**
 * Make the per-cgId data + meta partition reflect EXACTLY the update payload
 * for a knowledge asset, so the Random Sampling prover can prove updated KAs.
 *
 * GH #842 — why this exists.
 * V10 treats a knowledge-asset update as a *full restatement*: the on-chain
 * `updateKnowledgeCollection` ASSIGNS (`=`, not `+=`) `merkleRoot`,
 * `merkleLeafCount` and `byteSize` from the update payload, and the author
 * seal signs that payload root. So after an update the chain's view of the KA
 * is "the update payload, nothing else".
 *
 * The RS prover reads ONLY the per-cgId partition
 * (`<name>/context/<cgId>/data` + `…/_meta`) via `extractV10KCFromStore`.
 * Publish promotes confirmed data into that partition, but the update paths
 * (`DKGPublisher.update` and the gossip `UpdateHandler`) only wrote the payload
 * into the label data graph (`did:dkg:context-graph:<name>`) and never touched
 * the per-cgId partition. Result: the prover kept extracting the STALE
 * pre-update KA from the original publish promotion, whose leaf count can never
 * match the chain's post-update commitment — a permanent
 * `data-corrupted` / leaf-count-mismatch that made every updated KA unprovable.
 *
 * This helper closes the gap: it purges the KA's prior per-cgId roots (data +
 * meta) and writes the update payload, so the extract leaf set equals exactly
 * what the chain committed. `trustLevel` is intentionally NOT stamped — the
 * extractor skips those predicates, so they are not part of the leaf set.
 *
 * Best-effort by design: callers that cannot resolve the on-chain cgId or the
 * UAL skip promotion, leaving behaviour exactly as before (the KA simply stays
 * `kc-not-synced` for RS, no regression).
 */
export async function promoteUpdatedKaToPerCgId(opts: {
  store: TripleStore;
  /** CG label/name (e.g. `my-graph`), NOT the on-chain id. */
  contextGraphId: string;
  /** Stringified on-chain context-graph id (the `/context/<cgId>` segment). */
  cgId: string;
  /** Canonical UAL of the KA — used as the meta join key. */
  ual: string;
  /** On-chain batch id (== kaId) for the `dkg:batchId` resolution edge. */
  kaId: bigint;
  /** Post-update merkle root (mirrored into the per-cgId meta for parity). */
  merkleRoot: Uint8Array;
  /**
   * The update payload, partitioned by public root entity. Quad `graph` is
   * overwritten to the per-cgId data graph on insert. This MUST be the exact
   * same quad set the chain `merkleLeafCount` was computed over.
   */
  payloadByRoot: Map<string, Quad[]>;
  /** Per-root private merkle roots, when the update carried private content. */
  privateRootByRoot?: Map<string, Uint8Array>;
  /**
   * Chain version (block:txIndex) for the last-writer-wins guard. When set, the
   * promotion is skipped if a newer state is already materialised — this is
   * what stops a late publish-promotion from clobbering an applied update.
   */
  version?: MaterializedVersion;
}): Promise<boolean> {
  const { store, contextGraphId, cgId, ual, kaId, merkleRoot, payloadByRoot, privateRootByRoot, version } = opts;
  assertSafeContextGraphIdForSparql(contextGraphId);
  assertSafeContextGraphIdForSparql(cgId);
  assertSafeGraphIriForSparql(ual);
  const ctxData = contextGraphDataUri(contextGraphId, cgId);
  const ctxMeta = contextGraphMetaUri(contextGraphId, cgId);

  return restateKaPartition({
    store,
    dataGraph: ctxData,
    metaGraph: ctxMeta,
    ual,
    kaId,
    merkleRoot,
    payloadByRoot,
    privateRootByRoot,
    version,
  });
}

// ── Sub-Graph Registration Metadata ────────────────────────────────────

export interface SubGraphRegistration {
  contextGraphId: string;
  subGraphName: string;
  createdBy: string;
  authorizedWriters?: string[];
  description?: string;
  timestamp: Date;
}

/**
 * Generate RDF triples that register a sub-graph in the CG's `_meta` graph.
 * Spec §16.2: Sub-graph registration is recorded in `_meta` for agent discovery.
 */
export function generateSubGraphRegistration(reg: SubGraphRegistration): Quad[] {
  const metaGraph = `did:dkg:context-graph:${reg.contextGraphId}/_meta`;
  const subGraphUri = `did:dkg:context-graph:${reg.contextGraphId}/${reg.subGraphName}`;
  const parentUri = `did:dkg:context-graph:${reg.contextGraphId}`;

  const quads: Quad[] = [
    mq(subGraphUri, `${RDF}type`, `${DKG}SubGraph`, metaGraph),
    mq(subGraphUri, `${DKG}parentContextGraph`, parentUri, metaGraph),
    mq(subGraphUri, `${SCHEMA}name`, lit(reg.subGraphName), metaGraph),
    mq(subGraphUri, `${DKG}createdBy`, agentDid(reg.createdBy), metaGraph),
    mq(subGraphUri, `${DKG}createdAt`, dateLit(reg.timestamp), metaGraph),
  ];

  if (reg.description) {
    quads.push(mq(subGraphUri, `${SCHEMA}description`, lit(reg.description), metaGraph));
  }

  if (reg.authorizedWriters && reg.authorizedWriters.length > 0) {
    for (const writer of reg.authorizedWriters) {
      const writerUri = agentDid(writer);
      if (!isSafeIri(writerUri)) continue;
      quads.push(mq(subGraphUri, `${DKG}authorizedWriter`, writerUri, metaGraph));
    }
  }

  return quads;
}

/**
 * Generate SPARQL to remove a sub-graph's registration triples from `_meta`.
 */
export function subGraphDeregistrationSparql(contextGraphId: string, subGraphName: string): string {
  assertSafeContextGraphIdForSparql(contextGraphId);
  assertSafeSubGraphNameForSparql(subGraphName);
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
  return `DELETE WHERE { GRAPH <${metaGraph}> { <${subGraphUri}> ?p ?o } }`;
}

/**
 * SPARQL query to discover registered sub-graphs from `_meta`.
 */
export function subGraphDiscoverySparql(contextGraphId: string): string {
  assertSafeContextGraphIdForSparql(contextGraphId);
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  return `SELECT ?subGraph ?name ?createdBy ?createdAt ?description WHERE {
  GRAPH <${metaGraph}> {
    ?subGraph a <${DKG}SubGraph> ;
              <${SCHEMA}name> ?name ;
              <${DKG}createdBy> ?createdBy .
    OPTIONAL { ?subGraph <${DKG}createdAt> ?createdAt }
    OPTIONAL { ?subGraph <${SCHEMA}description> ?description }
  }
}`;
}

/**
 * SPARQL query to list authorized writers for a specific sub-graph.
 */
export function subGraphWritersSparql(contextGraphId: string, subGraphName: string): string {
  assertSafeContextGraphIdForSparql(contextGraphId);
  assertSafeSubGraphNameForSparql(subGraphName);
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
  return `SELECT ?writer WHERE {
  GRAPH <${metaGraph}> {
    <${subGraphUri}> <${DKG}authorizedWriter> ?writer
  }
}`;
}

// ── Assertion Lifecycle Metadata (Event-Sourced, PROV-O) ────────────────
//
// Persistent records in `_meta` that track an assertion's identity and
// provenance across all three memory layers (WM → SWM → VM).
//
// Uses W3C PROV-O (http://www.w3.org/ns/prov#) as the backbone:
//   - Transition event = prov:Activity + dkg:Assertion{Created,Promoted,...}
//   - prov:wasAttributedTo links entity → agent
//   - prov:startedAtTime records when the activity happened
//   - prov:generated links activity → entity it produced/modified
// (RFC ka-metadata-trim Phase 1: the entity-side `a prov:Entity` /
// `a dkg:Assertion` type rows and `prov:wasGeneratedBy` are no longer
// written — history joins the event-side `prov:generated`/`prov:used`.
// Phase 2: `prov:wasAssociatedWith`, `dkg:fromLayer`/`dkg:toLayer` and the
// event-side member-entity rows are no longer written either — the agent is
// the subject's `prov:wasAttributedTo`, the layer transition is derived from
// the event class, and the member list lives on the stable lifecycle
// subject. Readers stay read-both for old-store events.)
//
// DKG-specific extensions (no PROV equivalent):
//   - dkg:state, dkg:memoryLayer — current mutable position
//   - dkg:assertionGraph, dkg:assertionName — DKG identity
//   - dkg:shareOperationId, dkg:kcUal — operation metadata
//   - dkg:rootEntity — member entities, on the stable lifecycle subject

// ── OT-RFC-43 A2 / B3 — per-layer pointers + KA identity on the lifecycle URN ──
//
// All of these are net-new (none existed before this RFC). They are stamped
// on the SAME subject as dkg:state/dkg:memoryLayer — the lifecycle URN
// (assertionLifecycleUri) — so an assertion's identity and per-layer position
// are queryable from one stable subject across WM → SWM → VM.
//
//   dkg:wmCurrentAssertion  — merkle hex of the assertion currently sealed in WM
//   dkg:swmCurrentAssertion — merkle hex of the assertion shared into SWM
//   dkg:vmCurrentAssertion  — merkle hex of the assertion confirmed on-chain (VM)
//   dkg:kaId                — the per-author KA NUMBER (low 96 bits), xsd:integer
//   dkg:reservedUal         — did:dkg:<chainId>/<agentAddrLower>/<number>
//   prov:wasRevisionOf      — links a new (updated) merkle to the prior one
//
// Divergence between the three pointers is the observable signal that a layer
// is ahead of another (e.g. after wm/pull-from + a fresh finalize, WM is ahead
// of VM; after an update mint, wmCurrentAssertion == vmCurrentAssertion again).
export const WM_CURRENT_ASSERTION_PRED = `${DKG}wmCurrentAssertion`;
export const SWM_CURRENT_ASSERTION_PRED = `${DKG}swmCurrentAssertion`;
export const VM_CURRENT_ASSERTION_PRED = `${DKG}vmCurrentAssertion`;
export const KA_ID_PRED = `${DKG}kaId`;
export const RESERVED_UAL_PRED = `${DKG}reservedUal`;
export const PROV_WAS_REVISION_OF = `${PROV}wasRevisionOf`;

/** OT-RFC-43 §10.5.4 per-layer / overall KA status enum (string-stable). */
export type KaStatus = 'draft-open' | 'wm-sealed' | 'swm-shared' | 'vm-confirmed';

/**
 * Minimal shape `deriveStatus` reads. Mirrors the pointer + state fields the
 * `agent.assertion.history()` facade returns, so callers can pass a descriptor
 * straight through.
 */
export interface StatusPointers {
  state?: string;
  wmCurrentAssertion?: string;
  swmCurrentAssertion?: string;
  vmCurrentAssertion?: string;
}

/**
 * OT-RFC-43 §10.5.4 — derive the KA status from a descriptor's lifecycle
 * state + per-layer pointers. When `layer` is supplied the status reflects
 * THAT layer's position (so per-layer divergence is observable); otherwise it
 * reflects the highest layer reached.
 *
 * The four returned strings are the SAME literals already used across the
 * codebase (knowledge-assets.ts, api-client.test.ts): "draft-open" |
 * "wm-sealed" | "swm-shared" | "vm-confirmed".
 */
export function deriveStatus(p: StatusPointers, layer?: 'wm' | 'swm' | 'vm'): KaStatus {
  if (layer === 'vm') return p.vmCurrentAssertion ? 'vm-confirmed' : 'draft-open';
  if (layer === 'swm') {
    if (p.swmCurrentAssertion) return 'swm-shared';
    if (p.vmCurrentAssertion) return 'vm-confirmed';
    return 'draft-open';
  }
  if (layer === 'wm') return p.wmCurrentAssertion ? 'wm-sealed' : 'draft-open';
  // Overall (no layer): highest layer reached.
  if (p.vmCurrentAssertion || p.state === 'published' || p.state === 'finalized') return 'vm-confirmed';
  if (p.swmCurrentAssertion || p.state === 'promoted') return 'swm-shared';
  if (p.wmCurrentAssertion) return 'wm-sealed';
  return 'draft-open';
}

/**
 * Build a single per-layer pointer quad on the lifecycle URN. The value is the
 * assertion's merkle root hex (no 0x prefix, matching the seal's hexBinary
 * lexical space) so divergence comparisons are plain string equality.
 */
export function assertionLayerPointerQuad(
  lifecycleUri: string,
  pred: typeof WM_CURRENT_ASSERTION_PRED | typeof SWM_CURRENT_ASSERTION_PRED | typeof VM_CURRENT_ASSERTION_PRED,
  merkleHex: string,
  metaGraph: string,
): Quad {
  const bare = merkleHex.startsWith('0x') ? merkleHex.slice(2) : merkleHex;
  return mq(lifecycleUri, pred, lit(bare), metaGraph);
}

/**
 * DELETE/INSERT to (re)stamp a per-layer pointer on the lifecycle URN. Returns
 * a SPARQL UPDATE string that drops any prior value for `pred` and sets the
 * new merkle. Callers run it against the triple store directly.
 */
export function stampLayerPointerSparql(
  lifecycleUri: string,
  pred: typeof WM_CURRENT_ASSERTION_PRED | typeof SWM_CURRENT_ASSERTION_PRED | typeof VM_CURRENT_ASSERTION_PRED,
  merkleHex: string,
  metaGraph: string,
): string {
  const bare = merkleHex.startsWith('0x') ? merkleHex.slice(2) : merkleHex;
  return `DELETE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${pred}> ?old } }
INSERT { GRAPH <${metaGraph}> { <${lifecycleUri}> <${pred}> ${lit(bare)} } }
WHERE  { GRAPH <${metaGraph}> { OPTIONAL { <${lifecycleUri}> <${pred}> ?old } } }`;
}

let eventCounter = 0;
function nextEventId(): string {
  return `${Date.now().toString(36)}-${(++eventCounter).toString(36)}`;
}

export interface AssertionCreatedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  timestamp: Date;
  /** D1 (identity-at-create) — per-author KA number minted at create. */
  kaNumber?: string | number | bigint;
  /** D1 (identity-at-create) — reserved UAL `did:dkg:{chain}/{addr}/{number}`. */
  reservedUal?: string;
}

/**
 * RFC ka-metadata-trim Phase 3 (P3.3): writer-side gate for the PROV event
 * rows. When `provenanceEvents` is `false` ("lite mode" for high-throughput
 * publishers / core nodes), the lifecycle generators skip the per-transition
 * `prov:Activity` event nodes but KEEP every state/identity row on the
 * lifecycle subject (state, memoryLayer, assertionGraph, assertionName,
 * kaId, reservedUal, member-entity stamps, pointers). The history API then
 * returns `events: []` gracefully — the descriptor itself is unaffected.
 */
export interface LifecycleMetadataOptions {
  /** Default `true`. Set `false` to skip the PROV event-node rows. */
  provenanceEvents?: boolean;
}

export function generateAssertionCreatedMetadata(meta: AssertionCreatedMeta, opts?: LifecycleMetadataOptions): Quad[] {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  // Uniform layout: the assertionGraph pointer must name the SAME per-KA WM graph the
  // data is written to (else _meta-driven discovery/promote follows an empty name-keyed
  // graph). Number-keyed once the KA has an identity (D1), else legacy name-keyed.
  const graphUri = meta.kaNumber !== undefined
    ? contextGraphLayerUri(meta.contextGraphId, MemoryLayer.WorkingMemory, meta.agentAddress, meta.kaNumber, meta.subGraphName)
    : contextGraphAssertionUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const agentUri = agentDid(meta.agentAddress);
  const eventUri = `${subject}/event/${nextEventId()}`;

  const quads: Quad[] = [
    // Assertion entity (DKG identity). RFC ka-metadata-trim Phase 1: the
    // `a prov:Entity` / `a dkg:Assertion` type rows, `dkg:contextGraph` and
    // `prov:wasGeneratedBy` were dropped — history joins the event-side
    // `prov:generated`/`prov:used`. Old-store rows synced from older nodes
    // may still carry them.
    // "Zero readers" correction (Codex review "graph-viz", F1-style): one
    // client-side reader DOES generically match `prov:wasGeneratedBy` —
    // graph-viz's provenance-resolver (provenance-resolver.ts) populates
    // ProvenanceInfo.generatedBy from any loaded node. The drop still
    // strands nothing: (a) `_meta` lifecycle rows are not fed to the viz in
    // any node-ui flow (data-layer SPARQL only); (b) generatedBy/
    // generatedByName have no renderer anywhere in the repo; (c) the
    // resolver's live feed is content-layer `prov:wasGeneratedBy` writers
    // (semantic enrichment, agent profiles, user data) untouched by the
    // trim. See docs/rfcs/ka-metadata-trim.md Phase 1.
    mq(subject, `${PROV}wasAttributedTo`, agentUri, metaGraph),
    mq(subject, `${DKG}assertionName`, lit(meta.assertionName), metaGraph),
    mq(subject, `${DKG}assertionGraph`, graphUri, metaGraph),
    mq(subject, `${DKG}state`, lit('created'), metaGraph),
    mq(subject, `${DKG}memoryLayer`, lit(MemoryLayer.WorkingMemory), metaGraph),
  ];
  if (opts?.provenanceEvents !== false) {
    quads.push(
      // Event entity (prov:Activity). RFC ka-metadata-trim Phase 2:
      // `dkg:fromLayer`/`dkg:toLayer` are no longer written — they are 100%
      // determined by the event class (AssertionCreated ⇒ none→WM) and the
      // history reader derives them; `prov:wasAssociatedWith` is no longer
      // written — readers fall back to the subject's `prov:wasAttributedTo`
      // (same agent DID). Old-store events still carry both (read-both).
      mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
      mq(eventUri, `${RDF}type`, `${DKG}AssertionCreated`, metaGraph),
      mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
      mq(eventUri, `${PROV}generated`, subject, metaGraph),
    );
  }

  // D1 (identity-at-create): stamp the KA number + reserved UAL on the lifecycle URN
  // so the UAL is the KA's identity from the first write — the per-KA graph name
  // {addr}/{number} and the _meta row key both derive from it. Finalize's
  // hasExistingKaId guard then finds this stamp and skips re-allocation. Consensus-
  // neutral: the seal commits content+author, never the kaId.
  if (meta.kaNumber !== undefined) {
    quads.push(mq(subject, KA_ID_PRED, intLit(BigInt(meta.kaNumber)), metaGraph));
  }
  if (meta.reservedUal) {
    quads.push(mq(subject, RESERVED_UAL_PRED, lit(meta.reservedUal), metaGraph));
  }

  if (meta.subGraphName) {
    quads.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }

  return quads;
}

export interface AssertionPromotedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  /** D1 — KA number, so the WM-delete targets the per-KA _working_memory/{addr}/{number} graph. */
  kaNumber?: bigint | number | string;
  shareOperationId: string;
  rootEntities: string[];
  timestamp: Date;
  /**
   * OT-RFC-43 A2 — the assertion's merkle root hex (no 0x), captured at the
   * SWM-share boundary. Stamps `dkg:swmCurrentAssertion` on the lifecycle URN
   * so the SWM pointer is observable and can diverge from WM/VM. Optional for
   * back-compat with callers that don't have the seal merkle yet.
   */
  merkleHex?: string;
}

export function generateAssertionPromotedMetadata(meta: AssertionPromotedMeta, opts?: LifecycleMetadataOptions): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const eventUri = `${subject}/event/${nextEventId()}`;
  const provenanceEvents = opts?.provenanceEvents !== false;
  // SUBSTRATE-2: the layer-aware assertionGraph re-stamp. At create the pointer names
  // the WM graph (metadata.ts generateAssertionCreatedMetadata); on promote it must
  // re-point to the SWM-layer graph so the _meta index locates SWM data correctly.
  // rc.17a: the shared bucket (contextGraphSharedMemoryUri); rc.17b flips this target
  // to the per-KA SWM graph. Without this re-stamp the index follows a stale WM pointer.
  const wmGraphUri = meta.kaNumber !== undefined
    ? contextGraphLayerUri(meta.contextGraphId, MemoryLayer.WorkingMemory, meta.agentAddress, meta.kaNumber, meta.subGraphName)
    : contextGraphAssertionUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const swmGraphUri = meta.kaNumber !== undefined
    ? contextGraphLayerUri(
        meta.contextGraphId,
        MemoryLayer.SharedWorkingMemory,
        meta.agentAddress,
        meta.kaNumber,
        meta.subGraphName,
      )
    : contextGraphSharedMemoryUri(meta.contextGraphId, meta.subGraphName);

  const del = [
    assertionStateQuad(subject, 'created', metaGraph),
    assertionLayerQuad(subject, MemoryLayer.WorkingMemory, metaGraph),
    mq(subject, `${DKG}assertionGraph`, wmGraphUri, metaGraph),
  ];
  const ins: Quad[] = [
    // Update assertion entity (mutable fields)
    mq(subject, `${DKG}state`, lit('promoted'), metaGraph),
    mq(subject, `${DKG}memoryLayer`, lit(MemoryLayer.SharedWorkingMemory), metaGraph),
    mq(subject, `${DKG}assertionGraph`, swmGraphUri, metaGraph),
    mq(subject, `${DKG}shareOperationId`, lit(meta.shareOperationId), metaGraph),
  ];
  if (provenanceEvents) {
    ins.push(
      // Event entity (prov:Activity). RFC ka-metadata-trim Phase 2: no
      // `dkg:fromLayer`/`dkg:toLayer` (derived from the event class —
      // AssertionPromoted ⇒ WM→SWM) and no `prov:wasAssociatedWith`
      // (readers fall back to the subject's `prov:wasAttributedTo`).
      mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
      mq(eventUri, `${RDF}type`, `${DKG}AssertionPromoted`, metaGraph),
      mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
      mq(eventUri, `${PROV}used`, subject, metaGraph),
      mq(eventUri, `${DKG}shareOperationId`, lit(meta.shareOperationId), metaGraph),
    );
  }
  // OT-RFC-43 A2 — stamp the SWM pointer (swmCurrentAssertion). DELETE handled
  // by the caller's stampLayerPointerSparql when restamping; here we INSERT the
  // current merkle so generateAssertionPromotedMetadata callers that go through
  // the insert/delete shape get the pointer too.
  if (meta.merkleHex) {
    ins.push(assertionLayerPointerQuad(subject, SWM_CURRENT_ASSERTION_PRED, meta.merkleHex, metaGraph));
  }
  for (const entity of meta.rootEntities) {
    // RFC ka-metadata-trim Phase 2: the per-event membership rows were
    // dropped — the event node no longer duplicates the member list. The
    // history/feed readers resolve a promote's entities from the STABLE
    // subject-side stamp below (read-both: old-store events still carry
    // event-side rows).
    //
    // SUBSTRATE-1: membership on the STABLE lifecycle URN, so the _meta index can
    // resolve "which KAs contain member-entity X" by binding the member
    // predicate on the URN instead of walking per-event nodes. (Member
    // entities are first known once the KA is sealed; promote is the first
    // lifecycle event that carries them. The create-and-seal path (D2)
    // should stamp the same rows on the URN.)
    ins.push(...entityMemberQuads(subject, entity, metaGraph));
  }
  if (meta.subGraphName) {
    ins.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }
  return { insert: ins, delete: del };
}

// RFC ka-metadata-trim Phase 0: `generateAssertionPublishedMetadata` (and its
// `AssertionPublishedMeta` input) was deleted — its sole caller was a dead
// SPARQL gate in dkg-publisher.ts that joined `dkg:agent`, a predicate the
// lifecycle writer never emits, so it never fired. The SWM→VM flip is done
// imperatively in dkg-agent-publish.ts.

export interface AssertionUpdatedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  kcUal: string;
  timestamp: Date;
  /** New merkle root hex (no 0x) of the updated assertion (the new VM/WM value). */
  newMerkleHex: string;
  /**
   * Prior assertion's merkle root hex (no 0x), discoverable on the update path.
   * Emitted as `<lifecycle> prov:wasRevisionOf <priorAssertionUri>` when set.
   */
  priorMerkleHex?: string;
  /**
   * Optional explicit prior-assertion URI. When omitted, a stable
   * `<lifecycle>#assertion-<priorMerkleHex>` skolem is used so the revision
   * chain is queryable without minting a separate assertion subject.
   */
  priorAssertionUri?: string;
}

/**
 * OT-RFC-43 A2 §4 — provenance for an UPDATE (a second publish of the same
 * lifecycle name). Uses the lifecycle writers' insert/delete shape: it
 * re-stamps `dkg:vmCurrentAssertion` (and `dkg:wmCurrentAssertion`, which
 * converges back to VM after the update mint) to the NEW merkle and records
 * `<lifecycle> prov:wasRevisionOf <prior>` so the version chain is walkable.
 */
export function generateAssertionUpdatedMetadata(meta: AssertionUpdatedMeta, opts?: LifecycleMetadataOptions): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const eventUri = `${subject}/event/${nextEventId()}`;
  const newBare = meta.newMerkleHex.startsWith('0x') ? meta.newMerkleHex.slice(2) : meta.newMerkleHex;

  const ins: Quad[] = [
    // State/identity rows — ALWAYS written, even in lite mode (P3.3).
    mq(subject, `${DKG}state`, lit('published'), metaGraph),
    mq(subject, `${DKG}memoryLayer`, lit(MemoryLayer.VerifiableMemory), metaGraph),
    // New VM pointer. RFC ka-metadata-trim Phase 2: the WM pointer is NO
    // LONGER re-written here — after the update mint WM converges back to
    // VM, and the wm/swm pointers are only materialised when they DIVERGE
    // from VM. Readers COALESCE a missing wm/swm to the vm value.
    assertionLayerPointerQuad(subject, VM_CURRENT_ASSERTION_PRED, newBare, metaGraph),
  ];
  if (opts?.provenanceEvents !== false) {
    ins.push(
      // RFC ka-metadata-trim Phase 2: no `dkg:fromLayer`/`dkg:toLayer`
      // (AssertionUpdated ⇒ VM→VM, derived by the history reader) and no
      // `prov:wasAssociatedWith` (subject `prov:wasAttributedTo` fallback).
      mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
      mq(eventUri, `${RDF}type`, `${DKG}AssertionUpdated`, metaGraph),
      mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
      mq(eventUri, `${PROV}used`, subject, metaGraph),
      mq(eventUri, `${DKG}kcUal`, meta.kcUal, metaGraph),
    );
  }

  if (meta.priorMerkleHex) {
    const priorBare = meta.priorMerkleHex.startsWith('0x') ? meta.priorMerkleHex.slice(2) : meta.priorMerkleHex;
    const priorUri = meta.priorAssertionUri ?? `${subject}#assertion-${priorBare}`;
    ins.push(mq(subject, PROV_WAS_REVISION_OF, priorUri, metaGraph));
    // Make the prior version subject self-describing so the chain is walkable.
    ins.push(mq(priorUri, `${RDF}type`, `${DKG}Assertion`, metaGraph));
    ins.push(assertionLayerPointerQuad(priorUri, VM_CURRENT_ASSERTION_PRED, priorBare, metaGraph));
  }
  if (meta.subGraphName) {
    ins.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }

  // DELETE the prior per-layer pointer values so the re-stamp is unambiguous.
  const del: Quad[] = [];
  if (meta.priorMerkleHex) {
    const priorBare = meta.priorMerkleHex.startsWith('0x') ? meta.priorMerkleHex.slice(2) : meta.priorMerkleHex;
    del.push(assertionLayerPointerQuad(subject, VM_CURRENT_ASSERTION_PRED, priorBare, metaGraph));
    del.push(assertionLayerPointerQuad(subject, WM_CURRENT_ASSERTION_PRED, priorBare, metaGraph));
  }
  return { insert: ins, delete: del };
}

export interface AssertionDiscardedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  timestamp: Date;
}

export function generateAssertionDiscardedMetadata(meta: AssertionDiscardedMeta, opts?: LifecycleMetadataOptions): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const eventUri = `${subject}/event/${nextEventId()}`;
  const ins: Quad[] = [
    // The state change is ALWAYS written, even in lite mode (P3.3): it is a
    // state/identity row, not a PROV event row.
    mq(subject, `${DKG}state`, lit('discarded'), metaGraph),
  ];
  if (opts?.provenanceEvents !== false) {
    ins.push(
      // `prov:wasInvalidatedBy` points AT the event node, so it is gated
      // together with the event — writing it without the node would leave a
      // dangling edge in lite mode.
      mq(subject, `${PROV}wasInvalidatedBy`, eventUri, metaGraph),
      // RFC ka-metadata-trim Phase 2: no `dkg:fromLayer`/`dkg:toLayer`
      // (AssertionDiscarded ⇒ WM→none, derived by the history reader) and no
      // `prov:wasAssociatedWith` (subject `prov:wasAttributedTo` fallback).
      mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
      mq(eventUri, `${RDF}type`, `${DKG}AssertionDiscarded`, metaGraph),
      mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
      mq(eventUri, `${PROV}used`, subject, metaGraph),
    );
  }
  if (meta.subGraphName) {
    ins.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }
  return {
    insert: ins,
    delete: [
      assertionStateQuad(subject, 'created', metaGraph),
      assertionLayerQuad(subject, MemoryLayer.WorkingMemory, metaGraph),
    ],
  };
}

/**
 * Build the quad for a specific assertion state value.
 * Used as the target of DELETE operations when transitioning states.
 */
export function assertionStateQuad(lifecycleUri: string, state: AssertionState, metaGraph: string): Quad {
  return mq(lifecycleUri, `${DKG}state`, lit(state), metaGraph);
}

/**
 * Build the quad for a specific memory layer value.
 * Used as the target of DELETE operations when transitioning layers.
 */
export function assertionLayerQuad(lifecycleUri: string, layer: MemoryLayer, metaGraph: string): Quad {
  return mq(lifecycleUri, `${DKG}memoryLayer`, lit(layer), metaGraph);
}
