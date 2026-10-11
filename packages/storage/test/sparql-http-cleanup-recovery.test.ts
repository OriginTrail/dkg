// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';

describe('managed atomic staging cleanup recovery', () => {
  it('keeps cancelled cleanup active until confirmed termination without replacing the primary error', async () => {
    const requests: string[] = [];
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        requests.push(body);
        if (requests.length === 1) {
          res.writeHead(500).end('primary mutation failed');
        } else {
          // The server accepted DROP, but has not completed it or sent an answer.
          cleanupStarted();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const activity: boolean[] = [];
    const recover = vi.fn();
    const recovery = { recovering: false, generation: 0 };
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: `${endpoint}/query`, updateEndpoint: `${endpoint}/update`, timeout: 500,
    }, {
      getRecoveryState: () => ({ ...recovery }),
      onClientTimeout: recover, registerActivity: () => ({ report: (count) => activity.push(count), dispose() {} }),
    });
    const caller = new AbortController();
    try {
      const replacing = store.replaceGraph('urn:cleanup:target', [{
        subject: 'urn:cleanup:subject', predicate: 'urn:cleanup:predicate',
        object: '"new"', graph: 'urn:cleanup:target',
      }], { signal: caller.signal }).catch((error: unknown) => error);
      await started;
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatch(/^DROP SILENT GRAPH <urn:dkg:internal:atomic-graph-replace:/);
      caller.abort(new Error('cleanup caller stopped waiting'));
      expect(await replacing).toMatchObject({ message: expect.stringContaining('primary mutation failed') });
      // Caller-visible cleanup ended; server-side work remains unknown.
      expect(activity.at(-1)).toBe(true);
      expect(recover).not.toHaveBeenCalled();
      await expect.poll(() => recover.mock.calls.length, { timeout: 2_000 }).toBe(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('replaceGraph');
      expect(activity.at(-1)).toBe(true);
      recovery.generation += 1;
      await expect.poll(() => activity.at(-1), { timeout: 2_000 }).toBe(false);
    } finally {
      await store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('managed client deadline activity fence', () => {
  it.each(['query', 'update'] as const)(
    'keeps a timed-out %s fenced when its restart is unconfirmed',
    async (operation) => {
      const server = createServer((req) => { req.resume(); });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const activity: boolean[] = [];
      const state = { recovering: false, generation: 0 };
      const recover = vi.fn();
      const store = createManagedOxigraphSparqlStoreV1({
        queryEndpoint: endpoint, updateEndpoint: endpoint, timeout: 100,
      }, {
        getRecoveryState: () => state, onClientTimeout: recover,
        registerActivity: () => ({ report: (count) => activity.push(count), dispose() {} }),
      });
      try {
        await expect(operation === 'query'
          ? store.query('ASK { ?s ?p ?o }')
          : store.update('INSERT DATA { <urn:s> <urn:p> "v" }'))
          .rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
        expect(recover).toHaveBeenCalledExactlyOnceWith(operation);
        expect(activity.at(-1)).toBe(true);
        state.generation = 1;
        await expect.poll(() => activity.at(-1), { timeout: 2_000 }).toBe(false);
        expect(recover).toHaveBeenCalledTimes(1);
      } finally {
        await store.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
