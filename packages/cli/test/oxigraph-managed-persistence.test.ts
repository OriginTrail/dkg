// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { startManagedOxigraph, MANAGED_OXIGRAPH_BACKEND } from '../src/daemon/oxigraph-managed.js';
import { freePort, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

// Delegate actual filesystem operations and inject only the selected directory sync failure.
const directorySync = vi.hoisted(() => ({ fail: '', synced: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), path = String(args[0]);
    if (args[1] === 'r') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (path === directorySync.fail) throw Object.assign(new Error('held database ancestor sync'), { code: 'EIO' });
        await sync(); directorySync.synced.push(path);
      };
    }
    return handle;
  } };
});

it('reconstructs adoption ancestry after managed owner replacement and certifies actual SIGKILL/reopen', async () => {
  // Binary installation and the database share an absent node parent.
  const root = await mkdtemp(join(tmpdir(), 'oxi-managed-persistence-'));
  const dataDir = join(root, 'new-node'), cacheDir = join(dataDir, 'bin'), port = await freePort();
  const start = () => startManagedOxigraph({
    config: { store: { backend: MANAGED_OXIGRAPH_BACKEND, options: { port, cacheDir } } },
    dataDir, log: () => {}, readyTimeoutMs: 30_000,
  });
  const update = 'INSERT DATA { GRAPH <urn:certified> { <urn:asset> <urn:value> "survives SIGKILL" } }';
  const sentinel = 'ASK { GRAPH <urn:certified> { <urn:after-replacement> <urn:value> "fresh mutation" } }';
  let managed: Awaited<ReturnType<typeof start>> = null, store: TripleStore | undefined;
  try {
    managed = await start(); expect(managed).not.toBeNull();
    store = await createTripleStore(managed!.storeConfig);
    expect(store.commitment?.durability).toBe('restart-durable');
    const originalCommit = store.commitment!.capture();
    await store.update(update);
    if (process.platform !== 'win32') {
      directorySync.fail = root;
      await expect(originalCommit()).rejects.toMatchObject({ code: 'EIO' });
    } else await originalCommit();

    // Replace the daemon's directory owner while its ancestor failure is still held.
    await store.close(); store = undefined; await managed!.handle.stop(); managed = null;
    managed = await start(); expect(managed).not.toBeNull();
    store = await createTripleStore(managed!.storeConfig);
    const commit = store.commitment!.capture();
    await expect(store.query(sentinel)).resolves.toMatchObject({ type: 'boolean', value: false });
    await store.update('INSERT DATA { GRAPH <urn:certified> { <urn:after-replacement> <urn:value> "fresh mutation" } }');
    if (process.platform !== 'win32') await expect(commit()).rejects.toMatchObject({ code: 'EIO' });
    directorySync.fail = ''; directorySync.synced = [];
    await commit();
    if (process.platform !== 'win32') {
      expect(directorySync.synced).toEqual(expect.arrayContaining([join(dataDir, 'oxigraph-data'), dataDir, root]));
    }

    const phases: string[] = [];
    const recovery = managed!.handle.requestRecovery!(managed!.handle.getRecoveryState().generation, 'test certified WAL after SIGKILL');
    expect(recovery).toBeDefined();
    const unsubscribe = recovery!.subscribe(phase => { phases.push(phase); });
    try { expect(await waitForCondition(() => Promise.resolve(phases.includes('reopened')), 30_000)).toBe(true); }
    finally { unsubscribe(); }
    expect(phases).toContain('signalled'); expect(phases).toContain('terminated');
    // The production supervisor verified ownership and sent SIGKILL; no graceful close since certification.
    await expect(store.query(sentinel)).resolves.toMatchObject({ type: 'boolean', value: true });
    await expect(store.query('ASK { GRAPH <urn:certified> { <urn:asset> <urn:value> "survives SIGKILL" } }'))
      .resolves.toMatchObject({ type: 'boolean', value: true });
  } finally {
    directorySync.fail = ''; directorySync.synced = [];
    await store?.close(); await managed?.handle.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
