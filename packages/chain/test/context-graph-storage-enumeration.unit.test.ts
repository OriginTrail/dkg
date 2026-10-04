// SPDX-License-Identifier: Apache-2.0

import { Contract, ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MULTICALL3_ADDRESS } from '../src/evm-background-read-batching.js';
import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';
import {
  CONTEXT_GRAPH_STORAGE_ENUMERATION_CONCURRENCY,
  CONTEXT_GRAPH_STORAGE_ENUMERATION_IDS_PER_REQUEST,
  CONTEXT_GRAPH_STORAGE_ENUMERATION_MAX_IDS_PER_READ,
  ContextGraphStorageEnumerationError,
  contextGraphStorageBatchCalls,
  decodeContextGraphStorageBatch,
  decodeContextGraphStorageEntryV1,
  isContextGraphStorageEnumerationReadRetryable,
  isNonexistentContextGraphStorageRevert,
  readContextGraphStorageRangeV1,
  type ContextGraphStorageBatchedRead,
  type ContextGraphStorageRangePorts,
} from '../src/evm-context-graph-storage-enumeration.js';
import type { ReadOpts, RpcReadDescriptor } from '../src/rpc-failover-client.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { minimalConfig, seam } from './context-graph-registry-scan-fixture.js';
import { MULTICALL3_RUNTIME_CODE } from './fixtures/multicall3-runtime-code.js';

const STORAGE = '0xC6C6c6C6C6c6c6c6C6c6C6c6c6C6C6C6c6c6C6c6';
const OWNER = '0x64529c023d853371228923B4FdA5FB22F929bf51';
const AUTHORITY = '0xbBE5eF8eC201677BBe3e4FAAbE73556b84a6eA13';
const ANCHOR_HASH = `0x${'ab'.repeat(32)}`;

interface FakeGraph {
  owner?: string;
  active?: boolean;
  createdAt?: number;
  accessPolicy?: number;
  publishPolicy?: number;
  publishAuthority?: string;
  nameHash?: string;
}

function nameHashFor(id: number): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`graph-${id}`));
}

function tuple(graph: FakeGraph): unknown[] {
  return [
    graph.owner ?? OWNER,
    [],
    0n,
    graph.active ?? true,
    BigInt(graph.createdAt ?? 1_790_152_299),
    BigInt(graph.accessPolicy ?? 0),
    BigInt(graph.publishPolicy ?? 1),
    graph.publishAuthority ?? ethers.ZeroAddress,
    0n,
  ];
}

function nonexistent(id: bigint) {
  return Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    data: new ethers.Interface(['error ERC721NonexistentToken(uint256 tokenId)'])
      .encodeErrorResult('ERC721NonexistentToken', [id]),
  });
}

function fakePorts(graphs: Map<number, FakeGraph>, latestId: number, anchor = 1_000) {
  const blockTags: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const ports: ContextGraphStorageRangePorts = {
    storageAddress: STORAGE,
    readAnchor: async () => ({ number: anchor, hash: ANCHOR_HASH.toUpperCase().replace('0X', '0x') }),
    readLatestId: async (blockTag) => {
      blockTags.push(blockTag);
      return BigInt(latestId);
    },
    readContextGraph: async (id, blockTag) => {
      blockTags.push(blockTag);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const graph = graphs.get(Number(id));
      if (!graph) throw nonexistent(id);
      return tuple(graph);
    },
    readNameHash: async (id, blockTag) => {
      blockTags.push(blockTag);
      const graph = graphs.get(Number(id));
      return graph?.nameHash ?? ethers.ZeroHash;
    },
    isNonexistentContextGraph: isNonexistentContextGraphStorageRevert,
  };
  return { ports, blockTags, maxInFlight: () => maxInFlight };
}

