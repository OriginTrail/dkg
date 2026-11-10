import { vi } from 'vitest';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import type { AtomicAssetReplacement } from '../../src/atomic-asset-group.js';
import type { Quad, UpdateOptions } from '../../src/triple-store.js';
import { authorCommitInput } from '../rfc64-author-commit-cas-harness.js';

/**
 * Records the HTTP requests BlazegraphStore sends for each write method.
 *
 * Every request is reduced to its content type and body. Graph names and
 * variable suffixes that the adapter draws at random are replaced by numbered
 * placeholders, in order of first appearance, so two runs of the same write
 * produce the same list.
 */
export const BLAZEGRAPH_TEST_ENDPOINT = 'http://blazegraph.invalid/bigdata/namespace/kb/sparql';

export const G = 'urn:test:write-requests:graph';
export const META = 'urn:test:write-requests:meta';
export const S = 'urn:test:write-requests:s1';
const P = 'urn:test:write-requests:p';

export function q(subject: string, object: string, graph = G): Quad {
  return { subject, predicate: P, object, graph };
}

const ASSET: AtomicAssetReplacement = {
  graphUri: G,
  graphQuads: [q(S, '"one"'), q('urn:test:write-requests:s2', '"two"')],
  metaGraphUri: META,
  metadataSubject: 'urn:test:write-requests:asset',
  metadataQuads: [q('urn:test:write-requests:asset', '"meta"', META)],
};

/** One write call, and the index of the request in which it changes data. */
export interface BlazegraphWriteCase {
  readonly name: string;
  readonly dataRequest: number;
  readonly run: (store: BlazegraphStore, options?: UpdateOptions) => Promise<unknown>;
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

interface RawRequest {
  readonly contentType: string;
  readonly body: string;
}

/** A fetch stub that records each request and answers it as Blazegraph would on success. */
function recordingFetch(requests: RawRequest[], fail?: (request: RawRequest) => boolean) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = {
      contentType: new Headers(init?.headers).get('content-type') ?? '',
      body: String(init?.body ?? ''),
    };
    requests.push(request);
    if (fail?.(request)) return new Response('injected failure', { status: 500 });
    if (!request.contentType.startsWith('application/sparql-query')) return new Response('', { status: 200 });
    if (request.body.startsWith('ASK')) return Response.json({ head: {}, boolean: true });
    return Response.json({ head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: '0' } }] } });
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SUFFIX = /\b(subject[PO])[0-9a-f]{32}\b/g;

function normalize(requests: readonly RawRequest[]): string[] {
  const names = new Map<string, string>();
  const placeholder = (value: string, kind: string): string => {
    const key = `${kind}:${value}`;
    if (!names.has(key)) names.set(key, `${kind}-${[...names.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}`);
    return names.get(key)!;
  };
  return requests.map(({ contentType, body }) => {
    const stable = body
      .replace(UUID, (value) => `{${placeholder(value, 'uuid')}}`)
      .replace(SUFFIX, (_value, name: string) => `${name}{suffix}`);
    return `${contentType.split(';')[0]}\n${stable}`;
  });
}

/** Run one write against a recording fetch and return its normalized requests. */
export async function recordBlazegraphWrite(
  run: (store: BlazegraphStore) => Promise<unknown>,
  fail?: (request: { contentType: string; body: string }) => boolean,
): Promise<{ requests: string[]; error?: unknown }> {
  const requests: RawRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(requests, fail) as typeof fetch;
  const store = new BlazegraphStore(BLAZEGRAPH_TEST_ENDPOINT);
  try {
    await run(store);
    return { requests: normalize(requests) };
  } catch (error) {
    return { requests: normalize(requests), error };
  } finally {
    globalThis.fetch = original;
    await store.close();
  }
}
