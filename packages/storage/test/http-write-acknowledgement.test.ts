import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { BlazegraphStore, SparqlHttpStore } from '../src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function openEndpoint(backend: 'blazegraph' | 'sparql-http', timeout = 5_000) {
  let response!: ServerResponse, arrived!: () => void;
  const headers = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer((req, res) => {
    req.resume(); response = res;
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.flushHeaders();
    res.write('update progress '.repeat(8_192)); arrived();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test endpoint');
  const url = `http://127.0.0.1:${address.port}/sparql`;
  const store = backend === 'blazegraph' ? new BlazegraphStore(url, { timeout })
    : new SparqlHttpStore({ queryEndpoint: url, timeout, writesDurableOnAcknowledgement: true });
  cleanups.push(async () => { await store.close(); response?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { store, headers, finish: () => response.end('committed'), fail: () => response.destroy(new Error('body transport failed')) };
}
const writes = {
  update: (store: BlazegraphStore | SparqlHttpStore, signal?: AbortSignal) => store.update('INSERT DATA { GRAPH <urn:ack> { <urn:s> <urn:p> "v" } }', { signal }),
  insert: (store: BlazegraphStore | SparqlHttpStore, signal?: AbortSignal) => store.insert([{ graph: 'urn:ack', subject: 'urn:s', predicate: 'urn:p', object: '"v"' }], { signal }),
};

describe.each(['blazegraph', 'sparql-http'] as const)('%s mutation acknowledgement', backend => {
const endpoint = (timeout?: number) => openEndpoint(backend, timeout);
it.each(['update', 'insert'] as const)('waits for the complete %s response before acknowledging/certifying the write', async operation => {
  const f = await endpoint(), barrier = f.store.commitment!.capture();
  let certified = false;
  const work = writes[operation](f.store).then(() => barrier()).then(() => { certified = true; });
  await f.headers;
  try {
    await new Promise(resolve => setTimeout(resolve, 30)); expect(certified).toBe(false);
  } finally { f.finish(); await work; }
  expect(certified).toBe(true);
});
it.each(['update', 'insert'] as const)('rejects %s when a successful response body fails', async operation => {
  const f = await endpoint(), barrier = f.store.commitment!.capture();
  let certified = false;
  const work = writes[operation](f.store).then(() => barrier()).then(() => { certified = true; });
  const result = work.then(() => ({ ok: true }), error => ({ ok: false, error }));
  await f.headers; await new Promise(resolve => setTimeout(resolve, 30)); f.fail();
  expect(await result).toMatchObject({ ok: false, error: expect.any(Error) }); expect(certified).toBe(false);
});
it('keeps the original mutation deadline through the response body', async () => {
  const f = await endpoint(500);
  const work = f.store.update('INSERT DATA {}');
  const result = work.catch(error => error);
  await f.headers;
  expect(await result).toMatchObject({ code: 'STORE_OPERATION_TIMEOUT', backend, outcome: 'indeterminate' });
});
it('propagates caller cancellation while the body is unfinished', async () => {
  const f = await endpoint(), controller = new AbortController(), reason = new Error('caller cancelled body');
  const result = writes.insert(f.store, controller.signal).catch(error => error);
  await f.headers; await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(reason);
  expect(await result).toBe(reason);
});

});
