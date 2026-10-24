import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RpcRequestGovernor } from '@origintrail-official/dkg-chain';
import {
  LIVE_DAEMON_RPC_REQUEST_BUDGET,
  startLiveDaemon,
  stopLiveDaemon,
  getJson,
  type LiveDaemon,
} from './helpers/live-daemon.js';

it('two daemon children bind their own ports and one teardown leaves the other and a foreign listener alive', async () => {
  const foreign = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const daemons: LiveDaemon[] = [];
  try {
    await Promise.all([1, 2].map(async () => {
      const daemon = await startLiveDaemon({ authEnabled: false, extraConfig: { chain: { type: 'mock' } } });
      daemons.push(daemon);
    }));
    expect(new Set(daemons.map((daemon) => daemon.apiPort)).size).toBe(2);
    for (const daemon of daemons) {
      expect(daemon.apiPort).not.toBe((foreign.address() as { port: number }).port);
      expect(Number((await readFile(join(daemon.home, 'api.port'), 'utf8')).trim())).toBe(daemon.apiPort);
      expect(JSON.parse(await readFile(join(daemon.home, 'config.json'), 'utf8'))).toMatchObject({ apiPort: 0, listenPort: 0 });
    }
    const stopped = daemons[0];
    await stopLiveDaemon(stopped);
    expect(stopped.child.exitCode !== null || stopped.child.signalCode !== null).toBe(true);
    await expect(fetch(`${stopped.base}/api/status`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    daemons.shift();
    expect((await getJson(daemons[0], '/api/status')).status).toBe(200);
    expect(foreign.listening).toBe(true);
  } finally {
    await Promise.all(daemons.map(stopLiveDaemon));
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
}, 90_000);

it('admits a background request from the first moment under the suite-chain request budget', async () => {
  // The start-up delay is drawn at random; take the largest draw, so the
  // answer does not depend on the one a daemon happens to get.
  const governor = new RpcRequestGovernor(LIVE_DAEMON_RPC_REQUEST_BUDGET, {
    clock: {
      now: () => 0,
      random: () => 1 - Number.EPSILON,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  expect(governor.snapshot().startupDelayRemainingMs).toBe(0);
  await expect(governor.acquireImmediately('background')).resolves.toBeUndefined();
  expect(governor.snapshot()).toMatchObject({ backgroundAdmitted: 1, rejected: 0 });
});
