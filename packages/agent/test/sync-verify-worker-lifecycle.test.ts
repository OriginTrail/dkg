import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';

const mocks = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
    constructor() { super(); mocks.workers.push(this); }
  } };
});
afterEach(() => { mocks.workers.splice(0); });
const calls = (worker: SyncVerifyWorker) => [
  worker.verify([], [], false), worker.parseAndFilter('', 'urn:g', 'test'),
  worker.processSharedMemory([], []), worker.processDurableBatch([], [], false),
  worker.processSharedMemoryBatch([], [], 'test'),
];

describe('verification worker lifecycle', () => {
  it.each(['error', 'exit', 'close'] as const)('rejects pending and subsequent operations after %s with one retained reason', async event => {
    const worker = new SyncVerifyWorker(), native = mocks.workers.at(-1);
    const expected = new Error(event === 'error' ? 'worker failed'
      : event === 'exit' ? 'Sync verification worker exited (7)' : 'Sync verification worker closed');
    const pending = Promise.allSettled(calls(worker));
    if (event === 'error') native.emit('error', expected);
    else if (event === 'exit') native.emit('exit', 7);
    else await worker.close();
    const outcomes = await pending;
    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 'rejected', reason: expected });
    const reason = (outcomes[0] as PromiseRejectedResult).reason;
    native.emit('exit', 0);
    await Promise.all([worker.close(), worker.close()]);
    for (const outcome of await Promise.allSettled(calls(worker))) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBe(reason);
    }
    expect(native.terminate).toHaveBeenCalledTimes(1);
    expect(native.postMessage).toHaveBeenCalledTimes(5);
  });

  it('retains durable array membership and returns original quad references', async () => {
    const worker = new SyncVerifyWorker(), native = mocks.workers.at(-1);
    const a: Quad = { subject: 'urn:a', predicate: 'urn:p', object: '"a"', graph: 'urn:g' };
    const b: Quad = { ...a, subject: 'urn:b' }, meta = { ...a, graph: 'urn:meta' };
    const data = [a, b], metadata = [meta];
    const pending = worker.processDurableBatch(data, metadata, false);
    data.reverse(); metadata.splice(0);
    const message = native.postMessage.mock.calls[0][0];
    expect(message.args.slice(0, 2)).toEqual([[a, b], [meta]]);
    native.emit('message', { id: message.id, result: { verifiedDataIndexes: [1], verifiedMetaIndexes: [0] } });
    const result = await pending;
    expect(result.verifiedData[0]).toBe(b); expect(result.verifiedMeta[0]).toBe(meta);
    await worker.close();
  });

  it('rejects a dispatch error without retaining its request or poisoning later operations', async () => {
    const worker = new SyncVerifyWorker(), native = mocks.workers.at(-1);
    const error = new Error('structured clone failed');
    native.postMessage.mockImplementationOnce(() => { throw error; });
    await expect(worker.verify([], [], false)).rejects.toBe(error);
    const pending = worker.parseAndFilter('', 'urn:g', 'test');
    const message = native.postMessage.mock.calls[1][0];
    const result = { quads: [], totalQuads: 0 };
    native.emit('message', { id: message.id, result });
    await expect(pending).resolves.toBe(result);
    await worker.close();
  });
});
