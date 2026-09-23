import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';
import {
  STORE_QUADS_CACHE_TTL_MS,
  STORE_QUADS_REFRESH_AFTER_MS,
  type StoreQuadsStatusFields,
  type StoreReachability,
} from '../src/status-store-quads-wire.js';

interface StoreFields {
  storeUrl?: string | null;
  storeQuads: number | null;
  // Widened so a status only a newer daemon sends can be rendered as well.
  storeQuadsStatus?: StoreQuadsStatusFields['storeQuadsStatus'] | 'from-a-newer-daemon';
  storeQuadsAgeMs?: number | null;
  storeQuadsRefreshing?: boolean;
  // Widened like the status, for a check result only a newer daemon sends.
  storeReachability?: StoreReachability | 'from-a-newer-daemon';
}

/**
 * Run `dkg status` against a stubbed client. `peek` answers plain status
 * requests and `requested` answers those asking for a store count.
 */
async function renderStatus(peek: StoreFields, requested: StoreFields | Error = peek): Promise<{
  storeLine: string | undefined;
  statusRequests: unknown[][];
}> {
  const lines: string[] = [];
  const statusRequests: unknown[][] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  // The command exits 1 on an error; make that fail the test instead.
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`dkg status exited with ${code}`);
  }) as never);
  const connectSpy = vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    controlPlaneWarning: null,
    status: async (...args: unknown[]) => {
      statusRequests.push(args);
      const options = args[0] as { includeStoreQuads?: boolean } | undefined;
      if (options?.includeStoreQuads && requested instanceof Error) throw requested;
      return {
        name: 'status-store-test',
        peerId: 'peer-status-store-test',
        uptimeMs: 1_000,
        connectedPeers: 0,
        relayConnected: false,
        multiaddrs: [],
        storeBackend: 'sparql-http',
        storeUrl: 'http://127.0.0.1:9999/query',
        ...(options?.includeStoreQuads ? requested as StoreFields : peek),
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
    exitSpy.mockRestore();
    logSpy.mockRestore();
  }
}

// Every run checks reachability first; a count refresh is a second request.
const PLAIN_ONLY = [[{ probeStore: true }]];
const PLAIN_THEN_COUNT = [[{ probeStore: true }], [{ includeStoreQuads: true }]];

const REQUEST_CASES: Array<[label: string, peek: StoreFields, requests: unknown[][]]> = [
  ['asks for a count nobody has requested yet', {
    storeQuads: null, storeQuadsStatus: 'not-requested', storeQuadsAgeMs: null,
  }, PLAIN_THEN_COUNT],
  ['asks for a count when a 10.0.7 to 10.0.18 daemon reports no status', {
    storeQuads: null,
  }, PLAIN_THEN_COUNT],
  ['re-checks a failed count', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 1_000,
  }, PLAIN_THEN_COUNT],
  ['refreshes a count ten minutes old', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 600_000,
  }, PLAIN_THEN_COUNT],
  ['refreshes a count whose age is unknown', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: null,
  }, PLAIN_THEN_COUNT],
  ['refreshes a count from a daemon that reports no age', {
    storeQuads: 66, storeQuadsStatus: 'ready',
  }, PLAIN_THEN_COUNT],
  ['starts no count while a successful one is under ten minutes old', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 599_999,
  }, PLAIN_ONLY],
  ['starts no count while one is running', {
    storeQuads: null, storeQuadsStatus: 'pending', storeQuadsAgeMs: null,
  }, PLAIN_ONLY],
  ['never asks a local backend for a count', {
    storeUrl: null, storeQuads: null,
  }, PLAIN_ONLY],
  ['starts no count while the store is unreachable', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 700_000, storeReachability: 'unreachable',
  }, PLAIN_ONLY],
  ['starts no count while the store gives no answer', {
    storeQuads: null, storeQuadsStatus: 'not-requested', storeQuadsAgeMs: null, storeReachability: 'no-answer',
  }, PLAIN_ONLY],
  ['starts no count on a check result only a newer daemon sends', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 700_000, storeReachability: 'from-a-newer-daemon',
  }, PLAIN_ONLY],
  ['still refreshes an old count when the store answers', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 700_000, storeReachability: 'reachable',
  }, PLAIN_THEN_COUNT],
];

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
  ['a count of unknown age as such', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: null,
  }, '66 quads (age unknown)'],
  ['a failed count as unreachable', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 1_000,
  }, 'UNREACHABLE'],
  ['an old failure with its age', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 125_000,
  }, 'UNREACHABLE (checked 2m 5s ago)'],
  ['a count being refreshed as such', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 660_000, storeQuadsRefreshing: true,
  }, '66 quads (checked 11m 0s ago), refreshing'],
  ['a failure being re-checked as such', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 125_000, storeQuadsRefreshing: true,
  }, 'UNREACHABLE (checked 2m 5s ago), refreshing'],
  ['a count from an older daemon that sends no status', {
    storeQuads: 66,
  }, '66 quads'],
  ['null from an older daemon that sends no status as the legacy unreachable signal', {
    storeQuads: null,
  }, 'UNREACHABLE'],
  ['a status this CLI does not know as unknown rather than unreachable', {
    storeQuads: null, storeQuadsStatus: 'from-a-newer-daemon',
  }, 'UNKNOWN'],
  ['a store that failed this run\'s check as unreachable, even with a cached count', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 120_000, storeReachability: 'unreachable',
  }, 'UNREACHABLE'],
  ['a store that gave this run\'s check no answer as not responding, not unreachable', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 120_000, storeReachability: 'no-answer',
  }, 'NOT RESPONDING'],
  ['a store that failed this run\'s check as unreachable while a count is running', {
    storeQuads: null, storeQuadsStatus: 'pending', storeQuadsAgeMs: null, storeReachability: 'unreachable',
  }, 'UNREACHABLE'],
  ['a store that failed this run\'s check as unreachable when no count was requested', {
    storeQuads: null, storeQuadsStatus: 'not-requested', storeQuadsAgeMs: null, storeReachability: 'unreachable',
  }, 'UNREACHABLE'],
  ['a store that gave this run\'s check no answer as not responding while a count is running', {
    storeQuads: null, storeQuadsStatus: 'pending', storeQuadsAgeMs: null, storeReachability: 'no-answer',
  }, 'NOT RESPONDING'],
  ['a store that gave this run\'s check no answer as not responding when no count was requested', {
    storeQuads: null, storeQuadsStatus: 'not-requested', storeQuadsAgeMs: null, storeReachability: 'no-answer',
  }, 'NOT RESPONDING'],
  ['a failed count of a store that answers as a failed count, not an outage', {
    storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 125_000, storeReachability: 'reachable',
  }, 'reachable, count failed (checked 2m 5s ago)'],
  ['the count of a store that answers', {
    storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 120_000, storeReachability: 'reachable',
  }, '66 quads (checked 2m 0s ago)'],
];

