import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_STATE_FILE,
  readPersistedDaemonState,
  readPersistedNetworkConfig,
  readPersistedStoreBackend,
  writePersistedChainResetMarker,
  writePersistedNetworkConfig,
  writePersistedStoreBackend,
} from '../src/daemon/daemon-state.js';

describe('persisted daemon state', () => {
  it('preserves sibling fields when marker, backend, and network writers update independently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-daemon-state-'));

    writePersistedStoreBackend(dataDir, 'oxigraph-server');
    writePersistedNetworkConfig(dataDir, 'mainnet-gnosis');
    writePersistedChainResetMarker(dataDir, 'reset-42');

    expect(readPersistedDaemonState(dataDir)).toMatchObject({
      chainResetMarker: 'reset-42',
      lastBackend: 'oxigraph-server',
      lastNetworkConfig: 'mainnet-gnosis',
    });
    expect(readPersistedStoreBackend(dataDir)).toBe('oxigraph-server');
    expect(readPersistedNetworkConfig(dataDir)).toBe('mainnet-gnosis');

    writePersistedStoreBackend(dataDir, 'blazegraph');
    expect(readPersistedDaemonState(dataDir)).toMatchObject({
      chainResetMarker: 'reset-42',
      lastBackend: 'blazegraph',
      lastNetworkConfig: 'mainnet-gnosis',
    });
  });

  it('treats malformed state as absent and repairs it on the next write', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-daemon-state-invalid-'));
    await writeFile(
      join(dataDir, DAEMON_STATE_FILE),
      JSON.stringify({ chainResetMarker: 42, lastBackend: 'oxigraph' }),
    );

    expect(readPersistedDaemonState(dataDir)).toBeNull();
    writePersistedNetworkConfig(dataDir, 'testnet');
    expect(readPersistedDaemonState(dataDir)).toMatchObject({
      chainResetMarker: null,
      lastNetworkConfig: 'testnet',
    });
  });
});
