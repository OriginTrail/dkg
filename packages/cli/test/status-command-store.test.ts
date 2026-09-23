import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, type DaemonStatusResponse } from '../src/api-client.js';
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';

interface StoreFields {
  storeQuads: number | null;
  // Widened so a status only a newer daemon sends can be rendered as well.
  storeQuadsStatus?: DaemonStatusResponse['storeQuadsStatus'] | 'from-a-newer-daemon';
  storeQuadsAgeMs?: number | null;
}

async function renderStatus(store: StoreFields): Promise<{
  storeLine: string | undefined;
  statusRequests: unknown[][];
}> {
  const lines: string[] = [];
  const statusRequests: unknown[][] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const connectSpy = vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    controlPlaneWarning: null,
    status: async (...args: unknown[]) => {
      statusRequests.push(args);
      return {
        name: 'status-store-test',
        peerId: 'peer-status-store-test',
        uptimeMs: 1_000,
        connectedPeers: 0,
        relayConnected: false,
        multiaddrs: [],
        storeBackend: 'sparql-http',
        storeUrl: 'http://127.0.0.1:9999/query',
        ...store,
      };
    },
  } as never);

  try {
    const program = new Command();
    program.exitOverride();
    registerLifecycleCommands(program);
    await program.parseAsync(['node', 'dkg', 'status']);
    return {
      storeLine: lines.find((line) => line.includes('Store:')),
      statusRequests,
    };
  } finally {
    connectSpy.mockRestore();
    logSpy.mockRestore();
  }
}

const RENDER_CASES: Array<[label: string, store: StoreFields, rendered: string]> = [
  ['a count in progress as checking', {
    storeQuads: null, storeQuadsStatus: 'pending', storeQuadsAgeMs: null,
  }, 'CHECKING'],
  ['a count nobody has requested as not checked rather than unreachable', {
    storeQuads: null, storeQuadsStatus: 'not-requested', storeQuadsAgeMs: null,
  }, 'NOT CHECKED'],
  ['a fresh count', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 5_000,
  }, '66 quads'],
  ['a count just under a minute old without its age', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 59_999,
  }, '66 quads'],
  ['a cached count past a minute old with its age', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 3_720_000,
  }, '66 quads (checked 1h 2m ago)'],
  ['a failed count as unreachable', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 1_000,
  }, 'UNREACHABLE'],
  ['an old failure with its age', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 125_000,
  }, 'UNREACHABLE (checked 2m 5s ago)'],
  ['a count from an older daemon that sends no status', {
    storeQuads: 66,
  }, '66 quads'],
  ['null from an older daemon that sends no status as the legacy unreachable signal', {
    storeQuads: null,
  }, 'UNREACHABLE'],
  ['a status this CLI does not know as unknown rather than unreachable', {
    storeQuads: null, storeQuadsStatus: 'from-a-newer-daemon',
  }, 'UNKNOWN'],
];

describe('dkg status external-store rendering', () => {
  it('asks the daemon for the store count explicitly', async () => {
    const { statusRequests } = await renderStatus({
      storeQuads: 66,
      storeQuadsStatus: 'ready',
      storeQuadsAgeMs: 0,
    });

    expect(statusRequests).toEqual([[{ includeStoreQuads: true }]]);
  });

  it.each(RENDER_CASES)('renders %s', async (_label, store, rendered) => {
    const { storeLine } = await renderStatus(store);

    expect(storeLine).toBe(`  Store:     sparql-http (http://127.0.0.1:9999/query) — ${rendered}`);
  });
});
