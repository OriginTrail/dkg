import { createHash } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { EntitySearchError, checkDeadline, type EntityDocument, type EntityIndexSpec } from './types.js';

export const PAGE_SIZE = 8;
export const MAX_DOCUMENT_ROWS = 256;
export function iri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z][a-z0-9+.-]*:/i.test(value)
      || /[<>"{}|^`\\\s]/u.test(value) || [...value].some(char => char.charCodeAt(0) < 32)) throw new EntitySearchError('ENTITY_INVALID_REQUEST', 400);
  return `<${value}>`;
}
export function parseSpec(raw: EntityIndexSpec): EntityIndexSpec {
  if (!raw || typeof raw.contextGraphId !== 'string' || !raw.contextGraphId || raw.contextGraphId.length > 256
      || !['verifiable-memory', 'shared-working-memory'].includes(raw.view)) throw new EntitySearchError('ENTITY_INVALID_REQUEST', 400);
  function terms(values: unknown, required: boolean): string[] {
    if (!Array.isArray(values) || values.length > 16 || (required && !values.length)) throw new EntitySearchError('ENTITY_INVALID_REQUEST', 400);
    values.forEach(iri);
    return [...new Set(values as string[])].sort();
  }
  return { contextGraphId: raw.contextGraphId, view: raw.view,
    textPredicates: terms(raw.textPredicates, true), types: terms(raw.types ?? [], false) };
}
export function indexKey(spec: EntityIndexSpec, fingerprint: string): string {
  return createHash('sha256').update(JSON.stringify([spec, fingerprint])).digest('hex');
}
export function documentKey(doc: Pick<EntityDocument, 'entityUri' | 'sourceGraph'>): string {
  return JSON.stringify([doc.sourceGraph, doc.entityUri]);
}
function selection(spec: EntityIndexSpec): string {
  return `VALUES ?p { ${spec.textPredicates.map(iri).join(' ')} }
    GRAPH ?sourceGraph { ?entity ?p ?value . FILTER(isIRI(?entity) && isLiteral(?value))
    ${spec.types.length ? `?entity a ?type . VALUES ?type { ${spec.types.map(iri).join(' ')} }` : ''} }`;
}
export class EntityGraphReader {
  constructor(private agent: { query: OmitThisParameter<DKGAgent['query']> }, readonly callerAgentAddress?: string, private priority: 'normal' | 'background' = 'normal') {}
  async query(spec: EntityIndexSpec, sparql: string, signal: AbortSignal, deadline: number) {
    checkDeadline(signal, deadline);
    const result = await this.agent.query(sparql, { contextGraphId: spec.contextGraphId, view: spec.view,
      includeContextGraphPartitions: true, callerAgentAddress: this.callerAgentAddress,
      accessDenied: 'error', redactQuery: true, signal, source: 'api.entities', priority: this.priority, maxResponseBytes: 256 * 1024 });
    checkDeadline(signal, deadline);
    return result.bindings;
  }
  async authorize(spec: EntityIndexSpec, signal: AbortSignal, deadline: number): Promise<void> {
    // Always traverse the normal graph/view guard, including empty and stale indexes.
    await this.query(spec, 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 0', signal, deadline);
  }
  async page(spec: EntityIndexSpec, after: string | null, signal: AbortSignal, deadline: number) {
    let cursor = '';
    if (after) {
      const [graph, entity] = JSON.parse(after) as string[];
      cursor = `FILTER(STR(?sourceGraph) > ${JSON.stringify(graph)} ||
        (STR(?sourceGraph) = ${JSON.stringify(graph)} && STR(?entity) > ${JSON.stringify(entity)}))`;
    }
    const rows = await this.query(spec, `SELECT DISTINCT ?sourceGraph ?entity WHERE {
      ${selection(spec)} ${cursor} } ORDER BY STR(?sourceGraph) STR(?entity) LIMIT ${PAGE_SIZE}`, signal, deadline);
    return rows.map(row => ({ sourceGraph: row.sourceGraph, entityUri: row.entity }));
  }
  async document(spec: EntityIndexSpec, entity: Pick<EntityDocument, 'sourceGraph' | 'entityUri'>,
    signal: AbortSignal, deadline: number): Promise<EntityDocument | null> {
    const rows = await this.query(spec, `SELECT DISTINCT ?p ?value WHERE {
      VALUES (?sourceGraph ?entity) { (${iri(entity.sourceGraph)} ${iri(entity.entityUri)}) }
      ${selection(spec)} } ORDER BY ?p ?value LIMIT ${MAX_DOCUMENT_ROWS + 1}`, signal, deadline);
    if (!rows.length) return null;
    if (rows.length > MAX_DOCUMENT_ROWS) throw new EntitySearchError('ENTITY_DOCUMENT_TOO_LARGE', 422);
    // Preserve predicate names in the embedding input; do not flatten unrelated entities.
    const text = rows.map(row => `${row.p}: ${row.value}`).join('\n');
    if (Buffer.byteLength(text) > 16_384) throw new EntitySearchError('ENTITY_DOCUMENT_TOO_LARGE', 422);
    return { ...entity, text, contentHash: createHash('sha256').update(text).digest('hex') };
  }
}
