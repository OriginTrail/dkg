import type { ChainEventLogState } from '@origintrail-official/dkg-chain/internal/chain-index-worker';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeAssetReadModelFactoryOptions,
} from '@origintrail-official/dkg-chain';
import {
  ChainIndexReadWorker,
  type ChainIndexReadWorkerOptions,
} from '../src/daemon/worker/chain-index-read-worker.js';
import type {
  ChainIndexReadMessage,
  ChainIndexReadRequest,
  ChainIndexReadResponse,
} from '../src/daemon/worker/chain-index-read-worker-protocol.js';

const NOW = 1_700_000_000_000;
const MODEL: KnowledgeAssetReadModelFactoryOptions = {
  scope: 'evm:31337:hub:storage',
  contextGraphStorageAddress: `0x${'12'.repeat(20)}`,
  contextGraphStorageAbi: '[]',
  maxHeadAgeMs: 100,
};
const BINDING = { kind: 'bound' as const, contextGraphId: 7n, asOfBlockNumber: 100 };

function state(): ChainEventLogState {
  return {
    cursor: {
      revision: 1,
      lineage: 'lineage-1',
      deploymentBlockNumber: 1,
      settledBlockNumber: 100,
      settledBlockHash: 'settled-hash',
      head: { number: 105, hash: 'head-hash', timestampSeconds: NOW / 1_000, fetchedAtMs: Date.now() },
      topicSetVersion: 'topics-1',
    },
    coverage: [],
  };
}

class FakeWorker extends EventEmitter {
  constructor(private readonly autoReady = true) { super(); }

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    super.on(eventName, listener);
    if (eventName === 'message' && this.autoReady) listener({ type: 'ready' });
    return this;
  }

  readonly messages: ChainIndexReadMessage[] = [];
  readonly postMessage = vi.fn((message: ChainIndexReadMessage) => { this.messages.push(message); });
  readonly ref = vi.fn(() => this);
  readonly unref = vi.fn(() => this);
  readonly terminate = vi.fn(async () => 0);

  get reads(): ChainIndexReadRequest[] {
    return this.messages.filter((message): message is ChainIndexReadRequest => message.type === 'read');
  }

  ready(): void {
    this.emit('message', { type: 'ready' });
  }

  reply(request: ChainIndexReadRequest, patch: Partial<ChainIndexReadResponse> = {}): void {
    const common = {
      id: request.id, reason: 'served' as const, rowsRead: 1, readMs: 1, decodeMs: 1,
      fence: { revision: 1, lineage: 'lineage-1', topicSetVersion: 'topics-1' },
    };
    const response: ChainIndexReadResponse = request.method === 'binding'
      ? { ...common, method: 'binding', result: BINDING }
      : request.method === 'ordinal'
        ? { ...common, method: 'ordinal', result: { kaId: 42n, asOfBlockNumber: 100 } }
        : { ...common, method: 'list', result: { contextGraphId: request.key, kaIds: [42n], throughBlockNumber: 100 } };
    // Patches also exercise deliberately malformed messages at the IPC boundary.
    this.emit('message', { ...response, ...patch });
  }
}