describe('readContextGraphStorageRangeV1', () => {
  it('reads a bounded id range with every call pinned to the anchor block', async () => {
    const graphs = new Map<number, FakeGraph>();
    for (let id = 1; id <= 20; id++) {
      graphs.set(id, { nameHash: nameHashFor(id), accessPolicy: id % 2, publishPolicy: id % 3 === 0 ? 0 : 1 });
    }
    graphs.set(3, { ...graphs.get(3), publishAuthority: AUTHORITY, publishPolicy: 0 });
    const { ports, blockTags, maxInFlight } = fakePorts(graphs, 20, 4_242);

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 2n, maxIds: 10 });

    expect(range.storageAddress).toBe(STORAGE.toLowerCase());
    expect(range.anchorBlockNumber).toBe(4_242);
    expect(range.anchorBlockHash).toBe(ANCHOR_HASH);
    expect(range.latestId).toBe(20n);
    expect(range.nextId).toBe(12n);
    expect(range.entries.map((entry) => entry.contextGraphId)).toEqual(
      ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
    );
    expect(new Set(blockTags)).toEqual(new Set([4_242]));
    expect(maxInFlight()).toBeLessThanOrEqual(CONTEXT_GRAPH_STORAGE_ENUMERATION_CONCURRENCY);
    expect(range.entries[1]).toEqual({
      contextGraphId: '3',
      owner: OWNER.toLowerCase(),
      active: true,
      createdAt: 1_790_152_299,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY.toLowerCase(),
      nameHash: nameHashFor(3).toLowerCase(),
    });
    expect(Object.isFrozen(range)).toBe(true);
  });

  it('caps the range at the latest id and never moves a cursor past the chain', async () => {
    const graphs = new Map<number, FakeGraph>([[1, {}], [2, {}]]);
    const { ports } = fakePorts(graphs, 2);

    const tail = await readContextGraphStorageRangeV1(ports, { fromId: 2n, maxIds: 50 });
    expect(tail.entries.map((entry) => entry.contextGraphId)).toEqual(['2']);
    expect(tail.nextId).toBe(3n);

    const beyond = await readContextGraphStorageRangeV1(ports, { fromId: 3n, maxIds: 50 });
    expect(beyond.entries).toEqual([]);
    expect(beyond.nextId).toBe(3n);
  });

  it('reports an opted-out name hash and a zero publish authority as null', async () => {
    const { ports } = fakePorts(new Map([[1, { publishPolicy: 1 }]]), 1);
    const [entry] = (await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 1 })).entries;
    expect(entry!.nameHash).toBeNull();
    expect(entry!.publishAuthority).toBeNull();
  });

  it('keeps deactivated graphs, flagged inactive', async () => {
    const { ports } = fakePorts(new Map([[1, { active: false, nameHash: nameHashFor(1) }]]), 1);
    const [entry] = (await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 1 })).entries;
    expect(entry!.active).toBe(false);
  });

  it('ends the range at an id that is not readable yet instead of skipping it', async () => {
    const graphs = new Map<number, FakeGraph>([[1, {}], [2, {}], [4, {}], [5, {}]]);
    const { ports } = fakePorts(graphs, 5);

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 5 });

    expect(range.entries.map((entry) => entry.contextGraphId)).toEqual(['1', '2']);
    expect(range.nextId).toBe(3n);
  });

  it('ends the range before an id that could not be read, so no cursor advances over a gap', async () => {
    const { ports } = fakePorts(new Map([[1, {}], [2, {}], [3, {}], [4, {}]]), 4);
    const failing: ContextGraphStorageRangePorts = {
      ...ports,
      readNameHash: async (id) => {
        if (id === 3n) throw Object.assign(new Error('boom'), { code: 'SERVER_ERROR' });
        return ethers.ZeroHash;
      },
    };

    // The ids read before the failed one are kept; nothing after it is returned.
    const range = await readContextGraphStorageRangeV1(failing, { fromId: 1n, maxIds: 4 });
    expect(range.entries.map((entry) => entry.contextGraphId)).toEqual(['1', '2']);
    expect(range.nextId).toBe(3n);
    expect(range.latestId).toBe(4n);

    // The failure itself is what a read starting at that id reports.
    await expect(readContextGraphStorageRangeV1(failing, { fromId: 3n, maxIds: 2 }))
      .rejects.toThrow('boom');
  });

  it('reports the failure with the lowest id when several ids could not be read', async () => {
    const { ports } = fakePorts(new Map([[1, {}], [2, {}], [3, {}]]), 3);
    const failing: ContextGraphStorageRangePorts = {
      ...ports,
      readContextGraph: async (id, blockTag) => {
        // The later id fails first; the first id's failure is the one that counts.
        if (id === 1n) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('first id unreadable');
        }
        if (id === 2n) throw new Error('second id unreadable');
        return ports.readContextGraph(id, blockTag);
      },
    };

    await expect(readContextGraphStorageRangeV1(failing, { fromId: 1n, maxIds: 3 }))
      .rejects.toThrow('first id unreadable');
  });

  it('ends at a nonexistent id below a failed one without reporting the failure', async () => {
    const { ports } = fakePorts(new Map([[2, {}], [3, {}]]), 3);
    const failing: ContextGraphStorageRangePorts = {
      ...ports,
      readNameHash: async (id) => {
        if (id === 2n) throw new Error('boom');
        return ethers.ZeroHash;
      },
    };

    const range = await readContextGraphStorageRangeV1(failing, { fromId: 1n, maxIds: 3 });

    expect(range.entries).toEqual([]);
    expect(range.nextId).toBe(1n);
  });

  it('rejects out-of-contract arguments before any chain read', async () => {
    const { ports, blockTags } = fakePorts(new Map(), 0);
    await expect(readContextGraphStorageRangeV1(ports, { fromId: 0n, maxIds: 1 }))
      .rejects.toThrow(RangeError);
    await expect(readContextGraphStorageRangeV1(ports, { fromId: 1 as unknown as bigint, maxIds: 1 }))
      .rejects.toThrow(RangeError);
    await expect(readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 0 }))
      .rejects.toThrow(RangeError);
    await expect(readContextGraphStorageRangeV1(ports, {
      fromId: 1n,
      maxIds: CONTEXT_GRAPH_STORAGE_ENUMERATION_MAX_IDS_PER_READ + 1,
    })).rejects.toThrow(RangeError);
    expect(blockTags).toEqual([]);
  });

  it('honours cancellation between reads', async () => {
    const { ports } = fakePorts(new Map([[1, {}]]), 1);
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 1, signal: controller.signal }))
      .rejects.toThrow('stop');
  });
});

/**
 * Ports of an adapter that can aggregate: `fakePorts` plus one request for a
 * run of ids, with every request and every read of a single id recorded.
 */
function aggregatingPorts(
  graphs: Map<number, FakeGraph>,
  latestId: number,
  options: {
    /** Ids the request has no usable answer for. */
    unanswered?: number[];
    /** Ids the request answers with a tuple that does not decode. */
    garbled?: number[];
    /** Ids that cannot be read on their own either. */
    unreadable?: number[];
    /** What the request starting at this id rejects with. */
    refuseFrom?: { id: number; error: unknown };
    /** The adapter has no aggregate to offer. */
    unavailable?: boolean;
  } = {},
) {
  const { ports, blockTags } = fakePorts(graphs, latestId);
  const requests: number[][] = [];
  const singleReads: number[] = [];
  const aggregating: ContextGraphStorageRangePorts = {
    ...ports,
    readContextGraph: async (id, blockTag) => {
      singleReads.push(Number(id));
      if (options.unreadable?.includes(Number(id))) throw new Error(`id ${id} is unreadable`);
      return ports.readContextGraph(id, blockTag);
    },
    readEntriesBatch: async (ids, blockTag) => {
      blockTags.push(blockTag);
      requests.push(ids.map(Number));
      if (options.unavailable) return undefined;
      if (options.refuseFrom?.id === Number(ids[0])) throw options.refuseFrom.error;
      return ids.map((id): ContextGraphStorageBatchedRead => {
        const graph = graphs.get(Number(id));
        if (!graph) return 'nonexistent';
        if (options.unanswered?.includes(Number(id))) return undefined;
        if (options.garbled?.includes(Number(id))) {
          return { contextGraph: tuple({ ...graph, owner: ethers.ZeroAddress }), nameHash: ethers.ZeroHash };
        }
        return { contextGraph: tuple(graph), nameHash: graph.nameHash ?? ethers.ZeroHash };
      });
    },
  };
  return { ports: aggregating, plainPorts: ports, requests, singleReads, blockTags };
}

