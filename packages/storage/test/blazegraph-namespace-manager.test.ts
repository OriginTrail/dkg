import { describe, expect, it } from 'vitest';

import { BlazegraphNamespaceManager } from '../src/blazegraph-namespace-manager.js';

const SERVICE_URL = 'http://127.0.0.1:9999/bigdata/namespace/kb/sparql';
const renderNamespaceXml = (namespace: string): string => `<namespace>${namespace}</namespace>`;

describe('BlazegraphNamespaceManager', () => {
  it('ensures an existing namespace without issuing a create', async () => {
    const calls: Array<Readonly<{ method: string; url: string }>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(Object.freeze({ method: init?.method ?? 'GET', url: String(input) }));
      return new Response('', { status: 200 });
    };
    const manager = new BlazegraphNamespaceManager({
      serviceUrl: SERVICE_URL,
      fetchImpl,
      renderNamespaceXml,
      requestTimeoutMs: 100,
    });

    await expect(manager.ensure('selected-cg')).resolves.toEqual({
      created: false,
      sparqlUrl: 'http://127.0.0.1:9999/bigdata/namespace/selected-cg/sparql',
    });
    expect(calls).toEqual([{
      method: 'GET',
      url: 'http://127.0.0.1:9999/bigdata/namespace/selected-cg/sparql/properties',
    }]);
  });

  it('starts the complete lease plan concurrently and disposes every lease concurrently', async () => {
    const pendingCreates: Array<() => void> = [];
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          pendingCreates.push(() => resolve(new Response('', { status: 201 })));
        });
      }
      if (init?.method === 'DELETE') {
        activeDeletes += 1;
        maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
        await Promise.resolve();
        activeDeletes -= 1;
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected method ${String(init?.method)}`);
    };
    const manager = new BlazegraphNamespaceManager({
      serviceUrl: SERVICE_URL,
      fetchImpl,
      renderNamespaceXml,
      requestTimeoutMs: 100,
    });
    const acquiring = manager.acquireMany(['author', 'receiver-a', 'receiver-b']);
    await waitFor(() => pendingCreates.length === 3);
    pendingCreates.forEach((resolve) => resolve());
    const leases = await acquiring;

    expect(leases.map((lease) => lease.namespace)).toEqual([
      'author',
      'receiver-a',
      'receiver-b',
    ]);
    await manager.disposeAll(leases);
    expect(maxActiveDeletes).toBe(3);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not become true');
}
