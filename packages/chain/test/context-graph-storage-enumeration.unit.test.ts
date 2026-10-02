// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';
import {
  CONTEXT_GRAPH_STORAGE_ENUMERATION_CONCURRENCY,
  CONTEXT_GRAPH_STORAGE_ENUMERATION_MAX_IDS_PER_READ,
  ContextGraphStorageEnumerationError,
  decodeContextGraphStorageEntryV1,
  isContextGraphStorageEnumerationReadRetryable,
  isNonexistentContextGraphStorageRevert,
  readContextGraphStorageRangeV1,
  type ContextGraphStorageRangePorts,
} from '../src/evm-context-graph-storage-enumeration.js';
import { minimalConfig, seam } from './context-graph-registry-scan-fixture.js';

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

  it('propagates every other read failure so no cursor advances over a gap', async () => {
    const { ports } = fakePorts(new Map([[1, {}], [2, {}]]), 2);
    const failing: ContextGraphStorageRangePorts = {
      ...ports,
      readNameHash: async (id) => {
        if (id === 2n) throw Object.assign(new Error('boom'), { code: 'SERVER_ERROR' });
        return ethers.ZeroHash;
      },
    };
    await expect(readContextGraphStorageRangeV1(failing, { fromId: 1n, maxIds: 2 }))
      .rejects.toThrow('boom');
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
