import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Historical producer output from 7347c165e255fa0a49219aabfa53d3f2c2e219da:
 * packages/publisher/src/metadata.ts generateShareMetadata, and
 * packages/publisher/src/workspace-resolution.ts storeWorkspaceOperationPublicQuads.
 * Keep this independent of current producers: neither record carried identity
 * literals, and the public slice stored JSON rather than a snapshot reference.
 */
export function legacySwm20260507(contextGraphId: string, subGraphName?: string) {
  const prefix = `did:dkg:context-graph:${contextGraphId}${subGraphName ? `/${subGraphName}` : ''}`;
  const graph = `${prefix}/_shared_memory_meta`;
  const root = 'urn:historical:root';
  const operationId = 'historical-operation';
  const operation = `urn:dkg:share:${contextGraphId}:${operationId}`;
  const slice = `urn:dkg:public-stage:${[contextGraphId, subGraphName ?? '_', operationId, root].map(encodeURIComponent).join(':')}`;
  const data: Quad[] = [{ subject: root, predicate: 'urn:historical:value', object: '"kept"', graph: `${prefix}/_shared_memory` }];
  const metadata: Quad[] = [
    { subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation', graph },
    { subject: operation, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: '"historical-peer"', graph },
    { subject: operation, predicate: 'http://dkg.io/ontology/publishedAt', object: '"2026-05-07T12:44:37.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph },
    { subject: operation, predicate: 'http://dkg.io/ontology/rootEntity', object: root, graph },
    { subject: slice, predicate: 'http://dkg.io/ontology/publicStagedQuads', object: JSON.stringify(JSON.stringify(data)), graph },
    { subject: slice, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: '"historical-peer"', graph },
  ];
  return { data, metadata, root, operation, slice };
}
