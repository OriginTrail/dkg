import { describe, expect, it, vi } from 'vitest';

import {
  RawLogScanner,
  rawLogIdentity,
  type RawLogScanReadProvider,
} from '../src/raw-log-scanner.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const TOPIC_A = `0x${'a'.repeat(64)}`;
const TOPIC_B = `0x${'b'.repeat(64)}`;

function log(blockNumber: number, index: number, topic = TOPIC_A): any {
  return {
    blockNumber,
    blockHash: `0x${String(blockNumber).padStart(64, '0')}`,
    transactionHash: `0x${String(index).padStart(64, '0')}`,
    index,
    topics: [topic],
    data: '0x',
  };
}

function providerFor(input: {
  readonly heads: readonly number[];
  readonly logs: readonly (readonly any[])[];
}): {
  readonly readProvider: RawLogScanReadProvider;
  readonly getLogs: ReturnType<typeof vi.fn>;
  readonly getBlockNumber: ReturnType<typeof vi.fn>;
} {
  let headIndex = 0;
  const getBlockNumber = vi.fn(async () => input.heads[Math.min(headIndex++, input.heads.length - 1)]!);
  let logIndex = 0;
  // Honour the requested range the way a node does, so range construction is
  // exercised by the assertions instead of being papered over by the fake.
  const getLogs = vi.fn(async (filter: { fromBlock: number; toBlock: number }) => {
    const batch = input.logs[Math.min(logIndex++, input.logs.length - 1)] ?? [];
    return batch.filter((entry) => entry.blockNumber >= filter.fromBlock
      && entry.blockNumber <= filter.toBlock);
  });
  const readProvider: RawLogScanReadProvider = async (_label, fn, _opts) =>
    fn({ getBlockNumber, getLogs } as never);
  return { readProvider, getLogs, getBlockNumber };
}

describe('RawLogScanner', () => {
  it('owns range construction, wide-log policy, and stable batch dedupe', async () => {
    const first = log(98, 0);
    const duplicate = log(98, 0);
    const second = log(101, 1, TOPIC_B);
    const provider = providerFor({
      heads: [100, 105],
      logs: [[first], [duplicate, second]],
    });
    const calls: Array<{ label: string; opts: any; filter?: any }> = [];
    const readProvider: RawLogScanReadProvider = async (label, fn, opts) => {
      calls.push({ label, opts });
      return provider.readProvider(label, fn, opts);
    };
    const scanner = new RawLogScanner({
      label: 'unit scan',
      readProvider,
      reorgBufferBlocks: 10,
    });

    const firstBatch = await scanner.read({ address: ADDRESS, topics: [TOPIC_A, TOPIC_B] });
    expect(firstBatch?.logs).toEqual([first]);
    expect(calls.map((call) => call.label)).toEqual([
      'unit scan getBlockNumber',
      'unit scan getLogs',
    ]);
    expect(calls[0]?.opts).toMatchObject({
      policy: 'watchdogPointRead',
      skipPreferred: true,
    });
    expect(calls[1]?.opts).toMatchObject({
      policy: 'watchdogWideLogScan',
      skipPreferred: true,
    });
    scanner.commit(firstBatch!);

    const secondBatch = await scanner.read({ address: ADDRESS, topics: [TOPIC_A, TOPIC_B] });
    expect(secondBatch?.logs).toEqual([second]);
  });

  it('does not advance cursor or dedupe state until the caller commits a batch', async () => {
    const entry = log(4, 0);
    const provider = providerFor({ heads: [5, 5], logs: [[entry], [entry]] });
    const scanner = new RawLogScanner({
      label: 'transactional scan',
      readProvider: provider.readProvider,
      reorgBufferBlocks: 1,
    });

    const firstBatch = await scanner.read({ address: ADDRESS, topics: [] });
    const secondBatch = await scanner.read({ address: ADDRESS, topics: [] });
    expect(secondBatch?.logs).toEqual([entry]);
    scanner.commit(firstBatch!);
    const thirdBatch = await scanner.read({ address: ADDRESS, topics: [] });
    expect(thirdBatch?.logs).toEqual([]);
  });

  it('skips the wide scan and returns no batch when the caller aborts during the head read', async () => {
    const entry = log(4, 0);
    const provider = providerFor({ heads: [5], logs: [[entry]] });
    const scanner = new RawLogScanner({
      label: 'abort scan',
      readProvider: provider.readProvider,
      reorgBufferBlocks: 1,
    });

    const batch = await scanner.read(
      { address: ADDRESS, topics: [] },
      { isAborted: () => true },
    );
    expect(batch).toBeUndefined();
    expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(provider.getLogs).not.toHaveBeenCalled();
  });

  it('keeps the oldest in-range block deduped: prune and scanFromBlock share one boundary', async () => {
    // head - reorgBufferBlocks is BOTH the oldest identity prune keeps and the
    // fromBlock of the next scan, so a log sitting exactly there is re-read from
    // the node every tick and must stay deduped. Pruning it (`<=` instead of
    // `<`) re-dispatches it forever.
    const boundary = log(5, 0);
    const provider = providerFor({
      heads: [6, 6],
      logs: [[boundary], [boundary]],
    });
    const scanner = new RawLogScanner({
      label: 'boundary scan',
      readProvider: provider.readProvider,
      reorgBufferBlocks: 1,
    });

    const firstBatch = await scanner.read({ address: ADDRESS, topics: [] });
    expect(firstBatch?.logs).toEqual([boundary]);
    scanner.commit(firstBatch!);

    const rescan = await scanner.read({ address: ADDRESS, topics: [] });
    expect(provider.getLogs.mock.calls.at(-1)?.[0]).toMatchObject({
      fromBlock: boundary.blockNumber,
      toBlock: 6,
    });
    expect(rescan?.logs).toEqual([]);
  });

  it('prunes identities the scan window has left behind, so a head regression re-observes them', async () => {
    const entry = log(8, 0);
    const provider = providerFor({
      // The third head regresses (lagging endpoint / reorg), widening fromBlock
      // back below the block the second commit pruned.
      heads: [10, 12, 9],
      logs: [[entry], [entry], [entry]],
    });
    const scanner = new RawLogScanner({
      label: 'prune scan',
      readProvider: provider.readProvider,
      reorgBufferBlocks: 2,
    });

    const firstBatch = await scanner.read({ address: ADDRESS, topics: [] });
    expect(firstBatch?.logs).toEqual([entry]);
    scanner.commit(firstBatch!);

    // head 12 puts block 8 outside both the scan window and the buffer: nothing
    // is returned, and the commit prunes the identity.
    const outOfRange = await scanner.read({ address: ADDRESS, topics: [] });
    expect(outOfRange?.logs).toEqual([]);
    scanner.commit(outOfRange!);

    const reintroduced = await scanner.read({ address: ADDRESS, topics: [] });
    expect(reintroduced?.logs).toEqual([entry]);
  });

  it('uses a deterministic fallback when provider log identity fields are absent', () => {
    const value = {
      blockNumber: 7,
      topics: [TOPIC_A],
      data: '0x1234',
    } as any;
    expect(rawLogIdentity(value)).toBe(`7:unknown:${TOPIC_A}:0x1234`);
  });
});
