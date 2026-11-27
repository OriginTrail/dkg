// SPDX-License-Identifier: Apache-2.0
import { formatSparqlTerm } from '@origintrail-official/dkg-core';
import type { Quad } from './triple-store.js';
import { ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES } from './atomic-asset-limits.js';

interface AtomicAssetUpdate {
  graphUri: string;
  graphQuads: readonly Quad[];
  metaGraphUri: string;
  metadataSubject: string;
  metadataQuads: readonly Quad[];
}

/** Internal rendering after the caller's payload validation; no adapter reporting. */
export function renderBoundedAtomicAssetUpdate(assets: readonly AtomicAssetUpdate[]) {
  const operations = assets.flatMap(a => [
    `CLEAR SILENT GRAPH <${a.graphUri}>`,
    `DELETE WHERE { GRAPH <${a.metaGraphUri}> { <${a.metadataSubject}> ?p ?o } }`,
  ]);
  const blocks = assets.flatMap(a => [
    ...(a.graphQuads.length ? [formatGraphBlock(a.graphUri, a.graphQuads)] : []),
    ...(a.metadataQuads.length ? [formatGraphBlock(a.metaGraphUri, a.metadataQuads)] : []),
  ]);
  if (blocks.length) operations.push(`INSERT DATA {\n${blocks.join('\n')}\n}`);
  const update = operations.join(';\n');
  if (Buffer.byteLength(update) > ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES) return null;
  return { update, graphs: [...new Set(assets.flatMap(a => [a.graphUri, a.metaGraphUri]))] };
}

/** graphUri is a validated bare IRI; every RDF term is still safely formatted. */
export function formatGraphBlock(graphUri: string, quads: readonly Quad[]): string {
  const triples = quads.map(quad => `    ${formatSparqlTerm(quad.subject, { position: 'subject' })} `
    + `${formatSparqlTerm(quad.predicate, { position: 'predicate' })} `
    + `${formatSparqlTerm(quad.object, { position: 'object' })} .`).join('\n');
  return `  GRAPH <${graphUri}> {\n${triples}\n  }`;
}