function graphsUpTo(count: number): Map<number, FakeGraph> {
  const graphs = new Map<number, FakeGraph>();
  for (let id = 1; id <= count; id++) {
    graphs.set(id, { nameHash: nameHashFor(id), accessPolicy: id % 2, publishPolicy: id % 3 === 0 ? 0 : 1 });
  }
  return graphs;
}

const idsOf = (range: { entries: readonly { contextGraphId: string }[] }) =>
  range.entries.map((entry) => Number(entry.contextGraphId));
const sequence = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('readContextGraphStorageRangeV1 with an aggregating adapter', () => {
  it('answers a whole range from one request, with no read per id', async () => {
    const graphs = graphsUpTo(20);
    const { ports, plainPorts, requests, singleReads, blockTags } = aggregatingPorts(graphs, 20);

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 20 });

    expect(requests).toEqual([sequence(1, 20)]);
    expect(singleReads).toEqual([]);
    expect(new Set(blockTags)).toEqual(new Set([1_000]));
    // Exactly what the same range reads one id at a time.
    expect(range).toEqual(await readContextGraphStorageRangeV1(plainPorts, { fromId: 1n, maxIds: 20 }));
    expect(range.nextId).toBe(21n);
  });

  it('sends one request per run of ids, in id order', async () => {
    const perRequest = CONTEXT_GRAPH_STORAGE_ENUMERATION_IDS_PER_REQUEST;
    expect(perRequest).toBe(32);
    const { ports, requests, singleReads } = aggregatingPorts(graphsUpTo(70), 70);

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 100 });

    expect(requests).toEqual([sequence(1, 32), sequence(33, 64), sequence(65, 70)]);
    expect(singleReads).toEqual([]);
    expect(idsOf(range)).toEqual(sequence(1, 70));
  });

  it('reads an id the request did not answer on its own, and keeps the others from the request', async () => {
    const { ports, requests, singleReads } = aggregatingPorts(graphsUpTo(10), 10, { unanswered: [5] });

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 10 });

    expect(requests).toHaveLength(1);
    expect(singleReads).toEqual([5]);
    expect(idsOf(range)).toEqual(sequence(1, 10));
    expect(range.entries[4]!.nameHash).toBe(nameHashFor(5).toLowerCase());
  });

  it('reads an id on its own when its answer in the request does not decode', async () => {
    const { ports, singleReads } = aggregatingPorts(graphsUpTo(6), 6, { garbled: [2] });

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 6 });

    expect(singleReads).toEqual([2]);
    expect(idsOf(range)).toEqual(sequence(1, 6));
    expect(range.entries[1]!.owner).toBe(OWNER.toLowerCase());
  });

  it('keeps the ids before one that cannot be read at all, and reads nothing past it one by one', async () => {
    const { ports, singleReads } = aggregatingPorts(graphsUpTo(10), 10, {
      unanswered: [5, 8],
      unreadable: [5],
    });

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 10 });

    // 1..4 came from the request; 5 failed on its own, so the range ends there.
    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(range.nextId).toBe(5n);
    expect(singleReads.filter((id) => id === 5)).toEqual([5]);
    // The failure is reported by the read that starts at the failed id.
    await expect(readContextGraphStorageRangeV1(ports, { fromId: 5n, maxIds: 6 }))
      .rejects.toThrow('id 5 is unreadable');
  });

  it('ends the range at an id the request proves nonexistent and asks for nothing after it', async () => {
    const graphs = graphsUpTo(70);
    graphs.delete(10);
    const { ports, requests, singleReads } = aggregatingPorts(graphs, 70);

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 70 });

    expect(idsOf(range)).toEqual(sequence(1, 9));
    expect(range.nextId).toBe(10n);
    expect(requests).toEqual([sequence(1, 32)]);
    expect(singleReads).toEqual([]);
  });

  it('reads every id one by one when the adapter has no aggregate to offer, asking once', async () => {
    const { ports, plainPorts, requests, singleReads } = aggregatingPorts(graphsUpTo(40), 40, {
      unavailable: true,
    });

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 40 });

    expect(requests).toEqual([sequence(1, 32)]);
    expect([...singleReads].sort((a, b) => a - b)).toEqual(sequence(1, 40));
    expect(range).toEqual(await readContextGraphStorageRangeV1(plainPorts, { fromId: 1n, maxIds: 40 }));
  });

  it('rejects when the first request is refused, without reading any id on its own', async () => {
    const refusal = new RpcRequestGovernorQueueFullError(256);
    const { ports, singleReads } = aggregatingPorts(graphsUpTo(40), 40, {
      refuseFrom: { id: 1, error: refusal },
    });

    await expect(readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 40 }))
      .rejects.toBe(refusal);
    expect(singleReads).toEqual([]);
  });

  it('keeps what earlier requests read when a later request is refused', async () => {
    const { ports, requests, singleReads } = aggregatingPorts(graphsUpTo(70), 70, {
      unanswered: [3],
      refuseFrom: { id: 33, error: new RpcRequestGovernorQueueFullError(256) },
    });

    const range = await readContextGraphStorageRangeV1(ports, { fromId: 1n, maxIds: 70 });

    expect(idsOf(range)).toEqual(sequence(1, 32));
    expect(range.nextId).toBe(33n);
    expect(requests).toEqual([sequence(1, 32), sequence(33, 64)]);
    // Only the id the first request left open; nothing from the refused run.
    expect(singleReads).toEqual([3]);
  });

  it('honours cancellation before a request is sent', async () => {
    const { ports, requests } = aggregatingPorts(graphsUpTo(40), 40);
    const controller = new AbortController();
    const cancelling: ContextGraphStorageRangePorts = {
      ...ports,
      readEntriesBatch: async (ids, blockTag) => {
        const batch = await ports.readEntriesBatch!(ids, blockTag);
        controller.abort(new Error('pass ended'));
        return batch;
      },
    };

    await expect(readContextGraphStorageRangeV1(cancelling, {
      fromId: 1n,
      maxIds: 40,
      signal: controller.signal,
    })).rejects.toThrow('pass ended');
    expect(requests).toEqual([sequence(1, 32)]);
  });
});

