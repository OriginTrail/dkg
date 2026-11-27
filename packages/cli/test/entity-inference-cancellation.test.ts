import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntityIndexStore } from '../src/entity-search/store.js';
import { EntitySearchService } from '../src/entity-search/service.js';
import { LocalEntityEmbedder } from '../src/entity-search/embedding.js';
import { EntityGraphReader } from '../src/entity-search/documents.js';
import { parseIndexRequest } from '../src/entity-search/requests.js';
import { handleEntityRoutes } from '../src/daemon/routes/entities.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanups.splice(0).reverse()) await stop(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it.each([
  ['readiness', 'deadline'], ['readiness', 'disconnect'], ['search', 'deadline'], ['search', 'disconnect'],
])('cancels pending %s inference on %s and releases admission', async (operation, cancellation) => {
  const pending = deferred(), inferenceClosed = deferred(), routeSettled = deferred();
  let hold = true;
  const digest = 'a'.repeat(64);
  const inference = await listen(createServer((req, res) => {
    if (req.url === '/api/embed' && hold) {
      res.once('close', inferenceClosed.resolve); req.resume(); pending.resolve(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/embed' ? { embeddings: [[1, 0]] } : { models: [{ name: 'test:latest', digest }] }));
  }));
  const dir = mkdtempSync(join(tmpdir(), 'entity-inference-cancel-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const service = new EntitySearchService(new EntityIndexStore(dir), new LocalEntityEmbedder({
    provider: 'ollama', model: 'test', digest, dimensions: 2, baseURL: inference,
  }));
  cleanups.push(() => service.close());
  const agent = { query: vi.fn(async () => ({ bindings: [] })) };
  const spec = { contextGraphId: 'catalog', view: 'verifiable-memory', textPredicates: ['urn:text'] };
  const indexed = await service.index(parseIndexRequest(spec), new EntityGraphReader(agent), new AbortController().signal, performance.now() + 5000);
  const api = await listen(createServer(async (req, res) => {
    try {
      await handleEntityRoutes({ req, res, path: req.url!, agent, entitySearch: service,
        authentication: requestAuthentication({ kind: 'nodeOperator' }) } as unknown as RequestContext);
    } finally { routeSettled.resolve(); }
  }));
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const caller = new AbortController();
  const body = { ...spec, indexId: indexed.indexId, query: 'ocean', warmup: operation === 'readiness' };
  const response = fetch(`${api}/api/entities/${operation}`, { method: 'POST', body: JSON.stringify(body), signal: caller.signal });
  // Install the rejection handler before the caller can disconnect.
  const outcome = response.then(value => value, error => error as Error);
  await pending.promise;
  expect(timeout).toHaveBeenCalledWith(operation === 'readiness' ? 30_000 : 2_000);
  if (cancellation === 'deadline') deadline.abort(new DOMException('Expired', 'TimeoutError'));
  else caller.abort();
  await Promise.all([routeSettled.promise, inferenceClosed.promise]);
  const result = await outcome;
  if (cancellation === 'deadline') {
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
    expect(await (result as Response).json()).toEqual({ code: 'QUERY_DEADLINE_EXCEEDED' });
  } else expect(result).toBeInstanceOf(Error);
  timeout.mockRestore(); hold = false;
  for (const next of ['search', 'index', 'readiness']) {
    const nextResponse = await fetch(`${api}/api/entities/${next}`, { method: 'POST', body: JSON.stringify(body) });
    expect(nextResponse.status).toBe(200);
    await nextResponse.json();
  }
});
