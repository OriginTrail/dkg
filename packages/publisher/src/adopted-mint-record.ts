// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, contextGraphMetaUri, formatSparqlTerm } from '@origintrail-official/dkg-core';
import { tryUpdateWithTouchedGraphs, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { GRAPH_KNOWLEDGE_ASSET_LOCAL_CONTROL_PREDICATES } from './graph-knowledge-asset-controls.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { readGraphKnowledgeAssetMetadataEnvelope } from './graph-metadata-store.js';
import { GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES, type ConfirmedGraphKnowledgeAssetMetadataEnvelope } from './graph-metadata-envelope.js';
import { MintAdoptionRefusedError } from './adopt-existing-mint.js';

/**
 * Classify exact local content before recording a live or adopted mint. The run that minted it
 * may have recorded it before failing, or the node's chain reconcile may have
 * materialized it. Either record must describe exactly the sealed content and
 * this transaction; confirmed rows are retained, while matching tentative rows
 * are replaced atomically. Anything else refuses before the publish writes.
 */
export async function classifyMintRecord(
  store: TripleStore,
  expected: { contextGraphId: string; ual: string } & Omit<ConfirmedGraphKnowledgeAssetMetadataEnvelope, 'transactionHash' | 'subGraphName' | 'batchId'>,
  mint: OnChainPublishResult,
): Promise<'absent' | 'tentative' | 'confirmed'> {
  const existing = await readGraphKnowledgeAssetMetadataEnvelope(store, expected);
  if (existing.state === 'absent') return 'absent';
  const recorded = existing.state === 'confirmed' || existing.state === 'tentative' ? existing.envelope : undefined;
  const hex = (bytes?: Uint8Array) => (bytes ? ethers.hexlify(bytes) : undefined);
  if (
    recorded
    && recorded.assertionVersion === expected.assertionVersion
    && recorded.assertionGraph === expected.assertionGraph
    && recorded.publicTripleCount === expected.publicTripleCount
    && recorded.privateTripleCount === expected.privateTripleCount
    && hex(recorded.privateMerkleRoot) === hex(expected.privateMerkleRoot)
    && hex(recorded.merkleRoot) === hex(expected.merkleRoot)
    && (existing.state === 'tentative'
      ? recorded.batchId === undefined && recorded.transactionHash === undefined
      : recorded.batchId === (mint.kaId ?? mint.batchId)
        && (recorded.transactionHash === undefined || recorded.transactionHash.toLowerCase() === mint.txHash.toLowerCase()))
  ) {
    return existing.state === 'tentative' ? 'tentative' : 'confirmed';
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

/** A matching tentative envelope becomes confirmed in one backend operation.
 * The materialization lock is held by the caller across classification and writes.
 * Preserve unrelated metadata while replacing the complete publication envelope.
 */
export async function writeMintMetadata(store: TripleStore, contextGraphId: string, ual: string,
  rows: readonly Quad[], disposition: 'absent' | 'tentative'): Promise<void> {
  if (disposition === 'absent') { await store.insert([...rows]); return; }
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId)), subject = assertSafeIri(ual);
  if (rows.some(row => row.graph !== graph || row.subject !== subject)) throw new Error('Mint metadata replacement requires one exact subject and graph');
  const predicates = new Set([...GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES,
    ...GRAPH_KNOWLEDGE_ASSET_LOCAL_CONTROL_PREDICATES, ...rows.map(row => row.predicate)]);
  const terms = [...predicates].map(predicate => `<${assertSafeIri(predicate)}>`).join(' ');
  const triples = rows.map(row => `<${subject}> <${assertSafeIri(row.predicate)}> ${formatSparqlTerm(row.object, { position: 'object' })} .`).join(' ');
  if (!await tryUpdateWithTouchedGraphs(store,
    `DELETE { GRAPH <${graph}> { <${subject}> ?p ?o } } INSERT { GRAPH <${graph}> { ${triples} } }
     WHERE { VALUES ?p { ${terms} } OPTIONAL { GRAPH <${graph}> { <${subject}> ?p ?o } } }`,
    [graph], { source: 'publisher.tentativeMint.confirm' })) throw new Error('Confirming a tentative mint requires atomic metadata replacement');
}
