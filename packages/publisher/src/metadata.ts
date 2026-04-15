import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { validateSubGraphName, isSafeIri, assertionLifecycleUri, contextGraphAssertionUri, MemoryLayer, ASSERTION_STATE_TO_LAYER } from '@origintrail-official/dkg-core';
import type { AssertionState } from '@origintrail-official/dkg-core';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'http://schema.org/';
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
  subGraphName?: string;
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
  assertionName: string;
  entities: string[];
  timestamp: Date;
}

export function generateShareTransitionMetadata(meta: ShareTransitionMetadata): Quad[] {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_shared_memory_meta`;
  const subject = `urn:dkg:share:${meta.operationId}`;
  const quads: Quad[] = [
    mq(subject, `${RDF}type`, `${DKG}ShareTransition`, metaGraph),
    mq(subject, `${DKG}source`, lit(`assertion/${meta.agentAddress}/${meta.assertionName}`), metaGraph),
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
    mq(subGraphUri, `${DKG}createdBy`, `did:dkg:agent:${reg.createdBy}`, metaGraph),
    mq(subGraphUri, `${DKG}createdAt`, dateLit(reg.timestamp), metaGraph),
  ];

  if (reg.description) {
    quads.push(mq(subGraphUri, `${SCHEMA}description`, lit(reg.description), metaGraph));
  }

  if (reg.authorizedWriters && reg.authorizedWriters.length > 0) {
    for (const writer of reg.authorizedWriters) {
      const writerUri = `did:dkg:agent:${writer}`;
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
//   - Assertion entity = prov:Entity + dkg:Assertion
//   - Transition event = prov:Activity + dkg:Assertion{Created,Promoted,...}
//   - prov:wasAttributedTo links entity → agent
//   - prov:wasGeneratedBy links entity → creation activity
//   - prov:wasAssociatedWith links activity → agent
//   - prov:startedAtTime records when the activity happened
//   - prov:generated links activity → entity it produced/modified
//
// DKG-specific extensions (no PROV equivalent):
//   - dkg:state, dkg:memoryLayer — current mutable position
//   - dkg:fromLayer, dkg:toLayer — layer transition on each event
//   - dkg:assertionGraph, dkg:assertionName — DKG identity
//   - dkg:shareOperationId, dkg:kcUal, dkg:rootEntity — operation metadata

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
}

export function generateAssertionCreatedMetadata(meta: AssertionCreatedMeta): Quad[] {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const graphUri = contextGraphAssertionUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const agentUri = `did:dkg:agent:${meta.agentAddress}`;
  const eventUri = `${subject}/event/${nextEventId()}`;

  return [
    // Assertion entity (prov:Entity + DKG identity)
    mq(subject, `${RDF}type`, `${PROV}Entity`, metaGraph),
    mq(subject, `${RDF}type`, `${DKG}Assertion`, metaGraph),
    mq(subject, `${PROV}wasAttributedTo`, agentUri, metaGraph),
    mq(subject, `${PROV}wasGeneratedBy`, eventUri, metaGraph),
    mq(subject, `${DKG}contextGraph`, `did:dkg:context-graph:${meta.contextGraphId}`, metaGraph),
    mq(subject, `${DKG}assertionName`, lit(meta.assertionName), metaGraph),
    mq(subject, `${DKG}assertionGraph`, graphUri, metaGraph),
    mq(subject, `${DKG}state`, lit('created'), metaGraph),
    mq(subject, `${DKG}memoryLayer`, lit(MemoryLayer.WorkingMemory), metaGraph),
    // Event entity (prov:Activity + DKG layer transition)
    mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
    mq(eventUri, `${RDF}type`, `${DKG}AssertionCreated`, metaGraph),
    mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
    mq(eventUri, `${PROV}wasAssociatedWith`, agentUri, metaGraph),
    mq(eventUri, `${PROV}generated`, subject, metaGraph),
    mq(eventUri, `${DKG}fromLayer`, lit('none'), metaGraph),
    mq(eventUri, `${DKG}toLayer`, lit(MemoryLayer.WorkingMemory), metaGraph),
  ];
}

export interface AssertionPromotedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  shareOperationId: string;
  rootEntities: string[];
  timestamp: Date;
}

export function generateAssertionPromotedMetadata(meta: AssertionPromotedMeta): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const agentUri = `did:dkg:agent:${meta.agentAddress}`;
  const eventUri = `${subject}/event/${nextEventId()}`;

  const del = [
    assertionStateQuad(subject, 'created', metaGraph),
    assertionLayerQuad(subject, MemoryLayer.WorkingMemory, metaGraph),
  ];
  const ins: Quad[] = [
    // Update assertion entity (mutable fields)
    mq(subject, `${DKG}state`, lit('promoted'), metaGraph),
    mq(subject, `${DKG}memoryLayer`, lit(MemoryLayer.SharedWorkingMemory), metaGraph),
    // Event entity (prov:Activity + DKG layer transition)
    mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
    mq(eventUri, `${RDF}type`, `${DKG}AssertionPromoted`, metaGraph),
    mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
    mq(eventUri, `${PROV}wasAssociatedWith`, agentUri, metaGraph),
    mq(eventUri, `${PROV}used`, subject, metaGraph),
    mq(eventUri, `${DKG}fromLayer`, lit(MemoryLayer.WorkingMemory), metaGraph),
    mq(eventUri, `${DKG}toLayer`, lit(MemoryLayer.SharedWorkingMemory), metaGraph),
    mq(eventUri, `${DKG}shareOperationId`, lit(meta.shareOperationId), metaGraph),
  ];
  for (const entity of meta.rootEntities) {
    ins.push(mq(eventUri, `${DKG}rootEntity`, entity, metaGraph));
  }
  return { insert: ins, delete: del };
}

export interface AssertionPublishedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  kcUal: string;
  timestamp: Date;
}

export function generateAssertionPublishedMetadata(meta: AssertionPublishedMeta): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const agentUri = `did:dkg:agent:${meta.agentAddress}`;
  const eventUri = `${subject}/event/${nextEventId()}`;
  return {
    insert: [
      mq(subject, `${DKG}state`, lit('published'), metaGraph),
      mq(subject, `${DKG}memoryLayer`, lit(MemoryLayer.VerifiedMemory), metaGraph),
      mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
      mq(eventUri, `${RDF}type`, `${DKG}AssertionPublished`, metaGraph),
      mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
      mq(eventUri, `${PROV}wasAssociatedWith`, agentUri, metaGraph),
      mq(eventUri, `${PROV}used`, subject, metaGraph),
      mq(eventUri, `${DKG}fromLayer`, lit(MemoryLayer.SharedWorkingMemory), metaGraph),
      mq(eventUri, `${DKG}toLayer`, lit(MemoryLayer.VerifiedMemory), metaGraph),
      mq(eventUri, `${DKG}kcUal`, meta.kcUal, metaGraph),
    ],
    delete: [
      assertionStateQuad(subject, 'promoted', metaGraph),
      assertionLayerQuad(subject, MemoryLayer.SharedWorkingMemory, metaGraph),
    ],
  };
}

export interface AssertionDiscardedMeta {
  contextGraphId: string;
  agentAddress: string;
  assertionName: string;
  subGraphName?: string;
  timestamp: Date;
}

export function generateAssertionDiscardedMetadata(meta: AssertionDiscardedMeta): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const agentUri = `did:dkg:agent:${meta.agentAddress}`;
  const eventUri = `${subject}/event/${nextEventId()}`;
  return {
    insert: [
      mq(subject, `${DKG}state`, lit('discarded'), metaGraph),
      mq(subject, `${PROV}wasInvalidatedBy`, eventUri, metaGraph),
      mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
      mq(eventUri, `${RDF}type`, `${DKG}AssertionDiscarded`, metaGraph),
      mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
      mq(eventUri, `${PROV}wasAssociatedWith`, agentUri, metaGraph),
      mq(eventUri, `${PROV}used`, subject, metaGraph),
      mq(eventUri, `${DKG}fromLayer`, lit(MemoryLayer.WorkingMemory), metaGraph),
      mq(eventUri, `${DKG}toLayer`, lit('none'), metaGraph),
    ],
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
