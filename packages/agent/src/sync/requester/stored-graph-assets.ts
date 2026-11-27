// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphMetaUri, DEFAULT_MAX_READ_BYTES } from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest, GRAPH_KNOWLEDGE_ASSET_STORED_ENVELOPE_PREDICATES, GRAPH_KNOWLEDGE_ASSET_REPLAY_CONTROL_PREDICATES, parseStoredGraphKnowledgeAssetMetadataEnvelope, type GraphKnowledgeAssetMetadataRead } from '@origintrail-official/dkg-publisher';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { heldMetadataControlsMatchReplay } from './held-metadata-controls.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphScopedDescriptor } from '../durable-integrity.js';
import { verifyExactGraphContent } from '../../exact-graph-content-verifier.js';
import { commitmentFromDescriptor, type FinalizedVmAssetCommitment } from './finalized-vm-asset-commitment.js';

export type HeldGraphScopedAssetEvidence =
  | { readonly kind: 'confirmed'; readonly commitment: FinalizedVmAssetCommitment }
  | { readonly kind: 'integrity-only' };

/** Assets per store read: one VALUES list of exact metadata subjects. */
const HOLDINGS_READ_CHUNK = 200;
const AUTHENTICATED_SUB_GRAPH = 'http://dkg.io/ontology/authenticatedSubGraphName';

export interface HeldGraphScopedAssetsRequest {
  readonly contextGraphId: string;
  readonly descriptors: readonly GraphScopedDescriptor[];
  readonly signal?: AbortSignal;
}

/**
 * The assets of a verified META generation that this node already holds: a
 * graph-scoped copy (confirmed, or explicitly integrity-only in no-chain mode) at the descriptor's version, root, row counts,
 * graph and sub-graph, whose assertion graph still holds exactly the declared
 * number of public rows and hashes to the declared root, including any private
 * root commitment. Metadata and cardinality alone cannot prove a copy: a write
 * before this recovery (or a process restart) may have changed rows without
 * changing either. Read and verify one assertion at a time, bounded by its
 * declared size plus one row. Whether it is current on chain is checked next.
 */
