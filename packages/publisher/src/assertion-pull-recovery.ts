// SPDX-License-Identifier: Apache-2.0
import {
  ASSERTION_SEAL_PREDICATES, MemoryLayer, assertSafeIri,
  contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
  type AssertionSeal,
} from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, tryUpdateWithTouchedGraphs,
  type GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { parsePromoteOperationIntent } from './promote-operation-intent.js';
import { resolveKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';

import { lifecycleTerms, lifecycleLiteral, type AssertionPromoteAssessment } from './assertion-promote-assessment.js';
const sealPredicates = new Set<string>(Object.values(ASSERTION_SEAL_PREDICATES));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** One scoped update on native stores; older adapters remain safely resumable. */
export async function clearAssertionSealPredicates(
  store: TripleStore, graph: string, subjects: readonly string[],
): Promise<void> {
  if (!subjects.length) return;
  const iri = (value: string) => `<${assertSafeIri(value)}>`;
  if (await tryUpdateWithTouchedGraphs(store,
    `DELETE { GRAPH ${iri(graph)} { ?subject ?predicate ?object } } WHERE {
      VALUES ?subject { ${subjects.map(iri).join(' ')} }
      VALUES ?predicate { ${[...sealPredicates].map(iri).join(' ')} }
      GRAPH ${iri(graph)} { ?subject ?predicate ?object }
    }`, [graph], { source: 'publisher.pullFrom.clearActiveSeal' })) return;
  for (const subject of subjects) {
    for (const predicate of sealPredicates) {
      await deleteByPatternWithoutCount(store, { graph, subject, predicate });
    }
  }
}

/**
 * This proof is usable only by pull-from, AFTER both source partitions match the
 * archived seal. It never authorizes create/write/discard or repairs a promote.
 */
export async function canResumeCompletedSwmPull(input: {
  store: TripleStore; graphManager: GraphManager; contextGraphId: string;
  name: string; agentAddress: string; subGraphName?: string;
  promote: AssertionPromoteAssessment; archivedSeal: AssertionSeal; archivedQuads: readonly Quad[];
  activeSubjects: readonly string[]; normalizedPublicQuads: readonly Quad[];
}): Promise<boolean> {
  const { store, graphManager, contextGraphId, subGraphName,
    archivedSeal: seal } = input;
  if (!seal.kaUal || !seal.assertionVersion) return false;
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const meta = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const terms = (predicate: string) => lifecycleTerms(input.promote, predicate);
  const literal = (predicate: string) => lifecycleLiteral(input.promote, predicate);
  if (literal('memoryLayer') !== MemoryLayer.SharedWorkingMemory
    || literal('swmShareComplete') !== 'true'
    || literal('reservedUal') !== scope.ual
    || literal('assertionVersion') !== scope.assertionVersion
    || literal('kaId') !== scope.kaNumber) return false;
  for (const pointer of ['wmCurrentAssertion', 'swmCurrentAssertion']) {
    if (terms(pointer).length && literal(pointer)?.replace(/^0x/i, '').toLowerCase() !== hex(seal.merkleRoot)) return false;
  }
  const operationId = literal('shareOperationId');
  const intent = literal('promoteOperationIntent');
  if ((terms('shareOperationId').length && !operationId)
    || (terms('promoteOperationIntent').length && (!intent || !operationId))) return false;

  // Resolve operation and head together using the existing singleton/equivalent-
  // alias decoder, so corrupt or superseded metadata cannot authorize recovery.
  const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager,
    contextGraphId, kaUal: scope.ual, subGraphName });
  if (!head || head.assertionVersion !== scope.assertionVersion
    || head.assertionGraph !== knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory, scope, subGraphName)
    || head.publicQuadsDigest !== workspacePublicQuadsDigest(input.normalizedPublicQuads)
    || head.publicTripleCount !== seal.publicTripleCount
    || head.privateTripleCount !== seal.privateTripleCount
    || head.privateMerkleRoot?.replace(/^0x/i, '').toLowerCase() !== (seal.privateMerkleRoot ? hex(seal.privateMerkleRoot) : undefined)
    || (operationId && !head.operationAliases.some(alias => alias.shareOperationId === operationId))) return false;
  if (intent && operationId) {
    try {
      const parsed = parsePromoteOperationIntent(intent, operationId);
      const alias = head.operationAliases.find(item => item.shareOperationId === operationId)!;
      if ((parsed.publisherPeerId ?? 'unknown') !== head.publisherPeerId
        || parsed.accessPolicy !== head.access.accessPolicy
        || JSON.stringify(parsed.allowedPeers) !== JSON.stringify([...head.access.allowedPeers].sort())
        || alias.publishedAt !== String(parsed.timestampMs)) return false;
    } catch { return false; }
  }
  // A partial clear can only remove rows. Residue from a different/newer active
  // seal must not be mistaken for the interrupted deletion of this archive.
  const archivedTerms = new Set(input.archivedQuads.filter(q => sealPredicates.has(q.predicate))
    .map(q => JSON.stringify([q.predicate, q.object])));
  for (const subject of input.activeSubjects) {
    const active = await store.query(`SELECT ?p ?o WHERE { GRAPH <${meta}> { <${assertSafeIri(subject)}> ?p ?o } }`);
    if (active.type !== 'bindings' || active.bindings.some(row =>
      sealPredicates.has(row['p'] ?? '') && !archivedTerms.has(JSON.stringify([row['p'], row['o']])))) return false;
  }
  return true;
}