describe('the aggregate request for a run of ids', () => {
  const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
  const nonexistentToken = new ethers.Interface(['error ERC721NonexistentToken(uint256 tokenId)']);
  const encoded = (graph: FakeGraph) => ({
    contextGraph: {
      success: true,
      returnData: storageInterface.encodeFunctionResult('getContextGraph', tuple(graph)),
    },
    nameHash: {
      success: true,
      returnData: storageInterface.encodeFunctionResult('getNameHash', [graph.nameHash ?? ethers.ZeroHash]),
    },
  });

  it('carries getContextGraph then getNameHash for every id', () => {
    const calls = contextGraphStorageBatchCalls(storageInterface, STORAGE, [7n, 8n]);

    expect(calls.map(({ target }) => target)).toEqual([STORAGE, STORAGE, STORAGE, STORAGE]);
    expect(calls.map(({ callData }) => {
      const fragment = storageInterface.getFunction(callData.slice(0, 10))!;
      return [fragment.name, storageInterface.decodeFunctionData(fragment, callData)[0]];
    })).toEqual([
      ['getContextGraph', 7n], ['getNameHash', 7n], ['getContextGraph', 8n], ['getNameHash', 8n],
    ]);
  });

  it('decodes an answered id into the entry a read of that id gives', () => {
    const graph = { nameHash: nameHashFor(7), accessPolicy: 1, publishPolicy: 0, publishAuthority: AUTHORITY };
    const { contextGraph, nameHash } = encoded(graph);

    const [read] = decodeContextGraphStorageBatch(storageInterface, [7n], [contextGraph, nameHash]);

    expect(read).not.toBe('nonexistent');
    const answered = read as { contextGraph: unknown; nameHash: unknown };
    expect(decodeContextGraphStorageEntryV1(7n, answered.contextGraph, answered.nameHash))
      .toEqual(decodeContextGraphStorageEntryV1(7n, tuple(graph), graph.nameHash));
  });

  it('takes only the id-exact nonexistent revert as proof that an id was never minted', () => {
    const { contextGraph, nameHash } = encoded({});
    const revertFor = (id: bigint) => ({
      success: false,
      returnData: nonexistentToken.encodeErrorResult('ERC721NonexistentToken', [id]),
    });
    const answerOf = (results: Array<{ success: boolean; returnData: string }>) =>
      decodeContextGraphStorageBatch(storageInterface, [7n], results)[0];

    expect(answerOf([revertFor(7n), nameHash])).toBe('nonexistent');
    // Anything else is not an answer: the id is read on its own.
    expect(answerOf([revertFor(8n), nameHash])).toBeUndefined();
    expect(answerOf([{ success: false, returnData: '0x' }, nameHash])).toBeUndefined();
    expect(answerOf([contextGraph, { success: false, returnData: '0x' }])).toBeUndefined();
    expect(answerOf([{ success: true, returnData: '0x1234' }, nameHash])).toBeUndefined();
    expect(answerOf([contextGraph])).toBeUndefined();
  });
});

describe('decodeContextGraphStorageEntryV1', () => {
  const good = tuple({ nameHash: nameHashFor(1) });

  it('rejects malformed tuples instead of cataloguing them', () => {
    const cases: Array<[unknown, unknown, RegExp]> = [
      [null, ethers.ZeroHash, /non-tuple/],
      [Object.assign([...good], { 0: ethers.ZeroAddress }), ethers.ZeroHash, /zero owner/],
      [Object.assign([...good], { 0: 'not-an-address' }), ethers.ZeroHash, /owner is not an address/],
      [Object.assign([...good], { 3: 'yes' }), ethers.ZeroHash, /active is not a boolean/],
      [Object.assign([...good], { 4: 'soon' }), ethers.ZeroHash, /createdAt is not an unsigned integer/],
      [Object.assign([...good], { 4: -1n }), ethers.ZeroHash, /createdAt is negative/],
      [Object.assign([...good], { 4: 2n ** 60n }), ethers.ZeroHash, /createdAt is out of range/],
      [Object.assign([...good], { 5: 256n }), ethers.ZeroHash, /out-of-range policy/],
      [good, '0x1234', /not a bytes32/],
    ];
    for (const [raw, nameHash, message] of cases) {
      expect(() => decodeContextGraphStorageEntryV1(1n, raw, nameHash))
        .toThrow(ContextGraphStorageEnumerationError);
      expect(() => decodeContextGraphStorageEntryV1(1n, raw, nameHash)).toThrow(message);
    }
  });
});

describe('enumeration error classifiers', () => {
  it('recognises only an id-exact nonexistent-token revert', () => {
    expect(isNonexistentContextGraphStorageRevert(nonexistent(7n), 7n)).toBe(true);
    expect(isNonexistentContextGraphStorageRevert(nonexistent(7n), 8n)).toBe(false);
    expect(isNonexistentContextGraphStorageRevert({
      code: 'CALL_EXCEPTION',
      revert: { name: 'ERC721NonexistentToken', args: [9n] },
    }, 9n)).toBe(true);
    expect(isNonexistentContextGraphStorageRevert({
      code: 'CALL_EXCEPTION',
      revert: { name: 'ERC721NonexistentToken', args: [{}] },
    }, 9n)).toBe(false);
    expect(isNonexistentContextGraphStorageRevert({
      code: 'CALL_EXCEPTION',
      revert: { name: 'ERC721NonexistentToken', args: [] },
    }, 9n)).toBe(false);
    expect(isNonexistentContextGraphStorageRevert({ code: 'SERVER_ERROR', data: nonexistent(7n).data }, 7n))
      .toBe(false);
    expect(isNonexistentContextGraphStorageRevert(null, 7n)).toBe(false);
    expect(isNonexistentContextGraphStorageRevert('CALL_EXCEPTION', 7n)).toBe(false);
  });

  it('lets a data-less CALL_EXCEPTION (a lagging backend) fail over, but not a real revert', () => {
    expect(isContextGraphStorageEnumerationReadRetryable({ code: 'CALL_EXCEPTION', data: null })).toBe(true);
    expect(isContextGraphStorageEnumerationReadRetryable({ code: 'CALL_EXCEPTION', data: '0x' })).toBe(true);
    expect(isContextGraphStorageEnumerationReadRetryable(nonexistent(1n))).toBe(false);
    expect(isContextGraphStorageEnumerationReadRetryable({
      code: 'CALL_EXCEPTION',
      data: null,
      revert: { name: 'Anything', args: [] },
    })).toBe(false);
    expect(isContextGraphStorageEnumerationReadRetryable(
      Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }),
    )).toBe(true);
    expect(isContextGraphStorageEnumerationReadRetryable(null)).toBe(false);
    expect(isContextGraphStorageEnumerationReadRetryable('CALL_EXCEPTION')).toBe(false);
  });
});

