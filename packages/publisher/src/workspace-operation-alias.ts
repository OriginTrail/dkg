// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { assertSafeIri, canonicalizeObjectTermForHash, sparqlString, type TimestampMsV1 } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';
import type { NormalizedWorkspaceOperationProvenance } from './workspace-operation-equivalence.js';
import type { KnowledgeAssetWorkspaceOperationAlias, KnowledgeAssetWorkspaceSnapshotLocator } from './workspace-resolution.js';

export function workspaceOperationAlias(candidate: {
  provenance: NormalizedWorkspaceOperationProvenance;
  snapshotLocator: KnowledgeAssetWorkspaceSnapshotLocator;
}): KnowledgeAssetWorkspaceOperationAlias {
  return Object.freeze({
    shareOperationId: candidate.provenance.shareOperationId,
    ...(candidate.provenance.publishedAtMs === undefined ? {} : { publishedAt: candidate.provenance.publishedAtMs.toString() as TimestampMsV1 }),
    publisherChronologyAuthenticated: candidate.provenance.publisherChronologyAuthenticated,
    snapshotLocator: candidate.snapshotLocator,
  });
}

const LOCAL_EVIDENCE_GRAPH = 'urn:dkg:publisher:authenticated-operation-evidence';
const EVIDENCE_DIGEST = 'urn:dkg:publisher:authenticatedOperationDigest';

function evidenceDigest(rows: readonly Quad[]): string {
  const term = (row: Quad) => {
    const canonical = canonicalizeObjectTermForHash(row.object);
    if (row.predicate === 'http://dkg.io/ontology/publishedAt') {
      // Evidence has always folded valid timestamps to UTC, without the RDF suffix.
      const date = parseRdfLiteralTerm(canonical, { combineSurrogatePairs: true })?.value;
      if (date && Number.isFinite(Date.parse(date))) return new Date(date).toISOString();
    }
    return canonical;
  };
  const values = [...new Set(rows.map(row => JSON.stringify([row.subject, row.predicate, term(row)])))].sort();
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Only local publisher/verified-live writers may create this positive evidence. */
export async function persistWorkspaceOperationEvidence(store: TripleStore, rows: readonly Quad[]): Promise<void> {
  const subject = rows[0]?.subject;
  if (!subject || rows.some(row => row.subject !== subject)) throw new Error('Invalid immutable operation evidence');
  await replaceSubjectAtomicallyOrFallback(store, LOCAL_EVIDENCE_GRAPH, subject,
    [{ subject, predicate: EVIDENCE_DIGEST, object: sparqlString(evidenceDigest(rows)), graph: LOCAL_EVIDENCE_GRAPH }],
    'publisher.workspace.authenticatedOperationEvidence');
}

/** Reserved local graph evidence cannot arrive through provider metadata unions. */
export async function readAuthenticatedWorkspaceOperations(store: TripleStore, rows: readonly Quad[]): Promise<ReadonlySet<string>> {
  const subjects = [...new Set(rows.map(row => row.subject))];
  if (subjects.length === 0) return new Set();
  const evidence = await store.query(`SELECT ?s ?digest WHERE { GRAPH <${LOCAL_EVIDENCE_GRAPH}> {
    VALUES ?s { ${subjects.map(subject => `<${assertSafeIri(subject)}>`).join(' ')} } ?s <${EVIDENCE_DIGEST}> ?digest
  } }`, { priority: 'background', source: 'publisher.workspace.authenticatedOperationEvidence' });
  if (evidence.type !== 'bindings') throw new Error('Authenticated operation evidence is unavailable');
  const authenticated = new Set<string>();
  for (const subject of subjects) {
    const operation = rows.filter(row => row.subject === subject);
    const digests = evidence.bindings.filter(row => row['s'] === subject).map(row => row['digest']);
    const digest = digests.length === 1 ? parseRdfLiteralTerm(digests[0] ?? '') : null;
    if (digest && digest.kind !== 'language' && digest.value === evidenceDigest(operation)) authenticated.add(subject);
  }
  return authenticated;
}
