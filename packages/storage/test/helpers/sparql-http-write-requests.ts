import { SparqlHttpStore, type SparqlHttpConsistencyProfile } from '../../src/adapters/sparql-http.js';
import type { ReadGraphWriteOptions } from '../../src/read-graph/adapter-contract.js';
import { authorCommitInput } from '../rfc64-author-commit-cas-harness.js';
import { ASSET, G, META, P, q, recordWrite, S, type RecordedRequest } from './write-request-recording.js';

/** Records the HTTP requests SparqlHttpStore sends for each write method (see `write-request-recording.ts`). */
export function newSparqlHttpTestStore(consistencyProfile: SparqlHttpConsistencyProfile = 'atomic-readback'): SparqlHttpStore {
  return new SparqlHttpStore({
    queryEndpoint: 'http://oxigraph.invalid/query',
    updateEndpoint: 'http://oxigraph.invalid/update',
    consistencyProfile,
  });
}

/** One write call, and the index of the request in which it changes data. */
export interface SparqlHttpWriteCase {
  readonly name: string;
  readonly dataRequest: number;
  readonly run: (store: SparqlHttpStore, options?: ReadGraphWriteOptions) => Promise<unknown>;
}

export const SPARQL_HTTP_WRITE_CASES: readonly SparqlHttpWriteCase[] = [
  { name: 'insert', dataRequest: 0,
    run: (store, options) => store.insert([q(S, '"one"'), q(S, '"two"')], options) },
  { name: 'delete', dataRequest: 0,
    run: (store, options) => store.delete([q(S, '"one"')], options) },
  { name: 'delete with a blank node', dataRequest: 0,
    run: (store, options) => store.delete([q('_:b1', '"one"')], options) },
  { name: 'deleteByPattern', dataRequest: 1,
    run: (store, options) => store.deleteByPattern({ graph: G, subject: S }, options) },
  { name: 'deleteByPatternWithoutCount', dataRequest: 0,
    run: (store, options) => store.deleteByPatternWithoutCount({ graph: G, predicate: P }, options) },
  { name: 'deleteBySubjectPrefix', dataRequest: 1,
    run: (store, options) => store.deleteBySubjectPrefix(G, 'urn:test:write-requests:s', options) },
  { name: 'dropGraph', dataRequest: 0,
    run: (store, options) => store.dropGraph(G, options) },
  { name: 'update', dataRequest: 0,
    run: (store, options) => store.update(
      `DELETE WHERE { GRAPH <${G}> { <${S}> ?p ?o } }`, { ...options, touchedGraphs: [G] }) },
  { name: 'replaceGraph', dataRequest: 0,
    run: (store, options) => store.replaceGraph(G, [q(S, '"one"'), q(S, '"two"')], options) },
  { name: 'replaceGraph with no quads', dataRequest: 0,
    run: (store, options) => store.replaceGraph(G, [], options) },
  { name: 'replaceAssetGroup', dataRequest: 0,
    run: (store, options) => store.replaceAssetGroup([ASSET], options) },
  { name: 'replaceGraphAndSubject', dataRequest: 0,
    run: (store, options) => store.replaceGraphAndSubject(
      G, ASSET.graphQuads, META, ASSET.metadataSubject, ASSET.metadataQuads, options) },
  { name: 'replaceSubject', dataRequest: 0,
    run: (store, options) => store.replaceSubject(G, S, [q(S, '"one"')], options) },
  { name: 'replaceSubjectAndInsert', dataRequest: 0,
    run: (store, options) => store.replaceSubjectAndInsert(
      G, S, [q(S, '"one"')], [q('urn:test:write-requests:s3', '"three"')], options) },
  { name: 'rfc64AuthorCommitCasV1', dataRequest: 0,
    run: (store, options) => store.rfc64AuthorCommitCasV1(authorCommitInput(), options) },
];

/** oxigraph-server's answer to a request that succeeds. */
function oxigraphServerAnswer(request: RecordedRequest): Response {
  if (!request.contentType.startsWith('application/sparql-query')) return new Response(null, { status: 204 });
  if (request.body.startsWith('ASK')) return Response.json({ head: {}, boolean: true });
  return Response.json({ head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: '0' } }] } });
}

/** Run one write against a recording fetch and return its normalized requests. */
export function recordSparqlHttpWrite(
  run: (store: SparqlHttpStore) => Promise<unknown>,
  options: { fail?: (request: RecordedRequest) => boolean; profile?: SparqlHttpConsistencyProfile } = {},
): Promise<{ requests: string[]; error?: unknown }> {
  return recordWrite(() => newSparqlHttpTestStore(options.profile), run, oxigraphServerAnswer, options.fail);
}
