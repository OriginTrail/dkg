import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import type { DKGNode } from '../src/node.js';
import type { Network } from '../src/network/network.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import { BulkGraphSession, bulkGraphTransportOptions, exchangeBulkGraph } from '../src/bulk-graph-transport.js';
import { BULK_GRAPH_KIND as K, encodeBulkGraphFrame } from '../src/bulk-graph-wire.js';

const PEER = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const frame = { kind: K.DATA, index: 0, sequence: 0, payload: new Uint8Array([1]) };

/** Controlled stream with the real frame decoder and router deadline ownership. */
class ControlledStream extends EventTarget {
  status = 'open'; writableNeedsDrain = false;
  maxReadBufferLength = 0; maxWriteBufferLength = 0;
  pending?: { resolve: (item: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void };
  failure?: Error;
  send = vi.fn(() => true);
  close = vi.fn(async () => { this.status = 'closed'; });
  returned = vi.fn();
  abort = vi.fn((error: Error) => {
    this.status = 'closed'; this.failure = error;
    this.pending?.reject(error); this.pending = undefined;
  });
  deliver() {
    if (!this.pending) throw new Error('Expected a pending stream read');
    this.pending.resolve({ done: false, value: encodeBulkGraphFrame(frame) });
    this.pending = undefined;
  }
  async *[Symbol.asyncIterator]() {
    try {
      while (true) {
        if (this.failure) throw this.failure;
        const item = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => { this.pending = { resolve, reject }; });
        if (item.done) return;
        yield item.value;
      }
    } finally { this.returned(); }
  }
}
function fixture() {
  vi.useFakeTimers();
  const stream = new ControlledStream();
  const dialProtocol = vi.fn(async () => stream as unknown as Stream);
  const node = { stopSignal: new AbortController().signal,
    libp2p: { getConnections: () => [], peerStore: { get: async () => ({ addresses: [] }) } },
  } as unknown as DKGNode;
  const router = new ProtocolRouter(node, { network: { dialProtocol } as unknown as Network });
  const session = new BulkGraphSession(stream as unknown as Stream, new AbortController().signal);
  return { stream, router, session, dialProtocol };
}
afterEach(() => vi.useRealTimers());

describe('bulk graph read-idle and original total deadlines', () => {
  it('aborts and settles an idle pending read at 120 seconds and disposes its iterator', async () => {
    const { stream, session } = fixture();
    const pending = expect(session.next()).rejects.toThrow('Bulk graph idle deadline exceeded');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(stream.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await session.dispose();
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.pending).toBeUndefined();
    expect(stream.returned).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a fresh idle allowance after a successful read', async () => {
    const { stream, session } = fixture();
    const first = session.next();
    await vi.advanceTimersByTimeAsync(60_000);
    stream.deliver();
    await expect(first).resolves.toEqual(frame);
    const pending = expect(session.next()).rejects.toThrow('Bulk graph idle deadline exceeded');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(stream.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await session.dispose();
    expect(stream.returned).toHaveBeenCalledOnce();
  });

  it('keeps an exchange active beyond 120 seconds while frames arrive, then closes and disposes it', async () => {
    const { stream, router, dialProtocol } = fixture();
    const result = exchangeBulkGraph(router, PEER, new Uint8Array([1]), bulkGraphTransportOptions(300_000), async session => {
      const received = [];
      for (let n = 0; n < 3; n++) received.push(await session.next());
      return received;
    });
    for (let n = 0; n < 3; n++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stream.abort).not.toHaveBeenCalled();
      stream.deliver();
    }
    await expect(result).resolves.toEqual([frame, frame, frame]);
    expect(dialProtocol).toHaveBeenCalledOnce();
    expect(stream.send).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
    expect(stream.returned).toHaveBeenCalledOnce();
    expect(stream.abort).not.toHaveBeenCalled();
  });

  it('does not let incoming frames extend the original total exchange deadline', async () => {
    const { stream, router, dialProtocol } = fixture();
    const result = exchangeBulkGraph(router, PEER, new Uint8Array([1]), bulkGraphTransportOptions(180_000), async session => {
      for (let n = 0; n < 3; n++) await session.next();
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    for (let n = 0; n < 2; n++) {
      await vi.advanceTimersByTimeAsync(60_000);
      stream.deliver();
    }
    await vi.advanceTimersByTimeAsync(59_999);
    expect(stream.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(dialProtocol).toHaveBeenCalledOnce();
    expect(stream.send).toHaveBeenCalledOnce();
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream.returned).toHaveBeenCalledOnce();
    expect(stream.pending).toBeUndefined();
  });
});
