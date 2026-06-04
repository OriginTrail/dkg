import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { validateSubGraphName, isSafeIri, assertionLifecycleUri, contextGraphAssertionUri, contextGraphDataUri, contextGraphMetaUri, MemoryLayer, ASSERTION_STATE_TO_LAYER } from '@origintrail-official/dkg-core';
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
   * RFC-001 §3.5 off-chain provenance mirror. When both `authorAddress`
   * and `publishOperationId` are supplied, `generateKCMetadata` emits a
   * `dkg:Publication` resource at `urn:dkg:publication:{publishOperationId}`
   * carrying:
   *   a dkg:Publication ;
   *   dkg:publishOperationId "..." ;
   *   dkg:contextGraphId "..." ;
   *   dkg:merkleRoot "0x..."^^xsd:hexBinary ;
   *   dkg:authoredBy "0x..." .
   * and links each KA via `<kaUri> dkg:publication <publication-uri>`.
   *
   * These triples are pure SPARQL-filtering convenience — the on-chain
   * `KnowledgeBatch.authorAddress` remains canonical (RFC-001 §3.5,
   * point 1). Implementations that don't need rich provenance queries
   * can omit these fields and the publication subject is not emitted.
   */
  authorAddress?: string;
  publishOperationId?: string;
}

export interface KAMetadata {
  rootEntity: string;
  kcUal: string;
  /** Real on-chain KA NFT id when confirmed. */
  tokenId: bigint;
  /** Per-root compatibility row id used for `<ual>/1`, `<ual>/2`, ... subjects. */
  metadataTokenId?: bigint;
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
    mq(
      meta.ual,
      `${DKG}publishedAt`,
      dateLit(meta.timestamp),
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

  // KA metadata. OT-RFC-44 keeps one on-chain KA per file/lifecycle, but the
  // current update and private-access paths still resolve per-root label rows
  // at <ual>/1, <ual>/2, ... . Keep this compatibility shape until those
  // consumers are migrated to aggregate multi-root KA metadata directly.
  const kaUriFor = (ka: KAMetadata): string => `${ka.kcUal}/${ka.metadataTokenId ?? ka.tokenId}`;
  if (kaEntries.length > 0) {
    const publicTripleCount = kaEntries.reduce((sum, ka) => sum + ka.publicTripleCount, 0);
    const privateTripleCount = kaEntries.reduce((sum, ka) => sum + ka.privateTripleCount, 0);
    const tokenIds = [...new Set(kaEntries.map((ka) => ka.tokenId.toString()))];
    const rootEntities = [...new Set(kaEntries.map((ka) => ka.rootEntity))];
    quads.push(
      mq(meta.ual, `${RDF}type`, `${DKG}KnowledgeAsset`, metaGraph),
      mq(meta.ual, `${DKG}partOf`, meta.ual, metaGraph),
      mq(meta.ual, `${DKG}publicTripleCount`, intLit(publicTripleCount), metaGraph),
    );
    for (const tokenId of tokenIds) {
      quads.push(mq(meta.ual, `${DKG}tokenId`, intLit(BigInt(tokenId)), metaGraph));
    }
    for (const rootEntity of rootEntities) {
      quads.push(mq(meta.ual, `${DKG}rootEntity`, rootEntity, metaGraph));
    }
    if (privateTripleCount > 0) {
      quads.push(mq(meta.ual, `${DKG}privateTripleCount`, intLit(privateTripleCount), metaGraph));
      const privateRoots = kaEntries.filter((ka) => ka.privateMerkleRoot);
      if (privateRoots.length === 1 && privateRoots[0].privateMerkleRoot) {
        quads.push(mq(meta.ual, `${DKG}privateMerkleRoot`, lit(toHex(privateRoots[0].privateMerkleRoot)), metaGraph));
      }
    }
  }

  for (const ka of kaEntries) {
    const kaUri = kaUriFor(ka);
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

  // RFC-001 §3.5 — optional `dkg:Publication` provenance subject. Emitted
  // only when both `authorAddress` and `publishOperationId` are supplied
  // so existing callers that don't propagate author identity see no
  // behavior change.
  if (meta.authorAddress && meta.publishOperationId) {
    const publicationUri = `urn:dkg:publication:${meta.publishOperationId}`;
    quads.push(
      mq(publicationUri, `${RDF}type`, `${DKG}Publication`, metaGraph),
      mq(publicationUri, `${DKG}publishOperationId`, lit(meta.publishOperationId), metaGraph),
      mq(publicationUri, `${DKG}contextGraphId`, lit(meta.contextGraphId), metaGraph),
      mq(publicationUri, `${DKG}merkleRoot`, hexLit(toHex(meta.merkleRoot)), metaGraph),
      mq(publicationUri, `${DKG}authoredBy`, lit(meta.authorAddress), metaGraph),
    );
    for (const ka of kaEntries) {
      const kaUri = kaUriFor(ka);
      quads.push(mq(kaUri, `${DKG}publication`, publicationUri, metaGraph));
    }
    quads.push(mq(meta.ual, `${DKG}publication`, publicationUri, metaGraph));
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

function hexLit(hex: string): string {
  // `xsd:hexBinary` lexical space is hex digits ONLY — no `0x` prefix
  // (per XML Schema Part 2: Datatypes, §3.2.16). A typed literal
  // `"0x..."^^xsd:hexBinary` is invalid for RDF value-equality
  // semantics (SPARQL `=` operator on hexBinary compares decoded
  // bytes; an invalid lexical form yields no match). Emit the bare
  // hex digits as the lexical value, no `0x` prefix.
  const bare = hex.startsWith('0x') ? hex.slice(2) : hex;
  return `"${bare}"^^<${XSD}hexBinary>`;
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
    mq(blankNode, `${DKG}agent`, agentDid(proof.agentAddress), metaGraph),
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
    mq(subject, `${DKG}agent`, agentDid(meta.agentAddress), metaGraph),
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
): Promise<boolean> {
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
  await store.insert([{
    subject: ual,
    predicate: MATERIALIZED_VERSION_PRED,
    object: lit(`${version.blockNumber}:${version.txIndex}`),
    graph: metaGraph,
  }]);
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
 * minimal meta shape the RS prover needs (`partOf` / `rootEntity` /
 * `privateMerkleRoot` / `batchId` / `merkleRoot`). Used for the per-cgId
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
  const rootsToPurge = new Set<string>(payloadByRoot.keys());
  const priorRes = await store.query(
    `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?ka <${DKG}partOf> <${ual}> ; <${DKG}rootEntity> ?root } }`,
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

  // 2. Delete prior KA meta rows (?ka partOf <ual>); KC-level <ual> rows stay.
  const priorKaRes = await store.query(
    `SELECT DISTINCT ?ka WHERE { GRAPH <${metaGraph}> { ?ka <${DKG}partOf> <${ual}> } }`,
  );
  if (priorKaRes.type === 'bindings') {
    for (const row of priorKaRes.bindings) {
      const ka = row['ka'];
      if (ka) await store.deleteByPattern({ graph: metaGraph, subject: ka });
    }
  }

  // 3. Insert payload public triples.
  const dataQuads: Quad[] = [];
  for (const quads of payloadByRoot.values()) {
    for (const q of quads) dataQuads.push({ ...q, graph: dataGraph });
  }
  if (dataQuads.length > 0) await store.insert(dataQuads);

  // 4. Insert fresh minimal KA meta rows.
  //    Iterate roots in INSERTION order (= manifest/publisher order), NOT
  //    lex order. `<ual>/1`, `<ual>/2`, ... are stable, numerically-keyed
  //    KA identifiers; a lex sort would put `<ual>/10` before `<ual>/2` and
  //    permute the token→root binding on every restate (Codex review on
  //    PR #845).
  const roots = [...payloadByRoot.keys()];
  const metaQuads: Quad[] = [];
  let tokenIdx = 1;
  for (const root of roots) {
    const kaUri = `${ual}/${tokenIdx++}`;
    metaQuads.push(
      mq(kaUri, `${RDF}type`, `${DKG}KnowledgeAsset`, metaGraph),
      mq(kaUri, `${DKG}partOf`, ual, metaGraph),
      mq(kaUri, `${DKG}rootEntity`, root, metaGraph),
    );
    const privRoot = privateRootByRoot?.get(root);
    if (privRoot && privRoot.length > 0) {
      metaQuads.push(mq(kaUri, `${DKG}privateMerkleRoot`, lit(toHex(privRoot)), metaGraph));
    }
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
 * the KA's rich publish metadata (type, provenance, …) and only:
 *  - deletes the prior root entities' DATA (so `agent.query` no longer returns
 *    stale pre-update triples — the full-restatement bug, GH#842 §7.1), and
 *  - repoints `dkg:rootEntity` / `dkg:privateMerkleRoot` on the existing KA
 *    rows to the new payload roots (so `resolveKA` doesn't dangle), and
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

  // Preserve INSERTION order from the caller (manifest order). Lex-sorting
  // breaks the token→root binding for KAs with ≥10 batches because
  // `<ual>/10` sorts before `<ual>/2` (Codex review on PR #845).
  const newRoots = [...payloadByRoot.keys()];

  // 1. Resolve prior KA rows (ka↔root) from the label meta.
  const priorKaRows: { ka: string; root: string }[] = [];
  const priorRes = await store.query(
    `SELECT ?ka ?root WHERE { GRAPH <${metaGraph}> { ?ka <${DKG}partOf> <${ual}> ; <${DKG}rootEntity> ?root } }`,
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

  // 3. Repoint rootEntity / privateMerkleRoot on existing KA rows (by token
  //    order), minting rows only when the update grew the KA's root count.
  //    Everything else on the ?ka subject (provenance, type, …) is preserved.
  //    Sort kaSubjects by NUMERIC token suffix (`<ual>/<n>`), not lex —
  //    otherwise `<ual>/10` sorts before `<ual>/2` and the retained tokens
  //    get bound to the wrong roots (Codex review on PR #845).
  const kaPrefix = `${ual}/`;
  const kaSubjects = [...new Set(priorKaRows.map((r) => r.ka))].sort((a, b) => {
    const na = Number(a.startsWith(kaPrefix) ? a.slice(kaPrefix.length) : NaN);
    const nb = Number(b.startsWith(kaPrefix) ? b.slice(kaPrefix.length) : NaN);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  for (const ka of kaSubjects) {
    await store.deleteByPattern({ graph: metaGraph, subject: ka, predicate: `${DKG}rootEntity` });
    await store.deleteByPattern({ graph: metaGraph, subject: ka, predicate: `${DKG}privateMerkleRoot` });
  }
  // If the update SHRANK the root count, the surplus ka subjects must be
  // removed entirely. Just dropping `dkg:rootEntity` leaves them with
  // `rdf:type dkg:KnowledgeAsset` + `dkg:partOf <ual>` still present, so
  // enumeration queries would keep returning phantom tokens from the prior
  // version (Codex review on PR #845).
  if (kaSubjects.length > newRoots.length) {
    for (let i = newRoots.length; i < kaSubjects.length; i++) {
      await store.deleteByPattern({ graph: metaGraph, subject: kaSubjects[i] });
    }
  }
  const metaQuads: Quad[] = [];
  for (let i = 0; i < newRoots.length; i++) {
    const root = newRoots[i];
    const existing = kaSubjects[i];
    const ka = existing ?? `${ual}/${i + 1}`;
    metaQuads.push(mq(ka, `${DKG}rootEntity`, root, metaGraph));
    if (!existing) {
      metaQuads.push(
        mq(ka, `${RDF}type`, `${DKG}KnowledgeAsset`, metaGraph),
        mq(ka, `${DKG}partOf`, ual, metaGraph),
      );
    }
    const privRoot = privateRootByRoot?.get(root);
    if (privRoot && privRoot.length > 0) {
      metaQuads.push(mq(ka, `${DKG}privateMerkleRoot`, lit(toHex(privRoot)), metaGraph));
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
  const agentUri = agentDid(meta.agentAddress);
  const eventUri = `${subject}/event/${nextEventId()}`;

  const quads: Quad[] = [
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
  shareOperationId: string;
  rootEntities: string[];
  timestamp: Date;
}

export function generateAssertionPromotedMetadata(meta: AssertionPromotedMeta): { insert: Quad[]; delete: Quad[] } {
  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const subject = assertionLifecycleUri(meta.contextGraphId, meta.agentAddress, meta.assertionName, meta.subGraphName);
  const agentUri = agentDid(meta.agentAddress);
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
  if (meta.subGraphName) {
    ins.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
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
  const agentUri = agentDid(meta.agentAddress);
  const eventUri = `${subject}/event/${nextEventId()}`;
  const ins: Quad[] = [
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
  ];
  if (meta.subGraphName) {
    ins.push(mq(subject, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }
  return {
    insert: ins,
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
  const agentUri = agentDid(meta.agentAddress);
  const eventUri = `${subject}/event/${nextEventId()}`;
  const ins: Quad[] = [
    mq(subject, `${DKG}state`, lit('discarded'), metaGraph),
    mq(subject, `${PROV}wasInvalidatedBy`, eventUri, metaGraph),
    mq(eventUri, `${RDF}type`, `${PROV}Activity`, metaGraph),
    mq(eventUri, `${RDF}type`, `${DKG}AssertionDiscarded`, metaGraph),
    mq(eventUri, `${PROV}startedAtTime`, dateLit(meta.timestamp), metaGraph),
    mq(eventUri, `${PROV}wasAssociatedWith`, agentUri, metaGraph),
    mq(eventUri, `${PROV}used`, subject, metaGraph),
    mq(eventUri, `${DKG}fromLayer`, lit(MemoryLayer.WorkingMemory), metaGraph),
    mq(eventUri, `${DKG}toLayer`, lit('none'), metaGraph),
  ];
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
