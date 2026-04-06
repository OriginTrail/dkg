import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface KCMetadata {
  ual: string;
  contextGraphId: string;
  merkleRoot: Uint8Array;
  kaCount: number;
  publisherPeerId: string;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
  timestamp: Date;
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

function assertSafeContextGraphIdForSparql(contextGraphId: string): void {
  // Reject characters that can break GRAPH <...> IRI delimiters and enable injection.
  if (/[<>"{}|^`\\\s]/.test(contextGraphId)) {
    throw new Error(`Unsafe contextGraphId for SPARQL graph IRI: "${contextGraphId}"`);
  }
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

  // KC metadata
  quads.push(
    mq(meta.ual, `${RDF}type`, `${DKG}KnowledgeCollection`, metaGraph),
    mq(meta.ual, `${DKG}merkleRoot`, lit(toHex(meta.merkleRoot)), metaGraph),
    mq(meta.ual, `${DKG}kaCount`, intLit(meta.kaCount), metaGraph),
    mq(meta.ual, `${DKG}accessPolicy`, lit(meta.accessPolicy ?? 'public'), metaGraph),
    mq(meta.ual, `${DKG}publisherPeerId`, lit(meta.publisherPeerId || 'unknown'), metaGraph),
    mq(
      meta.ual,
      `${PROV}wasAttributedTo`,
      lit(meta.publisherPeerId || 'unknown'),
      metaGraph,
    ),
    mq(
      meta.ual,
      `${DKG}publishedAt`,
      dateLit(meta.timestamp),
      metaGraph,
    ),
    mq(meta.ual, `${DKG}paranet`, `did:dkg:context-graph:${meta.contextGraphId}`, metaGraph),
  );

  if (meta.allowedPeers?.length) {
    for (const peerId of meta.allowedPeers) {
      quads.push(
        mq(meta.ual, `${DKG}allowedPeer`, lit(peerId), metaGraph),
      );
    }
  }

  // KA metadata
  for (const ka of kaEntries) {
    const kaUri = `${ka.kcUal}/${ka.tokenId}`;
    quads.push(
      mq(kaUri, `${RDF}type`, `${DKG}KnowledgeAsset`, metaGraph),
      mq(kaUri, `${DKG}rootEntity`, ka.rootEntity, metaGraph),
      mq(kaUri, `${DKG}partOf`, ka.kcUal, metaGraph),
      mq(kaUri, `${DKG}tokenId`, intLit(ka.tokenId), metaGraph),
      mq(
        kaUri,
        `${DKG}publicTripleCount`,
        intLit(ka.publicTripleCount),
        metaGraph,
      ),
    );

    if (ka.privateTripleCount > 0) {
      quads.push(
        mq(
          kaUri,
          `${DKG}privateTripleCount`,
          intLit(ka.privateTripleCount),
          metaGraph,
        ),
      );
      if (ka.privateMerkleRoot) {
        quads.push(
          mq(
            kaUri,
            `${DKG}privateMerkleRoot`,
            lit(toHex(ka.privateMerkleRoot)),
            metaGraph,
          ),
        );
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
  const quads: Quad[] = [
    mq(ual, `${DKG}status`, lit('confirmed'), metaGraph),
    mq(ual, `${DKG}transactionHash`, lit(provenance.txHash), metaGraph),
    mq(ual, `${DKG}blockNumber`, intLit(provenance.blockNumber), metaGraph),
    mq(
      ual,
      `${DKG}blockTimestamp`,
      dateLit(new Date(provenance.blockTimestamp * 1000)),
      metaGraph,
    ),
    mq(ual, `${DKG}publisherAddress`, lit(provenance.publisherAddress), metaGraph),
    mq(ual, `${DKG}batchId`, intLit(provenance.batchId), metaGraph),
    mq(ual, `${DKG}chainId`, lit(provenance.chainId), metaGraph),
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

function mq(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function lit(val: string): string {
  return `"${val}"`;
}

function intLit(val: number | bigint): string {
  return `"${val}"^^<${XSD}integer>`;
}

function dateLit(d: Date): string {
  return `"${d.toISOString()}"^^<${XSD}dateTime>`;
}

/**
 * Agent authorship proof per spec §9.0.6.
 * The agent signs keccak256(merkleRoot) and the proof is stored in _meta.
 */
export interface AuthorshipProof {
  kcUal: string;
  contextGraphId: string;
  agentAddress: string;
  signature: string;
  signedHash: string;
}

export function generateAuthorshipProof(proof: AuthorshipProof): Quad[] {
  const metaGraph = `did:dkg:context-graph:${proof.contextGraphId}/_meta`;
  const blankNode = `_:authorship_${proof.kcUal.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return [
    mq(proof.kcUal, `${DKG}authoredBy`, blankNode, metaGraph),
    mq(blankNode, `${RDF}type`, `${DKG}AuthorshipProof`, metaGraph),
    mq(blankNode, `${DKG}agent`, `did:dkg:agent:${proof.agentAddress}`, metaGraph),
    mq(blankNode, `${DKG}signature`, lit(proof.signature), metaGraph),
    mq(blankNode, `${DKG}signedHash`, lit(proof.signedHash), metaGraph),
  ];
}

/**
 * ShareTransition metadata per spec §8.
 * Recorded in _shared_memory_meta when data is promoted from WM → SWM.
 */
export interface ShareTransitionMetadata {
  contextGraphId: string;
  operationId: string;
  agentAddress: string;
  draftName: string;
  entities: string[];
  timestamp: Date;
}

export function generateShareTransitionMetadata(meta: ShareTransitionMetadata): Quad[] {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_shared_memory_meta`;
  const subject = `urn:dkg:share:${meta.operationId}`;
  const quads: Quad[] = [
    mq(subject, `${RDF}type`, `${DKG}ShareTransition`, metaGraph),
    mq(subject, `${DKG}source`, lit(`draft/${meta.agentAddress}/${meta.draftName}`), metaGraph),
    mq(subject, `${DKG}agent`, `did:dkg:agent:${meta.agentAddress}`, metaGraph),
    mq(subject, `${DKG}timestamp`, dateLit(meta.timestamp), metaGraph),
  ];
  for (const entity of meta.entities) {
    quads.push(mq(subject, `${DKG}entities`, entity, metaGraph));
  }
  return quads;
}

/** Shared memory metadata: no UAL; stored in _shared_memory_meta graph. */
export interface ShareMetadata {
  shareOperationId: string;
  contextGraphId: string;
  rootEntities: string[];
  publisherPeerId: string;
  timestamp: Date;
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
    mq(
      subject,
      `${PROV}wasAttributedTo`,
      lit(meta.publisherPeerId),
      swmMetaGraph,
    ),
    mq(
      subject,
      `${DKG}publishedAt`,
      dateLit(meta.timestamp),
      swmMetaGraph,
    ),
  );

  for (const rootEntity of meta.rootEntities) {
    quads.push(
      mq(subject, `${DKG}rootEntity`, rootEntity, swmMetaGraph),
    );
  }

  return quads;
}

/** @deprecated Use generateShareMetadata */
export const generateWorkspaceMetadata = generateShareMetadata;

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
