// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { startManagedOxigraph, MANAGED_OXIGRAPH_BACKEND } from '../src/daemon/oxigraph-managed.js';
import { freePort, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

const fault = vi.hoisted(() => ({ path: '', committedBytes: 0, once: false, injected: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle);
    if (args[1] === 'r+' && String(args[0]) === fault.path) handle.sync = async () => {
      if (fault.once) {
        fault.once = false; fault.injected += 1;
        // Deliberately model lost writeback, retaining only the certified prefix.
        await handle.truncate(fault.committedBytes);
        await sync();
        throw Object.assign(new Error('injected lost WAL writeback'), { code: 'EIO' });
      }
      await sync();
    };
    return handle;
  } };
});

it('never certifies a lost WAL tail by retrying the same owner, then repairs on a fresh owner', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-wal-writeback-')));
  const dataDir = join(root, 'node'), cacheDir = join(root, 'bin'), port = await freePort();
  const start = () => startManagedOxigraph({ config: { store: { backend: MANAGED_OXIGRAPH_BACKEND,
    options: { port, cacheDir } } }, dataDir, log: () => {}, readyTimeoutMs: 30_000 });
  let managed: Awaited<ReturnType<typeof start>> = null, store: TripleStore | undefined;
  const seed = 'ASK { GRAPH <urn:wal> { <urn:seed> <urn:value> "committed" } }';
  const target = 'ASK { GRAPH <urn:wal> { <urn:target> <urn:value> "repair me" } }';
  const writeTarget = 'INSERT DATA { GRAPH <urn:wal> { <urn:target> <urn:value> "repair me" } }';
  const crashAndReopen = async () => {
    const phases: string[] = [];
    const recovery = managed!.handle.requestRecovery!(managed!.handle.getRecoveryState().generation, 'WAL writeback regression');
    expect(recovery).toBeDefined();
    const unsubscribe = recovery!.subscribe(phase => { phases.push(phase); });
    try { expect(await waitForCondition(() => Promise.resolve(phases.includes('reopened')), 30_000)).toBe(true); }
    finally { unsubscribe(); }
    expect(phases).toContain('signalled'); expect(phases).toContain('terminated');
  };
  try {
    managed = await start(); store = await createTripleStore(managed!.storeConfig);
    await store.update('INSERT DATA { GRAPH <urn:wal> { <urn:seed> <urn:value> "committed" } }');
    await store.commitment!.capture()();
    const db = join(dataDir, 'oxigraph-data');
    const names = (await readdir(db)).filter(name => /^\d+\.log$/.test(name));
    const prefixes = new Map(await Promise.all(names.map(async name => [name, (await stat(join(db, name))).size] as const)));
    const captured = store.commitment!.capture();
    await store.update(writeTarget);
    const grown = (await Promise.all(names.map(async name => ({ name, size: (await stat(join(db, name))).size }))))
      .filter(file => file.size > prefixes.get(file.name)!);
    expect(grown).toHaveLength(1);
    fault.path = join(db, grown[0]!.name); fault.committedBytes = prefixes.get(grown[0]!.name)!;
    fault.once = true;
    await expect(captured()).rejects.toMatchObject({ code: 'EIO' });
    expect(fault.injected).toBe(1);
    await expect(store.query(target)).resolves.toMatchObject({ value: true }); // Memtable is misleading.
    await expect(captured()).rejects.toMatchObject({ code: 'EIO' });
    await expect(store.commitment!.capture()()).rejects.toMatchObject({ code: 'EIO' });
    await crashAndReopen();
    await expect(store.query(seed)).resolves.toMatchObject({ value: true });
    await expect(store.query(target)).resolves.toMatchObject({ value: false });
    await expect(captured()).rejects.toMatchObject({ code: 'EIO' });

    // Recreate the managed owner after replay, reapply, and certify the repair.
    await store.close(); store = undefined; await managed!.handle.stop(); managed = null;
    managed = await start(); store = await createTripleStore(managed!.storeConfig);
    const repaired = store.commitment!.capture();
    await store.update(writeTarget); await repaired(); await crashAndReopen();
    await expect(store.query(seed)).resolves.toMatchObject({ value: true });
    await expect(store.query(target)).resolves.toMatchObject({ value: true });
  } finally {
    fault.once = false; fault.path = ''; fault.injected = 0;
    await store?.close(); await managed?.handle.stop(); await rm(root, { recursive: true, force: true });
  }
}, 120_000);
