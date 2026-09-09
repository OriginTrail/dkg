import { expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

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
