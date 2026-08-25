import { describe, expect, it, vi } from 'vitest';

import {
  ContextGraphAssetFetchConflictError,
  runExactAssetFetch,
  type ExactAssetFetchDependencies,
  type ExactAssetFetchEvidence,
} from '../src/sync/exact-asset-fetch.js';

const CONTEXT_GRAPH = 'sports';
const ON_CHAIN_ID = '9';
const UALS = [
  'did:dkg:base:8453/0x00000000000000000000000000000000000000a1/1',
  'did:dkg:base:8453/0x00000000000000000000000000000000000000a1/2',
] as const;

function baseDependencies(
  overrides: Partial<ExactAssetFetchDependencies> = {},
): ExactAssetFetchDependencies {
  return {
    chainId: 'base:8453',
    isCurrent: () => true,
    getKAContextGraphId: async () => BigInt(ON_CHAIN_ID),
    readKnowledgeAssetVersionSnapshot: async () => ({
      latestRoot: `0x${'ab'.repeat(32)}`,
      rootCount: 3n,
      latestAuthor: '0x00000000000000000000000000000000000000a1',
      latestPublisher: '0x00000000000000000000000000000000000000b1',
      blockNumber: 321,
    }),
    verifyLocalContextGraph: async () => true,
    inspectLocal: async () => 'present',
    resolvePeerIds: async () => [],
    preparePeer: async () => true,
    fetchFromPeer: async () => undefined,
    flush: async () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

describe('exact asset fetch service', () => {
  it('overlaps bounded evidence reads, preserves order, and uses only coherent snapshots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let startedReads = 0;
    const inspect = vi.fn(async (_evidence: ExactAssetFetchEvidence) => 'present' as const);
    const deps = baseDependencies({
      getKAContextGraphId: async () => {
        startedReads += 1;
        await gate;
        return BigInt(ON_CHAIN_ID);
      },
      readKnowledgeAssetVersionSnapshot: async () => {
        startedReads += 1;
        await gate;
        return {
          latestRoot: `0x${'cd'.repeat(32)}`,
          rootCount: 2n,
          latestAuthor: '0x00000000000000000000000000000000000000a2',
          latestPublisher: '0x00000000000000000000000000000000000000b2',
          blockNumber: 654,
        };
      },
      inspectLocal: inspect,
    });

    const running = runExactAssetFetch({
      contextGraphId: CONTEXT_GRAPH,
      requestedUals: [UALS[1], UALS[0]],
    }, deps);
    await vi.waitFor(() => expect(startedReads).toBe(4));
    release();
    const result = await running;

    expect(result.items.map((item) => item.ual)).toEqual([UALS[1], UALS[0]]);
    expect(inspect).toHaveBeenCalledTimes(2);
    for (const [evidence] of inspect.mock.calls) {
      expect(evidence.merkleRoot).toEqual(new Uint8Array(32).fill(0xcd));
      expect(evidence.authorAddress).toBe(
        '0x00000000000000000000000000000000000000a2',
      );
      expect(evidence.publisherAddress).toBe(
        '0x00000000000000000000000000000000000000b2',
      );
      expect(evidence.versionBlock).toBe(654);
    }
  });

  it('fails closed when the chain cannot return one coherent version snapshot', async () => {
    const inspectLocal = vi.fn(async () => 'present' as const);
    await expect(runExactAssetFetch({
      contextGraphId: CONTEXT_GRAPH,
      requestedUals: [UALS[0]],
    }, baseDependencies({
      readKnowledgeAssetVersionSnapshot: async () => null,
      inspectLocal,
    }))).rejects.toBeInstanceOf(ContextGraphAssetFetchConflictError);
    expect(inspectLocal).not.toHaveBeenCalled();
  });

  it('uses ordered peers and sends each peer only the unresolved UALs', async () => {
    const present = new Set<string>();
    const fetchCalls: Array<[string, readonly string[]]> = [];
    const result = await runExactAssetFetch({
      contextGraphId: CONTEXT_GRAPH,
      requestedUals: UALS,
      peerIds: ['peer-a', 'peer-b'],
    }, baseDependencies({
      inspectLocal: async (evidence) => present.has(evidence.ual) ? 'present' : 'missing',
      fetchFromPeer: async (peerId, uals) => {
        fetchCalls.push([peerId, [...uals]]);
        if (peerId === 'peer-a') present.add(UALS[0]);
        if (peerId === 'peer-b') present.add(UALS[1]);
      },
    }));

    expect(fetchCalls).toEqual([
      ['peer-a', [UALS[0], UALS[1]]],
      ['peer-b', [UALS[1]]],
    ]);
    expect(result).toMatchObject({
      status: 'complete',
      peerAttempts: 2,
      fetchedAssets: 2,
      unresolvedAssets: 0,
      items: [
        { ual: UALS[0], status: 'fetched' },
        { ual: UALS[1], status: 'fetched' },
      ],
    });
  });
});
