/**
 * /api/status chain sanitization + /api/chain/rpc-health probing — REAL
 * daemon, REAL chain, NO mocks.
 *
 * The retired version replaced ethers' JsonRpcProvider with a module mock
 * whose getBlockNumber() returned canned numbers/errors keyed by URL, and
 * drove `handleStatusRoutes` through a hand-built ctx. That could not notice
 * a real provider behaviour change (e.g. a different failure shape) and the
 * sanitization was asserted against a fabricated config.
 *
 * This version boots a real edge daemon whose chain config carries TWO RPC
 * endpoints: the shared Hardhat node (primary — genuinely healthy) and a
 * dead localhost port (backup — a genuinely unreachable endpoint, so the
 * failure path is a REAL connection error, not an injected one). The same
 * contracts are then proven over real HTTP:
 *   - /api/status returns the sanitized chain summary (no raw rpcUrl /
 *     rpcUrls / hubAddress leaks),
 *   - /api/chain/rpc-health probes BOTH endpoints, reports the healthy one
 *     with a real block number, the dead one with the sanitized
 *     'RPC health probe failed' error, and never echoes an RPC URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedContext } from '../../chain/test/evm-test-context.js';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

// A port nothing listens on — connecting to it is a REAL refused connection.
const DEAD_RPC = 'http://127.0.0.1:9';

describe('/api/status + /api/chain/rpc-health (real daemon, real chain)', () => {
  let daemon: LiveDaemon;

  beforeAll(async () => {
    const { rpcUrl, hubAddress } = getSharedContext();
    daemon = await startLiveDaemon({
      extraConfig: {
        chain: {
          type: 'evm',
          rpcUrl,
          rpcUrls: [rpcUrl, DEAD_RPC],
          hubAddress,
          chainId: 'evm:31337',
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('/api/status returns a sanitized chain summary without raw RPC endpoints', async () => {
    const res = await fetch(`${daemon.base}/api/status`, { headers: authHeaders(daemon) });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.chain).toMatchObject({
      chainId: 'evm:31337',
      configured: true,
      rpcEndpointCount: 2,
      hubConfigured: true,
    });
    expect(body.chain).not.toHaveProperty('rpcUrl');
    expect(body.chain).not.toHaveProperty('rpcUrls');
    expect(body.chain).not.toHaveProperty('hubAddress');
  });

  it('/api/chain/rpc-health probes both endpoints; real block number, sanitized real failure, no URL echo', async () => {
    const res = await fetch(`${daemon.base}/api/chain/rpc-health`, { headers: authHeaders(daemon) });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.configured).toBe(true);
    expect(body.rpcEndpointCount).toBe(2);
    expect(body).not.toHaveProperty('rpcUrl');
    expect(body).not.toHaveProperty('rpcUrls');

    // Primary = the real Hardhat node: ok with a REAL block number.
    const primary = body.rpcs.find((p: any) => p.role === 'primary');
    expect(primary.ok).toBe(true);
    expect(typeof primary.blockNumber).toBe('number');
    expect(primary.blockNumber).toBeGreaterThanOrEqual(0);

    // Backup = the dead endpoint: a REAL connection failure, sanitized.
    const backup = body.rpcs.find((p: any) => p.role === 'backup');
    expect(backup.ok).toBe(false);
    expect(backup.blockNumber).toBeNull();
    expect(backup.error).toBe('RPC health probe failed');

    // The overall probe is healthy (primary up) and no probe leaks a URL.
    expect(body.ok).toBe(true);
    expect(typeof body.blockNumber).toBe('number');
    for (const probe of body.rpcs) {
      expect(probe).not.toHaveProperty('rpcUrl');
    }
  });
});
