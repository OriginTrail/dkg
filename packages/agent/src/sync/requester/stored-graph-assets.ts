// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES, parseGraphKnowledgeAssetMetadataEnvelope, type GraphKnowledgeAssetMetadataRead } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphScopedDescriptor } from '../durable-integrity.js';
import { verifyExactGraphContent } from '../../exact-graph-content-verifier.js';

/** Assets per store read: one VALUES list of exact metadata subjects. */
const HOLDINGS_READ_CHUNK = 200;

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
): Promise<Set<string>> {
  const metaGraph = assertSafeIri(contextGraphMetaUri(request.contextGraphId));
  const predicates = GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES.map((predicate) => `<${predicate}>`).join(' ');
  const options = { priority: 'background' as const, signal: request.signal };
  const held = new Set<string>();
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
    const eligible = chunk.filter((descriptor) => holdsDescriptor(
      descriptor,
      parseGraphKnowledgeAssetMetadataEnvelope(
        rowsBySubject.get(descriptor.ual) ?? [],
        { contextGraphId: request.contextGraphId, ual: descriptor.ual },
      ), confirmation,
    ));
    for (const descriptor of eligible) {
      request.signal?.throwIfAborted();
      const content = await verifyExactGraphContent(store, {
        graphUri: descriptor.assertionGraph,
        publicTripleCount: descriptor.publicTripleCount,
        privateMerkleRoot: descriptor.privateRoot,
        expectedMerkleRoot: Buffer.from(descriptor.claimedRootHex, 'hex'),
        source: 'agent.durableSync.heldAssetContent', queryOptions: options,
      });
      if (content.status !== 'verified') continue;
      held.add(descriptor.ual);
    }
  }
  return held;
}

/** The holdings reader a recovery host gives graph-owned rounds. */
export function heldGraphScopedAssetsReader(
  store: TripleStore,
  confirmation: () => 'confirmed' | 'integrity-only' = () => 'confirmed',
): (request: HeldGraphScopedAssetsRequest) => Promise<Set<string>> {
  return (request) => readHeldGraphScopedAssets(store, request, undefined, confirmation());
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

