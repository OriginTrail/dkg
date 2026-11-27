// SPDX-License-Identifier: Apache-2.0

import type { Quad, Rfc64AuthorCommitCasInputV1 } from '@origintrail-official/dkg-storage';

/** A semantic RFC-64 author commit over made-up graphs; the projection graph and its payload can be chosen. */
export function commitInput(
  options: { sharedProjectionGraph?: string; sharedProjectionQuads?: readonly Quad[] } = {},
): Rfc64AuthorCommitCasInputV1 {
  const graph = options.sharedProjectionGraph ?? 'did:dkg:context-graph:rfc64/_shared_memory';
  const stateGraph = 'urn:test:rfc64:state';
  const transition = (subject: string, predicate: string, oldValue: string, nextValue: string) => ({
    graphUri: stateGraph,
    subject,
    predicate,
    expectedObject: oldValue,
    expectedQuads: [{ subject, predicate, object: oldValue, graph: stateGraph }],
    quads: [{ subject, predicate, object: nextValue, graph: stateGraph }],
  });
  return {
    sharedProjectionGraph: graph,
    sharedProjectionQuads: options.sharedProjectionQuads
      ?? [{ subject: 'urn:ka', predicate: 'urn:p', object: '"v"', graph }],
    authorSealGraph: 'urn:seals',
    authorSealSubject: 'urn:seal',
    authorSealQuads: [{ subject: 'urn:seal', predicate: 'urn:p', object: '"seal"', graph: 'urn:seals' }],
    currentHead: {
      graphUri: 'urn:heads',
      subject: 'urn:author',
      predicate: 'urn:head',
      expectedObject: 'urn:old',
      expectedQuads: [{ subject: 'urn:author', predicate: 'urn:head', object: 'urn:old', graph: 'urn:heads' }],
      quads: [{ subject: 'urn:author', predicate: 'urn:head', object: 'urn:new', graph: 'urn:heads' }],
    },
    subgraphMutationGeneration: transition('urn:subgraph-mutation', 'urn:generation', '"1"', '"2"'),
    contextGraphMutationGeneration: transition('urn:cg-mutation', 'urn:generation', '"10"', '"11"'),
    appliedSet: transition('urn:applied-set', 'urn:root', 'urn:old-root', 'urn:new-root'),
  };
}
