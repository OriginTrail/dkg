import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OwnedManagedHttpClient } from '../src/adapters/managed-http-client.js';

/**
 * A local server with one deliberately slow route, so a second request must
 * queue behind it on the client's single-socket pool.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow');
      }, 1_500);
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const UPDATE = 'application/sparql-update; charset=utf-8';

describe('OwnedManagedHttpClient', () => {
  it('bounds the caller by wall clock, including time spent QUEUED for a socket', async () => {
    // Regression: `req.setTimeout()` bounds socket-ACTIVE time only. With
    // maxSockets:1 a queued request was not counted at all, so a call with a
    // 500 ms timeout RESOLVED SUCCESSFULLY after 3822 ms — failing silently by
    // succeeding, far outside the deadline the caller was promised. The lane
    // treats its apply timeout as a safety bound, so queue wait must count.
    const client = new OwnedManagedHttpClient('1');
    try {
      const slow = client.post(`${base}/slow`, UPDATE, 'x', 10_000).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));

      const started = Date.now();
      await expect(client.post(`${base}/`, UPDATE, 'x', 300)).rejects.toThrow(/exceeded 300ms/);
      const elapsed = Date.now() - started;

      // Generous upper bound: the point is that it does NOT wait for the slow
      // request (~1.4s remaining), not that the timer is precise.
      expect(elapsed).toBeLessThan(1_000);
      await slow;
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('settles rather than hanging when the signal is already aborted', async () => {
    // The early-abort branch returns before `req.end()`, so it must still reach
    // a rejection path; a hang here would strand the caller forever.
    const client = new OwnedManagedHttpClient('1');
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        client.post(`${base}/`, UPDATE, 'x', 5_000, controller.signal),
      ).rejects.toThrow(/aborted/);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('proves the pool is empty after destroy, not merely that destroy was called', async () => {
    // Agent.destroy() tears sockets down asynchronously; they leave the agent's
    // maps on their close event. Returning before that would let a replacement
    // child bind while a retired keep-alive socket is still open.
    const client = new OwnedManagedHttpClient('7');
    await client.post(`${base}/`, UPDATE, 'x', 5_000);
    expect(client.openSocketCount).toBeGreaterThan(0);

    await client.destroyAndSettle();
    expect(client.openSocketCount).toBe(0);
    expect(client.isDestroyed).toBe(true);
  });

  it('refuses to dispatch once destroyed, so a stale generation cannot reach a listener', async () => {
    const client = new OwnedManagedHttpClient('2');
    await client.destroyAndSettle();
    await expect(client.post(`${base}/`, UPDATE, 'x', 5_000)).rejects.toThrow(
      /generation 2 is destroyed/,
    );
  });

  it('reports the generation it is bound to', () => {
    expect(new OwnedManagedHttpClient('42').childGeneration).toBe('42');
  });
});
