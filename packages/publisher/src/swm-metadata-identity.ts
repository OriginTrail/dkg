// SPDX-License-Identifier: Apache-2.0

import { isSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SWM_PREDICATES as P } from './swm-metadata-vocabulary.js';
import { workspaceOperationSubject } from './workspace-metadata-subjects.js';

export interface SwmOperationIdentity {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly subGraphName?: string;
}
/** Historical admission permits omitted identity fields. Graph admission requires
 * identity values. Snapshot readiness also requires one distinct RDF term per field. */
export type SwmMetadataIdentityPolicy = 'historical-admission' | 'graph-admission' | 'snapshot-readiness';

export function swmMetadataLiteralValue(rows: readonly Quad[], predicate: string,
  policy: SwmMetadataIdentityPolicy = 'historical-admission'): string | undefined {
  const terms = rows.filter(row => row.predicate === predicate).map(row => row.object);
  if (policy === 'snapshot-readiness' && new Set(terms).size !== 1) return undefined;
  const values = new Set<string>();
  for (const term of terms) {
    const literal = parseRdfLiteralTerm(term);
    if (!literal) return undefined;
    values.add(literal.value);
  }
  return values.size === 1 ? [...values][0] : undefined;
}

export function matchesSwmMetadataIdentity(rows: readonly Quad[], identity: SwmOperationIdentity,
  policy: SwmMetadataIdentityPolicy): boolean {
  const required = policy !== 'historical-admission';
  const claims: Array<[string, string | undefined, boolean]> = [
    [P.contextGraphId, identity.contextGraphId, required],
    [P.shareOperationId, identity.shareOperationId, required],
    [P.subGraphName, identity.subGraphName, required && identity.subGraphName !== undefined],
  ];
  return claims.every(([predicate, expected, mandatory]) => {
    if (!rows.some(row => row.predicate === predicate)) return !mandatory;
    const value = swmMetadataLiteralValue(rows, predicate, policy);
    return value !== undefined && value === expected;
  });
}

/** Canonical operation subject and metadata graph share the same identity. */
export function decodeSwmOperationIdentity(subject: string, metaGraph: string): SwmOperationIdentity | undefined {
  const prefix = 'did:dkg:context-graph:';
  const suffix = '/_shared_memory_meta';
  if (!isSafeIri(metaGraph) || !metaGraph.startsWith(prefix) || !metaGraph.endsWith(suffix)) return undefined;
  const graphId = metaGraph.slice(prefix.length, -suffix.length);
  const candidates: Array<{ contextGraphId: string; subGraphName?: string }> = [{ contextGraphId: graphId }];
  const slash = graphId.lastIndexOf('/');
  if (slash > 0 && validateSubGraphName(graphId.slice(slash + 1)).valid) {
    candidates.push({ contextGraphId: graphId.slice(0, slash), subGraphName: graphId.slice(slash + 1) });
  }
  for (const candidate of candidates) {
    const operationPrefix = `urn:dkg:share:${candidate.contextGraphId}:`;
    if (!subject.startsWith(operationPrefix)) continue;
    const shareOperationId = subject.slice(operationPrefix.length);
    if (!shareOperationId) continue;
    try {
      if (workspaceOperationSubject(candidate.contextGraphId, shareOperationId) === subject) {
        return { ...candidate, shareOperationId };
      }
    } catch { /* An invalid candidate cannot identify a canonical record. */ }
  }
  return undefined;
}
