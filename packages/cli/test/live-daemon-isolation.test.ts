import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startEmbeddingFixture } from './helpers/embedding-http-fixture.js';
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

it('embedding fixture accepts valid requests and closes without a hidden failure', async () => {
  const fixture = await startEmbeddingFixture();
  try {
    const response = await fetch(`${fixture.config.baseURL}/embeddings`, { method: 'POST',
      headers: { authorization: `Bearer ${fixture.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'hello', dimensions: 1536 }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { embedding: number[] }[] }).data[0].embedding).toHaveLength(1536);
    expect(fixture.inputs).toEqual(['hello']);
  } finally { await fixture.close(); }
});
for (const damage of ['method', 'authorization', 'route', 'input', 'dimensions']) {
  it(`embedding fixture reports ${damage} assertion failures even if its HTTP error is tolerated`, async () => {
    const fixture = await startEmbeddingFixture();
    try {
      const response = await fetch(`${fixture.config.baseURL}/${damage === 'route' ? 'wrong' : 'embeddings'}`, {
        method: damage === 'method' ? 'PUT' : 'POST',
        headers: { authorization: damage === 'authorization' ? 'Bearer wrong' : `Bearer ${fixture.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: damage === 'input' ? [] : 'hello', dimensions: damage === 'dimensions' ? 2 : 1536 }),
      });
      expect(response.status).toBe(500);
      await response.text();
    } finally {
      await expect(fixture.close()).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: 'ERR_ASSERTION' })],
      });
    }
  });
}
