import { vi } from 'vitest';
import type { AtomicAssetReplacement } from '../../src/atomic-asset-group.js';
import type { Quad } from '../../src/triple-store.js';

/**
 * The shared parts of the request-recording tests of the HTTP adapters: the
 * quads their write cases use, a fetch stub that records every request, and
 * the normalization that makes two runs of the same write give the same list.
 *
 * Every request is reduced to its content type and body. Graph names and
 * variable suffixes that an adapter draws at random are replaced by numbered
 * placeholders, in order of first appearance.
 */
export const G = 'urn:test:write-requests:graph';
export const META = 'urn:test:write-requests:meta';
export const S = 'urn:test:write-requests:s1';
export const P = 'urn:test:write-requests:p';

export function q(subject: string, object: string, graph = G): Quad {
  return { subject, predicate: P, object, graph };
}

export const ASSET: AtomicAssetReplacement = {
  graphUri: G,
  graphQuads: [q(S, '"one"'), q('urn:test:write-requests:s2', '"two"')],
  metaGraphUri: META,
  metadataSubject: 'urn:test:write-requests:asset',
  metadataQuads: [q('urn:test:write-requests:asset', '"meta"', META)],
};

export interface RecordedRequest {
  readonly contentType: string;
  readonly body: string;
}

/** How the stub answers a request that is not made to fail. */
export type RequestAnswer = (request: RecordedRequest) => Response;

function recordingFetch(requests: RecordedRequest[], answer: RequestAnswer, fail?: (request: RecordedRequest) => boolean) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = {
      contentType: new Headers(init?.headers).get('content-type') ?? '',
      body: String(init?.body ?? ''),
    };
    requests.push(request);
    if (fail?.(request)) return new Response('injected failure', { status: 500 });
    return answer(request);
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SUFFIX = /\b(subject[PO])[0-9a-f]{32}\b/g;

/** Each request as its content type (or call name) and its body, with random names numbered in order of first appearance. */
export function normalizeRecordedRequests(requests: readonly RecordedRequest[]): string[] {
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

/** Run one write on a fresh store against a recording fetch, and return its normalized requests. */
export async function recordWrite<T extends { close(): Promise<void> }>(
  newStore: () => T,
  run: (store: T) => Promise<unknown>,
  answer: RequestAnswer,
  fail?: (request: RecordedRequest) => boolean,
): Promise<{ requests: string[]; error?: unknown }> {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(requests, answer, fail) as typeof fetch;
  const store = newStore();
  try {
    await run(store);
    return { requests: normalizeRecordedRequests(requests) };
  } catch (error) {
    return { requests: normalizeRecordedRequests(requests), error };
  } finally {
    globalThis.fetch = original;
    await store.close();
  }
}
