import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import type { ReadGraphWriteOptions } from '../../src/read-graph/adapter-contract.js';
import { authorCommitInput } from '../rfc64-author-commit-cas-harness.js';
import { ASSET, G, META, P, q, recordWrite, S, type RecordedRequest } from './write-request-recording.js';

/** Records the HTTP requests BlazegraphStore sends for each write method (see `write-request-recording.ts`). */
export const BLAZEGRAPH_TEST_ENDPOINT = 'http://blazegraph.invalid/bigdata/namespace/kb/sparql';

/** One write call, and the index of the request in which it changes data. */
export interface BlazegraphWriteCase {
  readonly name: string;
  readonly dataRequest: number;
  readonly run: (store: BlazegraphStore, options?: ReadGraphWriteOptions) => Promise<unknown>;
}

export const BLAZEGRAPH_WRITE_CASES: readonly BlazegraphWriteCase[] = [
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
  { name: 'replaceAssetGroup', dataRequest: 1,
    run: (store, options) => store.replaceAssetGroup([ASSET], options) },
  { name: 'replaceAssetGroup in one direct update', dataRequest: 0,
    // Two literals Blazegraph may store as one term select the direct update.
    run: (store, options) => store.replaceAssetGroup([{
      ...ASSET, graphQuads: [q(S, '"one"@en'), q(S, '"one"@EN')],
    }], options) },
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

/** Blazegraph's answer to a request that succeeds. */
function blazegraphAnswer(request: RecordedRequest): Response {
  if (!request.contentType.startsWith('application/sparql-query')) return new Response('', { status: 200 });
  if (request.body.startsWith('ASK')) return Response.json({ head: {}, boolean: true });
  return Response.json({ head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: '0' } }] } });
}

/** Run one write against a recording fetch and return its normalized requests. */
export function recordBlazegraphWrite(
  run: (store: BlazegraphStore) => Promise<unknown>,
  fail?: (request: RecordedRequest) => boolean,
): Promise<{ requests: string[]; error?: unknown }> {
  return recordWrite(() => new BlazegraphStore(BLAZEGRAPH_TEST_ENDPOINT), run, blazegraphAnswer, fail);
}
