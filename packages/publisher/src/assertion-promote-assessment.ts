// SPDX-License-Identifier: Apache-2.0
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, assertSafeIri, assertionLifecycleUri,
  contextGraphAssertionUri, contextGraphMetaUri, parseAssertionSealQuads,
} from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { GraphManager, TripleStore } from '@origintrail-official/dkg-storage';
import { resolveKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { stripOptionalLiteral } from './sparql-binding-literal.js';

const DKG = 'http://dkg.io/ontology/';
export interface AssertionPromoteAssessment {
  readonly status: 'mutable' | 'completed' | 'recovery-required';
  readonly lifecycle: ReadonlyMap<string, readonly string[]>;
}

export function lifecycleTerms(assessment: AssertionPromoteAssessment, predicate: string): readonly string[] {
  return assessment.lifecycle.get(predicate) ?? [];
}
export function lifecycleLiteral(assessment: AssertionPromoteAssessment, predicate: string): string | undefined {
  const values = lifecycleTerms(assessment, predicate);
  return values.length === 1 ? parseRdfLiteralTerm(values[0]!)?.value : undefined;
}
export function assertionPromoteRecoveryRequired(name: string): Error & { code: string } {
  return Object.assign(new Error(
    `Assertion "${name}" has an unfinished promote; retry assertionPromote before mutating its draft`,
  ), { code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
}

/** Decode lifecycle once; ordinary mutation policy and pull proof consume the same assessment. */
export async function assessAssertionPromote(input: {
  store: TripleStore; graphManager: GraphManager; contextGraphId: string;
  name: string; agentAddress: string; subGraphName?: string;
  hasDurableTail: (operationId: string, kaUal: string, assertionVersion: string) => Promise<boolean>;
}): Promise<AssertionPromoteAssessment> {
  const { store, graphManager, contextGraphId, name, agentAddress, subGraphName } = input;
  const subject = assertSafeIri(assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName));
  const meta = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const rows = await store.query(`SELECT ?p ?o WHERE { GRAPH <${meta}> { <${subject}> ?p ?o } }`);
  const lifecycle = new Map<string, string[]>();
  if (rows.type !== 'bindings' || rows.bindings.some(row => typeof row.p !== 'string' || typeof row.o !== 'string')) {
    return { status: 'recovery-required', lifecycle };
  }
  for (const { p, o } of rows.bindings) {
    if (!p!.startsWith(DKG)) continue;
    const key = p!.slice(DKG.length);
    lifecycle.set(key, [...(lifecycle.get(key) ?? []), o!]);
  }
  const result = (status: AssertionPromoteAssessment['status']): AssertionPromoteAssessment => ({ status, lifecycle });
  const terms = (key: string) => lifecycle.get(key) ?? [];
  const layers = terms('memoryLayer');
  const layer = layers.length === 1 ? stripOptionalLiteral(layers[0]) : undefined;
  const ids = terms('shareOperationId');
  const hasIntent = terms('promoteOperationIntent').length > 0;
  if (layer === MemoryLayer.VerifiableMemory) return result('completed');
  if (!ids.length && !hasIntent && layer !== MemoryLayer.SharedWorkingMemory) return result('mutable');
  if (layer !== MemoryLayer.SharedWorkingMemory) return result('recovery-required');

  let operationId: string | undefined;
  try {
    const decoded: unknown = ids.length === 1 ? JSON.parse(ids[0]!) : undefined;
    if (typeof decoded === 'string' && decoded.length > 0) operationId = decoded;
  } catch { /* Malformed provisional pointers never authorize completion. */ }
  const sealSubject = assertSafeIri(contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName));
  const sealRows = await store.query(`CONSTRUCT { <${sealSubject}> ?p ?o } WHERE {
    GRAPH <${meta}> { <${sealSubject}> ?p ?o }
  }`);
  const seal = parseAssertionSealQuads(sealRows.type === 'quads' ? sealRows.quads : [], sealSubject);
  if (!operationId && !ids.length && !hasIntent && seal?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION && seal.kaUal) {
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId, kaUal: seal.kaUal, subGraphName });
    operationId = head?.shareOperationId;
  }
  // Preserve the ordinary mutation gate. Pull recovery adds stricter archive,
  // singleton lifecycle, current workspace-head and exact payload proof.
  if (operationId && seal?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
    && seal.kaUal && seal.assertionVersion && terms('swmShareComplete').length > 0
    && await input.hasDurableTail(operationId, seal.kaUal, seal.assertionVersion)) return result('completed');
  return result('recovery-required');
}
