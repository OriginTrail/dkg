import { iri } from './requests.js';
import { createHash } from 'node:crypto';
import { sparqlString } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { isQueryResultTooLargeError, type DKGAgent } from '@origintrail-official/dkg-agent';
import { EntitySearchError, checkDeadline, type EntityDocument, type EntityIndexSpec, type EntityReadSpec, type EntityIdentity } from './types.js';

export const PAGE_SIZE = 8;
export const MAX_DOCUMENT_ROWS = 256;
function selection(spec: EntityIndexSpec, graphOperand: string): string {
  return `VALUES ?p { ${spec.textPredicates.map(iri).join(' ')} }
    GRAPH ${graphOperand} { ?entity ?p ?value . FILTER(isIRI(?entity) && isLiteral(?value))
    ${spec.types.length ? `FILTER EXISTS { ?entity a ?type . VALUES ?type { ${spec.types.map(iri).join(' ')} } }` : ''} }`;
}
export class EntityGraphReader {
  constructor(private agent: { query: OmitThisParameter<DKGAgent['query']> }, readonly callerAgentAddress?: string, private priority: 'normal' | 'background' = 'normal') {}
  async query(spec: EntityReadSpec, sparql: string, signal: AbortSignal, deadline: number, maxResponseBytes = 256 * 1024, maxLiteralHydrationBytes?: number) {
    checkDeadline(signal, deadline);
    const result = await this.agent.query(sparql, { contextGraphId: spec.contextGraphId, view: spec.view,
      includeContextGraphPartitions: true, callerAgentAddress: this.callerAgentAddress,
      accessDenied: 'error', redactQuery: true, chainEvidenceMode: spec.chainEvidenceMode, signal, source: 'api.entities', priority: this.priority, maxResponseBytes, maxLiteralHydrationBytes });
    checkDeadline(signal, deadline);
    return result.bindings;
  }
  async authorize(spec: EntityReadSpec, signal: AbortSignal, deadline: number): Promise<void> {
    // Always traverse the normal graph/view guard, including empty and stale indexes.
    await this.query(spec, 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 0', signal, deadline);
  }
  async page(spec: EntityReadSpec, after: EntityIdentity | null, signal: AbortSignal, deadline: number) {
    let cursor = '';
    if (after) {
      cursor = `FILTER(STR(?sourceGraph) > ${sparqlString(after.sourceGraph)} ||
        (STR(?sourceGraph) = ${sparqlString(after.sourceGraph)} && STR(?entity) > ${sparqlString(after.entityUri)}))`;
    }
    const rows = await this.query(spec, `SELECT DISTINCT ?sourceGraph ?entity WHERE {
      ${selection(spec, '?sourceGraph')} ${cursor} } ORDER BY STR(?sourceGraph) STR(?entity) LIMIT ${PAGE_SIZE}`, signal, deadline);
    return rows.map(row => ({ sourceGraph: row.sourceGraph, entityUri: row.entity }));
  }
  async document(spec: EntityReadSpec, entity: Pick<EntityDocument, 'sourceGraph' | 'entityUri'>,
    signal: AbortSignal, deadline: number): Promise<EntityDocument | null> {
    const selected = `VALUES (?sourceGraph ?entity) { (${iri(entity.sourceGraph)} ${iri(entity.entityUri)}) }
      ${selection(spec, '?sourceGraph')}`;
    // A bound variable intersects the fresh authorized graph set: a removed
    // partition produces no rows. Keep it outside nested SELECTs so the engine
    // can constrain it safely. Each unique RDF property yields one size witness;
    // the type EXISTS avoids multiplying witnesses by matching types.
    const sizes = await this.query(spec, `SELECT (STRLEN(STR(?p)) + STRLEN(STR(?value)) AS ?chars)
      WHERE { ${selected} } LIMIT ${MAX_DOCUMENT_ROWS + 1}`, signal, deadline);
    let chars = 0;
    for (const row of sizes) {
      const size = Number(parseRdfLiteralTerm(row.chars)?.value ?? row.chars);
      if (!Number.isSafeInteger(size) || size < 0) throw new EntitySearchError('ENTITY_SEARCH_UNAVAILABLE');
      chars += size;
    }
    if (sizes.length > MAX_DOCUMENT_ROWS || chars > 16384) throw new EntitySearchError('ENTITY_DOCUMENT_TOO_LARGE', 422);
    // Transport includes RDF term metadata and JSON escaping. Keep that bounded
    // independently of the unchanged text and disk-backed literal budgets.
    let rows;
    try {
      rows = await this.query(spec, `SELECT DISTINCT ?p ?value WHERE {
        ${selected} } ORDER BY ?p ?value LIMIT ${MAX_DOCUMENT_ROWS + 1}`, signal, deadline, 256 * 1024, 16_384);
    } catch (error) {
      if (isQueryResultTooLargeError(error))
        throw new EntitySearchError('ENTITY_DOCUMENT_TOO_LARGE', 422);
      throw error;
    }
    if (!rows.length) return null;
    if (rows.length > MAX_DOCUMENT_ROWS) throw new EntitySearchError('ENTITY_DOCUMENT_TOO_LARGE', 422);
    // Preserve predicate names in the embedding input; do not flatten unrelated entities.
    const text = rows.map(row => `${row.p}: ${row.value}`).join('\n');
    if (Buffer.byteLength(text) > 16_384) throw new EntitySearchError('ENTITY_DOCUMENT_TOO_LARGE', 422);
    return { ...entity, text, contentHash: createHash('sha256').update(text).digest('hex') };
  }
}
