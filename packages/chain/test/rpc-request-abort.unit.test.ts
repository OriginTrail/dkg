// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ContractReadBatcher } from '../src/contract-read-batcher.js';
import { rpcRequestAbortReason } from '../src/rpc-request-abort.js';
import { throwRpcRequestAbortReason } from '../src/rpc-request-transport.js';

function thrownBy(fn: () => never): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
}

/** What a read cancelled before it joined a batch rejects with. */
async function batcherRejection(signal: AbortSignal): Promise<unknown> {
  const batcher = new ContractReadBatcher({ aggregate: async () => [] });
  return batcher.read({
    label: 'kas.getLatestMerkleRoot',
    target: `0x${'aa'.repeat(20)}`,
    callData: '0x01',
    decode: (returnData) => returnData,
    direct: async () => 'direct',
    signals: [signal],
  }).then(() => undefined, (error: unknown) => error);
}

describe('rpcRequestAbortReason', () => {
  it('returns the Error a signal was aborted with, itself', () => {
    const reason = new Error('caller gave up');
    expect(rpcRequestAbortReason(AbortSignal.abort(reason))).toBe(reason);
  });

  it('wraps a string reason in an AbortError with that message', () => {
    const error = rpcRequestAbortReason(AbortSignal.abort('stopped'));
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'AbortError', message: 'stopped' });
  });

  it('names a reason that is neither an Error nor a string a plain RPC abort', () => {
    const error = rpcRequestAbortReason(AbortSignal.abort({ code: 7 }));
    expect(error).toMatchObject({ name: 'AbortError', message: 'RPC request aborted' });
  });

  it.each([
    ['an Error reason', () => AbortSignal.abort(new TypeError('deadline passed'))],
    ['a string reason', () => AbortSignal.abort('stopped')],
    ['the default reason', () => AbortSignal.abort()],
    ['an opaque reason', () => AbortSignal.abort(42)],
  ])('is what the transport throws and what a batched read rejects with: %s', async (_name, make) => {
    const signal = make();
    const expected = rpcRequestAbortReason(signal);

    const thrown = thrownBy(() => throwRpcRequestAbortReason(signal)) as Error;
    const rejected = await batcherRejection(signal) as Error;

    for (const error of [thrown, rejected]) {
      expect(error).toBeInstanceOf(Error);
      expect({ name: error.name, message: error.message }).toEqual({
        name: expected.name, message: expected.message,
      });
    }
    // A signal's own Error keeps its identity on both paths.
    if (signal.reason instanceof Error) {
      expect(thrown).toBe(signal.reason);
      expect(rejected).toBe(signal.reason);
    }
  });
});
