/**
 * OT-RFC-73 P14: `store.controlReservedSlots` in the node config. The type takes the values of
 * DKG_STORE_CONTROL_RESERVED_SLOTS (a string, or the number 0), and the loader hands the value to the daemon
 * unchanged, malformed or not: the storage resolver judges it (a malformed value leaves the path off with a
 * warning), so it is never a startup error.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStoreControlConfig } from '@origintrail-official/dkg-storage';
import { DkgHomeFiles, validateStoreConfig, type DkgConfig } from '../src/config.js';

describe('the config type', () => {
  it('accepts a per-queue string and the number 0 beside the other store fields', () => {
    const on: DkgConfig['store'] = { backend: 'blazegraph', options: { url: 'http://127.0.0.1:9999/sparql' }, controlReservedSlots: 'share:1,publisher:2' };
    const off: DkgConfig['store'] = { backend: 'blazegraph', options: { url: 'http://127.0.0.1:9999/sparql' }, controlReservedSlots: 0 };
    const zero: DkgConfig['store'] = { backend: 'oxigraph-server', controlReservedSlots: '0' };
    const absent: DkgConfig['store'] = { backend: 'blazegraph', options: { url: 'http://127.0.0.1:9999/sparql' } };
    expect([on, off, zero, absent].map((store) => store?.controlReservedSlots)).toEqual(['share:1,publisher:2', 0, '0', undefined]);
  });

  it('is not a store validation error, malformed or not', () => {
    for (const controlReservedSlots of ['share:1,publisher:2', 0, 'garbage', true, null]) {
      expect(validateStoreConfig({ store: { backend: 'blazegraph', options: { url: 'http://127.0.0.1:9999/sparql' }, controlReservedSlots } }))
        .toEqual([]);
    }
  });
});

describe('the config loader', () => {
  let home: string;
  let files: DkgHomeFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dkg-store-control-config-'));
    files = new DkgHomeFiles(home);
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const loadStore = async (store: unknown) => {
    await writeFile(files.configPath, JSON.stringify({ name: 'n', store }));
    return (await files.loadConfig()).store;
  };

  it('passes store.controlReservedSlots from config.json through unchanged', async () => {
    expect((await loadStore({ backend: 'blazegraph', controlReservedSlots: 'share:1,publisher:2' }))?.controlReservedSlots)
      .toBe('share:1,publisher:2');
    expect((await loadStore({ backend: 'blazegraph', controlReservedSlots: 0 }))?.controlReservedSlots).toBe(0);
    expect((await loadStore({ backend: 'blazegraph', controlReservedSlots: '0' }))?.controlReservedSlots).toBe('0');
    expect(await loadStore({ backend: 'blazegraph' })).toEqual({ backend: 'blazegraph' });
  });

  it('passes a malformed value through for the resolver to refuse, never as the default', async () => {
    const store = await loadStore({ backend: 'blazegraph', controlReservedSlots: true });
    expect(store?.controlReservedSlots).toBe(true);
    expect(resolveStoreControlConfig(undefined, { cpus: 8, backend: store?.backend, configured: store?.controlReservedSlots }))
      .toMatchObject({ slots: { share: 0, publisher: 0 }, source: 'refused' });
  });

  it('reads the same values from config.yaml', async () => {
    await writeFile(files.configYamlPath, 'name: n\nstore:\n  backend: blazegraph\n  controlReservedSlots: share:1,publisher:2\n');
    expect((await files.loadConfig()).store?.controlReservedSlots).toBe('share:1,publisher:2');
    await writeFile(files.configYamlPath, 'name: n\nstore:\n  backend: blazegraph\n  controlReservedSlots: 0\n');
    expect((await files.loadConfig()).store?.controlReservedSlots).toBe(0);
  });
});
