// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { decodeRegisteredSubGraphName } from './registered-sub-graphs.js';

export function registeredAssertionGraphPattern(contextGraphId: string): string {
  return `GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> { ?assertion <http://dkg.io/ontology/assertionGraph> ?assertionGraph . }`;
}
export const CHILD_CONTEXT_GRAPH_PREDICATES = [
  'a <https://dkg.network/ontology#ContextGraph>',
  '<https://dkg.network/ontology#registrationStatus> ?status',
] as const;
export function decodePartitionMetadataFact(row: Record<string, string>) {
  return { subGraphName: decodeRegisteredSubGraphName(row.name),
    assertionGraph: row.assertionGraph, childContextGraph: row.ctxGraph };
}