describe('EVMChainAdapter.readContextGraphStorageRange', () => {
  function makeStorageAdapter(options: {
    finalityConfirmations?: number;
    head: number;
    graphs: Map<number, FakeGraph>;
    latestId: number;
  }) {
    const adapter = new EVMChainAdapter(minimalConfig(
      options.finalityConfirmations === undefined
        ? {}
        : { finalityConfirmations: options.finalityConfirmations },
    ));
    const blockTags: unknown[] = [];
    const bound = {
      getLatestContextGraphId: seam(async (overrides: { blockTag: number }) => {
        blockTags.push(overrides.blockTag);
        return BigInt(options.latestId);
      }),
      getContextGraph: seam(async (id: bigint, overrides: { blockTag: number }) => {
        blockTags.push(overrides.blockTag);
        const graph = options.graphs.get(Number(id));
        if (!graph) throw nonexistent(id);
        return tuple(graph);
      }),
      getNameHash: seam(async (id: bigint, overrides: { blockTag: number }) => {
        blockTags.push(overrides.blockTag);
        return options.graphs.get(Number(id))?.nameHash ?? ethers.ZeroHash;
      }),
    };
    const storage = {
      getAddress: async () => STORAGE,
      connect: () => bound,
    };
    const provider = {
      getBlock: seam(async (tag: number | 'latest') => {
        const number = tag === 'latest' ? options.head : tag;
        return { number, hash: ethers.zeroPadValue(ethers.toBeHex(number), 32) };
      }),
    };
    (adapter as any).contracts = { contextGraphStorage: storage };
    (adapter as any).initialized = true;
    (adapter as any).provider = provider;
    (adapter as any).providers = [provider];
    return { adapter, provider, bound, blockTags };
  }

  it('reads at the configured finality anchor, not the raw head', async () => {
    const graphs = new Map<number, FakeGraph>([
      [1, { nameHash: nameHashFor(1), accessPolicy: 0 }],
      [2, { nameHash: nameHashFor(2), accessPolicy: 1, publishPolicy: 0, publishAuthority: AUTHORITY }],
      [3, { active: false }],
    ]);
    const { adapter, provider, blockTags } = makeStorageAdapter({
      finalityConfirmations: 3,
      head: 500,
      graphs,
      latestId: 3,
    });

    const range = await adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 });

    expect(provider.getBlock.calls).toEqual([['latest'], [498]]);
    expect(range.anchorBlockNumber).toBe(498);
    expect(new Set(blockTags)).toEqual(new Set([498]));
    expect(range.storageAddress).toBe(STORAGE.toLowerCase());
    expect(range.entries.map((entry) => [entry.contextGraphId, entry.accessPolicy, entry.active, entry.nameHash]))
      .toEqual([
        ['1', 0, true, nameHashFor(1).toLowerCase()],
        ['2', 1, true, nameHashFor(2).toLowerCase()],
        ['3', 0, false, null],
      ]);
    expect(range.nextId).toBe(4n);
  });

  it('uses the head itself at the default finality depth, with one block read', async () => {
    const { adapter, provider } = makeStorageAdapter({
      head: 77,
      graphs: new Map([[1, {}]]),
      latestId: 1,
    });
    const range = await adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 1 });
    expect(provider.getBlock.calls).toEqual([['latest']]);
    expect(range.anchorBlockNumber).toBe(77);
  });

  it('fails closed, before any view, when the anchor block cannot be read', async () => {
    const { adapter, provider, blockTags } = makeStorageAdapter({
      head: 77,
      graphs: new Map([[1, {}]]),
      latestId: 1,
    });
    provider.getBlock.setImpl(async () => null as never);

    await expect(adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 1 }))
      .rejects.toThrow(/Context Graph storage enumeration anchor unavailable/);
    expect(blockTags).toEqual([]);
  });

  it('fails over a data-less CALL_EXCEPTION from a backend behind the anchor', async () => {
    const graphs = new Map<number, FakeGraph>([[1, { nameHash: nameHashFor(1) }]]);
    const first = makeStorageAdapter({ head: 10, graphs, latestId: 1 });
    const lagging = {
      getBlock: first.provider.getBlock,
    };
    const laggingBound = {
      ...first.bound,
      getContextGraph: seam(async () => {
        throw Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null });
      }),
    };
    const healthyStorage = (first.adapter as any).contracts.contextGraphStorage;
    (first.adapter as any).contracts = {
      contextGraphStorage: {
        getAddress: healthyStorage.getAddress,
        connect: (provider: unknown) => (provider === lagging ? laggingBound : first.bound),
      },
    };
    (first.adapter as any).providers = [lagging, first.provider];
    (first.adapter as any).rpcUrls = ['http://127.0.0.1:59998', 'http://127.0.0.1:59999'];

    const range = await first.adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 1 });

    expect(laggingBound.getContextGraph.calls.length).toBeGreaterThan(0);
    expect(range.entries.map((entry) => entry.contextGraphId)).toEqual(['1']);
  });

  it('reports whether a ContextGraphNameRegistry is bound', async () => {
    const { adapter } = makeStorageAdapter({ head: 1, graphs: new Map(), latestId: 0 });
    await expect(adapter.hasContextGraphNameRegistry()).resolves.toBe(false);
    (adapter as any).contracts.contextGraphNameRegistry = {};
    await expect(adapter.hasContextGraphNameRegistry()).resolves.toBe(true);
  });
});

