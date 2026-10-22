// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { startManagedOxigraph, MANAGED_OXIGRAPH_BACKEND } from '../src/daemon/oxigraph-managed.js';
import { freePort, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

it('keeps stock managed HTTP uncertified while preserving writes, reads and supervised process restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oxi-managed-uncertified-')));
  const dataDir = join(root, 'node'), cacheDir = join(root, 'bin'), port = await freePort();
  const start = () => startManagedOxigraph({
    config: { store: { backend: MANAGED_OXIGRAPH_BACKEND,
      options: { port, cacheDir, writesDurableOnAcknowledgement: true } } },
    dataDir, log: () => {}, readyTimeoutMs: 30_000,
  });
  let managed: Awaited<ReturnType<typeof start>> = null, store: TripleStore | undefined;
  const read = 'ASK { GRAPH <urn:ordinary> { <urn:asset> <urn:value> "observed after process restart" } }';
  try {
    managed = await start(); expect(managed).not.toBeNull();
    store = await createTripleStore(managed!.storeConfig);
    expect(store.commitment).toBeUndefined();
    await store.update('INSERT DATA { GRAPH <urn:ordinary> { <urn:asset> <urn:value> "observed after process restart" } }');
    await store.flush?.();
    expect(store.commitment).toBeUndefined();
    await expect(store.query(read)).resolves.toMatchObject({ type: 'boolean', value: true });

    const phases: string[] = [];
    const recovery = managed!.handle.requestRecovery!(managed!.handle.getRecoveryState().generation, 'uncertified HTTP regression');
    expect(recovery).toBeDefined();
    const unsubscribe = recovery!.subscribe(phase => { phases.push(phase); });
    try { expect(await waitForCondition(() => Promise.resolve(phases.includes('reopened')), 30_000)).toBe(true); }
    finally { unsubscribe(); }
    expect(phases).toContain('signalled'); expect(phases).toContain('terminated');
    await expect(store.query(read)).resolves.toMatchObject({ type: 'boolean', value: true });
    expect(store.commitment).toBeUndefined();

    await store.close(); store = await createTripleStore(managed!.storeConfig);
    await expect(store.query(read)).resolves.toMatchObject({ type: 'boolean', value: true });
    expect(store.commitment).toBeUndefined();
    // Process-crash survival is observed here; it does not establish stable-media durability.
  } finally { await store?.close(); await managed?.handle.stop(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
