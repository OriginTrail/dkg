import { Command } from 'commander';
import type { WalRuntimeStatus } from '@origintrail-official/dkg-wal';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';

async function renderStatus(store: {
  storeQuads: number | null;
  storeQuadsStatus?: 'pending' | 'ready' | 'unreachable';
  wal?: WalRuntimeStatus;
}): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const connectSpy = vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    controlPlaneWarning: null,
    status: async () => ({
      name: 'status-store-test',
      peerId: 'peer-status-store-test',
      uptimeMs: 1_000,
      connectedPeers: 0,
      relayConnected: false,
      multiaddrs: [],
      storeBackend: 'sparql-http',
      storeUrl: 'http://127.0.0.1:9999/query',
      ...store,
    }),
  } as never);

  try {
    const program = new Command();
    program.exitOverride();
    registerLifecycleCommands(program);
    await program.parseAsync(['node', 'dkg', 'status']);
    return lines.join('\n');
  } finally {
    connectSpy.mockRestore();
    logSpy.mockRestore();
  }
}

describe('dkg status external-store rendering', () => {
  it('renders a cold healthy store as checking rather than unreachable', async () => {
    const output = await renderStatus({
      storeQuads: null,
      storeQuadsStatus: 'pending',
    });

    expect(output).toContain('CHECKING');
    expect(output).not.toContain('UNREACHABLE');
  });

  it('keeps null from older daemons as the legacy unreachable signal', async () => {
    const output = await renderStatus({ storeQuads: null });

    expect(output).toContain('UNREACHABLE');
    expect(output).not.toContain('CHECKING');
  });

  it('renders the live WAL mode, lifecycle, and authority', async () => {
    const output = await renderStatus({
      storeQuads: 10,
      wal: {
        mode: 'parallel',
        lifecycle: 'ready',
        ready: true,
        synchronizationAuthority: 'legacy',
        shadowEnabled: true,
        runtimeRegistered: true,
        protocolsRegistered: false,
        workersActive: 0,
        protocolVersion: 1,
        adapterVersion: 1,
        paths: null,
        blockedReason: null,
      },
    });

    expect(output).toContain('WAL:       parallel (ready; legacy sync authoritative)');
  });
});