describe('EVMChainAdapter.readContextGraphStorageRange in a background pass', () => {
  const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
  const nonexistentToken = new ethers.Interface(['error ERC721NonexistentToken(uint256 tokenId)']);
  const HEAD = 9_000;
  const ANCHOR = 'listContextGraphsFromChain anchor';
  const LATEST_ID = 'listContextGraphsFromChain getLatestContextGraphId';
  const AGGREGATE = 'listContextGraphsFromChain aggregate3';
  const GET_CONTEXT_GRAPH = 'listContextGraphsFromChain getContextGraph';
  const GET_NAME_HASH = 'listContextGraphsFromChain getNameHash';
  const CODE_CHECK = 'multicall3.getCode';
  const background = <T>(fn: () => T): T => withRpcRequestContext({ requestClass: 'background' }, fn);

  afterEach(() => { delete process.env.DKG_DISABLE_RPC_READ_BATCHING; });

  /** An adapter over a fake chain, with every physical request counted at the transport. */
  function makeBackgroundAdapter(options: {
    graphs: Map<number, FakeGraph>;
    latestId: number;
    /** Bytecode at the Multicall3 address. */
    multicall3Code?: string;
    /** Ids whose views fail inside an aggregate request, but not on their own. */
    failsInAggregate?: number[];
    /** Ids whose views fail however they are read. */
    unreadable?: number[];
    finalityConfirmations?: number;
  }) {
    const adapter = new EVMChainAdapter(minimalConfig(
      options.finalityConfirmations === undefined
        ? {}
        : { finalityConfirmations: options.finalityConfirmations },
    ));
    const requests: Array<{ label: string; consumer: string | null; policy: ReadOpts['policy'] }> = [];
    /** Each aggregate request: its inner calls and the block it was pinned to. */
    const aggregates: Array<{
      calls: Array<{ target: string; allowFailure: boolean; callData: string }>;
      blockTag: unknown;
    }> = [];
    /** The block every read of a single view was pinned to. */
    const blockTags: unknown[] = [];
    const control: {
      aggregateFailure?: unknown;
      beforeAggregateAnswers?: () => void;
      /** Runs before a view of one id is answered on its own. */
      beforeSingleView?: (id: number) => void;
      /** Keeps the bytecode check out until it resolves. */
      codeCheckHeld?: Promise<void>;
    } = {};

    /** The fake chain's answer to one ContextGraphStorage view. */
    const view = (callData: string, insideAggregate: boolean): { success: boolean; returnData: string } => {
      const fragment = storageInterface.getFunction(callData.slice(0, 10))!;
      if (fragment.name === 'getLatestContextGraphId') {
        return {
          success: true,
          returnData: storageInterface.encodeFunctionResult(fragment, [BigInt(options.latestId)]),
        };
      }
      const [rawId] = storageInterface.decodeFunctionData(fragment, callData);
      const id = Number(rawId);
      const graph = options.graphs.get(id);
      if (options.unreadable?.includes(id) || (insideAggregate && options.failsInAggregate?.includes(id))) {
        return { success: false, returnData: '0x' };
      }
      if (fragment.name === 'getNameHash') {
        return {
          success: true,
          returnData: storageInterface.encodeFunctionResult(fragment, [graph?.nameHash ?? ethers.ZeroHash]),
        };
      }
      if (!graph) {
        return {
          success: false,
          returnData: nonexistentToken.encodeErrorResult('ERC721NonexistentToken', [rawId]),
        };
      }
      return { success: true, returnData: storageInterface.encodeFunctionResult(fragment, tuple(graph)) };
    };

    const internals = adapter as unknown as {
      contracts: { contextGraphStorage?: Contract };
      initialized: boolean;
      readProvider(label: string, fn: (provider: unknown) => Promise<unknown>, opts?: ReadOpts): Promise<unknown>;
      rpcFailover: {
        readContract(
          descriptor: RpcReadDescriptor,
          contract: Contract,
          fn: (contract: unknown) => Promise<unknown>,
          opts?: ReadOpts,
        ): Promise<unknown>;
      };
    };
    internals.contracts = { contextGraphStorage: new Contract(STORAGE, loadAbi('ContextGraphStorage')) };
    internals.initialized = true;
    internals.readProvider = async (label, fn, opts) => {
      requests.push({
        label,
        consumer: opts?.rpcUsageConsumer === undefined ? label : opts.rpcUsageConsumer,
        policy: opts?.policy,
      });
      if (label === CODE_CHECK) await control.codeCheckHeld;
      return fn({
        getCode: async () => options.multicall3Code ?? MULTICALL3_RUNTIME_CODE,
        getBlock: async (tag: number | 'latest') => {
          const number = tag === 'latest' ? HEAD : tag;
          return { number, hash: ethers.zeroPadValue(ethers.toBeHex(number), 32) };
        },
      });
    };
    internals.rpcFailover.readContract = async (descriptor, contract, fn, opts) => {
      requests.push({ label: descriptor.label, consumer: descriptor.consumer, policy: opts?.policy });
      if (contract.target === MULTICALL3_ADDRESS) {
        return fn({
          aggregate3: {
            staticCall: async (
              calls: Array<{ target: string; allowFailure: boolean; callData: string }>,
              overrides?: { blockTag?: number },
            ) => {
              aggregates.push({ calls, blockTag: overrides?.blockTag });
              control.beforeAggregateAnswers?.();
              if (control.aggregateFailure !== undefined) throw control.aggregateFailure;
              return calls.map(({ callData }) => view(callData, true));
            },
          },
        });
      }
      // A single view: what the contract method call returns, or throws, for the same answer.
      return fn(new Proxy({}, {
        get: (_target, method: string) => async (...args: unknown[]) => {
          const overrides = args.pop() as { blockTag: number };
          blockTags.push(overrides.blockTag);
          if (args.length > 0) control.beforeSingleView?.(Number(args[0]));
          const { success, returnData } = view(storageInterface.encodeFunctionData(method, args), false);
          if (!success) {
            throw Object.assign(new Error(`execution reverted (${method})`), {
              code: 'CALL_EXCEPTION',
              data: returnData,
            });
          }
          const result = storageInterface.decodeFunctionResult(method, returnData);
          return result.length === 1 ? result[0] : result;
        },
      }));
    };
    const labels = () => requests.map(({ label }) => label);
    return { adapter, requests, labels, aggregates, blockTags, control };
  }

  it('reads 37 ids in four requests, after one bytecode check per process', async () => {
    const { adapter, requests, labels, aggregates, blockTags } = makeBackgroundAdapter({
      graphs: graphsUpTo(37),
      latestId: 37,
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 64 }));

    expect(idsOf(range)).toEqual(sequence(1, 37));
    expect(range.nextId).toBe(38n);
    expect(range.anchorBlockNumber).toBe(HEAD);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, AGGREGATE]);
    // 32 ids, then the other 5: two inner calls per id, each allowed to fail on its own.
    expect(aggregates.map(({ calls }) => calls.length)).toEqual([64, 10]);
    expect(aggregates.flatMap(({ calls }) => calls).every(
      ({ target, allowFailure }) => target === STORAGE.toLowerCase() && allowFailure === true,
    )).toBe(true);
    // Every view is pinned to the anchor, in a request or on its own.
    expect(aggregates.map(({ blockTag }) => blockTag)).toEqual([HEAD, HEAD]);
    expect(blockTags).toEqual([HEAD]);

    // A later pass re-reads them (the daily refresh) without another bytecode check.
    requests.length = 0;
    await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 37 }));
    expect(labels()).toEqual([ANCHOR, LATEST_ID, AGGREGATE, AGGREGATE]);

    // A pass with nothing new sends no aggregate request.
    requests.length = 0;
    const quiet = await background(() => adapter.readContextGraphStorageRange({ fromId: 38n, maxIds: 64 }));
    expect(quiet.entries).toEqual([]);
    expect(labels()).toEqual([ANCHOR, LATEST_ID]);
  });

  it('pins the aggregate request to the finality anchor, not the head', async () => {
    const { adapter, aggregates, blockTags } = makeBackgroundAdapter({
      graphs: graphsUpTo(3),
      latestId: 3,
      finalityConfirmations: 3,
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 3 }));

    expect(range.anchorBlockNumber).toBe(HEAD - 2);
    expect(aggregates.map(({ blockTag }) => blockTag)).toEqual([HEAD - 2]);
    expect(blockTags).toEqual([HEAD - 2]);
    expect(idsOf(range)).toEqual([1, 2, 3]);
  });

  it('bills the aggregate request to the enumeration consumer, under the same read cap as its other reads', async () => {
    const { adapter, requests } = makeBackgroundAdapter({ graphs: graphsUpTo(3), latestId: 3 });

    await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 3 }));

    expect(requests).toEqual([
      { label: ANCHOR, consumer: 'listContextGraphsFromChain', policy: 'wideLogScan' },
      { label: LATEST_ID, consumer: 'listContextGraphsFromChain', policy: 'wideLogScan' },
      // The check may wait out the closed background budget at start.
      { label: CODE_CHECK, consumer: CODE_CHECK, policy: 'watchdogWideLogScan' },
      { label: AGGREGATE, consumer: 'listContextGraphsFromChain', policy: 'wideLogScan' },
    ]);
  });

  it('returns the range a foreground read gives, which still reads id by id', async () => {
    const graphs = graphsUpTo(5);
    graphs.set(2, { ...graphs.get(2), active: false, publishPolicy: 0, publishAuthority: AUTHORITY });
    const { adapter, requests, labels } = makeBackgroundAdapter({ graphs, latestId: 5 });

    const foreground = await adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 5 });
    const foregroundLabels = labels();
    requests.length = 0;
    const batched = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 5 }));

    expect(batched).toEqual(foreground);
    expect(foregroundLabels.slice(0, 2)).toEqual([ANCHOR, LATEST_ID]);
    expect(foregroundLabels.filter((label) => label === GET_CONTEXT_GRAPH)).toHaveLength(5);
    expect(foregroundLabels.filter((label) => label === GET_NAME_HASH)).toHaveLength(5);
    expect(foregroundLabels).toHaveLength(12);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it('reads an id whose views fail inside the request on its own, and the rest from the request', async () => {
    const { adapter, labels } = makeBackgroundAdapter({
      graphs: graphsUpTo(10),
      latestId: 10,
      failsInAggregate: [5],
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 }));

    expect(idsOf(range)).toEqual(sequence(1, 10));
    expect(range.entries[4]!.nameHash).toBe(nameHashFor(5).toLowerCase());
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);
  });

  it('keeps the ids before one that cannot be read at all, and reports the failure for that id', async () => {
    const { adapter, requests, labels } = makeBackgroundAdapter({
      graphs: graphsUpTo(10),
      latestId: 10,
      unreadable: [5],
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 }));

    // The ids before it are returned; a cursor stops at the id that was not read.
    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(range.nextId).toBe(5n);
    expect(range.latestId).toBe(10n);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);

    requests.length = 0;
    await expect(background(() => adapter.readContextGraphStorageRange({ fromId: 5n, maxIds: 6 })))
      .rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    // Asked for in a request, then on its own; ids 6..10 are not read one by one.
    expect(labels()).toEqual([ANCHOR, LATEST_ID, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);
  });

  it('ends the range at an id the chain does not hold yet, without reading it again', async () => {
    const graphs = graphsUpTo(10);
    graphs.delete(7);
    const { adapter, labels } = makeBackgroundAdapter({ graphs, latestId: 10 });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 }));

    expect(idsOf(range)).toEqual(sequence(1, 6));
    expect(range.nextId).toBe(7n);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it('reads id by id when the kill switch is set, without a bytecode check', async () => {
    const { adapter, labels, aggregates } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    process.env.DKG_DISABLE_RPC_READ_BATCHING = '1';

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }));

    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(aggregates).toEqual([]);
    expect(labels()).not.toContain(CODE_CHECK);
    expect(labels()).toHaveLength(2 + 2 * 4);
  });

  it('reads id by id on a chain without the aggregate contract, checking its bytecode once', async () => {
    const { adapter, requests, labels, aggregates } = makeBackgroundAdapter({
      graphs: graphsUpTo(4),
      latestId: 4,
      multicall3Code: '0x',
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }));

    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(aggregates).toEqual([]);
    expect(labels().slice(0, 3)).toEqual([ANCHOR, LATEST_ID, CODE_CHECK]);
    expect(labels()).toHaveLength(3 + 2 * 4);

    requests.length = 0;
    await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }));
    expect(labels()).not.toContain(CODE_CHECK);
  });

  it('reads id by id when the aggregate request fails, trying it once for the range and saying so', async () => {
    const { adapter, labels, aggregates, control } = makeBackgroundAdapter({
      graphs: graphsUpTo(40),
      latestId: 40,
    });
    control.aggregateFailure = new Error('https://rpc.example/v2/secret-key rejected the call');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 40 }));

      expect(idsOf(range)).toEqual(sequence(1, 40));
      expect(aggregates).toHaveLength(1);
      expect(labels().filter((label) => label === GET_CONTEXT_GRAPH)).toHaveLength(40);
      expect(labels().filter((label) => label === GET_NAME_HASH)).toHaveLength(40);
      // One line for the operator, with any endpoint URL reduced to its host.
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[chain] listContextGraphsFromChain: aggregate request failed, reading id by id: '
          + 'rpc.example rejected the call',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects when the node itself refuses the aggregate request, without reading id by id', async () => {
    const { adapter, labels, control } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    const refusal = new RpcRequestGovernorQueueFullError(256);
    control.aggregateFailure = refusal;

    await expect(background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 })))
      .rejects.toBe(refusal);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it.each([
    ['its own signal', true],
    ['the signal of the pass it runs in', false],
  ])('rejects with the cancellation when %s ends the aggregate request', async (_name, ownSignal) => {
    const { adapter, labels, control } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    const controller = new AbortController();
    control.beforeAggregateAnswers = () => controller.abort(new Error('pass ended'));
    control.aggregateFailure = new Error('request aborted');

    const read = ownSignal
      ? background(() => adapter.readContextGraphStorageRange({
          fromId: 1n,
          maxIds: 4,
          signal: controller.signal,
        }))
      : withRpcRequestContext(
          { requestClass: 'background', signal: controller.signal },
          () => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }),
        );

    await expect(read).rejects.toThrow('pass ended');
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it('rejects, rather than return the ids read so far, when the pass is cancelled at a later request', async () => {
    const { adapter, aggregates, control } = makeBackgroundAdapter({ graphs: graphsUpTo(40), latestId: 40 });
    const controller = new AbortController();
    control.beforeAggregateAnswers = () => {
      if (aggregates.length < 2) return;
      controller.abort(new Error('pass ended'));
      throw new Error('request aborted');
    };

    // Cancelled through the request context alone: the range has no signal of its own.
    await expect(withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 64 }),
    )).rejects.toThrow('pass ended');
    expect(aggregates).toHaveLength(2);
  });

  it('rejects when the pass is cancelled while ids are read one by one', async () => {
    const { adapter, control } = makeBackgroundAdapter({ graphs: graphsUpTo(20), latestId: 20 });
    process.env.DKG_DISABLE_RPC_READ_BATCHING = '1';
    const controller = new AbortController();
    control.beforeSingleView = (id) => {
      if (id !== 6) return;
      controller.abort(new Error('pass ended'));
      throw new Error('request aborted');
    };

    await expect(withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 20 }),
    )).rejects.toThrow('pass ended');
  });

  it('stops waiting for the bytecode check when the range\'s own signal ends', async () => {
    const { adapter, labels, control } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    let releaseCodeCheck!: () => void;
    control.codeCheckHeld = new Promise<void>((resolve) => { releaseCodeCheck = resolve; });
    const controller = new AbortController();

    const read = background(() => adapter.readContextGraphStorageRange({
      fromId: 1n,
      maxIds: 4,
      signal: controller.signal,
    }));
    const outcome = read.then(() => 'resolved', (error: Error) => error.message);
    await vi.waitFor(() => expect(labels()).toContain(CODE_CHECK));
    controller.abort(new Error('pass ended'));

    // The check is still out; the range does not wait for it.
    await expect(Promise.race([
      outcome,
      new Promise((resolve) => { setTimeout(() => resolve('still waiting for the bytecode check'), 500); }),
    ])).resolves.toBe('pass ended');
    releaseCodeCheck();
  });
});

