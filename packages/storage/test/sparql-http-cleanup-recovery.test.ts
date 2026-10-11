// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';

describe('managed atomic staging cleanup recovery', () => {
  it('keeps cancelled cleanup active until its deadline without replacing the primary error', async () => {
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
    const activity: number[] = [];
    const recover = vi.fn();
    const store = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: `${endpoint}/query`, updateEndpoint: `${endpoint}/update`, timeout: 500,
    }, {
      getRecoveryState: () => ({ recovering: false, generation: 0 }),
      onClientTimeout: recover, onActivityChange: (count) => activity.push(count),
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
      expect(activity.at(-1)).toBeGreaterThan(0);
      expect(recover).not.toHaveBeenCalled();
      await expect.poll(() => recover.mock.calls.length, { timeout: 2_000 }).toBe(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('replaceGraph');
      expect(activity.at(-1)).toBe(0);
    } finally {
      await store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
