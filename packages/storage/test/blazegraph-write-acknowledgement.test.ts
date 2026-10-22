import { afterEach, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { BlazegraphStore } from '../src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function endpoint(timeout = 5_000) {
  let response!: ServerResponse, arrived!: () => void;
  const headers = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer((req, res) => {
    req.resume(); response = res;
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.flushHeaders();
    res.write('update progress '.repeat(8_192)); arrived();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test endpoint');
  cleanups.push(async () => { response?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const store = new BlazegraphStore(`http://127.0.0.1:${address.port}/sparql`, { timeout });
  return { store, headers, finish: () => response.end('committed'), fail: () => response.destroy(new Error('body transport failed')) };
}
const writes = {
  update: (store: BlazegraphStore, signal?: AbortSignal) => store.update('INSERT DATA { GRAPH <urn:ack> { <urn:s> <urn:p> "v" } }', { signal }),
  insert: (store: BlazegraphStore, signal?: AbortSignal) => store.insert([{ graph: 'urn:ack', subject: 'urn:s', predicate: 'urn:p', object: '"v"' }], { signal }),
};

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
  expect(await result).toMatchObject({ code: 'STORE_OPERATION_TIMEOUT', backend: 'blazegraph', outcome: 'indeterminate' });
});
it('propagates caller cancellation while the body is unfinished', async () => {
  const f = await endpoint(), controller = new AbortController(), reason = new Error('caller cancelled body');
  const result = writes.insert(f.store, controller.signal).catch(error => error);
  await f.headers; await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(reason);
  expect(await result).toBe(reason);
});
