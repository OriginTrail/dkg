// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ContractReadBatcher,
  type BatchableContractRead,
  type BatchedContractCall,
  type BatchedContractCallResult,
  type ContractReadBatchObservation,
} from '../src/contract-read-batcher.js';

const TARGET = `0x${'aa'.repeat(20)}`;
const OTHER_TARGET = `0x${'bb'.repeat(20)}`;

/** One macrotask: the batcher flushes on the turn after its reads were issued. */
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A read whose inner call returns its own call data, so each answer is traceable. */
function read(
  callData: string,
  overrides: Partial<BatchableContractRead<string>> = {},
): BatchableContractRead<string> & { direct: ReturnType<typeof vi.fn> } {
  const direct = vi.fn(async () => `direct:${callData}`);
  return {
    label: 'kas.getLatestMerkleRoot',
    target: TARGET,
    callData,
    decode: (returnData) => `batched:${returnData}`,
    direct,
    ...overrides,
  } as BatchableContractRead<string> & { direct: ReturnType<typeof vi.fn> };
}

/** An aggregate that echoes each call's data back as its return data. */
function echoAggregate() {
  const requests: BatchedContractCall[][] = [];
  const aggregate = vi.fn(async (calls: readonly BatchedContractCall[]) => {
    requests.push([...calls]);
    return calls.map(({ callData }): BatchedContractCallResult => ({
      success: true, returnData: callData,
    }));
  });
  return { aggregate, requests };
}

