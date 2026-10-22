import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

it('isolates bounded disk admission from normal reads, health probes and unrelated writes', async () => {
  let release!: () => void, active = 0, peak = 0, started = 0, dispatched = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((request, response) => {
    dispatched += 1;
    if (request.url === '/update') { response.writeHead(204).end(); return; }
    response.setHeader('Content-Type', 'application/sparql-results+json');
    response.end(JSON.stringify({ head: {}, boolean: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 4, ackReservedSlots: 1,
    healthReservedSlots: 1, queueWaitTimeoutMs: 50 });
  const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: `${endpoint}/query`,
    updateEndpoint: `${endpoint}/update`, scheduler }, { persistence: async () => {
    started += 1; active += 1; peak = Math.max(peak, active);
    try { await held; } finally { active -= 1; }
  } });
  const barriers = Array.from({ length: 4 }, () => store.commitment!.capture()());
  const settled = Promise.allSettled(barriers);
  try {
    await vi.waitFor(() => expect(started).toBe(2));
    await expect(store.query('ASK {}')).resolves.toMatchObject({ value: true });
    await expect(store.query('ASK {}', { priority: 'health' })).resolves.toMatchObject({ value: true });
    await store.update('INSERT DATA { <urn:s> <urn:p> "unrelated" }');
    expect(dispatched).toBe(3);
    expect(started).toBe(2);
    expect(peak).toBe(2);
    expect(scheduler.snapshot.normalInflight).toBe(0);
  } finally {
    release(); await settled; await store.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(await settled).toEqual(Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: undefined })));
  expect(peak).toBe(2);
});
