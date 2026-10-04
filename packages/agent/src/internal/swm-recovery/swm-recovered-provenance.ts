// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { KnowledgeAssetWorkspaceHeadCorruptError, resolveAcquiredKnowledgeAssetWorkspaceHead, readAuthenticatedWorkspaceOperations, type KnowledgeAssetWorkspaceHeadResolution } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { decodeRecoveryOperationCandidate, isPublisherOperationCandidate, type RecoveryOperationCandidate, type GraphScopedSwmRecoveryDescriptor } from '../../sync/graph-scoped-swm-recovery.js';
import { stripMetadataLiteral } from '../../sync/metadata-literal.js';
import { canonicalQuadKey } from '../../sync/requester/quad-key.js';

const DKG = 'http://dkg.io/ontology/';
type AuthenticatedCandidate = RecoveryOperationCandidate & {
  readonly provenance: RecoveryOperationCandidate['provenance'] & { readonly publisherChronologyAuthenticated: true };
};
/** Authentication and ACK exclusion follow the publisher's shared chronology policy. */
export function isAuthenticatedPublisherCandidate(candidate: RecoveryOperationCandidate): candidate is AuthenticatedCandidate {
  return candidate.provenance.publisherChronologyAuthenticated === true
    && isPublisherOperationCandidate(candidate);
}
/** The prepared boundary separates decoded local evidence from provider claims. */
export interface PreparedSwmRecoveryDescriptor extends GraphScopedSwmRecoveryDescriptor {
  readonly preparation: 'local-evidence-acquired';
  readonly storedHead: KnowledgeAssetWorkspaceHeadResolution;
  readonly storedAliasIds: readonly string[];
  readonly operationCandidates: readonly RecoveryOperationCandidate[];
  /** Null retains fail-closed handling of an undecodable current alias class. */
  readonly storedOperationCandidates: readonly RecoveryOperationCandidate[] | null;
  readonly authenticatedPublisherOperation?: AuthenticatedCandidate;
}

/** Decode at acquisition, so ordering and retention consume facts, not RDF lookups. */
function decodeCandidate(rows: readonly Quad[], descriptor: GraphScopedSwmRecoveryDescriptor): RecoveryOperationCandidate {
  const value = (predicate: string) => stripMetadataLiteral(rows.find(row => row.predicate === `${DKG}${predicate}`)?.object ?? '');
  return decodeRecoveryOperationCandidate({ rows, contextGraphId: value('contextGraphId'),
    metaGraph: descriptor.metaGraph, operationSubject: rows[0]!.subject, shareOperationId: value('shareOperationId'),
    kaUal: descriptor.kaUal, assertionVersion: BigInt(value('assertionVersion')).toString(), subGraphName: descriptor.subGraphName });
}