describe('ContractReadBatcher', () => {
  it('sends the reads of one turn in one request and answers each from its own inner call', async () => {
    const { aggregate, requests } = echoAggregate();
    const observations: ContractReadBatchObservation[] = [];
    const batcher = new ContractReadBatcher({ aggregate, observe: (o) => observations.push(o) });
    const onBatched = vi.fn();
    const first = read('0x01', { onBatched });
    const second = read('0x02', { target: OTHER_TARGET, label: 'cgStorage.kaToContextGraph' });

    const answers = await Promise.all([batcher.read(first), batcher.read(second)]);

    expect(answers).toEqual(['batched:0x01', 'batched:0x02']);
    expect(requests).toEqual([[
      { target: TARGET, callData: '0x01' },
      { target: OTHER_TARGET, callData: '0x02' },
    ]]);
    expect(first.direct).not.toHaveBeenCalled();
    expect(second.direct).not.toHaveBeenCalled();
    expect(onBatched).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([{
      outcome: 'served',
      calls: 2,
      readsByLabel: new Map([['kas.getLatestMerkleRoot', 1], ['cgStorage.kaToContextGraph', 1]]),
      directReads: 0,
    }]);
  });

  it('shares one inner call between identical reads', async () => {
    const { aggregate, requests } = echoAggregate();
    const observations: ContractReadBatchObservation[] = [];
    const batcher = new ContractReadBatcher({ aggregate, observe: (o) => observations.push(o) });

    const answers = await Promise.all([
      batcher.read(read('0x01')),
      batcher.read(read('0x01', { target: TARGET.toUpperCase().replace('0X', '0x') })),
      batcher.read(read('0x01', { target: OTHER_TARGET })),
    ]);

    expect(answers).toEqual(['batched:0x01', 'batched:0x01', 'batched:0x01']);
    expect(requests[0]).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      calls: 2, readsByLabel: new Map([['kas.getLatestMerkleRoot', 3]]),
    });
  });

  it('keeps one request out at a time and sends what arrived meanwhile in the next', async () => {
    const gates: Array<Deferred<void>> = [];
    const requests: string[][] = [];
    const batcher = new ContractReadBatcher({
      aggregate: async (calls) => {
        requests.push(calls.map(({ callData }) => callData));
        const gate = deferred<void>();
        gates.push(gate);
        await gate.promise;
        return calls.map(({ callData }) => ({ success: true, returnData: callData }));
      },
    });

    const first = batcher.read(read('0x01'));
    await turn();
    // The first request is out. Three more reads arrive over several turns.
    const later = [batcher.read(read('0x02'))];
    await turn();
    later.push(batcher.read(read('0x03')));
    await turn();
    later.push(batcher.read(read('0x04')));
    await turn();
    expect(requests).toEqual([['0x01']]);

    gates[0]!.resolve();
    await expect(first).resolves.toBe('batched:0x01');
    await turn();
    expect(requests).toEqual([['0x01'], ['0x02', '0x03', '0x04']]);
    gates[1]!.resolve();
    await expect(Promise.all(later)).resolves.toEqual(['batched:0x02', 'batched:0x03', 'batched:0x04']);
  });

  it('splits what is waiting at the per-request call bound', async () => {
    const { aggregate, requests } = echoAggregate();
    const batcher = new ContractReadBatcher({ aggregate, maxCallsPerRequest: 2 });

    const answers = await Promise.all(
      ['0x01', '0x02', '0x03', '0x04', '0x05'].map((callData) => batcher.read(read(callData))),
    );

    expect(answers).toHaveLength(5);
    expect(requests.map((calls) => calls.map(({ callData }) => callData)))
      .toEqual([['0x01', '0x02'], ['0x03', '0x04'], ['0x05']]);
    expect(() => new ContractReadBatcher({ aggregate, maxCallsPerRequest: 0 })).toThrow(RangeError);
  });

  it('lets the direct read answer an inner call that failed or does not decode', async () => {
    const observations: ContractReadBatchObservation[] = [];
    const batcher = new ContractReadBatcher({
      aggregate: async (calls) => calls.map(({ callData }) => ({
        success: callData !== '0x02', returnData: callData,
      })),
      observe: (o) => observations.push(o),
    });
    const reverted = read('0x02');
    reverted.direct.mockRejectedValueOnce(Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
    }));
    const undecodable = read('0x03', {
      decode: () => { throw Object.assign(new Error('could not decode'), { code: 'BAD_DATA' }); },
    });
    const fine = read('0x01');

    const settled = await Promise.allSettled([
      batcher.read(fine), batcher.read(reverted), batcher.read(undecodable),
    ]);

    expect(settled[0]).toEqual({ status: 'fulfilled', value: 'batched:0x01' });
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: { code: 'CALL_EXCEPTION' } });
    expect(settled[2]).toEqual({ status: 'fulfilled', value: 'direct:0x03' });
    expect(fine.direct).not.toHaveBeenCalled();
    expect(reverted.direct).toHaveBeenCalledTimes(1);
    expect(undecodable.direct).toHaveBeenCalledTimes(1);
    expect(observations[0]).toMatchObject({ outcome: 'served', calls: 3, directReads: 2 });
  });

  it('answers every read directly when the request fails or returns the wrong number of results', async () => {
    const observations: ContractReadBatchObservation[] = [];
    let attempt = 0;
    const batcher = new ContractReadBatcher({
      aggregate: async (calls) => {
        attempt += 1;
        if (attempt === 1) throw new Error('endpoint unavailable');
        return calls.slice(1).map(({ callData }) => ({ success: true, returnData: callData }));
      },
      observe: (o) => observations.push(o),
    });

    await expect(Promise.all([batcher.read(read('0x01')), batcher.read(read('0x02'))]))
      .resolves.toEqual(['direct:0x01', 'direct:0x02']);
    const thrower = read('0x03', { direct: vi.fn(() => { throw new Error('issued badly'); }) });
    await expect(batcher.read(thrower)).rejects.toThrow('issued badly');

    expect(observations.map(({ outcome, directReads }) => ({ outcome, directReads })))
      .toEqual([{ outcome: 'failed', directReads: 2 }, { outcome: 'failed', directReads: 1 }]);
  });

  it('pauses after repeated request failures, sends reads directly meanwhile, and resumes', async () => {
    let now = 1_000;
    let failing = true;
    const aggregate = vi.fn(async (calls: readonly BatchedContractCall[]) => {
      if (failing) throw new Error('endpoint unavailable');
      return calls.map(({ callData }) => ({ success: true, returnData: callData }));
    });
    const batcher = new ContractReadBatcher({
      aggregate, now: () => now, pauseAfterFailures: 2, pauseMs: 60_000,
    });

    await expect(batcher.read(read('0x01'))).resolves.toBe('direct:0x01');
    expect(batcher.accepting).toBe(true);
    // The second failure pauses batching; a read already waiting behind it goes out directly too.
    const second = batcher.read(read('0x02'));
    await turn();
    await expect(second).resolves.toBe('direct:0x02');
    expect(batcher.accepting).toBe(false);
    expect(aggregate).toHaveBeenCalledTimes(2);

    await expect(batcher.read(read('0x03'))).resolves.toBe('direct:0x03');
    expect(aggregate).toHaveBeenCalledTimes(2);

    now += 60_000;
    failing = false;
    expect(batcher.accepting).toBe(true);
    await expect(batcher.read(read('0x04'))).resolves.toBe('batched:0x04');
    expect(aggregate).toHaveBeenCalledTimes(3);
  });

  it('hands reads still waiting to their direct path when a failure pauses batching', async () => {
    const gate = deferred<void>();
    const batcher = new ContractReadBatcher({
      aggregate: async () => { await gate.promise; throw new Error('endpoint unavailable'); },
      pauseAfterFailures: 1,
    });

    const inFlight = batcher.read(read('0x01'));
    await turn();
    const waiting = batcher.read(read('0x02'));
    gate.resolve();

    await expect(Promise.all([inFlight, waiting])).resolves.toEqual(['direct:0x01', 'direct:0x02']);
    expect(batcher.accepting).toBe(false);
  });

  it('fails the reads with a local admission refusal instead of queueing each behind it', async () => {
    const refusal = Object.assign(new Error('queue is full'), { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const observations: ContractReadBatchObservation[] = [];
    const batcher = new ContractReadBatcher({
      aggregate: async () => { throw refusal; },
      isLocalRefusal: (error) => error === refusal,
      pauseAfterFailures: 1,
      observe: (o) => observations.push(o),
    });
    const first = read('0x01');
    const second = read('0x02');

    const settled = await Promise.allSettled([batcher.read(first), batcher.read(second)]);

    expect(settled).toEqual([
      { status: 'rejected', reason: refusal },
      { status: 'rejected', reason: refusal },
    ]);
    expect(first.direct).not.toHaveBeenCalled();
    expect(second.direct).not.toHaveBeenCalled();
    // A refusal says nothing about the aggregate call itself: batching stays on.
    expect(batcher.accepting).toBe(true);
    expect(observations).toEqual([expect.objectContaining({ outcome: 'refused', directReads: 0 })]);
  });

  it('ends one caller\'s wait on its signal without cancelling the request for the others', async () => {
    const gate = deferred<void>();
    const requests: string[][] = [];
    const batcher = new ContractReadBatcher({
      aggregate: async (calls) => {
        requests.push(calls.map(({ callData }) => callData));
        await gate.promise;
        return calls.map(({ callData }) => ({ success: true, returnData: callData }));
      },
    });
    const controller = new AbortController();
    const leaving = read('0x01', { signals: [undefined, controller.signal] });
    const staying = read('0x02');

    const left = batcher.read(leaving);
    const stayed = batcher.read(staying);
    await turn();
    controller.abort(new Error('caller gave up'));
    await expect(left).rejects.toThrow('caller gave up');
    gate.resolve();

    await expect(stayed).resolves.toBe('batched:0x02');
    expect(requests).toEqual([['0x01', '0x02']]);
    expect(leaving.direct).not.toHaveBeenCalled();
  });

  it('never sends a read whose caller left before the request, or arrived already cancelled', async () => {
    const { aggregate, requests } = echoAggregate();
    const batcher = new ContractReadBatcher({ aggregate });
    const before = new AbortController();
    const cancelled = AbortSignal.abort('stopped');

    const leftEarly = batcher.read(read('0x01', { signals: [before.signal] }));
    const kept = batcher.read(read('0x02'));
    before.abort();
    const never = batcher.read(read('0x03', { signals: [cancelled] }));

    await expect(leftEarly).rejects.toMatchObject({ name: 'AbortError' });
    await expect(never).rejects.toMatchObject({ name: 'AbortError', message: 'stopped' });
    await expect(kept).resolves.toBe('batched:0x02');
    expect(requests).toEqual([[{ target: TARGET, callData: '0x02' }]]);
  });

  describe('a request that stays out', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('stops holding the reads behind it after the stall bound, up to the in-flight bound', async () => {
      vi.useFakeTimers();
      const gates: Array<Deferred<void>> = [];
      const requests: string[][] = [];
      const batcher = new ContractReadBatcher({
        aggregate: async (calls) => {
          requests.push(calls.map(({ callData }) => callData));
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
          return calls.map(({ callData }) => ({ success: true, returnData: callData }));
        },
        stallMs: 5_000,
        maxRequestsInFlight: 3,
      });

      const stuck = batcher.read(read('0x01'));
      await vi.advanceTimersByTimeAsync(1);
      const behind = batcher.read(read('0x02'));
      await vi.advanceTimersByTimeAsync(4_998);
      // Inside the bound the one-at-a-time rule holds.
      expect(requests).toEqual([['0x01']]);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toEqual([['0x01'], ['0x02']]);

      // The second is stuck too: a third leaves one bound later, and that is the limit.
      const third = batcher.read(read('0x03'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requests).toEqual([['0x01'], ['0x02'], ['0x03']]);
      const fourth = batcher.read(read('0x04'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(3);

      // Any request coming back lets what is waiting leave.
      gates[1]!.resolve();
      await expect(behind).resolves.toBe('batched:0x02');
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual([['0x01'], ['0x02'], ['0x03'], ['0x04']]);
      for (const gate of gates) gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(Promise.all([stuck, third, fourth]))
        .resolves.toEqual(['batched:0x01', 'batched:0x03', 'batched:0x04']);
    });

    it('sends nothing extra when no read is waiting behind it', async () => {
      vi.useFakeTimers();
      const gate = deferred<void>();
      const aggregate = vi.fn(async (calls: readonly BatchedContractCall[]) => {
        await gate.promise;
        return calls.map(({ callData }) => ({ success: true, returnData: callData }));
      });
      const batcher = new ContractReadBatcher({ aggregate, stallMs: 5_000 });

      const only = batcher.read(read('0x01'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(aggregate).toHaveBeenCalledTimes(1);
      gate.resolve();
      await expect(only).resolves.toBe('batched:0x01');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects an in-flight bound below one', () => {
      expect(() => new ContractReadBatcher({ aggregate: async () => [], maxRequestsInFlight: 0 }))
        .toThrow(RangeError);
    });
  });

  it('keeps answering when its observer throws', async () => {
    const { aggregate } = echoAggregate();
    const batcher = new ContractReadBatcher({
      aggregate,
      observe: () => { throw new Error('observer failed'); },
    });
    const noisy = read('0x01', { onBatched: () => { throw new Error('callback failed'); } });

    await expect(batcher.read(noisy)).resolves.toBe('batched:0x01');
  });
});
