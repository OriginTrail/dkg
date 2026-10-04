// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphDataUri, contextGraphStorageOwnerCandidates, isSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import type { TripleStore } from './triple-store.js';

export interface KnowledgeAssetPrivateArtifact {
  readonly graphUri: string;
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly agentAddress: string;
  readonly kaNumber: string;
  readonly assertionVersion: string;
  readonly commitmentId?: string;
}

/** Inverse of the version and commitment URI builders, including legacy partitions. */
export function decodeKnowledgeAssetPrivateArtifact(contextGraphId: string, graphUri: string): KnowledgeAssetPrivateArtifact | undefined {
  const prefix = `${contextGraphDataUri(contextGraphId)}/`;
  if (!graphUri.startsWith(prefix)) return undefined;
  const match = /^(?:(?<sub>[^/]+)\/)?_private\/(?<author>0x[0-9a-fA-F]{40})\/(?<number>[1-9][0-9]*)\/assertions\/(?<version>[1-9][0-9]*)(?:\/commitments\/(?<commitment>[0-9a-fA-F]{64}))?$/.exec(graphUri.slice(prefix.length));
  const parts = match?.groups;
  if (!parts || !isSafeIri(graphUri)) return undefined;
  return { graphUri, contextGraphId, subGraphName: parts['sub'], agentAddress: parts['author']!.toLowerCase(),
    kaNumber: parts['number']!, assertionVersion: parts['version']!, commitmentId: parts['commitment']?.toLowerCase() };
}

/** Graph-index paging excludes empty graphs; unrecognized layouts still advance the cursor. */
export async function readKnowledgeAssetPrivateArtifactsPage(
  store: TripleStore,
  contextGraphId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ artifacts: readonly KnowledgeAssetPrivateArtifact[]; nextCursor: string } | undefined> {
  const limit = options.limit ?? 32;
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('Private artifact page limit must be between 1 and 128');
  const prefix = `${assertSafeIri(contextGraphDataUri(contextGraphId))}/`;
  const result = await store.query(`SELECT ?graph WHERE {
    GRAPH ?graph {}
    FILTER(STRSTARTS(STR(?graph), ${sparqlString(prefix)}) && CONTAINS(STR(?graph), "/_private/"))
    FILTER(STR(?graph) > ${sparqlString(options.cursor ?? '')})
    FILTER EXISTS { GRAPH ?graph { ?s ?p ?o } }
  } ORDER BY ?graph LIMIT ${limit}`, { source: 'storage.privateArtifacts.page', priority: 'background' });
  if (result.type !== 'bindings' || result.bindings.some(row => !row['graph'])) return undefined;
  return {
    artifacts: result.bindings.flatMap(row => { const artifact = decodeKnowledgeAssetPrivateArtifact(contextGraphId, row['graph']!); return artifact ? [artifact] : []; }),
    nextCursor: result.bindings.length === limit ? result.bindings.at(-1)!['graph']! : '',
  };
}

/** Every legal namespace interpretation must retain references and share collection locks. */
export function knowledgeAssetPrivateArtifactOwnerCandidates(graphUri: string): readonly Pick<KnowledgeAssetPrivateArtifact, 'contextGraphId' | 'subGraphName'>[] {
  return (contextGraphStorageOwnerCandidates(graphUri) ?? []).flatMap(contextGraphId => {
    const artifact = decodeKnowledgeAssetPrivateArtifact(contextGraphId, graphUri);
    return artifact ? [{ contextGraphId, subGraphName: artifact.subGraphName }] : [];
  });
}

