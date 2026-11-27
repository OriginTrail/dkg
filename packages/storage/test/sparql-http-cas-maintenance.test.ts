import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createManagedOxigraphSparqlStoreV1, SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { HEAD_GRAPH, PROJECTION_GRAPH, authorCommitInput } from './rfc64-author-commit-cas-harness.js';

afterEach(() => vi.restoreAllMocks());

describe('managed CAS maintenance boundary', () => {
  it.each(['managed', 'generic'] as const)('preserves an actual HTTP403 rejection on a %s transactional store', async (kind) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = Buffer.concat(parts).toString('utf8');
        requests.push(body);
        if (requests.length === 1) response.writeHead(403).end('write permission denied');
        else response.writeHead(204).end();
      })().catch(error => response.destroy(error));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const options = {
      queryEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/query`,
      consistencyProfile: 'atomic-readback' as const,
    };
    const store = kind === 'managed' ? createManagedOxigraphSparqlStoreV1(options)
      : new SparqlHttpStore(options);
    const before = [PROJECTION_GRAPH, HEAD_GRAPH].map(graph => store.getWriteRevision(graph));
    try {
      await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toMatchObject({
        name: 'SparqlHttpResponseError', status: 403,
      });
      expect(requests.some(body => body.startsWith('ASK'))).toBe(false);
      expect([PROJECTION_GRAPH, HEAD_GRAPH].map(graph => store.getWriteRevision(graph))).toEqual(before);
    } finally {
      await store.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('keeps an HTTP500 update failure indeterminate rather than asserting no commit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('backend outcome unknown', { status: 500 }));
    const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:7878/query' });
    try {
      await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toMatchObject({ outcome: 'indeterminate' });
      expect(store.getWriteRevision(PROJECTION_GRAPH)).toMatchObject({ stable: false });
    } finally { await store.close(); }
  });

  it('keeps the actual HTTP receipt and cleanup alive during a maintenance drain', async () => {
    const state = { recovering: false, admissionsPaused: false, generation: 0 };
    let active = false;
    let receiptStarted!: () => void;
    const receiptDispatched = new Promise<void>((resolve) => { receiptStarted = resolve; });
    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const requests: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = Buffer.concat(parts).toString('utf8');
        requests.push(body);
        if (requests.length === 1) state.admissionsPaused = true;
        if (body.startsWith('ASK')) {
          receiptStarted();
          await receiptGate;
          response.setHeader('Content-Type', 'application/sparql-results+json');
          response.end(JSON.stringify({ boolean: true }));
        } else { response.writeHead(204).end(); }
      })().catch((error) => response.destroy(error));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/query`,
      timeout: 2_000,
    }, { getRecoveryState: () => ({ ...state }), registerActivity: () => ({ report: (count) => { active = count; }, dispose() {} }) });
    const commit = store.rfc64AuthorCommitCasV1(authorCommitInput());
    try {
      await Promise.race([receiptDispatched, commit.then(() => { throw new Error('CAS ended before its receipt'); })]);
      expect(active).toBe(true);
      await expect(store.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
      expect(requests).toHaveLength(2);
      releaseReceipt();
      await expect(commit).resolves.toBe('committed');
      expect(requests).toHaveLength(3);
      expect(requests[2]).toContain('DROP SILENT GRAPH');
      expect(store.getWriteRevision(PROJECTION_GRAPH)).toMatchObject({ stable: true });
    } finally {
      releaseReceipt();
      await store.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('drains an admitted CAS through its receipt and cleanup while refusing fresh work', async () => {
    const state = { recovering: false, admissionsPaused: false, generation: 0 };
    const activities: boolean[] = [];
    const calls: string[] = [];
    let releaseUpdate!: () => void;
    const heldUpdate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let updateStarted!: () => void;
    const dispatched = new Promise<void>((resolve) => { updateStarted = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = String(init?.body);
      calls.push(body);
      if (calls.length === 1) {
        updateStarted();
        await heldUpdate;
        state.admissionsPaused = true;
      }
      return body.startsWith('ASK')
        ? new Response(JSON.stringify({ boolean: true }))
        : new Response(null, { status: 200 });
    });
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: 'http://127.0.0.1:7878/query',
      timeout: 2_000,
      scheduler: new StorePriorityScheduler({
        maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0,
        normalReservedSlots: 0, backgroundReservedSlots: 0,
      }),
    }, {
      getRecoveryState: () => ({ ...state }),
      registerActivity: () => ({ report: (active) => { activities.push(active); }, dispose() {} }),
    });
    const before = store.getWriteRevision(PROJECTION_GRAPH);
    const commit = store.rfc64AuthorCommitCasV1(authorCommitInput());
    try {
      await dispatched;
      releaseUpdate();
      await expect(commit).resolves.toBe('committed');
      expect(calls).toHaveLength(3);
      expect(calls[1]).toContain('ASK');
      expect(calls[2]).toContain('DROP SILENT GRAPH');
      expect(store.getWriteRevision(PROJECTION_GRAPH)).toMatchObject({ stable: true });
      expect(store.getWriteRevision(PROJECTION_GRAPH).generation).toBeGreaterThan(before.generation);
      const firstBusy = activities.findIndex((active) => active);
      expect(activities.slice(firstBusy, -1).every((active) => active)).toBe(true);
      await expect(store.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
      expect(calls).toHaveLength(3);
    } finally {
      releaseUpdate();
      await store.close();
    }
  });

  it.each(['terminated', 'malformed', 'transport', 'refused'] as const)(
    'marks all semantic graphs indeterminate after a submitted CAS loses its %s receipt',
    async (failure) => {
      const state = { recovering: false, admissionsPaused: false, generation: 0 };
      let requests = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        requests += 1;
        if (requests === 1) {
          if (failure === 'terminated') state.generation += 1;
          return new Response(null, { status: 200 });
        }
        if (String(init?.body).startsWith('ASK')) {
          if (failure === 'transport') throw new Error('receipt transport lost');
          if (failure === 'refused') return new Response('read forbidden', { status: 403 });
          return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }));
        }
        return new Response(null, { status: 200 });
      });
      const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:7878/query' }, {
        getRecoveryState: () => ({ ...state }),
      });
      try {
        await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toMatchObject({
          storeOperation: 'rfc64AuthorCommitCasV1', outcome: 'indeterminate',
        });
        for (const graph of [PROJECTION_GRAPH, HEAD_GRAPH]) {
          expect(store.getWriteRevision(graph)).toMatchObject({ stable: false });
          expect(store.getWriteRevision(graph).generation).toBeGreaterThan(0);
        }
        if (failure === 'terminated') expect(requests).toBe(1);
      } finally { await store.close(); }
    },
  );

  it('leaves semantic revisions untouched when maintenance refuses a new CAS before dispatch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:7878/query' }, {
      getRecoveryState: () => ({ recovering: false, admissionsPaused: true, generation: 0 }),
    });
    const before = store.getWriteRevision(PROJECTION_GRAPH);
    try {
      await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toMatchObject({
        storeOperation: 'rfc64AuthorCommitCasV1', outcome: 'not_started',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(store.getWriteRevision(PROJECTION_GRAPH)).toEqual(before);
    } finally { await store.close(); }
  });
});
