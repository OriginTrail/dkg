// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { canonicalizeObjectTermForHash, formatSparqlTerm } from '@origintrail-official/dkg-core';
import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../atomic-graph-replace.js';
import { type AtomicAssetReplacement, ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES, validateAtomicAssetGroup } from '../atomic-asset-group.js';
import { quadToBlazegraphNQuad } from './blazegraph-nquads.js';

/** Native upload into hidden graphs followed by ONE guarded group publication and receipt. */
export function buildBulkAssetGroupPlan(assets: readonly AtomicAssetReplacement[]) {
  validateAtomicAssetGroup(assets);
  if (assets.every(a => !a.graphQuads.length && !a.metadataQuads.length)) return null;
  const stages: string[] = [], lines: string[] = [], guards: string[] = [], branches: string[] = [];
  let bytes = 0;
  for (const asset of assets) {
    for (const [part, quads] of [asset.graphQuads, asset.metadataQuads].entries()) {
      const stage = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;
      const target = part === 0 ? asset.graphUri : asset.metaGraphUri;
      const triples = new Set<string>(), values = new Set<string>();
      for (const quad of quads) {
        const s = formatSparqlTerm(quad.subject, { position: 'subject' });
        const p = formatSparqlTerm(quad.predicate, { position: 'predicate' });
        const o = formatSparqlTerm(quad.object, { position: 'object' });
        triples.add(`${s} ${p} ${o}`);
        values.add(`${s} ${p} ${canonicalizeObjectTermForHash(o)}`);
        const line = `${quadToBlazegraphNQuad({ ...quad, graph: stage })}\n`;
        bytes += Buffer.byteLength(line);
        if (bytes > ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES) throw new RangeError('Atomic asset group byte allowance exceeded');
        lines.push(line);
      }
      // Backend value-space aliasing is ambiguous: choose SPARQL before uploading anything.
      if (triples.size !== values.size) return null;
      const variable = `n${stages.length}`;
      guards.push(`{ SELECT (COUNT(*) AS ?${variable}) WHERE { GRAPH <${stage}> { ?s ?p ?o } } } FILTER(?${variable} = ${triples.size})`);
      branches.push(`{ GRAPH <${stage}> { ?newS ?newP ?newO } BIND(<${target}> AS ?newGraph) }`);
      // Retained triples need no deletion. Keeping delete/insert sets disjoint
      // also makes replay safe on engines that stream UNION update bindings.
      branches.push(part === 0
        ? `{ GRAPH <${target}> { ?oldS ?oldP ?oldO } BIND(<${target}> AS ?oldGraph) FILTER NOT EXISTS { GRAPH <${stage}> { ?oldS ?oldP ?oldO } } }`
        : `{ GRAPH <${target}> { <${asset.metadataSubject}> ?oldP ?oldO } BIND(<${asset.metadataSubject}> AS ?oldS) BIND(<${target}> AS ?oldGraph) FILTER NOT EXISTS { GRAPH <${stage}> { ?oldS ?oldP ?oldO } } }`);
      stages.push(stage);
    }
  }
  const receipt = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;
  stages.push(receipt);
  branches.push(`{ BIND(<${receipt}> AS ?newGraph) BIND(<${receipt}> AS ?newS) BIND(<urn:dkg:bulk:committed> AS ?newP) BIND(true AS ?newO) }`);
  return {
    nquads: lines.join(''),
    update: `DELETE { GRAPH ?oldGraph { ?oldS ?oldP ?oldO } } INSERT { GRAPH ?newGraph { ?newS ?newP ?newO } }
WHERE { ${guards.join('\n')} { ${branches.join('\nUNION ')} } }`,
    receiptQuery: `ASK { GRAPH <${receipt}> { <${receipt}> <urn:dkg:bulk:committed> true } }`,
    cleanup: stages.map(s => `DROP SILENT GRAPH <${s}>`).join(';\n'),
  };
}