describe('dkg status external-store count requests', () => {
  // A refresh window shorter than the daemon's cache TTL would make
  // `dkg status` ask for recounts that the daemon answers from its cache.
  it('waits at least the daemon cache TTL before asking to recount a successful count', () => {
    expect(STORE_QUADS_REFRESH_AFTER_MS).toBeGreaterThanOrEqual(STORE_QUADS_CACHE_TTL_MS);
  });

  it.each(REQUEST_CASES)('%s', async (_label, peek, requests) => {
    const { statusRequests } = await renderStatus(peek, {
      storeQuads: null, storeQuadsStatus: 'pending', storeQuadsAgeMs: null,
    });

    expect(statusRequests).toEqual(requests);
  });

  it('renders the response to the count request', async () => {
    const { storeLine } = await renderStatus(
      { storeQuads: null, storeQuadsStatus: 'not-requested', storeQuadsAgeMs: null },
      { storeQuads: null, storeQuadsStatus: 'pending', storeQuadsAgeMs: null },
    );

    expect(storeLine).toBe('  Store:     sparql-http (http://127.0.0.1:9999/query) — CHECKING');
  });

  it('renders the count the refresh request returns, not the one it replaced', async () => {
    const { storeLine } = await renderStatus(
      { storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 700_000 },
      { storeQuads: 70, storeQuadsStatus: 'ready', storeQuadsAgeMs: 0, storeQuadsRefreshing: false },
    );

    expect(storeLine).toBe('  Store:     sparql-http (http://127.0.0.1:9999/query) — 70 quads');
  });

  it('prints the plain response when the optional refresh request fails', async () => {
    const { storeLine, statusRequests } = await renderStatus(
      { storeQuads: 66, storeQuadsStatus: 'ready', storeQuadsAgeMs: 700_000, storeReachability: 'reachable' },
      new Error('socket hang up'),
    );

    expect(statusRequests).toEqual(PLAIN_THEN_COUNT);
    expect(storeLine).toBe('  Store:     sparql-http (http://127.0.0.1:9999/query) — 66 quads (checked 11m 40s ago)');
  });

  // The count request makes no check, so its response cannot replace this
  // run's, whatever it says about reachability.
  it.each([undefined, 'unreachable', 'no-answer'] as const)(
    'keeps this run\'s reachability when it renders the refreshed count (the refresh reports %s)',
    async (refreshReachability) => {
      const { storeLine } = await renderStatus(
        {
          storeQuads: null, storeQuadsStatus: 'unreachable', storeQuadsAgeMs: 125_000, storeReachability: 'reachable',
        },
        {
          storeQuads: null,
          storeQuadsStatus: 'unreachable',
          storeQuadsAgeMs: 125_000,
          storeQuadsRefreshing: true,
          storeReachability: refreshReachability,
        },
      );

      expect(storeLine)
        .toBe('  Store:     sparql-http (http://127.0.0.1:9999/query) — reachable, count failed (checked 2m 5s ago), refreshing');
    },
  );
});

describe('dkg status external-store rendering', () => {
  it.each(RENDER_CASES)('renders %s', async (_label, store, rendered) => {
    const { storeLine } = await renderStatus(store);

    expect(storeLine).toBe(`  Store:     sparql-http (http://127.0.0.1:9999/query) — ${rendered}`);
  });
});