export async function readHeldGraphScopedAssets(
  store: TripleStore,
  request: HeldGraphScopedAssetsRequest,
  chunkSize = HOLDINGS_READ_CHUNK,
  confirmation: 'confirmed' | 'integrity-only' = 'confirmed',

): Promise<Map<string, HeldGraphScopedAssetEvidence>> {
  const metaGraph = assertSafeIri(contextGraphMetaUri(request.contextGraphId));
  // The publisher's stored projection is what its parser reads or refuses; the route and replay controls are ours.
  const predicates = [AUTHENTICATED_SUB_GRAPH, ...GRAPH_KNOWLEDGE_ASSET_STORED_ENVELOPE_PREDICATES, ...GRAPH_KNOWLEDGE_ASSET_REPLAY_CONTROL_PREDICATES].map((predicate) => `<${predicate}>`).join(' ');
  const options = { priority: 'background' as const, signal: request.signal };
  const held = new Map<string, HeldGraphScopedAssetEvidence>();
  for (let start = 0; start < request.descriptors.length; start += chunkSize) {
    const chunk = request.descriptors.slice(start, start + chunkSize);
    const subjects = chunk.map((descriptor) => `<${assertSafeIri(descriptor.ual)}>`).join(' ');
    // sparql-scan-allow: R4 -- exact meta graph; subjects and predicates are bound by finite VALUES lists
    const result = await store.query(
      `SELECT ?ual ?predicate ?object WHERE { GRAPH <${metaGraph}> { VALUES ?ual { ${subjects} } VALUES ?predicate { ${predicates} } ?ual ?predicate ?object } }`,
      { ...options, source: 'agent.durableSync.heldAssets' },
    );
    if (result.type !== 'bindings') throw new Error('Held asset metadata SELECT expected a bindings result');
    const rowsBySubject = new Map<string, Array<{ predicate: string; object: string }>>();
    for (const { ual, predicate, object } of result.bindings) {
      if (ual === undefined || predicate === undefined || object === undefined) {
        throw new Error('Held asset metadata SELECT returned an incomplete binding');
      }
      const rows = rowsBySubject.get(ual) ?? [];
      rows.push({ predicate, object });
      rowsBySubject.set(ual, rows);
    }
    const confirmed = new Set<string>();
    const eligible = chunk.filter(descriptor => {
      const rows = rowsBySubject.get(descriptor.ual) ?? [];
      const stored = parseStoredGraphKnowledgeAssetMetadataEnvelope(
        rows.map(row => ({ ...row, graph: metaGraph })),
        { contextGraphId: request.contextGraphId, ual: descriptor.ual });
      if (stored.state === 'confirmed') confirmed.add(descriptor.ual);
      // Authenticated replay restores this receiver-owned route. A named copy
      // without it can be complete in storage yet invisible to scoped queries.
      const routes = rows.filter(row => row.predicate === AUTHENTICATED_SUB_GRAPH);
      const expectedRoute = stored.state === 'confirmed' ? descriptor.subGraphName : undefined;
      const routingMatches = expectedRoute === undefined ? routes.length === 0
        : routes.length === 1 && parseRdfLiteralTerm(routes[0]!.object)?.value === expectedRoute;
      return routingMatches && holdsDescriptor(descriptor, stored, confirmation);
    });
    for (const descriptor of eligible) {
      request.signal?.throwIfAborted();
      if (!await heldMetadataControlsMatchReplay(store, metaGraph, descriptor.ual,
        rowsBySubject.get(descriptor.ual) ?? [], options)) continue;
      const content = await verifyExactGraphContent(store, {
        graphUri: descriptor.assertionGraph,
        publicTripleCount: descriptor.publicTripleCount,
        // Durable recovery permits one whole asset beyond its round budget. Each
        // accepted row fits a bounded wire response; the descriptor bounds how
        // many such rows this proof can retain. Do not inherit export defaults.
        readLimits: { maxQuadCount: descriptor.publicTripleCount,
          maxNQuadsBytes: Math.min(Number.MAX_SAFE_INTEGER, descriptor.publicTripleCount * DEFAULT_MAX_READ_BYTES) },
        privateMerkleRoot: descriptor.privateRoot,
        expectedMerkleRoot: Buffer.from(descriptor.claimedRootHex, 'hex'),
        source: 'agent.durableSync.heldAssetContent', queryOptions: options,
      });
      request.signal?.throwIfAborted();
      if (content.status !== 'verified') continue;
      // Membership and cleanup authority are one result, including tentative no-chain copies.
      held.set(descriptor.ual, confirmed.has(descriptor.ual)
        ? { kind: 'confirmed', commitment: commitmentFromDescriptor(descriptor, workspacePublicQuadsDigest(content.quads)) }
        : { kind: 'integrity-only' });
    }
  }
  return held;
}

/** The holdings reader a recovery host gives graph-owned rounds. */
export function heldGraphScopedAssetsReader(
  store: TripleStore,
  confirmation: () => 'confirmed' | 'integrity-only' = () => 'confirmed',
): (request: HeldGraphScopedAssetsRequest) => Promise<Set<string>> {
  return async (request) => new Set((await readHeldGraphScopedAssets(store, request, undefined, confirmation())).keys());
}

function holdsDescriptor(
  descriptor: GraphScopedDescriptor,
  stored: GraphKnowledgeAssetMetadataRead,
  confirmation: 'confirmed' | 'integrity-only',
): boolean {
  if (stored.state !== 'confirmed' && !(confirmation === 'integrity-only' && stored.state === 'tentative')) return false;
  const { envelope } = stored;
  return BigInt(envelope.assertionVersion) === BigInt(descriptor.assertionVersion)
    && Buffer.from(envelope.merkleRoot).toString('hex') === descriptor.claimedRootHex
    && envelope.assertionGraph === descriptor.assertionGraph
    && envelope.publicTripleCount === descriptor.publicTripleCount
    && envelope.privateTripleCount === descriptor.privateTripleCount
    && (envelope.privateMerkleRoot === undefined
      ? undefined
      : Buffer.from(envelope.privateMerkleRoot).toString('hex')) === descriptor.privateRootHex
    && envelope.subGraphName === descriptor.subGraphName;
}

