import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asChangelogReader } from '@origintrail-official/dkg-storage';

const wiring = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  managed: null as null | { storeConfig: Record<string, unknown>; handle: { stop: () => Promise<void> } },
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  loadConfig: async () => wiring.config,
}));

vi.mock('../src/daemon/oxigraph-managed.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/daemon/oxigraph-managed.js')>(),
  startManagedOxigraph: async () => wiring.managed,
}));

import { openStoppedNodeStore } from '../src/update/rollback-read-graphs.js';

const QUAD = { graph: 'did:dkg:context-graph:opened/_verifiable_memory/0xab/1', subject: 'urn:s', predicate: 'urn:p', object: '"v"' };
let dataDir = '';
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dkg-rollback-read-graphs-'));
  wiring.config = {};
  wiring.managed = null;
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

describe('opening a stopped node store for the rollback', () => {
  it('runs a managed Oxigraph server only while the store is open', async () => {
    const stop = vi.fn(async () => undefined);
    wiring.managed = { storeConfig: { backend: 'oxigraph' }, handle: { stop } };
    const opened = await openStoppedNodeStore(dataDir, () => undefined);
    await opened.store.insert([QUAD]);
    expect(stop).not.toHaveBeenCalled();
    await opened.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops the managed server when the store cannot be built', async () => {
    const stop = vi.fn(async () => undefined);
    wiring.managed = { storeConfig: { backend: 'no-such-backend' }, handle: { stop } };
    await expect(openStoppedNodeStore(dataDir, () => undefined)).rejects.toThrow('Unknown TripleStore backend');
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

  it('opens the default embedded store in the data directory when none is configured', async () => {
    const opened = await openStoppedNodeStore(dataDir, () => undefined);
    await opened.store.insert([QUAD]);
    await opened.close();
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
  });
});
