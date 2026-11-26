// SPDX-License-Identifier: Apache-2.0
import { ethers, type JsonRpcProvider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import { createEvmContextGraphAuthorityIndexRevisionReaderV1 } from '../src/evm-context-graph-authority-index-reader.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { classifyRpcRetryDisposition } from '../src/evm-adapter-rpc.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';
import { makeClient } from './rpc-failover-test-helpers.js';

function fixture(primaryRead: () => Promise<never>) {
  const primary = { getBlock: vi.fn(primaryRead) };
  const backup = {
    getBlock: vi.fn(async (tag: number | 'latest') => {
      const number = tag === 'latest' ? 130 : tag;
      return { number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: Math.floor(Date.now() / 1_000) };
    }),
    getLogs: vi.fn(async () => []),
    getNetwork: async () => ({ chainId: 31337n }),
  };
  const rpc = makeClient([primary, backup], ['https://primary.example', 'https://backup.example']);
  const contract = new ethers.Contract(`0x${'cd'.repeat(20)}`, loadAbi('ContextGraphStorage'), backup as unknown as JsonRpcProvider);
  const reader = createEvmContextGraphAuthorityIndexRevisionReaderV1({
    index: new ContextGraphAuthorityIndex(new MemoryAuthorityIndexStore()),
    deploymentId: 'evm:31337:0xhub',
    initialize: async () => undefined,
    requireContextGraphStorage: () => contract,
    readTipProvider: (label, read, options) => rpc.read(label, read, options),
    resolveContractDeployBlock: async () => ({ blockNumber: 10, pinned: true }),
    pageSize: () => 2_000,
    finalityConfirmations: () => 1,
  });
  reader.snapshots.open();
  return { reader, primary, backup };
}

const networkError = () => Object.assign(new Error('primary unavailable'), { code: 'NETWORK_ERROR' });

describe('authority block sharing through the real provider failover loop', () => {
  it('lets all three concurrent refreshes reach the healthy backup after shared failures', async () => {
    const { reader, primary, backup } = fixture(async () => { throw networkError(); });
    try {
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => reader.snapshots.refresh()));
      expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: 'fulfilled', value: undefined })));
      expect(primary.getBlock).toHaveBeenCalledTimes(1);
      expect(backup.getBlock).toHaveBeenCalled();
      expect(backup.getLogs).toHaveBeenCalled();
    } finally { await reader.snapshots.close(); }
  });

  it.each([
    ['local admission pressure', () => new RpcRequestGovernorQueueFullError(1), 'retry-later'],
    ['deterministic provider failure', () => Object.assign(new Error('invalid block'), { code: 'INVALID_ARGUMENT' }), 'fail'],
  ] as const)('preserves %s without blaming another endpoint', async (_label, failure, disposition) => {
    const error = failure();
    const { reader, primary, backup } = fixture(async () => { throw error; });
    try {
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => reader.snapshots.refresh()));
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('Expected rejection');
        expect(result.reason).toBe(error);
        expect(classifyRpcRetryDisposition(result.reason)).toBe(disposition);
      }
      expect(primary.getBlock).toHaveBeenCalledTimes(1);
      expect(backup.getBlock).not.toHaveBeenCalled();
    } finally { await reader.snapshots.close(); }
  });

  it('keeps cancellation caller-local while the other refreshes reach the backup', async () => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { reader, backup } = fixture(async () => { entered(); await held; throw networkError(); });
    const caller = new AbortController();
    const reason = new DOMException('caller stopped', 'AbortError');
    const results = Promise.allSettled([
      reader.snapshots.refresh({ signal: caller.signal }),
      reader.snapshots.refresh(), reader.snapshots.refresh(),
    ]);
    try {
      await started;
      caller.abort(reason);
      release();
      expect(await results).toEqual([
        { status: 'rejected', reason },
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      expect(backup.getLogs).toHaveBeenCalled();
    } finally { release(); await results; await reader.snapshots.close(); }
  });
});
