import { expect, it } from 'vitest';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';
import { startOxigraphSparqlEndpoint } from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import { checkOrSetStoreIdentity } from '../src/daemon/store-health-check.js';

const SENTINEL = '<urn:reset-test:subject> <urn:reset-test:predicate> "preserve-me" <urn:reset-test:graph> .\n';
const OLD_MARKER = 'issue-1441-old-chain';

it.each(['1', undefined] as const)('honors DKG_SKIP_CHAIN_RESET_WIPE=%s through daemon startup', async flag => {
  const network = JSON.parse(await readFile(new URL('../../../network/testnet.json', import.meta.url), 'utf8'));
  expect(typeof network.chainResetMarker).toBe('string');
  expect(network.chainResetMarker).not.toBe(OLD_MARKER);
  let daemon: LiveDaemon | undefined;
  try {
    daemon = await startLiveDaemon({
      // This tests daemon/file ownership with a mock chain and no publishing.
      extraConfig: { networkConfig: 'testnet', chain: { type: 'mock' }, rfc64Catalog: { enabled: false } },
      env: { DKG_SKIP_CHAIN_RESET_WIPE: flag },
      prepareHome: async home => {
        await writeFile(join(home, '.network-state.json'), JSON.stringify({ chainResetMarker: OLD_MARKER }));
        await writeFile(join(home, 'store.nq'), SENTINEL);
      },
    });
    const state = JSON.parse(await readFile(join(daemon.home, '.network-state.json'), 'utf8'));
    const backups = (await readdir(daemon.home)).filter(name => name.startsWith('store.nq.pre-wipe-'));
    if (flag === '1') {
      expect(state.chainResetMarker).toBe(OLD_MARKER);
      expect(backups).toEqual([]);
      expect(await readFile(join(daemon.home, 'store.nq'), 'utf8')).toContain('preserve-me');
    } else {
      expect(state.chainResetMarker).toBe(network.chainResetMarker);
      expect(backups).toHaveLength(1);
      expect(await readFile(join(daemon.home, backups[0]), 'utf8')).toBe(SENTINEL);
    }
  } finally { await stopLiveDaemon(daemon); }
});

it.each(['completed', 'incomplete', 'marker-write-failed'] as const)(
  're-tags a managed external namespace after a %s reset', async outcome => {
    const endpoint = await startOxigraphSparqlEndpoint();
    const storeConfig = {
      backend: 'sparql-http',
      options: { queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint, managedByDkg: true },
    };
    endpoint.store.update('INSERT DATA { GRAPH <urn:reset-fixture:old-graph> { <urn:s> <urn:p> "old-chain" } }');
    let daemon: LiveDaemon | undefined;
    try {
      daemon = await startLiveDaemon({
        extraConfig: {
          networkConfig: 'testnet', chain: { type: 'mock' }, rfc64Catalog: { enabled: false }, store: storeConfig,
        },
        env: { DKG_SKIP_CHAIN_RESET_WIPE: undefined },
        prepareHome: async home => {
          if (outcome === 'marker-write-failed') {
            await mkdir(join(home, '.network-state.json'));
          } else {
            await writeFile(join(home, '.network-state.json'), JSON.stringify({ chainResetMarker: OLD_MARKER }));
          }
          if (outcome === 'incomplete') {
            // Journal cleanup is deliberately non-recursive. A directory at a
            // journal path fails on every platform without denying store access.
            await mkdir(join(home, 'publish-journal.blocked-fixture'));
          }
        },
      });
      await daemon.owner.stop();
      const logs = await readFile(join(daemon.home, 'daemon.log'), 'utf8');
      expect(endpoint.store.query('ASK { GRAPH <urn:reset-fixture:old-graph> { ?s ?p ?o } }')).toBe(false);
      expect(logs).toContain(`Chain-state auto-wipe ${outcome === 'completed' ? 'complete' : outcome}:`);
      expect(logs).toContain('Re-tagged triple-store namespace');
      // A matching result proves the daemon already restored ownership. This
      // call would report "tagged" if it had to repair the missing tag itself.
      expect(await checkOrSetStoreIdentity({ storeConfig, nodeName: 'live-daemon-test' })).toMatchObject({ ok: true, action: 'matched' });
      if (outcome === 'incomplete') {
        expect(JSON.parse(await readFile(join(daemon.home, '.network-state.json'), 'utf8')).chainResetMarker).toBe(OLD_MARKER);
      }
    } finally {
      await stopLiveDaemon(daemon);
      await endpoint.close();
    }
  },
);

it('reports a marker-write failure without claiming a completed daemon reset', async () => {
  let daemon: LiveDaemon | undefined;
  try {
    daemon = await startLiveDaemon({
      extraConfig: { networkConfig: 'testnet', chain: { type: 'mock' }, rfc64Catalog: { enabled: false } },
      env: { DKG_SKIP_CHAIN_RESET_WIPE: undefined },
      prepareHome: async home => {
        await mkdir(join(home, '.network-state.json'));
        await writeFile(join(home, 'store.nq'), SENTINEL);
      },
    });
    await daemon.owner.stop();
    const logs = await readFile(join(daemon.home, 'daemon.log'), 'utf8');
    expect((await stat(join(daemon.home, '.network-state.json'))).isDirectory()).toBe(true);
    const backups = (await readdir(daemon.home)).filter(name => name.startsWith('store.nq.pre-wipe-'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(daemon.home, backups[0]), 'utf8')).toBe(SENTINEL);
    expect(logs).toContain('Chain-state auto-wipe marker-write-failed');
    expect(logs).not.toContain('Chain-state auto-wipe complete:');
  } finally { await stopLiveDaemon(daemon); }
});
