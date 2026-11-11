import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asChangelogReader, createManagedOxigraphRuntimeStoreConfigV1 } from '@origintrail-official/dkg-storage';

const wiring = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  managed: null as null | { storeConfig: unknown; handle: { stop: () => Promise<void> } },
  started: 0,
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  loadConfig: async () => wiring.config,
}));

vi.mock('../src/daemon/oxigraph-managed.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/daemon/oxigraph-managed.js')>(),
  startManagedOxigraph: async () => { wiring.started += 1; return wiring.managed; },
}));

import { dropReadGraphsForRollback, openStoppedNodeStore } from '../src/update/rollback-read-graphs.js';
import { mayHoldReadGraphPartitions } from '@origintrail-official/dkg-storage';

const QUAD = { graph: 'did:dkg:context-graph:opened/_verifiable_memory/0xab/1', subject: 'urn:s', predicate: 'urn:p', object: '"v"' };

/** The store config a managed Oxigraph server hands over, with runtime hooks that record activity. */
function managedStoreConfig(activity: boolean[]) {
  return createManagedOxigraphRuntimeStoreConfigV1({
    backend: 'sparql-http',
    options: { queryEndpoint: 'http://127.0.0.1:7878/query', updateEndpoint: 'http://127.0.0.1:7878/update', managedByDkg: true },
    // The daemon's config has the changelog on; a stopped node's store must not.
    changelog: true,
  }, { registerActivity: () => ({ report: (active) => { activity.push(active); }, dispose() {} }) });
}
let dataDir = '';
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dkg-rollback-read-graphs-'));
  wiring.config = {};
  wiring.managed = null;
  wiring.started = 0;
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

describe('opening a stopped node store for the rollback', () => {
  it('opens the managed server\'s store with its runtime identity, only while the server runs', async () => {
    const stop = vi.fn(async () => undefined);
    const activity: boolean[] = [];
    wiring.managed = { storeConfig: managedStoreConfig(activity), handle: { stop } };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ head: {}, boolean: true }),
      { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } },
    ));
    try {
      const opened = await openStoppedNodeStore(dataDir, () => undefined);
      try {
        expect(asChangelogReader(opened.store)).toBeNull();
        await expect(opened.store.query('ASK { ?s ?p ?o }')).resolves.toMatchObject({ type: 'boolean', value: true });
        // The runtime hooks saw the request, so the config kept what the server attached to it.
        expect(activity).toContain(true);
        expect(stop).not.toHaveBeenCalled();
      } finally { await opened.close(); }
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  it('stops the managed server when the store cannot be built', async () => {
    const stop = vi.fn(async () => undefined);
    wiring.managed = { storeConfig: { backend: 'sparql-http' }, handle: { stop } };
    await expect(openStoppedNodeStore(dataDir, () => undefined)).rejects.toThrow('no authenticated control plane');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('opens the configured store with the changelog off', async () => {
    wiring.config = { store: { backend: 'oxigraph', changelog: true } };
    const opened = await openStoppedNodeStore(dataDir, () => undefined);
    try {
      expect(asChangelogReader(opened.store)).toBeNull();
      await opened.store.insert([QUAD]);
      expect(await opened.store.listGraphs()).toEqual([QUAD.graph]);
    } finally { await opened.close(); }
  });

  it('refuses a configured embedded store whose location it cannot match to the node\'s, and keeps the note', async () => {
    // The note a release that maintains read graphs leaves in the data directory.
    writeFileSync(join(dataDir, 'read-graph-partitions'), '');
    for (const backend of ['oxigraph', 'oxigraph-worker', 'oxigraph-persistent']) {
      // Relative: the rollback's working directory need not be the daemon's.
      wiring.config = { store: { backend, options: { path: 'store.nq' } } };
      await expect(openStoppedNodeStore(dataDir, () => undefined), backend).rejects.toThrow(/relative/);
      // Absolute, with nothing there: opening it would make a new, empty store.
      wiring.config = { store: { backend, options: { path: join(dataDir, 'moved', 'store.nq') } } };
      await expect(dropReadGraphsForRollback(dataDir, () => undefined), backend).rejects.toThrow(/does not exist/);
      expect(existsSync(join(dataDir, 'moved')), backend).toBe(false);
    }
    expect(existsSync(join(process.cwd(), 'store.nq'))).toBe(false);
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(true);

    // The store at the configured absolute path is opened, dropped and the note removed.
    const path = join(dataDir, 'configured.nq');
    writeFileSync(path, '');
    wiring.config = { store: { backend: 'oxigraph', options: { path } } };
    await expect(dropReadGraphsForRollback(dataDir, () => undefined)).resolves.toBe(0);
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(false);
  });

  it('refuses a managed Oxigraph directory it cannot match to the node\'s before it starts the server, and keeps the note', async () => {
    writeFileSync(join(dataDir, 'read-graph-partitions'), '');
    wiring.managed = { storeConfig: { backend: 'sparql-http' }, handle: { stop: vi.fn(async () => undefined) } };
    wiring.config = { store: { backend: 'oxigraph-server', options: { location: 'db' } } };
    await expect(dropReadGraphsForRollback(dataDir, () => undefined)).rejects.toThrow(/store\.options\.location "db" is relative/);
    wiring.config = { store: { backend: 'oxigraph-server', options: { location: join(dataDir, 'moved-db') } } };
    await expect(dropReadGraphsForRollback(dataDir, () => undefined)).rejects.toThrow(/does not exist/);
    expect(wiring.started).toBe(0);
    expect(mayHoldReadGraphPartitions(dataDir)).toBe(true);
    // The default directory in the data directory is the server's own, and starts as before.
    wiring.config = { store: { backend: 'oxigraph-server', options: {} } };
    await expect(openStoppedNodeStore(dataDir, () => undefined)).rejects.toThrow('no authenticated control plane');
    expect(wiring.started).toBe(1);
  });

  it('opens the default embedded store in the data directory when none is configured', async () => {
    const opened = await openStoppedNodeStore(dataDir, () => undefined);
    await opened.store.insert([QUAD]);
    await opened.close();
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
  });
});
