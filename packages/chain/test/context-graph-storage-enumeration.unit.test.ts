// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
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
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import { minimalConfig, seam } from './context-graph-registry-scan-fixture.js';
import {
  STORAGE, OWNER, AUTHORITY, ANCHOR_HASH, type FakeGraph, nameHashFor, tuple, graphsUpTo, idsOf, sequence,
} from './context-graph-storage-enumeration-fixture.js';

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
