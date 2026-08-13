import { getEventListeners } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OwnedManagedHttpClient } from '../src/adapters/managed-http-client.js';
import { isStoreResponseTooLargeErrorV1 } from '../src/http-response-limit.js';

/**
 * A local server with one deliberately slow route, so a second request must
 * queue behind it on the client's single-socket pool.
 */
let server: Server;
let base: string;
let requestCount = 0;
let overflowTailStarted = false;
let overflowClosedBeforeTail = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    requestCount += 1;
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow');
      }, 1_500);
      return;
    }
    if (req.url === '/exact-boundary') {
      res.writeHead(200);
      res.end('€x'); // Four UTF-8 bytes, two JavaScript code units.
      return;
    }
    if (req.url === '/chunked-overflow') {
      overflowTailStarted = false;
      overflowClosedBeforeTail = false;
      res.on('error', () => undefined);
      res.on('close', () => {
        if (!overflowTailStarted) overflowClosedBeforeTail = true;
      });
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write('1234');
      setTimeout(() => res.write('56'), 10);
      setTimeout(() => {
        overflowTailStarted = true;
        if (!res.destroyed) res.end('tail');
      }, 150);
      return;
    }
    if (req.url === '/chunked-exact') {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.write('12');
      res.write('34');
      res.end('5');
      return;
    }
    if (req.url === '/hang') {
      res.on('error', () => undefined);
      res.writeHead(200);
      res.write('x');
      return;
    }
    if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': '5', Connection: 'close' });
      res.end('abc');
      return;
    }
    if (req.url === '/declared-overflow') {
      res.writeHead(200, { 'Content-Length': '6' });
      res.end('123456');
      return;
    }
    if (req.url === '/legacy-large') {
      res.writeHead(200);
      res.end('x'.repeat(4 * 1024 * 1024 + 1));
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
  it('accepts request and response bodies at their exact UTF-8 byte limits', async () => {
    const client = new OwnedManagedHttpClient('bounded-exact');
    const capacities: number[] = [];
    try {
      await expect(
        client.post(`${base}/exact-boundary`, UPDATE, '€x', 5_000, undefined, {
          maxRequestBytes: 4,
          maxResponseBytes: 4,
          reserveResponseCapacity: (bytes) => capacities.push(bytes),
        }),
      ).resolves.toEqual({ status: 200, body: '€x' });
      expect(capacities).toEqual([4]);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('preserves the legacy unbounded response path when limits are omitted', async () => {
    const client = new OwnedManagedHttpClient('legacy-unbounded');
    try {
      const response = await client.post(`${base}/legacy-large`, UPDATE, 'x', 5_000);
      expect(Buffer.byteLength(response.body, 'utf8')).toBe(4 * 1024 * 1024 + 1);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('rejects a one-byte-over UTF-8 request before allocation or dispatch', async () => {
    const client = new OwnedManagedHttpClient('request-overflow');
    const countBefore = requestCount;
    try {
      await expect(
        client.post(`${base}/`, UPDATE, '€', 5_000, undefined, {
          maxRequestBytes: 2,
          maxResponseBytes: 16,
        }),
      ).rejects.toThrow(/request body is 3 bytes; maximum is 2 bytes/);
      expect(requestCount).toBe(countBefore);
      expect(client.openSocketCount).toBe(0);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('destroys a chunked response immediately when cumulative bytes cross the cap', async () => {
    const client = new OwnedManagedHttpClient('response-overflow');
    try {
      await expect(
        client.post(`${base}/chunked-overflow`, UPDATE, 'x', 5_000, undefined, {
          maxRequestBytes: 1,
          maxResponseBytes: 5,
        }),
      ).rejects.toThrow(/response body exceeded 5 bytes/);

      // The refusal must carry the CANONICAL code, not just a recognisable message.
      // Callers that degrade on an oversized response (the legacy agent-profile gate reads
      // report it as undecidable rather than failing their page) recognise this refusal by
      // code. Asserting only the message let the tag be deleted with every suite green:
      // the reader tests supply the code themselves, so they cannot witness this client
      // emitting it.
      const refusal = await client.post(`${base}/chunked-overflow`, UPDATE, 'x', 5_000, undefined, {
        maxRequestBytes: 1,
        maxResponseBytes: 5,
      }).then(() => null, (error: unknown) => error);
      expect(isStoreResponseTooLargeErrorV1(refusal)).toBe(true);

      await vi.waitFor(() => expect(overflowClosedBeforeTail).toBe(true));
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
    expect(client.openSocketCount).toBe(0);
  });

  it('accepts a chunked response exactly at the cap without concatenating body buffers', async () => {
    const client = new OwnedManagedHttpClient('chunked-exact');
    const concatSpy = vi.spyOn(Buffer, 'concat');
    try {
      await expect(
        client.post(`${base}/chunked-exact`, UPDATE, 'x', 5_000, undefined, {
          maxRequestBytes: 1,
          maxResponseBytes: 5,
        }),
      ).resolves.toEqual({ status: 200, body: '12345' });
      expect(concatSpy).not.toHaveBeenCalled();
    } finally {
      concatSpy.mockRestore();
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('charges actual chunked buffer growth instead of reserving the advertised ceiling', async () => {
    const client = new OwnedManagedHttpClient('chunked-incremental-capacity');
    const capacities: number[] = [];
    try {
      await expect(
        client.post(`${base}/chunked-exact`, UPDATE, 'x', 5_000, undefined, {
          maxRequestBytes: 1,
          maxResponseBytes: 4 * 1024 * 1024,
          reserveResponseCapacity: (bytes) => capacities.push(bytes),
        }),
      ).resolves.toEqual({ status: 200, body: '12345' });
      expect(capacities).toEqual([64 * 1024]);
      expect(capacities.at(-1)).toBeLessThan(4 * 1024 * 1024);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('rejects a truncated bounded response instead of settling a partial body', async () => {
    const client = new OwnedManagedHttpClient('truncated-response');
    try {
      await expect(
        client.post(`${base}/truncated`, UPDATE, 'x', 5_000, undefined, {
          maxRequestBytes: 1,
          maxResponseBytes: 5,
        }),
      ).rejects.toThrow(/response (aborted|closed) before completion/);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('rejects an oversized declared response before reserving response capacity', async () => {
    const client = new OwnedManagedHttpClient('declared-response-overflow');
    const reserveResponseCapacity = vi.fn();
    try {
      await expect(
        client.post(`${base}/declared-overflow`, UPDATE, 'x', 5_000, undefined, {
          maxRequestBytes: 1,
          maxResponseBytes: 5,
          reserveResponseCapacity,
        }),
      ).rejects.toThrow(/response body declares 6 bytes; maximum is 5 bytes/);
      expect(reserveResponseCapacity).not.toHaveBeenCalled();

      // The declared-length refusal carries the canonical code for the same reason the
      // chunked one does, and it matters MORE: an endpoint that sends Content-Length never
      // reaches the chunked check, so this is the path a real oversized answer takes.
      // Message-only assertions cannot tell a tagged refusal from an untagged one.
      const refusal = await client.post(`${base}/declared-overflow`, UPDATE, 'x', 5_000, undefined, {
        maxRequestBytes: 1,
        maxResponseBytes: 5,
      }).then(() => null, (error: unknown) => error);
      expect(isStoreResponseTooLargeErrorV1(refusal)).toBe(true);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
    expect(client.openSocketCount).toBe(0);
  });

  it('clears its deadline and abort listener after bounded success', async () => {
    const client = new OwnedManagedHttpClient('settlement-cleanup');
    const controller = new AbortController();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await client.post(`${base}/`, UPDATE, 'x', 4_321, controller.signal, {
        maxRequestBytes: 1,
        maxResponseBytes: 2,
      });

      const deadlineIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 4_321);
      expect(deadlineIndex).toBeGreaterThanOrEqual(0);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(
        setTimeoutSpy.mock.results[deadlineIndex]?.value,
      );
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      await client.destroyAndSettle().catch(() => undefined);
    }
    expect(client.openSocketCount).toBe(0);
  });

  it('clears its deadline when request construction throws synchronously', async () => {
    const client = new OwnedManagedHttpClient('construction-cleanup');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await expect(
        client.post('ftp://127.0.0.1/', UPDATE, 'x', 4_322, undefined, {
          maxRequestBytes: 1,
          maxResponseBytes: 2,
        }),
      ).rejects.toThrow(/Protocol|protocol/);

      const deadlineIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 4_322);
      expect(deadlineIndex).toBeGreaterThanOrEqual(0);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(
        setTimeoutSpy.mock.results[deadlineIndex]?.value,
      );
      expect(client.openSocketCount).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      await client.destroyAndSettle().catch(() => undefined);
    }
  });

  it('removes the abort listener and closes its socket after an in-flight abort', async () => {
    const client = new OwnedManagedHttpClient('abort-cleanup');
    const controller = new AbortController();
    try {
      const pending = client.post(`${base}/hang`, UPDATE, 'x', 5_000, controller.signal, {
        maxRequestBytes: 1,
        maxResponseBytes: 16,
      });
      await vi.waitFor(() =>
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1),
      );

      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      await client.destroyAndSettle().catch(() => undefined);
    }
    expect(client.openSocketCount).toBe(0);
  });

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
