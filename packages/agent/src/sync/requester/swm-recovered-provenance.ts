// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { isDecodableWorkspaceOperationRows } from '@origintrail-official/dkg-publisher';
import { RECOVERED_OPERATION_CHRONOLOGY, readAuthenticatedWorkspaceOperations } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { workspacePublisherOperationTimestamp } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { operationIdentityKey, type GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { stripMetadataLiteral } from '../metadata-literal.js';

const DKG = 'http://dkg.io/ontology/';
/**
 * A provider authenticates transport/content, not the publisher's RDF clock.
 * Only an immutable operation already established locally by a trusted writer
 * may contribute chronology. Never copy, clear, or reinterpret a peer's marker.
 */
export async function prepareRecoveredDescriptor(store: TripleStore, descriptor: GraphScopedSwmRecoveryDescriptor): Promise<GraphScopedSwmRecoveryDescriptor> {
  const subjects = [...new Set(descriptor.metadataQuads.filter(row => row.subject !== descriptor.headSubject).map(row => row.subject))];
  // sparql-scan-allow: R4 -- VALUES binds the exact operation subjects in one validated KA alias class; this never walks the CG bucket.
  const acquired = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> {
    VALUES ?s { ${subjects.map(subject => `<${assertSafeIri(subject)}>`).join(' ')} } ?s ?p ?o
  } }`, { priority: 'background', source: 'agent.swmRecovery.localPublisherEvidence' });
  if (acquired.type !== 'bindings') throw new Error('Publisher provenance acquisition is unavailable');
  const allLocal: Quad[] = acquired.bindings.map(row => ({ subject: row['s']!, predicate: row['p']!, object: row['o']!, graph: descriptor.metaGraph }));
  const authenticated = await readAuthenticatedWorkspaceOperations(store, allLocal);
  const clocks: { shareOperationId: string; publishedAt: number }[] = [];
  const metadataQuads = descriptor.metadataQuads.filter(row => row.subject === descriptor.headSubject);
  for (const subject of subjects) {
    const wire = descriptor.metadataQuads.filter(row => row.subject === subject && row.predicate !== RECOVERED_OPERATION_CHRONOLOGY);
    const local: Quad[] = acquired.bindings.filter(row => row['s'] === subject).map(row => ({ subject, predicate: row['p']!, object: row['o']!, graph: descriptor.metaGraph }));
    const value = (rows: readonly Quad[], predicate: string) => stripMetadataLiteral(rows.find(row => row.predicate === `${DKG}${predicate}`)?.object ?? '');
    const id = value(wire, 'shareOperationId');
    const locallyAuthenticated = authenticated.has(subject)
      && isDecodableWorkspaceOperationRows(local, { kaUal: descriptor.kaUal, assertionVersion: value(local, 'assertionVersion'), shareOperationId: id, requirePublishedAt: true });
    const sameOperation = value(local, 'publisherPeerId') === descriptor.publisherPeerId
      && operationIdentityKey(local) !== null && operationIdentityKey(local) === operationIdentityKey(wire);
    if (locallyAuthenticated && !sameOperation) throw Object.assign(new Error('Recovered operation conflicts with authenticated local evidence'), { code: 'RECOVERED_OPERATION_EVIDENCE_CONFLICT' });
    const trusted = locallyAuthenticated && sameOperation;
    if (trusted) {
      metadataQuads.push(...local);
      clocks.push({ shareOperationId: id, publishedAt: Date.parse(value(local, 'publishedAt')) });
    } else {
      metadataQuads.push(...wire, { subject, predicate: RECOVERED_OPERATION_CHRONOLOGY, object: '"true"', graph: descriptor.metaGraph });
    }
  }
  const timestamp = workspacePublisherOperationTimestamp(clocks);
  const publisherOperationId = clocks.find(clock => clock.publishedAt === timestamp)?.shareOperationId;
  return { ...descriptor, metadataQuads, publisherOperationTimestampMs: timestamp, publisherOperationId, locallyAuthenticatedPublisherOperationId: publisherOperationId };
}