/** Acquire one bounded provider/current alias class under the existing KA lock. */
export async function prepareRecoveredDescriptor(store: TripleStore, descriptor: GraphScopedSwmRecoveryDescriptor): Promise<PreparedSwmRecoveryDescriptor> {
  const subjects = [...new Set(descriptor.metadataQuads.filter(row => row.subject !== descriptor.headSubject).map(row => row.subject))];
  // sparql-scan-allow: R4 -- exact provider subjects and the exact KA head bind both branches; this never walks the CG bucket.
  const acquired = await store.query(`SELECT ?s ?p ?o ?headId WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> {
    { VALUES ?s { ${subjects.map(subject => `<${assertSafeIri(subject)}>`).join(' ')} } ?s ?p ?o }
    UNION { <${assertSafeIri(descriptor.headSubject)}> ?p ?o . BIND(<${assertSafeIri(descriptor.headSubject)}> AS ?s) }
    UNION { <${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?headId . ?s <${DKG}shareOperationId> ?headId ; ?p ?o }
  } }`, { priority: 'background', source: 'agent.swmRecovery.localPublisherEvidence' });
  if (acquired.type !== 'bindings') throw new Error('Publisher provenance acquisition is unavailable');
  const localBySubject = new Map<string, Map<string, Quad>>();
  const headRows: Quad[] = [];
  const ownedSubjects = new Set<string>();
  for (const row of acquired.bindings) {
    const subject = row['s']!;
    const quad = { subject, predicate: row['p']!, object: row['o']!, graph: descriptor.metaGraph };
    if (subject === descriptor.headSubject) { headRows.push(quad); continue; }
    const rows = localBySubject.get(subject) ?? new Map<string, Quad>();
    rows.set(canonicalQuadKey(quad), quad); localBySubject.set(subject, rows);
    if (row['headId'] !== undefined) ownedSubjects.add(subject);
  }
  const allLocal = [...localBySubject.values()].flatMap(rows => [...rows.values()]);
  const authenticated = await readAuthenticatedWorkspaceOperations(store, descriptor.metaGraph, allLocal);
  let storedHead: KnowledgeAssetWorkspaceHeadResolution;
  const contextGraphId = stripMetadataLiteral(descriptor.metadataQuads.find(row => row.subject === descriptor.operationSubject && row.predicate === `${DKG}contextGraphId`)?.object ?? '');
  try {
    const head = resolveAcquiredKnowledgeAssetWorkspaceHead({ contextGraphId, kaUal: descriptor.kaUal, subGraphName: descriptor.subGraphName }, [...headRows, ...allLocal], authenticated);
    storedHead = head ? { status: 'resolved', head } : { status: 'missing' };
  } catch (error) {
    if (!(error instanceof KnowledgeAssetWorkspaceHeadCorruptError)) throw error;
    storedHead = { status: 'corrupt', error };
  }
  const locals = new Map<string, RecoveryOperationCandidate>();
  for (const [subject, rows] of localBySubject) {
    try {
      const candidate = decodeCandidate([...rows.values()], descriptor);
      locals.set(subject, { ...candidate, provenance: { ...candidate.provenance,
        publisherChronologyAuthenticated: authenticated.has(subject) } });
    } catch { /* Incomplete local evidence cannot certify chronology or equivalence. */ }
  }
  const operationCandidates: RecoveryOperationCandidate[] = [];
  const metadataQuads = descriptor.metadataQuads.filter(row => row.subject === descriptor.headSubject);
  for (const subject of subjects) {
    const wire = descriptor.metadataQuads.filter(row => row.subject === subject);
    const incoming = decodeCandidate(wire, descriptor);
    const local = locals.get(subject);
    const locallyAuthenticated = local?.provenance.publisherChronologyAuthenticated === true
      && local.shareOperationId === incoming.shareOperationId;
    const sameOperation = local?.semantics.publisherIdentity === descriptor.publisherPeerId
      && local.identityKey !== null && local.identityKey === incoming.identityKey;
    if (locallyAuthenticated && !sameOperation) throw Object.assign(new Error('Recovered operation conflicts with authenticated local evidence'), { code: 'RECOVERED_OPERATION_EVIDENCE_CONFLICT' });
    if (locallyAuthenticated && sameOperation) {
      metadataQuads.push(...local.operationRows); operationCandidates.push(local);
    } else {
      metadataQuads.push(...wire); operationCandidates.push({ ...incoming,
        provenance: { ...incoming.provenance, publisherChronologyAuthenticated: false } });
    }
  }
  // Preserve descriptor order on ties, matching the prior publisher-clock policy.
  const authenticatedPublisherOperation = operationCandidates
    .filter(isAuthenticatedPublisherCandidate)
    .sort((a, b) => b.provenance.publishedAtMs - a.provenance.publishedAtMs)[0];
  const storedAliasIds = [...new Set(headRows.filter(row => row.predicate === `${DKG}shareOperationId`).map(row => stripMetadataLiteral(row.object).trim()))];
  const storedOperationCandidates = [...ownedSubjects].every(subject => locals.has(subject))
    ? [...ownedSubjects].map(subject => locals.get(subject)!) : null;
  return { ...descriptor, metadataQuads, preparation: 'local-evidence-acquired',
    operationCandidates, storedOperationCandidates, authenticatedPublisherOperation, storedHead, storedAliasIds };
}
