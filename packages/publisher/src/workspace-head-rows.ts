// SPDX-License-Identifier: Apache-2.0

import { GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { GraphManager, Quad } from '@origintrail-official/dkg-storage';
import { workspaceKnowledgeAssetHeadSubject } from './workspace-metadata-subjects.js';

/** The canonical persisted current-head schema, shared by writes and exact replay proofs. */
export function knowledgeAssetWorkspaceHeadRows(params: {
  graphManager: GraphManager; contextGraphId: string; kaUal: string;
  assertionVersion: string | number | bigint; shareOperationId: string; subGraphName?: string;
}): Quad[] {
  const scope = createGraphKnowledgeAssetScope(params.kaUal, params.assertionVersion);
  const subGraphName = params.subGraphName?.trim() || undefined;
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Lift shared-memory resolution rejected invalid subGraphName "${params.subGraphName}": ${validation.reason}`);
  }
  const graph = params.graphManager.sharedMemoryMetaUri(params.contextGraphId, subGraphName);
  const subject = workspaceKnowledgeAssetHeadSubject(scope.ual);
  const assertionGraph = knowledgeAssetLayerGraphUri(params.contextGraphId, MemoryLayer.SharedWorkingMemory, scope, subGraphName);
  const dkg = 'http://dkg.io/ontology/';
  const integer = (value: number | bigint) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
  return [
    { subject, predicate: `${dkg}contentScopeVersion`, object: integer(GRAPH_KA_CONTENT_SCOPE_VERSION), graph },
    { subject, predicate: `${dkg}kaUal`, object: scope.ual, graph },
    { subject, predicate: `${dkg}assertionVersion`, object: integer(BigInt(scope.assertionVersion)), graph },
    { subject, predicate: `${dkg}assertionGraph`, object: assertionGraph, graph },
    { subject, predicate: `${dkg}shareOperationId`, object: JSON.stringify(params.shareOperationId), graph },
  ];
}