describe('chain-index read worker client', () => {
  const clients: ChainIndexReadWorker[] = [];

  beforeEach(() => {
    // Leave microtasks real: dispatch follows settled jobs through queueMicrotask.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fixture(options: ChainIndexReadWorkerOptions = {}, autoReady = true) {
    const workers: FakeWorker[] = [];
    const load = vi.fn<() => Promise<ChainEventLogState | undefined>>(async () => state());
    const workerFactory = vi.fn(() => {
      const worker = new FakeWorker(autoReady);
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const onDiagnostic = vi.fn();
    const client = new ChainIndexReadWorker('/unused/node-ui.db', { load }, {
      timeoutMs: 1_000, maxPending: 3, maxInFlight: 1,
      workerFactory, onDiagnostic, ...options,
    });
    clients.push(client);
    return {
      client, model: client.createReadModel(MODEL), load, workers, workerFactory, onDiagnostic,
      worker: () => workers[workers.length - 1]!,
    };
  }

  it('coalesces equivalent reads while cancelling only the waiter that aborted', async () => {
    const f = fixture();
    const controller = new AbortController();
    const first = f.model.readContextGraphForKa(42n, { view: 'latest', signal: controller.signal });
    const second = f.model.readContextGraphForKa(42n, { view: 'latest' });
    const firstRejected = expect(first).rejects.toThrow('caller stopped');
    expect(f.worker().reads).toHaveLength(1);
    expect(f.worker().reads[0]!.options).not.toHaveProperty('signal');
    controller.abort(new Error('caller stopped'));
    await firstRejected;
    expect(f.worker().messages.filter((message) => message.type === 'cancel')).toEqual([]);

    f.worker().reply(f.worker().reads[0]!);
    await expect(second).resolves.toEqual(BINDING);
    expect(f.load).toHaveBeenCalledExactlyOnceWith(MODEL.scope);
    expect(f.onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it('lets a cold read expire while the worker warms, then serves a later read after readiness', async () => {
    const f = fixture({}, false);
    const first = f.model.readContextGraphForKa(42n);
    const worker = f.worker();
    expect(worker.reads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBeUndefined();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.messages).toEqual([]);
    worker.ready();
    const next = f.model.readContextGraphForKa(43n);
    expect(f.workerFactory).toHaveBeenCalledOnce();
    expect(worker.reads.map((request) => request.key)).toEqual([43n]);
    worker.reply(worker.reads[0]!);
    await expect(next).resolves.toEqual(BINDING);
    await vi.advanceTimersByTimeAsync(9_001);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(f.onDiagnostic.mock.calls.map(([event]) => event.reason)).toEqual(['timeout', 'served']);
  });

  it('terminates a worker that never becomes ready and observes the restart cooldown', async () => {
    const f = fixture({}, false);
    const first = f.model.readContextGraphForKa(42n);
    const oldWorker = f.worker();
    await vi.advanceTimersByTimeAsync(9_999);
    await expect(first).resolves.toBeUndefined();
    expect(oldWorker.reads).toHaveLength(0);
    expect(oldWorker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();
    oldWorker.ready();
    await vi.advanceTimersByTimeAsync(1_001);
    const recovered = f.model.readContextGraphForKa(44n);
    expect(f.workerFactory).toHaveBeenCalledTimes(2);
    expect(f.worker().reads).toHaveLength(0);
    f.worker().ready();
    f.worker().reply(f.worker().reads[0]!);
    await expect(recovered).resolves.toEqual(BINDING);
  });

  it('cancels abandoned work and holds its slot until the worker acknowledges completion', async () => {
    const f = fixture();
    const a = new AbortController();
    const b = new AbortController();
    const first = f.model.readContextGraphForKa(42n, { signal: a.signal });
    const second = f.model.readContextGraphForKa(42n, { signal: b.signal });
    const rejectionA = expect(first).rejects.toThrow('a');
    const rejectionB = expect(second).rejects.toThrow('b');
    const queued = f.model.readContextGraphForKa(43n);
    const activeRequest = f.worker().reads[0]!;
    a.abort(new Error('a'));
    b.abort(new Error('b'));
    await Promise.all([rejectionA, rejectionB]);
    expect(f.worker().messages.filter((message) => message.type === 'cancel'))
      .toEqual([{ type: 'cancel', id: activeRequest.id }]);
    expect(f.worker().reads.map((request) => request.key)).toEqual([42n]);
    f.worker().reply(activeRequest, { result: undefined, reason: 'timeout' });
    await Promise.resolve();
    expect(f.worker().reads.map((request) => request.key)).toEqual([42n, 43n]);
    f.worker().reply(f.worker().reads[1]!);
    await expect(queued).resolves.toEqual(BINDING);
  });

  it('removes cancelled queued work without sending it to the worker', async () => {
    const f = fixture();
    const active = f.model.readContextGraphForKa(42n);
    const controller = new AbortController();
    const queued = f.model.readContextGraphForKa(43n, { signal: controller.signal });
    const rejected = expect(queued).rejects.toThrow('queued caller stopped');
    controller.abort(new Error('queued caller stopped'));
    await rejected;
    f.worker().reply(f.worker().reads[0]!);
    await active;
    expect(f.worker().reads.map((request) => request.key)).toEqual([42n]);
    expect(f.worker().messages.some((message) => message.type === 'cancel')).toBe(false);
  });

  it('retains a detached physical read in admission accounting until its reply', async () => {
    const f = fixture({ maxPending: 1 });
    const controller = new AbortController();
    const first = f.model.readContextGraphForKa(42n, { signal: controller.signal });
    const rejected = expect(first).rejects.toThrow('detached');
    const request = f.worker().reads[0]!;
    controller.abort(new Error('detached'));
    await rejected;
    // Neither the same key nor a different key can reclaim a physically busy
    // record's bounded capacity just because its observers have gone away.
    await expect(f.model.readContextGraphForKa(42n)).resolves.toBeUndefined();
    await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
    expect(f.worker().reads).toHaveLength(1);
    f.worker().reply(request, { result: undefined, reason: 'timeout' });
    const next = f.model.readContextGraphForKa(42n);
    expect(f.worker().reads[1]!.id).not.toBe(request.id);
    f.worker().reply(f.worker().reads[1]!);
    await expect(next).resolves.toEqual(BINDING);
  });

  it('rejects an already-aborted caller without starting a worker', async () => {
    const f = fixture();
    const signal = AbortSignal.abort(new Error('already stopped'));
    await expect(f.model.readContextGraphForKa(42n, { signal })).rejects.toThrow('already stopped');
    expect(f.workerFactory).not.toHaveBeenCalled();
  });

  it('bounds pending jobs and dispatches queued point reads before queued ordinal folds', async () => {
    const f = fixture();
    const active = f.model.readContextGraphForKa(42n);
    const ordinal = f.model.readContextGraphKaAt!(7n, 0n);
    const point = f.model.readContextGraphForKa(43n);
    await expect(f.model.readContextGraphForKa(44n)).resolves.toBeUndefined();
    expect(f.worker().reads).toHaveLength(1);
    f.worker().reply(f.worker().reads[0]!);
    await active;
    expect(f.worker().reads[1]).toMatchObject({ method: 'binding', key: 43n });
    f.worker().reply(f.worker().reads[1]!);
    await point;
    expect(f.worker().reads[2]).toMatchObject({ method: 'ordinal', key: 7n, index: 0n });
    f.worker().reply(f.worker().reads[2]!, { result: { kaId: 42n, asOfBlockNumber: 100 } });
    await expect(ordinal).resolves.toEqual({ kaId: 42n, asOfBlockNumber: 100 });
  });

  it('bounds coalesced callers as well as distinct jobs', async () => {
    const f = fixture({ maxPending: 2 });
    const first = f.model.readContextGraphForKa(42n);
    const second = f.model.readContextGraphForKa(42n);
    await expect(f.model.readContextGraphForKa(42n)).resolves.toBeUndefined();
    expect(f.worker().reads).toHaveLength(1);
    f.worker().reply(f.worker().reads[0]!);
    await expect(Promise.all([first, second])).resolves.toEqual([BINDING, BINDING]);
  });

  it('keeps queued binding and own-write inputs independent of caller mutation', async () => {
    const f = fixture();
    const active = f.model.readContextGraphForKa(42n);
    const mutableModel = { ...MODEL };
    const ownWrite = { blockNumber: 50, blockHash: 'own-write-hash' };
    const model = f.client.createReadModel(mutableModel);
    const queued = model.readContextGraphForKa(43n, { ownWrite });
    mutableModel.contextGraphStorageAddress = `0x${'34'.repeat(20)}`;
    ownWrite.blockHash = 'different-fork';
    f.worker().reply(f.worker().reads[0]!);
    await active;
    expect(f.worker().reads[1]!.model.contextGraphStorageAddress).toBe(MODEL.contextGraphStorageAddress);
    expect(f.worker().reads[1]!.options.ownWrite).toEqual({ blockNumber: 50, blockHash: 'own-write-hash' });
    f.worker().reply(f.worker().reads[1]!);
    await expect(queued).resolves.toEqual(BINDING);
  });

  it('does not coalesce distinct views, own-write barriers, or binding generations', async () => {
    const f = fixture({ maxPending: 8, maxInFlight: 8 });
    const nextModel = f.client.createReadModel(MODEL);
    const reads = [
      f.model.readContextGraphForKa(42n),
      f.model.readContextGraphForKa(42n, { view: 'latest' }),
      f.model.readContextGraphForKa(42n, { ownWrite: { blockNumber: 50, blockHash: 'first' } }),
      f.model.readContextGraphForKa(42n, { ownWrite: { blockNumber: 50, blockHash: 'second' } }),
      nextModel.readContextGraphForKa(42n),
    ];
    expect(f.worker().reads).toHaveLength(5);
    for (const request of f.worker().reads) f.worker().reply(request);
    await expect(Promise.all(reads)).resolves.toEqual(Array(5).fill(BINDING));
  });

  it('recycles a timed-out worker and ignores its late reply after a retry', async () => {
    const f = fixture();
    const first = f.model.readContextGraphForKa(42n);
    const oldWorker = f.worker();
    const oldRequest = oldWorker.reads[0]!;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBeUndefined();
    expect(oldWorker.messages).toContainEqual({ type: 'cancel', id: oldRequest.id });
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    await expect(f.model.readContextGraphForKa(42n)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_001);
    const retry = f.model.readContextGraphForKa(42n);
    expect(f.workerFactory).toHaveBeenCalledTimes(2);
    const newRequest = f.worker().reads[0]!;
    expect(newRequest.id).not.toBe(oldRequest.id);
    oldWorker.reply(oldRequest);
    expect(f.load).not.toHaveBeenCalled();
    f.worker().reply(newRequest);
    await expect(retry).resolves.toEqual(BINDING);
    expect(f.onDiagnostic.mock.calls.map(([event]) => event.reason)).toEqual(['timeout', 'served']);
  });

  it('terminates a worker that ignores cancellation, blocks replacement, and awaits retirement on close', async () => {
    const f = fixture();
    const controller = new AbortController();
    const read = f.model.readContextGraphForKa(42n, { signal: controller.signal });
    const worker = f.worker();
    let release!: (code: number) => void;
    const termination = new Promise<number>((resolve) => { release = resolve; });
    worker.terminate.mockReturnValueOnce(termination);
    const rejected = expect(read).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();
    const closed = vi.fn();
    const closing = f.client.close().then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    release(0);
    await closing;
    expect(closed).toHaveBeenCalledOnce();
  });

  it('fails pending work on a worker crash and restarts after the cooldown', async () => {
    const f = fixture();
    const active = f.model.readContextGraphForKa(42n);
    const queued = f.model.readContextGraphForKa(43n);
    const oldWorker = f.worker();
    oldWorker.emit('error', new Error('worker crashed'));
    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined]);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    await expect(f.model.readContextGraphForKa(44n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_001);
    const recovered = f.model.readContextGraphForKa(42n);
    expect(f.workerFactory).toHaveBeenCalledTimes(2);
    oldWorker.emit('exit', 1);
    expect(f.worker().terminate).not.toHaveBeenCalled();
    f.worker().reply(f.worker().reads[0]!);
    await expect(recovered).resolves.toEqual(BINDING);
  });

  it('retires a worker after an IPC dispatch failure, settles pending callers, and recovers after cooldown', async () => {
    const f = fixture({}, false);
    const first = f.model.readContextGraphForKa(42n);
    const queued = f.model.readContextGraphForKa(43n);
    const oldWorker = f.worker();
    oldWorker.postMessage.mockImplementationOnce(() => { throw new Error('IPC channel closed'); });
    oldWorker.ready();

    await expect(Promise.all([first, queued])).resolves.toEqual([undefined, undefined]);
    expect(oldWorker.reads).toEqual([]);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.onDiagnostic.mock.calls.map(([event]) => event.reason))
      .toEqual(['worker-unavailable', 'worker-unavailable']);
    await expect(f.model.readContextGraphForKa(44n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_001);
    const recovered = f.model.readContextGraphForKa(42n);
    expect(f.workerFactory).toHaveBeenCalledTimes(2);
    f.worker().ready();
    f.worker().reply(f.worker().reads[0]!);
    await expect(recovered).resolves.toEqual(BINDING);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
  });

  it('ignores forged queued replies and duplicate replies while validating a completed read', async () => {
    const f = fixture();
    let release!: (value: ChainEventLogState) => void;
    f.load.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const firstSettled = vi.fn();
    const queuedSettled = vi.fn();
    const first = f.model.readContextGraphForKa(42n).then(firstSettled);
    const queued = f.model.readContextGraphForKa(43n).then(queuedSettled);
    const activeRequest = f.worker().reads[0]!;

    // This id exists locally, but its read has never been dispatched. An IPC
    // reply cannot bypass admission or turn unperformed work into an answer.
    f.worker().reply(activeRequest, { id: activeRequest.id + 1 });
    await Promise.resolve();
    expect(f.worker().reads).toHaveLength(1);
    expect(f.load).not.toHaveBeenCalled();
    expect(queuedSettled).not.toHaveBeenCalled();

    f.worker().reply(activeRequest);
    expect(f.load).toHaveBeenCalledOnce();
    // The real reply is waiting on its cursor fence. A duplicate miss must
    // neither finish that caller early nor replace the pending valid result.
    f.worker().reply(activeRequest, { result: undefined, fence: undefined });
    await Promise.resolve();
    expect(firstSettled).not.toHaveBeenCalled();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.worker().reads.map((request) => request.key)).toEqual([42n, 43n]);
    const nextBinding = { ...BINDING, contextGraphId: 8n };
    f.worker().reply(f.worker().reads[1]!, { result: nextBinding });
    await queued;
    expect(queuedSettled).toHaveBeenCalledExactlyOnceWith(nextBinding);
    release(state());
    await first;
    expect(firstSettled).toHaveBeenCalledExactlyOnceWith(BINDING);
    expect(f.onDiagnostic).toHaveBeenCalledTimes(2);
  });

  it('refuses reads while worker construction fails and can retry after cooldown', async () => {
    const f = fixture();
    f.workerFactory.mockImplementationOnce(() => { throw new Error('cannot start thread'); });
    await expect(f.model.readContextGraphForKa(42n)).resolves.toBeUndefined();
    await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_001);
    const recovered = f.model.readContextGraphForKa(42n);
    f.worker().reply(f.worker().reads[0]!);
    await expect(recovered).resolves.toEqual(BINDING);
  });

  it.each(['unref', 'on'] as const)('retires a constructed worker when %s setup throws', async (method) => {
    const worker = new FakeWorker();
    vi.spyOn(worker, method).mockImplementationOnce(() => { throw new Error('setup failed'); });
    let release!: (code: number) => void;
    worker.terminate.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const factory = vi.fn(() => worker as unknown as Worker);
    const f = fixture({ workerFactory: factory });
    try {
      await expect(f.model.readContextGraphForKa(42n)).resolves.toBeUndefined();
      expect(worker.terminate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(11_000);
      // The startup timer is gone; retirement, rather than elapsed cooldown,
      // prevents a replacement while this physical thread is still exiting.
      await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
      expect(factory).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      release(0);
      await f.client.close();
    }
  });

  it.each(['throws', 'rejects'] as const)('keeps failed retirement unavailable when terminate %s', async (mode) => {
    const f = fixture();
    const read = f.model.readContextGraphForKa(42n);
    const worker = f.worker();
    const error = new Error('termination failed');
    if (mode === 'throws') worker.terminate.mockImplementationOnce(() => { throw error; });
    else worker.terminate.mockRejectedValueOnce(error);
    worker.emit('error', new Error('worker failed'));
    await expect(read).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();
    await expect(f.client.close()).rejects.toThrow('termination failed');
    await expect(f.client.close()).rejects.toThrow('termination failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
    // This fake allocated no thread. Its deliberately failed close has been
    // asserted already; ordinary fixtures must still fail on teardown errors.
    clients.splice(clients.indexOf(f.client), 1);
  });

  it.each([
    ['advanced revision', () => ({ ...state(), cursor: { ...state().cursor, revision: 2 } })],
    ['replaced lineage', () => ({ ...state(), cursor: { ...state().cursor, lineage: 'lineage-2' } })],
    ['changed topics', () => ({ ...state(), cursor: { ...state().cursor, topicSetVersion: 'topics-2' } })],
    ['tombstoned scope', () => undefined],
    ['suspected fork', () => ({ ...state(), suspectedForkBlockNumber: 99 })],
    ['stale head', () => ({ ...state(), cursor: {
      ...state().cursor, head: { ...state().cursor.head, fetchedAtMs: NOW - MODEL.maxHeadAgeMs - 1 },
    } })],
    ['future head', () => ({ ...state(), cursor: {
      ...state().cursor, head: { ...state().cursor.head, fetchedAtMs: NOW + 1 },
    } })],
  ] as const)('refuses a worker answer after %s', async (_label, loadState) => {
    const f = fixture();
    const read = f.model.readContextGraphForKa(42n);
    f.load.mockResolvedValue(loadState());
    f.worker().reply(f.worker().reads[0]!);
    await expect(read).resolves.toBeUndefined();
    expect(f.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: 'retired-revision' }));
  });

  it('refuses an unfenced result and a failed cursor validation read', async () => {
    const f = fixture();
    const unfenced = f.model.readContextGraphForKa(42n);
    f.worker().reply(f.worker().reads[0]!, { fence: undefined });
    await expect(unfenced).resolves.toBeUndefined();
    f.load.mockRejectedValue(new Error('store closed'));
    const unavailable = f.model.readContextGraphForKa(42n);
    f.worker().reply(f.worker().reads[1]!);
    await expect(unavailable).resolves.toBeUndefined();
    expect(f.onDiagnostic.mock.calls.map(([event]) => event.reason))
      .toEqual(['retired-revision', 'store-unavailable']);
  });

  it('refuses a served reply for another operation before reading the cursor', async () => {
    const f = fixture();
    const binding = f.model.readContextGraphForKa(42n);
    const response: ChainIndexReadResponse = {
      id: f.worker().reads[0]!.id, method: 'ordinal', reason: 'served',
      result: { kaId: 42n, asOfBlockNumber: 100 },
      fence: { revision: 1, lineage: 'lineage-1', topicSetVersion: 'topics-1' },
      rowsRead: 1, readMs: 1, decodeMs: 1,
    };
    f.worker().emit('message', response);
    await expect(binding).resolves.toBeUndefined();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: 'invalid-response' }));
    const list = f.model.readContextGraphKaList(7n);
    f.worker().reply(f.worker().reads[1]!);
    await expect(list).resolves.toEqual({ contextGraphId: 7n, kaIds: [42n], throughBlockNumber: 100 });
  });

  it('refuses a delivered result after its deadline even before the timer callback runs', async () => {
    const f = fixture();
    const read = f.model.readContextGraphForKa(42n);
    vi.setSystemTime(NOW + 1_000);
    f.worker().reply(f.worker().reads[0]!);
    await expect(read).resolves.toBeUndefined();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout' }));
  });

  it('checks the deadline again after an asynchronous cursor validation read', async () => {
    const f = fixture();
    let release!: (value: ChainEventLogState) => void;
    f.load.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const read = f.model.readContextGraphForKa(42n);
    f.worker().reply(f.worker().reads[0]!);
    expect(f.load).toHaveBeenCalledOnce();
    vi.setSystemTime(NOW + 1_000);
    release(state());
    await expect(read).resolves.toBeUndefined();
    expect(f.onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: 'timeout' }));
  });

  it('keeps the caller deadline while cursor validation is stalled', async () => {
    const f = fixture();
    f.load.mockReturnValue(new Promise(() => {}));
    let result: unknown = 'pending';
    void f.model.readContextGraphForKa(42n).then((value) => { result = value; });
    f.worker().reply(f.worker().reads[0]!);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toBeUndefined();
    // The physical worker completed; only validation was stuck.
    expect(f.worker().terminate).not.toHaveBeenCalled();
  });

  it('reuses physical capacity while a completed response awaits cursor validation', async () => {
    const f = fixture();
    let release!: (value: ChainEventLogState) => void;
    f.load.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = f.model.readContextGraphForKa(42n);
    f.worker().reply(f.worker().reads[0]!);
    const second = f.model.readContextGraphForKa(43n);
    expect(f.worker().reads.map((request) => request.key)).toEqual([42n, 43n]);
    f.worker().reply(f.worker().reads[1]!);
    await expect(second).resolves.toEqual(BINDING);
    release(state());
    await expect(first).resolves.toEqual(BINDING);
  });

  it('shares close completion while retirement ignores late ready and response events', async () => {
    const f = fixture();
    const read = f.model.readContextGraphForKa(42n);
    const worker = f.worker();
    let release!: (code: number) => void;
    worker.terminate.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = f.client.close();
    const second = f.client.close();
    expect(first).toBe(second);
    await expect(read).resolves.toBeUndefined();
    const closed = vi.fn();
    void first.then(closed);
    worker.ready();
    worker.reply(worker.reads[0]!);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(f.load).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(f.model.readContextGraphForKa(43n)).resolves.toBeUndefined();
    release(0);
    await Promise.all([first, second]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('settles active and queued callers on close and never restarts afterwards', async () => {
    const f = fixture();
    const active = f.model.readContextGraphForKa(42n);
    const queued = f.model.readContextGraphForKa(43n);
    const worker = f.worker();
    await f.client.close();
    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.reply(worker.reads[0]!);
    await expect(f.model.readContextGraphForKa(44n)).resolves.toBeUndefined();
    expect(f.workerFactory).toHaveBeenCalledOnce();
    expect(f.load).not.toHaveBeenCalled();
  });
});