describe('MockChainAdapter.readContextGraphStorageRange', () => {
  it('enumerates the in-memory graphs with the same range semantics', async () => {
    const chain = new MockChainAdapter();
    const publicHash = nameHashFor(1);
    const privateHash = nameHashFor(2);
    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: publicHash });
    await chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0, nameHash: privateHash });
    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
    chain.getContextGraph(3n)!.active = false;

    const range = await chain.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 });

    expect(range.latestId).toBe(3n);
    expect(range.nextId).toBe(4n);
    expect(range.entries.map((entry) => ({
      id: entry.contextGraphId,
      access: entry.accessPolicy,
      publish: entry.publishPolicy,
      owner: entry.owner,
      active: entry.active,
      nameHash: entry.nameHash,
      authority: entry.publishAuthority,
    }))).toEqual([
      { id: '1', access: 0, publish: 1, owner: MOCK_DEFAULT_SIGNER, active: true, nameHash: publicHash.toLowerCase(), authority: null },
      { id: '2', access: 1, publish: 0, owner: MOCK_DEFAULT_SIGNER, active: true, nameHash: privateHash.toLowerCase(), authority: MOCK_DEFAULT_SIGNER },
      { id: '3', access: 0, publish: 1, owner: MOCK_DEFAULT_SIGNER, active: false, nameHash: null, authority: null },
    ]);
    expect(range.entries[0]!.createdAt).toBeGreaterThan(1_700_000_000);
    await expect(chain.hasContextGraphNameRegistry()).resolves.toBe(false);
  });

  it('ends at a missing slot like the EVM adapter', async () => {
    const chain = new MockChainAdapter();
    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
    (chain as any).contextGraphs.delete(1n);
    const range = await chain.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 });
    expect(range.entries).toEqual([]);
    expect(range.nextId).toBe(1n);
  });
});
