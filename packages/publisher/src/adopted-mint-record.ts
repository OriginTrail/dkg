// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphMetaUri, formatSparqlTerm } from '@origintrail-official/dkg-core';
import { tryUpdateWithTouchedGraphs, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { GRAPH_KNOWLEDGE_ASSET_LOCAL_CONTROL_PREDICATES } from './graph-knowledge-asset-controls.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope, type ConfirmedGraphKnowledgeAssetMetadataEnvelope } from './metadata.js';
import { MintAdoptionRefusedError } from './adopt-existing-mint.js';

/**
 * Whether an adopted mint is already recorded locally. The run that minted it
 * may have recorded it before failing, or the node's chain reconcile may have
 * materialized it. Either record must describe exactly the sealed content and
 * this transaction; then the publish keeps it instead of adding a second set
 * of rows. Anything else refuses before the publish writes.
 */
export async function adoptedMintAlreadyRecorded(
  store: TripleStore,
  expected: { contextGraphId: string; ual: string } & Omit<ConfirmedGraphKnowledgeAssetMetadataEnvelope, 'transactionHash' | 'subGraphName' | 'batchId'>,
  mint: OnChainPublishResult,
): Promise<boolean> {
  const existing = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, expected);
  if (existing.state === 'absent') return false;
  const recorded = existing.state === 'confirmed' ? existing.envelope : undefined;
  const hex = (bytes?: Uint8Array) => (bytes ? ethers.hexlify(bytes) : undefined);
  if (
    recorded
    && recorded.assertionVersion === expected.assertionVersion
    && recorded.assertionGraph === expected.assertionGraph
    && recorded.publicTripleCount === expected.publicTripleCount
    && recorded.privateTripleCount === expected.privateTripleCount
    && hex(recorded.privateMerkleRoot) === hex(expected.privateMerkleRoot)
    && hex(recorded.merkleRoot) === hex(expected.merkleRoot)
    && recorded.batchId === (mint.kaId ?? mint.batchId)
    && (recorded.transactionHash === undefined || recorded.transactionHash.toLowerCase() === mint.txHash.toLowerCase())
  ) {
    return true;
  }
  throw new MintAdoptionRefusedError('existing-record-conflict', mint.kaId ?? mint.batchId,
    `the local record of ${expected.ual} is ${existing.state === 'invalid' ? 'unreadable' : 'for other content or another transaction'}`);
}

/** Preserve transaction provenance while replacing access controls from the retained share.
 * This must finish before private slices are persisted. One backend operation
 * replaces all three predicates, so readers never observe a permissive half-policy.
 */
export async function replaceRecordedMintAccess(store: TripleStore, contextGraphId: string, ual: string,
  trustedMetadata: readonly Quad[]): Promise<void> {
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const subject = assertSafeIri(ual);
  const predicates = GRAPH_KNOWLEDGE_ASSET_LOCAL_CONTROL_PREDICATES;
  const rows = trustedMetadata.filter(row => row.graph === graph && row.subject === subject && predicates.includes(row.predicate));
  if (!['http://dkg.io/ontology/accessPolicy', 'http://dkg.io/ontology/publisherPeerId']
    .every(predicate => rows.some(row => row.predicate === predicate)))
    throw new Error('Recorded mint access replacement requires the complete trusted control envelope');
  const terms = predicates.map(predicate => `<${predicate}>`).join(' ');
  const existing = await store.query(`SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } VALUES ?p { ${terms} } }`);
  if (existing.type !== 'bindings') throw new Error('Cannot read the recorded mint access policy');
  const key = (predicate: string, object: string) => `${predicate}\u0000${object}`;
  const desired = new Set(rows.map(row => key(row.predicate, row.object)));
  if (existing.bindings.length === desired.size && existing.bindings.every(row => desired.has(key(row.p!, row.o!)))) return;
  const triples = rows.map(row => `<${subject}> <${row.predicate}> ${formatSparqlTerm(row.object, { position: 'object' })} .`).join(' ');
  const updated = await tryUpdateWithTouchedGraphs(store,
    `DELETE { GRAPH <${graph}> { <${subject}> ?p ?o } } INSERT { GRAPH <${graph}> { ${triples} } }
     WHERE { VALUES ?p { ${terms} } OPTIONAL { GRAPH <${graph}> { <${subject}> ?p ?o } } }`,
    [graph], { source: 'publisher.recordedMint.access' });
  if (!updated) throw new Error('Recording this mint requires atomic replacement of its access policy');
}
